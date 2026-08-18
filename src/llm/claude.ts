import Anthropic from "@anthropic-ai/sdk";
import * as https from "node:https";
import { extractUnifiedDiff } from "../patch";
import { parsePlanJson, PlanStep } from "../prompt";
import { createTickGate } from "../progress";

const STREAM_TICK_THRESHOLD_CHARS = 400;

export type CacheUsage = {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

type ClaudeRequest = {
  apiKey: string;
  model: string;
  prompt: string;
  context: string;
  onTick?: (charsReceived: number) => void;
  onUsage?: (usage: CacheUsage) => void;
};

type ClaudePlanRequest = ClaudeRequest & {
  maxSteps?: number;
  targetCount?: number;
  existingFiles?: string[];
};

export type ClaudePlanStep = PlanStep;

const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          instruction: { type: "string" },
        },
        required: ["title", "instruction"],
        additionalProperties: false,
      },
    },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

type ClaudeFileRequest = ClaudeRequest & {
  filePath: string;
};

type ClaudeModelListResponse = {
  data?: Array<{ id?: string }>;
};

export async function generatePatchWithClaude({
  apiKey,
  model,
  prompt,
  context,
  onTick,
  onUsage,
}: ClaudeRequest): Promise<string> {
  const client = new Anthropic({ apiKey });

  const system =
    "Return ONLY a unified diff patch that can be applied with git apply. " +
    "Do not include explanations, markdown, or code fences. " +
    "If no changes are needed, return an empty response.";

  const response = await streamMessage(
    client,
    {
      model,
      max_tokens: 64000,
      system,
      messages: [
        {
          role: "user",
          content: cachedUserContent(
            `Context:\n${truncate(context, 12000)}`,
            `Prompt:\n${prompt}\n\nOutput:`
          ),
        },
      ],
    },
    onTick,
    onUsage
  );

  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");

  return extractUnifiedDiff(text);
}

export async function generatePlanWithClaude({
  apiKey,
  model,
  prompt,
  context,
  maxSteps = 6,
  targetCount,
  existingFiles,
  onTick,
  onUsage,
}: ClaudePlanRequest): Promise<ClaudePlanStep[]> {
  const client = new Anthropic({ apiKey });

  const system = "Generate an execution plan as a list of steps.";

  const countHint =
    targetCount && targetCount > 0
      ? `Target item count: ${targetCount}\n`
      : "";
  const existingHint =
    existingFiles && existingFiles.length > 0
      ? `Existing files (partial):\n${truncate(
          existingFiles.join("\n"),
          2000
        )}\n\n`
      : "";
  const taskBlock =
    `Task:\n${prompt}\n\n` +
    existingHint +
    `Constraints:\n- Max steps: ${maxSteps}\n` +
    countHint +
    "- Steps must be executable in order\n" +
    "- If multiple items are requested, ensure all items are covered\n" +
    "- Each step must target exactly one file and include the filename in the title\n" +
    "- Do not create files that already exist; plan edits instead\n" +
    "- Each instruction should be specific and scoped\n\n" +
    "Output:";

  const response = await streamMessage(
    client,
    {
      model,
      max_tokens: 8000,
      system,
      messages: [
        {
          role: "user",
          content: cachedUserContent(
            `Context summary:\n${truncate(context, 6000)}`,
            taskBlock
          ),
        },
      ],
      output_config: {
        format: { type: "json_schema", schema: PLAN_JSON_SCHEMA },
      },
    },
    onTick,
    onUsage
  );

  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();

  const parsed = parsePlanJson(text);
  if (!parsed.length) {
    throw new Error("Failed to generate execution plan.");
  }
  return parsed;
}

export async function generateFileContentWithClaude({
  apiKey,
  model,
  prompt,
  context,
  filePath,
  onTick,
  onUsage,
}: ClaudeFileRequest): Promise<string> {
  const client = new Anthropic({ apiKey });

  const system =
    "Return ONLY the full file contents. " +
    "Do not include markdown, code fences, or explanations.";

  const response = await streamMessage(
    client,
    {
      model,
      max_tokens: 64000,
      system,
      messages: [
        {
          role: "user",
          content: cachedUserContent(
            `Context:\n${truncate(context, 6000)}`,
            `File path: ${filePath}\n\nTask:\n${prompt}\n\nOutput:`
          ),
        },
      ],
    },
    onTick,
    onUsage
  );

  const text = response.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("")
    .trim();

  return text;
}

export async function listClaudeModels(apiKey: string): Promise<string[]> {
  const response = await fetchClaudeModels(apiKey);
  const models = response?.data?.map((item) => item.id).filter(Boolean) ?? [];
  return models as string[];
}

/**
 * Puts the stable repo-context block first (its own cached content entry)
 * and the per-call task text after, so repeat calls against the same repo
 * reuse the cached prefix (Anthropic requires an unbroken prefix match).
 */
function cachedUserContent(
  contextBlock: string,
  taskBlock: string
): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: contextBlock,
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: taskBlock },
  ];
}

async function streamMessage(
  client: Anthropic,
  params: Anthropic.MessageStreamParams,
  onTick?: (charsReceived: number) => void,
  onUsage?: (usage: CacheUsage) => void
): Promise<Anthropic.Message> {
  const stream = client.messages.stream(params);

  if (onTick) {
    const shouldTick = createTickGate(STREAM_TICK_THRESHOLD_CHARS);
    stream.on("text", (_delta, snapshot) => {
      if (shouldTick(snapshot.length)) {
        onTick(snapshot.length);
      }
    });
  }

  const response = await stream.finalMessage();

  if (onUsage) {
    onUsage({
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens:
        response.usage.cache_creation_input_tokens ?? 0,
    });
  }

  return response;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...truncated...`;
}

async function fetchClaudeModels(
  apiKey: string
): Promise<ClaudeModelListResponse> {
  const responseText = await new Promise<string>((resolve, reject) => {
    const request = https.request(
      "https://api.anthropic.com/v1/models",
      {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => resolve(data));
      }
    );
    request.on("error", reject);
    request.end();
  });

  try {
    return JSON.parse(responseText) as ClaudeModelListResponse;
  } catch {
    return {};
  }
}


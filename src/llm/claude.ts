import Anthropic from "@anthropic-ai/sdk";
import { parsePlan, planFailureMessage, PlanStep } from "../prompt";
import { createTickGate } from "../progress";
import { appError } from "../errors.ts";

const STREAM_TICK_THRESHOLD_CHARS = 400;

export type CacheUsage = {
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

type ClaudeRequest = {
  apiKey: string;
  model: string;
  prompt: string;
  context: string;
  effort?: ClaudeEffort;
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

export async function generatePlanWithClaude({
  apiKey,
  model,
  prompt,
  context,
  maxSteps = 6,
  targetCount,
  existingFiles,
  effort,
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
        ...(effort ? { effort } : {}),
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

  const parsed = parsePlan(text);
  if (!parsed.ok) {
    throw new Error(planFailureMessage(parsed.reason));
  }
  return parsed.steps;
}

export async function listClaudeModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey });
  const models: string[] = [];
  for await (const model of client.models.list()) {
    models.push(model.id);
  }
  return models;
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

  if (response.stop_reason === "refusal") {
    const explanation = response.stop_details?.explanation;
    throw appError("refusal", explanation);
  }

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


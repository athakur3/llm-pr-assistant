import Anthropic from "@anthropic-ai/sdk";
import * as https from "node:https";

type ClaudeRequest = {
  apiKey: string;
  model: string;
  prompt: string;
  context: string;
};

type ClaudePlanRequest = ClaudeRequest & {
  maxSteps?: number;
  targetCount?: number;
  existingFiles?: string[];
};

export type ClaudePlanStep = {
  title: string;
  instruction: string;
};

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
}: ClaudeRequest): Promise<string> {
  const client = new Anthropic({ apiKey });

  const system =
    "Return ONLY a unified diff patch that can be applied with git apply. " +
    "Do not include explanations, markdown, or code fences. " +
    "If no changes are needed, return an empty response.";

  const user =
    `Prompt:\n${prompt}\n\n` +
    `Context:\n${truncate(context, 12000)}\n\n` +
    "Output:";

  const response = await client.messages.create({
    model,
    max_tokens: 3000,
    temperature: 0.2,
    system,
    messages: [{ role: "user", content: user }],
  });

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
}: ClaudePlanRequest): Promise<ClaudePlanStep[]> {
  const client = new Anthropic({ apiKey });

  const system =
    "Return ONLY valid JSON. " +
    "Output a JSON array of steps, each with {\"title\": string, \"instruction\": string}. " +
    "No markdown, no code fences, no extra text.";

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
  const user =
    `Task:\n${prompt}\n\n` +
    `Context summary:\n${truncate(context, 6000)}\n\n` +
    existingHint +
    `Constraints:\n- Max steps: ${maxSteps}\n` +
    countHint +
    "- Steps must be executable in order\n" +
    "- If multiple items are requested, ensure all items are covered\n" +
    "- Each step must target exactly one file and include the filename in the title\n" +
    "- Do not create files that already exist; plan edits instead\n" +
    "- Each instruction should be specific and scoped\n\n" +
    "Output:";

  const response = await client.messages.create({
    model,
    max_tokens: 800,
    temperature: 0.2,
    system,
    messages: [{ role: "user", content: user }],
  });

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
}: ClaudeFileRequest): Promise<string> {
  const client = new Anthropic({ apiKey });

  const system =
    "Return ONLY the full file contents. " +
    "Do not include markdown, code fences, or explanations.";

  const user =
    `File path: ${filePath}\n\n` +
    `Task:\n${prompt}\n\n` +
    `Context:\n${truncate(context, 6000)}\n\n` +
    "Output:";

  const response = await client.messages.create({
    model,
    max_tokens: 3000,
    temperature: 0.2,
    system,
    messages: [{ role: "user", content: user }],
  });

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

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...truncated...`;
}

function extractUnifiedDiff(raw: string): string {
  const cleaned = raw
    .replace(/```[\s\S]*?```/g, (match) =>
      match.replace(/```/g, "")
    )
    .trim();

  const diffIndex = cleaned.indexOf("diff --git ");
  if (diffIndex >= 0) {
    return cleaned.slice(diffIndex).trim();
  }

  const altIndex = cleaned.search(/^---\s+/m);
  if (altIndex >= 0) {
    return cleaned.slice(altIndex).trim();
  }

  return cleaned.trim();
}

function parsePlanJson(raw: string): ClaudePlanStep[] {
  const cleaned = raw.replace(/```[\s\S]*?```/g, (match) =>
    match.replace(/```/g, "")
  );
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  const candidate =
    start >= 0 && end >= start ? cleaned.slice(start, end + 1) : cleaned;

  try {
    const data = JSON.parse(candidate);
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .map((item) => ({
        title: String(item?.title ?? "").trim(),
        instruction: String(item?.instruction ?? "").trim(),
      }))
      .filter((item) => item.title && item.instruction);
  } catch {
    return [];
  }
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


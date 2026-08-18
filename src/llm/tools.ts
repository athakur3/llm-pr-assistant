import * as fs from "node:fs/promises";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { runGit } from "../git.ts";
import type { ClaudeEffort } from "./claude.ts";

const DEFAULT_MAX_ITERATIONS = 5;

/**
 * Resolves a model-supplied path against repoRoot and rejects anything that
 * escapes it (../ traversal, absolute paths elsewhere) — these tools are the
 * only thing standing between an LLM response and the user's filesystem.
 */
export function resolveRepoPath(repoRoot: string, relativePath: string): string {
  const root = path.resolve(repoRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the repository root: ${relativePath}`);
  }
  return resolved;
}

export function createReadFileTool(repoRoot: string): BetaRunnableTool {
  return betaTool({
    name: "read_file",
    description:
      "Read the full text contents of a file in the repository. Path is relative to the repository root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the repository root.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    run: async (args) => {
      const fullPath = resolveRepoPath(repoRoot, args.path);
      try {
        return await fs.readFile(fullPath, "utf8");
      } catch (error) {
        return `Error: could not read ${args.path}: ${(error as Error).message}`;
      }
    },
  });
}

export function createWriteFileTool(repoRoot: string): BetaRunnableTool {
  return betaTool({
    name: "write_file",
    description:
      "Write the full text contents of a file in the repository, creating it (and any missing parent directories) if it does not exist. Path is relative to the repository root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the repository root.",
        },
        content: {
          type: "string",
          description: "The complete new contents of the file.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    run: async (args) => {
      const fullPath = resolveRepoPath(repoRoot, args.path);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, args.content, "utf8");
      return `Wrote ${args.path}`;
    },
  });
}

export function createListFilesTool(repoRoot: string): BetaRunnableTool {
  return betaTool({
    name: "list_files",
    description: "List every file tracked by git in the repository.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    run: async () => {
      const output = await runGit(["ls-files"], repoRoot);
      return output.trim() ? output : "(repository has no tracked files)";
    },
  });
}

/**
 * Scoped to repoRoot with no shell/network tools — this is a file-editing
 * loop for the PR flow, not a general agent.
 */
export function createFileEditingTools(repoRoot: string): BetaRunnableTool[] {
  return [
    createReadFileTool(repoRoot),
    createWriteFileTool(repoRoot),
    createListFilesTool(repoRoot),
  ];
}

export type ToolLoopRequest = {
  apiKey: string;
  model: string;
  effort?: ClaudeEffort;
  system: string;
  prompt: string;
  repoRoot: string;
  maxIterations?: number;
};

export async function runFileEditingToolLoop({
  apiKey,
  model,
  effort,
  system,
  prompt,
  repoRoot,
  maxIterations = DEFAULT_MAX_ITERATIONS,
}: ToolLoopRequest): Promise<string> {
  const client = new Anthropic({ apiKey });

  const runner = client.beta.messages.toolRunner({
    model,
    max_tokens: 16000,
    max_iterations: maxIterations,
    system,
    messages: [{ role: "user", content: prompt }],
    tools: createFileEditingTools(repoRoot),
    ...(effort ? { output_config: { effort } } : {}),
  });

  const finalMessage = await runner.runUntilDone();

  return finalMessage.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");
}

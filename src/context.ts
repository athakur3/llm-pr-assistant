import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./git.ts";
import { rankFilesByPrompt } from "./relevance.ts";

const RELEVANT_FILE_LIMIT = 12;
const RELEVANT_FILE_MAX_CHARS = 3000;
const TRACKED_FILE_LIMIT = 200;

/**
 * The outcome of listing a repository's tracked files. "empty" (a real repo
 * with nothing in it) and "unreadable" (git could not answer) used to collapse
 * into the same empty array, so a repo whose file list failed to load reached
 * the model looking like an empty repo, with nothing logged.
 */
export type TrackedFiles =
  | { status: "ok"; files: string[] }
  | { status: "empty" }
  | { status: "unreadable"; error: string };

export function formatTrackedFilesSection(tracked: TrackedFiles): string {
  if (tracked.status === "unreadable") {
    return (
      "Tracked files: (unavailable - this repository's file list could not " +
      "be read, so the context below is incomplete)"
    );
  }
  if (tracked.status === "empty") {
    return "Tracked files: (none - this repository has no tracked files)";
  }
  return [
    `Tracked files (first ${TRACKED_FILE_LIMIT}):`,
    tracked.files.slice(0, TRACKED_FILE_LIMIT).join("\n"),
  ].join("\n");
}

export async function buildContext(
  workspaceRoot: string,
  prompt: string,
  log?: (message: string) => void
): Promise<string> {
  const sections: string[] = [];

  const tracked = await listTrackedFiles(workspaceRoot);
  if (tracked.status === "unreadable") {
    log?.(
      "Could not read this repository's tracked file list; continuing " +
        `without repo context.\n${tracked.error}`
    );
  } else if (tracked.status === "empty") {
    log?.("This repository has no tracked files.");
  }

  const allFiles = tracked.status === "ok" ? tracked.files : [];
  sections.push(formatTrackedFilesSection(tracked));

  const readme = await readTextFile(workspaceRoot, "README.md", 4000);
  if (readme) {
    sections.push("\nREADME.md:");
    sections.push(readme);
  }

  const packageJson = await readTextFile(workspaceRoot, "package.json", 4000);
  if (packageJson) {
    sections.push("\npackage.json:");
    sections.push(packageJson);
  }

  const relevantFiles = rankFilesByPrompt(allFiles, prompt, RELEVANT_FILE_LIMIT);
  if (relevantFiles.length > 0) {
    sections.push("\nFiles most relevant to the prompt:");
    for (const file of relevantFiles) {
      const content = await readTextFile(
        workspaceRoot,
        file,
        RELEVANT_FILE_MAX_CHARS
      );
      if (content) {
        sections.push(`\n${file}:`);
        sections.push(content);
      }
    }
  }

  return sections.join("\n");
}

export async function listTrackedFiles(
  workspaceRoot: string
): Promise<TrackedFiles> {
  try {
    const output = await runGit(["ls-files"], workspaceRoot);
    const files = output.split("\n").filter(Boolean);
    return files.length > 0 ? { status: "ok", files } : { status: "empty" };
  } catch (error) {
    return {
      status: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readTextFile(
  workspaceRoot: string,
  relativePath: string,
  maxLength: number
): Promise<string | null> {
  const target = path.join(workspaceRoot, relativePath);
  try {
    const content = await fs.readFile(target, "utf8");
    if (content.length <= maxLength) {
      return content;
    }
    return `${content.slice(0, maxLength)}\n...truncated...`;
  } catch {
    return null;
  }
}


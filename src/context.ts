import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./git";
import { rankFilesByPrompt } from "./relevance";

const RELEVANT_FILE_LIMIT = 12;
const RELEVANT_FILE_MAX_CHARS = 3000;

export async function buildContext(
  workspaceRoot: string,
  prompt: string
): Promise<string> {
  const sections: string[] = [];

  const allFiles = await getAllFiles(workspaceRoot);
  sections.push("Tracked files (first 200):");
  sections.push(allFiles.slice(0, 200).join("\n") || "(no files)");

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

async function getAllFiles(workspaceRoot: string): Promise<string[]> {
  try {
    const output = await runGit(["ls-files"], workspaceRoot);
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
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


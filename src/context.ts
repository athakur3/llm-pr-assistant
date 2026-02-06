import * as fs from "node:fs/promises";
import * as path from "node:path";
import { runGit } from "./git";

export async function buildContext(workspaceRoot: string): Promise<string> {
  const sections: string[] = [];

  const fileList = await getFileList(workspaceRoot);
  sections.push("Tracked files (first 200):");
  sections.push(fileList.join("\n") || "(no files)");

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

  return sections.join("\n");
}

async function getFileList(workspaceRoot: string): Promise<string[]> {
  try {
    const output = await runGit(["ls-files"], workspaceRoot);
    return output.split("\n").filter(Boolean).slice(0, 200);
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


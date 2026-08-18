import { runGit } from "./git.ts";

export function buildDiffPreviewSummary(changedFiles: string[]): string {
  if (changedFiles.length === 0) {
    return "No file changes to review.";
  }
  const label = changedFiles.length === 1 ? "file" : "files";
  return (
    `Review ${changedFiles.length} changed ${label} before committing. ` +
    "Apply these changes and create the PR?"
  );
}

export async function listChangedFiles(repoRoot: string): Promise<string[]> {
  const modified = await runGit(["diff", "--name-only"], repoRoot);
  const untracked = await runGit(
    ["ls-files", "--others", "--exclude-standard"],
    repoRoot
  );
  const files = [
    ...modified.split("\n").filter(Boolean),
    ...untracked.split("\n").filter(Boolean),
  ];
  return Array.from(new Set(files)).sort();
}

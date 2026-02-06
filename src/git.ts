import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runGit(
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
    });
    return stdout.trim();
  } catch (error) {
    const message = getExecErrorMessage(error);
    throw new Error(`Git command failed: git ${args.join(" ")}\n${message}`);
  }
}

export async function ensureGitRepo(workspaceRoot: string): Promise<string> {
  return runGit(["rev-parse", "--show-toplevel"], workspaceRoot);
}

export async function ensureClean(repoRoot: string): Promise<void> {
  const status = await runGit(["status", "--porcelain"], repoRoot);
  const dirty = status
    .split("\n")
    .filter(Boolean)
    .filter((line) => !isIgnoredDirtyPath(line));
  if (dirty.length > 0) {
    throw new Error("Working tree is not clean. Commit or stash changes first.");
  }
}

function isIgnoredDirtyPath(statusLine: string): boolean {
  if (statusLine.length < 4) {
    return false;
  }
  const filePath = statusLine.slice(3).trim();
  return (
    filePath === ".vscode/settings.json" ||
    filePath === ".vscode/" ||
    filePath.startsWith(".vscode/")
  );
}

export async function createBranch(
  repoRoot: string,
  branchName: string
): Promise<void> {
  await runGit(["checkout", "-b", branchName], repoRoot);
}

export async function applyPatch(
  repoRoot: string,
  patchPath: string
): Promise<void> {
  await runGit(["apply", "--whitespace=fix", patchPath], repoRoot);
}

export async function applyPatchThreeWay(
  repoRoot: string,
  patchPath: string
): Promise<void> {
  await runGit(["apply", "--3way", "--whitespace=fix", patchPath], repoRoot);
}

export async function commitAll(
  repoRoot: string,
  message: string
): Promise<void> {
  await runGit(["add", "-A"], repoRoot);
  await runGit(["commit", "-m", message], repoRoot);
}

export async function pushBranch(
  repoRoot: string,
  branchName: string
): Promise<void> {
  await runGit(["push", "-u", "origin", branchName], repoRoot);
}

export async function pushBranchWithToken(
  repoRoot: string,
  branchName: string,
  token: string
): Promise<void> {
  const askPassPath = path.join(repoRoot, ".llm-pr-assistant-askpass.sh");
  const script = `#!/bin/sh
case "$1" in
  *Username*) echo "x-access-token" ;;
  *Password*) echo "${token}" ;;
  *) echo "" ;;
esac
`;
  await fs.writeFile(askPassPath, script, { mode: 0o700 });
  try {
    await runGit(
      [
        "-c",
        "credential.helper=",
        "-c",
        "credential.useHttpPath=true",
        "push",
        "-u",
        "origin",
        branchName,
      ],
      repoRoot,
      {
        GIT_ASKPASS: askPassPath,
        GIT_TERMINAL_PROMPT: "0",
      }
    );
  } finally {
    await fs.unlink(askPassPath).catch(() => undefined);
  }
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
}

function getExecErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  if ("stderr" in error && typeof error.stderr === "string") {
    return error.stderr.trim();
  }

  if ("message" in error && typeof error.message === "string") {
    return error.message;
  }

  return String(error);
}


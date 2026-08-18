import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function buildBranchName(): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `llm/pr-${stamp}`;
}

export function isRepoSlug(value: string): boolean {
  return /^[^/]+\/[^/]+$/.test(value);
}

export function parseGithubSlug(remoteUrl: string): string | null {
  const httpsMatch = remoteUrl.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshMatch = remoteUrl.match(
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/
  );
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  return null;
}

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

const TOKEN_ENV_VAR = "LLM_PR_ASSISTANT_GIT_TOKEN";

export async function pushBranchWithToken(
  repoRoot: string,
  branchName: string,
  token: string
): Promise<void> {
  // The helper script never contains the token itself — only a reference to
  // the env var carrying it — and lives outside repoRoot, so a leftover file
  // (crash before cleanup, another process reading it) exposes nothing.
  const helperPath = path.join(
    os.tmpdir(),
    `llm-pr-assistant-credential-helper-${randomUUID()}.sh`
  );
  const script = `#!/bin/sh
if [ "$1" = "get" ]; then
  echo "username=x-access-token"
  echo "password=$${TOKEN_ENV_VAR}"
fi
`;
  await fs.writeFile(helperPath, script, { mode: 0o700 });
  try {
    await runGit(
      [
        "-c",
        `credential.helper=${helperPath}`,
        "-c",
        "credential.useHttpPath=true",
        "push",
        "-u",
        "origin",
        branchName,
      ],
      repoRoot,
      {
        [TOKEN_ENV_VAR]: token,
        GIT_TERMINAL_PROMPT: "0",
      }
    );
  } finally {
    await fs.unlink(helperPath).catch(() => undefined);
  }
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
  return runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
}

export async function discardBranchChanges(repoRoot: string): Promise<void> {
  await runGit(["reset", "--hard", "HEAD"], repoRoot);
  await runGit(["clean", "-fd", "-e", ".vscode"], repoRoot);
}

export async function abandonBranch(
  repoRoot: string,
  originalBranch: string,
  branchName: string
): Promise<void> {
  await runGit(["checkout", originalBranch], repoRoot);
  await runGit(["branch", "-D", branchName], repoRoot);
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


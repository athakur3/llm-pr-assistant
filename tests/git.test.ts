import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildBranchName,
  isRepoSlug,
  parseGithubSlug,
  pushBranchWithToken,
} from "../src/git.ts";

const execFileAsync = promisify(execFile);

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "llm-pr-assistant-git-"));
}

async function listCredentialHelperFiles(): Promise<string[]> {
  return (await fs.readdir(os.tmpdir())).filter((name) =>
    name.startsWith("llm-pr-assistant-credential-helper-")
  );
}

test("buildBranchName produces llm/pr-YYYYMMDD-HHMMSS", () => {
  assert.match(buildBranchName(), /^llm\/pr-\d{8}-\d{6}$/);
});

test("isRepoSlug accepts org/repo and rejects everything else", () => {
  assert.equal(isRepoSlug("octocat/hello-world"), true);
  assert.equal(isRepoSlug("just-a-name"), false);
  assert.equal(isRepoSlug("a/b/c"), false);
  assert.equal(isRepoSlug(""), false);
});

test("parseGithubSlug handles https remotes with and without .git", () => {
  assert.equal(
    parseGithubSlug("https://github.com/octocat/hello-world.git"),
    "octocat/hello-world"
  );
  assert.equal(
    parseGithubSlug("https://github.com/octocat/hello-world"),
    "octocat/hello-world"
  );
});

test("parseGithubSlug handles ssh remotes", () => {
  assert.equal(
    parseGithubSlug("git@github.com:octocat/hello-world.git"),
    "octocat/hello-world"
  );
});

test("parseGithubSlug rejects non-github remotes", () => {
  assert.equal(parseGithubSlug("https://gitlab.com/a/b.git"), null);
  assert.equal(parseGithubSlug("not a url"), null);
});

test("pushBranchWithToken pushes without leaving a token file behind", async () => {
  const bareRemote = await makeTempDir();
  await execFileAsync("git", ["init", "--bare", "-q"], { cwd: bareRemote });

  const repoRoot = await makeTempDir();
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], {
    cwd: repoRoot,
  });
  await fs.writeFile(path.join(repoRoot, "a.txt"), "hi", "utf8");
  await execFileAsync("git", ["add", "-A"], { cwd: repoRoot });
  await execFileAsync("git", ["commit", "-q", "-m", "init"], {
    cwd: repoRoot,
  });
  await execFileAsync("git", ["branch", "-M", "main"], { cwd: repoRoot });
  await execFileAsync("git", ["remote", "add", "origin", bareRemote], {
    cwd: repoRoot,
  });

  const helpersBefore = await listCredentialHelperFiles();

  await pushBranchWithToken(repoRoot, "main", "fake-token-value");

  const repoFiles = await fs.readdir(repoRoot);
  assert.ok(
    !repoFiles.some(
      (name) => name.includes("askpass") || name.includes("credential")
    ),
    "no credential-related file should be left in the repo working tree"
  );

  const helpersAfter = await listCredentialHelperFiles();
  assert.deepEqual(
    helpersAfter,
    helpersBefore,
    "the temporary credential helper script should be cleaned up after push"
  );
});

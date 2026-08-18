import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createListFilesTool,
  createReadFileTool,
  createWriteFileTool,
  resolveRepoPath,
} from "../src/llm/tools.ts";

const execFileAsync = promisify(execFile);

async function makeTempRepo(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "llm-pr-assistant-tools-"));
}

test("resolveRepoPath joins a relative path onto the repo root", () => {
  const resolved = resolveRepoPath("/repo", "src/app.ts");
  assert.equal(resolved, path.resolve("/repo", "src/app.ts"));
});

test("resolveRepoPath rejects paths that escape the repo root", () => {
  assert.throws(() => resolveRepoPath("/repo", "../outside.txt"));
  assert.throws(() => resolveRepoPath("/repo", "../../etc/passwd"));
  assert.throws(() => resolveRepoPath("/repo", "/etc/passwd"));
});

test("read_file tool returns file contents", async () => {
  const repoRoot = await makeTempRepo();
  await fs.writeFile(path.join(repoRoot, "notes.txt"), "hello world", "utf8");

  const tool = createReadFileTool(repoRoot);
  const result = await tool.run({ path: "notes.txt" });

  assert.equal(result, "hello world");
});

test("read_file tool reports a missing file instead of throwing", async () => {
  const repoRoot = await makeTempRepo();
  const tool = createReadFileTool(repoRoot);

  const result = await tool.run({ path: "missing.txt" });

  assert.match(String(result), /Error: could not read missing\.txt/);
});

test("read_file tool rejects a path that escapes the repo root", async () => {
  const repoRoot = await makeTempRepo();
  const tool = createReadFileTool(repoRoot);

  await assert.rejects(async () => tool.run({ path: "../outside.txt" }));
});

test("write_file tool creates missing directories and writes content", async () => {
  const repoRoot = await makeTempRepo();
  const tool = createWriteFileTool(repoRoot);

  await tool.run({ path: "src/new/file.ts", content: "export const a = 1;" });

  const written = await fs.readFile(
    path.join(repoRoot, "src/new/file.ts"),
    "utf8"
  );
  assert.equal(written, "export const a = 1;");
});

test("write_file tool rejects a path that escapes the repo root", async () => {
  const repoRoot = await makeTempRepo();
  const tool = createWriteFileTool(repoRoot);

  await assert.rejects(async () =>
    tool.run({ path: "../escape.txt", content: "nope" })
  );

  await assert.rejects(() =>
    fs.stat(path.join(path.dirname(repoRoot), "escape.txt"))
  );
});

test("list_files tool lists git-tracked files", async () => {
  const repoRoot = await makeTempRepo();
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });
  await fs.writeFile(path.join(repoRoot, "a.txt"), "a", "utf8");
  await fs.writeFile(path.join(repoRoot, "b.txt"), "b", "utf8");
  await execFileAsync("git", ["add", "a.txt", "b.txt"], { cwd: repoRoot });

  const tool = createListFilesTool(repoRoot);
  const result = await tool.run({});

  assert.equal(result, "a.txt\nb.txt");
});

test("list_files tool reports an empty repository", async () => {
  const repoRoot = await makeTempRepo();
  await execFileAsync("git", ["init", "-q"], { cwd: repoRoot });

  const tool = createListFilesTool(repoRoot);
  const result = await tool.run({});

  assert.equal(result, "(repository has no tracked files)");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildContext,
  formatTrackedFilesSection,
  listTrackedFiles,
} from "../src/context.ts";

const execFileAsync = promisify(execFile);

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "llm-pr-context-"));
}

async function makeTempRepo(): Promise<string> {
  const dir = await makeTempDir();
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

test("formatTrackedFilesSection separates unreadable from empty", () => {
  const unreadable = formatTrackedFilesSection({
    status: "unreadable",
    error: "fatal: not a git repository",
  });
  const empty = formatTrackedFilesSection({ status: "empty" });

  assert.match(unreadable, /could not be read/);
  assert.match(empty, /no tracked files/);
  assert.notEqual(unreadable, empty);
});

test("formatTrackedFilesSection lists files and caps the listing", () => {
  const files = Array.from({ length: 250 }, (_, i) => `src/file-${i}.ts`);
  const section = formatTrackedFilesSection({ status: "ok", files });

  assert.match(section, /^Tracked files \(first 200\):/);
  assert.ok(section.includes("src/file-0.ts"));
  assert.ok(section.includes("src/file-199.ts"));
  assert.ok(!section.includes("src/file-200.ts"));
});

test("listTrackedFiles reports 'unreadable' when git cannot answer", async () => {
  const notARepo = await makeTempDir();
  const tracked = await listTrackedFiles(notARepo);

  assert.equal(tracked.status, "unreadable");
  if (tracked.status === "unreadable") {
    assert.ok(tracked.error.length > 0);
  }
  await fs.rm(notARepo, { recursive: true, force: true });
});

test("listTrackedFiles reports 'empty' for a repo with no tracked files", async () => {
  const repo = await makeTempRepo();
  const tracked = await listTrackedFiles(repo);

  assert.equal(tracked.status, "empty");
  await fs.rm(repo, { recursive: true, force: true });
});

test("listTrackedFiles reports 'ok' with the tracked files", async () => {
  const repo = await makeTempRepo();
  await fs.writeFile(path.join(repo, "a.ts"), "export const a = 1;\n", "utf8");
  await execFileAsync("git", ["add", "a.ts"], { cwd: repo });
  const tracked = await listTrackedFiles(repo);

  assert.equal(tracked.status, "ok");
  if (tracked.status === "ok") {
    assert.deepEqual(tracked.files, ["a.ts"]);
  }
  await fs.rm(repo, { recursive: true, force: true });
});

test("buildContext logs the git error and says so in the prompt when unreadable", async () => {
  const notARepo = await makeTempDir();
  const logged: string[] = [];
  const context = await buildContext(notARepo, "add a feature", (message) =>
    logged.push(message)
  );

  assert.match(context, /could not be read/);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Could not read this repository's tracked file list/);
  assert.match(logged[0], /Git command failed/);
  await fs.rm(notARepo, { recursive: true, force: true });
});

test("buildContext distinguishes an empty repo from an unreadable one", async () => {
  const repo = await makeTempRepo();
  const logged: string[] = [];
  const context = await buildContext(repo, "add a feature", (message) =>
    logged.push(message)
  );

  assert.match(context, /no tracked files/);
  assert.ok(!/could not be read/.test(context));
  assert.deepEqual(logged, ["This repository has no tracked files."]);
  await fs.rm(repo, { recursive: true, force: true });
});

test("buildContext still works without a logger", async () => {
  const notARepo = await makeTempDir();
  const context = await buildContext(notARepo, "add a feature");

  assert.match(context, /could not be read/);
  await fs.rm(notARepo, { recursive: true, force: true });
});

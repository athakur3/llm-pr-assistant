import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ensureDiffGitHeader,
  ensureTrailingNewline,
  extractFilePathFromPrompt,
  extractNewFileContentFromPatch,
  extractPrimaryFilePath,
  extractUnifiedDiff,
  isNewFilePatch,
  stripCodeFences,
} from "../src/patch.ts";

const MODIFY_PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,2 +1,2 @@",
  "-const a = 1;",
  "+const a = 2;",
  " const b = 3;",
].join("\n");

const NEW_FILE_PATCH = [
  "--- /dev/null",
  "+++ b/docs/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+hello",
].join("\n");

test("stripCodeFences removes fence markers but keeps fenced content", () => {
  assert.equal(stripCodeFences("a ```x\ncode\n``` b"), "a x\ncode\n b");
  assert.equal(stripCodeFences("no fences"), "no fences");
});

test("stripCodeFences leaves an unmatched fence alone", () => {
  assert.equal(stripCodeFences("```only one"), "```only one");
});

test("extractUnifiedDiff finds diff --git after prose", () => {
  const raw = `Here is the patch:\n\n${MODIFY_PATCH}`;
  assert.equal(extractUnifiedDiff(raw), MODIFY_PATCH);
});

test("extractUnifiedDiff unwraps fenced diffs", () => {
  const raw = "```diff\n" + MODIFY_PATCH + "\n```";
  assert.equal(extractUnifiedDiff(raw), MODIFY_PATCH);
});

test("extractUnifiedDiff falls back to --- header when no diff --git", () => {
  const raw = `Sure!\n${NEW_FILE_PATCH}`;
  assert.equal(extractUnifiedDiff(raw), NEW_FILE_PATCH);
});

test("extractUnifiedDiff returns trimmed input when nothing looks like a diff", () => {
  assert.equal(extractUnifiedDiff("  just text  "), "just text");
});

test("ensureDiffGitHeader leaves patches with a header untouched", () => {
  assert.equal(ensureDiffGitHeader(MODIFY_PATCH), MODIFY_PATCH);
});

test("ensureDiffGitHeader adds header and new-file mode for /dev/null source", () => {
  const result = ensureDiffGitHeader(NEW_FILE_PATCH);
  const lines = result.split("\n");
  assert.equal(lines[0], "diff --git a/docs/notes.md b/docs/notes.md");
  assert.equal(lines[1], "new file mode 100644");
  assert.equal(lines.slice(2).join("\n"), NEW_FILE_PATCH);
});

test("ensureDiffGitHeader adds deleted-file mode for /dev/null target", () => {
  const patch = [
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-bye",
  ].join("\n");
  const lines = ensureDiffGitHeader(patch).split("\n");
  assert.equal(lines[0], "diff --git a/old.txt b/old.txt");
  assert.equal(lines[1], "deleted file mode 100644");
});

test("ensureDiffGitHeader returns input unchanged without ---/+++ lines", () => {
  assert.equal(ensureDiffGitHeader("not a patch"), "not a patch");
});

test("ensureTrailingNewline appends exactly one newline when missing", () => {
  assert.equal(ensureTrailingNewline("x"), "x\n");
  assert.equal(ensureTrailingNewline("x\n"), "x\n");
  assert.equal(ensureTrailingNewline(""), "");
});

test("isNewFilePatch detects /dev/null sources and -0,0 hunks", () => {
  assert.equal(isNewFilePatch(NEW_FILE_PATCH), true);
  assert.equal(isNewFilePatch("@@ -0,0 +1,5 @@"), true);
  assert.equal(isNewFilePatch(MODIFY_PATCH), false);
});

test("extractNewFileContentFromPatch returns added lines of a new-file patch", () => {
  assert.equal(extractNewFileContentFromPatch(NEW_FILE_PATCH), "# Notes\nhello");
});

test("extractNewFileContentFromPatch returns null for modification patches", () => {
  assert.equal(extractNewFileContentFromPatch(MODIFY_PATCH), null);
});

test("extractPrimaryFilePath prefers the +++ target path", () => {
  assert.equal(extractPrimaryFilePath(MODIFY_PATCH), "src/app.ts");
  assert.equal(extractPrimaryFilePath(NEW_FILE_PATCH), "docs/notes.md");
});

test("extractPrimaryFilePath falls back to the diff --git line", () => {
  assert.equal(
    extractPrimaryFilePath("diff --git a/x.txt b/y.txt"),
    "y.txt"
  );
  assert.equal(extractPrimaryFilePath("nothing here"), null);
});

test("extractFilePathFromPrompt finds a known-extension path", () => {
  assert.equal(
    extractFilePathFromPrompt("please update src/utils/date.ts to fix parsing"),
    "src/utils/date.ts"
  );
  assert.equal(extractFilePathFromPrompt("no file mentioned"), null);
});

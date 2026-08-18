import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiffPreviewSummary } from "../src/diffPreview.ts";

test("buildDiffPreviewSummary reports no changes", () => {
  assert.equal(
    buildDiffPreviewSummary([]),
    "No file changes to review."
  );
});

test("buildDiffPreviewSummary uses singular file wording for one change", () => {
  assert.equal(
    buildDiffPreviewSummary(["src/extension.ts"]),
    "Review 1 changed file before committing. Apply these changes and create the PR?"
  );
});

test("buildDiffPreviewSummary uses plural files wording for multiple changes", () => {
  assert.equal(
    buildDiffPreviewSummary(["a.ts", "b.ts", "c.ts"]),
    "Review 3 changed files before committing. Apply these changes and create the PR?"
  );
});

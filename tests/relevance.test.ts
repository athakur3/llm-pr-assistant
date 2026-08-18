import { test } from "node:test";
import assert from "node:assert/strict";
import { extractKeywords, rankFilesByPrompt } from "../src/relevance.ts";

test("extractKeywords lowercases, splits, dedupes, and drops stop words/short tokens", () => {
  assert.deepEqual(
    extractKeywords("Add retry logic to the API client, and the client tests"),
    ["retry", "logic", "api", "client", "tests"]
  );
});

test("extractKeywords returns nothing for a prompt with only stop words", () => {
  assert.deepEqual(extractKeywords("the and for"), []);
});

test("rankFilesByPrompt scores path-segment matches above substring matches", () => {
  const files = [
    "src/auth/login.ts",
    "src/payment/retry.ts",
    "src/unrelated/index.ts",
    "docs/retryable.md",
  ];
  const ranked = rankFilesByPrompt(files, "add retry logic to payment", 10);
  assert.deepEqual(ranked, ["src/payment/retry.ts", "docs/retryable.md"]);
});

test("rankFilesByPrompt respects the limit and excludes zero-score files", () => {
  const files = ["src/auth/login.ts", "src/auth/logout.ts", "src/other.ts"];
  const ranked = rankFilesByPrompt(files, "fix the auth module", 1);
  assert.equal(ranked.length, 1);
  assert.ok(files.slice(0, 2).includes(ranked[0]));
});

test("rankFilesByPrompt returns an empty list when the prompt has no keywords", () => {
  assert.deepEqual(rankFilesByPrompt(["src/a.ts"], "the and for", 5), []);
});

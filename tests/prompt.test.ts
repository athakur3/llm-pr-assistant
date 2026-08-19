import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTaskSizing,
  extractRequestedCount,
  findClosestNumberWord,
  levenshteinDistance,
  parsePlan,
  planFailureAdvice,
  planFailureMessage,
} from "../src/prompt.ts";

test("levenshteinDistance handles equal, empty, and mixed strings", () => {
  assert.equal(levenshteinDistance("abc", "abc"), 0);
  assert.equal(levenshteinDistance("", "abc"), 3);
  assert.equal(levenshteinDistance("abc", ""), 3);
  assert.equal(levenshteinDistance("kitten", "sitting"), 3);
  assert.equal(levenshteinDistance("three", "thre"), 1);
});

test("findClosestNumberWord corrects small typos within the distance cap", () => {
  const map = { three: 3, seven: 7, twenty: 20 };
  assert.equal(findClosestNumberWord("thre", map, 2), "three");
  assert.equal(findClosestNumberWord("sevn", map, 2), "seven");
  assert.equal(findClosestNumberWord("zzzzzz", map, 2), "");
});

test("extractRequestedCount reads digit counts", () => {
  assert.equal(extractRequestedCount("create 12 endpoints"), 12);
  assert.equal(extractRequestedCount("nothing numeric"), 0);
});

test("extractRequestedCount reads number words, including compounds", () => {
  assert.equal(extractRequestedCount("add five tests"), 5);
  assert.equal(extractRequestedCount("write twenty-five stories"), 25);
  assert.equal(extractRequestedCount("write twenty five stories"), 25);
});

test("extractRequestedCount takes the maximum mentioned count", () => {
  assert.equal(extractRequestedCount("split 3 files into 10 modules"), 10);
});

test("classifyTaskSizing returns TIER_1 for small scoped prompts", () => {
  assert.equal(classifyTaskSizing("fix the typo in the readme", "small"), "TIER_1");
});

test("classifyTaskSizing returns TIER_2 for mid-size prompts", () => {
  assert.equal(classifyTaskSizing("add five tests for the parser", "ctx"), "TIER_2");
});

test("classifyTaskSizing returns TIER_3 for long high-count prompts", () => {
  const prompt = `create 25 components for the design system. ${"details ".repeat(90)}`;
  assert.equal(classifyTaskSizing(prompt, "ctx"), "TIER_3");
});

test("parsePlan parses a plain JSON array of steps", () => {
  const raw = '[{"title": "Step 1", "instruction": "Do the thing"}]';
  assert.deepEqual(parsePlan(raw), {
    ok: true,
    steps: [{ title: "Step 1", instruction: "Do the thing" }],
  });
});

test("parsePlan unwraps fenced JSON and surrounding prose", () => {
  const raw =
    'Here you go:\n```json\n[{"title": "T", "instruction": "I"}]\n```\nDone.';
  assert.deepEqual(parsePlan(raw), {
    ok: true,
    steps: [{ title: "T", instruction: "I" }],
  });
});

test("parsePlan drops steps missing a title or instruction", () => {
  const raw =
    '[{"title": "ok", "instruction": "ok"}, {"title": "", "instruction": "x"}, {"title": "y"}]';
  assert.deepEqual(parsePlan(raw), {
    ok: true,
    steps: [{ title: "ok", instruction: "ok" }],
  });
});

test("parsePlan unwraps a steps array nested in a JSON object", () => {
  const raw = '{"steps": [{"title": "Step 1", "instruction": "Do the thing"}]}';
  assert.deepEqual(parsePlan(raw), {
    ok: true,
    steps: [{ title: "Step 1", instruction: "Do the thing" }],
  });
});

test("parsePlan names each of the four ways a plan comes back unusable", () => {
  assert.deepEqual(parsePlan("total garbage"), {
    ok: false,
    reason: "unparseable",
  });
  assert.deepEqual(parsePlan('{"title": "not an array"}'), {
    ok: false,
    reason: "not-a-list",
  });
  assert.deepEqual(parsePlan("[]"), { ok: false, reason: "empty" });
  assert.deepEqual(parsePlan('[{"title": "", "instruction": "i"}]'), {
    ok: false,
    reason: "steps-incomplete",
  });
});

test("parsePlan returns the steps when the plan is usable", () => {
  assert.deepEqual(parsePlan('[{"title": "T", "instruction": "I"}]'), {
    ok: true,
    steps: [{ title: "T", instruction: "I" }],
  });
});

test("planFailureMessage carries a machine-readable cause token", () => {
  const message = planFailureMessage("steps-incomplete");
  assert.ok(message.startsWith("Failed to generate execution plan"));
  assert.ok(message.includes("(steps-incomplete)"));
});

test("planFailureAdvice gives distinct advice per cause", () => {
  const advice = (["unparseable", "not-a-list", "empty", "steps-incomplete"] as const).map(
    (reason) => planFailureAdvice(planFailureMessage(reason))
  );
  assert.ok(advice.every((entry) => typeof entry === "string" && entry.length > 0));
  assert.equal(new Set(advice).size, 4);
});

test("planFailureAdvice falls back for a plan failure with no cause token", () => {
  assert.equal(
    planFailureAdvice("Failed to generate execution plan."),
    "Could not plan the task. Try a smaller scope or run again."
  );
});

test("planFailureAdvice ignores errors that are not plan failures", () => {
  assert.equal(planFailureAdvice("Working tree is not clean"), null);
});

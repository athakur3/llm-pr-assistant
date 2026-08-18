import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTickGate,
  formatCharCount,
  formatCacheUsage,
} from "../src/progress.ts";

test("createTickGate emits only once the threshold is crossed", () => {
  const gate = createTickGate(100);
  assert.equal(gate(50), false);
  assert.equal(gate(99), false);
  assert.equal(gate(100), true);
  assert.equal(gate(150), false);
  assert.equal(gate(199), false);
  assert.equal(gate(200), true);
});

test("createTickGate instances track their own state independently", () => {
  const a = createTickGate(10);
  const b = createTickGate(10);
  assert.equal(a(10), true);
  assert.equal(b(5), false);
  assert.equal(b(10), true);
});

test("formatCharCount uses plain counts under 1000", () => {
  assert.equal(formatCharCount(0), "0 chars");
  assert.equal(formatCharCount(999), "999 chars");
});

test("formatCharCount uses k-suffix at and above 1000", () => {
  assert.equal(formatCharCount(1000), "1.0k chars");
  assert.equal(formatCharCount(2340), "2.3k chars");
  assert.equal(formatCharCount(64000), "64.0k chars");
});

test("formatCacheUsage reports none when both counts are zero", () => {
  assert.equal(formatCacheUsage(0, 0), "cache: none");
});

test("formatCacheUsage reports read tokens on a cache hit", () => {
  assert.equal(formatCacheUsage(4200, 0), "cache: 4200 read");
});

test("formatCacheUsage reports written tokens on a cache miss", () => {
  assert.equal(formatCacheUsage(0, 4200), "cache: 4200 written");
});

test("formatCacheUsage reports both when present", () => {
  assert.equal(formatCacheUsage(100, 200), "cache: 100 read, 200 written");
});

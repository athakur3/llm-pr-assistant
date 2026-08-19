import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_APP_ERROR_CODES,
  appError,
  appErrorToken,
  toUserErrorMessage,
  type AppErrorCode,
} from "../src/errors.ts";
import { planFailureMessage } from "../src/prompt.ts";


test("every code round-trips from throw site to distinct user advice", () => {
  const seen = new Map<string, AppErrorCode>();
  assert.ok(ALL_APP_ERROR_CODES.length >= 15, "code list looks truncated");
  for (const code of ALL_APP_ERROR_CODES) {
    const advice = toUserErrorMessage(appError(code));
    assert.ok(advice, `${code} produced no advice`);
    assert.ok(
      !advice.includes("llmpr:"),
      `${code} leaked its token into user text`
    );
    const clash = seen.get(advice);
    assert.equal(clash, undefined, `${code} and ${clash} share advice`);
    seen.set(advice, code);
  }
});

test("advice survives rewording the internal message", () => {
  const reworded = new Error(
    `totally different wording ${appErrorToken("missing-repo")}`
  );
  assert.equal(
    toUserErrorMessage(reworded),
    "Repository is missing. Enter it as owner/repo."
  );
});

test("appError keeps the cause readable and appends detail for logs", () => {
  const withDetail = appError("refusal", "the request asked for malware");
  assert.match(withDetail.message, /^Claude declined to respond to this request\./);
  assert.ok(withDetail.message.includes("the request asked for malware"));
  assert.ok(withDetail.message.includes(appErrorToken("refusal")));

  // Detail is a log affordance only — it must not reach the user.
  const shown = toUserErrorMessage(withDetail);
  assert.ok(!shown.includes("malware"));

  assert.equal(
    appError("refusal").message,
    `Claude declined to respond to this request. ${appErrorToken("refusal")}`
  );
  assert.equal(appError("refusal", "   ").message, appError("refusal").message);
});

test("plan failures still map through planFailureAdvice", () => {
  const advice = toUserErrorMessage(new Error(planFailureMessage("empty")));
  assert.ok(advice);
  assert.notEqual(advice, "Something went wrong. Please try again.");
});

test("foreign text from the Anthropic SDK maps to model advice", () => {
  for (const raw of [
    "404 {'type':'not_found_error','message':'model: claude-3-5-sonnet-latest'}",
    "not_found_error",
    "model: claude-2",
  ]) {
    assert.match(toUserErrorMessage(new Error(raw)), /Claude model not available/);
  }
});

test("foreign text from git maps to push-permission advice", () => {
  const raw =
    "Git command failed: git push\nremote: Permission to a/b.git denied to user.";
  assert.match(toUserErrorMessage(new Error(raw)), /Git push failed due to permission/);
  // Both halves are required: "denied" alone is not a push-permission failure.
  assert.equal(
    toUserErrorMessage(new Error("access was denied")),
    "access was denied"
  );
});

test("unrecognised errors are shown as-is, without internal tokens", () => {
  assert.equal(toUserErrorMessage(new Error("Setup required.")), "Setup required.");
  assert.equal(
    toUserErrorMessage(new Error(`Some new failure (llmpr:not-a-real-code)`)),
    "Some new failure"
  );
});

test("empty and non-Error inputs get the generic fallback", () => {
  for (const input of [new Error(""), "", null, undefined]) {
    assert.equal(
      toUserErrorMessage(input),
      "Something went wrong. Please try again."
    );
  }
  assert.equal(toUserErrorMessage("plain string failure"), "plain string failure");
});

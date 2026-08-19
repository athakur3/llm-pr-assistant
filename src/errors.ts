import { planFailureAdvice } from "./prompt.ts";

/**
 * User-facing error mapping, lifted out of extension.ts so it can be tested.
 *
 * Two kinds of text reach `toUserErrorMessage`, and they are matched
 * differently on purpose:
 *
 * 1. Errors WE throw carry a stable `(llmpr:<code>)` token, produced by
 *    `appError`. Rewording an internal message never changes which advice a
 *    user sees, and the round trip is covered by tests/errors.test.ts.
 * 2. Errors from git, GitHub and the Anthropic SDK are matched by substring,
 *    because we do not own that text. Those branches are marked FOREIGN TEXT
 *    below. They are fragile by necessity rather than by oversight: a token
 *    cannot be put into a string this codebase never emits. Do not "finish the
 *    job" by converting them.
 */
export type AppErrorCode =
  | "dirty-worktree"
  | "missing-api-key"
  | "missing-github-token"
  | "missing-repo"
  | "no-file-changes"
  | "changes-declined"
  | "refusal"
  | "github-device-expired"
  | "github-access-denied"
  | "github-login-timeout";

/** What the thrown Error says — for logs and for anyone reading a stack. */
const APP_ERROR_CAUSE: Record<AppErrorCode, string> = {
  "dirty-worktree": "Working tree is not clean. Commit or stash changes first.",
  "missing-api-key": "Missing Anthropic API key.",
  "missing-github-token": "Missing GitHub token.",
  "missing-repo": "Missing repository.",
  "no-file-changes": "Model made no file changes.",
  "changes-declined": "Changes were not approved.",
  refusal: "Claude declined to respond to this request.",
  "github-device-expired": "GitHub device code expired.",
  "github-access-denied": "GitHub access denied.",
  "github-login-timeout": "GitHub login timed out.",
};

/** What the user is told, and what to do about it. */
const APP_ERROR_ADVICE: Record<AppErrorCode, string> = {
  "dirty-worktree":
    "Your repo has uncommitted changes. Commit, stash, or clean changes " +
    "before running the assistant.",
  "missing-api-key": "Anthropic API key is missing. Add it in the setup step.",
  "missing-github-token":
    "GitHub login is required. Click 'Sign In to GitHub' to continue.",
  "missing-repo": "Repository is missing. Enter it as owner/repo.",
  "no-file-changes":
    "The model didn't make any file changes. Try rephrasing the request " +
    "or narrowing the scope.",
  "changes-declined":
    "Changes were declined in the diff preview. Nothing was committed, " +
    "pushed, or opened as a PR.",
  refusal:
    "Claude declined to respond to this request. Try rephrasing or " +
    "narrowing the prompt.",
  "github-device-expired": "GitHub login expired. Please sign in again.",
  "github-access-denied":
    "GitHub access was denied. Please approve the login to continue.",
  "github-login-timeout": "GitHub login timed out. Please try again.",
};

const TOKEN_PATTERN = /\s*\(llmpr:[a-z-]+\)/g;

export function appErrorToken(code: AppErrorCode): string {
  return `(llmpr:${code})`;
}

/**
 * The one way this codebase raises an error it knows how to explain. `detail`
 * appends context that is useful in a log but never shown to the user.
 */
export function appError(
  code: AppErrorCode,
  detail?: string | null
): Error {
  const suffix = detail?.trim() ? ` ${detail.trim()}` : "";
  return new Error(
    `${APP_ERROR_CAUSE[code]} ${appErrorToken(code)}${suffix}`
  );
}

function findAppErrorCode(raw: string): AppErrorCode | null {
  for (const code of Object.keys(APP_ERROR_ADVICE) as AppErrorCode[]) {
    if (raw.includes(appErrorToken(code))) {
      return code;
    }
  }
  return null;
}

export function toUserErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");

  const code = findAppErrorCode(raw);
  if (code) {
    return APP_ERROR_ADVICE[code];
  }

  const planAdvice = planFailureAdvice(raw);
  if (planAdvice) {
    return planAdvice;
  }

  // FOREIGN TEXT: the Anthropic SDK's 404 for an unknown or retired model.
  // We do not emit this string, so substring matching is the only option.
  if (raw.includes("model:") || raw.includes("not_found_error")) {
    return (
      "Claude model not available. Set a valid model in settings " +
      "(llmPrAssistant.claudeModel) or use 'claude-opus-5'."
    );
  }

  // FOREIGN TEXT: git's own push rejection, surfaced through runGit.
  if (raw.includes("Permission to") && raw.includes("denied")) {
    return (
      "Git push failed due to permission issues. Make sure the GitHub " +
      "account you signed in with has access to the repo, then try again."
    );
  }

  // Anything unrecognised is shown as-is, minus our internal tokens.
  const cleaned = raw.replace(TOKEN_PATTERN, "").trim();
  return cleaned || "Something went wrong. Please try again.";
}

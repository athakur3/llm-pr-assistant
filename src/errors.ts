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
  | "github-login-timeout"
  | "github-http-auth"
  | "github-http-rate-limit"
  | "github-http-client"
  | "github-http-server"
  | "github-bad-response";

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
  "github-http-auth": "GitHub rejected the request as unauthorized.",
  "github-http-rate-limit": "GitHub rate-limited the request.",
  "github-http-client": "GitHub rejected the request.",
  "github-http-server": "GitHub returned a server error.",
  "github-bad-response": "Unexpected response from GitHub.",
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
  "github-http-auth":
    "GitHub refused the sign-in request as unauthorized. Sign out of the " +
    "assistant, sign in again, and check the output channel for the exact " +
    "status if it keeps happening.",
  "github-http-rate-limit":
    "GitHub is rate-limiting sign-in requests. Wait a minute, then try " +
    "signing in again.",
  "github-http-client":
    "GitHub rejected the sign-in request. The output channel has the exact " +
    "status and response — please include it if you report this.",
  "github-http-server":
    "GitHub had a server-side error. This is usually temporary — check " +
    "githubstatus.com and try again in a few minutes.",
  "github-bad-response":
    "GitHub sent a response this extension could not read. The output " +
    "channel has the status and a short excerpt of what arrived.",
};

const TOKEN_PATTERN = /\s*\(llmpr:[a-z-]+\)/g;

/**
 * Anything shaped like a credential, redacted before error text is written to
 * the output channel. Response bodies and git's stderr are not ours to trust
 * with a log line: a remote URL of the form `https://user:token@github.com/...`
 * puts a live token in a message we would otherwise print verbatim.
 */
const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /\b(access_token|refresh_token|client_secret)=[^&\s"]+/gi,
  /"(access_token|refresh_token|client_secret)"\s*:\s*"[^"]*"/gi,
  /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (acc, pattern) =>
      acc.replace(pattern, (match, ...groups) => {
        const scheme = typeof groups[0] === "string" && /^https?:\/\/$/i.test(groups[0])
          ? groups[0]
          : null;
        if (scheme) {
          return `${scheme}[redacted]@`;
        }
        const separator = match.includes("=")
          ? "="
          : match.includes('":')
            ? '":'
            : null;
        if (!separator) {
          return "[redacted]";
        }
        const [name] = match.split(separator);
        return separator === "="
          ? `${name}=[redacted]`
          : `${name}": "[redacted]"`;
      }),
    text
  );
}

/**
 * What belongs in the output channel when an error is shown to a user: the
 * message we actually threw — including an `appError` detail such as an HTTP
 * status — minus anything that looks like a credential. The user sees
 * `toUserErrorMessage`; a log line gets this.
 */
export function toLogDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  return redactSecrets(raw).trim();
}

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

/**
 * Every code, derived from the advice map rather than repeated. `Record<
 * AppErrorCode, string>` already forces the maps to cover the union, so
 * deriving the list here means a new code cannot be added without both its
 * advice and its test coverage following it.
 */
export const ALL_APP_ERROR_CODES = Object.keys(
  APP_ERROR_ADVICE
) as AppErrorCode[];

function findAppErrorCode(raw: string): AppErrorCode | null {
  for (const code of ALL_APP_ERROR_CODES) {
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

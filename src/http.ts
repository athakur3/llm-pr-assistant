import * as http from "node:http";
import * as https from "node:https";
import { URLSearchParams } from "node:url";
import { appError, redactSecrets, type AppErrorCode } from "./errors.ts";

/**
 * Form POSTs to GitHub's device-flow endpoints, lifted out of extension.ts so
 * the failure paths can be tested against a local server.
 *
 * The reason this module exists at all: the previous version read the body and
 * never looked at `response.statusCode`, so a 401, a 500 and an HTML error page
 * all arrived at the user as one opaque sentence — a failure and a surprise
 * rendered identically, in the first code path a user hits. The status is now
 * classified into an error code (distinct advice per class) and preserved,
 * along with a short body excerpt, as log-only detail.
 */

/** How much of a failing response body is worth keeping for a log line. */
const BODY_EXCERPT_LIMIT = 200;

/** A single-line, length-capped, secret-free view of a response body. */
export function bodyExcerpt(body: string): string {
  const collapsed = redactSecrets(body).replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "(empty body)";
  }
  return collapsed.length > BODY_EXCERPT_LIMIT
    ? `${collapsed.slice(0, BODY_EXCERPT_LIMIT)}...`
    : collapsed;
}

/**
 * Which advice a status deserves. Grouped by what the user can do about it,
 * not by the number: nothing actionable distinguishes a 502 from a 503.
 * `null` means the status is a success and the body should be parsed.
 */
export function httpErrorCodeForStatus(status: number): AppErrorCode | null {
  if (status >= 200 && status < 300) {
    return null;
  }
  if (status === 401 || status === 403) {
    return "github-http-auth";
  }
  if (status === 429) {
    return "github-http-rate-limit";
  }
  if (status >= 500 && status < 600) {
    return "github-http-server";
  }
  if (status >= 400 && status < 500) {
    return "github-http-client";
  }
  // 1xx and 3xx: we send no `Expect` header and follow no redirects, so
  // neither is an answer to the request we made.
  return "github-bad-response";
}

type RawResponse = { status: number; body: string };

function requestForm(url: string, body: string): Promise<RawResponse> {
  const transport = new URL(url).protocol === "http:" ? http : https;

  return new Promise<RawResponse>((resolve, reject) => {
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: data });
        });
      }
    );

    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

/** `https://github.com/login/device/code` -> `github.com/login/device/code`. */
function describeTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

export async function postForm(
  url: string,
  params: Record<string, string>
): Promise<Record<string, unknown>> {
  const { status, body } = await requestForm(
    url,
    new URLSearchParams(params).toString()
  );
  const where = `${describeTarget(url)} returned HTTP ${status}`;

  const statusCode = httpErrorCodeForStatus(status);
  if (statusCode) {
    throw appError(statusCode, `${where}: ${bodyExcerpt(body)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw appError(
      "github-bad-response",
      `${where} with a body that is not JSON: ${bodyExcerpt(body)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw appError(
      "github-bad-response",
      `${where} with JSON that is not an object: ${bodyExcerpt(body)}`
    );
  }

  return parsed as Record<string, unknown>;
}

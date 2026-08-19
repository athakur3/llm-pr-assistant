import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  bodyExcerpt,
  httpErrorCodeForStatus,
  postForm,
} from "../src/http.ts";
import {
  appErrorToken,
  toLogDetail,
  toUserErrorMessage,
  type AppErrorCode,
} from "../src/errors.ts";

type Reply = { status: number; body: string; contentType?: string };

/**
 * Serves one canned reply and records what arrived. Real sockets, real status
 * lines — the point of these tests is the part of the request/response cycle
 * the old implementation never looked at.
 */
async function withServer(
  reply: Reply,
  run: (url: string, seen: { body: string; contentType?: string }) => Promise<void>
): Promise<void> {
  const seen = { body: "", contentType: undefined as string | undefined };
  const server = http.createServer((req, res) => {
    seen.contentType = req.headers["content-type"];
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      seen.body = data;
      res.writeHead(reply.status, {
        "Content-Type": reply.contentType ?? "application/json",
      });
      res.end(reply.body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/login/oauth/access_token`, seen);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function postFormError(reply: Reply): Promise<Error> {
  let caught: unknown;
  await withServer(reply, async (url) => {
    try {
      await postForm(url, { client_id: "abc" });
    } catch (error) {
      caught = error;
    }
  });
  assert.ok(caught instanceof Error, "expected postForm to throw");
  return caught;
}

test("a successful form post returns the parsed object and sends the form body", async () => {
  await withServer(
    { status: 200, body: JSON.stringify({ device_code: "d", interval: 5 }) },
    async (url, seen) => {
      const result = await postForm(url, { client_id: "abc", scope: "repo" });
      assert.deepEqual(result, { device_code: "d", interval: 5 });
      assert.equal(seen.body, "client_id=abc&scope=repo");
      assert.equal(seen.contentType, "application/x-www-form-urlencoded");
    }
  );
});

test("a 200 carrying an error field is still returned, not thrown", async () => {
  // The device-flow poll loop depends on this: GitHub answers a pending
  // authorization with HTTP 200 and an `error` field.
  await withServer(
    { status: 200, body: JSON.stringify({ error: "authorization_pending" }) },
    async (url) => {
      const result = await postForm(url, { client_id: "abc" });
      assert.equal(result.error, "authorization_pending");
    }
  );
});

test("each status class maps to its own user advice", async () => {
  const cases: Array<[number, AppErrorCode]> = [
    [401, "github-http-auth"],
    [403, "github-http-auth"],
    [429, "github-http-rate-limit"],
    [404, "github-http-client"],
    [500, "github-http-server"],
    [503, "github-http-server"],
    [302, "github-bad-response"],
  ];

  const advice = new Map<string, number>();
  for (const [status, code] of cases) {
    const error = await postFormError({ status, body: "nope" });
    assert.ok(
      error.message.includes(appErrorToken(code)),
      `HTTP ${status} should carry ${code}, got: ${error.message}`
    );
    advice.set(toUserErrorMessage(error), status);
  }

  // 401/403 and 500/503 deliberately share advice; the five distinct classes
  // must not collapse any further than that.
  assert.equal(advice.size, 5);
});

test("the thrown error keeps the status and a body excerpt, and the user sees neither", async () => {
  const error = await postFormError({
    status: 500,
    body: "<html><body>Server Error 12345</body></html>",
    contentType: "text/html",
  });

  assert.match(error.message, /HTTP 500/);
  assert.match(error.message, /Server Error 12345/);

  const shown = toUserErrorMessage(error);
  assert.doesNotMatch(shown, /500/);
  assert.doesNotMatch(shown, /12345/);
  assert.doesNotMatch(shown, /llmpr:/);
  assert.match(shown, /githubstatus\.com/);
});

test("a 200 that is not JSON is reported as an unreadable response, not as JSON", async () => {
  const error = await postFormError({
    status: 200,
    body: "<html>maintenance</html>",
    contentType: "text/html",
  });

  assert.ok(error.message.includes(appErrorToken("github-bad-response")));
  assert.match(error.message, /not JSON/);
  assert.match(error.message, /maintenance/);
});

test("a 200 whose JSON is not an object is not passed off as one", async () => {
  const error = await postFormError({ status: 200, body: "[1,2,3]" });
  assert.ok(error.message.includes(appErrorToken("github-bad-response")));
  assert.match(error.message, /not an object/);
});

test("an empty failing body says so instead of trailing off", async () => {
  const error = await postFormError({ status: 500, body: "" });
  assert.match(error.message, /\(empty body\)/);
});

test("a token in a failing response body never reaches the error message", async () => {
  const error = await postFormError({
    status: 400,
    body: JSON.stringify({ access_token: "gho_abcdefghijklmnopqrstuvwxyz012345" }),
  });

  assert.doesNotMatch(error.message, /gho_abcdefghijklmnopqrstuvwxyz012345/);
  assert.match(error.message, /redacted/);
});

test("bodyExcerpt collapses whitespace and caps length", () => {
  assert.equal(bodyExcerpt("  a\n\n  b  "), "a b");
  assert.equal(bodyExcerpt("   "), "(empty body)");

  const long = bodyExcerpt("x".repeat(500));
  assert.equal(long.length, 203);
  assert.ok(long.endsWith("..."));
});

test("httpErrorCodeForStatus treats only 2xx as success", () => {
  assert.equal(httpErrorCodeForStatus(200), null);
  assert.equal(httpErrorCodeForStatus(204), null);
  assert.equal(httpErrorCodeForStatus(299), null);
  assert.equal(httpErrorCodeForStatus(100), "github-bad-response");
  assert.equal(httpErrorCodeForStatus(301), "github-bad-response");
  assert.equal(httpErrorCodeForStatus(400), "github-http-client");
  assert.equal(httpErrorCodeForStatus(401), "github-http-auth");
  assert.equal(httpErrorCodeForStatus(429), "github-http-rate-limit");
  assert.equal(httpErrorCodeForStatus(599), "github-http-server");
});

test("toLogDetail keeps the cause and strips credentials", () => {
  assert.equal(toLogDetail("plain failure"), "plain failure");
  assert.equal(
    toLogDetail(new Error("remote: https://x:ghp_abcdefghijklmnopqrstuvwx@github.com/o/r")),
    "remote: https://[redacted]@github.com/o/r"
  );
  assert.match(
    toLogDetail(new Error('{"access_token": "gho_abcdefghijklmnopqrst"}')),
    /"access_token": "\[redacted\]"/
  );
});

test("a connection failure still rejects rather than resolving empty", async () => {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  await assert.rejects(
    () => postForm(`http://127.0.0.1:${port}/gone`, { client_id: "abc" }),
    /ECONNREFUSED/
  );
});

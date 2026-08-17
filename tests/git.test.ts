import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBranchName, isRepoSlug, parseGithubSlug } from "../src/git.ts";

test("buildBranchName produces llm/pr-YYYYMMDD-HHMMSS", () => {
  assert.match(buildBranchName(), /^llm\/pr-\d{8}-\d{6}$/);
});

test("isRepoSlug accepts org/repo and rejects everything else", () => {
  assert.equal(isRepoSlug("octocat/hello-world"), true);
  assert.equal(isRepoSlug("just-a-name"), false);
  assert.equal(isRepoSlug("a/b/c"), false);
  assert.equal(isRepoSlug(""), false);
});

test("parseGithubSlug handles https remotes with and without .git", () => {
  assert.equal(
    parseGithubSlug("https://github.com/octocat/hello-world.git"),
    "octocat/hello-world"
  );
  assert.equal(
    parseGithubSlug("https://github.com/octocat/hello-world"),
    "octocat/hello-world"
  );
});

test("parseGithubSlug handles ssh remotes", () => {
  assert.equal(
    parseGithubSlug("git@github.com:octocat/hello-world.git"),
    "octocat/hello-world"
  );
});

test("parseGithubSlug rejects non-github remotes", () => {
  assert.equal(parseGithubSlug("https://gitlab.com/a/b.git"), null);
  assert.equal(parseGithubSlug("not a url"), null);
});

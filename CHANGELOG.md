# Changelog

## 0.1.0 — 2026-08-19

- Upgrade `@anthropic-ai/sdk` from 0.28 to 0.117 (current).
- Stream Claude's responses instead of waiting silently: progress now appears in
  the chat panel and output channel as it's generated. Response token limits were
  also raised, fixing truncation on larger patches.
- Use structured outputs (JSON schema) for plan generation, removing a class of
  plan-parsing failures.
- Add prompt caching for repeat calls against the same repo, with cache usage
  logged to the output channel.
- Add an `llmPrAssistant.effort` setting (reasoning effort for Claude calls,
  default `high`); model listing now uses the SDK's own `models.list()`; refusals
  from the model now show a friendly error instead of a generic failure.
- Show a diff view with Apply/Cancel before any change is committed or pushed —
  changes are never pushed without an explicit review step.
- Replace the regex-based patch-apply fallback chain with a tool-driven loop: the
  model reads and writes files directly (capped at 5 iterations) instead of
  generating diffs for a chain of apply/repair fallbacks to chew on. This means
  fewer failed generations overall.
- Rank tracked files by relevance to the prompt and include the most relevant
  ones' content as context, instead of relying on file listing + README alone.
  This should improve generations for prompts that name a specific area of code.
- Remove the local Qdrant sidecar indexer. It only ever gated the onboarding
  wizard behind a forced binary download and was never queried for anything —
  removing it means one less required install before first use.
- Move the GitHub token to secure storage automatically on activation if it was
  previously pasted into settings (a warning is now shown in Settings UI
  discouraging that path in favor of "Sign In to GitHub"). The token is no longer
  ever written to a file inside the working repository during a push.
- Remove the `llmPrAssistant.llmProvider` and `llmPrAssistant.gitProvider` settings.
  Neither was ever read by the extension (Claude and GitHub are the only providers
  implemented), so both were no-ops regardless of what was selected.
- Shrink the published extension from 2.0 MB to 0.9 MB (1065 files down to 7). The
  package was shipping a full copy of `node_modules` that the bundled extension
  never loaded at runtime, so installs and updates now download less than half as
  much.
- Stop reporting a repository that could not be read as an empty repository. If
  listing the repo's files fails, the underlying git error is now written to the
  output channel and the model is told the listing is unavailable, instead of
  being handed "(no files)" as though the repo were genuinely empty.
- Say why planning failed. "Could not plan the task" previously covered four
  different causes (malformed response, a response that wasn't a list of steps,
  an empty plan, and a plan whose steps all lacked a title or instruction); each
  now reports its own cause and its own suggested next step.
- Rewrite the README and usage docs to match what the extension actually does.
  The feature list had not kept up with the last several releases, and the
  command list in `docs/usage.md` was missing "Generate PR from Prompt" — the
  extension's main command — along with "Set Anthropic API Key" and the
  `llmPrAssistant.effort` setting.

## 0.0.7

- Fix: the default Claude model (`claude-3-5-sonnet-latest`) was retired upstream,
  so "Generate PR from Prompt" failed with a 404 for anyone who never picked a
  model manually. The default is now `claude-opus-5`.
- Remove the `temperature` parameter from Claude calls; current models reject it.
- Raise response token limits so larger patches are no longer truncated.
- Fix packaging failure caused by a duplicate license file.
- Internal: first unit test suite, F5 debug loop, simplified esbuild-only build.

## 0.0.1

- Initial scaffold with Claude + GitHub PR flow.

## 0.0.3

- Package runtime dependencies so activation succeeds in Cursor/Open VSX.

## 0.0.4

- Chat-based onboarding with step-by-step guidance.
- GitHub device login plus status bar entry point.
- Repo/base branch auto-detection with quick-pick selection.
- Claude model selection from available models.
- Friendlier user-facing error messages and change summaries.
- Ignore `.vscode/` for clean tree checks.

## 0.0.5

- Refined chat onboarding with step-by-step input handling.
- Auto-detect repo/base branch with onboarding actions.
- Model list and selection from Anthropic API.
- Cleaner user-facing error messages.
- Improved patch handling and validation.
- Token-based git push retry for HTTPS GitHub remotes.

## 0.0.6

- Multi-step planning with task sizing.
- Stronger patch application fallbacks and retries.
- Chat toasts for execution progress.
- Local Qdrant sidecar downloader support.


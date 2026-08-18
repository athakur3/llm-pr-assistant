# Changelog

## Unreleased

- Remove the `llmPrAssistant.llmProvider` and `llmPrAssistant.gitProvider` settings.
  Neither was ever read by the extension (Claude and GitHub are the only providers
  implemented), so both were no-ops regardless of what was selected.

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


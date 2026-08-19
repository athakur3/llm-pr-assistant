# Usage

## Quick start

1. Open a git repository in VS Code or Cursor.
2. Click the status bar item **LLM PR Assistant** to open chat.
3. Follow onboarding, then enter a prompt.

Example prompts:

- Write unit tests for the payment service
- Add retry logic to the API client
- Refactor the auth middleware for clarity
- Fix lint errors in the checkout module

## Commands

- `LLM PR Assistant: Generate PR from Prompt` — the main flow: plan, edit, review the diff, then branch/commit/push and open the PR
- `LLM PR Assistant: Open Chat`
- `LLM PR Assistant: Quick Setup`
- `LLM PR Assistant: Set Anthropic API Key`
- `LLM PR Assistant: Sign In to GitHub`
- `LLM PR Assistant: Select Claude Model`

## Settings (advanced)

- `llmPrAssistant.claudeModel`: Claude model name (default `claude-opus-5`)
- `llmPrAssistant.effort`: reasoning effort for Claude calls — `low`, `medium`, `high`, `xhigh`, or `max` (default `high`)
- `llmPrAssistant.githubToken`: deprecated — use `LLM PR Assistant: Sign In to GitHub` instead. A token pasted here is moved into secure storage and cleared from settings on the next activation.
- `llmPrAssistant.repo`: repository slug like `org/repo`
- `llmPrAssistant.baseBranch`: base branch for PRs (default `main`)

## Notes

- The repo must be clean (no uncommitted changes), except `.vscode/`.
- The GitHub login token is used for PR creation and HTTPS pushes.
- Changed files are shown in a diff view for approval before anything is committed or pushed.
- Progress and cache usage are written to the `LLM PR Assistant` output channel.

## Local build

Use `./rebuild.sh` to clean, compile, and package a VSIX.


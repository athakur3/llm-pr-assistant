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

- `LLM PR Assistant: Open Chat`
- `LLM PR Assistant: Quick Setup`
- `LLM PR Assistant: Sign In to GitHub`
- `LLM PR Assistant: Select Claude Model`

## Settings (advanced)

- `llmPrAssistant.claudeModel`: Claude model name
- `llmPrAssistant.githubToken`: GitHub token with repo scope (optional)
- `llmPrAssistant.repo`: repository slug like `org/repo`
- `llmPrAssistant.baseBranch`: base branch for PRs (default `main`)
- `llmPrAssistant.qdrantPath`: local Qdrant binary path (optional)
- `llmPrAssistant.qdrantHost`: Qdrant host (default `127.0.0.1`)
- `llmPrAssistant.qdrantPort`: Qdrant HTTP port (default `6333`)
- `llmPrAssistant.qdrantDataDir`: Qdrant data directory (optional)

## Notes

- The repo must be clean (no uncommitted changes), except `.vscode/`.
- The GitHub login token is used for PR creation and HTTPS pushes.

## Local build

Use `./rebuild.sh` to clean, compile, and package a VSIX.


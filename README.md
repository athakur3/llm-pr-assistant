# LLM PR Assistant

[![CI](https://github.com/athakur3/llm-pr-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/athakur3/llm-pr-assistant/actions/workflows/ci.yml)
![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/AkshanshThakur.llm-pr-assistant?label=VS%20Code%20Marketplace)
[![Open VSX](https://img.shields.io/open-vsx/v/athakur3/llm-pr-assistant?label=Open%20VSX)](https://open-vsx.org/extension/athakur3/llm-pr-assistant)

Describe a change in plain language. The extension makes the edits, shows you a diff, and — once you approve it — commits to a new branch, pushes, and opens a pull request on GitHub.

Marketplace:
- https://marketplace.visualstudio.com/items?itemName=AkshanshThakur.llm-pr-assistant
- https://open-vsx.org/extension/athakur3/llm-pr-assistant

## How it works

One flow, from the chat panel or the `LLM PR Assistant: Generate PR from Prompt` command:

1. **Plan** — larger tasks are broken into a multi-step plan first.
2. **Edit** — Claude edits your files itself through a capped tool-use loop (`read_file`, `write_file`, `list_files`), scoped to the repository root. There are no shell or network tools.
3. **Review** — changed files open in VS Code's diff view. Nothing is committed until you pick **Apply & Create PR**.
4. **Ship** — approved changes go onto a new branch, are committed and pushed, and a PR is opened against your base branch.

## What it is not

This is not a full in-editor coding agent. There is no autocomplete, no always-on assistant editing as you type, no MCP integrations, and no browser control. It does one thing: turn a prompt into a pull request you review on GitHub.

## Requirements

- VS Code or Cursor `^1.85.0`
- An Anthropic API key — kept in VS Code's SecretStorage, not in settings
- A GitHub account — sign in from the extension; the token is kept in SecretStorage too
- A git repository with no uncommitted changes (changes under `.vscode/` are ignored)

## Features

- **Guided onboarding** in the editor for the Anthropic key and GitHub sign-in.
- **Repo and base-branch auto-detection**, overridable in settings.
- **Streaming progress** — long calls report into the chat panel and output channel instead of going quiet for a minute.
- **Structured planning** — the plan call uses a JSON schema, so a bad plan fails as a schema error rather than a parsing guess.
- **Prompt caching** for repeat calls against the same repo; cache reads and writes are logged to the output channel.
- **Relevance-ranked context** — tracked files are scored against your prompt and the top 12 are included (up to 3,000 characters each), on top of the file list, `README.md`, and `package.json`.
- **Diff preview and approval gate** before any commit or push.
- **Model picker** — `LLM PR Assistant: Select Claude Model` lists models from the Anthropic API rather than a hardcoded set.
- **Adjustable reasoning effort** via `llmPrAssistant.effort` (default `high`).
- **Distinct error messages** — a model refusal, a repository that cannot be read, and a repository with no tracked files each say so specifically.

## Docs

- Usage, commands, and settings: `docs/usage.md`
- Changelog: `CHANGELOG.md`
- Contributing and local development: `CONTRIBUTING.md`

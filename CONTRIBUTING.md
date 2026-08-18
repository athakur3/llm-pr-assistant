# Contributing

## Setup

```bash
npm install
```

## Develop

Press `F5` in VS Code ("Run Extension"). This starts the `watch` task and opens an
Extension Development Host with the extension loaded. The dev build is unminified
with sourcemaps, so breakpoints land in the original TypeScript. Edits rebuild on
save — reload the host window (`Cmd+R` / `Ctrl+R`) to pick them up.

To run the watcher on its own:

```bash
npm run dev
```

`esbuild` strips types but does not check them. Run the type checker separately:

```bash
npm run typecheck
```

## Test

```bash
npm test
```

Unit tests live in `tests/` and run on Node's built-in test runner with native
TypeScript type stripping — no test framework dependency. This needs Node 23.6+
(Node 24 recommended). The pure logic under test lives in `src/prompt.ts`,
`src/git.ts`, `src/relevance.ts`, `src/diffPreview.ts`, `src/progress.ts`, and
`src/llm/tools.ts`; keep new pure helpers in modules like these so they stay
testable without a VS Code host.

## Build and package

```bash
npm run build     # production bundle -> dist/extension.js (minified)
npm run package   # produces llm-pr-assistant-<version>.vsix
```

## CI

`.github/workflows/ci.yml` runs the same four checks on every push and pull
request, in the same order:

```bash
npm test
npm run typecheck
npm run build
npx vsce package
```

Keep them green locally before pushing — CI is a backstop, not the first place
a break should show up.

## Publish

Bump `version` in `package.json` and add a `CHANGELOG.md` entry first, then:

```bash
npm run publish:vscode
npm run publish:ovsx
```

`scripts/publish.js` swaps the `publisher` field to match the target registry
(`AkshanshThakur` for the VS Code Marketplace, `athakur3` for Open VSX) and
restores `package.json` afterwards.

## Notes

- `./rebuild.sh` runs a clean type check and packages a VSIX.
- Ensure `OPEN_VSX_TOKEN` and VS Code Marketplace credentials are set before publishing.
- Tag releases to match the published version (`git tag v<version>`).

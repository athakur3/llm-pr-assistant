#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const target = process.argv[2];
if (!target || !["vscode", "ovsx"].includes(target)) {
  console.error("Usage: node scripts/publish.js <vscode|ovsx>");
  process.exit(1);
}

const root = path.resolve(__dirname, "..");
const packagePath = path.join(root, "package.json");
const originalPackageJson = fs.readFileSync(packagePath, "utf8");
const parsed = JSON.parse(originalPackageJson);

const vscodePublisher =
  process.env.VSCODE_PUBLISHER || "AkshanshThakur";
const ovsxPublisher = process.env.OVSX_PUBLISHER || "athakur3";

const targetPublisher = target === "vscode" ? vscodePublisher : ovsxPublisher;

function run(command, extraEnv) {
  // Secrets go through the child's ENVIRONMENT, never through the command string.
  // A token interpolated into `command` lands in argv, where any same-user process can
  // read it out of `ps` for the whole life of the publish — and on this machine four
  // autonomous loops run as the same user.
  execSync(command, {
    stdio: "inherit",
    cwd: root,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
}

function writePackageJson(next) {
  fs.writeFileSync(packagePath, JSON.stringify(next, null, 2) + "\n");
}

try {
  if (parsed.publisher !== targetPublisher) {
    parsed.publisher = targetPublisher;
    writePackageJson(parsed);
  }

  run("npm run package");

  const vsixName = `llm-pr-assistant-${parsed.version}.vsix`;

  if (target === "vscode") {
    // `--no-install` so this can only ever run the vsce THIS repo depends on. Without it,
    // npx silently falls back to fetching a publisher from the network at release time,
    // with VSCE_PAT already in the environment. Today it happens to resolve locally
    // (node_modules/.bin/vsce -> @vscode/vsce); the flag makes a missing dependency fail
    // loudly instead of turning into a download nobody reviewed.
    run("npx --no-install vsce publish");
  } else {
    if (!process.env.OPEN_VSX_TOKEN) {
      throw new Error("Missing OPEN_VSX_TOKEN environment variable.");
    }
    // ovsx reads OVSX_PAT from the environment (ovsx/lib/util.js: `options.pat ??
    // (options.pat = process.env.OVSX_PAT)`), so the token never needs to appear as a
    // `-p` argument. vsce already worked this way via VSCE_PAT; this makes ovsx match.
    // Same reasoning, and here it was not hypothetical: `ovsx` was not a dependency of
    // this project at all. It resolved only out of the npx cache (~/.npm/_npx), so on a
    // cleared cache or another machine this line fetched an unpinned publisher over the
    // network mid-release, holding a live Open VSX token. It is a pinned devDependency
    // now, and `--no-install` keeps it that way.
    run(`npx --no-install ovsx publish ${vsixName}`, { OVSX_PAT: process.env.OPEN_VSX_TOKEN });
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(packagePath, originalPackageJson);
}


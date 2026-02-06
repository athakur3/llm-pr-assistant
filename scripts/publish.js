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

function run(command) {
  execSync(command, { stdio: "inherit", cwd: root });
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
    run("npx vsce publish");
  } else {
    if (!process.env.OPEN_VSX_TOKEN) {
      throw new Error("Missing OPEN_VSX_TOKEN environment variable.");
    }
    run(`npx ovsx publish ${vsixName} -p ${process.env.OPEN_VSX_TOKEN}`);
  }
} catch (error) {
  console.error(error.message || String(error));
  process.exitCode = 1;
} finally {
  fs.writeFileSync(packagePath, originalPackageJson);
}


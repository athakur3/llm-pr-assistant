const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");
const { builtinModules } = require("module");

const dev = process.argv.includes("--dev");
const watch = process.argv.includes("--watch");

const entry = path.join(__dirname, "..", "src", "extension.ts");
const outfile = path.join(__dirname, "..", "dist", "extension.js");

const options = {
  entryPoints: [entry],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  external: ["vscode"],
  minify: !dev,
  sourcemap: dev,
  logLevel: "silent",
};

const watchPlugin = {
  name: "watch-logger",
  setup(build) {
    build.onStart(() => console.log("[watch] build started"));
    build.onEnd((result) => {
      for (const error of result.errors) {
        const at = error.location;
        console.error(
          at
            ? `${at.file}:${at.line}:${at.column}: error: ${error.text}`
            : `error: ${error.text}`
        );
      }
      console.log("[watch] build finished");
    });
  },
};

// The VSIX excludes node_modules (.vscodeignore), so dist/extension.js must be
// self-contained: every module it loads has to be a Node builtin or "vscode",
// which the editor provides. A dependency esbuild could not bundle would resolve
// fine locally and fail on a user's machine, so fail the build here instead.
const allowedBare = new Set(["vscode", ...builtinModules]);

function isAllowed(specifier) {
  const bare = specifier.replace(/^node:/, "");
  return allowedBare.has(bare) || allowedBare.has(specifier);
}

function checkBundleIsSelfContained() {
  const code = fs.readFileSync(outfile, "utf8");
  const problems = [];

  const literal = /(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = literal.exec(code))) {
    const specifier = match[1];
    if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
    if (!isAllowed(specifier)) problems.push(`unbundled dependency: ${specifier}`);
  }

  // A computed specifier cannot be checked statically, and would resolve against
  // the node_modules the VSIX no longer ships.
  const dynamic = /(?:require|import)\s*\(\s*(?!["'])/g;
  const dynamicCount = (code.match(dynamic) || []).length;
  if (dynamicCount > 0) {
    problems.push(
      `${dynamicCount} non-literal require()/import() call(s) — cannot verify these resolve without node_modules`
    );
  }

  return [...new Set(problems)];
}

async function main() {
  if (watch) {
    const context = await esbuild.context({
      ...options,
      plugins: [watchPlugin],
    });
    await context.watch();
    return;
  }

  await esbuild.build(options);

  const problems = checkBundleIsSelfContained();
  if (problems.length > 0) {
    console.error(
      "Bundle is not self-contained, but the VSIX ships without node_modules:"
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "Bundle the dependency (remove it from `external`) or stop excluding node_modules in .vscodeignore."
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

const esbuild = require("esbuild");
const path = require("path");

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
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

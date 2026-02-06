const esbuild = require("esbuild");
const path = require("path");

const entry = path.join(__dirname, "..", "out", "extension.js");
const outfile = path.join(__dirname, "..", "dist", "extension.js");

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile,
    external: ["vscode"],
    minify: true,
    sourcemap: false,
  })
  .catch(() => process.exit(1));


import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("public/assets", { recursive: true });
mkdirSync("dist", { recursive: true });

const isWatch = process.argv.includes("--watch");

const webCtx = await esbuild.context({
  entryPoints: ["src/web/main.tsx"],
  bundle: true,
  outfile: "public/assets/app.js",
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  logLevel: "info",
});

const mcpCtx = await esbuild.context({
  entryPoints: ["src/mcp/avent-mcp-stdio.ts"],
  bundle: true,
  outfile: "dist/avent-mcp.mjs",
  format: "esm",
  platform: "node",
  target: ["node22"],
  banner: {
    js: "import { createRequire as __aventCreateRequire } from 'node:module'; const require = __aventCreateRequire(import.meta.url);",
  },
  logLevel: "info",
});

if (isWatch) {
  await Promise.all([webCtx.watch(), mcpCtx.watch()]);
  console.log("[build] Watching web UI and MCP stdio bundle...");
} else {
  await Promise.all([webCtx.rebuild(), mcpCtx.rebuild()]);
  await Promise.all([webCtx.dispose(), mcpCtx.dispose()]);
}

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { build } from "esbuild";

export const webBundleDirName = ".web-build";

export async function buildWebWorkerBundle(rootDir: string): Promise<string> {
  const outDir = resolve(rootDir, webBundleDirName);
  const outfile = resolve(outDir, "convert-worker.js");

  mkdirSync(outDir, { recursive: true });

  await build({
    entryPoints: [resolve(rootDir, "src", "web", "convert-worker.ts")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: true,
    logLevel: "silent"
  });

  return outfile;
}

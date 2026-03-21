import { cpSync, mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { buildWebWorkerBundle } from "../src/server/build-web-worker.js";

export const rootDir = resolve(process.cwd());
export const outputDir = resolve(rootDir, "dist-static");
const webDir = resolve(rootDir, "src", "web");
const iconsDir = resolve(webDir, "icons");
const fixturesOutDir = resolve(rootDir, "out");
const fixturesWebOutDir = resolve(rootDir, "out-web");
const vendorDir = resolve(outputDir, "vendor");
const fixturesDataDir = resolve(outputDir, "fixtures-data");
const fixturesWebDataDir = resolve(outputDir, "fixtures-web-data");
const lottiePlayerPath = resolve(rootDir, "node_modules", "lottie-web", "build", "player", "lottie.min.js");

await buildStaticSite();

export async function buildStaticSite(): Promise<void> {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(vendorDir, { recursive: true });
  mkdirSync(fixturesDataDir, { recursive: true });
  mkdirSync(fixturesWebDataDir, { recursive: true });

  const workerPath = await buildWebWorkerBundle(rootDir);

  copyWebFile("index.html");
  copyWebFile("app.js");
  copyWebFile("build-info.js");
  copyWebFile("styles.css");
  copyWebFile("fixtures.html");
  copyWebFile("fixtures.js");
  copyWebFile("fixtures-web.html");
  copyWebFile("fixtures-web.js");
  copyWebFile("fixtures.css");

  cpSync(iconsDir, resolve(outputDir, "icons"), { recursive: true });
  cpSync(lottiePlayerPath, resolve(vendorDir, "lottie.min.js"));
  cpSync(workerPath, resolve(outputDir, "convert-worker.js"));
  cpSync(`${workerPath}.map`, resolve(outputDir, "convert-worker.js.map"));

  const manifest = buildFixturesManifest();
  writeFileSync(
    resolve(outputDir, "fixtures-manifest.json"),
    `${JSON.stringify({ fixtures: manifest }, null, 2)}\n`,
    "utf8"
  );

  const webManifest = buildFixturesManifest(fixturesWebOutDir, fixturesWebDataDir, "./fixtures-web-data/");
  writeFileSync(
    resolve(outputDir, "fixtures-web-manifest.json"),
    `${JSON.stringify({ fixtures: webManifest }, null, 2)}\n`,
    "utf8"
  );
}

function copyWebFile(filename: string): void {
  cpSync(resolve(webDir, filename), resolve(outputDir, filename));
}

function buildFixturesManifest(
  sourceDir = fixturesOutDir,
  targetDir = fixturesDataDir,
  hrefBase = "./fixtures-data/"
): Array<{ name: string; size: number; href: string }> {
  const filenames = readdirSync(sourceDir)
    .filter((filename) => filename.endsWith(".json"))
    .filter((filename) => !filename.endsWith(".meta.json"))
    .filter((filename) => !filename.endsWith(".error.json"))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  return filenames.map((filename) => {
    const sourcePath = resolve(sourceDir, filename);
    const targetPath = resolve(targetDir, filename);
    cpSync(sourcePath, targetPath);

    return {
      name: basename(filename, extname(filename)),
      size: statSync(sourcePath).size,
      href: `${hrefBase}${filename}`
    };
  });
}

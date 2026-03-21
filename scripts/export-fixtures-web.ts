import { build } from "esbuild";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { ConversionError } from "../src/core/issues.js";
import { loadSwfFixtures } from "../src/testing/fixtures.js";

const fixturesDir = resolve(process.cwd(), "fixtures");
const outDir = resolve(process.cwd(), "out-web");
const requestedFixture = process.argv[2];
const bitmapAssetMode = process.env.BITMAP_ASSET_MODE === "external" ? "external" : "inline";

if (!requestedFixture) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const convertSwfToLottie = await loadBrowserBundledConverter();
const allFixtures = loadSwfFixtures(fixturesDir);
const resolvedFixtureName = resolveRequestedFixtureName(requestedFixture, allFixtures.map((fixture) => fixture.name));
const fixtures = allFixtures.filter((fixture) =>
  resolvedFixtureName ? fixture.name === resolvedFixtureName : true
);

if (requestedFixture && fixtures.length === 0) {
  process.stderr.write(`Fixture not found: ${requestedFixture}\n`);
  process.exitCode = 1;
  process.exit();
}

for (const fixture of fixtures) {
  const stem = basename(fixture.name, ".swf");
  const jsonPath = resolve(outDir, `${stem}.json`);
  const metaPath = resolve(outDir, `${stem}.meta.json`);
  const errorPath = resolve(outDir, `${stem}.error.json`);

  rmSync(jsonPath, { force: true });
  rmSync(metaPath, { force: true });
  rmSync(errorPath, { force: true });

  try {
    const result = convertSwfToLottie(fixture.buffer, { bitmapAssetMode });
    if (!result.animation) {
      writeFileSync(
        errorPath,
        `${JSON.stringify(
          {
            source: fixture.name,
            message: "Conversion finished without a Lottie animation payload.",
            issues: result.issues
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      process.stdout.write(`error ${fixture.name}\n`);
      continue;
    }

    writeFileSync(jsonPath, `${JSON.stringify(result.animation, null, 2)}\n`, "utf8");
    writeFileSync(
      metaPath,
      `${JSON.stringify(
        {
          source: fixture.name,
          issues: result.issues
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    for (const asset of result.bitmapAssets) {
      if (bitmapAssetMode !== "external") {
        continue;
      }

      writeFileSync(resolve(outDir, asset.filename), Buffer.from(asset.dataBase64, "base64"));
    }

    process.stdout.write(`ok ${fixture.name}\n`);
  } catch (error) {
    if (error instanceof ConversionError) {
      writeFileSync(
        errorPath,
        `${JSON.stringify(
          {
            source: fixture.name,
            message: error.message,
            issues: error.issues
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      process.stdout.write(`error ${fixture.name}\n`);
      continue;
    }

    throw error;
  }
}

async function loadBrowserBundledConverter(): Promise<
  typeof import("../src/core/convert.js").convertSwfToLottie
> {
  const dir = mkdtempSync(join(tmpdir(), "swf2lottie-browser-export-"));
  const entry = join(dir, "entry.ts");
  const outfile = join(dir, "bundle.cjs");

  writeFileSync(
    entry,
    `
      import { convertSwfToLottie } from ${JSON.stringify(resolve("src/core/convert.ts").replace(/\\\\/g, "/"))};
      export { convertSwfToLottie };
    `,
    "utf8"
  );

  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    logLevel: "silent"
  });

  const mod = await import(`file:///${outfile.replace(/\\/g, "/")}`);
  const convert = (mod.default?.convertSwfToLottie ?? mod.convertSwfToLottie) as
    | typeof import("../src/core/convert.js").convertSwfToLottie
    | undefined;

  if (typeof convert !== "function") {
    throw new Error("Failed to load browser-bundled convertSwfToLottie.");
  }

  return convert;
}

function resolveRequestedFixtureName(
  requestedFixture: string | undefined,
  fixtureNames: string[]
): string | undefined {
  if (!requestedFixture) {
    return undefined;
  }

  const exactMatch = fixtureNames.find((fixtureName) => fixtureName === requestedFixture);
  if (exactMatch) {
    return exactMatch;
  }

  if (!/^\d+$/.test(requestedFixture)) {
    return requestedFixture;
  }

  const prefix = `testswf${requestedFixture}`;
  const matches = fixtureNames.filter((fixtureName) => fixtureName.startsWith(prefix));

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    process.stderr.write(`Fixture number ${requestedFixture} is ambiguous: ${matches.join(", ")}\n`);
    process.exitCode = 1;
    process.exit();
  }

  return requestedFixture;
}

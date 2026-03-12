import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import { convertSwfToLottie } from "../src/core/convert.js";
import { ConversionError } from "../src/core/issues.js";
import { loadSwfFixtures } from "../src/testing/fixtures.js";

const fixturesDir = resolve(process.cwd(), "fixtures");
const outDir = resolve(process.cwd(), "out");
const requestedFixture = process.argv[2];

if (!requestedFixture) {
  rmSync(outDir, { recursive: true, force: true });
}
mkdirSync(outDir, { recursive: true });

const fixtures = loadSwfFixtures(fixturesDir).filter((fixture) =>
  requestedFixture ? fixture.name === requestedFixture : true
);

if (requestedFixture && fixtures.length === 0) {
  process.stderr.write(`Fixture not found: ${requestedFixture}\n`);
  process.exitCode = 1;
  process.exit();
}

for (const fixture of fixtures) {
  const stem = basename(fixture.name, ".swf");

  try {
    const result = convertSwfToLottie(fixture.buffer);
    if (!result.animation) {
      writeFileSync(
        resolve(outDir, `${stem}.error.json`),
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

    writeFileSync(
      resolve(outDir, `${stem}.json`),
      `${JSON.stringify(result.animation, null, 2)}\n`,
      "utf8"
    );
    writeFileSync(
      resolve(outDir, `${stem}.meta.json`),
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
    process.stdout.write(`ok ${fixture.name}\n`);
  } catch (error) {
    if (error instanceof ConversionError) {
      writeFileSync(
        resolve(outDir, `${stem}.error.json`),
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

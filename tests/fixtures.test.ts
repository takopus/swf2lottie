import { describe, expect, it } from "vitest";
import { basename, resolve } from "node:path";

import { parseSwfMovieHeader } from "../src/core/swf/parse-movie-header.js";
import { loadSwfFixtures } from "../src/testing/fixtures.js";

const fixturesDir = resolve(process.cwd(), "fixtures");

describe("SWF fixtures", () => {
  const fixtures = loadSwfFixtures(fixturesDir);

  it("contains at least one fixture", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)("parses a valid movie header for $name", ({ buffer, path }) => {
    const header = parseSwfMovieHeader(buffer);

    expect(["FWS", "CWS", "ZWS"]).toContain(header.header.signature);
    expect(header.header.version).toBeGreaterThan(0);
    expect(header.header.fileLength).toBeGreaterThan(0);
    expect(basename(path).toLowerCase().endsWith(".swf")).toBe(true);
  });
});

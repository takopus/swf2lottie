import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { loadSwfFixtures } from "../src/testing/fixtures.js";
import { parseSwfMovieHeader } from "../src/core/swf/parse-movie-header.js";

describe("parseSwfMovieHeader", () => {
  const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));

  it.each(fixtures)("reads movie metadata for $name", ({ buffer }) => {
    const header = parseSwfMovieHeader(buffer);

    expect(["FWS", "CWS"]).toContain(header.header.signature);
    expect(header.header.version).toBeGreaterThanOrEqual(10);
    expect(header.frameRate).toBeGreaterThan(0);
    expect(header.frameCount).toBeGreaterThan(0);
    expect(header.frameSize.xMax).toBeGreaterThan(header.frameSize.xMin);
    expect(header.frameSize.yMax).toBeGreaterThan(header.frameSize.yMin);
    expect(header.bodyOffset).toBeGreaterThan(8);
  });
});

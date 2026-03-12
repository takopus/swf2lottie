import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { parseSwf } from "../src/core/swf/parser.js";
import { loadSwfFixtures } from "../src/testing/fixtures.js";

describe("parseSwf", () => {
  const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));

  it.each(fixtures)("builds a document skeleton for $name", ({ name, buffer }) => {
    const result = parseSwf(buffer);

    expect(result.document).not.toBeNull();
    expect(result.document?.rootTimelineId).toBe("root");
    expect(result.document?.symbols.length).toBeGreaterThan(0);

    const root = result.document?.symbols.find(
      (symbol) => symbol.kind === "movieclip" && symbol.id === "root"
    );

    expect(root?.kind).toBe("movieclip");
    expect(root && root.kind === "movieclip" ? root.timeline.frames.length : 0).toBeGreaterThan(0);

    if (name.includes("nested")) {
      const movieclips = result.document?.symbols.filter((symbol) => symbol.kind === "movieclip") ?? [];
      expect(movieclips.length).toBeGreaterThan(1);
    }
  });
});

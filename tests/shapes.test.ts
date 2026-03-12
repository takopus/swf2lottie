import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { parseSwf } from "../src/core/swf/parser.js";
import { loadSwfFixtures } from "../src/testing/fixtures.js";

function getFixture(name: string) {
  const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
  const fixture = fixtures.find((entry) => entry.name === name);

  if (!fixture) {
    throw new Error(`Fixture not found: ${name}`);
  }

  return fixture;
}

describe("shape parsing", () => {
  it("extracts a solid-filled rectangle path", () => {
    const fixture = getFixture("testswf0-rectangle.swf");
    const result = parseSwf(fixture.buffer);
    const shapes = result.document?.symbols.filter((symbol) => symbol.kind === "shape") ?? [];
    const rectangle = shapes[0];

    expect(rectangle?.kind).toBe("shape");
    expect(rectangle && rectangle.kind === "shape" ? rectangle.paths.length : 0).toBeGreaterThan(0);
    expect(rectangle && rectangle.kind === "shape" ? rectangle.paths[0]?.commands[0] : "").toMatch(/^M /);
    expect(rectangle && rectangle.kind === "shape" ? rectangle.paths[0]?.fill?.kind : "").toBe("solid");
  });

  it("extracts a linear gradient fill", () => {
    const fixture = getFixture("testswf9-linear-gradient.swf");
    const result = parseSwf(fixture.buffer);
    const shapes = result.document?.symbols.filter((symbol) => symbol.kind === "shape") ?? [];
    const gradientShape = shapes.find(
      (symbol) => symbol.kind === "shape" && symbol.paths.some((path) => path.fill?.kind === "linear-gradient")
    );

    expect(gradientShape).toBeDefined();
    expect(
      gradientShape && gradientShape.kind === "shape"
        ? gradientShape.paths.find((path) => path.fill?.kind === "linear-gradient")?.fill?.kind
        : undefined
    ).toBe("linear-gradient");
  });
});

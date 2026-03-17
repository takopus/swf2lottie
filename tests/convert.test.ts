import { describe, expect, it } from "vitest";

import { convertSwfToLottie } from "../src/core/convert.js";
import { ConversionError } from "../src/core/issues.js";
import { loadSwfFixtures } from "../src/testing/fixtures.js";
import { resolve } from "node:path";

describe("convertSwfToLottie", () => {
  it("returns structured errors while exporter is still a stub", () => {
    const bytes = new Uint8Array([
      0x46, 0x57, 0x53,
      0x0a,
      0x2a, 0x00, 0x00, 0x00
    ]);

    expect(() => convertSwfToLottie(bytes.buffer)).toThrowError(ConversionError);
  });

  it("exports the simple rectangle fixture to a non-null animation", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const rectangle = fixtures.find((fixture) => fixture.name === "testswf0-rectangle.swf");

    expect(rectangle).toBeDefined();

    const result = convertSwfToLottie((rectangle as NonNullable<typeof rectangle>).buffer);

    expect(result.animation).not.toBeNull();
  });

  it("still reports unsupported exports for nested motion content", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const nested = fixtures.find((fixture) => fixture.name === "testswf3-nested-rotation.swf");

    expect(nested).toBeDefined();
    const result = convertSwfToLottie((nested as NonNullable<typeof nested>).buffer);

    expect(result.animation).not.toBeNull();
  });

  it("exports the linear gradient fixture to a non-null animation", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const gradient = fixtures.find((fixture) => fixture.name === "testswf9-linear-gradient.swf");

    expect(gradient).toBeDefined();

    const result = convertSwfToLottie((gradient as NonNullable<typeof gradient>).buffer);

    expect(result.animation).not.toBeNull();
  });

  it("exports the radial gradient fixture to a non-null animation", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const gradient = fixtures.find((fixture) => fixture.name === "testswf10-radial-gradient.swf");

    expect(gradient).toBeDefined();

    const result = convertSwfToLottie((gradient as NonNullable<typeof gradient>).buffer);

    expect(result.animation).not.toBeNull();
  });

  it("exports the simple bitmap fixture to a non-null animation", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const bitmap = fixtures.find((fixture) => fixture.name === "testswf25-simple-bitmap.swf");

    expect(bitmap).toBeDefined();

    const result = convertSwfToLottie((bitmap as NonNullable<typeof bitmap>).buffer);

    expect(result.animation).not.toBeNull();
  });

  it("exports the bitmap motion tween fixture to a non-null animation", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const bitmap = fixtures.find((fixture) => fixture.name === "testswf26-bitmap-motion-tween.swf");

    expect(bitmap).toBeDefined();

    const result = convertSwfToLottie((bitmap as NonNullable<typeof bitmap>).buffer);

    expect(result.animation).not.toBeNull();
  });
});

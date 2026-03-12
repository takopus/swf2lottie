import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import { convertSwfToLottie } from "../src/core/convert.js";
import { loadSwfFixtures } from "../src/testing/fixtures.js";

describe("Lottie export", () => {
  it("exports a root-level solid shape as a shape layer", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const rectangle = fixtures.find((fixture) => fixture.name === "testswf0-rectangle.swf");

    if (!rectangle) {
      throw new Error("Rectangle fixture not found.");
    }

    const result = convertSwfToLottie(rectangle.buffer);
    const animation = result.animation as { layers: Array<Record<string, unknown>> } | null;

    expect(animation).not.toBeNull();
    expect(animation?.layers.length).toBeGreaterThan(0);
    expect(animation?.layers[0]?.ty).toBe(4);
  });

  it("exports a linear gradient fill as a Lottie gradient fill", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const gradient = fixtures.find((fixture) => fixture.name === "testswf9-linear-gradient.swf");

    if (!gradient) {
      throw new Error("Gradient fixture not found.");
    }

    const result = convertSwfToLottie(gradient.buffer);
    const animation = result.animation as { layers: Array<{ shapes: Array<Record<string, unknown>> }> } | null;
    const firstGroup = animation?.layers[0]?.shapes[0] as { it?: Array<Record<string, unknown>> } | undefined;
    const gradientFill = firstGroup?.it?.find((item) => item.ty === "gf");

    expect(animation).not.toBeNull();
    expect(gradientFill).toBeDefined();
  });

  it("exports a radial gradient fill as a radial Lottie gradient", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const gradient = fixtures.find((fixture) => fixture.name === "testswf10-radial-gradient.swf");

    if (!gradient) {
      throw new Error("Radial gradient fixture not found.");
    }

    const result = convertSwfToLottie(gradient.buffer);
    const animation = result.animation as { layers: Array<{ shapes: Array<Record<string, unknown>> }> } | null;
    const firstGroup = animation?.layers[0]?.shapes[0] as { it?: Array<Record<string, unknown>> } | undefined;
    const gradientFill = firstGroup?.it?.find((item) => item.ty === "gf");

    expect(animation).not.toBeNull();
    expect(gradientFill).toBeDefined();
    expect(gradientFill?.t).toBe(2);
  });

  it("does not emit unused precomp assets for a static wrapper movieclip", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const rotate = fixtures.find((fixture) => fixture.name === "testswf1-motiontwin-rotate.swf");

    if (!rotate) {
      throw new Error("Rotate fixture not found.");
    }

    const result = convertSwfToLottie(rotate.buffer);
    const animation = result.animation as {
      assets?: Array<Record<string, unknown>>;
      layers?: Array<Record<string, unknown>>;
    } | null;

    expect(animation).not.toBeNull();
    expect(animation?.assets ?? []).toHaveLength(0);
    expect(animation?.layers?.[0]?.ty).toBe(4);
  });

  it("orders higher-depth layers above lower-depth layers", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const alpha = fixtures.find((fixture) => fixture.name === "testswf5-alpha.swf");

    if (!alpha) {
      throw new Error("Alpha fixture not found.");
    }

    const result = convertSwfToLottie(alpha.buffer);
    const animation = result.animation as { layers?: Array<{ nm?: string }> } | null;

    expect(animation).not.toBeNull();
    expect(animation?.layers?.[0]?.nm).toContain("root:instance:2");
  });

  it("animates fill color when tint changes over time", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const tint = fixtures.find((fixture) => fixture.name === "testswf6-tint.swf");

    if (!tint) {
      throw new Error("Tint fixture not found.");
    }

    const result = convertSwfToLottie(tint.buffer);
    const animation = result.animation as Record<string, unknown> | null;
    const animatedFill = findAnimatedFill(animation);

    expect(animation).not.toBeNull();
    expect(animatedFill?.c?.a).toBe(1);
  });

  it("exports nested movieclips by flattening them into shape layers", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const nested = fixtures.find((fixture) => fixture.name === "testswf3-nested-rotation.swf");

    if (!nested) {
      throw new Error("Nested fixture not found.");
    }

    const result = convertSwfToLottie(nested.buffer);
    const animation = result.animation as {
      assets?: Array<Record<string, unknown>>;
      layers?: Array<Record<string, unknown>>;
    } | null;

    expect(animation).not.toBeNull();
    expect(animation?.assets ?? []).toHaveLength(0);
    expect((animation?.layers?.length ?? 0)).toBeGreaterThan(1);
    expect(animation?.layers?.every((layer) => layer.ty === 4)).toBe(true);
  });
});

function findAnimatedFill(node: unknown): { c?: { a?: number } } | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const candidate = node as {
    ty?: unknown;
    c?: { a?: number };
    it?: unknown[];
    shapes?: unknown[];
    layers?: unknown[];
  };

  if (candidate.ty === "fl" && candidate.c?.a === 1) {
    return candidate;
  }

  for (const key of ["it", "shapes", "layers"] as const) {
    const value = candidate[key];
    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      const found = findAnimatedFill(item);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

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
    const animation = result.animation as Record<string, unknown> | null;
    const gradientFill = findByType(animation, "gf");

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
    const animation = result.animation as Record<string, unknown> | null;
    const gradientFill = findByType(animation, "gf");

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

  it("exports motion tween transforms as compact keyframes instead of per-frame samples", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const rotate = fixtures.find((fixture) => fixture.name === "testswf1-motiontwin-rotate.swf");

    if (!rotate) {
      throw new Error("Rotate fixture not found.");
    }

    const result = convertSwfToLottie(rotate.buffer);
    const animation = result.animation as {
      layers?: Array<{
        ks?: {
          p?: { a?: number; k?: unknown[] };
          r?: { a?: number; k?: unknown[] };
          s?: { a?: number; k?: unknown[] };
        };
      }>;
    } | null;
    const layer = animation?.layers?.[0];
    const positionKeyframes = Array.isArray(layer?.ks?.p?.k) ? layer.ks.p.k.length : 1;
    const rotationKeyframes = Array.isArray(layer?.ks?.r?.k) ? layer.ks.r.k.length : 1;
    const scaleKeyframes = Array.isArray(layer?.ks?.s?.k) ? layer.ks.s.k.length : 1;

    expect(animation).not.toBeNull();
    expect(positionKeyframes).toBeLessThan(10);
    expect(rotationKeyframes).toBeLessThan(10);
    expect(scaleKeyframes).toBeLessThan(10);
  });

  it("orders higher-depth layers above lower-depth layers", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const alpha = fixtures.find((fixture) => fixture.name === "testswf5-alpha.swf");

    if (!alpha) {
      throw new Error("Alpha fixture not found.");
    }

    const result = convertSwfToLottie(alpha.buffer);
    const animation = result.animation as { layers?: Array<{ ks?: { o?: { a?: number } } }> } | null;

    expect(animation).not.toBeNull();
    expect(animation?.layers?.[0]?.ks?.o?.a).toBe(1);
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

  it("exports simple vector masks as Lottie masksProperties", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const masked = fixtures.find((fixture) => fixture.name === "testswf12-mask.swf");

    if (!masked) {
      throw new Error("Mask fixture not found.");
    }

    const result = convertSwfToLottie(masked.buffer);
    const animation = result.animation as {
      layers?: Array<{ masksProperties?: Array<Record<string, unknown>> }>;
    } | null;
    const maskedLayer = animation?.layers?.find((layer) => (layer.masksProperties?.length ?? 0) > 0);

    expect(animation).not.toBeNull();
    expect(maskedLayer?.masksProperties?.length).toBeGreaterThan(0);
    expect(maskedLayer?.masksProperties?.[0]?.mode).toBe("a");
  });

  it("exports supported line styles as Lottie strokes", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const lines = fixtures.find((fixture) => fixture.name === "testswf13-line-styles.swf");

    if (!lines) {
      throw new Error("Line styles fixture not found.");
    }

    const result = convertSwfToLottie(lines.buffer);
    const animation = result.animation as Record<string, unknown> | null;
    const stroke = findStroke(animation);

    expect(animation).not.toBeNull();
    expect(stroke?.ty).toBe("st");
    expect(stroke?.w?.k).toBeGreaterThan(0);
  });

  it("preserves autogenerated names when safe optimization is disabled", () => {
    const fixtures = loadSwfFixtures(resolve(process.cwd(), "fixtures"));
    const nested = fixtures.find((fixture) => fixture.name === "testswf3-nested-rotation.swf");

    if (!nested) {
      throw new Error("Nested fixture not found.");
    }

    const result = convertSwfToLottie(nested.buffer);
    const animation = result.animation as {
      assets?: Array<Record<string, unknown>>;
      nm?: string;
      layers?: Array<{ nm?: string }>;
    } | null;

    expect(animation).not.toBeNull();
    expect(animation?.assets).toEqual([]);
    expect(animation?.nm).toBe("swf2lottie");
    expect(animation?.layers?.every((layer) => typeof layer.nm === "string")).toBe(true);
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

function findStroke(node: unknown): { ty?: string; w?: { k?: number } } | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const candidate = node as {
    ty?: unknown;
    w?: { k?: number };
    it?: unknown[];
    shapes?: unknown[];
    layers?: unknown[];
  };

  if (candidate.ty === "st" && typeof candidate.w?.k === "number") {
    return candidate as { ty?: string; w?: { k?: number } };
  }

  for (const key of ["it", "shapes", "layers"] as const) {
    const value = candidate[key];
    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      const found = findStroke(item);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

function findByType(node: unknown, type: string): Record<string, unknown> | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  const candidate = node as {
    ty?: unknown;
    it?: unknown[];
    shapes?: unknown[];
    layers?: unknown[];
  };

  if (candidate.ty === type) {
    return candidate as Record<string, unknown>;
  }

  for (const key of ["it", "shapes", "layers"] as const) {
    const value = candidate[key];
    if (!Array.isArray(value)) {
      continue;
    }

    for (const item of value) {
      const found = findByType(item, type);
      if (found) {
        return found;
      }
    }
  }

  return null;
}

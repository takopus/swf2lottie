const GENERATED_NAME_PATTERNS = [
  /^root:instance:/,
  /^symbol:\d+:instance:/,
  /\/symbol:\d+:instance:/,
  /^asset:symbol:/
];

export function optimizeLottieAnimation(animation: Record<string, unknown>): Record<string, unknown> {
  const optimized = optimizeValue(animation, []);
  if (!optimized || typeof optimized !== "object" || Array.isArray(optimized)) {
    return animation;
  }

  return optimized as Record<string, unknown>;
}

function optimizeValue(value: unknown, path: string[]): unknown {
  if (typeof value === "number") {
    return roundNumber(value);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => optimizeValue(item, [...path, String(index)]));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};

  for (const [key, rawChild] of Object.entries(value)) {
    if (shouldDropProperty(path, key, rawChild)) {
      continue;
    }

    const child = optimizeValue(rawChild, [...path, key]);

    if (child === undefined) {
      continue;
    }

    result[key] = child;
  }

  return result;
}

function shouldDropProperty(path: string[], key: string, value: unknown): boolean {
  if (key === "nm" && typeof value === "string") {
    if (GENERATED_NAME_PATTERNS.some((pattern) => pattern.test(value))) {
      return true;
    }
  }

  return false;
}

function roundNumber(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

import type { FlashColorTransform, FlashDocument, FlashFill } from "../ir/index.js";
import type { ConversionIssue } from "../issues.js";

export function validateDocumentSubset(document: FlashDocument): ConversionIssue[] {
  const issues: ConversionIssue[] = [];

  for (const symbol of document.symbols) {
    if (symbol.kind === "shape") {
      symbol.paths.forEach((path, pathIndex) => {
        if (path.fill) {
          validateFill(path.fill, issues, `${symbol.id}.paths[${pathIndex}].fill`);
        }
      });
      continue;
    }

    if (symbol.kind === "morphshape") {
      symbol.paths.forEach((path, pathIndex) => {
        if (path.start.fill) {
          validateFill(path.start.fill, issues, `${symbol.id}.paths[${pathIndex}].start.fill`);
        }

        if (path.end.fill) {
          validateFill(path.end.fill, issues, `${symbol.id}.paths[${pathIndex}].end.fill`);
        }
      });
      continue;
    }

    symbol.timeline.frames.forEach((frame) => {
      frame.displayList.forEach((instance, displayIndex) => {
        validateColorTransform(
          instance.colorTransform,
          issues,
          `${symbol.id}.frames[${frame.index}].displayList[${displayIndex}].colorTransform`
        );
      });
    });
  }

  return issues;
}

function validateFill(fill: FlashFill, issues: ConversionIssue[], path: string): void {
  if (fill.kind === "solid") {
    return;
  }

  if (fill.stops.length < 2) {
    issues.push({
      code: "unsupported_fill",
      severity: "error",
      message: "Gradient fill must contain at least two stops.",
      path
    });
  }
}

function validateColorTransform(
  transform: FlashColorTransform,
  issues: ConversionIssue[],
  path: string
): void {
  if (transform.alpha < 0 || transform.alpha > 1) {
    issues.push({
      code: "unsupported_color_transform",
      severity: "error",
      message: "Alpha must stay within the normalized range 0..1.",
      path,
      details: { alpha: transform.alpha }
    });
  }

  if (!transform.tint) {
    if (transform.brightness === undefined) {
      return;
    }
  }

  if (transform.brightness !== undefined && (transform.brightness < -1 || transform.brightness > 1)) {
    issues.push({
      code: "unsupported_color_transform",
      severity: "error",
      message: "Brightness must stay within the normalized range -1..1.",
      path,
      details: { brightness: transform.brightness }
    });
  }

  if (transform.tint && (transform.tint.amount < 0 || transform.tint.amount > 1)) {
    issues.push({
      code: "unsupported_color_transform",
      severity: "error",
      message: "Tint amount must stay within the normalized range 0..1.",
      path,
      details: { amount: transform.tint.amount }
    });
  }
}

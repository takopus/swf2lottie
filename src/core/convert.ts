import { ConversionError } from "./issues.js";
import type { ConversionIssue } from "./issues.js";
import { exportToLottie } from "./export-lottie/exporter.js";
import type { BitmapAssetMode, ExportedBitmapAsset } from "./export-lottie/types.js";
import { optimizeLottieAnimation } from "./optimize-lottie.js";
import { parseSwf } from "./swf/parser.js";
import { validateDocumentSubset } from "./validate/subset.js";

const ENABLE_SAFE_LOTTIE_OPTIMIZATION = false;

export interface ConvertSwfOptions {
  failOnWarnings?: boolean;
  bitmapAssetMode?: BitmapAssetMode;
  bitmapAssetBasePath?: string;
}

export interface ConvertSwfResult {
  animation: Record<string, unknown> | null;
  bitmapAssets: ExportedBitmapAsset[];
  issues: ConversionIssue[];
}

export function convertSwfToLottie(
  buffer: ArrayBuffer,
  options: ConvertSwfOptions = {}
): ConvertSwfResult {
  const parsed = parseSwf(buffer);
  const issues: ConversionIssue[] = [...parsed.issues];

  if (!parsed.document) {
    throw new ConversionError("SWF parsing did not produce a document.", issues);
  }

  issues.push(...validateDocumentSubset(parsed.document));

  const exportResult = exportToLottie(parsed.document, {
    ...(options.bitmapAssetMode ? { bitmapAssetMode: options.bitmapAssetMode } : {}),
    ...(options.bitmapAssetBasePath ? { bitmapAssetBasePath: options.bitmapAssetBasePath } : {})
  });
  issues.push(...exportResult.issues);

  const hasErrors = issues.some((issue) => issue.severity === "error");
  const hasWarnings = issues.some((issue) => issue.severity === "warning");

  if (hasErrors || (options.failOnWarnings && hasWarnings)) {
    throw new ConversionError("SWF conversion failed.", issues);
  }

  return {
    animation: exportResult.result.animation
      ? (ENABLE_SAFE_LOTTIE_OPTIMIZATION
          ? optimizeLottieAnimation(exportResult.result.animation)
          : exportResult.result.animation)
      : null,
    bitmapAssets: exportResult.result.bitmapAssets,
    issues
  };
}

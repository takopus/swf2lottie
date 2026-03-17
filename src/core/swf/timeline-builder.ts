import type {
  FlashColorTransform,
  FlashBitmapSymbol,
  FlashDisplayObjectState,
  FlashDocument,
  FlashFrame,
  FlashMatrix,
  FlashMorphShapeSymbol,
  FlashMovieClipSymbol,
  FlashShapeSymbol
} from "../ir/index.js";
import type { ConversionIssue } from "../issues.js";
import { mergeJpegTables } from "./bitmap-decode.js";
import type { ParsedSwfMovieHeader } from "./types.js";
import type {
  SwfControlTag,
  SwfDefineBitmapTag,
  SwfJpegTablesTag,
  SwfDefineShapeTag,
  SwfDefineSpriteTag,
  SwfPlaceObjectTag,
  SwfRemoveObject2Tag,
  SwfTag
} from "./tag-types.js";

interface DisplayListEntry {
  id: string;
  symbolId: string;
  depth: number;
  name?: string;
  clipDepth?: number;
  ratio?: number;
  matrix: FlashMatrix;
  colorTransform: FlashColorTransform;
}

export function buildDocumentFromTags(
  movieHeader: ParsedSwfMovieHeader,
  rootTags: SwfControlTag[]
): {
  document: FlashDocument;
  issues: ConversionIssue[];
} {
  const issues: ConversionIssue[] = [];
  const symbols = new Map<string, FlashShapeSymbol | FlashMorphShapeSymbol | FlashBitmapSymbol | FlashMovieClipSymbol>();

  collectSymbols(rootTags, symbols);

  const rootTimelineId = "root";
  const rootTimeline = buildTimeline(rootTimelineId, movieHeader.frameCount, rootTags, issues);

  for (const tag of rootTags) {
    if (!isDefineSpriteTag(tag)) {
      continue;
    }

    const spriteId = symbolIdFromCharacterId(tag.spriteId);
    symbols.set(spriteId, {
      kind: "movieclip",
      id: spriteId,
      timeline: buildTimeline(spriteId, tag.frameCount, tag.controlTags, issues)
    });
  }

  symbols.set(rootTimelineId, {
    kind: "movieclip",
    id: rootTimelineId,
    timeline: rootTimeline
  });

  return {
    document: {
      version: movieHeader.header.version,
      frameRate: movieHeader.frameRate,
      width: twipsToPixels(movieHeader.frameSize.xMax - movieHeader.frameSize.xMin),
      height: twipsToPixels(movieHeader.frameSize.yMax - movieHeader.frameSize.yMin),
      rootTimelineId,
      symbols: Array.from(symbols.values())
    },
    issues
  };
}

function collectSymbols(
  tags: SwfControlTag[],
  symbols: Map<string, FlashShapeSymbol | FlashMorphShapeSymbol | FlashBitmapSymbol | FlashMovieClipSymbol>
): void {
  let jpegTables: Uint8Array | undefined;

  for (const tag of tags) {
    if (isDefineShapeTag(tag)) {
      const symbolId = symbolIdFromCharacterId(tag.characterId);
      if (!symbols.has(symbolId)) {
        symbols.set(symbolId, {
          kind: "shape",
          id: symbolId,
          paths: tag.paths
        });
      }
      continue;
    }

    if (isDefineMorphShapeTag(tag)) {
      const symbolId = symbolIdFromCharacterId(tag.characterId);
      if (!symbols.has(symbolId)) {
        symbols.set(symbolId, {
          kind: "morphshape",
          id: symbolId,
          paths: tag.paths
        });
      }
      continue;
    }

    if (isDefineBitmapTag(tag)) {
      const symbolId = symbolIdFromCharacterId(tag.characterId);
      if (!symbols.has(symbolId)) {
        const data = tag.code === 6 && jpegTables ? mergeJpegTables(jpegTables, tag.data) : tag.data;
        symbols.set(symbolId, {
          kind: "bitmap",
          id: symbolId,
          mimeType: tag.mimeType,
          data,
          width: tag.width,
          height: tag.height,
          ...(tag.hasSeparateAlpha ? { hasSeparateAlpha: true } : {})
        });
      }
      continue;
    }

    if (isJpegTablesTag(tag)) {
      jpegTables = tag.data;
      continue;
    }

    if (isDefineSpriteTag(tag)) {
      collectSymbols(tag.controlTags, symbols);
    }
  }
}

function buildTimeline(
  timelineId: string,
  declaredFrameCount: number,
  tags: SwfControlTag[],
  issues: ConversionIssue[]
): { id: string; frames: FlashFrame[] } {
  const frames: FlashFrame[] = [];
  const displayList = new Map<number, DisplayListEntry>();
  let frameIndex = 0;
  let autoInstanceCounter = 0;

  for (const tag of tags) {
    if (tag.code === 1) {
      frames.push({
        index: frameIndex,
        duration: 1,
        displayList: snapshotDisplayList(displayList)
      });
      frameIndex += 1;
      continue;
    }

    if (isPlaceObjectTag(tag)) {
      applyPlaceObject(displayList, tag, timelineId, () => {
        autoInstanceCounter += 1;
        return `${timelineId}:instance:${autoInstanceCounter}`;
      }, issues);
      continue;
    }

    if (isRemoveObject2Tag(tag)) {
      displayList.delete(tag.depth);
      continue;
    }
  }

  if (frames.length !== declaredFrameCount) {
    issues.push({
      code: "unsupported_feature",
      severity: "warning",
      message: "Declared frame count does not match the number of ShowFrame tags.",
      path: timelineId,
      details: {
        declaredFrameCount,
        parsedFrameCount: frames.length
      }
    });
  }

  return {
    id: timelineId,
    frames
  };
}

function applyPlaceObject(
  displayList: Map<number, DisplayListEntry>,
  tag: SwfPlaceObjectTag,
  timelineId: string,
  nextInstanceId: () => string,
  issues: ConversionIssue[]
): void {
  const existing = displayList.get(tag.depth);

  if (!existing && tag.hasMove && tag.characterId === undefined) {
    issues.push({
      code: "malformed_swf",
      severity: "warning",
      message: "Move update references an empty depth.",
      path: `${timelineId}.depth:${tag.depth}`
    });
    return;
  }

  if (tag.characterId !== undefined) {
    const symbolId = symbolIdFromCharacterId(tag.characterId);
    const nextEntry: DisplayListEntry = {
      id: existing?.id ?? nextInstanceId(),
      symbolId,
      depth: tag.depth,
      ...(tag.clipDepth !== undefined
        ? { clipDepth: tag.clipDepth }
        : existing?.clipDepth !== undefined
          ? { clipDepth: existing.clipDepth }
          : {}),
      ...(tag.ratio !== undefined
        ? { ratio: tag.ratio / 65535 }
        : existing?.ratio !== undefined
          ? { ratio: existing.ratio }
          : {}),
      matrix: tag.matrix ?? existing?.matrix ?? identityMatrix(),
      colorTransform: tag.colorTransform
        ? swfColorTransformToFlash(tag.colorTransform)
        : (existing?.colorTransform ?? defaultColorTransform())
    };
    const resolvedName = tag.name ?? existing?.name;
    if (resolvedName) {
      nextEntry.name = resolvedName;
    }
    displayList.set(tag.depth, nextEntry);
    return;
  }

  if (!existing) {
    return;
  }

  const updatedEntry: DisplayListEntry = {
    ...existing,
    ...(tag.clipDepth !== undefined ? { clipDepth: tag.clipDepth } : {}),
    ...(tag.ratio !== undefined ? { ratio: tag.ratio / 65535 } : {}),
    matrix: tag.matrix ?? existing.matrix,
    colorTransform: tag.colorTransform
      ? swfColorTransformToFlash(tag.colorTransform)
      : existing.colorTransform
  };
  const updatedName = tag.name ?? existing.name;
  if (updatedName) {
    updatedEntry.name = updatedName;
  }
  displayList.set(tag.depth, updatedEntry);
}

function snapshotDisplayList(displayList: Map<number, DisplayListEntry>): FlashDisplayObjectState[] {
  const sorted = Array.from(displayList.values()).sort((left, right) => left.depth - right.depth);
  const activeMasks: Array<{ id: string; clipDepth: number }> = [];

  return sorted.map((entry) => {
    while (activeMasks.length > 0 && entry.depth > (activeMasks[activeMasks.length - 1]?.clipDepth ?? Number.NEGATIVE_INFINITY)) {
      activeMasks.pop();
    }

    const activeMask = activeMasks[activeMasks.length - 1];
    const state: FlashDisplayObjectState = {
      id: entry.id,
      symbolId: entry.symbolId,
      depth: entry.depth,
      matrix: entry.matrix,
      colorTransform: entry.colorTransform,
      ...(entry.name ? { name: entry.name } : {}),
      ...(entry.ratio !== undefined ? { ratio: entry.ratio } : {}),
      ...(activeMask ? { maskLayerId: activeMask.id } : {})
    };

    if (entry.clipDepth !== undefined && entry.clipDepth > entry.depth) {
      state.isMask = true;
      delete state.maskLayerId;
      activeMasks.push({
        id: entry.id,
        clipDepth: entry.clipDepth
      });
    }

    return state;
  });
}

function swfColorTransformToFlash(transform: NonNullable<SwfPlaceObjectTag["colorTransform"]>): FlashColorTransform {
  const alpha = transform.alphaMultiplier / 256;
  const tint = detectTint(transform);
  const brightness = detectBrightness(transform);

  return {
    alpha,
    ...(brightness !== undefined ? { brightness } : {}),
    ...(tint ? { tint } : {})
  };
}

function detectTint(transform: NonNullable<SwfPlaceObjectTag["colorTransform"]>): FlashColorTransform["tint"] {
  if (detectBrightness(transform) !== undefined) {
    return undefined;
  }

  const multipliersEqual =
    transform.redMultiplier === transform.greenMultiplier &&
    transform.redMultiplier === transform.blueMultiplier;
  const addsWithinRange =
    transform.redAdd >= 0 &&
    transform.redAdd <= 255 &&
    transform.greenAdd >= 0 &&
    transform.greenAdd <= 255 &&
    transform.blueAdd >= 0 &&
    transform.blueAdd <= 255;

  if (!multipliersEqual || !addsWithinRange) {
    return undefined;
  }

  const amount = 1 - transform.redMultiplier / 256;
  if (amount <= 0 || amount > 1) {
    return undefined;
  }

  const expectedRed = Math.round(transform.redAdd / amount);
  const expectedGreen = Math.round(transform.greenAdd / amount);
  const expectedBlue = Math.round(transform.blueAdd / amount);

  if (
    expectedRed < 0 || expectedRed > 255 ||
    expectedGreen < 0 || expectedGreen > 255 ||
    expectedBlue < 0 || expectedBlue > 255
  ) {
    return undefined;
  }

  if (
    Math.abs(expectedRed * amount - transform.redAdd) > 1 ||
    Math.abs(expectedGreen * amount - transform.greenAdd) > 1 ||
    Math.abs(expectedBlue * amount - transform.blueAdd) > 1
  ) {
    return undefined;
  }

  return {
    color: rgbToHex(expectedRed, expectedGreen, expectedBlue),
    amount
  };
}

function detectBrightness(transform: NonNullable<SwfPlaceObjectTag["colorTransform"]>): number | undefined {
  const multipliersEqual =
    transform.redMultiplier === transform.greenMultiplier &&
    transform.redMultiplier === transform.blueMultiplier;
  const addsEqual =
    transform.redAdd === transform.greenAdd &&
    transform.redAdd === transform.blueAdd;

  if (!multipliersEqual || !addsEqual) {
    return undefined;
  }

  const multiplier = transform.redMultiplier / 256;
  const add = transform.redAdd;

  if (add > 0 && Math.abs(multiplier - (1 - add / 255)) < 0.02) {
    return add / 255;
  }

  if (add < 0 && Math.abs(multiplier - (1 + add / 255)) < 0.02) {
    return add / 255;
  }

  return undefined;
}

function defaultColorTransform(): FlashColorTransform {
  return {
    alpha: 1
  };
}

function identityMatrix(): FlashMatrix {
  return {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    tx: 0,
    ty: 0
  };
}

function twipsToPixels(value: number): number {
  return value / 20;
}

function symbolIdFromCharacterId(characterId: number): string {
  return `symbol:${characterId}`;
}

function isDefineShapeTag(tag: SwfControlTag): tag is SwfDefineShapeTag {
  return tag.code === 2 || tag.code === 22 || tag.code === 32 || tag.code === 83;
}

function isDefineMorphShapeTag(tag: SwfControlTag): tag is Extract<SwfControlTag, { code: 46 | 84 }> {
  return tag.code === 46 || tag.code === 84;
}

function isDefineSpriteTag(tag: SwfControlTag): tag is SwfDefineSpriteTag {
  return tag.code === 39;
}

function isDefineBitmapTag(tag: SwfControlTag): tag is SwfDefineBitmapTag {
  return tag.code === 6 || tag.code === 21 || tag.code === 35 || tag.code === 36;
}

function isJpegTablesTag(tag: SwfControlTag): tag is SwfJpegTablesTag {
  return tag.code === 8;
}

function isPlaceObjectTag(tag: SwfControlTag): tag is SwfPlaceObjectTag {
  return tag.code === 26;
}

function isRemoveObject2Tag(tag: SwfControlTag): tag is SwfRemoveObject2Tag {
  return tag.code === 28;
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

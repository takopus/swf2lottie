import { segmentsToGeometry, type ShapeSegment } from "../shape-normalize.js";
import type {
  FlashFill,
  FlashGradientFill,
  FlashGradientStop,
  FlashMorphShapePath,
  FlashShapePath,
  FlashStroke
} from "../ir/index.js";
import { BinaryReader } from "./binary-reader.js";
import { BitReader } from "./bit-reader.js";

interface ShapeTagParseResult {
  characterId: number;
  paths: FlashShapePath[];
}

interface MorphShapeTagParseResult {
  characterId: number;
  paths: FlashMorphShapePath[];
}

interface ParsedShapeRecordSegment {
  styleKind: "fill" | "stroke";
  styleIndex: number;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  controlX?: number;
  controlY?: number;
}

export function parseDefineShapeTag(
  buffer: ArrayBuffer,
  code: 2 | 22 | 32 | 83,
  bodyOffset: number
): ShapeTagParseResult {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  const characterId = reader.readUi16();
  const shapeBounds = readRect(buffer, reader.position);
  reader.skip(shapeBounds.byteLength);

  if (code === 83) {
    const edgeBounds = readRect(buffer, reader.position);
    reader.skip(edgeBounds.byteLength);
    reader.readUi8();
  }

  const shapeWithStyle = readShapeWithStyle(buffer, reader.position, code);

  return {
    characterId,
    paths: shapeWithStyle.paths
  };
}

export function parseDefineMorphShapeTag(
  buffer: ArrayBuffer,
  code: 46 | 84,
  bodyOffset: number
): MorphShapeTagParseResult {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  const characterId = reader.readUi16();
  const startBounds = readRect(buffer, reader.position);
  reader.skip(startBounds.byteLength);
  const endBounds = readRect(buffer, reader.position);
  reader.skip(endBounds.byteLength);

  if (code === 84) {
    const startEdgeBounds = readRect(buffer, reader.position);
    reader.skip(startEdgeBounds.byteLength);
    const endEdgeBounds = readRect(buffer, reader.position);
    reader.skip(endEdgeBounds.byteLength);
    reader.readUi8();
  }

  const endEdgesOffset = reader.readUi32();
  const morphDataOffset = reader.position;
  const fillStyles = readMorphFillStyleArray(buffer, reader.position, code);
  reader.skip(fillStyles.byteLength);
  const lineStyles = readMorphLineStyleArray(buffer, reader.position, code);
  reader.skip(lineStyles.byteLength);

  const startEdges = readShapeRecords(
    buffer,
    reader.position,
    fillStyles.startValues,
    lineStyles.startValues,
    true,
    code,
    "start"
  );
  const endEdges = readShapeRecords(
    buffer,
    morphDataOffset + endEdgesOffset,
    fillStyles.endValues,
    lineStyles.endValues,
    true,
    code,
    "end",
    {
      fillStyle1: fillStyles.endValues.length > 0 ? 1 : 0,
      lineStyle: lineStyles.endValues.some((style) => style) ? 1 : 0
    }
  );

  return {
    characterId,
    paths: pairMorphPaths(startEdges.paths, endEdges.paths)
  };
}

function readShapeWithStyle(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 83
): {
  paths: FlashShapePath[];
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);

  const fillStyles = readFillStyleArray(buffer, reader.position, shapeCode);
  reader.skip(fillStyles.byteLength);

  const lineStyles = readLineStyleArray(buffer, reader.position, shapeCode);
  reader.skip(lineStyles.byteLength);
  const shape = readShapeRecords(buffer, reader.position, fillStyles.values, lineStyles.values, true, shapeCode);

  return {
    paths: shape.paths,
    byteLength: reader.position + shape.byteLength - startOffset
  };
}

function readShapeRecords(
  buffer: ArrayBuffer,
  startOffset: number,
  initialFillStyles: FlashFill[],
  initialLineStyles: Array<FlashStroke | null>,
  allowNewStyles: boolean,
  shapeCode: 2 | 22 | 32 | 46 | 83 | 84,
  morphSide?: "start" | "end",
  initialStyleSelection?: {
    fillStyle0?: number;
    fillStyle1?: number;
    lineStyle?: number;
  }
): {
  paths: FlashShapePath[];
  byteLength: number;
} {
  const bits = new BitReader(new Uint8Array(buffer), startOffset);
  let numFillBits = bits.readUnsigned(4);
  let numLineBits = bits.readUnsigned(4);
  let currentX = 0;
  let currentY = 0;
  let fillStyle0 = initialStyleSelection?.fillStyle0 ?? 0;
  let fillStyle1 = initialStyleSelection?.fillStyle1 ?? 0;
  let lineStyle = initialStyleSelection?.lineStyle ?? 0;
  const fillStyleState = [...initialFillStyles];
  const lineStyleState = [...initialLineStyles];
  const segments: ParsedShapeRecordSegment[] = [];

  while (true) {
    const typeFlag = bits.readUnsigned(1);

    if (typeFlag === 0) {
      const stateNewStyles = bits.readUnsigned(1) !== 0;
      const stateLineStyle = bits.readUnsigned(1) !== 0;
      const stateFillStyle1 = bits.readUnsigned(1) !== 0;
      const stateFillStyle0 = bits.readUnsigned(1) !== 0;
      const stateMoveTo = bits.readUnsigned(1) !== 0;

      if (
        !stateNewStyles &&
        !stateLineStyle &&
        !stateFillStyle1 &&
        !stateFillStyle0 &&
        !stateMoveTo
      ) {
        break;
      }

      if (stateMoveTo) {
        const moveBits = bits.readUnsigned(5);
        currentX = bits.readSigned(moveBits);
        currentY = bits.readSigned(moveBits);
      }

      if (stateFillStyle0) {
        fillStyle0 = bits.readUnsigned(numFillBits);
      }

      if (stateFillStyle1) {
        fillStyle1 = bits.readUnsigned(numFillBits);
      }

      if (stateLineStyle) {
        lineStyle = bits.readUnsigned(numLineBits);
      }

      if (stateNewStyles) {
        if (!allowNewStyles) {
          throw new Error("Morph shape record unexpectedly declared new styles.");
        }

        bits.align();
        let nextStyleOffset = bits.offset;

        if (shapeCode === 46 || shapeCode === 84) {
          const nestedFillStyles = readMorphFillStyleArray(buffer, bits.offset, shapeCode);
          fillStyleState.push(
            ...(morphSide === "end" ? nestedFillStyles.endValues : nestedFillStyles.startValues)
          );
          const nestedLineStyles = readMorphLineStyleArray(
            buffer,
            bits.offset + nestedFillStyles.byteLength,
            shapeCode
          );
          lineStyleState.push(
            ...(morphSide === "end" ? nestedLineStyles.endValues : nestedLineStyles.startValues)
          );
          nextStyleOffset = bits.offset + nestedFillStyles.byteLength + nestedLineStyles.byteLength;
        } else {
          const nestedFillStyles = readFillStyleArray(buffer, bits.offset, shapeCode);
          fillStyleState.push(...nestedFillStyles.values);
          const nestedLineStyles = readLineStyleArray(
            buffer,
            bits.offset + nestedFillStyles.byteLength,
            shapeCode
          );
          lineStyleState.push(...nestedLineStyles.values);
          nextStyleOffset = bits.offset + nestedFillStyles.byteLength + nestedLineStyles.byteLength;
        }

        bits.setOffset(nextStyleOffset);
        numFillBits = bits.readUnsigned(4);
        numLineBits = bits.readUnsigned(4);
        fillStyle0 = 0;
        fillStyle1 = 0;
        lineStyle = 0;
      }

      continue;
    }

    const straightFlag = bits.readUnsigned(1) !== 0;

    if (straightFlag) {
      const numBits = bits.readUnsigned(4) + 2;
      const generalLineFlag = bits.readUnsigned(1) !== 0;
      let deltaX = 0;
      let deltaY = 0;

      if (generalLineFlag) {
        deltaX = bits.readSigned(numBits);
        deltaY = bits.readSigned(numBits);
      } else {
        const verticalLineFlag = bits.readUnsigned(1) !== 0;
        if (verticalLineFlag) {
          deltaY = bits.readSigned(numBits);
        } else {
          deltaX = bits.readSigned(numBits);
        }
      }

      const nextX = currentX + deltaX;
      const nextY = currentY + deltaY;
      pushSegments(segments, fillStyle0, fillStyle1, lineStyle, currentX, currentY, nextX, nextY);
      currentX = nextX;
      currentY = nextY;
      continue;
    }

    const numBits = bits.readUnsigned(4) + 2;
    const controlDeltaX = bits.readSigned(numBits);
    const controlDeltaY = bits.readSigned(numBits);
    const anchorDeltaX = bits.readSigned(numBits);
    const anchorDeltaY = bits.readSigned(numBits);
    const controlX = currentX + controlDeltaX;
    const controlY = currentY + controlDeltaY;
    const nextX = controlX + anchorDeltaX;
    const nextY = controlY + anchorDeltaY;

    pushSegments(segments, fillStyle0, fillStyle1, lineStyle, currentX, currentY, nextX, nextY, controlX, controlY);
    currentX = nextX;
    currentY = nextY;
  }

  bits.align();

  return {
    paths: buildPathsFromSegments(fillStyleState, lineStyleState, segments),
    byteLength: bits.offset - startOffset
  };
}

function pushSegments(
  target: ParsedShapeRecordSegment[],
  fillStyle0: number,
  fillStyle1: number,
  lineStyle: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  controlX?: number,
  controlY?: number
): void {
  if (fillStyle1 > 0) {
    target.push({
      styleKind: "fill",
      styleIndex: fillStyle1,
      startX,
      startY,
      endX,
      endY,
      ...(controlX !== undefined && controlY !== undefined ? { controlX, controlY } : {})
    });
  }

  if (fillStyle0 > 0) {
    target.push({
      styleKind: "fill",
      styleIndex: fillStyle0,
      startX: endX,
      startY: endY,
      endX: startX,
      endY: startY,
      ...(controlX !== undefined && controlY !== undefined ? { controlX, controlY } : {})
    });
  }

  if (lineStyle > 0) {
    target.push({
      styleKind: "stroke",
      styleIndex: lineStyle,
      startX,
      startY,
      endX,
      endY,
      ...(controlX !== undefined && controlY !== undefined ? { controlX, controlY } : {})
    });
  }
}

function buildPathsFromSegments(
  fillStyles: FlashFill[],
  lineStyles: Array<FlashStroke | null>,
  segments: ParsedShapeRecordSegment[]
): FlashShapePath[] {
  const grouped = new Map<string, ParsedShapeRecordSegment[]>();

  for (const segment of segments) {
    const key = `${segment.styleKind}:${segment.styleIndex}`;
    const list = grouped.get(key) ?? [];
    list.push(segment);
    grouped.set(key, list);
  }

  const paths: FlashShapePath[] = [];

  for (const [key, styleSegments] of grouped) {
    const [styleKind, styleIndexValue] = key.split(":");
    const styleIndex = Number.parseInt(styleIndexValue ?? "0", 10);
    const fill = styleKind === "fill" ? fillStyles[styleIndex - 1] : undefined;
    const stroke = styleKind === "stroke" ? lineStyles[styleIndex - 1] : undefined;

    if (!fill && !stroke) {
      continue;
    }

    const chains = stitchSegments(styleSegments);
    for (const chain of chains) {
      const closed = arePointsEqual(chain[0]?.startX ?? 0, chain[0]?.startY ?? 0, chain.at(-1)?.endX ?? 0, chain.at(-1)?.endY ?? 0);
      paths.push({
        closed,
        commands: segmentsToCommands(chain),
        geometry: segmentsToGeometry(chainToGeometrySegments(chain), closed),
        ...(fill ? { fill } : {}),
        ...(stroke ? { stroke } : {})
      });
    }
  }

  return paths;
}

function chainToGeometrySegments(segments: ParsedShapeRecordSegment[]): ShapeSegment[] {
  return segments.map((segment) => ({
    start: [twipsToPixels(segment.startX), twipsToPixels(segment.startY)],
    end: [twipsToPixels(segment.endX), twipsToPixels(segment.endY)],
    ...(segment.controlX !== undefined && segment.controlY !== undefined
      ? {
          control: [twipsToPixels(segment.controlX), twipsToPixels(segment.controlY)] as [number, number]
        }
      : {})
  }));
}

function stitchSegments(segments: ParsedShapeRecordSegment[]): ParsedShapeRecordSegment[][] {
  const remaining = [...segments];
  const chains: ParsedShapeRecordSegment[][] = [];

  while (remaining.length > 0) {
    const chain: ParsedShapeRecordSegment[] = [remaining.shift() as ParsedShapeRecordSegment];

    while (true) {
      const last = chain.at(-1);
      if (!last) {
        break;
      }

      const nextIndex = remaining.findIndex((candidate) =>
        arePointsEqual(last.endX, last.endY, candidate.startX, candidate.startY)
      );

      if (nextIndex === -1) {
        break;
      }

      chain.push(remaining.splice(nextIndex, 1)[0] as ParsedShapeRecordSegment);
    }

    chains.push(chain);
  }

  return chains;
}

function segmentsToCommands(segments: ParsedShapeRecordSegment[]): string[] {
  if (segments.length === 0) {
    return [];
  }

  const firstSegment = segments[0];
  if (!firstSegment) {
    return [];
  }

  const commands = [`M ${twipsToPixels(firstSegment.startX)} ${twipsToPixels(firstSegment.startY)}`];

  for (const segment of segments) {
    if (segment.controlX !== undefined && segment.controlY !== undefined) {
      commands.push(
        `Q ${twipsToPixels(segment.controlX)} ${twipsToPixels(segment.controlY)} ${twipsToPixels(segment.endX)} ${twipsToPixels(segment.endY)}`
      );
      continue;
    }

    commands.push(`L ${twipsToPixels(segment.endX)} ${twipsToPixels(segment.endY)}`);
  }

  if (
    arePointsEqual(
      firstSegment.startX,
      firstSegment.startY,
      segments.at(-1)?.endX ?? 0,
      segments.at(-1)?.endY ?? 0
    )
  ) {
    commands.push("Z");
  }

  return commands;
}

function readFillStyleArray(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 46 | 83 | 84
): {
  values: FlashFill[];
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);

  let count = reader.readUi8();
  if (shapeCode >= 22 && count === 0xff) {
    count = reader.readUi16();
  }

  const values: FlashFill[] = [];
  const start = reader.position;

  for (let index = 0; index < count; index += 1) {
    const style = readFillStyle(buffer, reader.position, shapeCode);
    values.push(style.value);
    reader.skip(style.byteLength);
  }

  return {
    values,
    byteLength: reader.position - startOffset
  };
}

function readFillStyle(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 46 | 83 | 84
): {
  value: FlashFill;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  const fillStyleType = reader.readUi8();

  if (fillStyleType === 0x00) {
    const color = readColor(buffer, reader.position, shapeCode);
    return {
      value: {
        kind: "solid",
        color: color.hex,
        alpha: color.alpha
      },
      byteLength: 1 + color.byteLength
    };
  }

  if (fillStyleType === 0x10 || fillStyleType === 0x12) {
    const matrix = readMatrix(buffer, reader.position);
    const gradient = readGradient(buffer, reader.position + matrix.byteLength, shapeCode, fillStyleType);

    return {
      value: {
        kind: fillStyleType === 0x10 ? "linear-gradient" : "radial-gradient",
        matrix: matrix.value,
        stops: gradient.stops
      },
      byteLength: 1 + matrix.byteLength + gradient.byteLength
    };
  }

  return {
    value: {
      kind: "solid",
      color: "#000000",
      alpha: 1
    },
    byteLength: 1
  };
}

function readGradient(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 46 | 83 | 84,
  fillStyleType: number
): {
  stops: FlashGradientStop[];
  byteLength: number;
} {
  const bytes = new Uint8Array(buffer);
  const bits = new BitReader(bytes, startOffset);
  bits.readUnsigned(2);
  bits.readUnsigned(2);
  const count = bits.readUnsigned(4);
  bits.align();

  const reader = new BinaryReader(buffer);
  reader.skip(bits.offset);
  const stops: FlashGradientStop[] = [];

  for (let index = 0; index < count; index += 1) {
    const ratio = reader.readUi8();
    const color = readColor(buffer, reader.position, shapeCode);
    reader.skip(color.byteLength);
    stops.push({
      offset: ratio / 255,
      color: color.hex,
      alpha: color.alpha
    });
  }

  if (fillStyleType === 0x13) {
    reader.readUi16();
  }

  return {
    stops,
    byteLength: reader.position - startOffset
  };
}

function readMorphFillStyleArray(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 46 | 84
): {
  startValues: FlashFill[];
  endValues: FlashFill[];
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);

  let count = reader.readUi8();
  if (count === 0xff) {
    count = reader.readUi16();
  }

  const startValues: FlashFill[] = [];
  const endValues: FlashFill[] = [];

  for (let index = 0; index < count; index += 1) {
    const style = readMorphFillStyle(buffer, reader.position, shapeCode);
    startValues.push(style.startValue);
    endValues.push(style.endValue);
    reader.skip(style.byteLength);
  }

  return {
    startValues,
    endValues,
    byteLength: reader.position - startOffset
  };
}

function readMorphFillStyle(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 46 | 84
): {
  startValue: FlashFill;
  endValue: FlashFill;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  const fillStyleType = reader.readUi8();

  if (fillStyleType === 0x00) {
    const startColor = readColor(buffer, reader.position, 84);
    reader.skip(startColor.byteLength);
    const endColor = readColor(buffer, reader.position, 84);

    return {
      startValue: {
        kind: "solid",
        color: startColor.hex,
        alpha: startColor.alpha
      },
      endValue: {
        kind: "solid",
        color: endColor.hex,
        alpha: endColor.alpha
      },
      byteLength: 1 + startColor.byteLength + endColor.byteLength
    };
  }

  if (fillStyleType === 0x10 || fillStyleType === 0x12) {
    const startMatrix = readMatrix(buffer, reader.position);
    const endMatrix = readMatrix(buffer, reader.position + startMatrix.byteLength);
    const gradient = readMorphGradient(
      buffer,
      reader.position + startMatrix.byteLength + endMatrix.byteLength,
      fillStyleType
    );

    return {
      startValue: {
        kind: fillStyleType === 0x10 ? "linear-gradient" : "radial-gradient",
        matrix: startMatrix.value,
        stops: gradient.startStops
      },
      endValue: {
        kind: fillStyleType === 0x10 ? "linear-gradient" : "radial-gradient",
        matrix: endMatrix.value,
        stops: gradient.endStops
      },
      byteLength: 1 + startMatrix.byteLength + endMatrix.byteLength + gradient.byteLength
    };
  }

  return {
    startValue: { kind: "solid", color: "#000000", alpha: 1 },
    endValue: { kind: "solid", color: "#000000", alpha: 1 },
    byteLength: 1
  };
}

function readMorphGradient(
  buffer: ArrayBuffer,
  startOffset: number,
  fillStyleType: number
): {
  startStops: FlashGradientStop[];
  endStops: FlashGradientStop[];
  byteLength: number;
} {
  const bytes = new Uint8Array(buffer);
  const bits = new BitReader(bytes, startOffset);
  bits.readUnsigned(2);
  bits.readUnsigned(2);
  const count = bits.readUnsigned(4);
  bits.align();

  const reader = new BinaryReader(buffer);
  reader.skip(bits.offset);
  const startStops: FlashGradientStop[] = [];
  const endStops: FlashGradientStop[] = [];

  for (let index = 0; index < count; index += 1) {
    const startRatio = reader.readUi8();
    const startColor = readColor(buffer, reader.position, 84);
    reader.skip(startColor.byteLength);
    const endRatio = reader.readUi8();
    const endColor = readColor(buffer, reader.position, 84);
    reader.skip(endColor.byteLength);
    startStops.push({
      offset: startRatio / 255,
      color: startColor.hex,
      alpha: startColor.alpha
    });
    endStops.push({
      offset: endRatio / 255,
      color: endColor.hex,
      alpha: endColor.alpha
    });
  }

  if (fillStyleType === 0x13) {
    reader.readUi16();
    reader.readUi16();
  }

  return {
    startStops,
    endStops,
    byteLength: reader.position - startOffset
  };
}

function readLineStyleArray(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 46 | 83 | 84
): {
  values: Array<FlashStroke | null>;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);

  let count = reader.readUi8();
  if (shapeCode >= 22 && count === 0xff) {
    count = reader.readUi16();
  }

  const values: Array<FlashStroke | null> = [];
  for (let index = 0; index < count; index += 1) {
    const lineStyle = shapeCode === 83
      ? readLineStyle2(buffer, reader.position)
      : readLineStyle(buffer, reader.position, shapeCode);
    values.push(lineStyle.value);
    reader.skip(lineStyle.byteLength);
  }

  return {
    values,
    byteLength: reader.position - startOffset
  };
}

function readMorphLineStyleArray(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 46 | 84
): {
  startValues: Array<FlashStroke | null>;
  endValues: Array<FlashStroke | null>;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);

  let count = reader.readUi8();
  if (count === 0xff) {
    count = reader.readUi16();
  }

  const startValues: Array<FlashStroke | null> = [];
  const endValues: Array<FlashStroke | null> = [];

  for (let index = 0; index < count; index += 1) {
    const style = shapeCode === 84
      ? readMorphLineStyle2(buffer, reader.position)
      : readMorphLineStyle(buffer, reader.position);
    startValues.push(style.startValue);
    endValues.push(style.endValue);
    reader.skip(style.byteLength);
  }

  return {
    startValues,
    endValues,
    byteLength: reader.position - startOffset
  };
}

function readMorphLineStyle(buffer: ArrayBuffer, startOffset: number): {
  startValue: FlashStroke | null;
  endValue: FlashStroke | null;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  const startWidth = reader.readUi16();
  const endWidth = reader.readUi16();
  const startColor = readColor(buffer, reader.position, 84);
  reader.skip(startColor.byteLength);
  const endColor = readColor(buffer, reader.position, 84);

  return {
    startValue: {
      kind: "solid",
      width: twipsToPixels(startWidth),
      color: startColor.hex,
      alpha: startColor.alpha,
      lineCap: "round",
      lineJoin: "round"
    },
    endValue: {
      kind: "solid",
      width: twipsToPixels(endWidth),
      color: endColor.hex,
      alpha: endColor.alpha,
      lineCap: "round",
      lineJoin: "round"
    },
    byteLength: 4 + startColor.byteLength + endColor.byteLength
  };
}

function readMorphLineStyle2(buffer: ArrayBuffer, startOffset: number): {
  startValue: FlashStroke | null;
  endValue: FlashStroke | null;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  const startWidth = reader.readUi16();
  const endWidth = reader.readUi16();
  const flags = reader.readUi16();
  const startCapStyle = (flags >> 14) & 0b11;
  const joinStyle = (flags >> 12) & 0b11;
  const hasFillFlag = (flags & 0b0000_1000) !== 0;
  const noClose = (flags & 0b0000_0100) !== 0;
  const endCapStyle = flags & 0b11;
  const miterLimit = joinStyle === 2 ? reader.readUi16() / 256 : undefined;

  if (hasFillFlag) {
    const startFill = readMorphFillStyle(buffer, reader.position, 84);
    return {
      startValue: startFill.startValue.kind === "solid"
        ? {
            kind: "solid",
            width: twipsToPixels(startWidth),
            color: startFill.startValue.color,
            alpha: startFill.startValue.alpha,
            lineCap: mapLineCap(startCapStyle, noClose ? endCapStyle : startCapStyle),
            lineJoin: mapLineJoin(joinStyle),
            ...(miterLimit !== undefined ? { miterLimit } : {})
          }
        : null,
      endValue: startFill.endValue.kind === "solid"
        ? {
            kind: "solid",
            width: twipsToPixels(endWidth),
            color: startFill.endValue.color,
            alpha: startFill.endValue.alpha,
            lineCap: mapLineCap(startCapStyle, noClose ? endCapStyle : startCapStyle),
            lineJoin: mapLineJoin(joinStyle),
            ...(miterLimit !== undefined ? { miterLimit } : {})
          }
        : null,
      byteLength: 6 + startFill.byteLength + (miterLimit !== undefined ? 2 : 0)
    };
  }

  const startColor = readColor(buffer, reader.position, 84);
  reader.skip(startColor.byteLength);
  const endColor = readColor(buffer, reader.position, 84);
  return {
    startValue: {
      kind: "solid",
      width: twipsToPixels(startWidth),
      color: startColor.hex,
      alpha: startColor.alpha,
      lineCap: mapLineCap(startCapStyle, noClose ? endCapStyle : startCapStyle),
      lineJoin: mapLineJoin(joinStyle),
      ...(miterLimit !== undefined ? { miterLimit } : {})
    },
    endValue: {
      kind: "solid",
      width: twipsToPixels(endWidth),
      color: endColor.hex,
      alpha: endColor.alpha,
      lineCap: mapLineCap(startCapStyle, noClose ? endCapStyle : startCapStyle),
      lineJoin: mapLineJoin(joinStyle),
      ...(miterLimit !== undefined ? { miterLimit } : {})
    },
    byteLength: 6 + startColor.byteLength + endColor.byteLength + (miterLimit !== undefined ? 2 : 0)
  };
}

function readLineStyle(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 46 | 83 | 84
): {
  value: FlashStroke | null;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  const width = reader.readUi16();
  const color = readColor(buffer, reader.position, shapeCode);
  return {
    value: {
      kind: "solid",
      width: twipsToPixels(width),
      color: color.hex,
      alpha: color.alpha,
      lineCap: "round",
      lineJoin: "round"
    },
    byteLength: 2 + color.byteLength
  };
}

function readLineStyle2(buffer: ArrayBuffer, startOffset: number): {
  value: FlashStroke | null;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  const width = reader.readUi16();
  const flags = reader.readUi16();
  const startCapStyle = (flags >> 14) & 0b11;
  const joinStyle = (flags >> 12) & 0b11;
  const hasFillFlag = (flags & 0b0000_1000) !== 0;
  const noClose = (flags & 0b0000_0100) !== 0;
  const endCapStyle = flags & 0b11;
  const miterLimit = joinStyle === 2 ? reader.readUi16() / 256 : undefined;

  if (hasFillFlag) {
    const fillStyle = readFillStyle(buffer, reader.position, 83);
    return {
      value: fillStyle.value.kind === "solid"
        ? {
            kind: "solid",
            width: twipsToPixels(width),
            color: fillStyle.value.color,
            alpha: fillStyle.value.alpha,
            lineCap: mapLineCap(startCapStyle, noClose ? endCapStyle : startCapStyle),
            lineJoin: mapLineJoin(joinStyle),
            ...(miterLimit !== undefined ? { miterLimit } : {})
          }
        : null,
      byteLength: 4 + fillStyle.byteLength + (miterLimit !== undefined ? 2 : 0)
    };
  }

  const color = readColor(buffer, reader.position, 83);
  return {
    value: {
      kind: "solid",
      width: twipsToPixels(width),
      color: color.hex,
      alpha: color.alpha,
      lineCap: mapLineCap(startCapStyle, noClose ? endCapStyle : startCapStyle),
      lineJoin: mapLineJoin(joinStyle),
      ...(miterLimit !== undefined ? { miterLimit } : {})
    },
    byteLength: 4 + color.byteLength + (miterLimit !== undefined ? 2 : 0)
  };
}

function readRect(buffer: ArrayBuffer, startOffset: number): {
  value: { xMin: number; xMax: number; yMin: number; yMax: number };
  byteLength: number;
} {
  const bits = new BitReader(new Uint8Array(buffer), startOffset);
  const nBits = bits.readUnsigned(5);
  const value = {
    xMin: bits.readSigned(nBits),
    xMax: bits.readSigned(nBits),
    yMin: bits.readSigned(nBits),
    yMax: bits.readSigned(nBits)
  };
  bits.align();

  return {
    value,
    byteLength: bits.offset - startOffset
  };
}

function readMatrix(buffer: ArrayBuffer, startOffset: number): {
  value: FlashGradientFill["matrix"];
  byteLength: number;
} {
  const bits = new BitReader(new Uint8Array(buffer), startOffset);
  let a = 1;
  let d = 1;
  let b = 0;
  let c = 0;

  if (bits.readUnsigned(1) !== 0) {
    const nScaleBits = bits.readUnsigned(5);
    a = bits.readSigned(nScaleBits) / 65536;
    d = bits.readSigned(nScaleBits) / 65536;
  }

  if (bits.readUnsigned(1) !== 0) {
    const nRotateBits = bits.readUnsigned(5);
    b = bits.readSigned(nRotateBits) / 65536;
    c = bits.readSigned(nRotateBits) / 65536;
  }

  const nTranslateBits = bits.readUnsigned(5);
  const tx = bits.readSigned(nTranslateBits);
  const ty = bits.readSigned(nTranslateBits);
  bits.align();

  return {
    value: {
      a,
      b,
      c,
      d,
      tx: twipsToPixels(tx),
      ty: twipsToPixels(ty)
    },
    byteLength: bits.offset - startOffset
  };
}

function readColor(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 46 | 83 | 84
): {
  hex: string;
  alpha: number;
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  const red = reader.readUi8();
  const green = reader.readUi8();
  const blue = reader.readUi8();
  const alpha = shapeCode >= 32 ? reader.readUi8() / 255 : 1;

  return {
    hex: rgbToHex(red, green, blue),
    alpha,
    byteLength: shapeCode >= 32 ? 4 : 3
  };
}

function twipsToPixels(value: number): number {
  return value / 20;
}

function arePointsEqual(ax: number, ay: number, bx: number, by: number): boolean {
  return ax === bx && ay === by;
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function mapLineCap(startCapStyle: number, endCapStyle: number): "butt" | "round" | "square" {
  const capStyle = startCapStyle === endCapStyle ? startCapStyle : startCapStyle;
  if (capStyle === 1) {
    return "butt";
  }

  if (capStyle === 2) {
    return "square";
  }

  return "round";
}

function mapLineJoin(joinStyle: number): "miter" | "round" | "bevel" {
  if (joinStyle === 1) {
    return "bevel";
  }

  if (joinStyle === 2) {
    return "miter";
  }

  return "round";
}

function pairMorphPaths(startPaths: FlashShapePath[], endPaths: FlashShapePath[]): FlashMorphShapePath[] {
  const endFillPaths = endPaths.filter((path) => path.fill);
  const endStrokePaths = endPaths.filter((path) => path.stroke && !path.fill);
  const fallbackEndPaths = [...endPaths];
  const pairs: FlashMorphShapePath[] = [];

  for (const startPath of startPaths) {
    let endPath: FlashShapePath | undefined;

    if (startPath.fill) {
      endPath = endFillPaths.shift();
    } else if (startPath.stroke) {
      endPath = endStrokePaths.shift();
    }

    if (!endPath) {
      endPath = fallbackEndPaths.shift();
    }

    if (!endPath) {
      continue;
    }

    pairs.push({
      start: startPath,
      end: endPath
    });
  }

  return pairs;
}

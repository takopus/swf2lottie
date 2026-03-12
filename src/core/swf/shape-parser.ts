import { segmentsToGeometry, type ShapeSegment } from "../shape-normalize.js";
import type { FlashFill, FlashGradientFill, FlashGradientStop, FlashShapePath } from "../ir/index.js";
import { BinaryReader } from "./binary-reader.js";
import { BitReader } from "./bit-reader.js";

interface ShapeTagParseResult {
  characterId: number;
  paths: FlashShapePath[];
}

interface ParsedShapeRecordSegment {
  fillStyleIndex: number;
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

  const bits = new BitReader(new Uint8Array(buffer), reader.position);
  let numFillBits = bits.readUnsigned(4);
  let numLineBits = bits.readUnsigned(4);
  let currentX = 0;
  let currentY = 0;
  let fillStyle0 = 0;
  let fillStyle1 = 0;
  const fillStyleState = [...fillStyles.values];
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
        bits.readUnsigned(numLineBits);
      }

      if (stateNewStyles) {
        bits.align();
        const nestedFillStyles = readFillStyleArray(buffer, bits.offset, shapeCode);
        fillStyleState.push(...nestedFillStyles.values);
        const nestedLineStyles = readLineStyleArray(
          buffer,
          bits.offset + nestedFillStyles.byteLength,
          shapeCode
        );
        const nextStyleOffset = bits.offset + nestedFillStyles.byteLength + nestedLineStyles.byteLength;
        bits.setOffset(nextStyleOffset);
        numFillBits = bits.readUnsigned(4);
        numLineBits = bits.readUnsigned(4);
        fillStyle0 = 0;
        fillStyle1 = 0;
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
      pushSegments(segments, fillStyle0, fillStyle1, currentX, currentY, nextX, nextY);
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

    pushSegments(segments, fillStyle0, fillStyle1, currentX, currentY, nextX, nextY, controlX, controlY);
    currentX = nextX;
    currentY = nextY;
  }

  bits.align();

  return {
    paths: buildPathsFromSegments(fillStyleState, segments),
    byteLength: bits.offset - startOffset
  };
}

function pushSegments(
  target: ParsedShapeRecordSegment[],
  fillStyle0: number,
  fillStyle1: number,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  controlX?: number,
  controlY?: number
): void {
  if (fillStyle1 > 0) {
    target.push({
      fillStyleIndex: fillStyle1,
      startX,
      startY,
      endX,
      endY,
      ...(controlX !== undefined && controlY !== undefined ? { controlX, controlY } : {})
    });
  }

  if (fillStyle0 > 0) {
    target.push({
      fillStyleIndex: fillStyle0,
      startX: endX,
      startY: endY,
      endX: startX,
      endY: startY,
      ...(controlX !== undefined && controlY !== undefined ? { controlX, controlY } : {})
    });
  }
}

function buildPathsFromSegments(fillStyles: FlashFill[], segments: ParsedShapeRecordSegment[]): FlashShapePath[] {
  const grouped = new Map<number, ParsedShapeRecordSegment[]>();

  for (const segment of segments) {
    const list = grouped.get(segment.fillStyleIndex) ?? [];
    list.push(segment);
    grouped.set(segment.fillStyleIndex, list);
  }

  const paths: FlashShapePath[] = [];

  for (const [fillStyleIndex, fillSegments] of grouped) {
    const fill = fillStyles[fillStyleIndex - 1];
    if (!fill) {
      continue;
    }

    const chains = stitchSegments(fillSegments);
    for (const chain of chains) {
      const closed = arePointsEqual(chain[0]?.startX ?? 0, chain[0]?.startY ?? 0, chain.at(-1)?.endX ?? 0, chain.at(-1)?.endY ?? 0);
      paths.push({
        closed,
        commands: segmentsToCommands(chain),
        geometry: segmentsToGeometry(chainToGeometrySegments(chain), closed),
        fill
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
  shapeCode: 2 | 22 | 32 | 83
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
  shapeCode: 2 | 22 | 32 | 83
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
  shapeCode: 2 | 22 | 32 | 83,
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

function readLineStyleArray(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 83
): {
  byteLength: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);

  let count = reader.readUi8();
  if (shapeCode >= 22 && count === 0xff) {
    count = reader.readUi16();
  }

  for (let index = 0; index < count; index += 1) {
    const lineStyleLength = shapeCode === 83 ? readLineStyle2Length(buffer, reader.position) : readLineStyleLength(buffer, reader.position, shapeCode);
    reader.skip(lineStyleLength);
  }

  return {
    byteLength: reader.position - startOffset
  };
}

function readLineStyleLength(
  buffer: ArrayBuffer,
  startOffset: number,
  shapeCode: 2 | 22 | 32 | 83
): number {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  reader.readUi16();
  const color = readColor(buffer, reader.position, shapeCode);
  return 2 + color.byteLength;
}

function readLineStyle2Length(buffer: ArrayBuffer, startOffset: number): number {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);
  reader.readUi16();
  const flags = reader.readUi16();
  const hasFillFlag = (flags & 0b0000_1000) !== 0;

  if (hasFillFlag) {
    const fillStyle = readFillStyle(buffer, reader.position, 83);
    return 4 + fillStyle.byteLength;
  }

  const color = readColor(buffer, reader.position, 83);
  return 4 + color.byteLength;
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
  shapeCode: 2 | 22 | 32 | 83
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

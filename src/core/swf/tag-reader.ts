import { BinaryReader } from "./binary-reader.js";
import { BitReader } from "./bit-reader.js";
import {
  combineJpegWithAlpha,
  decodeLosslessToPng,
  mergeJpegTables,
  normalizeJpegData
} from "./bitmap-decode.js";
import { parseDefineMorphShapeTag, parseDefineShapeTag } from "./shape-parser.js";
import { SWF_TAG_NAMES } from "./tag-names.js";
import type {
  SwfBackgroundColorTag,
  SwfControlTag,
  SwfDefineBitmapTag,
  SwfJpegTablesTag,
  SwfDefineShapeTag,
  SwfDefineMorphShapeTag,
  SwfDefineSpriteTag,
  SwfFileAttributesTag,
  SwfPlaceObjectTag,
  SwfRemoveObject2Tag,
  SwfTag
} from "./tag-types.js";

export function readControlTags(buffer: ArrayBuffer, startOffset: number): {
  tags: SwfControlTag[];
  nextOffset: number;
} {
  const reader = new BinaryReader(buffer);
  reader.skip(startOffset);

  const tags: SwfControlTag[] = [];

  while (reader.position < reader.length) {
    const tagHeaderOffset = reader.position;
    const tagCodeAndLength = reader.readUi16();
    const code = tagCodeAndLength >> 6;
    let length = tagCodeAndLength & 0x3f;

    if (length === 0x3f) {
      length = reader.readUi32();
    }

    const bodyOffset = reader.position;
    const tag = readTag(buffer, code, length, bodyOffset);
    tags.push(tag);
    reader.skip(length);

    if (code === 0) {
      return {
        tags,
        nextOffset: reader.position
      };
    }

    if (reader.position <= tagHeaderOffset) {
      throw new Error("SWF parser did not advance while reading tags.");
    }
  }

  return {
    tags,
    nextOffset: reader.position
  };
}

function readTag(buffer: ArrayBuffer, code: number, length: number, bodyOffset: number): SwfControlTag {
  switch (code) {
    case 6:
      return readDefineBitsTag(buffer, code, length, bodyOffset);
    case 8:
      return readJpegTablesTag(buffer, length, bodyOffset);
    case 21:
    case 35:
    case 36:
      return readDefineBitmapTag(buffer, code, length, bodyOffset);
    case 2:
    case 22:
    case 32:
    case 83:
      return readDefineShapeTag(buffer, code, length, bodyOffset);
    case 46:
    case 84:
      return readDefineMorphShapeTag(buffer, code, bodyOffset);
    case 9:
      return readBackgroundColorTag(buffer, bodyOffset);
    case 26:
      return readPlaceObject2Tag(buffer, bodyOffset);
    case 70:
      return readPlaceObject3Tag(buffer, bodyOffset);
    case 28:
      return readRemoveObject2Tag(buffer, bodyOffset);
    case 39:
      return readDefineSpriteTag(buffer, bodyOffset);
    case 69:
      return readFileAttributesTag(buffer, bodyOffset);
    default:
      return createUnknownTag(code, length, bodyOffset);
  }
}

function readDefineShapeTag(
  buffer: ArrayBuffer,
  code: 2 | 22 | 32 | 83,
  length: number,
  bodyOffset: number
): SwfDefineShapeTag {
  const shape = parseDefineShapeTag(buffer, code, bodyOffset);

  return {
    code,
    characterId: shape.characterId,
    paths: shape.paths
  };
}

function readDefineMorphShapeTag(
  buffer: ArrayBuffer,
  code: 46 | 84,
  bodyOffset: number
): SwfDefineMorphShapeTag {
  const shape = parseDefineMorphShapeTag(buffer, code, bodyOffset);

  return {
    code,
    characterId: shape.characterId,
    paths: shape.paths
  };
}

function readDefineBitmapTag(
  buffer: ArrayBuffer,
  code: 21 | 35 | 36,
  length: number,
  bodyOffset: number
): SwfDefineBitmapTag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  const characterId = reader.readUi16();
  let imageData = new Uint8Array();
  let mimeType: "image/jpeg" | "image/png" | "image/gif" = "image/jpeg";
  let width = 0;
  let height = 0;
  let hasSeparateAlpha = false;
  const bodyEnd = bodyOffset + length;

  if (code === 21) {
    imageData = new Uint8Array(reader.readBytes(bodyEnd - reader.position));
    const bitmapInfo = inspectBitmapData(imageData);
    mimeType = bitmapInfo.mimeType;
    width = bitmapInfo.width;
    height = bitmapInfo.height;
  } else if (code === 35) {
    const alphaDataOffset = reader.readUi32();
    const rawImageData = new Uint8Array(reader.readBytes(alphaDataOffset));
    const alphaData = new Uint8Array(reader.readBytes(bodyEnd - reader.position));
    const bitmapInfo = inspectBitmapData(rawImageData);
    width = bitmapInfo.width;
    height = bitmapInfo.height;
    hasSeparateAlpha = alphaData.length > 0;
    if (bitmapInfo.mimeType === "image/jpeg" && alphaData.length > 0) {
      imageData = new Uint8Array(combineJpegWithAlpha(normalizeJpegData(rawImageData), alphaData));
      mimeType = "image/png";
      hasSeparateAlpha = false;
    } else {
      imageData = rawImageData;
      mimeType = bitmapInfo.mimeType;
    }
  } else {
    const format = reader.readUi8();
    width = reader.readUi16();
    height = reader.readUi16();
    const colorTableSize = format === 3 ? reader.readUi8() : undefined;
    const compressed = new Uint8Array(reader.readBytes(bodyEnd - reader.position));
    imageData = new Uint8Array(decodeLosslessToPng(format, width, height, colorTableSize, compressed));
    mimeType = "image/png";
  }

  return {
    code,
    characterId,
    mimeType,
    data: imageData,
    width,
    height,
    ...(hasSeparateAlpha ? { hasSeparateAlpha: true } : {})
  };
}

function readDefineBitsTag(
  buffer: ArrayBuffer,
  code: 6,
  length: number,
  bodyOffset: number
): SwfDefineBitmapTag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);
  const characterId = reader.readUi16();
  const imageData = normalizeJpegData(new Uint8Array(reader.readBytes(length - 2)));
  const bitmapInfo = inspectBitmapData(imageData);

  return {
    code,
    characterId,
    mimeType: bitmapInfo.mimeType,
    data: imageData,
    width: bitmapInfo.width,
    height: bitmapInfo.height
  };
}

function readJpegTablesTag(buffer: ArrayBuffer, length: number, bodyOffset: number): SwfJpegTablesTag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);
  return {
    code: 8,
    data: new Uint8Array(reader.readBytes(length))
  };
}

function readBackgroundColorTag(buffer: ArrayBuffer, bodyOffset: number): SwfBackgroundColorTag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  return {
    code: 9,
    red: reader.readUi8(),
    green: reader.readUi8(),
    blue: reader.readUi8()
  };
}

function readFileAttributesTag(buffer: ArrayBuffer, bodyOffset: number): SwfFileAttributesTag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  return {
    code: 69,
    flags: reader.readUi32()
  };
}

function readPlaceObject2Tag(buffer: ArrayBuffer, bodyOffset: number): SwfPlaceObjectTag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  const flags = reader.readUi8();
  const hasClipActions = (flags & 0b1000_0000) !== 0;
  const hasClipDepth = (flags & 0b0100_0000) !== 0;
  const hasName = (flags & 0b0010_0000) !== 0;
  const hasRatio = (flags & 0b0001_0000) !== 0;
  const hasColorTransform = (flags & 0b0000_1000) !== 0;
  const hasMatrix = (flags & 0b0000_0100) !== 0;
  const hasCharacter = (flags & 0b0000_0010) !== 0;
  const hasMove = (flags & 0b0000_0001) !== 0;

  const depth = reader.readUi16();
  const characterId = hasCharacter ? reader.readUi16() : undefined;
  let ratio: number | undefined;
  let clipDepth: number | undefined;
  const matrix = hasMatrix ? readMatrix(buffer, reader.position) : undefined;
  if (matrix) {
    reader.skip(matrix.byteLength);
  }

  const colorTransform = hasColorTransform ? readColorTransformWithAlpha(buffer, reader.position) : undefined;
  if (colorTransform) {
    reader.skip(colorTransform.byteLength);
  }

  if (hasRatio) {
    ratio = reader.readUi16();
  }

  const name = hasName ? readSwfString(buffer, reader.position) : undefined;
  if (name) {
    reader.skip(name.byteLength);
  }

  if (hasClipDepth) {
    clipDepth = reader.readUi16();
  }

  if (hasClipActions) {
    throw new Error("PlaceObject2 clip actions are not supported yet.");
  }

  return {
    code: 26,
    depth,
    hasMove,
    ...(characterId !== undefined ? { characterId } : {}),
    ...(ratio !== undefined ? { ratio } : {}),
    ...(clipDepth !== undefined ? { clipDepth } : {}),
    ...(matrix
      ? {
          matrix: {
            a: matrix.a,
            b: matrix.b,
            c: matrix.c,
            d: matrix.d,
            tx: matrix.tx,
            ty: matrix.ty
          }
        }
      : {}),
    ...(colorTransform
      ? {
          colorTransform: {
            redMultiplier: colorTransform.redMultiplier,
            greenMultiplier: colorTransform.greenMultiplier,
            blueMultiplier: colorTransform.blueMultiplier,
            alphaMultiplier: colorTransform.alphaMultiplier,
            redAdd: colorTransform.redAdd,
            greenAdd: colorTransform.greenAdd,
            blueAdd: colorTransform.blueAdd,
            alphaAdd: colorTransform.alphaAdd
          }
        }
      : {}),
    ...(name ? { name: name.value } : {})
  };
}

function readPlaceObject3Tag(buffer: ArrayBuffer, bodyOffset: number): SwfPlaceObjectTag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  const flags = reader.readUi8();
  const flags2 = reader.readUi8();
  const hasClipActions = (flags & 0b1000_0000) !== 0;
  const hasClipDepth = (flags & 0b0100_0000) !== 0;
  const hasName = (flags & 0b0010_0000) !== 0;
  const hasRatio = (flags & 0b0001_0000) !== 0;
  const hasColorTransform = (flags & 0b0000_1000) !== 0;
  const hasMatrix = (flags & 0b0000_0100) !== 0;
  const hasCharacter = (flags & 0b0000_0010) !== 0;
  const hasMove = (flags & 0b0000_0001) !== 0;
  const hasFilterList = (flags2 & 0b0000_0001) !== 0;
  const hasBlendMode = (flags2 & 0b0000_0010) !== 0;
  const hasCacheAsBitmap = (flags2 & 0b0000_0100) !== 0;
  const hasClassName = (flags2 & 0b0000_1000) !== 0;
  const hasImage = (flags2 & 0b0001_0000) !== 0;

  const depth = reader.readUi16();
  const className = hasClassName || (hasImage && hasCharacter) ? readSwfString(buffer, reader.position) : undefined;
  if (className) {
    reader.skip(className.byteLength);
  }

  const characterId = hasCharacter ? reader.readUi16() : undefined;
  const matrix = hasMatrix ? readMatrix(buffer, reader.position) : undefined;
  if (matrix) {
    reader.skip(matrix.byteLength);
  }

  const colorTransform = hasColorTransform ? readColorTransformWithAlpha(buffer, reader.position) : undefined;
  if (colorTransform) {
    reader.skip(colorTransform.byteLength);
  }

  const ratio = hasRatio ? reader.readUi16() : undefined;
  const name = hasName ? readSwfString(buffer, reader.position) : undefined;
  if (name) {
    reader.skip(name.byteLength);
  }

  const clipDepth = hasClipDepth ? reader.readUi16() : undefined;
  let blendMode: number | undefined;

  if (hasFilterList) {
    // Filter list is intentionally not parsed yet. The caller receives a flag and can warn.
  }

  if (hasBlendMode) {
    blendMode = reader.readUi8();
  }

  if (hasCacheAsBitmap) {
    reader.readUi8();
  }

  if (hasClipActions) {
    throw new Error("PlaceObject3 clip actions are not supported yet.");
  }

  return {
    code: 70,
    depth,
    hasMove,
    ...(characterId !== undefined ? { characterId } : {}),
    ...(ratio !== undefined ? { ratio } : {}),
    ...(clipDepth !== undefined ? { clipDepth } : {}),
    ...(hasFilterList ? { hasFilterList: true } : {}),
    ...(blendMode !== undefined ? { blendMode } : {}),
    ...(matrix
      ? {
          matrix: {
            a: matrix.a,
            b: matrix.b,
            c: matrix.c,
            d: matrix.d,
            tx: matrix.tx,
            ty: matrix.ty
          }
        }
      : {}),
    ...(colorTransform
      ? {
          colorTransform: {
            redMultiplier: colorTransform.redMultiplier,
            greenMultiplier: colorTransform.greenMultiplier,
            blueMultiplier: colorTransform.blueMultiplier,
            alphaMultiplier: colorTransform.alphaMultiplier,
            redAdd: colorTransform.redAdd,
            greenAdd: colorTransform.greenAdd,
            blueAdd: colorTransform.blueAdd,
            alphaAdd: colorTransform.alphaAdd
          }
        }
      : {}),
    ...(name ? { name: name.value } : {})
  };
}

function readRemoveObject2Tag(buffer: ArrayBuffer, bodyOffset: number): SwfRemoveObject2Tag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  return {
    code: 28,
    depth: reader.readUi16()
  };
}

function readDefineSpriteTag(buffer: ArrayBuffer, bodyOffset: number): SwfDefineSpriteTag {
  const reader = new BinaryReader(buffer);
  reader.skip(bodyOffset);

  const spriteId = reader.readUi16();
  const frameCount = reader.readUi16();
  const controlTags = readControlTags(buffer, reader.position).tags;

  return {
    code: 39,
    spriteId,
    frameCount,
    controlTags
  };
}

function createUnknownTag(code: number, length: number, bodyOffset: number): SwfTag {
  return {
    code,
    name: SWF_TAG_NAMES.get(code) ?? `Tag${code}`,
    length,
    bodyOffset
  };
}

function inspectBitmapData(bytes: Uint8Array): {
  mimeType: "image/jpeg" | "image/png" | "image/gif";
  width: number;
  height: number;
} {
  if (isPng(bytes)) {
    return {
      mimeType: "image/png",
      width: readPngDimension(bytes, 16),
      height: readPngDimension(bytes, 20)
    };
  }

  if (isGif(bytes)) {
    return {
      mimeType: "image/gif",
      width: readLittleEndian16(bytes, 6),
      height: readLittleEndian16(bytes, 8)
    };
  }

  return {
    mimeType: "image/jpeg",
    ...readJpegDimensions(bytes)
  };
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
}

function isGif(bytes: Uint8Array): boolean {
  return bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46;
}

function readPngDimension(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0);
}

function readLittleEndian16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readJpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2 || marker === 0xc3) {
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0)
      };
    }

    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }

    const segmentLength = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    if (segmentLength < 2) {
      break;
    }
    offset += 2 + segmentLength;
  }

  return { width: 0, height: 0 };
}

function readMatrix(buffer: ArrayBuffer, startOffset: number): {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
  byteLength: number;
} {
  const bits = new BitReader(new Uint8Array(buffer), startOffset);
  let a = 1;
  let d = 1;
  let b = 0;
  let c = 0;

  if (bits.readUnsigned(1) !== 0) {
    const nScaleBits = bits.readUnsigned(5);
    a = readFixed8(bits, nScaleBits);
    d = readFixed8(bits, nScaleBits);
  }

  if (bits.readUnsigned(1) !== 0) {
    const nRotateBits = bits.readUnsigned(5);
    b = readFixed8(bits, nRotateBits);
    c = readFixed8(bits, nRotateBits);
  }

  const nTranslateBits = bits.readUnsigned(5);
  const tx = bits.readSigned(nTranslateBits);
  const ty = bits.readSigned(nTranslateBits);
  bits.align();

  return {
    a,
    b,
    c,
    d,
    tx,
    ty,
    byteLength: bits.offset - startOffset
  };
}

function readColorTransformWithAlpha(buffer: ArrayBuffer, startOffset: number): {
  redMultiplier: number;
  greenMultiplier: number;
  blueMultiplier: number;
  alphaMultiplier: number;
  redAdd: number;
  greenAdd: number;
  blueAdd: number;
  alphaAdd: number;
  byteLength: number;
} {
  const bits = new BitReader(new Uint8Array(buffer), startOffset);
  const hasAddTerms = bits.readUnsigned(1) !== 0;
  const hasMultTerms = bits.readUnsigned(1) !== 0;
  const nBits = bits.readUnsigned(4);

  const redMultiplier = hasMultTerms ? bits.readSigned(nBits) : 256;
  const greenMultiplier = hasMultTerms ? bits.readSigned(nBits) : 256;
  const blueMultiplier = hasMultTerms ? bits.readSigned(nBits) : 256;
  const alphaMultiplier = hasMultTerms ? bits.readSigned(nBits) : 256;

  const redAdd = hasAddTerms ? bits.readSigned(nBits) : 0;
  const greenAdd = hasAddTerms ? bits.readSigned(nBits) : 0;
  const blueAdd = hasAddTerms ? bits.readSigned(nBits) : 0;
  const alphaAdd = hasAddTerms ? bits.readSigned(nBits) : 0;
  bits.align();

  return {
    redMultiplier,
    greenMultiplier,
    blueMultiplier,
    alphaMultiplier,
    redAdd,
    greenAdd,
    blueAdd,
    alphaAdd,
    byteLength: bits.offset - startOffset
  };
}

function readFixed8(bits: BitReader, bitCount: number): number {
  return bits.readSigned(bitCount) / 65536;
}

function readSwfString(buffer: ArrayBuffer, startOffset: number): {
  value: string;
  byteLength: number;
} {
  const bytes = new Uint8Array(buffer);
  let cursor = startOffset;

  while (bytes[cursor] !== 0 && cursor < bytes.length) {
    cursor += 1;
  }

  const value = new TextDecoder("utf-8").decode(bytes.slice(startOffset, cursor));

  return {
    value,
    byteLength: cursor - startOffset + 1
  };
}

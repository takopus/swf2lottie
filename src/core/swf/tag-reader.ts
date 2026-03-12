import { BinaryReader } from "./binary-reader.js";
import { BitReader } from "./bit-reader.js";
import { parseDefineShapeTag } from "./shape-parser.js";
import { SWF_TAG_NAMES } from "./tag-names.js";
import type {
  SwfBackgroundColorTag,
  SwfControlTag,
  SwfDefineShapeTag,
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
    case 2:
    case 22:
    case 32:
    case 83:
      return readDefineShapeTag(buffer, code, length, bodyOffset);
    case 9:
      return readBackgroundColorTag(buffer, bodyOffset);
    case 26:
      return readPlaceObject2Tag(buffer, bodyOffset);
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
  const matrix = hasMatrix ? readMatrix(buffer, reader.position) : undefined;
  if (matrix) {
    reader.skip(matrix.byteLength);
  }

  const colorTransform = hasColorTransform ? readColorTransformWithAlpha(buffer, reader.position) : undefined;
  if (colorTransform) {
    reader.skip(colorTransform.byteLength);
  }

  if (hasRatio) {
    reader.readUi16();
  }

  const name = hasName ? readSwfString(buffer, reader.position) : undefined;
  if (name) {
    reader.skip(name.byteLength);
  }

  if (hasClipDepth) {
    reader.readUi16();
  }

  if (hasClipActions) {
    throw new Error("PlaceObject2 clip actions are not supported yet.");
  }

  return {
    code: 26,
    depth,
    hasMove,
    ...(characterId !== undefined ? { characterId } : {}),
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

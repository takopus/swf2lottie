import { BinaryReader } from "./binary-reader.js";
import { BitReader } from "./bit-reader.js";
import { getUncompressedSwfBuffer } from "./compression.js";
import { parseSwfHeader } from "./parse-header.js";
import type { ParsedSwfMovieHeader } from "./types.js";

export function parseSwfMovieHeader(buffer: ArrayBuffer): ParsedSwfMovieHeader {
  const header = parseSwfHeader(buffer);
  const uncompressedBuffer = getUncompressedSwfBuffer(buffer, header);
  const bytes = new Uint8Array(uncompressedBuffer);
  const bitReader = new BitReader(bytes, 8);
  const nBits = bitReader.readUnsigned(5);

  const frameSize = {
    xMin: bitReader.readSigned(nBits),
    xMax: bitReader.readSigned(nBits),
    yMin: bitReader.readSigned(nBits),
    yMax: bitReader.readSigned(nBits)
  };

  bitReader.align();

  const reader = new BinaryReader(uncompressedBuffer);
  reader.skip(bitReader.offset);

  return {
    header,
    frameSize,
    frameRate: reader.readUi16() / 256,
    frameCount: reader.readUi16(),
    bodyOffset: reader.position,
    uncompressedBuffer
  };
}

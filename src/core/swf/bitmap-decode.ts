import { unzlibSync, zlibSync } from "fflate";
import jpeg from "jpeg-js";

export function normalizeJpegData(data: Uint8Array): Uint8Array {
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd9 && data[2] === 0xff && data[3] === 0xd8) {
    return data.slice(4);
  }

  return data;
}

export function mergeJpegTables(jpegTables: Uint8Array, jpegData: Uint8Array): Uint8Array {
  const normalizedTables = normalizeJpegData(jpegTables);
  const normalizedData = normalizeJpegData(jpegData);

  if (normalizedTables.length < 4) {
    return normalizedData;
  }

  if (normalizedData.length < 2) {
    return normalizedData;
  }

  const merged = new Uint8Array(normalizedData.length + Math.max(0, normalizedTables.length - 4));
  merged.set(normalizedData.slice(0, 2), 0);
  merged.set(normalizedTables.slice(2, -2), 2);
  merged.set(normalizedData.slice(2), 2 + normalizedTables.length - 4);
  return merged;
}

export function combineJpegWithAlpha(jpegData: Uint8Array, alphaData: Uint8Array): Uint8Array {
  const decoded = jpeg.decode(jpegData, { useTArray: true });
  const alpha = unzlibSync(alphaData);
  const rgba = new Uint8Array(decoded.width * decoded.height * 4);

  for (let pixel = 0; pixel < decoded.width * decoded.height; pixel += 1) {
    const offset = pixel * 4;
    rgba[offset] = decoded.data[offset] ?? 0;
    rgba[offset + 1] = decoded.data[offset + 1] ?? 0;
    rgba[offset + 2] = decoded.data[offset + 2] ?? 0;
    rgba[offset + 3] = alpha[pixel] ?? 255;
  }

  return encodePng(decoded.width, decoded.height, rgba);
}

export function decodeLosslessToPng(
  format: number,
  width: number,
  height: number,
  colorTableSize: number | undefined,
  compressed: Uint8Array
): Uint8Array {
  const decoded = unzlibSync(compressed);
  if (format === 5) {
    return encodePng(width, height, decodeArgb32(decoded, width, height));
  }

  if (format === 3) {
    return encodePng(width, height, decodeColorMapped(decoded, width, height, colorTableSize ?? 0));
  }

  throw new Error(`Unsupported lossless bitmap format ${format}.`);
}

function decodeArgb32(decoded: Uint8Array, width: number, height: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * 4;
    const target = pixel * 4;
    rgba[target] = decoded[source + 1] ?? 0;
    rgba[target + 1] = decoded[source + 2] ?? 0;
    rgba[target + 2] = decoded[source + 3] ?? 0;
    rgba[target + 3] = decoded[source] ?? 255;
  }
  return rgba;
}

function decodeColorMapped(
  decoded: Uint8Array,
  width: number,
  height: number,
  colorTableSize: number
): Uint8Array {
  const paletteSize = colorTableSize + 1;
  const paletteBytes = paletteSize * 4;
  const rowStride = (width + 3) & ~3;
  const rgba = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = decoded[paletteBytes + y * rowStride + x] ?? 0;
      const paletteOffset = index * 4;
      const target = (y * width + x) * 4;
      rgba[target] = decoded[paletteOffset] ?? 0;
      rgba[target + 1] = decoded[paletteOffset + 1] ?? 0;
      rgba[target + 2] = decoded[paletteOffset + 2] ?? 0;
      rgba[target + 3] = decoded[paletteOffset + 3] ?? 255;
    }
  }

  return rgba;
}

function encodePng(width: number, height: number, data: Uint8Array): Uint8Array {
  const scanlineLength = width * 4 + 1;
  const raw = new Uint8Array(scanlineLength * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * scanlineLength;
    raw[rowOffset] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), rowOffset + 1);
  }

  const header = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47,
    0x0d, 0x0a, 0x1a, 0x0a
  ]);
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const compressed = zlibSync(raw);
  const ihdrChunk = createPngChunk("IHDR", ihdr);
  const idatChunk = createPngChunk("IDAT", compressed);
  const iendChunk = createPngChunk("IEND", new Uint8Array(0));

  const output = new Uint8Array(header.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  let offset = 0;
  output.set(header, offset);
  offset += header.length;
  output.set(ihdrChunk, offset);
  offset += ihdrChunk.length;
  output.set(idatChunk, offset);
  offset += idatChunk.length;
  output.set(iendChunk, offset);
  return output;
}

function createPngChunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(12 + data.length);
  writeUint32BE(output, 0, data.length);
  output[4] = type.charCodeAt(0);
  output[5] = type.charCodeAt(1);
  output[6] = type.charCodeAt(2);
  output[7] = type.charCodeAt(3);
  output.set(data, 8);
  writeUint32BE(output, 8 + data.length, crc32(output.subarray(4, 8 + data.length)));
  return output;
}

function writeUint32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

const crcTable = createCrc32Table();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index] ?? 0;
    const tableValue = crcTable[(crc ^ byte) & 0xff] ?? 0;
    crc = tableValue ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

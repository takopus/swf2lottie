import { unzlibSync } from "fflate";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

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
  const png = new PNG({ width, height });
  png.data = Buffer.from(data);
  return new Uint8Array(PNG.sync.write(png));
}

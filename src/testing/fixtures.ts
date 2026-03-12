import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface SwfFixture {
  name: string;
  path: string;
  buffer: ArrayBuffer;
}

export function loadSwfFixtures(fixturesDir: string): SwfFixture[] {
  const filenames = readdirSync(fixturesDir)
    .filter((filename) => filename.toLowerCase().endsWith(".swf"))
    .sort((left, right) => left.localeCompare(right));

  return filenames.map((filename) => {
    const path = join(fixturesDir, filename);
    const file = readFileSync(path);

    return {
      name: filename,
      path,
      buffer: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    };
  });
}

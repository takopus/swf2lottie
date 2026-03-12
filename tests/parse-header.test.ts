import { describe, expect, it } from "vitest";

import { parseSwfHeader } from "../src/core/swf/parse-header.js";

describe("parseSwfHeader", () => {
  it("reads the SWF signature, version and file length", () => {
    const bytes = new Uint8Array([
      0x46, 0x57, 0x53,
      0x0a,
      0x2a, 0x00, 0x00, 0x00
    ]);

    const header = parseSwfHeader(bytes.buffer);

    expect(header).toEqual({
      signature: "FWS",
      version: 10,
      fileLength: 42
    });
  });
});

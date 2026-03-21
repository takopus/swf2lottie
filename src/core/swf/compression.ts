import { unzlibSync } from "fflate";

import { ConversionError, type ConversionIssue } from "../issues.js";
import type { ParsedSwfHeader } from "./types.js";

export function getUncompressedSwfBuffer(
  buffer: ArrayBuffer,
  header: ParsedSwfHeader
): ArrayBuffer {
  if (header.signature === "FWS") {
    return buffer.slice(0);
  }

  if (header.signature === "ZWS") {
    const issues: ConversionIssue[] = [
      {
        code: "unsupported_feature",
        severity: "error",
        message: "LZMA-compressed SWF (ZWS) is not supported yet."
      }
    ];
    throw new ConversionError("Unsupported SWF compression.", issues);
  }

  try {
    const compressedBody = new Uint8Array(buffer, 8);
    const inflatedBody = unzlibSync(compressedBody);
    const output = new Uint8Array(header.fileLength);

    output[0] = 0x46;
    output[1] = 0x57;
    output[2] = 0x53;
    output[3] = header.version;
    output[4] = header.fileLength & 0xff;
    output[5] = (header.fileLength >>> 8) & 0xff;
    output[6] = (header.fileLength >>> 16) & 0xff;
    output[7] = (header.fileLength >>> 24) & 0xff;
    output.set(inflatedBody, 8);

    return output.buffer;
  } catch (cause) {
    const issues: ConversionIssue[] = [
      {
        code: "malformed_swf",
        severity: "error",
        message: "Failed to inflate compressed SWF body.",
        details: {
          cause: cause instanceof Error ? cause.message : String(cause)
        }
      }
    ];

    throw new ConversionError("Malformed compressed SWF.", issues);
  }
}

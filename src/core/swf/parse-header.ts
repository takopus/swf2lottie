import { ConversionError, type ConversionIssue } from "../issues.js";
import { BinaryReader } from "./binary-reader.js";
import type { ParsedSwfHeader } from "./types.js";

export function parseSwfHeader(buffer: ArrayBuffer): ParsedSwfHeader {
  const reader = new BinaryReader(buffer);
  const signature = String.fromCharCode(
    reader.readUi8(),
    reader.readUi8(),
    reader.readUi8()
  );

  if (signature !== "FWS" && signature !== "CWS" && signature !== "ZWS") {
    const issues: ConversionIssue[] = [
      {
        code: "malformed_swf",
        severity: "error",
        message: "File does not start with a valid SWF signature.",
        details: { signature }
      }
    ];
    throw new ConversionError("Invalid SWF signature.", issues);
  }

  return {
    signature,
    version: reader.readUi8(),
    fileLength: reader.readUi32()
  };
}

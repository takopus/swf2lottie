import type { FlashDocument } from "../ir/index.js";
import type { ConversionIssue } from "../issues.js";
import { parseSwfMovieHeader } from "./parse-movie-header.js";
import { readControlTags } from "./tag-reader.js";
import { buildDocumentFromTags } from "./timeline-builder.js";

export interface SwfParseResult {
  document: FlashDocument | null;
  issues: ConversionIssue[];
}

export function parseSwf(buffer: ArrayBuffer): SwfParseResult {
  const movieHeader = parseSwfMovieHeader(buffer);
  const rootTags = readControlTags(movieHeader.uncompressedBuffer, movieHeader.bodyOffset).tags;
  const built = buildDocumentFromTags(movieHeader, rootTags);

  return {
    document: built.document,
    issues: built.issues
  };
}

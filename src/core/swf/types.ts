export interface ParsedSwfHeader {
  signature: "FWS" | "CWS" | "ZWS";
  version: number;
  fileLength: number;
}

export interface ParsedSwfMovieHeader {
  header: ParsedSwfHeader;
  frameSize: {
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  };
  frameRate: number;
  frameCount: number;
  bodyOffset: number;
  uncompressedBuffer: ArrayBuffer;
}

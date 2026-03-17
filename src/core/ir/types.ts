export interface FlashMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

export interface FlashTint {
  color: string;
  amount: number;
}

export interface FlashColorTransform {
  alpha: number;
  brightness?: number;
  tint?: FlashTint;
}

export interface FlashSolidFill {
  kind: "solid";
  color: string;
  alpha: number;
}

export interface FlashGradientStop {
  offset: number;
  color: string;
  alpha: number;
}

export interface FlashGradientFill {
  kind: "linear-gradient" | "radial-gradient";
  matrix: FlashMatrix;
  stops: FlashGradientStop[];
  focalPoint?: number;
}

export interface FlashBitmapFill {
  kind: "bitmap";
  bitmapId: string;
  matrix: FlashMatrix;
  repeat: boolean;
  smoothed: boolean;
}

export type FlashFill = FlashSolidFill | FlashGradientFill | FlashBitmapFill;

export interface FlashSolidStroke {
  kind: "solid";
  width: number;
  color: string;
  alpha: number;
  lineCap?: "butt" | "round" | "square";
  lineJoin?: "miter" | "round" | "bevel";
  miterLimit?: number;
}

export type FlashStroke = FlashSolidStroke;

export interface FlashShapeGeometry {
  vertices: [number, number][];
  inTangents: [number, number][];
  outTangents: [number, number][];
  closed: boolean;
}

export interface FlashShapePath {
  closed: boolean;
  commands: string[];
  geometry: FlashShapeGeometry;
  fill?: FlashFill;
  stroke?: FlashStroke;
}

export interface FlashMorphShapePath {
  start: FlashShapePath;
  end: FlashShapePath;
}

export interface FlashShapeSymbol {
  kind: "shape";
  id: string;
  paths: FlashShapePath[];
}

export interface FlashMorphShapeSymbol {
  kind: "morphshape";
  id: string;
  paths: FlashMorphShapePath[];
}

export interface FlashBitmapSymbol {
  kind: "bitmap";
  id: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif";
  data: Uint8Array;
  width: number;
  height: number;
  hasSeparateAlpha?: boolean;
}

export interface FlashDisplayObjectState {
  id: string;
  symbolId: string;
  depth: number;
  name?: string;
  matrix: FlashMatrix;
  colorTransform: FlashColorTransform;
  ratio?: number;
  maskLayerId?: string;
  isMask?: boolean;
}

export interface FlashFrame {
  index: number;
  duration: number;
  displayList: FlashDisplayObjectState[];
}

export interface FlashTimeline {
  id: string;
  frames: FlashFrame[];
}

export interface FlashMovieClipSymbol {
  kind: "movieclip";
  id: string;
  timeline: FlashTimeline;
}

export type FlashSymbol = FlashShapeSymbol | FlashMorphShapeSymbol | FlashBitmapSymbol | FlashMovieClipSymbol;

export interface FlashDocument {
  version: number;
  frameRate: number;
  width: number;
  height: number;
  rootTimelineId: string;
  symbols: FlashSymbol[];
}

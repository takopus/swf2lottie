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
}

export type FlashFill = FlashSolidFill | FlashGradientFill;

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
}

export interface FlashShapeSymbol {
  kind: "shape";
  id: string;
  paths: FlashShapePath[];
}

export interface FlashDisplayObjectState {
  id: string;
  symbolId: string;
  depth: number;
  name?: string;
  matrix: FlashMatrix;
  colorTransform: FlashColorTransform;
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

export type FlashSymbol = FlashShapeSymbol | FlashMovieClipSymbol;

export interface FlashDocument {
  version: number;
  frameRate: number;
  width: number;
  height: number;
  rootTimelineId: string;
  symbols: FlashSymbol[];
}

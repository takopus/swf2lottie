export interface SwfTag {
  code: number;
  name: string;
  length: number;
  bodyOffset: number;
}

export interface SwfPlaceObjectTag {
  code: 26;
  depth: number;
  hasMove: boolean;
  characterId?: number;
  ratio?: number;
  clipDepth?: number;
  matrix?: {
    a: number;
    b: number;
    c: number;
    d: number;
    tx: number;
    ty: number;
  };
  colorTransform?: {
    redMultiplier: number;
    greenMultiplier: number;
    blueMultiplier: number;
    alphaMultiplier: number;
    redAdd: number;
    greenAdd: number;
    blueAdd: number;
    alphaAdd: number;
  };
  name?: string;
}

export interface SwfRemoveObject2Tag {
  code: 28;
  depth: number;
}

export interface SwfDefineShapeTag {
  code: 2 | 22 | 32 | 83;
  characterId: number;
  paths: import("../ir/index.js").FlashShapePath[];
}

export interface SwfDefineMorphShapeTag {
  code: 46 | 84;
  characterId: number;
  paths: import("../ir/index.js").FlashMorphShapePath[];
}

export interface SwfDefineSpriteTag {
  code: 39;
  spriteId: number;
  frameCount: number;
  controlTags: SwfControlTag[];
}

export interface SwfFileAttributesTag {
  code: 69;
  flags: number;
}

export interface SwfBackgroundColorTag {
  code: 9;
  red: number;
  green: number;
  blue: number;
}

export type SwfControlTag =
  | SwfPlaceObjectTag
  | SwfRemoveObject2Tag
  | SwfDefineShapeTag
  | SwfDefineMorphShapeTag
  | SwfDefineSpriteTag
  | SwfFileAttributesTag
  | SwfBackgroundColorTag
  | SwfTag;

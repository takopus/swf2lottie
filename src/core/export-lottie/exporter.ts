import type {
  FlashColorTransform,
  FlashDisplayObjectState,
  FlashDocument,
  FlashGradientFill,
  FlashMovieClipSymbol,
  FlashShapePath,
  FlashShapeSymbol,
  FlashSolidFill,
  FlashTimeline
} from "../ir/index.js";
import type { ConversionIssue } from "../issues.js";
import type { LottieExportResult } from "./types.js";

interface TimelineTrack {
  id: string;
  depth: number;
  symbolId: string;
  name?: string;
  firstFrame: number;
  lastFrame: number;
  samples: Array<FlashDisplayObjectState | null>;
}

interface TransformSample {
  frame: number;
  position: [number, number, number];
  rotation: number;
  scale: [number, number, number];
  opacity: number;
  colorTransform: FlashColorTransform;
}

interface FlattenedShapeTrack {
  id: string;
  name?: string;
  depthPath: number[];
  symbol: FlashShapeSymbol;
  samples: Array<FlashDisplayObjectState | null>;
}

type FlashSymbolMap = Map<string, FlashDocument["symbols"][number]>;

export function exportToLottie(document: FlashDocument): {
  result: LottieExportResult;
  issues: ConversionIssue[];
} {
  const issues: ConversionIssue[] = [];
  const symbolMap: FlashSymbolMap = new Map(document.symbols.map((symbol) => [symbol.id, symbol]));
  const root = symbolMap.get(document.rootTimelineId);

  if (!root || root.kind !== "movieclip") {
    return {
      result: { animation: null },
      issues: [
        {
          code: "unsupported_feature",
          severity: "error",
          message: "Root timeline is missing or is not a movieclip."
        }
      ]
    };
  }

  const layers = exportTimelineLayers(root.timeline, document, symbolMap, issues);

  if (layers.length === 0) {
    issues.push({
      code: "not_implemented",
      severity: "error",
      message: "No exportable layers were found.",
      details: { rootTimelineId: document.rootTimelineId }
    });
  }

  return {
    result: {
      animation: layers.length > 0
        ? {
            v: "5.12.2",
            fr: document.frameRate,
            ip: 0,
            op: root.timeline.frames.length,
            w: document.width,
            h: document.height,
            nm: "swf2lottie",
            ddd: 0,
            assets: [],
            layers
          }
        : null
    },
    issues
  };
}

function exportMovieClipAsset(
  symbol: FlashMovieClipSymbol,
  document: FlashDocument,
  symbolMap: FlashSymbolMap,
  _assetIds: Map<string, string>,
  issues: ConversionIssue[]
): Record<string, unknown> {
  return {
    id: `asset:${symbol.id}`,
    nm: symbol.id,
    fr: document.frameRate,
    w: document.width,
    h: document.height,
    layers: exportTimelineLayers(symbol.timeline, document, symbolMap, issues)
  };
}

function exportTimelineLayers(
  timeline: FlashTimeline,
  document: FlashDocument,
  symbolMap: FlashSymbolMap,
  issues: ConversionIssue[]
): Record<string, unknown>[] {
  const tracks = buildTimelineTracks(timeline);

  const layers = tracks
    .sort((left, right) => right.depth - left.depth)
    .flatMap((track) => exportTrack(track, timeline, document, symbolMap, issues));

  return layers.map((layer, index) => ({
    ...layer,
    ind: index + 1
  }));
}

function exportTrack(
  track: TimelineTrack,
  timeline: FlashTimeline,
  document: FlashDocument,
  symbolMap: FlashSymbolMap,
  issues: ConversionIssue[]
): Record<string, unknown>[] {
  const symbol = symbolMap.get(track.symbolId);

  if (!symbol) {
    issues.push({
      code: "unsupported_feature",
      severity: "warning",
      message: "Display object references a missing symbol.",
      path: track.id,
      details: { symbolId: track.symbolId }
    });
    return [];
  }

  const transformSamples = track.samples
    .map((sample, frame) => toTransformSample(frame, sample, issues, track.id))
    .filter((sample): sample is TransformSample => sample !== null);

  if (transformSamples.length === 0) {
    return [];
  }

  const baseLayer = {
    ddd: 0,
    nm: track.name ?? track.id,
    sr: 1,
    ks: exportTransformSamples(transformSamples),
    ip: track.firstFrame,
    op: Math.min(track.lastFrame + 1, timeline.frames.length),
    st: 0,
    ao: 0
  };

  if (symbol.kind === "shape") {
    const shapes = symbol.paths.flatMap((path) => exportShapePath(path, issues, transformSamples, track.samples));
    if (shapes.length === 0) {
      return [];
    }

    const layerTransformSamples = needsBakedMatrix(track.samples)
      ? transformSamples.map((sample) => ({
          ...sample,
          position: [0, 0, 0] as [number, number, number],
          rotation: 0,
          scale: [100, 100, 100] as [number, number, number]
        }))
      : transformSamples;

    return [
      {
        ...baseLayer,
        ks: exportTransformSamples(layerTransformSamples),
        ty: 4,
        shapes
      }
    ];
  }

  if (canFlattenStaticMovieClip(symbol, symbolMap)) {
    const shapes = exportStaticMovieClipShapes(symbol, symbolMap, issues, transformSamples);
    if (shapes.length === 0) {
      return [];
    }

    return [
      {
        ...baseLayer,
        ty: 4,
        shapes
      }
    ];
  }

  return exportMovieClipAsFlattenedLayers(track, symbol, timeline.frames.length, symbolMap, issues).map(
    (layer) => ({
      ...baseLayer,
      nm: layer.name,
      ks: exportTransformSamples(layer.transformSamples),
      ty: 4,
      shapes: layer.shapes
    })
  );
}

function buildTimelineTracks(timeline: FlashTimeline): TimelineTrack[] {
  const tracks = new Map<string, TimelineTrack>();

  timeline.frames.forEach((frame, frameIndex) => {
    const activeIds = new Set(frame.displayList.map((instance) => instance.id));

    for (const instance of frame.displayList) {
      const existing = tracks.get(instance.id);
      if (!existing) {
        const samples = Array.from({ length: timeline.frames.length }, () => null as FlashDisplayObjectState | null);
        samples[frameIndex] = instance;
        const track: TimelineTrack = {
          id: instance.id,
          depth: instance.depth,
          symbolId: instance.symbolId,
          firstFrame: frameIndex,
          lastFrame: frameIndex,
          samples
        };
        if (instance.name) {
          track.name = instance.name;
        }
        tracks.set(instance.id, track);
        continue;
      }

      existing.samples[frameIndex] = instance;
      existing.lastFrame = frameIndex;
      if (!existing.name && instance.name) {
        existing.name = instance.name;
      }
    }

    for (const [trackId, track] of tracks) {
      if (track.firstFrame > frameIndex || activeIds.has(trackId)) {
        continue;
      }

      if (track.samples[frameIndex] === null) {
        track.samples[frameIndex] = null;
      }
    }
  });

  return Array.from(tracks.values());
}

function toTransformSample(
  frame: number,
  sample: FlashDisplayObjectState | null,
  issues: ConversionIssue[],
  path: string
): TransformSample | null {
  if (!sample) {
    return null;
  }

  return {
    frame,
    position: [sample.matrix.tx / 20, sample.matrix.ty / 20, 0],
    rotation: rotationFromMatrix(sample.matrix),
    scale: [scalePercentFromMatrixX(sample), scalePercentFromMatrixY(sample), 100],
    opacity: clamp(sample.colorTransform.alpha * 100, 0, 100),
    colorTransform: sample.colorTransform
  };
}

function exportTransformSamples(samples: TransformSample[]): Record<string, unknown> {
  return {
    o: exportScalarProperty(samples.map((sample) => ({ frame: sample.frame, value: sample.opacity }))),
    r: exportScalarProperty(samples.map((sample) => ({ frame: sample.frame, value: sample.rotation }))),
    p: exportVectorProperty(samples.map((sample) => ({ frame: sample.frame, value: sample.position }))),
    a: { a: 0, k: [0, 0, 0] },
    s: exportVectorProperty(samples.map((sample) => ({ frame: sample.frame, value: sample.scale })))
  };
}

function exportShapePath(
  path: FlashShapePath,
  issues: ConversionIssue[],
  transformSamples: TransformSample[] = [],
  sourceSamples?: Array<FlashDisplayObjectState | null>
): Record<string, unknown>[] {
  const shapePath = sourceSamples && needsBakedMatrix(sourceSamples)
    ? bakePathAnimation(path, sourceSamples)
    : exportLottieBezier(path);

  if (!path.fill) {
    issues.push({
      code: "unsupported_fill",
      severity: "warning",
      message: "Unfilled paths are skipped."
    });
    return [];
  }

  if (path.fill.kind === "solid") {
    return [
      {
        ty: "gr",
        it: [shapePath, exportSolidFill(path.fill, transformSamples), exportGroupTransform()]
      }
    ];
  }

  if (path.fill.kind === "linear-gradient") {
    return [
      {
        ty: "gr",
        it: [shapePath, exportLinearGradientFill(path.fill), exportGroupTransform()]
      }
    ];
  }

  if (path.fill.kind === "radial-gradient") {
    return [
      {
        ty: "gr",
        it: [shapePath, exportRadialGradientFill(path.fill), exportGroupTransform()]
      }
    ];
  }

  issues.push({
    code: "not_implemented",
    severity: "warning",
    message: "This gradient fill type is parsed but not exported yet.",
    details: { fillKind: path.fill.kind }
  });
  return [];
}

function exportStaticMovieClipShapes(
  symbol: FlashMovieClipSymbol,
  symbolMap: FlashSymbolMap,
  issues: ConversionIssue[],
  transformSamples: TransformSample[] = []
): Record<string, unknown>[] {
  const frame = symbol.timeline.frames[0];
  if (!frame) {
    return [];
  }

  return frame.displayList
    .slice()
    .sort((left, right) => right.depth - left.depth)
    .flatMap((instance) => exportStaticInstanceShapes(instance, symbolMap, issues, transformSamples));
}

function exportStaticInstanceShapes(
  instance: FlashDisplayObjectState,
  symbolMap: FlashSymbolMap,
  issues: ConversionIssue[],
  transformSamples: TransformSample[] = []
): Record<string, unknown>[] {
  const symbol = symbolMap.get(instance.symbolId);
  if (!symbol) {
    return [];
  }

  if (symbol.kind === "shape") {
    const items = symbol.paths.flatMap((path) => exportShapePath(path, issues, transformSamples));
    if (items.length === 0) {
      return [];
    }

    return [
      {
        ty: "gr",
        nm: instance.name ?? instance.id,
        it: [
          ...items,
          exportGroupTransformFromInstance(instance)
        ]
      }
    ];
  }

  if (!canFlattenStaticMovieClip(symbol, symbolMap)) {
    issues.push({
      code: "not_implemented",
      severity: "warning",
      message: "Dynamic nested movieclips inside static flattening path are not exported inline.",
      path: instance.id,
      details: { symbolId: symbol.id }
    });
    return [];
  }

  const items = exportStaticMovieClipShapes(symbol, symbolMap, issues, transformSamples);
  if (items.length === 0) {
    return [];
  }

  return [
    {
      ty: "gr",
      nm: instance.name ?? instance.id,
      it: [
        ...items,
        exportGroupTransformFromInstance(instance)
      ]
    }
  ];
}

function exportMovieClipAsFlattenedLayers(
  track: TimelineTrack,
  symbol: FlashMovieClipSymbol,
  rootFrameCount: number,
  symbolMap: FlashSymbolMap,
  issues: ConversionIssue[]
): Array<{
  name: string;
  transformSamples: TransformSample[];
  shapes: Record<string, unknown>[];
}> {
  const flattened = collectFlattenedShapeTracks(track, symbol, rootFrameCount, symbolMap);

  return flattened
    .sort(compareFlattenedDepth)
    .flatMap((leaf) => {
      const transformSamples = leaf.samples
        .map((sample, frame) => toTransformSample(frame, sample, issues, leaf.id))
        .filter((sample): sample is TransformSample => sample !== null);

      if (transformSamples.length === 0) {
        return [];
      }

      const shapes = leaf.symbol.paths.flatMap((path) => exportShapePath(path, issues, transformSamples));
      const bakedShapes = leaf.symbol.paths.flatMap((path) => exportShapePath(path, issues, transformSamples, leaf.samples));
      if (bakedShapes.length === 0) {
        return [];
      }

      return [
        {
          name: leaf.name ?? leaf.id,
          transformSamples,
          shapes: bakedShapes
        }
      ];
    });
}

function collectFlattenedShapeTracks(
  track: TimelineTrack,
  symbol: FlashMovieClipSymbol,
  rootFrameCount: number,
  symbolMap: FlashSymbolMap
): FlattenedShapeTrack[] {
  const trackMap = new Map<string, FlattenedShapeTrack>();

  for (let rootFrame = 0; rootFrame < rootFrameCount; rootFrame += 1) {
    const parentSample = track.samples[rootFrame];
    if (!parentSample) {
      continue;
    }

    const symbolFrame = mod(rootFrame - track.firstFrame, symbol.timeline.frames.length);
    collectFlattenedFromMovieClipFrame(
      symbol,
      symbolFrame,
      parentSample,
      track.id,
      [track.depth],
      rootFrame,
      rootFrameCount,
      symbolMap,
      trackMap
    );
  }

  return Array.from(trackMap.values());
}

function collectFlattenedFromMovieClipFrame(
  symbol: FlashMovieClipSymbol,
  symbolFrame: number,
  parentState: FlashDisplayObjectState,
  pathPrefix: string,
  depthPath: number[],
  rootFrame: number,
  rootFrameCount: number,
  symbolMap: FlashSymbolMap,
  trackMap: Map<string, FlattenedShapeTrack>
): void {
  const childTracks = buildTimelineTracks(symbol.timeline);

  for (const childTrack of childTracks) {
    const localSample = childTrack.samples[symbolFrame];
    if (!localSample) {
      continue;
    }

    const childSymbol = symbolMap.get(childTrack.symbolId);
    if (!childSymbol) {
      continue;
    }

    const nextDepthPath = [...depthPath, childTrack.depth];
    const combinedState = combineDisplayStates(
      parentState,
      localSample,
      `${pathPrefix}/${childTrack.id}`,
      nextDepthPath
    );

    if (childSymbol.kind === "shape") {
      const existing = trackMap.get(combinedState.id) ?? createFlattenedShapeTrack(
        combinedState.id,
        combinedState.name,
        nextDepthPath,
        childSymbol,
        rootFrameCount
      );
      existing.samples[rootFrame] = combinedState;
      trackMap.set(existing.id, existing);
      continue;
    }

    const childFrame = mod(symbolFrame - childTrack.firstFrame, childSymbol.timeline.frames.length);
    collectFlattenedFromMovieClipFrame(
      childSymbol,
      childFrame,
      combinedState,
      combinedState.id,
      nextDepthPath,
      rootFrame,
      rootFrameCount,
      symbolMap,
      trackMap
    );
  }
}

function combineDisplayStates(
  parent: FlashDisplayObjectState,
  child: FlashDisplayObjectState,
  id: string,
  depthPath: number[]
): FlashDisplayObjectState {
  return {
    id,
    symbolId: child.symbolId,
    depth: depthPath[depthPath.length - 1] ?? child.depth,
    ...(child.name || parent.name ? { name: child.name ?? parent.name } : {}),
    matrix: multiplyMatrices(parent.matrix, child.matrix),
    colorTransform: combineColorTransforms(parent.colorTransform, child.colorTransform)
  };
}

function multiplyMatrices(
  parent: FlashDisplayObjectState["matrix"],
  child: FlashDisplayObjectState["matrix"]
): FlashDisplayObjectState["matrix"] {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty
  };
}

function combineColorTransforms(
  parent: FlashColorTransform,
  child: FlashColorTransform
): FlashColorTransform {
  return {
    alpha: parent.alpha * child.alpha,
    ...(child.brightness !== undefined
      ? { brightness: child.brightness }
      : parent.brightness !== undefined
        ? { brightness: parent.brightness }
        : {}),
    ...(child.tint
      ? { tint: child.tint }
      : parent.tint
        ? { tint: parent.tint }
        : {})
  };
}

function createFlattenedShapeTrack(
  id: string,
  name: string | undefined,
  depthPath: number[],
  symbol: FlashShapeSymbol,
  rootFrameCount: number
): FlattenedShapeTrack {
  return {
    id,
    ...(name ? { name } : {}),
    depthPath,
    symbol,
    samples: Array.from({ length: rootFrameCount }, () => null as FlashDisplayObjectState | null)
  };
}

function compareFlattenedDepth(left: FlattenedShapeTrack, right: FlattenedShapeTrack): number {
  const length = Math.max(left.depthPath.length, right.depthPath.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left.depthPath[index] ?? Number.NEGATIVE_INFINITY;
    const rightValue = right.depthPath[index] ?? Number.NEGATIVE_INFINITY;
    if (leftValue !== rightValue) {
      return rightValue - leftValue;
    }
  }

  return left.id.localeCompare(right.id);
}

function exportLottieBezier(path: FlashShapePath): Record<string, unknown> {
  return {
    ty: "sh",
    ks: {
      a: 0,
      k: {
        c: path.geometry.closed,
        v: path.geometry.vertices,
        i: path.geometry.inTangents,
        o: path.geometry.outTangents
      }
    }
  };
}

function bakePathAnimation(
  path: FlashShapePath,
  samples: Array<FlashDisplayObjectState | null>
): Record<string, unknown> {
  const keyframes = samples
    .map((sample, frame) => {
      if (!sample) {
        return null;
      }

      return {
        t: frame,
        s: [transformBezierGeometry(path.geometry, sample.matrix)]
      };
    })
    .filter((value): value is { t: number; s: Array<Record<string, unknown>> } => value !== null);

  const uniqueValues = new Set(keyframes.map((keyframe) => JSON.stringify(keyframe.s[0])));
  if (uniqueValues.size <= 1) {
    return {
      ty: "sh",
      ks: {
        a: 0,
        k: keyframes[0]?.s[0] ?? bezierGeometryToLottie(path.geometry)
      }
    };
  }

  return {
    ty: "sh",
    ks: {
      a: 1,
      k: keyframes.map((keyframe, index) => ({
        t: keyframe.t,
        s: keyframe.s,
        h: 1,
        ...(index < keyframes.length - 1 ? { e: [keyframes[index + 1]?.s[0] ?? keyframe.s[0]] } : {})
      }))
    }
  };
}

function transformBezierGeometry(
  geometry: FlashShapePath["geometry"],
  matrix: FlashDisplayObjectState["matrix"]
): Record<string, unknown> {
  const vertices = geometry.vertices.map(([x, y]) => applyMatrixToPoint([x, y], matrix));
  const inTangents = geometry.vertices.map(([x, y], index) => {
    const tangent = geometry.inTangents[index] ?? [0, 0];
    return applyMatrixToVector(tangent, matrix);
  });
  const outTangents = geometry.vertices.map(([x, y], index) => {
    const tangent = geometry.outTangents[index] ?? [0, 0];
    return applyMatrixToVector(tangent, matrix);
  });

  return {
    c: geometry.closed,
    v: vertices,
    i: inTangents,
    o: outTangents
  };
}

function bezierGeometryToLottie(geometry: FlashShapePath["geometry"]): Record<string, unknown> {
  return {
    c: geometry.closed,
    v: geometry.vertices,
    i: geometry.inTangents,
    o: geometry.outTangents
  };
}

function exportSolidFill(fill: FlashSolidFill, transformSamples: TransformSample[] = []): Record<string, unknown> {
  const colorProperty = exportFillColorProperty(fill, transformSamples);

  return {
    ty: "fl",
    c: colorProperty,
    o: { a: 0, k: clamp(fill.alpha * 100, 0, 100) },
    r: 1
  };
}

function exportLinearGradientFill(fill: FlashGradientFill): Record<string, unknown> {
  const start = applyGradientMatrix(fill.matrix, -16384 / 20, 0);
  const end = applyGradientMatrix(fill.matrix, 16384 / 20, 0);

  return {
    ty: "gf",
    o: { a: 0, k: 100 },
    r: 1,
    s: { a: 0, k: start },
    e: { a: 0, k: end },
    t: 1,
    g: {
      p: fill.stops.length,
      k: {
        a: 0,
        k: flattenGradientStops(fill)
      }
    }
  };
}

function exportRadialGradientFill(fill: FlashGradientFill): Record<string, unknown> {
  const start = applyGradientMatrix(fill.matrix, 0, 0);
  const end = applyGradientMatrix(fill.matrix, 16384 / 20, 0);

  return {
    ty: "gf",
    o: { a: 0, k: 100 },
    r: 1,
    s: { a: 0, k: start },
    e: { a: 0, k: end },
    t: 2,
    h: { a: 0, k: 0 },
    a: { a: 0, k: 0 },
    g: {
      p: fill.stops.length,
      k: {
        a: 0,
        k: flattenGradientStops(fill)
      }
    }
  };
}

function exportGroupTransform(): Record<string, unknown> {
  return {
    ty: "tr",
    p: { a: 0, k: [0, 0] },
    a: { a: 0, k: [0, 0] },
    s: { a: 0, k: [100, 100] },
    r: { a: 0, k: 0 },
    o: { a: 0, k: 100 },
    sk: { a: 0, k: 0 },
    sa: { a: 0, k: 0 }
  };
}

function exportGroupTransformFromInstance(instance: FlashDisplayObjectState): Record<string, unknown> {
  return {
    ty: "tr",
    p: { a: 0, k: [instance.matrix.tx / 20, instance.matrix.ty / 20] },
    a: { a: 0, k: [0, 0] },
    s: {
      a: 0,
      k: [
        scalePercentFromMatrixX(instance),
        scalePercentFromMatrixY(instance)
      ]
    },
    r: { a: 0, k: rotationFromMatrix(instance.matrix) },
    o: { a: 0, k: clamp(instance.colorTransform.alpha * 100, 0, 100) },
    sk: { a: 0, k: 0 },
    sa: { a: 0, k: 0 }
  };
}

function exportScalarProperty(
  keyframes: Array<{ frame: number; value: number }>
): Record<string, unknown> {
  const uniqueValues = new Set(keyframes.map((keyframe) => Math.round(keyframe.value * 1000)));
  if (uniqueValues.size <= 1) {
    return { a: 0, k: keyframes[0]?.value ?? 0 };
  }

  return {
    a: 1,
    k: keyframes.map((keyframe, index) => ({
      t: keyframe.frame,
      s: [keyframe.value],
      h: 1,
      ...(index < keyframes.length - 1 ? { e: [keyframes[index + 1]?.value ?? keyframe.value] } : {})
    }))
  };
}

function exportVectorProperty(
  keyframes: Array<{ frame: number; value: [number, number, number] }>
): Record<string, unknown> {
  const uniqueValues = new Set(keyframes.map((keyframe) => keyframe.value.join(",")));
  if (uniqueValues.size <= 1) {
    return { a: 0, k: keyframes[0]?.value ?? [0, 0, 0] };
  }

  return {
    a: 1,
    k: keyframes.map((keyframe, index) => ({
      t: keyframe.frame,
      s: keyframe.value,
      h: 1,
      ...(index < keyframes.length - 1 ? { e: keyframes[index + 1]?.value ?? keyframe.value } : {})
    }))
  };
}

function canFlattenStaticMovieClip(
  symbol: FlashMovieClipSymbol,
  symbolMap: FlashSymbolMap,
  seen = new Set<string>()
): boolean {
  if (seen.has(symbol.id)) {
    return false;
  }

  if (symbol.timeline.frames.length !== 1) {
    return false;
  }

  seen.add(symbol.id);
  const frame = symbol.timeline.frames[0];
  if (!frame) {
    return false;
  }

  return frame.displayList.every((instance) => {
    const child = symbolMap.get(instance.symbolId);
    if (!child) {
      return false;
    }

    if (child.kind === "shape") {
      return true;
    }

    return canFlattenStaticMovieClip(child, symbolMap, seen);
  });
}

function rotationFromMatrix(matrix: FlashDisplayObjectState["matrix"]): number {
  return (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI;
}

function scalePercentFromMatrixX(sample: FlashDisplayObjectState): number {
  return Math.sqrt(sample.matrix.a ** 2 + sample.matrix.b ** 2) * 100;
}

function scalePercentFromMatrixY(sample: FlashDisplayObjectState): number {
  return Math.sqrt(sample.matrix.c ** 2 + sample.matrix.d ** 2) * 100;
}

function needsBakedMatrix(samples: Array<FlashDisplayObjectState | null>): boolean {
  return samples.some((sample) => sample ? hasShear(sample.matrix) : false);
}

function hasShear(matrix: FlashDisplayObjectState["matrix"]): boolean {
  const dot = matrix.a * matrix.c + matrix.b * matrix.d;
  return Math.abs(dot) > 1e-6;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16)
  ];
}

function flattenGradientStops(fill: FlashGradientFill): number[] {
  const colors = fill.stops.flatMap((stop) => {
    const [red, green, blue] = hexToRgb(stop.color);
    return [stop.offset, red / 255, green / 255, blue / 255];
  });
  const opacity = fill.stops.flatMap((stop) => [stop.offset, stop.alpha]);
  return [...colors, ...opacity];
}

function applyGradientMatrix(
  matrix: FlashGradientFill["matrix"],
  x: number,
  y: number
): [number, number] {
  return [
    matrix.a * x + matrix.c * y + matrix.tx,
    matrix.b * x + matrix.d * y + matrix.ty
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function applyMatrixToPoint(
  point: [number, number],
  matrix: FlashDisplayObjectState["matrix"]
): [number, number] {
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.tx / 20,
    matrix.b * point[0] + matrix.d * point[1] + matrix.ty / 20
  ];
}

function applyMatrixToVector(
  vector: [number, number],
  matrix: FlashDisplayObjectState["matrix"]
): [number, number] {
  return [
    matrix.a * vector[0] + matrix.c * vector[1],
    matrix.b * vector[0] + matrix.d * vector[1]
  ];
}

function mod(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function exportFillColorProperty(
  fill: FlashSolidFill,
  transformSamples: TransformSample[]
): Record<string, unknown> {
  if (transformSamples.length === 0) {
    return { a: 0, k: colorVector(fill.color) };
  }

  const keyframes = transformSamples.map((sample) => ({
    frame: sample.frame,
    value: colorVector(applyColorTransformToHex(fill.color, sample.colorTransform))
  }));
  const uniqueValues = new Set(keyframes.map((keyframe) => keyframe.value.join(",")));

  if (uniqueValues.size <= 1) {
    return { a: 0, k: keyframes[0]?.value ?? colorVector(fill.color) };
  }

  return {
    a: 1,
    k: keyframes.map((keyframe, index) => ({
      t: keyframe.frame,
      s: keyframe.value,
      h: 1,
      ...(index < keyframes.length - 1 ? { e: keyframes[index + 1]?.value ?? keyframe.value } : {})
    }))
  };
}

function applyColorTransformToHex(hex: string, transform: FlashColorTransform): string {
  let [red, green, blue] = hexToRgb(hex);

  if (transform.brightness !== undefined) {
    [red, green, blue] = applyBrightness([red, green, blue], transform.brightness);
  }

  if (transform.tint) {
    [red, green, blue] = applyTint([red, green, blue], transform.tint.color, transform.tint.amount);
  }

  return rgbToHex(red, green, blue);
}

function applyBrightness(
  rgb: [number, number, number],
  brightness: number
): [number, number, number] {
  if (brightness >= 0) {
    return rgb.map((channel) => Math.round(channel * (1 - brightness) + 255 * brightness)) as [number, number, number];
  }

  return rgb.map((channel) => Math.round(channel * (1 + brightness))) as [number, number, number];
}

function applyTint(
  rgb: [number, number, number],
  tintHex: string,
  amount: number
): [number, number, number] {
  const tint = hexToRgb(tintHex);
  return [
    Math.round(rgb[0] * (1 - amount) + tint[0] * amount),
    Math.round(rgb[1] * (1 - amount) + tint[1] * amount),
    Math.round(rgb[2] * (1 - amount) + tint[2] * amount)
  ];
}

function colorVector(hex: string): [number, number, number, number] {
  const [red, green, blue] = hexToRgb(hex);
  return [red / 255, green / 255, blue / 255, 1];
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function toHex(value: number): string {
  return clamp(Math.round(value), 0, 255).toString(16).padStart(2, "0");
}

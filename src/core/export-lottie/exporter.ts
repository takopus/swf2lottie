import type {
  FlashColorTransform,
  FlashDisplayObjectState,
  FlashDocument,
  FlashGradientFill,
  FlashMorphShapePath,
  FlashMovieClipSymbol,
  FlashShapePath,
  FlashShapeSymbol,
  FlashSolidFill,
  FlashSolidStroke,
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

interface ScalarKeySample {
  frame: number;
  value: number;
}

interface VectorKeySample {
  frame: number;
  value: number[];
}

interface ShapeStyleGroup {
  index: number;
  fill?: FlashShapePath["fill"];
  stroke?: FlashShapePath["stroke"];
  paths: FlashShapePath[];
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
            op: minimumOutPoint(root.timeline.frames.length),
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
  const trackMap = new Map(tracks.map((track) => [track.id, track]));

  const layers = tracks
    .sort((left, right) => right.depth - left.depth)
    .flatMap((track) => exportTrack(track, trackMap, timeline, document, symbolMap, issues));

  return layers.map((layer, index) => ({
    ...layer,
    ind: index + 1
  }));
}

function exportTrack(
  track: TimelineTrack,
  trackMap: Map<string, TimelineTrack>,
  timeline: FlashTimeline,
  document: FlashDocument,
  symbolMap: FlashSymbolMap,
  issues: ConversionIssue[]
): Record<string, unknown>[] {
  if (track.samples.some((sample) => sample?.isMask)) {
    return [];
  }

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
  const maskProperties = exportMaskProperties(track, trackMap, symbolMap, issues);
  const shouldBakeLayerTransform = needsBakedMatrix(track.samples) || maskProperties.length > 0;

  if (transformSamples.length === 0) {
    return [];
  }

  const baseLayer = {
    ddd: 0,
    nm: track.name ?? track.id,
    sr: 1,
    ks: exportTransformSamples(transformSamples),
    ip: track.firstFrame,
    op: minimumOutPoint(Math.min(track.lastFrame + 1, timeline.frames.length), track.firstFrame),
    st: 0,
    ao: 0
  };

  if (symbol.kind === "shape") {
    const sourceSamples = shouldBakeLayerTransform ? track.samples : undefined;
    const shapes = sortShapeGroups(exportShapePaths(symbol.paths, issues, transformSamples, sourceSamples));
    if (shapes.length === 0) {
      return [];
    }

    const layerTransformSamples = shouldBakeLayerTransform
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
        shapes,
        ...(maskProperties.length > 0 ? { hasMask: true, masksProperties: maskProperties } : {})
      }
    ];
  }

  if (symbol.kind === "morphshape") {
    const shapes = sortShapeGroups(
      symbol.paths.flatMap((path) => exportMorphShapePath(path, track.samples, issues))
    );
    if (shapes.length === 0) {
      return [];
    }

    const layerTransformSamples = shouldBakeLayerTransform
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
        shapes,
        ...(maskProperties.length > 0 ? { hasMask: true, masksProperties: maskProperties } : {})
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

function exportShapePaths(
  paths: FlashShapePath[],
  issues: ConversionIssue[],
  transformSamples: TransformSample[] = [],
  sourceSamples?: Array<FlashDisplayObjectState | null>
): Record<string, unknown>[] {
  const exported: Record<string, unknown>[] = [];

  for (const group of groupPathsByStyle(paths)) {
    const items: Record<string, unknown>[] = group.paths.map((path) =>
      sourceSamples && needsBakedMatrix(sourceSamples)
        ? bakePathAnimation(path, sourceSamples)
        : exportLottieBezier(path)
    );

    if (group.fill) {
      if (group.fill.kind === "solid") {
        items.push(exportSolidFill(group.fill, transformSamples));
      } else if (group.fill.kind === "linear-gradient") {
        items.push(exportLinearGradientFill(group.fill, transformSamples, sourceSamples));
      } else if (group.fill.kind === "radial-gradient") {
        items.push(exportRadialGradientFill(group.fill, transformSamples, sourceSamples));
      } else {
        issues.push({
          code: "not_implemented",
          severity: "warning",
          message: "This gradient fill type is parsed but not exported yet.",
          details: { fillKind: group.fill.kind }
        });
      }
    }

    if (group.stroke?.kind === "solid") {
      items.push(exportSolidStroke(group.stroke));
    }

    if (items.length === group.paths.length) {
      issues.push({
        code: "unsupported_fill",
        severity: "warning",
        message: "Paths without supported fill or stroke are skipped."
      });
      continue;
    }

    exported.push({
      ty: "gr",
      it: [...items, exportGroupTransform()]
    });
  }

  return exported;
}

function groupPathsByStyle(paths: FlashShapePath[]): ShapeStyleGroup[] {
  const groups = new Map<string, ShapeStyleGroup>();

  for (const [index, path] of paths.entries()) {
    const groupKey = `${path.fill ? JSON.stringify(path.fill) : "none"}|${path.stroke ? JSON.stringify(path.stroke) : "none"}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.paths.push(path);
      continue;
    }

    groups.set(groupKey, {
      index,
      fill: path.fill,
      stroke: path.stroke,
      paths: [path]
    });
  }

  return [...groups.values()].sort((left, right) => left.index - right.index);
}

function exportMaskProperties(
  track: TimelineTrack,
  trackMap: Map<string, TimelineTrack>,
  symbolMap: FlashSymbolMap,
  issues: ConversionIssue[]
): Record<string, unknown>[] {
  const maskLayerId = firstMaskLayerId(track.samples);
  if (!maskLayerId) {
    return [];
  }

  const maskTrack = trackMap.get(maskLayerId);
  if (!maskTrack) {
    issues.push({
      code: "unsupported_mask",
      severity: "warning",
      message: "Mask layer reference could not be resolved.",
      path: track.id,
      details: { maskLayerId }
    });
    return [];
  }

  const maskSymbol = symbolMap.get(maskTrack.symbolId);
  if (!maskSymbol || (maskSymbol.kind !== "shape" && maskSymbol.kind !== "morphshape")) {
    issues.push({
      code: "unsupported_mask",
      severity: "warning",
      message: "Only shape-based masks are exported.",
      path: track.id,
      details: { maskLayerId, symbolId: maskTrack.symbolId }
    });
    return [];
  }

  const maskPaths = maskSymbol.kind === "shape"
    ? maskSymbol.paths.map((path) => bakePathAnimation(path, maskTrack.samples).ks)
    : maskSymbol.paths.map((path) => exportMorphBezier(path, maskTrack.samples));

  return maskPaths.map((ks, index) => ({
    mode: "a",
    inv: false,
    cl: true,
    nm: `mask:${maskLayerId}:${index + 1}`,
    o: { a: 0, k: 100 },
    pt: ks,
    x: { a: 0, k: 0 }
  }));
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

  return sortShapeGroups(frame.displayList
    .slice()
    .sort((left, right) => right.depth - left.depth)
    .flatMap((instance) => exportStaticInstanceShapes(instance, symbolMap, issues, transformSamples)));
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
    const items = exportShapePaths(symbol.paths, issues, transformSamples);
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

  if (symbol.kind === "morphshape") {
    const items = symbol.paths.flatMap((path) => exportMorphShapePath(path, [instance], issues));
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

      const bakedShapes = sortShapeGroups(
        exportShapePaths(leaf.symbol.paths, issues, transformSamples, leaf.samples)
      );
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

    if (childSymbol.kind === "shape" || childSymbol.kind === "morphshape") {
      const existing = trackMap.get(combinedState.id) ?? createFlattenedShapeTrack(
        combinedState.id,
        combinedState.name,
        nextDepthPath,
        childSymbol.kind === "shape"
          ? childSymbol
          : {
              kind: "shape",
              id: `${childSymbol.id}:ratio:${Math.round((combinedState.ratio ?? 0) * 65535)}`,
              paths: childSymbol.paths.map((path) => interpolateMorphPath(path, combinedState.ratio ?? 0))
            },
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
    colorTransform: combineColorTransforms(parent.colorTransform, child.colorTransform),
    ...(child.ratio !== undefined ? { ratio: child.ratio } : {})
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

function exportMorphShapePath(
  path: FlashMorphShapePath,
  samples: Array<FlashDisplayObjectState | null>,
  issues: ConversionIssue[]
): Record<string, unknown>[] {
  const shapePath = {
    ty: "sh",
    ks: exportMorphBezier(path, samples)
  };
  const items: Record<string, unknown>[] = [shapePath];
  const fill = exportMorphFill(path, samples, issues);
  const stroke = exportMorphStroke(path, samples);

  if (fill) {
    items.push(fill);
  }

  if (stroke) {
    items.push(stroke);
  }

  if (items.length === 1) {
    issues.push({
      code: "unsupported_feature",
      severity: "warning",
      message: "Morph path without a supported fill or stroke is skipped."
    });
    return [];
  }

  return [
    {
      ty: "gr",
      it: [...items, exportGroupTransform()]
    }
  ];
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

function exportMorphBezier(
  path: FlashMorphShapePath,
  samples: Array<FlashDisplayObjectState | null>
): Record<string, unknown> {
  const [startGeometry, endGeometry] = prepareMorphGeometryPair(path.start.geometry, path.end.geometry);

  if (!canMorphGeometries(startGeometry, endGeometry)) {
    return {
      a: 0,
      k: bezierGeometryToLottie(startGeometry)
    };
  }

  const keyframes = samples
    .map((sample, frame) => {
      if (!sample) {
        return null;
      }

      const morphed = interpolateGeometry(startGeometry, endGeometry, sample.ratio ?? 0);
      const geometry = needsBakedMatrix(samples)
        ? transformBezierGeometry(morphed, sample.matrix)
        : bezierGeometryToLottie(morphed);

      return {
        frame,
        value: geometry
      };
    })
    .filter((value): value is { frame: number; value: Record<string, unknown> } => value !== null);

  const uniqueValues = new Set(keyframes.map((keyframe) => JSON.stringify(keyframe.value)));
  if (uniqueValues.size <= 1) {
    return {
      a: 0,
      k: keyframes[0]?.value ?? bezierGeometryToLottie(startGeometry)
    };
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

function exportMorphFill(
  path: FlashMorphShapePath,
  samples: Array<FlashDisplayObjectState | null>,
  issues: ConversionIssue[]
): Record<string, unknown> | null {
  const startFill = path.start.fill;
  const endFill = path.end.fill;

  if (!startFill || !endFill) {
    return startFill ?? endFill ? null : null;
  }

  if (startFill.kind === "solid" && endFill.kind === "solid") {
    const colorKeyframes = samples
      .map((sample, frame) => {
        if (!sample) {
          return null;
        }

        return {
          frame,
          value: interpolateColorVector(startFill.color, endFill.color, sample.ratio ?? 0)
        };
      })
      .filter((value): value is { frame: number; value: [number, number, number, number] } => value !== null);

    const opacityKeyframes = samples
      .map((sample, frame) => {
        if (!sample) {
          return null;
        }

        return {
          frame,
          value: clamp(interpolateNumber(startFill.alpha, endFill.alpha, sample.ratio ?? 0) * 100, 0, 100)
        };
      })
      .filter((value): value is { frame: number; value: number } => value !== null);

    return {
      ty: "fl",
      c: exportVectorProperty(colorKeyframes),
      o: exportScalarProperty(opacityKeyframes),
      r: 1
    };
  }

  if (
    startFill.kind === "linear-gradient" &&
    endFill.kind === "linear-gradient" &&
    canMorphGradientStops(startFill, endFill)
  ) {
    const startKeyframes = samples
      .map((sample, frame) => sample
        ? {
            frame,
            value: gradientStartPoint(interpolateGradientFill(startFill, endFill, sample.ratio ?? 0))
          }
        : null)
      .filter((value): value is { frame: number; value: [number, number] } => value !== null);
    const endKeyframes = samples
      .map((sample, frame) => sample
        ? {
            frame,
            value: gradientEndPoint(interpolateGradientFill(startFill, endFill, sample.ratio ?? 0))
          }
        : null)
      .filter((value): value is { frame: number; value: [number, number] } => value !== null);
    const gradientKeyframes = samples
      .map((sample, frame) => sample
        ? {
            frame,
            value: flattenGradientStops(interpolateGradientFill(startFill, endFill, sample.ratio ?? 0))
          }
        : null)
      .filter((value): value is { frame: number; value: number[] } => value !== null);

    return {
      ty: "gf",
      o: { a: 0, k: 100 },
      r: 1,
      s: exportVectorProperty(startKeyframes),
      e: exportVectorProperty(endKeyframes),
      t: 1,
      g: {
        p: startFill.stops.length,
        k: exportVectorProperty(gradientKeyframes)
      }
    };
  }

  if (
    startFill.kind === "radial-gradient" &&
    endFill.kind === "radial-gradient" &&
    canMorphGradientStops(startFill, endFill)
  ) {
    const startKeyframes = samples
      .map((sample, frame) => sample
        ? {
            frame,
            value: gradientCenterPoint(interpolateGradientFill(startFill, endFill, sample.ratio ?? 0))
          }
        : null)
      .filter((value): value is { frame: number; value: [number, number] } => value !== null);
    const endKeyframes = samples
      .map((sample, frame) => sample
        ? {
            frame,
            value: gradientRadiusPoint(interpolateGradientFill(startFill, endFill, sample.ratio ?? 0))
          }
        : null)
      .filter((value): value is { frame: number; value: [number, number] } => value !== null);
    const gradientKeyframes = samples
      .map((sample, frame) => sample
        ? {
            frame,
            value: flattenGradientStops(interpolateGradientFill(startFill, endFill, sample.ratio ?? 0))
          }
        : null)
      .filter((value): value is { frame: number; value: number[] } => value !== null);
    const highlightKeyframes = samples
      .map((sample, frame) => sample
        ? {
            frame,
            value: clamp((interpolateGradientFill(startFill, endFill, sample.ratio ?? 0).focalPoint ?? 0) * 100, -100, 100)
          }
        : null)
      .filter((value): value is { frame: number; value: number } => value !== null);

    return {
      ty: "gf",
      o: { a: 0, k: 100 },
      r: 1,
      s: exportVectorProperty(startKeyframes),
      e: exportVectorProperty(endKeyframes),
      t: 2,
      h: exportScalarProperty(highlightKeyframes),
      a: { a: 0, k: 0 },
      g: {
        p: startFill.stops.length,
        k: exportVectorProperty(gradientKeyframes)
      }
    };
  }

  issues.push({
    code: "unsupported_fill",
    severity: "warning",
    message: "Only compatible solid and gradient morph fills are exported right now."
  });
  return null;
}

function exportMorphStroke(
  path: FlashMorphShapePath,
  samples: Array<FlashDisplayObjectState | null>
): Record<string, unknown> | null {
  const startStroke = path.start.stroke;
  const endStroke = path.end.stroke;

  if (!startStroke || !endStroke || startStroke.kind !== "solid" || endStroke.kind !== "solid") {
    return null;
  }

  const colorKeyframes = samples
    .map((sample, frame) => sample
      ? { frame, value: interpolateColorVector(startStroke.color, endStroke.color, sample.ratio ?? 0) }
      : null)
    .filter((value): value is { frame: number; value: [number, number, number, number] } => value !== null);
  const opacityKeyframes = samples
    .map((sample, frame) => sample
      ? { frame, value: clamp(interpolateNumber(startStroke.alpha, endStroke.alpha, sample.ratio ?? 0) * 100, 0, 100) }
      : null)
    .filter((value): value is { frame: number; value: number } => value !== null);
  const widthKeyframes = samples
    .map((sample, frame) => sample
      ? { frame, value: interpolateNumber(startStroke.width, endStroke.width, sample.ratio ?? 0) }
      : null)
    .filter((value): value is { frame: number; value: number } => value !== null);

  return {
    ty: "st",
    c: exportVectorProperty(colorKeyframes),
    o: exportScalarProperty(opacityKeyframes),
    w: exportScalarProperty(widthKeyframes),
    lc: lineCapToLottie(startStroke.lineCap),
    lj: lineJoinToLottie(startStroke.lineJoin),
    ...(startStroke.miterLimit !== undefined ? { ml: startStroke.miterLimit } : {})
  };
}

function exportSolidStroke(stroke: FlashSolidStroke): Record<string, unknown> {
  return {
    ty: "st",
    c: { a: 0, k: colorVector(stroke.color) },
    o: { a: 0, k: clamp(stroke.alpha * 100, 0, 100) },
    w: { a: 0, k: stroke.width },
    lc: lineCapToLottie(stroke.lineCap),
    lj: lineJoinToLottie(stroke.lineJoin),
    ...(stroke.miterLimit !== undefined ? { ml: stroke.miterLimit } : {})
  };
}

function exportLinearGradientFill(
  fill: FlashGradientFill,
  transformSamples: TransformSample[] = [],
  sourceSamples?: Array<FlashDisplayObjectState | null>
): Record<string, unknown> {
  const baseStart = applyGradientMatrix(fill.matrix, -16384 / 20, 0);
  const baseEnd = applyGradientMatrix(fill.matrix, 16384 / 20, 0);
  const bakedSamples = sourceSamples
    ?.map((sample, frame) => sample
      ? { frame, value: transformLinearGradient(baseStart, baseEnd, sample.matrix) }
      : null)
    .filter((
      value
    ): value is { frame: number; value: { start: [number, number]; end: [number, number] } } => value !== null);
  const start = bakedSamples
    ? exportVectorProperty(bakedSamples.map((sample) => ({ frame: sample.frame, value: sample.value.start })))
    : exportGradientPointProperty(fill, -16384 / 20, 0, transformSamples, sourceSamples);
  const end = bakedSamples
    ? exportVectorProperty(bakedSamples.map((sample) => ({ frame: sample.frame, value: sample.value.end })))
    : exportGradientPointProperty(fill, 16384 / 20, 0, transformSamples, sourceSamples);

  return {
    ty: "gf",
    o: { a: 0, k: 100 },
    r: 1,
    s: start,
    e: end,
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

function exportRadialGradientFill(
  fill: FlashGradientFill,
  transformSamples: TransformSample[] = [],
  sourceSamples?: Array<FlashDisplayObjectState | null>
): Record<string, unknown> {
  const start = exportGradientPointProperty(fill, 0, 0, transformSamples, sourceSamples);
  const end = exportGradientPointProperty(fill, 16384 / 20, 0, transformSamples, sourceSamples);

  return {
    ty: "gf",
    o: { a: 0, k: 100 },
    r: 1,
    s: start,
    e: end,
    t: 2,
    h: { a: 0, k: clamp((fill.focalPoint ?? 0) * 100, -100, 100) },
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

function gradientStartPoint(fill: FlashGradientFill): [number, number] {
  return applyGradientMatrix(fill.matrix, -16384 / 20, 0);
}

function gradientEndPoint(fill: FlashGradientFill): [number, number] {
  return applyGradientMatrix(fill.matrix, 16384 / 20, 0);
}

function gradientCenterPoint(fill: FlashGradientFill): [number, number] {
  return applyGradientMatrix(fill.matrix, 0, 0);
}

function gradientRadiusPoint(fill: FlashGradientFill): [number, number] {
  return applyGradientMatrix(fill.matrix, 16384 / 20, 0);
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
  const compressed = compressScalarKeyframes(keyframes, 0.05);
  const uniqueValues = new Set(compressed.map((keyframe) => Math.round(keyframe.value * 1000)));
  if (uniqueValues.size <= 1) {
    return { a: 0, k: compressed[0]?.value ?? 0 };
  }

  return {
    a: 1,
    k: compressed.map((keyframe, index) => exportAnimatedScalarKeyframe(keyframe, compressed[index + 1]))
  };
}

function exportVectorProperty(
  keyframes: Array<{ frame: number; value: number[] }>
): Record<string, unknown> {
  const compressed = compressVectorKeyframes(keyframes, 0.05);
  const uniqueValues = new Set(compressed.map((keyframe) => keyframe.value.join(",")));
  if (uniqueValues.size <= 1) {
    return { a: 0, k: compressed[0]?.value ?? [0, 0, 0] };
  }

  return {
    a: 1,
    k: compressed.map((keyframe, index) => exportAnimatedVectorKeyframe(keyframe, compressed[index + 1]))
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

    if (child.kind === "shape" || child.kind === "morphshape") {
      return true;
    }

    if (child.kind !== "movieclip") {
      return false;
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

function transformLinearGradient(
  start: [number, number],
  end: [number, number],
  matrix: FlashDisplayObjectState["matrix"]
): { start: [number, number]; end: [number, number] } {
  const center: [number, number] = [
    (start[0] + end[0]) / 2,
    (start[1] + end[1]) / 2
  ];
  const halfDirection: [number, number] = [
    (end[0] - start[0]) / 2,
    (end[1] - start[1]) / 2
  ];
  const transformedCenter = applyMatrixToPoint(center, matrix);
  const transformedHalfDirection = applyInverseTransposeToVector(halfDirection, matrix);

  return {
    start: [
      transformedCenter[0] - transformedHalfDirection[0],
      transformedCenter[1] - transformedHalfDirection[1]
    ],
    end: [
      transformedCenter[0] + transformedHalfDirection[0],
      transformedCenter[1] + transformedHalfDirection[1]
    ]
  };
}

function exportGradientPointProperty(
  fill: FlashGradientFill,
  x: number,
  y: number,
  transformSamples: TransformSample[],
  sourceSamples?: Array<FlashDisplayObjectState | null>
): Record<string, unknown> {
  const basePoint = applyGradientMatrix(fill.matrix, x, y);
  const actualSamples = sourceSamples
    ?.map((sample, frame) => sample ? ({ frame, value: applyMatrixToPoint(basePoint, sample.matrix) }) : null)
    .filter((value): value is { frame: number; value: [number, number] } => value !== null);

  if (actualSamples && actualSamples.length > 0) {
    return exportVectorProperty(actualSamples);
  }

  return { a: 0, k: basePoint };
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

function applyInverseTransposeToVector(
  vector: [number, number],
  matrix: FlashDisplayObjectState["matrix"]
): [number, number] {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < 1e-8) {
    return applyMatrixToVector(vector, matrix);
  }

  return [
    (matrix.d * vector[0] - matrix.b * vector[1]) / determinant,
    (-matrix.c * vector[0] + matrix.a * vector[1]) / determinant
  ];
}

function matrixFromTransformSample(sample: TransformSample): FlashDisplayObjectState["matrix"] {
  const radians = (sample.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const scaleX = (sample.scale[0] ?? 100) / 100;
  const scaleY = (sample.scale[1] ?? 100) / 100;

  return {
    a: cos * scaleX,
    b: sin * scaleX,
    c: -sin * scaleY,
    d: cos * scaleY,
    tx: sample.position[0] ?? 0,
    ty: sample.position[1] ?? 0
  };
}

function applyPixelMatrixToPoint(
  point: [number, number],
  matrix: FlashDisplayObjectState["matrix"]
): [number, number] {
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.tx,
    matrix.b * point[0] + matrix.d * point[1] + matrix.ty
  ];
}

function canMorphGeometries(
  start: FlashShapePath["geometry"],
  end: FlashShapePath["geometry"]
): boolean {
  return start.closed === end.closed &&
    start.vertices.length === end.vertices.length &&
    start.inTangents.length === end.inTangents.length &&
    start.outTangents.length === end.outTangents.length;
}

function prepareMorphGeometryPair(
  start: FlashShapePath["geometry"],
  end: FlashShapePath["geometry"]
): [FlashShapePath["geometry"], FlashShapePath["geometry"]] {
  const normalizedStart = normalizeMorphGeometry(start);
  const normalizedEnd = normalizeMorphGeometry(end);

  if (!canMorphGeometries(normalizedStart, normalizedEnd)) {
    return [normalizedStart, normalizedEnd];
  }

  return [normalizedStart, alignMorphGeometry(normalizedStart, normalizedEnd)];
}

function normalizeMorphGeometry(geometry: FlashShapePath["geometry"]): FlashShapePath["geometry"] {
  if (!geometry.closed || geometry.vertices.length % 2 !== 0) {
    return geometry;
  }

  const half = geometry.vertices.length / 2;
  const repeatedVertices = geometry.vertices.slice(0, half).every((point, index) =>
    pointsApproximatelyEqual(point, geometry.vertices[index + half] ?? point)
  );
  const repeatedInTangents = geometry.inTangents.slice(0, half).every((point, index) =>
    pointsApproximatelyEqual(point, geometry.inTangents[index + half] ?? point)
  );
  const repeatedOutTangents = geometry.outTangents.slice(0, half).every((point, index) =>
    pointsApproximatelyEqual(point, geometry.outTangents[index + half] ?? point)
  );

  if (!repeatedVertices || !repeatedInTangents || !repeatedOutTangents) {
    return geometry;
  }

  return {
    closed: geometry.closed,
    vertices: geometry.vertices.slice(0, half),
    inTangents: geometry.inTangents.slice(0, half),
    outTangents: geometry.outTangents.slice(0, half)
  };
}

function interpolateGeometry(
  start: FlashShapePath["geometry"],
  end: FlashShapePath["geometry"],
  ratio: number
): FlashShapePath["geometry"] {
  return {
    closed: start.closed,
    vertices: start.vertices.map((point, index) => interpolatePoint(point, end.vertices[index] ?? point, ratio)),
    inTangents: start.inTangents.map((point, index) => interpolatePoint(point, end.inTangents[index] ?? point, ratio)),
    outTangents: start.outTangents.map((point, index) => interpolatePoint(point, end.outTangents[index] ?? point, ratio))
  };
}

function interpolateMorphPath(path: FlashMorphShapePath, ratio: number): FlashShapePath {
  const fill = interpolateMorphFill(path.start.fill, path.end.fill, ratio);
  const stroke = interpolateMorphStroke(path.start.stroke, path.end.stroke, ratio);
  const [startGeometry, endGeometry] = prepareMorphGeometryPair(path.start.geometry, path.end.geometry);

  return {
    closed: path.start.closed,
    commands: path.start.commands,
    geometry: canMorphGeometries(startGeometry, endGeometry)
      ? interpolateGeometry(startGeometry, endGeometry, ratio)
      : startGeometry,
    ...(fill !== undefined ? { fill } : {}),
    ...(stroke !== undefined ? { stroke } : {})
  };
}

function interpolateMorphFill(
  startFill: FlashShapePath["fill"],
  endFill: FlashShapePath["fill"],
  ratio: number
): FlashShapePath["fill"] | undefined {
  if (!startFill || !endFill) {
    return startFill ?? endFill;
  }

  if (startFill.kind === "solid" && endFill.kind === "solid") {
    return {
      kind: "solid",
      color: rgbToHexVector(interpolateColorVector(startFill.color, endFill.color, ratio)),
      alpha: interpolateNumber(startFill.alpha, endFill.alpha, ratio)
    };
  }

  if (
    startFill.kind !== "solid" &&
    endFill.kind !== "solid" &&
    startFill.kind === endFill.kind &&
    canMorphGradientStops(startFill, endFill)
  ) {
    return interpolateGradientFill(startFill, endFill, ratio);
  }

  return startFill;
}

function canMorphGradientStops(startFill: FlashGradientFill, endFill: FlashGradientFill): boolean {
  return startFill.stops.length === endFill.stops.length;
}

function interpolateGradientFill(
  startFill: FlashGradientFill,
  endFill: FlashGradientFill,
  ratio: number
): FlashGradientFill {
  return {
    kind: startFill.kind,
    matrix: {
      a: interpolateNumber(startFill.matrix.a, endFill.matrix.a, ratio),
      b: interpolateNumber(startFill.matrix.b, endFill.matrix.b, ratio),
      c: interpolateNumber(startFill.matrix.c, endFill.matrix.c, ratio),
      d: interpolateNumber(startFill.matrix.d, endFill.matrix.d, ratio),
      tx: interpolateNumber(startFill.matrix.tx, endFill.matrix.tx, ratio),
      ty: interpolateNumber(startFill.matrix.ty, endFill.matrix.ty, ratio)
    },
    stops: startFill.stops.map((startStop, index) => {
      const endStop = endFill.stops[index] ?? startStop;
      return {
        offset: interpolateNumber(startStop.offset, endStop.offset, ratio),
        color: rgbToHexVector(interpolateColorVector(startStop.color, endStop.color, ratio)),
        alpha: interpolateNumber(startStop.alpha, endStop.alpha, ratio)
      };
    }),
    ...(
      startFill.kind === "radial-gradient" || endFill.kind === "radial-gradient"
        ? {
            focalPoint: interpolateNumber(startFill.focalPoint ?? 0, endFill.focalPoint ?? 0, ratio)
          }
        : {}
    )
  };
}

function interpolateMorphStroke(
  startStroke: FlashShapePath["stroke"],
  endStroke: FlashShapePath["stroke"],
  ratio: number
): FlashShapePath["stroke"] | undefined {
  if (!startStroke || !endStroke || startStroke.kind !== "solid" || endStroke.kind !== "solid") {
    return startStroke ?? endStroke;
  }

  return {
    kind: "solid",
    width: interpolateNumber(startStroke.width, endStroke.width, ratio),
    color: rgbToHexVector(interpolateColorVector(startStroke.color, endStroke.color, ratio)),
    alpha: interpolateNumber(startStroke.alpha, endStroke.alpha, ratio),
    ...(startStroke.lineCap ? { lineCap: startStroke.lineCap } : {}),
    ...(startStroke.lineJoin ? { lineJoin: startStroke.lineJoin } : {}),
    ...(startStroke.miterLimit !== undefined ? { miterLimit: startStroke.miterLimit } : {})
  };
}

function interpolatePoint(
  start: [number, number],
  end: [number, number],
  ratio: number
): [number, number] {
  return [
    interpolateNumber(start[0], end[0], ratio),
    interpolateNumber(start[1], end[1], ratio)
  ];
}

function pointsApproximatelyEqual(
  left: [number, number],
  right: [number, number],
  epsilon = 1e-4
): boolean {
  return approximatelyEqual(left[0], right[0], epsilon) && approximatelyEqual(left[1], right[1], epsilon);
}

function alignMorphGeometry(
  start: FlashShapePath["geometry"],
  end: FlashShapePath["geometry"]
): FlashShapePath["geometry"] {
  const direct = bestShiftedGeometry(start, end);
  const reversed = bestShiftedGeometry(start, reverseGeometry(end));

  return geometryDistanceScore(start, direct) <= geometryDistanceScore(start, reversed)
    ? direct
    : reversed;
}

function bestShiftedGeometry(
  start: FlashShapePath["geometry"],
  end: FlashShapePath["geometry"]
): FlashShapePath["geometry"] {
  let best = end;
  let bestScore = geometryDistanceScore(start, end);

  for (let shift = 1; shift < end.vertices.length; shift += 1) {
    const candidate = shiftGeometry(end, shift);
    const score = geometryDistanceScore(start, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function shiftGeometry(
  geometry: FlashShapePath["geometry"],
  shift: number
): FlashShapePath["geometry"] {
  return {
    closed: geometry.closed,
    vertices: rotateArray(geometry.vertices, shift),
    inTangents: rotateArray(geometry.inTangents, shift),
    outTangents: rotateArray(geometry.outTangents, shift)
  };
}

function reverseGeometry(geometry: FlashShapePath["geometry"]): FlashShapePath["geometry"] {
  return {
    closed: geometry.closed,
    vertices: [...geometry.vertices].reverse(),
    inTangents: [...geometry.outTangents].reverse().map(([x, y]) => ([-x, -y] as [number, number])),
    outTangents: [...geometry.inTangents].reverse().map(([x, y]) => ([-x, -y] as [number, number]))
  };
}

function geometryDistanceScore(
  start: FlashShapePath["geometry"],
  end: FlashShapePath["geometry"]
): number {
  return start.vertices.reduce((sum, point, index) => {
    const target = end.vertices[index] ?? point;
    const dx = point[0] - target[0];
    const dy = point[1] - target[1];
    return sum + dx * dx + dy * dy;
  }, 0);
}

function rotateArray<T>(values: T[], shift: number): T[] {
  const offset = ((shift % values.length) + values.length) % values.length;
  return values.slice(offset).concat(values.slice(0, offset));
}

function interpolateNumber(start: number, end: number, ratio: number): number {
  return start + (end - start) * ratio;
}

function interpolateColorVector(
  startHex: string,
  endHex: string,
  ratio: number
): [number, number, number, number] {
  const start = colorVector(startHex);
  const end = colorVector(endHex);
  return [
    interpolateNumber(start[0], end[0], ratio),
    interpolateNumber(start[1], end[1], ratio),
    interpolateNumber(start[2], end[2], ratio),
    1
  ];
}

function rgbToHexVector(color: [number, number, number, number]): string {
  return rgbToHex(color[0] * 255, color[1] * 255, color[2] * 255);
}

function mod(value: number, length: number): number {
  return ((value % length) + length) % length;
}

function firstMaskLayerId(samples: Array<FlashDisplayObjectState | null>): string | undefined {
  const ids = new Set(
    samples
      .map((sample) => sample?.maskLayerId)
      .filter((value): value is string => Boolean(value))
  );

  if (ids.size === 0) {
    return undefined;
  }

  return ids.values().next().value;
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
  const compressed = compressVectorKeyframes(keyframes, 1 / 1024);
  const uniqueValues = new Set(compressed.map((keyframe) => keyframe.value.join(",")));

  if (uniqueValues.size <= 1) {
    return { a: 0, k: compressed[0]?.value ?? colorVector(fill.color) };
  }

  return {
    a: 1,
    k: compressed.map((keyframe, index) => exportAnimatedVectorKeyframe(keyframe, compressed[index + 1]))
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

function lineCapToLottie(lineCap: FlashSolidStroke["lineCap"]): number {
  if (lineCap === "butt") {
    return 1;
  }

  if (lineCap === "square") {
    return 3;
  }

  return 2;
}

function lineJoinToLottie(lineJoin: FlashSolidStroke["lineJoin"]): number {
  if (lineJoin === "bevel") {
    return 3;
  }

  if (lineJoin === "miter") {
    return 1;
  }

  return 2;
}

function sortShapeGroups(groups: Record<string, unknown>[]): Record<string, unknown>[] {
  return groups.slice().sort((left, right) => shapeGroupPriority(left) - shapeGroupPriority(right));
}

function shapeGroupPriority(group: Record<string, unknown>): number {
  const items = Array.isArray(group.it) ? group.it as Array<Record<string, unknown>> : [];
  const hasStroke = items.some((item) => item.ty === "st");
  const hasFill = items.some((item) => item.ty === "fl" || item.ty === "gf");

  if (hasStroke && !hasFill) {
    return 0;
  }

  if (hasStroke && hasFill) {
    return 1;
  }

  return 2;
}

function minimumOutPoint(outPoint: number, inPoint = 0): number {
  return Math.max(outPoint, inPoint + 2);
}

function compressScalarKeyframes(keyframes: ScalarKeySample[], epsilon: number): ScalarKeySample[] {
  return compressKeyframes(keyframes, (left, right) => approximatelyEqual(left, right, epsilon));
}

function compressVectorKeyframes(keyframes: VectorKeySample[], epsilon: number): VectorKeySample[] {
  return compressKeyframes(keyframes, (left, right) => arraysApproximatelyEqual(left, right, epsilon));
}

function compressKeyframes<T extends ScalarKeySample | VectorKeySample>(
  keyframes: T[],
  valuesEqual: (left: T["value"], right: T["value"]) => boolean
): T[] {
  if (keyframes.length <= 2) {
    return keyframes;
  }

  const compressed: T[] = [keyframes[0] as T];

  for (let index = 1; index < keyframes.length - 1; index += 1) {
    const previous = compressed[compressed.length - 1];
    const current = keyframes[index];
    const next = keyframes[index + 1];

    if (
      previous &&
      current &&
      next &&
      isRedundantLinearSample(previous, current, next, valuesEqual)
    ) {
      continue;
    }

    compressed.push(current as T);
  }

  compressed.push(keyframes[keyframes.length - 1] as T);
  return compressed;
}

function isRedundantLinearSample<T extends ScalarKeySample | VectorKeySample>(
  previous: T,
  current: T,
  next: T,
  valuesEqual: (left: T["value"], right: T["value"]) => boolean
): boolean {
  const frameSpan = next.frame - previous.frame;
  if (frameSpan <= 0) {
    return false;
  }

  const ratio = (current.frame - previous.frame) / frameSpan;
  if (ratio <= 0 || ratio >= 1) {
    return false;
  }

  const expected = interpolateValue(previous.value, next.value, ratio) as T["value"];
  return valuesEqual(current.value, expected);
}

function interpolateValue(left: number | number[], right: number | number[], ratio: number): number | number[] {
  if (typeof left === "number" && typeof right === "number") {
    return left + (right - left) * ratio;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.map((value, index) => value + ((right[index] ?? value) - value) * ratio);
  }

  return left;
}

function exportAnimatedScalarKeyframe(
  keyframe: ScalarKeySample,
  next: ScalarKeySample | undefined
): Record<string, unknown> {
  if (!next) {
    return {
      t: keyframe.frame,
      s: [keyframe.value]
    };
  }

  return {
    t: keyframe.frame,
    s: [keyframe.value],
    e: [next.value],
    i: {
      x: [1],
      y: [1]
    },
    o: {
      x: [0],
      y: [0]
    }
  };
}

function exportAnimatedVectorKeyframe(
  keyframe: VectorKeySample,
  next: VectorKeySample | undefined
): Record<string, unknown> {
  if (!next) {
    return {
      t: keyframe.frame,
      s: keyframe.value
    };
  }

  const dimensions = keyframe.value.length;
  return {
    t: keyframe.frame,
    s: keyframe.value,
    e: next.value,
    i: {
      x: Array.from({ length: dimensions }, () => 1),
      y: Array.from({ length: dimensions }, () => 1)
    },
    o: {
      x: Array.from({ length: dimensions }, () => 0),
      y: Array.from({ length: dimensions }, () => 0)
    }
  };
}

function arraysApproximatelyEqual(left: number[], right: number[], epsilon: number): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => approximatelyEqual(value, right[index] ?? Number.NaN, epsilon));
}

function approximatelyEqual(left: number, right: number, epsilon = 1e-4): boolean {
  return Math.abs(left - right) <= epsilon;
}

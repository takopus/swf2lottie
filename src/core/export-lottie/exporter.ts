import type {
  FlashBitmapSymbol,
  FlashColorTransform,
  FlashDisplayObjectState,
  FlashDocument,
  FlashGradientFill,
  FlashGradientStroke,
  FlashMorphShapePath,
  FlashMovieClipSymbol,
  FlashShapePath,
  FlashShapeSymbol,
  FlashSolidFill,
  FlashSolidStroke,
  FlashTimeline
} from "../ir/index.js";
import type { ConversionIssue } from "../issues.js";
import type {
  BitmapAssetMode,
  ExportedBitmapAsset,
  LottieExportOptions,
  LottieExportResult
} from "./types.js";

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
  skew: number;
  skewAxis: number;
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

interface MorphShapeStyleGroup {
  index: number;
  fillPath?: FlashMorphShapePath;
  strokePath?: FlashMorphShapePath;
  paths: FlashMorphShapePath[];
}

interface LayerExportSpec {
  name: string;
  kind: "shape" | "bitmap";
  index: number;
  shapes?: Record<string, unknown>[];
  bitmapSymbol?: FlashBitmapSymbol;
  bitmapFill?: Extract<FlashShapePath["fill"], { kind: "bitmap" }>;
  transformSamples?: TransformSample[];
  hasUnsupportedBitmapColor?: boolean;
  clipMasks?: Record<string, unknown>[];
}

interface PixelMatrix2d {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

type FlashSymbolMap = Map<string, FlashDocument["symbols"][number]>;

export function exportToLottie(document: FlashDocument, options: LottieExportOptions = {}): {
  result: LottieExportResult;
  issues: ConversionIssue[];
} {
  const issues: ConversionIssue[] = [];
  const symbolMap: FlashSymbolMap = new Map(document.symbols.map((symbol) => [symbol.id, symbol]));
  const bitmapAssets: Record<string, unknown>[] = [];
  const exportedBitmapAssets: ExportedBitmapAsset[] = [];
  const bitmapAssetIds = new Map<string, string>();
  const bitmapAssetMode = options.bitmapAssetMode ?? "inline";
  const bitmapAssetBasePath = normalizeBitmapAssetBasePath(options.bitmapAssetBasePath ?? "");
  const root = symbolMap.get(document.rootTimelineId);

  if (!root || root.kind !== "movieclip") {
    return {
      result: { animation: null, bitmapAssets: [] },
      issues: [
        {
          code: "unsupported_feature",
          severity: "error",
          message: "Root timeline is missing or is not a movieclip."
        }
      ]
    };
  }

  const layers = exportTimelineLayers(
    root.timeline,
    document,
    symbolMap,
    bitmapAssets,
    exportedBitmapAssets,
    bitmapAssetIds,
    issues,
    bitmapAssetMode,
    bitmapAssetBasePath
  );

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
            assets: bitmapAssets,
            layers
          }
        : null,
      bitmapAssets: exportedBitmapAssets
    },
    issues
  };
}

function exportMovieClipAsset(
  symbol: FlashMovieClipSymbol,
  document: FlashDocument,
  symbolMap: FlashSymbolMap,
  bitmapAssets: Record<string, unknown>[],
  exportedBitmapAssets: ExportedBitmapAsset[],
  bitmapAssetIds: Map<string, string>,
  issues: ConversionIssue[],
  bitmapAssetMode: BitmapAssetMode,
  bitmapAssetBasePath: string
): Record<string, unknown> {
  return {
    id: `asset:${symbol.id}`,
    nm: symbol.id,
    fr: document.frameRate,
    w: document.width,
    h: document.height,
    layers: exportTimelineLayers(
      symbol.timeline,
      document,
      symbolMap,
      bitmapAssets,
      exportedBitmapAssets,
      bitmapAssetIds,
      issues,
      bitmapAssetMode,
      bitmapAssetBasePath
    )
  };
}

function exportTimelineLayers(
  timeline: FlashTimeline,
  document: FlashDocument,
  symbolMap: FlashSymbolMap,
  bitmapAssets: Record<string, unknown>[],
  exportedBitmapAssets: ExportedBitmapAsset[],
  bitmapAssetIds: Map<string, string>,
  issues: ConversionIssue[],
  bitmapAssetMode: BitmapAssetMode,
  bitmapAssetBasePath: string
): Record<string, unknown>[] {
  const tracks = buildTimelineTracks(timeline);
  const trackMap = new Map(tracks.map((track) => [track.id, track]));

  const layers = tracks
    .sort((left, right) => right.depth - left.depth)
    .flatMap((track) => exportTrack(
      track,
      trackMap,
      timeline,
      document,
      symbolMap,
      bitmapAssets,
      exportedBitmapAssets,
      bitmapAssetIds,
      issues,
      bitmapAssetMode,
      bitmapAssetBasePath
    ));

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
  bitmapAssets: Record<string, unknown>[],
  exportedBitmapAssets: ExportedBitmapAsset[],
  bitmapAssetIds: Map<string, string>,
  issues: ConversionIssue[],
  bitmapAssetMode: BitmapAssetMode,
  bitmapAssetBasePath: string
): Record<string, unknown>[] {
  if (track.samples.some((sample) => sample?.isMask)) {
    return [];
  }

  const splitTracks = splitTrackBySymbolChanges(track);
  if (splitTracks.length > 1) {
    return splitTracks.flatMap((splitTrack) => exportTrack(
      splitTrack,
      trackMap,
      timeline,
      document,
      symbolMap,
      bitmapAssets,
      exportedBitmapAssets,
      bitmapAssetIds,
      issues,
      bitmapAssetMode,
      bitmapAssetBasePath
    ));
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
    if (symbol.paths.some((path) => path.fill?.kind === "bitmap")) {
      return exportShapeTrackWithBitmapFills(
        track,
        symbol,
        timeline,
        baseLayer,
        transformSamples,
        track.samples,
        shouldBakeLayerTransform,
        symbolMap,
        bitmapAssets,
        exportedBitmapAssets,
        bitmapAssetIds,
        maskProperties,
        issues,
        bitmapAssetMode,
        bitmapAssetBasePath
      );
    }

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
          scale: [100, 100, 100] as [number, number, number],
          skew: 0,
          skewAxis: 0
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

  if (symbol.kind === "bitmap") {
    const assetId = ensureBitmapAsset(
      symbol,
      bitmapAssets,
      exportedBitmapAssets,
      bitmapAssetIds,
      bitmapAssetMode,
      bitmapAssetBasePath
    );
    const hasUnsupportedColor = transformSamples.some((sample) =>
      sample.colorTransform.tint !== undefined || sample.colorTransform.brightness !== undefined
    );

    if (symbol.hasSeparateAlpha) {
      issues.push({
        code: "unsupported_feature",
        severity: "warning",
        message: "Bitmap assets with separate alpha data are exported without alpha reconstruction.",
        path: track.id,
        details: { symbolId: symbol.id }
      });
    }

    if (hasUnsupportedColor) {
      issues.push({
        code: "unsupported_color_transform",
        severity: "warning",
        message: "Bitmap tint and brightness are not exported yet. Only alpha is applied.",
        path: track.id,
        details: { symbolId: symbol.id }
      });
    }

    return [
      {
        ...baseLayer,
        ty: 2,
        refId: assetId,
        w: symbol.width,
        h: symbol.height
      }
    ];
  }

  if (symbol.kind === "morphshape") {
    const proxySolidFillLayer = exportMorphProxySolidFillLayer(track, timeline, symbol, baseLayer, transformSamples, shouldBakeLayerTransform, symbolMap);
    if (proxySolidFillLayer) {
      return [
        {
          ...proxySolidFillLayer,
          ...(maskProperties.length > 0 ? { hasMask: true, masksProperties: maskProperties } : {})
        }
      ];
    }

    const staticProxySuccessor = findStaticMorphSuccessorShape(track, timeline, symbolMap);
    if (
      staticProxySuccessor &&
      morphStylesAreStatic(symbol) &&
      symbol.paths.some((path) => path.start.stroke || path.end.stroke)
    ) {
      const shapes = sortShapeGroups(
        exportStaticMorphProxyShapes(
          symbol,
          staticProxySuccessor.paths,
          issues,
          transformSamples,
          shouldBakeLayerTransform ? track.samples : undefined,
          track.samples,
          hasImmediateStaticMorphSuccessor(track, timeline, staticProxySuccessor.id)
        )
      );
      if (shapes.length > 0) {
        const layerTransformSamples = shouldBakeLayerTransform
          ? transformSamples.map((sample) => ({
              ...sample,
              position: [0, 0, 0] as [number, number, number],
              rotation: 0,
              scale: [100, 100, 100] as [number, number, number],
              skew: 0,
              skewAxis: 0
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
    }

    const staticSolidSuccessor = findStaticMorphSuccessorShape(track, timeline, symbolMap);
    if (staticSolidSuccessor && shapeUsesOnlySolidStyles(staticSolidSuccessor)) {
      const shapes = sortShapeGroups(
        exportStaticMorphProxyShapes(
          symbol,
          staticSolidSuccessor.paths,
          issues,
          transformSamples,
          shouldBakeLayerTransform ? track.samples : undefined,
          track.samples,
          hasImmediateStaticMorphSuccessor(track, timeline, staticSolidSuccessor.id)
        )
      );
      if (shapes.length > 0) {
        const layerTransformSamples = shouldBakeLayerTransform
          ? transformSamples.map((sample) => ({
              ...sample,
              position: [0, 0, 0] as [number, number, number],
              rotation: 0,
              scale: [100, 100, 100] as [number, number, number],
              skew: 0,
              skewAxis: 0
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
    }

    const staticProxyShape = findStaticMorphProxyShape(track, timeline, symbol, symbolMap);
    if (staticProxyShape) {
      const shapes = sortShapeGroups(
        exportStaticMorphProxyShapes(
          symbol,
          staticProxyShape.paths,
          issues,
          transformSamples,
          shouldBakeLayerTransform ? track.samples : undefined,
          track.samples,
          false
        )
      );
      if (shapes.length > 0) {
        const layerTransformSamples = shouldBakeLayerTransform
          ? transformSamples.map((sample) => ({
              ...sample,
              position: [0, 0, 0] as [number, number, number],
              rotation: 0,
              scale: [100, 100, 100] as [number, number, number],
              skew: 0,
              skewAxis: 0
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
    }

    const shapes = sortShapeGroups(exportMorphShapePaths(symbol.paths, track.samples, issues));
    if (shapes.length === 0) {
      return [];
    }

    const layerTransformSamples = shouldBakeLayerTransform
      ? transformSamples.map((sample) => ({
          ...sample,
          position: [0, 0, 0] as [number, number, number],
          rotation: 0,
          scale: [100, 100, 100] as [number, number, number],
          skew: 0,
          skewAxis: 0
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
      return exportStaticMovieClipLayers(
        track,
        symbol,
        timeline,
        document,
        symbolMap,
        bitmapAssets,
        exportedBitmapAssets,
        bitmapAssetIds,
        issues,
        bitmapAssetMode,
        bitmapAssetBasePath
      );
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

function exportMorphProxySolidFillLayer(
  track: TimelineTrack,
  timeline: FlashTimeline,
  symbol: Extract<FlashDocument["symbols"][number], { kind: "morphshape" }>,
  baseLayer: Record<string, unknown>,
  transformSamples: TransformSample[],
  shouldBakeLayerTransform: boolean,
  symbolMap: FlashSymbolMap
): Record<string, unknown> | null {
  const successor = findStaticMorphProxyShape(track, timeline, symbol, symbolMap);
  if (!successor) {
    return null;
  }

  const morphSolidFillPaths = symbol.paths.filter((path) => path.start.fill?.kind === "solid" && path.end.fill?.kind === "solid");
  const successorSolidFillPaths = successor.paths.filter((path) => path.fill?.kind === "solid");

  if (morphSolidFillPaths.length !== 1 || successorSolidFillPaths.length !== 1) {
    return null;
  }

  const morphFillPath = morphSolidFillPaths[0];
  const successorFillPath = successorSolidFillPaths[0];
  const startFill = morphFillPath?.start.fill?.kind === "solid" ? morphFillPath.start.fill : null;
  const endFill = morphFillPath?.end.fill?.kind === "solid" ? morphFillPath.end.fill : null;
  const successorFill = successorFillPath?.fill?.kind === "solid" ? successorFillPath.fill : null;
  if (!morphFillPath || !successorFillPath || !startFill || !endFill || !successorFill) {
    return null;
  }

  const shapeItems: Record<string, unknown>[] = [
    exportLottieBezier(successorFillPath),
    {
      ty: "fl",
      c: exportVectorProperty(track.samples
        .map((sample, frame) => sample
          ? {
              frame,
              value: interpolateColorVector(
                startFill.color,
                endFill.color,
                sample.ratio ?? 0
              )
            }
          : null)
        .filter((value): value is { frame: number; value: [number, number, number, number] } => value !== null)),
      o: exportScalarProperty(track.samples
        .map((sample, frame) => sample
          ? {
              frame,
              value: clamp(interpolateNumber(
                startFill.alpha,
                endFill.alpha,
                sample.ratio ?? 0
              ) * 100, 0, 100)
            }
          : null)
        .filter((value): value is { frame: number; value: number } => value !== null)),
      r: 1
    },
    exportGroupTransform()
  ];

  const layerTransformSamples = shouldBakeLayerTransform
    ? transformSamples.map((sample) => ({
        ...sample,
        position: [0, 0, 0] as [number, number, number],
        rotation: 0,
        scale: [100, 100, 100] as [number, number, number],
        skew: 0,
        skewAxis: 0
      }))
    : transformSamples;

  return {
    ...baseLayer,
    ks: exportTransformSamples(layerTransformSamples),
    ty: 4,
    shapes: [
      {
        ty: "gr",
        it: shapeItems
      }
    ]
  };
}

function findStaticMorphProxyShape(
  track: TimelineTrack,
  timeline: FlashTimeline,
  symbol: Extract<FlashDocument["symbols"][number], { kind: "morphshape" }>,
  symbolMap: FlashSymbolMap
): FlashShapeSymbol | null {
  if (!morphHasProxySolidFills(symbol)) {
    return null;
  }

  const currentSample = track.samples[track.lastFrame];
  if (!currentSample) {
    return null;
  }

  const successorSymbol = findStaticMorphSuccessorShape(track, timeline, symbolMap);
  if (!successorSymbol) {
    return null;
  }

  return shapeHasCompatibleStaticMorphGeometry(successorSymbol, symbol) ? successorSymbol : null;
}

function shapeUsesOnlySolidStyles(shape: FlashShapeSymbol): boolean {
  return shape.paths.every((path) =>
    (!path.fill || path.fill.kind === "solid") &&
    (!path.stroke || path.stroke.kind === "solid")
  );
}

function findStaticMorphSuccessorShape(
  track: TimelineTrack,
  timeline: FlashTimeline,
  symbolMap: FlashSymbolMap
): FlashShapeSymbol | null {
  const currentSample = track.samples[track.lastFrame];
  if (!currentSample) {
    return null;
  }

  for (let frameIndex = track.lastFrame + 1; frameIndex < timeline.frames.length; frameIndex += 1) {
    const frame = timeline.frames[frameIndex];
    const successor = frame?.displayList.find((instance) => instance.depth === currentSample.depth);
    if (!successor) {
      continue;
    }

    const successorSymbol = symbolMap.get(successor.symbolId);
    if (!successorSymbol) {
      return null;
    }

    if (successorSymbol.kind === "morphshape") {
      continue;
    }

    if (successorSymbol.kind !== "shape") {
      return null;
    }

    return successorSymbol;
  }

  for (let frameIndex = track.lastFrame + 1; frameIndex < timeline.frames.length; frameIndex += 1) {
    const frame = timeline.frames[frameIndex];
    if (!frame || frame.displayList.length === 0) {
      continue;
    }

    const shapeSymbols = frame.displayList
      .map((instance) => symbolMap.get(instance.symbolId))
      .filter((symbol): symbol is FlashShapeSymbol => symbol?.kind === "shape");

    if (shapeSymbols.length === 1) {
      return shapeSymbols[0] ?? null;
    }

    if (shapeSymbols.length > 1) {
      return null;
    }
  }

  return null;
}

function morphHasProxySolidFills(
  symbol: Extract<FlashDocument["symbols"][number], { kind: "morphshape" }>
): boolean {
  const fillPaths = symbol.paths.filter((path) => path.start.fill || path.end.fill);
  return fillPaths.length > 0 && fillPaths.every((path) =>
    path.start.fill?.kind === "solid" &&
    path.end.fill?.kind === "solid"
  );
}

function morphStylesAreStatic(
  symbol: Extract<FlashDocument["symbols"][number], { kind: "morphshape" }>
): boolean {
  return symbol.paths.every((path) => {
    const fillStable = fillsEqual(path.start.fill, path.end.fill);
    const strokeStable = strokesEqual(path.start.stroke, path.end.stroke);
    return fillStable && strokeStable;
  });
}

function fillsEqual(left: FlashShapePath["fill"], right: FlashShapePath["fill"]): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "solid" && right.kind === "solid") {
    return left.color === right.color && approximatelyEqual(left.alpha, right.alpha);
  }

  if ((left.kind === "linear-gradient" || left.kind === "radial-gradient") &&
      (right.kind === "linear-gradient" || right.kind === "radial-gradient")) {
    return left.kind === right.kind &&
      gradientStopsEqual(left.stops, right.stops) &&
      matrixEqual(left.matrix, right.matrix) &&
      approximatelyEqual(left.focalPoint ?? 0, right.focalPoint ?? 0);
  }

  if (left.kind === "bitmap" && right.kind === "bitmap") {
    return left.bitmapId === right.bitmapId &&
      left.repeat === right.repeat &&
      left.smoothed === right.smoothed &&
      matrixEqual(left.matrix, right.matrix);
  }

  return false;
}

function strokesEqual(left: FlashShapePath["stroke"], right: FlashShapePath["stroke"]): boolean {
  if (!left && !right) {
    return true;
  }

  if (!left || !right || left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "solid" && right.kind === "solid") {
    return left.color === right.color &&
      approximatelyEqual(left.alpha, right.alpha) &&
      approximatelyEqual(left.width, right.width) &&
      left.lineCap === right.lineCap &&
      left.lineJoin === right.lineJoin &&
      approximatelyEqual(left.miterLimit ?? 3, right.miterLimit ?? 3);
  }

  if ((left.kind === "linear-gradient" || left.kind === "radial-gradient") &&
      (right.kind === "linear-gradient" || right.kind === "radial-gradient")) {
    return left.kind === right.kind &&
      approximatelyEqual(left.width, right.width) &&
      left.lineCap === right.lineCap &&
      left.lineJoin === right.lineJoin &&
      approximatelyEqual(left.miterLimit ?? 3, right.miterLimit ?? 3) &&
      gradientStopsEqual(left.stops, right.stops) &&
      matrixEqual(left.matrix, right.matrix) &&
      approximatelyEqual(left.focalPoint ?? 0, right.focalPoint ?? 0);
  }

  if (left.kind === "bitmap" && right.kind === "bitmap") {
    return left.bitmapId === right.bitmapId &&
      left.repeat === right.repeat &&
      left.smoothed === right.smoothed &&
      approximatelyEqual(left.width, right.width) &&
      left.lineCap === right.lineCap &&
      left.lineJoin === right.lineJoin &&
      approximatelyEqual(left.miterLimit ?? 3, right.miterLimit ?? 3) &&
      matrixEqual(left.matrix, right.matrix);
  }

  return false;
}

function gradientStopsEqual(
  left: Array<{ offset: number; color: string; alpha: number }>,
  right: Array<{ offset: number; color: string; alpha: number }>
): boolean {
  return left.length === right.length && left.every((stop, index) => {
    const other = right[index];
    return other &&
      approximatelyEqual(stop.offset, other.offset) &&
      stop.color === other.color &&
      approximatelyEqual(stop.alpha, other.alpha);
  });
}

function matrixEqual(
  left: { a: number; b: number; c: number; d: number; tx: number; ty: number },
  right: { a: number; b: number; c: number; d: number; tx: number; ty: number }
): boolean {
  return approximatelyEqual(left.a, right.a) &&
    approximatelyEqual(left.b, right.b) &&
    approximatelyEqual(left.c, right.c) &&
    approximatelyEqual(left.d, right.d) &&
    approximatelyEqual(left.tx, right.tx) &&
    approximatelyEqual(left.ty, right.ty);
}

function shapeHasCompatibleStaticMorphGeometry(
  shape: FlashShapeSymbol,
  morph: Extract<FlashDocument["symbols"][number], { kind: "morphshape" }>
): boolean {
  if (shape.paths.some((path) => path.fill && path.fill.kind !== "solid")) {
    return false;
  }

  const shapeSolidGroups = groupPathsByStyle(shape.paths.filter((path) => path.fill?.kind === "solid"));
  const morphSolidGroups = groupMorphPathsByStyle(morph.paths.filter((path) => path.start.fill?.kind === "solid"));

  return shapeSolidGroups.length > 0 && shapeSolidGroups.length >= morphSolidGroups.length;
}

function splitTrackBySymbolChanges(track: TimelineTrack): TimelineTrack[] {
  const segments: TimelineTrack[] = [];
  let segmentStart = -1;
  let segmentSymbolId: string | null = null;
  let segmentIndex = 0;

  const flush = (endIndex: number): void => {
    if (segmentStart === -1 || !segmentSymbolId) {
      return;
    }

    const samples = Array.from({ length: track.samples.length }, (_, index) =>
      index >= segmentStart && index <= endIndex ? (track.samples[index] ?? null) : null
    );
    segments.push({
      ...track,
      id: `${track.id}:segment:${segmentIndex}`,
      symbolId: segmentSymbolId,
      firstFrame: segmentStart,
      lastFrame: endIndex,
      samples
    });
    segmentIndex += 1;
    segmentStart = -1;
    segmentSymbolId = null;
  };

  for (let frameIndex = 0; frameIndex < track.samples.length; frameIndex += 1) {
    const sample = track.samples[frameIndex];
    if (!sample) {
      flush(frameIndex - 1);
      continue;
    }

    if (segmentStart === -1) {
      segmentStart = frameIndex;
      segmentSymbolId = sample.symbolId;
      continue;
    }

    if (sample.symbolId !== segmentSymbolId) {
      flush(frameIndex - 1);
      segmentStart = frameIndex;
      segmentSymbolId = sample.symbolId;
    }
  }

  flush(track.samples.length - 1);
  return segments.length === 0 ? [track] : segments;
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

  const decomposition = decomposeMatrix(sample.matrix);

  return {
    frame,
    position: [sample.matrix.tx / 20, sample.matrix.ty / 20, 0],
    rotation: decomposition.rotation,
    scale: [decomposition.scaleX, decomposition.scaleY, 100],
    skew: decomposition.skew,
    skewAxis: decomposition.skewAxis,
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
    s: exportVectorProperty(samples.map((sample) => ({ frame: sample.frame, value: sample.scale }))),
    sk: exportScalarProperty(samples.map((sample) => ({ frame: sample.frame, value: sample.skew }))),
    sa: exportScalarProperty(samples.map((sample) => ({ frame: sample.frame, value: sample.skewAxis })))
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
    } else if (group.stroke?.kind === "linear-gradient") {
      items.push(exportLinearGradientStroke(group.stroke, transformSamples, sourceSamples));
    } else if (group.stroke?.kind === "radial-gradient") {
      items.push(exportRadialGradientStroke(group.stroke, transformSamples, sourceSamples));
    } else if (group.stroke?.kind === "bitmap") {
      issues.push({
        code: "unsupported_feature",
        severity: "warning",
        message: "Bitmap strokes are not supported by the current Lottie exporter.",
        details: { bitmapId: group.stroke.bitmapId }
      });
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

function exportStaticMorphProxyShapes(
  symbol: Extract<FlashDocument["symbols"][number], { kind: "morphshape" }>,
  successorPaths: FlashShapePath[],
  issues: ConversionIssue[],
  transformSamples: TransformSample[] = [],
  sourceSamples?: Array<FlashDisplayObjectState | null>,
  morphSamples: Array<FlashDisplayObjectState | null> = [],
  animateTowardSuccessor = false
): Record<string, unknown>[] {
  const exported: Record<string, unknown>[] = [];
  const morphFillPaths = symbol.paths.filter((path) => path.start.fill && !path.start.stroke);
  const morphStrokePaths = symbol.paths.filter((path) => path.start.stroke && !path.start.fill);
  const morphFillGroups = groupMorphPathsByStyle(morphFillPaths);
  const morphStrokeGroups = groupMorphPathsByStyle(morphStrokePaths);

  for (const group of groupPathsByStyle(successorPaths)) {
    const matchedMorphFillGroup = group.fill
      ? findBestMatchingMorphGroupForProxy(group, morphFillGroups)
      : null;
    const matchedMorphStrokeGroup = group.stroke
      ? findBestMatchingMorphGroupForProxy(group, morphStrokeGroups)
      : null;

    if ((group.fill && !matchedMorphFillGroup) || (group.stroke && !matchedMorphStrokeGroup)) {
      continue;
    }

    const items: Record<string, unknown>[] = group.paths.map((path) =>
      sourceSamples && needsBakedMatrix(sourceSamples)
        ? bakePathAnimation(path, sourceSamples)
        : exportLottieBezier(path)
    );

      const representativePath = group.paths[0];
      if (!representativePath) {
        continue;
      }

    if (group.fill) {
      const matchedMorphFill = matchedMorphFillGroup?.fillPath ?? findBestMatchingMorphPathByGeometry(representativePath, morphFillPaths);
      const fill = matchedMorphFill?.start.fill ?? group.fill;
      const matchedSolidFill = matchedMorphFill?.start.fill?.kind === "solid" ? matchedMorphFill.start.fill : null;
      const matchedSolidEndFill = matchedMorphFill?.end.fill?.kind === "solid" ? matchedMorphFill.end.fill : null;
      const successorSolidFill = group.fill.kind === "solid" ? group.fill : null;

      if (fill.kind === "solid") {
        if (
          matchedSolidFill &&
          matchedSolidEndFill &&
          (!fillsEqual(matchedMorphFill?.start.fill, matchedMorphFill?.end.fill) || animateTowardSuccessor)
        ) {
          const targetFill = animateTowardSuccessor && successorSolidFill
            ? successorSolidFill
            : matchedSolidEndFill;
          items.push({
            ty: "fl",
            c: exportVectorProperty(morphSamples
              .map((sample, frame) => sample
                ? {
                    frame,
                    value: interpolateColorVector(
                      matchedSolidFill.color,
                      targetFill.color,
                      sample.ratio ?? 0
                    )
                  }
                : null)
              .filter((value): value is { frame: number; value: [number, number, number, number] } => value !== null)),
            o: exportScalarProperty(morphSamples
              .map((sample, frame) => sample
                ? {
                    frame,
                    value: clamp(interpolateNumber(
                      matchedSolidFill.alpha,
                      targetFill.alpha,
                      sample.ratio ?? 0
                    ) * 100, 0, 100)
                  }
                : null)
              .filter((value): value is { frame: number; value: number } => value !== null)),
            r: 1
          });
        } else {
          items.push(exportSolidFill(fill, transformSamples));
        }
      } else if (fill.kind === "linear-gradient") {
        items.push(exportLinearGradientFill(fill, transformSamples, sourceSamples));
      } else if (fill.kind === "radial-gradient") {
        items.push(exportRadialGradientFill(fill, transformSamples, sourceSamples));
      } else {
        issues.push({
          code: "not_implemented",
          severity: "warning",
          message: "This proxy morph fill type is parsed but not exported yet.",
          details: { fillKind: fill.kind }
        });
      }
    }

    if (group.stroke) {
      const matchedMorphStroke = matchedMorphStrokeGroup?.strokePath ?? findBestMatchingMorphPathByGeometry(representativePath, morphStrokePaths);
      const stroke = matchedMorphStroke?.start.stroke ?? group.stroke;

      if (stroke.kind === "solid") {
        items.push(exportSolidStroke(stroke));
      } else if (stroke.kind === "linear-gradient") {
        items.push(exportLinearGradientStroke(stroke, transformSamples, sourceSamples));
      } else if (stroke.kind === "radial-gradient") {
        items.push(exportRadialGradientStroke(stroke, transformSamples, sourceSamples));
      } else if (stroke.kind === "bitmap") {
        issues.push({
          code: "unsupported_feature",
          severity: "warning",
          message: "Bitmap strokes are not supported by the current Lottie exporter.",
          details: { bitmapId: stroke.bitmapId }
        });
      }
    }

    if (items.length === group.paths.length) {
      continue;
    }

    exported.push({
      ty: "gr",
      it: [...items, exportGroupTransform()]
    });
  }

  return exported;
}

function findBestMatchingMorphGroupForProxy(
  targetGroup: ShapeStyleGroup,
  candidates: MorphShapeStyleGroup[]
): MorphShapeStyleGroup | null {
  let best: MorphShapeStyleGroup | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate.paths.length !== targetGroup.paths.length) {
      continue;
    }

    const score = morphGroupGeometryScore(targetGroup, candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function morphGroupGeometryScore(
  targetGroup: ShapeStyleGroup,
  candidateGroup: MorphShapeStyleGroup
): number {
  const remaining = [...candidateGroup.paths];
  let total = 0;

  for (const targetPath of targetGroup.paths) {
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const [index, candidatePath] of remaining.entries()) {
      const score = Math.min(
        geometryDistanceScore(targetPath.geometry, candidatePath.start.geometry),
        geometryDistanceScore(targetPath.geometry, reverseGeometry(candidatePath.start.geometry))
      );

      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    if (bestIndex === -1) {
      return Number.POSITIVE_INFINITY;
    }

    total += bestScore;
    remaining.splice(bestIndex, 1);
  }

  return total;
}

function findBestMatchingMorphPath(
  targetPath: FlashShapePath,
  candidates: FlashMorphShapePath[]
): FlashMorphShapePath | null {
  if (targetPath.styleKey) {
    const direct = candidates.find((candidate) =>
      candidate.start.styleKey === targetPath.styleKey || candidate.end.styleKey === targetPath.styleKey
    );
    if (direct) {
      return direct;
    }
  }

  let best: FlashMorphShapePath | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const score = geometryDistanceScore(targetPath.geometry, candidate.start.geometry);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function findBestMatchingMorphPathByGeometry(
  targetPath: FlashShapePath,
  candidates: FlashMorphShapePath[]
): FlashMorphShapePath | null {
  let best: FlashMorphShapePath | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const score = Math.min(
      geometryDistanceScore(targetPath.geometry, candidate.start.geometry),
      geometryDistanceScore(targetPath.geometry, reverseGeometry(candidate.start.geometry))
    );

    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function hasImmediateStaticMorphSuccessor(
  track: TimelineTrack,
  timeline: FlashTimeline,
  successorSymbolId: string
): boolean {
  const currentSample = track.samples[track.lastFrame];
  const nextFrame = timeline.frames[track.lastFrame + 1];
  if (!currentSample || !nextFrame) {
    return false;
  }

  return nextFrame.displayList.some((instance) =>
    instance.depth === currentSample.depth && instance.symbolId === successorSymbolId
  );
}

function exportShapeTrackWithBitmapFills(
  track: TimelineTrack,
  symbol: FlashShapeSymbol,
  timeline: FlashTimeline,
  baseLayer: Record<string, unknown>,
  transformSamples: TransformSample[],
  sourceSamples: Array<FlashDisplayObjectState | null>,
  shouldBakeLayerTransform: boolean,
  symbolMap: FlashSymbolMap,
  bitmapAssets: Record<string, unknown>[],
  exportedBitmapAssets: ExportedBitmapAsset[],
  bitmapAssetIds: Map<string, string>,
  maskProperties: Record<string, unknown>[],
  issues: ConversionIssue[],
  bitmapAssetMode: BitmapAssetMode,
  bitmapAssetBasePath: string
): Record<string, unknown>[] {
  const groups = groupPathsByStyle(symbol.paths);
  const layerSpecs: LayerExportSpec[] = [];

  for (const group of groups) {
    const bitmapFill = group.fill?.kind === "bitmap" ? group.fill : undefined;

    if (bitmapFill) {
      const bitmapSymbol = symbolMap.get(bitmapFill.bitmapId);
      if (!bitmapSymbol || bitmapSymbol.kind !== "bitmap") {
        issues.push({
          code: "unsupported_feature",
          severity: "warning",
          message: "Bitmap fill references a missing bitmap symbol.",
          path: track.id,
          details: { bitmapId: bitmapFill.bitmapId }
        });
        continue;
      }

      if (bitmapFill.repeat) {
        issues.push({
          code: "unsupported_feature",
          severity: "warning",
          message: "Repeated bitmap fills are currently exported as a single image sample.",
          path: track.id,
          details: { bitmapId: bitmapSymbol.id }
        });
      }

      const tileOffsets = bitmapFill.repeat
        ? computeBitmapTileOffsets(group.paths, bitmapFill, bitmapSymbol)
        : [{ x: 0, y: 0 }];

      if (tileOffsets.length > 64) {
        issues.push({
          code: "unsupported_feature",
          severity: "warning",
          message: "Bitmap fill tiling required too many image copies. Export was limited.",
          path: track.id,
          details: { bitmapId: bitmapSymbol.id, tiles: tileOffsets.length }
        });
      }

      for (const offset of tileOffsets.slice(0, 64)) {
        const combinedSamples = sourceSamples
          .map((sample, frame) => toBitmapTransformSample(frame, sample, bitmapFill, offset))
          .filter((sample): sample is TransformSample => sample !== null);

        if (combinedSamples.length === 0) {
          continue;
        }

        const tileMatrix = multiplyPixelMatrices(
          bitmapFillToPixelMatrix(bitmapFill),
          translationPixelMatrix(offset.x, offset.y)
        );

        layerSpecs.push({
          name: `${track.name ?? track.id}:bitmap:${group.index}:${offset.x}:${offset.y}`,
          kind: "bitmap",
          index: group.index,
          bitmapSymbol,
          bitmapFill,
          transformSamples: combinedSamples,
          clipMasks: exportBitmapFillClipMasks(group.paths, tileMatrix),
          hasUnsupportedBitmapColor: combinedSamples.some((sample) =>
            sample.colorTransform.tint !== undefined || sample.colorTransform.brightness !== undefined
          )
        });
      }
      continue;
    }

    const bakedSamples = shouldBakeLayerTransform ? sourceSamples : undefined;
    const shapes = exportShapePaths(group.paths, issues, transformSamples, bakedSamples);
    if (shapes.length === 0) {
      continue;
    }

    const layerTransformSamples = shouldBakeLayerTransform
      ? transformSamples.map((sample) => ({
          ...sample,
          position: [0, 0, 0] as [number, number, number],
          rotation: 0,
          scale: [100, 100, 100] as [number, number, number],
          skew: 0,
          skewAxis: 0
        }))
      : transformSamples;

    layerSpecs.push({
      name: `${track.name ?? track.id}:shape:${group.index}`,
      kind: "shape",
      index: group.index,
      shapes,
      transformSamples: layerTransformSamples
    });
  }

  const hasBitmapLayer = layerSpecs.some((spec) => spec.kind === "bitmap");

  return layerSpecs
    .sort((left, right) => hasBitmapLayer ? right.index - left.index : compareLayerSpecPriority(left, right))
    .reduce<Record<string, unknown>[]>((layers, spec) => {
      if (spec.kind === "shape") {
        layers.push(
          {
            ...baseLayer,
            nm: spec.name,
            ks: exportTransformSamples(spec.transformSamples ?? transformSamples),
            ty: 4,
            shapes: spec.shapes,
            ...(maskProperties.length > 0 ? { hasMask: true, masksProperties: maskProperties } : {})
          }
        );
        return layers;
      }

      if (!spec.bitmapSymbol || !spec.bitmapFill || !spec.transformSamples) {
        return layers;
      }

      if (spec.bitmapSymbol.hasSeparateAlpha) {
        issues.push({
          code: "unsupported_feature",
          severity: "warning",
          message: "Bitmap assets with separate alpha data are exported without alpha reconstruction.",
          path: track.id,
          details: { symbolId: spec.bitmapSymbol.id }
        });
      }

      if (spec.hasUnsupportedBitmapColor) {
        issues.push({
          code: "unsupported_color_transform",
          severity: "warning",
          message: "Bitmap tint and brightness are not exported yet. Only alpha is applied.",
          path: track.id,
          details: { symbolId: spec.bitmapSymbol.id }
        });
      }

      const assetId = ensureBitmapAsset(
        spec.bitmapSymbol,
        bitmapAssets,
        exportedBitmapAssets,
        bitmapAssetIds,
        bitmapAssetMode,
        bitmapAssetBasePath
      );
      layers.push({
        ...baseLayer,
        nm: spec.name,
        ks: exportTransformSamples(spec.transformSamples),
        ty: 2,
        refId: assetId,
        w: spec.bitmapSymbol.width,
        h: spec.bitmapSymbol.height,
        ...(
          maskProperties.length > 0 || (spec.clipMasks?.length ?? 0) > 0
            ? {
                hasMask: true,
                masksProperties: [...(spec.clipMasks ?? []), ...maskProperties]
              }
            : {}
        )
      });
      return layers;
    }, []);
}

function exportBitmapFillClipMasks(
  paths: FlashShapePath[],
  pixelMatrix: PixelMatrix2d
): Record<string, unknown>[] {
  const inverse = invertPixelMatrix(pixelMatrix);
  if (!inverse) {
    return [];
  }

  return paths.map((path, index) => ({
    mode: "a",
    inv: false,
    cl: true,
    nm: `bitmap-fill-mask:${index + 1}`,
    o: { a: 0, k: 100 },
    pt: {
      a: 0,
      k: transformBezierGeometryWithPixelMatrix(path.geometry, inverse)
    },
    x: { a: 0, k: 0 }
  }));
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

function groupMorphPathsByStyle(paths: FlashMorphShapePath[]): MorphShapeStyleGroup[] {
  const groups = new Map<string, MorphShapeStyleGroup>();

  for (const [index, path] of paths.entries()) {
    const startFillKey = path.start.fill ? JSON.stringify(path.start.fill) : "none";
    const endFillKey = path.end.fill ? JSON.stringify(path.end.fill) : "none";
    const startStrokeKey = path.start.stroke ? JSON.stringify(path.start.stroke) : "none";
    const endStrokeKey = path.end.stroke ? JSON.stringify(path.end.stroke) : "none";
    const key = [
      path.start.styleKey ?? "none",
      path.end.styleKey ?? "none",
      startFillKey,
      endFillKey,
      startStrokeKey,
      endStrokeKey
    ].join("|");
    const existing = groups.get(key);
    if (existing) {
      existing.paths.push(path);
      continue;
    }

    groups.set(key, {
      index,
      ...(path.start.fill || path.end.fill ? { fillPath: path } : {}),
      ...(path.start.stroke || path.end.stroke ? { strokePath: path } : {}),
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

function exportStaticMovieClipLayers(
  track: TimelineTrack,
  symbol: FlashMovieClipSymbol,
  timeline: FlashTimeline,
  document: FlashDocument,
  symbolMap: FlashSymbolMap,
  bitmapAssets: Record<string, unknown>[],
  exportedBitmapAssets: ExportedBitmapAsset[],
  bitmapAssetIds: Map<string, string>,
  issues: ConversionIssue[],
  bitmapAssetMode: BitmapAssetMode,
  bitmapAssetBasePath: string
): Record<string, unknown>[] {
  const frame = symbol.timeline.frames[0];
  if (!frame) {
    return [];
  }

  return frame.displayList
    .slice()
    .sort((left, right) => right.depth - left.depth)
    .flatMap((instance) => {
      const samples = track.samples.map((parentSample) =>
        parentSample ? combineDisplayStates(parentSample, instance, `${track.id}/${instance.id}`, [track.depth, instance.depth]) : null
      );
      const firstFrame = samples.findIndex((sample) => sample !== null);
      if (firstFrame === -1) {
        return [];
      }

      let lastFrame = samples.length - 1;
      while (lastFrame >= 0 && samples[lastFrame] === null) {
        lastFrame -= 1;
      }

      const childTrack: TimelineTrack = {
        id: `${track.id}/${instance.id}`,
        depth: instance.depth,
        symbolId: instance.symbolId,
        firstFrame,
        lastFrame,
        samples,
        ...(instance.name ? { name: instance.name } : {})
      };

      return exportTrack(
        childTrack,
        new Map<string, TimelineTrack>(),
        timeline,
        document,
        symbolMap,
        bitmapAssets,
        exportedBitmapAssets,
        bitmapAssetIds,
        issues,
        bitmapAssetMode,
        bitmapAssetBasePath
      );
    });
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

  if (symbol.kind === "bitmap") {
    issues.push({
      code: "unsupported_feature",
      severity: "warning",
      message: "Bitmap instances inside static shape flattening are not exported inline yet.",
      path: instance.id,
      details: { symbolId: symbol.id }
    });
    return [];
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

    if (childSymbol.kind !== "movieclip") {
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

function toBitmapTransformSample(
  frame: number,
  sample: FlashDisplayObjectState | null,
  fill: Extract<FlashShapePath["fill"], { kind: "bitmap" }>,
  offset: { x: number; y: number } = { x: 0, y: 0 }
): TransformSample | null {
  if (!sample) {
    return null;
  }

  return toTransformSample(
    frame,
    {
      ...sample,
      matrix: multiplyMatrices(
        sample.matrix,
        multiplyMatrices(
          bitmapFillMatrixToDisplayMatrix(fill),
          translationDisplayMatrix(offset.x, offset.y)
        )
      )
    },
    [],
    "bitmap-fill"
  );
}

function bitmapFillMatrixToDisplayMatrix(
  fill: Extract<FlashShapePath["fill"], { kind: "bitmap" }>
): FlashDisplayObjectState["matrix"] {
  return {
    a: fill.matrix.a / 20,
    b: fill.matrix.b / 20,
    c: fill.matrix.c / 20,
    d: fill.matrix.d / 20,
    tx: fill.matrix.tx * 20,
    ty: fill.matrix.ty * 20
  };
}

function bitmapFillToPixelMatrix(
  fill: Extract<FlashShapePath["fill"], { kind: "bitmap" }>
): PixelMatrix2d {
  return {
    a: fill.matrix.a / 20,
    b: fill.matrix.b / 20,
    c: fill.matrix.c / 20,
    d: fill.matrix.d / 20,
    tx: fill.matrix.tx,
    ty: fill.matrix.ty
  };
}

function translationDisplayMatrix(x: number, y: number): FlashDisplayObjectState["matrix"] {
  return {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    tx: x * 20,
    ty: y * 20
  };
}

function translationPixelMatrix(x: number, y: number): PixelMatrix2d {
  return {
    a: 1,
    b: 0,
    c: 0,
    d: 1,
    tx: x,
    ty: y
  };
}

function computeBitmapTileOffsets(
  paths: FlashShapePath[],
  fill: Extract<FlashShapePath["fill"], { kind: "bitmap" }>,
  bitmap: FlashBitmapSymbol
): Array<{ x: number; y: number }> {
  const inverse = invertPixelMatrix(bitmapFillToPixelMatrix(fill));
  if (!inverse) {
    return [{ x: 0, y: 0 }];
  }

  const bounds = boundsInLocalBitmapSpace(paths, inverse);
  if (!bounds) {
    return [{ x: 0, y: 0 }];
  }

  const startTileX = Math.floor(bounds.minX / bitmap.width);
  const endTileX = Math.floor((bounds.maxX - 1e-6) / bitmap.width);
  const startTileY = Math.floor(bounds.minY / bitmap.height);
  const endTileY = Math.floor((bounds.maxY - 1e-6) / bitmap.height);
  const offsets: Array<{ x: number; y: number }> = [];

  for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
    for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
      offsets.push({
        x: tileX * bitmap.width,
        y: tileY * bitmap.height
      });
    }
  }

  return offsets.length > 0 ? offsets : [{ x: 0, y: 0 }];
}

function boundsInLocalBitmapSpace(
  paths: FlashShapePath[],
  inverseMatrix: PixelMatrix2d
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const points = paths.flatMap((path) => path.geometry.vertices);
  if (points.length === 0) {
    return null;
  }

  return points.reduce<{ minX: number; minY: number; maxX: number; maxY: number }>((bounds, point) => {
    const [x, y] = applyPixelMatrixToPointWithMatrix(point, inverseMatrix);
    return {
      minX: Math.min(bounds.minX, x),
      minY: Math.min(bounds.minY, y),
      maxX: Math.max(bounds.maxX, x),
      maxY: Math.max(bounds.maxY, y)
    };
  }, {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  });
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

function exportMorphShapePaths(
  paths: FlashMorphShapePath[],
  samples: Array<FlashDisplayObjectState | null>,
  issues: ConversionIssue[]
): Record<string, unknown>[] {
  const exported: Record<string, unknown>[] = [];
  const filteredPaths = suppressOverlappingMorphFillPaths(normalizeProxyStaticMorphPaths(paths));

  for (const group of groupMorphPathsByStyle(filteredPaths)) {
    const items: Record<string, unknown>[] = group.paths.map((path) => ({
      ty: "sh",
      ks: exportMorphBezier(path, samples)
    }));

    if (group.fillPath) {
      const fill = exportMorphFill(group.fillPath, samples, issues);
      if (fill) {
        items.push(fill);
      }
    }

    if (group.strokePath) {
      const stroke = exportMorphStroke(group.strokePath, samples);
      if (stroke) {
        items.push(stroke);
      }
    }

    if (items.length === group.paths.length) {
      issues.push({
        code: "unsupported_feature",
        severity: "warning",
        message: "Morph path group without a supported fill or stroke is skipped."
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

function normalizeProxyStaticMorphPaths(paths: FlashMorphShapePath[]): FlashMorphShapePath[] {
  const staticStrokeGeometries = paths
    .filter((path) =>
      path.start.stroke &&
      path.end.stroke &&
      geometriesApproximatelyEqual(path.start.geometry, path.end.geometry)
    )
    .map((path) => path.start.geometry);

  if (staticStrokeGeometries.length === 0) {
    return paths;
  }

  return paths.map((path) => {
    if (
      !path.start.fill ||
      !path.end.fill ||
      geometriesApproximatelyEqual(path.start.geometry, path.end.geometry)
    ) {
      return path;
    }

    const endLooksLikeStroke = staticStrokeGeometries.some((geometry) =>
      geometriesApproximatelyEqual(path.end.geometry, geometry, 0.1) ||
      geometriesApproximatelyEqual(path.end.geometry, reverseGeometry(geometry), 0.1)
    );

    if (!endLooksLikeStroke) {
      return path;
    }

    return {
      start: path.start,
      end: {
        ...path.end,
        geometry: path.start.geometry
      }
    };
  });
}

function suppressOverlappingMorphFillPaths(paths: FlashMorphShapePath[]): FlashMorphShapePath[] {
  return paths.filter((path, index) => {
    const pathFill = path.start.fill;
    if (pathFill?.kind !== "solid" || !fillsEqual(path.start.fill, path.end.fill)) {
      return true;
    }

    return !paths.some((other, otherIndex) => {
      if (otherIndex === index || other.start.fill?.kind !== "solid") {
        return false;
      }

      if (path.start.styleKey === other.start.styleKey) {
        return false;
      }

      return geometriesApproximatelyEqual(path.start.geometry, other.start.geometry);
    });
  });
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

  if (!canMorphGeometries(startGeometry, endGeometry) || geometriesApproximatelyEqual(startGeometry, endGeometry)) {
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

function transformBezierGeometryWithPixelMatrix(
  geometry: FlashShapePath["geometry"],
  matrix: { a: number; b: number; c: number; d: number; tx: number; ty: number }
): Record<string, unknown> {
  const vertices = geometry.vertices.map(([x, y]) => applyPixelMatrixToPointWithMatrix([x, y], matrix));
  const inTangents = geometry.inTangents.map((tangent) => applyPixelMatrixToVectorWithMatrix(tangent, matrix));
  const outTangents = geometry.outTangents.map((tangent) => applyPixelMatrixToVectorWithMatrix(tangent, matrix));

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
      s: exportDiscreteVectorProperty(startKeyframes),
      e: exportDiscreteVectorProperty(endKeyframes),
      t: 1,
      g: {
        p: startFill.stops.length,
        k: exportDiscreteVectorProperty(gradientKeyframes)
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
      s: exportDiscreteVectorProperty(startKeyframes),
      e: exportDiscreteVectorProperty(endKeyframes),
      t: 2,
      h: exportDiscreteScalarProperty(highlightKeyframes),
      a: { a: 0, k: 0 },
      g: {
        p: startFill.stops.length,
        k: exportDiscreteVectorProperty(gradientKeyframes)
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

function exportLinearGradientStroke(
  stroke: FlashGradientStroke,
  transformSamples: TransformSample[] = [],
  sourceSamples?: Array<FlashDisplayObjectState | null>
): Record<string, unknown> {
  const start = sourceSamples && needsBakedMatrix(sourceSamples)
    ? exportGradientPointProperty(stroke, -16384 / 20, 0, transformSamples, sourceSamples)
    : exportGradientPointProperty(stroke, -16384 / 20, 0, transformSamples, sourceSamples);
  const end = sourceSamples && needsBakedMatrix(sourceSamples)
    ? exportGradientPointProperty(stroke, 16384 / 20, 0, transformSamples, sourceSamples)
    : exportGradientPointProperty(stroke, 16384 / 20, 0, transformSamples, sourceSamples);

  return {
    ty: "gs",
    o: { a: 0, k: 100 },
    r: 1,
    s: start,
    e: end,
    t: 1,
    g: {
      p: stroke.stops.length,
      k: {
        a: 0,
        k: flattenGradientStops(stroke)
      }
    },
    w: { a: 0, k: stroke.width },
    lc: lineCapToLottie(stroke.lineCap),
    lj: lineJoinToLottie(stroke.lineJoin),
    ...(stroke.miterLimit !== undefined ? { ml: stroke.miterLimit } : {})
  };
}

function exportRadialGradientStroke(
  stroke: FlashGradientStroke,
  transformSamples: TransformSample[] = [],
  sourceSamples?: Array<FlashDisplayObjectState | null>
): Record<string, unknown> {
  const start = exportGradientPointProperty(stroke, 0, 0, transformSamples, sourceSamples);
  const end = exportGradientPointProperty(stroke, 16384 / 20, 0, transformSamples, sourceSamples);

  return {
    ty: "gs",
    o: { a: 0, k: 100 },
    r: 1,
    s: start,
    e: end,
    t: 2,
    h: { a: 0, k: clamp((stroke.focalPoint ?? 0) * 100, -100, 100) },
    a: { a: 0, k: 0 },
    g: {
      p: stroke.stops.length,
      k: {
        a: 0,
        k: flattenGradientStops(stroke)
      }
    },
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

function exportDiscreteScalarProperty(
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

function exportDiscreteVectorProperty(
  keyframes: Array<{ frame: number; value: number[] }>
): Record<string, unknown> {
  const uniqueValues = new Set(keyframes.map((keyframe) => keyframe.value.join(",")));
  if (uniqueValues.size <= 1) {
    return { a: 0, k: keyframes[0]?.value ?? [0, 0] };
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
  return decomposeMatrix(matrix).rotation;
}

function scalePercentFromMatrixX(sample: FlashDisplayObjectState): number {
  return decomposeMatrix(sample.matrix).scaleX;
}

function scalePercentFromMatrixY(sample: FlashDisplayObjectState): number {
  return decomposeMatrix(sample.matrix).scaleY;
}

function needsBakedMatrix(samples: Array<FlashDisplayObjectState | null>): boolean {
  return samples.some((sample) => sample ? hasShear(sample.matrix) : false);
}

function hasShear(matrix: FlashDisplayObjectState["matrix"]): boolean {
  const dot = matrix.a * matrix.c + matrix.b * matrix.d;
  return Math.abs(dot) > 1e-6;
}

function decomposeMatrix(matrix: FlashDisplayObjectState["matrix"]): {
  rotation: number;
  scaleX: number;
  scaleY: number;
  skew: number;
  skewAxis: number;
} {
  const rotation = (Math.atan2(-matrix.c, matrix.d) * 180) / Math.PI;
  const unrotated = multiplyMatrices2d(
    rotationMatrix2d(-rotation),
    {
      a: matrix.a,
      b: matrix.b,
      c: matrix.c,
      d: matrix.d
    }
  );
  const scaleXRaw = unrotated.a;
  const scaleYRaw = unrotated.d;

  if (Math.abs(scaleXRaw) < 1e-8) {
    return {
      rotation: 0,
      scaleX: 0,
      scaleY: Math.hypot(matrix.c, matrix.d) * 100,
      skew: 0,
      skewAxis: 0
    };
  }

  return {
    rotation,
    scaleX: scaleXRaw * 100,
    scaleY: scaleYRaw * 100,
    skew: (Math.atan2(unrotated.b, scaleXRaw) * 180) / Math.PI,
    skewAxis: 90
  };
}

function multiplyMatrices2d(
  left: { a: number; b: number; c: number; d: number },
  right: { a: number; b: number; c: number; d: number }
): { a: number; b: number; c: number; d: number } {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d
  };
}

function rotationMatrix2d(rotation: number): { a: number; b: number; c: number; d: number } {
  const radians = (rotation * Math.PI) / 180;
  return {
    a: Math.cos(radians),
    b: Math.sin(radians),
    c: -Math.sin(radians),
    d: Math.cos(radians)
  };
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

function applyPixelMatrixToPointWithMatrix(
  point: [number, number],
  matrix: { a: number; b: number; c: number; d: number; tx: number; ty: number }
): [number, number] {
  return [
    matrix.a * point[0] + matrix.c * point[1] + matrix.tx,
    matrix.b * point[0] + matrix.d * point[1] + matrix.ty
  ];
}

function applyPixelMatrixToVectorWithMatrix(
  vector: [number, number],
  matrix: PixelMatrix2d
): [number, number] {
  return [
    matrix.a * vector[0] + matrix.c * vector[1],
    matrix.b * vector[0] + matrix.d * vector[1]
  ];
}

function invertPixelMatrix(
  matrix: PixelMatrix2d
): PixelMatrix2d | null {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (Math.abs(determinant) < 1e-8) {
    return null;
  }

  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    tx: (matrix.c * matrix.ty - matrix.d * matrix.tx) / determinant,
    ty: (matrix.b * matrix.tx - matrix.a * matrix.ty) / determinant
  };
}

function multiplyPixelMatrices(left: PixelMatrix2d, right: PixelMatrix2d): PixelMatrix2d {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    tx: left.a * right.tx + left.c * right.ty + left.tx,
    ty: left.b * right.tx + left.d * right.ty + left.ty
  };
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
    startFill.kind !== "bitmap" &&
    endFill.kind !== "solid" &&
    endFill.kind !== "bitmap" &&
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
    const inLeft = start.inTangents[index] ?? [0, 0];
    const inRight = end.inTangents[index] ?? inLeft;
    const outLeft = start.outTangents[index] ?? [0, 0];
    const outRight = end.outTangents[index] ?? outLeft;
    const dx = point[0] - target[0];
    const dy = point[1] - target[1];
    const dix = inLeft[0] - inRight[0];
    const diy = inLeft[1] - inRight[1];
    const dox = outLeft[0] - outRight[0];
    const doy = outLeft[1] - outRight[1];
    return sum + dx * dx + dy * dy + dix * dix + diy * diy + dox * dox + doy * doy;
  }, 0);
}

function geometriesApproximatelyEqual(
  start: FlashShapePath["geometry"],
  end: FlashShapePath["geometry"],
  epsilon = 1e-4
): boolean {
  return canMorphGeometries(start, end) &&
    start.vertices.every((point, index) => pointsApproximatelyEqual(point, end.vertices[index] ?? point, epsilon)) &&
    start.inTangents.every((point, index) => pointsApproximatelyEqual(point, end.inTangents[index] ?? point, epsilon)) &&
    start.outTangents.every((point, index) => pointsApproximatelyEqual(point, end.outTangents[index] ?? point, epsilon));
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

function compareLayerSpecPriority(left: LayerExportSpec, right: LayerExportSpec): number {
  const leftPriority = layerSpecPriority(left);
  const rightPriority = layerSpecPriority(right);

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return right.index - left.index;
}

function layerSpecPriority(spec: LayerExportSpec): number {
  if (spec.kind === "bitmap") {
    return 1;
  }

  const items = spec.shapes ?? [];
  const hasStroke = items.some((group) => {
    const nested = Array.isArray(group.it) ? group.it as Array<Record<string, unknown>> : [];
    return nested.some((item) => item.ty === "st");
  });
  const hasFill = items.some((group) => {
    const nested = Array.isArray(group.it) ? group.it as Array<Record<string, unknown>> : [];
    return nested.some((item) => item.ty === "fl" || item.ty === "gf");
  });

  if (hasStroke && !hasFill) {
    return 0;
  }

  return 2;
}

function ensureBitmapAsset(
  symbol: FlashBitmapSymbol,
  assets: Record<string, unknown>[],
  exportedBitmapAssets: ExportedBitmapAsset[],
  assetIds: Map<string, string>,
  bitmapAssetMode: BitmapAssetMode,
  bitmapAssetBasePath: string
): string {
  const existing = assetIds.get(symbol.id);
  if (existing) {
    return existing;
  }

  const assetId = `image:${symbol.id}`;
  const dataBase64 = encodeBase64(symbol.data);
  const filename = `bitmap-${sanitizeBitmapAssetName(symbol.id)}${extensionForMimeType(symbol.mimeType)}`;

  assets.push(
    bitmapAssetMode === "inline"
      ? {
          id: assetId,
          w: symbol.width,
          h: symbol.height,
          u: "",
          p: `data:${symbol.mimeType};base64,${dataBase64}`,
          e: 1
        }
      : {
          id: assetId,
          w: symbol.width,
          h: symbol.height,
          u: bitmapAssetBasePath,
          p: filename
        }
  );
  exportedBitmapAssets.push({
    symbolId: symbol.id,
    assetId,
    filename,
    mimeType: symbol.mimeType,
    dataBase64,
    width: symbol.width,
    height: symbol.height
  });
  assetIds.set(symbol.id, assetId);
  return assetId;
}

function normalizeBitmapAssetBasePath(value: string): string {
  if (!value) {
    return "";
  }

  const normalized = value.replace(/\\/g, "/");
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function sanitizeBitmapAssetName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function extensionForMimeType(mimeType: FlashBitmapSymbol["mimeType"]): string {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/gif":
      return ".gif";
    default:
      return ".bin";
  }
}

function encodeBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const chunk = (first << 16) | (second << 8) | third;

    output += alphabet[(chunk >> 18) & 0x3f];
    output += alphabet[(chunk >> 12) & 0x3f];
    output += index + 1 < bytes.length ? alphabet[(chunk >> 6) & 0x3f] : "=";
    output += index + 2 < bytes.length ? alphabet[chunk & 0x3f] : "=";
  }

  return output;
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

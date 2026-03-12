# Architecture

## Scope

The converter targets a strict Flash subset:

- timeline-based vector content;
- nested objects on a display list;
- per-instance affine transform matrix `a b c d tx ty`;
- simple color transform limited to `alpha` and `tint`;
- solid and gradient fills;
- primitive vector masks.

Everything else is out of scope until explicitly supported.

## Layering

### 1. SWF parse

Reads the binary stream and extracts only the tags needed for the supported subset.

Planned initial tag focus:

- `DefineShape*`
- `DefineSprite`
- `PlaceObject2` / `PlaceObject3`
- `RemoveObject2`
- `ShowFrame`
- header metadata

### 2. Flash IR

Normalizes parsed data into a converter-oriented model:

- symbol library;
- movieclip timelines;
- frame states or frame operations;
- shape geometry and fills;
- transforms, alpha, tint and masks.

### 3. Validation and normalization

Rejects unsupported constructs early and keeps errors explicit.

Examples:

- unsupported fill type;
- unsupported color transform mode;
- unsupported tag;
- unsupported mask behavior;
- malformed timeline update sequence.

### 4. Lottie export

Maps validated IR into Lottie layers, precomps, transforms, masks and shape data without approximation logic.

## Extensibility

The core package should stay runtime-agnostic:

- browser worker can feed `ArrayBuffer` directly;
- server API can wrap the same conversion function;
- CLI can be added later as a thin shell around the same entrypoint.

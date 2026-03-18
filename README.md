# swf 2 lottie

## Disclaimer

This project is entirely coded by OpenAI Codex. I did not even read the code yet. I give no warranties of any kind, project is provided as is. It currently in a working, but very early state.

## Description

`swf 2 lottie` is a deterministic converter from a strict subset of Adobe Flash Player 10.3 `SWF` files to `Lottie`.

The project is intentionally narrow:

- supported input is Flash timeline data within a strict supported subset, currently including vectors and a limited bitmap subset;
- supported timeline state includes nested display objects, motion tweens, shape tweens and color effects: alpha, tint and brightness;
- supported graphics include solid fills, gradients, bitmap fills, solid strokes, most stroke styles and primitive vector masks;
- unsupported features should produce explicit diagnostics, not heuristic output.

## Architecture

The project is written on TypeScript over Node.
The codebase is split into small layers:

- `src/core/swf`: binary reader and SWF parsing entrypoints;
- `src/core/ir`: intermediate representation for Flash timeline data;
- `src/core/validate`: subset validation and diagnostics;
- `src/core/export-lottie`: deterministic Lottie export from validated IR;
- `src/core/convert.ts`: orchestration entrypoint used by the preview server and fixture export scripts;
- `src/server`: minimal local HTTP server for preview and fixture gallery;
- `src/web`: minimal browser UI for manual conversion and inspection.

## Status

The current implementation already includes:

- `SWF` header and tag parsing for the subset used by the current fixtures;
- document and timeline IR with display list, transforms, color effects and morph ratio support;
- deterministic export to `Lottie` for the currently supported subset;
- structured diagnostics for unsupported features;
- fixture-driven tests and local preview tooling.

Supported on the current branch:

- nested display object timelines;
- motion tween style transform animation exported as `Lottie` keyframes;
- shape tween / morph shape animation;
- bitmap assets and bitmap-filled shapes;
- solid fills;
- linear and radial gradients;
- solid strokes;
- linear and radial gradient strokes;
- simple vector masks;
- alpha, tint and brightness color effects.

Still intentionally out of scope and probably never will be supported:

- audio;
- ActionScript / runtime code;
- filters, blend modes and other renderer-specific effects;
- heuristic reconstruction of unsupported Flash features.

Bitmap support currently covers the simple cases used by the current fixtures:

- embedded JPEG, PNG and GIF bitmap assets;
- `JPEG3` style image + alpha reconstruction into PNG;
- bitmap-filled shapes exported as masked `Lottie` image layers;
- repeated bitmap fills exported as tiled image layers clipped by the vector shape;
- bitmap motion tween transforms, including rotation, scale and skew.

Known bitmap limitation:

- bitmap `alpha` is exported;
- bitmap `tint` and `brightness` are not exported exactly and should warn;
- complex bitmap fill cases still rely on image-layer tiling and masking, because `Lottie` does not provide a native bitmap fill style for vector shapes.
- bitmap strokes are not exported and should warn.

## Fixtures

Source `SWF` samples live in `fixtures/`.

In this project, a fixture is a small stable sample file used as a regression test input. The current convention is flat naming, where each filename describes the feature under test, for example:

- `testswf0-rectangle.swf`
- `testswf3-nested-rotation.swf`
- `testswf6-tint.swf`

This is enough for the current phase. If the fixture set grows, it can later be reorganized into subdirectories without changing the converter core.

Ad hoc files that you only want to inspect manually should not go into `fixtures/`. Use the preview UI for those and let it save the generated JSON into `out/manual/`.

## Browser preview

To run the minimal local preview UI, start:

```bash
npm run preview
```

Then open `http://127.0.0.1:4173`.

The page provides:

- a `Choose SWF file` button;
- automatic conversion after file selection;
- an embedded `Lottie` preview area;
- a short issue list if conversion returns warnings or errors.

Each browser conversion also writes files to `out/manual/`:

- `*.json` for the generated `Lottie`;
- `*.meta.json` for source filename and issues;
- `*.error.json` if conversion fails.

There is also a fixture gallery at `http://127.0.0.1:4173/fixtures` which shows exported fixture JSON files in embedded `Lottie` players, activating on mouse over, in reverse date order, newest to oldest.

## Exporting fixture output

To generate JSON results for every file from `fixtures/`, run:

```bash
npm run export:fixtures
```

The command writes output files to `out/`:

- `*.json` for successful conversions;
- `*.error.json` for structured conversion failures.

To export a single fixture, run either:

```bash
npm run export:fixture -- testswf16-gradient-in-tween-2.swf
```

or the short numeric form:

```bash
npm run export:fixture -- 16
```

## Known limitation

- Dotted line-style case is still intentionally left unresolved. It seems flash exports all styled lines as shapes actually, and for some reason fill of the dotted line-style gets not line color, but fill color of nearby (?) shape.
- Elliptical radial gradients are not exported exactly. `Lottie` does not provide a direct equivalent of Flash gradient matrix deformation for radial fills, so those cases currently degrade to regular radial gradients.
- Some proxy tween patterns exported by Flash still need explicit handling on a case-by-case basis. The converter already resolves several of them deterministically, but this remains a class of edge cases to watch when new fixtures appear.

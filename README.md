# swf2lottie

`swf2lottie` is a deterministic converter from a strict subset of Adobe Flash Player 10.3 `SWF` files to `Lottie`.

The project is intentionally narrow:

- supported input is vector timeline data only;
- supported timeline state includes nested display objects, transform matrix, alpha and tint color transform;
- supported graphics include solid fills, gradients and primitive vector masks;
- unsupported features should produce explicit diagnostics, not heuristic output.

## Why not rely on an existing SWF parser?

At this stage, a project-specific parser is the better default.

- Most JavaScript SWF parsers are old, incomplete, or designed for broad playback/emulation rather than strict conversion.
- Mature SWF implementations exist, but many of the best maintained ones are embedded in runtimes or written in Rust rather than TypeScript.
- This project needs a narrow, auditable parser for a specific subset of tags and records, with precise diagnostics for unsupported features.
- A custom parser keeps the conversion pipeline deterministic and avoids carrying parsing complexity for ActionScript, raster assets, audio, filters and runtime behavior.

The recommended strategy is:

1. Build a small parser for the exact tag subset needed by the converter.
2. Keep the parser isolated behind interfaces so it can be swapped later.
3. Re-evaluate third-party parsing backends only if performance or spec coverage becomes a blocker.

## Architecture

The codebase is split into small layers:

- `src/core/swf`: binary reader and SWF parsing entrypoints;
- `src/core/ir`: intermediate representation for Flash timeline data;
- `src/core/validate`: subset validation and diagnostics;
- `src/core/export-lottie`: deterministic Lottie export from validated IR;
- `src/core/convert.ts`: orchestration entrypoint for future server, worker or CLI use.

## Status

This repository currently contains a typed core skeleton:

- document and timeline IR;
- structured conversion issues;
- parser/exporter interfaces and stubs;
- subset validator;
- conversion orchestration;
- smoke tests for the current pipeline.

The next implementation step is adding real `SWF` tag parsing on top of the binary reader and fixtures.

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
- a `Convert` button;
- an embedded `Lottie` preview area;
- a short issue list if conversion returns warnings or errors.

Each browser conversion also writes files to `out/manual/`:

- `*.json` for the generated `Lottie`;
- `*.meta.json` for source filename and issues;
- `*.error.json` if conversion fails.

## Exporting fixture output

To generate JSON results for every file from `fixtures/`, run:

```bash
npm run export:fixtures
```

The command writes output files to `out/`:

- `*.json` for successful conversions;
- `*.error.json` for structured conversion failures.

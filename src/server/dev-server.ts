import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { buildWebWorkerBundle, webBundleDirName } from "./build-web-worker.js";
import { convertSwfToLottie } from "../core/convert.js";
import { ConversionError } from "../core/issues.js";
import type { ExportedBitmapAsset } from "../core/export-lottie/types.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const rootDir = resolve(process.cwd());
const webDir = resolve(rootDir, "src", "web");
const iconsDir = resolve(webDir, "icons");
const faviconDir = resolve(webDir, "favicon");
const webBundleDir = resolve(rootDir, webBundleDirName);
const outDir = resolve(rootDir, "out", "manual");
const fixturesOutDir = resolve(rootDir, "out");
const fixturesWebOutDir = resolve(rootDir, "out-web");
const lottiePlayerPath = resolve(rootDir, "node_modules", "lottie-web", "build", "player", "lottie.min.js");

const staticFiles = new Map<string, { path: string; contentType: string }>([
  ["/", { path: resolve(webDir, "index.html"), contentType: "text/html; charset=utf-8" }],
  ["/app.js", { path: resolve(webDir, "app.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/build-info.js", { path: resolve(webDir, "build-info.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/lottie-preview-normalize.js", { path: resolve(webDir, "lottie-preview-normalize.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/convert-worker.js", { path: resolve(webBundleDir, "convert-worker.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/convert-worker.js.map", { path: resolve(webBundleDir, "convert-worker.js.map"), contentType: "application/json; charset=utf-8" }],
  ["/styles.css", { path: resolve(webDir, "styles.css"), contentType: "text/css; charset=utf-8" }],
  ["/fixtures", { path: resolve(webDir, "fixtures.html"), contentType: "text/html; charset=utf-8" }],
  ["/fixtures/", { path: resolve(webDir, "fixtures.html"), contentType: "text/html; charset=utf-8" }],
  ["/fixtures.js", { path: resolve(webDir, "fixtures.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/fixtures-web", { path: resolve(webDir, "fixtures-web.html"), contentType: "text/html; charset=utf-8" }],
  ["/fixtures-web/", { path: resolve(webDir, "fixtures-web.html"), contentType: "text/html; charset=utf-8" }],
  ["/fixtures-web.js", { path: resolve(webDir, "fixtures-web.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/fixtures.css", { path: resolve(webDir, "fixtures.css"), contentType: "text/css; charset=utf-8" }],
  ["/vendor/lottie.min.js", { path: lottiePlayerPath, contentType: "text/javascript; charset=utf-8" }]
]);

mkdirSync(outDir, { recursive: true });
await buildWebWorkerBundle(rootDir);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "POST" && url.pathname === "/api/convert") {
      await handleConvertRequest(request, response, url);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/save-json") {
      await handleSaveJsonRequest(request, response, url);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/fixtures") {
      sendJson(response, 200, {
        fixtures: listExportedFixtures(fixturesOutDir, "/api/fixture-json/")
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/fixture-json/")) {
      const filename = decodeURIComponent(url.pathname.slice("/api/fixture-json/".length));
      const safeName = sanitizeFixtureJsonName(filename, fixturesOutDir);

      if (!safeName) {
        sendJson(response, 404, { message: "Fixture JSON not found." });
        return;
      }

      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(readFileSync(resolve(fixturesOutDir, safeName)));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/fixtures-web") {
      sendJson(response, 200, {
        fixtures: listExportedFixtures(fixturesWebOutDir, "/api/fixture-web-json/")
      });
      return;
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/fixture-web-json/")) {
      const filename = decodeURIComponent(url.pathname.slice("/api/fixture-web-json/".length));
      const safeName = sanitizeFixtureJsonName(filename, fixturesWebOutDir);

      if (!safeName) {
        sendJson(response, 404, { message: "Browser fixture JSON not found." });
        return;
      }

      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(readFileSync(resolve(fixturesWebOutDir, safeName)));
      return;
    }

    if (request.method === "GET") {
      if (serveScopedAsset(url.pathname, "/icons/", iconsDir, response)) {
        return;
      }

      if (serveScopedAsset(url.pathname, "/favicon/", faviconDir, response)) {
        return;
      }

      if (serveStatic(url.pathname, response)) {
        return;
      }

      sendJson(response, 404, { message: "Not found." });
      return;
    }

    sendJson(response, 405, { message: "Method not allowed." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    sendJson(response, 500, { message });
  }
}).listen(port, host, () => {
  process.stdout.write(`swf2lottie preview server listening at http://${host}:${port}\n`);
});

function serveStatic(pathname: string, response: ServerResponse): boolean {
  const file = staticFiles.get(pathname);
  if (!file) {
    return false;
  }

  response.writeHead(200, { "content-type": file.contentType });
  response.end(readFileSync(file.path));
  return true;
}

function serveScopedAsset(pathname: string, routePrefix: string, baseDir: string, response: ServerResponse): boolean {
  if (!pathname.startsWith(routePrefix)) {
    return false;
  }

  const relativePath = pathname.slice(routePrefix.length).replaceAll("\\", "/");
  if (!relativePath || relativePath.includes("..")) {
    return false;
  }

  const assetPath = resolve(baseDir, relativePath);
  if (!assetPath.startsWith(baseDir)) {
    return false;
  }

  try {
    if (!statSync(assetPath).isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  response.writeHead(200, { "content-type": inferContentType(assetPath) });
  response.end(readFileSync(assetPath));
  return true;
}

function inferContentType(path: string): string {
  const extension = extname(path).toLowerCase();
  switch (extension) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

async function handleConvertRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  const filename = sanitizeFilename(url.searchParams.get("filename") ?? "upload.swf");
  const buffer = await readRequestBody(request);
  const arrayBuffer = Uint8Array.from(buffer).buffer;
  const stem = basename(filename, extname(filename));

  try {
    const result = convertSwfToLottie(arrayBuffer);
    const meta = {
      source: filename,
      issues: result.issues
    };

    if (!result.animation) {
      const errorPayload = {
        source: filename,
        message: "Conversion finished without a Lottie animation payload.",
        issues: result.issues
      };

      writeFileSync(resolve(outDir, `${stem}.error.json`), `${JSON.stringify(errorPayload, null, 2)}\n`, "utf8");
      sendJson(response, 422, {
        ok: false,
        message: errorPayload.message,
        issues: result.issues
      });
      return;
    }

    writeFileSync(resolve(outDir, `${stem}.json`), `${JSON.stringify(result.animation, null, 2)}\n`, "utf8");
    writeFileSync(resolve(outDir, `${stem}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    sendJson(response, 200, {
      ok: true,
      animation: result.animation,
      bitmapAssets: result.bitmapAssets,
      issues: result.issues,
      output: {
        json: `out/manual/${stem}.json`,
        meta: `out/manual/${stem}.meta.json`
      }
    });
  } catch (error) {
    if (error instanceof ConversionError) {
      const payload = {
        source: filename,
        message: error.message,
        issues: error.issues
      };

      writeFileSync(resolve(outDir, `${stem}.error.json`), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      sendJson(response, 422, {
        ok: false,
        message: error.message,
        issues: error.issues,
        output: {
          error: `out/manual/${stem}.error.json`
        }
      });
      return;
    }

    throw error;
  }
}

async function handleSaveJsonRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL
): Promise<void> {
  const filename = sanitizeJsonFilename(url.searchParams.get("filename") ?? "converted.json");
  const stem = basename(filename, extname(filename));
  const jsonPath = resolve(outDir, filename);
  const metaPath = resolve(outDir, `${stem}.meta.json`);

  const buffer = await readRequestBody(request);
  const text = buffer.toString("utf8");

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    sendJson(response, 400, {
      ok: false,
      message: "Invalid JSON payload."
    });
    return;
  }

  const packagePayload = normalizeSavePayload(payload);
  const animation = packagePayload.animation;
  const externalAssets = packagePayload.externalAssets;

  const issuesHeader = url.searchParams.get("issues");
  const sourceHeader = url.searchParams.get("source") ?? filename.replace(/\.json$/i, ".swf");
  const issues = parseIssuesQuery(issuesHeader);

  writeFileSync(jsonPath, `${JSON.stringify(animation, null, 2)}\n`, "utf8");
  for (const asset of externalAssets) {
    writeFileSync(resolve(outDir, asset.filename), Buffer.from(asset.dataBase64, "base64"));
  }
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        source: sourceHeader,
        issues
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  sendJson(response, 200, {
    ok: true,
    output: {
      json: `out/manual/${filename}`,
      meta: `out/manual/${stem}.meta.json`,
      assets: externalAssets.map((asset) => `out/manual/${asset.filename}`)
    },
    size: statSync(jsonPath).size
  });
}

function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolvePromise(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function sanitizeFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.toLowerCase().endsWith(".swf") ? cleaned : `${cleaned}.swf`;
}

function sanitizeJsonFilename(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.toLowerCase().endsWith(".json") ? cleaned : `${cleaned}.json`;
}

function sanitizeFixtureJsonName(filename: string, baseDir: string): string | null {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  if (
    !cleaned.toLowerCase().endsWith(".json") ||
    cleaned.toLowerCase().endsWith(".meta.json") ||
    cleaned.toLowerCase().endsWith(".error.json")
  ) {
    return null;
  }

  const absolutePath = resolve(baseDir, cleaned);
  try {
    if (!statSync(absolutePath).isFile()) {
      return null;
    }
  } catch {
    return null;
  }

  return cleaned;
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseIssuesQuery(serialized: string | null): unknown[] {
  if (!serialized) {
    return [];
  }

  try {
    const parsed = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeSavePayload(payload: unknown): {
  animation: unknown;
  externalAssets: ExportedBitmapAsset[];
} {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      animation: payload,
      externalAssets: []
    };
  }

  const candidate = payload as {
    animation?: unknown;
    externalAssets?: unknown;
  };
  const externalAssets = Array.isArray(candidate.externalAssets)
    ? candidate.externalAssets.filter(isExportedBitmapAsset)
    : [];

  return {
    animation: Object.prototype.hasOwnProperty.call(candidate, "animation") ? candidate.animation : payload,
    externalAssets
  };
}

function isExportedBitmapAsset(value: unknown): value is ExportedBitmapAsset {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ExportedBitmapAsset>;
  return typeof candidate.filename === "string" &&
    typeof candidate.dataBase64 === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.assetId === "string" &&
    typeof candidate.symbolId === "string";
}

function listExportedFixtures(
  sourceDir: string,
  hrefPrefix: string
): Array<{ name: string; size: number; href: string }> {
  return readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .filter((name) => !name.toLowerCase().endsWith(".meta.json"))
    .filter((name) => !name.toLowerCase().endsWith(".error.json"))
    .map((name) => {
      const absolutePath = resolve(sourceDir, name);
      return {
        name,
        size: statSync(absolutePath).size,
        href: `${hrefPrefix}${encodeURIComponent(name)}`
      };
    })
    .sort(compareFixtureExports);
}

function compareFixtureExports(
  left: { name: string; size: number; href: string },
  right: { name: string; size: number; href: string }
): number {
  const leftNumber = extractFixtureSequence(left.name);
  const rightNumber = extractFixtureSequence(right.name);

  if (leftNumber !== null && rightNumber !== null && leftNumber !== rightNumber) {
    return rightNumber - leftNumber;
  }

  if (leftNumber !== null && rightNumber === null) {
    return -1;
  }

  if (leftNumber === null && rightNumber !== null) {
    return 1;
  }

  return right.name.localeCompare(left.name);
}

function extractFixtureSequence(filename: string): number | null {
  const match = /testswf(\d+)/i.exec(filename);
  const value = match?.[1];
  return value ? Number.parseInt(value, 10) : null;
}

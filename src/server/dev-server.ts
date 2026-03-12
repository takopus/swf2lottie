import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";

import { convertSwfToLottie } from "../core/convert.js";
import { ConversionError } from "../core/issues.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const rootDir = resolve(process.cwd());
const webDir = resolve(rootDir, "src", "web");
const outDir = resolve(rootDir, "out", "manual");
const lottiePlayerPath = resolve(rootDir, "node_modules", "lottie-web", "build", "player", "lottie.min.js");

const staticFiles = new Map<string, { path: string; contentType: string }>([
  ["/", { path: resolve(webDir, "index.html"), contentType: "text/html; charset=utf-8" }],
  ["/app.js", { path: resolve(webDir, "app.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/styles.css", { path: resolve(webDir, "styles.css"), contentType: "text/css; charset=utf-8" }],
  ["/vendor/lottie.min.js", { path: lottiePlayerPath, contentType: "text/javascript; charset=utf-8" }]
]);

mkdirSync(outDir, { recursive: true });

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (request.method === "GET") {
      if (serveStatic(url.pathname, response)) {
        return;
      }

      sendJson(response, 404, { message: "Not found." });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/convert") {
      await handleConvertRequest(request, response, url);
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

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

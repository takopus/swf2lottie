import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";

import { buildStaticSite, outputDir } from "./build-static.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4174", 10);

await buildStaticSite();

const contentTypes = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".map", "application/json; charset=utf-8"]
]);

createServer((request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
    const filePath = resolve(outputDir, `.${pathname}`);

    if (!filePath.startsWith(outputDir) || !statSync(filePath).isFile()) {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ message: "Not found." }));
      return;
    }

    const contentType = contentTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    response.end(readFileSync(filePath));
  } catch {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ message: "Not found." }));
  }
}).listen(port, host, () => {
  process.stdout.write(`swf2lottie static preview listening at http://${host}:${port}\n`);
});

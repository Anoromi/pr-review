import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { createRouter } from "./router";
import { ReviewStore } from "./store";

const store = new ReviewStore();
const handler = createHTTPHandler({
  router: createRouter(store),
  basePath: "/trpc/",
  maxBodySize: 1024 * 1024,
});
const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const port = process.env.NODE_ENV === "production" ? 4318 : 4319;
const allowedHosts = new Set([
  "127.0.0.1:4317",
  "localhost:4317",
  "127.0.0.1:4318",
  "localhost:4318",
  "127.0.0.1:4319",
  "localhost:4319",
]);

const server = createServer(async (request, response) => {
  // This server can read private PRs using the local gh account. Keep it local.
  const origin = request.headers.origin;
  if (
    !allowedHosts.has(request.headers.host ?? "") ||
    (origin && ![...allowedHosts].some((host) => origin === `http://${host}`))
  ) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  if (request.url?.startsWith("/trpc/")) {
    await handler(request, response);
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    response.writeHead(404).end();
    return;
  }
  try {
    const root = resolve("dist");
    const pathname = decodeURIComponent(
      new URL(request.url ?? "/", "http://localhost").pathname,
    );
    const file = resolve(
      root,
      `.${pathname === "/" ? "/index.html" : pathname}`,
    );
    if (!file.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    response
      .writeHead(200, {
        "Content-Type": types[extname(file)] ?? "application/octet-stream",
      })
      .end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `PR Review API: http://127.0.0.1:${port}\nReviews: ${store.root}`,
  ),
);

import { createServer as createHttpServer } from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendAssetFile } from "./compressed-assets.mjs";
import { handleHealthRequest } from "./health.mjs";
import { handleHorizonsRequest } from "./horizons.mjs";
import { handleModelAssetRequest } from "./model-assets.mjs";
import { handleObjectInfoRequest } from "./object-info.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST_ROOT = path.join(REPO_ROOT, "dist");
const DEFAULT_PORT = 4173;
const HOST = process.env.HOST || "127.0.0.1";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".bin", "application/octet-stream"],
  [".geojson", "application/geo+json; charset=utf-8"],
  [".glb", "model/gltf-binary"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".wgsl", "text/plain; charset=utf-8"],
]);

const SPA_ASSET_PREFIXES = ["/assets/", "/cache/", "/data/", "/draco/", "/models/", "/textures/"];

function setIsolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
}

function safeStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolved = path.resolve(DIST_ROOT, relative);
  return resolved.startsWith(`${DIST_ROOT}${path.sep}`) || resolved === DIST_ROOT ? resolved : null;
}

function isSpaAssetRequest(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return true;
  }
  if (SPA_ASSET_PREFIXES.some(prefix => decoded.startsWith(prefix))) return true;
  return path.extname(decoded) !== "";
}

async function resolveStaticFile(urlPath) {
  const requested = safeStaticPath(urlPath);
  if (!requested) return null;

  try {
    const info = await stat(requested);
    if (info.isFile()) return requested;
    if (info.isDirectory()) {
      const indexFile = path.join(requested, "index.html");
      const indexInfo = await stat(indexFile);
      if (indexInfo.isFile()) return indexFile;
    }
  } catch {
    // SPA fallback below.
  }

  if (isSpaAssetRequest(urlPath)) return null;
  return path.join(DIST_ROOT, "index.html");
}

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { "Allow": "GET, HEAD" });
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const filePath = await resolveStaticFile(url.pathname);
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  let fileInfo;
  try {
    fileInfo = await stat(filePath);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Build output not found. Run npm run build first.");
    return;
  }

  const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
  sendAssetFile(req, res, {
    filePath,
    size: fileInfo.size,
    contentType,
    headers: {
      "Cache-Control": path.basename(filePath) === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function listenOnAvailablePort(makeServer, preferredPort, host) {
  const firstPort = Number.parseInt(process.env.PORT || "", 10) || preferredPort;
  for (let port = firstPort; port < firstPort + 20; port++) {
    const server = makeServer();
    try {
      await listen(server, port, host);
      return { server, port };
    } catch (err) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`No available port found from ${firstPort} to ${firstPort + 19}`);
}

function makeServer() {
  return createHttpServer(async (req, res) => {
    setIsolationHeaders(res);
    if (handleHealthRequest(req, res)) return;
    if (await handleHorizonsRequest(req, res)) return;
    if (await handleModelAssetRequest(req, res)) return;
    if (await handleObjectInfoRequest(req, res)) return;
    await serveStatic(req, res);
  });
}

const { server, port } = await listenOnAvailablePort(makeServer, DEFAULT_PORT, HOST);
const publicHost = HOST === "0.0.0.0" ? "localhost" : HOST;
console.log(`CosmosMap server: http://${publicHost}:${port}/`);

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

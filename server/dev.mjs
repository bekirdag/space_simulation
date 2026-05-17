import { createReadStream } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { handleHealthRequest } from "./health.mjs";
import { handleHorizonsRequest } from "./horizons.mjs";
import { handleModelAssetRequest } from "./model-assets.mjs";
import { handleObjectInfoRequest } from "./object-info.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PUBLIC_ROOT = path.join(REPO_ROOT, "public");
const DEFAULT_PORT = 5173;
const HOST = process.env.HOST || "127.0.0.1";
const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
let vite = null;

const MIME_TYPES = new Map([
  [".bin", "application/octet-stream"],
  [".glb", "model/gltf-binary"],
  [".geojson", "application/geo+json; charset=utf-8"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".stl", "application/vnd.ms-pki.stl"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".wasm", "application/wasm"],
]);

function publicHostFor(host) {
  return host === "0.0.0.0" ? "localhost" : host;
}

function setIsolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
}

function isBrowserCacheablePublicPath(pathname) {
  return pathname.startsWith("/data/") ||
    pathname.startsWith("/textures/") ||
    pathname.startsWith("/cache/") ||
    pathname.startsWith("/draco/") ||
    pathname === "/logo.png" ||
    pathname === "/favicon.ico" ||
    pathname === "/favicon.png" ||
    pathname === "/apple-touch-icon.png";
}

function safePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const resolved = path.resolve(PUBLIC_ROOT, relative);
  return resolved.startsWith(`${PUBLIC_ROOT}${path.sep}`) ? resolved : null;
}

async function serveBrowserCachedPublicAsset(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(req.url ?? "/", "http://localhost");
  if (!isBrowserCacheablePublicPath(url.pathname)) return false;

  const filePath = safePublicPath(url.pathname);
  if (!filePath) return false;

  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const contentType = MIME_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(info.size),
    "Cache-Control": ASSET_CACHE_CONTROL,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
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

function makeServer() {
  return createHttpServer(async (req, res) => {
    setIsolationHeaders(res);
    if (handleHealthRequest(req, res)) return;
    if (await handleHorizonsRequest(req, res)) return;
    if (await handleModelAssetRequest(req, res)) return;
    if (await handleObjectInfoRequest(req, res)) return;
    if (await serveBrowserCachedPublicAsset(req, res)) return;
    if (!vite) {
      res.statusCode = 503;
      res.end("CosmosMap dev server is starting");
      return;
    }
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });
}

async function createViteForServer(server, port, host) {
  return await createViteServer({
    appType: "spa",
    server: {
      host,
      port,
      middlewareMode: true,
      hmr: {
        server,
        host: publicHostFor(host),
        port,
        clientPort: port,
      },
    },
  });
}

async function listenOnAvailablePort(preferredPort, host) {
  const firstPort = Number.parseInt(process.env.PORT || "", 10) || preferredPort;
  for (let port = firstPort; port < firstPort + 20; port++) {
    const server = makeServer();
    const nextVite = await createViteForServer(server, port, host);
    vite = nextVite;
    try {
      await listen(server, port, host);
      return { server, port, vite: nextVite };
    } catch (err) {
      vite = null;
      await nextVite.close();
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`No available port found from ${firstPort} to ${firstPort + 19}`);
}

const { server, port } = await listenOnAvailablePort(DEFAULT_PORT, HOST);
const publicHost = publicHostFor(HOST);
console.log(`CosmosMap dev server: http://${publicHost}:${port}/`);

async function shutdown() {
  server.close();
  await vite?.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

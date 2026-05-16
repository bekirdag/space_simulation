import { createReadStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE_ROOT = process.env.COSMOSMAP_MODEL_CACHE_DIR
  ? path.resolve(process.env.COSMOSMAP_MODEL_CACHE_DIR)
  : path.join(REPO_ROOT, "cache", "nasa", "models");
const MAX_MODEL_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45_000;

const MODEL_ASSETS = new Map([
  ["crab-nebula", {
    filename: "crab-nebula.glb",
    contentType: "model/gltf-binary",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/printable/crab-nebula/Crab%20Nebula.glb",
  }],
  ["cassiopeia-a", {
    filename: "cassiopeia-a.glb",
    contentType: "model/gltf-binary",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/cassiopeia-a-supernova/Cassiopeia%20A%20Supernova.glb",
  }],
  ["cassiopeia-a-green-monster-2023", {
    filename: "cassiopeia-a-green-monster-2023.glb",
    contentType: "model/gltf-binary",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/cassiopeia-a-supernova-(b)-(2023)/Cassiopeia%20A%20Supernova%20(B)%20(2023).glb",
  }],
  ["cassiopeia-a-iron-2025", {
    filename: "cassiopeia-a-iron-2025.glb",
    contentType: "model/gltf-binary",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/cassiopeia-a-supernova-(c)-(2025)/Cassiopeia%20A%20Supernova%20(C)%20(2025).glb",
  }],
  ["g292-supernova-remnant", {
    filename: "g292-supernova-remnant.glb",
    contentType: "model/gltf-binary",
    upstream: "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master/3D%20Models/G292.0+1.8%20Supernova%20Remnant/G292.0+1.8%20Supernova%20Remnant.glb",
  }],
  ["cygnus-loop-supernova", {
    filename: "cygnus-loop-supernova.glb",
    contentType: "model/gltf-binary",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/cygnus-loop-supernova/Cygnus%20Loop%20Supernova.glb",
  }],
  ["bp-tauri", {
    filename: "bp-tauri.glb",
    contentType: "model/gltf-binary",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/model/bp-tauri/BP%20Tauri.glb",
  }],
  ["dg-tau", {
    filename: "dg-tau.stl",
    contentType: "application/vnd.ms-pki.stl",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/printable/dg-tau/DG%20Tau.stl",
  }],
  ["u-scorpii", {
    filename: "u-scorpii.stl",
    contentType: "application/vnd.ms-pki.stl",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/printable/u-scorpii/U%20Scorpii.stl",
  }],
  ["sn-1006-ejecta", {
    filename: "sn-1006-ejecta.stl",
    contentType: "application/vnd.ms-pki.stl",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/printable/sn-1006/Ejecta%20full%20globe.stl",
  }],
  ["tycho-supernova-inner", {
    filename: "tycho-supernova-inner.stl",
    contentType: "application/vnd.ms-pki.stl",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/printable/tycho-supernova-remnant/Tycho%20Supernova%20Remnant%20(left%20inner).stl",
  }],
  ["pillars-of-creation-pillar", {
    filename: "pillars-of-creation-pillar.stl",
    contentType: "application/vnd.ms-pki.stl",
    upstream: "https://assets.science.nasa.gov/content/dam/science/cds/3d/resources/printable/pillars-of-creation/Pillars%20of%20Creation%20(pillar%201B).stl",
  }],
]);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res) {
  res.writeHead(405, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Allow": "GET, HEAD, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}

async function downloadToCache(asset, cachePath) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(asset.upstream, {
      signal: controller.signal,
      headers: { "User-Agent": "CosmosMap/0.1 model-cache" },
    });
    if (!response.ok) {
      throw new Error(`upstream ${response.status}`);
    }

    const contentLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_MODEL_BYTES) {
      throw new Error("upstream model too large");
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error("upstream response body unavailable");

    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_MODEL_BYTES) throw new Error("upstream model too large");
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    await import("node:fs/promises").then(({ writeFile }) => writeFile(tempPath, merged));
    await rename(tempPath, cachePath);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureCached(asset) {
  const cachePath = path.join(CACHE_ROOT, asset.filename);
  try {
    const info = await stat(cachePath);
    if (info.isFile() && info.size > 0) return { cachePath, size: info.size, cacheState: "hit" };
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }

  await downloadToCache(asset, cachePath);
  const info = await stat(cachePath);
  return { cachePath, size: info.size, cacheState: "miss" };
}

function modelIdFromPath(urlPath) {
  const prefix = "/api/model-assets/";
  if (!urlPath.startsWith(prefix)) return null;
  return decodeURIComponent(urlPath.slice(prefix.length).replace(/\/+$/, ""));
}

export async function handleModelAssetRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const id = modelIdFromPath(url.pathname);
  if (id === null) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res);
    return true;
  }

  const asset = MODEL_ASSETS.get(id);
  if (!asset) {
    sendJson(res, 404, { error: "unknown_model_asset" });
    return true;
  }

  try {
    const { cachePath, size, cacheState } = await ensureCached(asset);
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": asset.contentType,
      "Content-Length": String(size),
      "Cache-Control": "public, max-age=86400",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "X-CosmosMap-Cache": cacheState,
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(cachePath).pipe(res);
  } catch (err) {
    console.warn(`Model asset fetch failed for ${id}:`, err);
    sendJson(res, 502, { error: "model_asset_fetch_failed" });
  }
  return true;
}

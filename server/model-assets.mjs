import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendAssetFile } from "./compressed-assets.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE_ROOT = process.env.COSMOSMAP_MODEL_CACHE_DIR
  ? path.resolve(process.env.COSMOSMAP_MODEL_CACHE_DIR)
  : path.join(REPO_ROOT, "cache", "nasa", "models");
const MAX_MODEL_BYTES = 128 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 45_000;
const NASA_3D_RAW_BASE = "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master";
const GLB_CONTENT_TYPE = "model/gltf-binary";
const USDZ_CONTENT_TYPE = "model/vnd.usdz+zip";
const MODEL_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

function nasa3d(pathname) {
  return `${NASA_3D_RAW_BASE}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

function glb(filename, pathname) {
  return { filename, contentType: GLB_CONTENT_TYPE, upstream: nasa3d(pathname) };
}

function glbUrl(filename, upstream) {
  return { filename, contentType: GLB_CONTENT_TYPE, upstream };
}

function usdzUrl(filename, upstream) {
  return { filename, contentType: USDZ_CONTENT_TYPE, upstream };
}

const MODEL_ASSETS = new Map([
  ["solar-sun", usdzUrl("solar-sun.usdz", "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/s/Sun_1_1391000.usdz")],
  ["solar-mercury", glbUrl("solar-mercury.glb", "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/m/Mercury_1_4878.glb")],
  ["solar-venus", glbUrl("solar-venus.glb", "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/v/Venus_1_12103.glb")],
  ["solar-earth", glbUrl("solar-earth.glb", "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/e/Earth_1_12756.glb")],
  ["solar-mars", glbUrl("solar-mars.glb", "https://assets.science.nasa.gov/content/dam/science/psd/mars/resources/gltf_files/24881_Mars_1_6792.glb")],
  ["solar-jupiter", glbUrl("solar-jupiter.glb", "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/j/Jupiter_1_142984.glb")],
  ["solar-saturn", glbUrl("solar-saturn.glb", "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/s/Saturn_1_120536.glb")],
  ["solar-uranus", glbUrl("solar-uranus.glb", "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/u/Uranus_1_51118.glb")],
  ["solar-neptune", glbUrl("solar-neptune.glb", "https://assets.science.nasa.gov/content/dam/science/psd/solar/2023/09/n/Neptune_1_49528.glb")],
  ["crab-nebula", glb("crab-nebula.glb", "3D Printing/Crab Nebula/Crab Nebula.glb")],
  ["cassiopeia-a", glb("cassiopeia-a.glb", "3D Models/Cassiopeia A Supernova/Cassiopeia A Supernova.glb")],
  ["cassiopeia-a-green-monster-2023", glb("cassiopeia-a-green-monster-2023.glb", "3D Models/Cassiopeia A Supernova (B) (2023)/Cassiopeia A Supernova (B) (2023).glb")],
  ["cassiopeia-a-iron-2025", glb("cassiopeia-a-iron-2025.glb", "3D Models/Cassiopeia A Supernova (C) (2025)/Cassiopeia A Supernova (C) (2025).glb")],
  ["g292-supernova-remnant", glb("g292-supernova-remnant.glb", "3D Models/G292.0+1.8 Supernova Remnant/G292.0+1.8 Supernova Remnant.glb")],
  ["cygnus-loop-supernova", glb("cygnus-loop-supernova.glb", "3D Models/Cygnus Loop Supernova/Cygnus Loop Supernova.glb")],
  ["bp-tauri", glb("bp-tauri.glb", "3D Models/BP Tauri/BP Tauri.glb")],
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

async function downloadUpstreamToFile(asset, outputPath) {
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

    await writeFile(outputPath, merged);
  } finally {
    clearTimeout(timeout);
  }
}

async function readHeader(filePath, byteLength) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function isValidModelFile(asset, filePath) {
  const info = await stat(filePath);
  if (!info.isFile() || info.size <= 0) return false;

  if (asset.contentType === GLB_CONTENT_TYPE) {
    const header = await readHeader(filePath, 12);
    if (header.length < 12 || header.subarray(0, 4).toString("ascii") !== "glTF") return false;
    const declaredLength = header.readUInt32LE(8);
    return declaredLength === info.size;
  }

  if (asset.contentType === USDZ_CONTENT_TYPE) {
    const header = await readHeader(filePath, 4);
    return header.length >= 4 && header.subarray(0, 2).toString("ascii") === "PK";
  }

  return true;
}

async function assertValidModelFile(asset, filePath) {
  if (!(await isValidModelFile(asset, filePath))) {
    throw new Error("downloaded model failed format validation");
  }
}

async function downloadToCache(asset, cachePath) {
  await mkdir(path.dirname(cachePath), { recursive: true });
  const tempPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await downloadUpstreamToFile(asset, tempPath);
    await assertValidModelFile(asset, tempPath);
    await rename(tempPath, cachePath);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  }
}

async function ensureCached(asset) {
  const cachePath = path.join(CACHE_ROOT, asset.filename);
  try {
    const info = await stat(cachePath);
    if (info.isFile() && info.size > 0 && await isValidModelFile(asset, cachePath)) {
      return { cachePath, size: info.size, cacheState: "hit" };
    }
    await unlink(cachePath).catch(() => {});
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
    sendAssetFile(req, res, {
      filePath: cachePath,
      size,
      contentType: asset.contentType,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": MODEL_ASSET_CACHE_CONTROL,
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "X-CosmosMap-Cache": cacheState,
      },
    });
  } catch (err) {
    console.warn(`Model asset fetch failed for ${id}:`, err);
    sendJson(res, 502, { error: "model_asset_fetch_failed" });
  }
  return true;
}

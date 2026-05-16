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
const NASA_3D_RAW_BASE = "https://raw.githubusercontent.com/nasa/NASA-3D-Resources/master";
const GLB_CONTENT_TYPE = "model/gltf-binary";
const STL_CONTENT_TYPE = "application/vnd.ms-pki.stl";

function nasa3d(pathname) {
  return `${NASA_3D_RAW_BASE}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

function glb(filename, pathname) {
  return { filename, contentType: GLB_CONTENT_TYPE, upstream: nasa3d(pathname) };
}

function stl(filename, pathname) {
  return { filename, contentType: STL_CONTENT_TYPE, upstream: nasa3d(pathname) };
}

const MODEL_ASSETS = new Map([
  ["crab-nebula", glb("crab-nebula.glb", "3D Printing/Crab Nebula/Crab Nebula.glb")],
  ["crab-nebula-disc", stl("crab-nebula-disc.stl", "3D Printing/Crab Nebula/Crab Nebula (disc).stl")],
  ["crab-nebula-jet-1", stl("crab-nebula-jet-1.stl", "3D Printing/Crab Nebula/Crab Nebula (jet 1).stl")],
  ["crab-nebula-jet-2", stl("crab-nebula-jet-2.stl", "3D Printing/Crab Nebula/Crab Nebula (jet 2).stl")],
  ["cassiopeia-a", glb("cassiopeia-a.glb", "3D Models/Cassiopeia A Supernova/Cassiopeia A Supernova.glb")],
  ["cassiopeia-a-green-monster-2023", glb("cassiopeia-a-green-monster-2023.glb", "3D Models/Cassiopeia A Supernova (B) (2023)/Cassiopeia A Supernova (B) (2023).glb")],
  ["cassiopeia-a-iron-2025", glb("cassiopeia-a-iron-2025.glb", "3D Models/Cassiopeia A Supernova (C) (2025)/Cassiopeia A Supernova (C) (2025).glb")],
  ["g292-supernova-remnant", glb("g292-supernova-remnant.glb", "3D Models/G292.0+1.8 Supernova Remnant/G292.0+1.8 Supernova Remnant.glb")],
  ["cygnus-loop-supernova", glb("cygnus-loop-supernova.glb", "3D Models/Cygnus Loop Supernova/Cygnus Loop Supernova.glb")],
  ["bp-tauri", glb("bp-tauri.glb", "3D Models/BP Tauri/BP Tauri.glb")],
  ["dg-tau", stl("dg-tau.stl", "3D Printing/DG Tau/DG Tau.stl")],
  ["u-scorpii", stl("u-scorpii.stl", "3D Printing/U Scorpii/U Scorpii.stl")],
  ["sn-1006-ejecta", stl("sn-1006-ejecta.stl", "3D Printing/SN 1006/Ejecta full globe.stl")],
  ["sn-1006-blast-quarter", stl("sn-1006-blast-quarter.stl", "3D Printing/SN 1006/Blast quarter globe.stl")],
  ["sn-1006-ejecta-quarter", stl("sn-1006-ejecta-quarter.stl", "3D Printing/SN 1006/Ejecta quarter globe.stl")],
  ["tycho-supernova-inner", stl("tycho-supernova-inner.stl", "3D Printing/Tycho Supernova Remnant/Tycho Supernova Remnant (left inner).stl")],
  ["tycho-supernova-left-outer", stl("tycho-supernova-left-outer.stl", "3D Printing/Tycho Supernova Remnant/Tycho Supernova Remnant (left outer).stl")],
  ["tycho-supernova-right-inner", stl("tycho-supernova-right-inner.stl", "3D Printing/Tycho Supernova Remnant/Tycho Supernova Remnant (right inner).stl")],
  ["tycho-supernova-right-outer", stl("tycho-supernova-right-outer.stl", "3D Printing/Tycho Supernova Remnant/Tycho Supernova Remnant (right outer).stl")],
  ["eta-carinae-homunculus", stl("eta-carinae-homunculus.stl", "3D Printing/Eta Carinae Homunculus Nebula/Eta Carinae Homunculus Nebula.stl")],
  ["eta-carinae-high-mdot-apastron-wind", stl("eta-carinae-high-mdot-apastron-wind.stl", "3D Printing/Eta Carinae Homunculus Nebula (High Mass-Loss Rate)/ApastronHighMdotPrimaryWind.stl")],
  ["eta-carinae-high-mdot-periastron-shock", stl("eta-carinae-high-mdot-periastron-shock.stl", "3D Printing/Eta Carinae Homunculus Nebula (High Mass-Loss Rate)/PeriastronHighMdotWWCR.stl")],
  ["eta-carinae-low-mdot-periastron-shock", stl("eta-carinae-low-mdot-periastron-shock.stl", "3D Printing/Eta Carinae Homunculus Nebula (Low Mass-Loss Rate)/PeriastronLowMdotWWCR.stl")],
  ["pillars-of-creation-pillar", stl("pillars-of-creation-pillar.stl", "3D Printing/Pillars of Creation/Pillars of Creation (pillar 1B).stl")],
  ["pillars-of-creation-full", stl("pillars-of-creation-full.stl", "3D Printing/Pillars of Creation/Pillars of Creation (full).stl")],
  ["pillars-of-creation-pillar-1a", stl("pillars-of-creation-pillar-1a.stl", "3D Printing/Pillars of Creation/Pillars of Creation (pillar 1A).stl")],
  ["pillars-of-creation-pillar-2", stl("pillars-of-creation-pillar-2.stl", "3D Printing/Pillars of Creation/Pillars of Creation (pillar 2).stl")],
  ["pillars-of-creation-pillar-3", stl("pillars-of-creation-pillar-3.stl", "3D Printing/Pillars of Creation/Pillars of Creation (pillar 3).stl")],
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

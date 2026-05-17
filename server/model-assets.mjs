import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
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
const STL_CONTENT_TYPE = "application/vnd.ms-pki.stl";
const MODEL_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

function nasa3d(pathname) {
  return `${NASA_3D_RAW_BASE}/${pathname.split("/").map(encodeURIComponent).join("/")}`;
}

function glb(filename, pathname) {
  return { filename, contentType: GLB_CONTENT_TYPE, upstream: nasa3d(pathname) };
}

function stl(filename, pathname) {
  return { filename, contentType: STL_CONTENT_TYPE, upstream: nasa3d(pathname) };
}

function stlArchive(filename, pathname, archiveMember) {
  return {
    filename,
    contentType: STL_CONTENT_TYPE,
    upstream: nasa3d(pathname),
    archiveMember,
  };
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
  ["eta-carinae-high-mdot-apastron-shock", stl("eta-carinae-high-mdot-apastron-shock.stl", "3D Printing/Eta Carinae Homunculus Nebula (High Mass-Loss Rate)/ApastronHighMdotWWCR.stl")],
  ["eta-carinae-high-mdot-periastron-wind", stl("eta-carinae-high-mdot-periastron-wind.stl", "3D Printing/Eta Carinae Homunculus Nebula (High Mass-Loss Rate)/PeriastronHighMdotPrimaryWind.stl")],
  ["eta-carinae-high-mdot-periastron-shock", stl("eta-carinae-high-mdot-periastron-shock.stl", "3D Printing/Eta Carinae Homunculus Nebula (High Mass-Loss Rate)/PeriastronHighMdotWWCR.stl")],
  ["eta-carinae-high-mdot-phase1045-wind", stl("eta-carinae-high-mdot-phase1045-wind.stl", "3D Printing/Eta Carinae Homunculus Nebula (High Mass-Loss Rate)/Phase1p045HighMdotPrimaryWind.stl")],
  ["eta-carinae-high-mdot-phase1045-shock", stl("eta-carinae-high-mdot-phase1045-shock.stl", "3D Printing/Eta Carinae Homunculus Nebula (High Mass-Loss Rate)/Phase1p045HighMdotWWCR.stl")],
  ["eta-carinae-low-mdot-apastron-wind", stl("eta-carinae-low-mdot-apastron-wind.stl", "3D Printing/Eta Carinae Homunculus Nebula (Low Mass-Loss Rate)/ApastronLowMdotPrimaryWind.stl")],
  ["eta-carinae-low-mdot-apastron-shock", stl("eta-carinae-low-mdot-apastron-shock.stl", "3D Printing/Eta Carinae Homunculus Nebula (Low Mass-Loss Rate)/ApastronLowMdotWWCR.stl")],
  ["eta-carinae-low-mdot-periastron-wind", stl("eta-carinae-low-mdot-periastron-wind.stl", "3D Printing/Eta Carinae Homunculus Nebula (Low Mass-Loss Rate)/PeriastronLowMdotPrimaryWind.stl")],
  ["eta-carinae-low-mdot-periastron-shock", stl("eta-carinae-low-mdot-periastron-shock.stl", "3D Printing/Eta Carinae Homunculus Nebula (Low Mass-Loss Rate)/PeriastronLowMdotWWCR.stl")],
  ["eta-carinae-low-mdot-phase1045-wind", stl("eta-carinae-low-mdot-phase1045-wind.stl", "3D Printing/Eta Carinae Homunculus Nebula (Low Mass-Loss Rate)/Phase1p045LowMdotPrimaryWind.stl")],
  ["eta-carinae-low-mdot-phase1045-shock", stl("eta-carinae-low-mdot-phase1045-shock.stl", "3D Printing/Eta Carinae Homunculus Nebula (Low Mass-Loss Rate)/Phase1p045LowMdotWWCR.stl")],
  ["pillars-of-creation-pillar", stl("pillars-of-creation-pillar.stl", "3D Printing/Pillars of Creation/Pillars of Creation (pillar 1B).stl")],
  ["pillars-of-creation-full", stl("pillars-of-creation-full.stl", "3D Printing/Pillars of Creation/Pillars of Creation (full).stl")],
  ["pillars-of-creation-mini", stl("pillars-of-creation-mini.stl", "3D Printing/Pillars of Creation/Pillars of Creation (mini).stl")],
  ["pillars-of-creation-positions", stl("pillars-of-creation-positions.stl", "3D Printing/Pillars of Creation/Pillars of Creation (positions).stl")],
  ["pillars-of-creation-pillar-1a", stl("pillars-of-creation-pillar-1a.stl", "3D Printing/Pillars of Creation/Pillars of Creation (pillar 1A).stl")],
  ["pillars-of-creation-pillar-2", stl("pillars-of-creation-pillar-2.stl", "3D Printing/Pillars of Creation/Pillars of Creation (pillar 2).stl")],
  ["pillars-of-creation-pillar-3", stl("pillars-of-creation-pillar-3.stl", "3D Printing/Pillars of Creation/Pillars of Creation (pillar 3).stl")],
  ["ic-443-blastwave", stlArchive(
    "ic-443-blastwave.stl",
    "3D Printing/IC 443 (Jellyfish Nebula)/IC 443 (Jellyfish Nebula) Blastwave.7z",
    "IC 443 (Jellyfish Nebula) Blastwave.stl",
  )],
  ["ic-443-ejecta-torus", stlArchive(
    "ic-443-ejecta-torus.stl",
    "3D Printing/IC 443 (Jellyfish Nebula)/IC 443 (Jellyfish Nebula) Ejecta and torus.7z",
    "IC 443 (Jellyfish Nebula) Ejecta and torus.stl",
  )],
  ["ic-443-ejecta-cross-section-pwn-torus", stlArchive(
    "ic-443-ejecta-cross-section-pwn-torus.stl",
    "3D Printing/IC 443 (Jellyfish Nebula)/IC 443 (Jellyfish Nebula) Ejecta cross section with PWN and torus.7z",
    "IC 443 (Jellyfish Nebula) Ejecta cross section with PWN and torus.stl",
  )],
  ["ic-443-ejecta-cross-section-pwn", stlArchive(
    "ic-443-ejecta-cross-section-pwn.stl",
    "3D Printing/IC 443 (Jellyfish Nebula)/IC 443 (Jellyfish Nebula) Ejecta cross section with PWN.7z",
    "IC 443 (Jellyfish Nebula) Ejecta cross section with PWN.stl",
  )],
  ["ic-443-ejecta-torus-blast", stlArchive(
    "ic-443-ejecta-torus-blast.stl",
    "3D Printing/IC 443 (Jellyfish Nebula)/IC 443 (Jellyfish Nebula) Ejecta torus blast.7z",
    "IC 443 (Jellyfish Nebula) Ejecta torus blast.stl",
  )],
  ["ic-443-ejecta", stlArchive(
    "ic-443-ejecta.stl",
    "3D Printing/IC 443 (Jellyfish Nebula)/IC 443 (Jellyfish Nebula) Ejecta.7z",
    "IC 443 (Jellyfish Nebula) Ejecta.stl",
  )],
  ["ic-443-molecular-cloud-torus", stlArchive(
    "ic-443-molecular-cloud-torus.stl",
    "3D Printing/IC 443 (Jellyfish Nebula)/IC 443 (Jellyfish Nebula) Molecular cloud torus.7z",
    "IC 443 (Jellyfish Nebula) Molecular cloud torus.stl",
  )],
]);

const ARCHIVE_EXTRACTORS = [
  { command: "bsdtar", args: (archivePath, member) => ["-xOf", archivePath, member] },
  { command: "7zz", args: (archivePath, member) => ["x", "-so", archivePath, member] },
  { command: "7z", args: (archivePath, member) => ["x", "-so", archivePath, member] },
];
let archiveExtractorPromise = null;

function canRun(command) {
  return new Promise(resolve => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(true));
  });
}

async function archiveExtractor() {
  if (!archiveExtractorPromise) {
    archiveExtractorPromise = (async () => {
      for (const extractor of ARCHIVE_EXTRACTORS) {
        if (await canRun(extractor.command)) return extractor;
      }
      return null;
    })();
  }
  return archiveExtractorPromise;
}

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

async function extractArchiveMember(archivePath, member, outputPath) {
  const extractor = await archiveExtractor();
  if (!extractor) {
    throw new Error("no local 7z-compatible extractor found for archived model");
  }

  const child = spawn(extractor.command, extractor.args(archivePath, member), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => {
    if (stderr.length < 4096) stderr += chunk.toString("utf8");
  });

  const exitPromise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`${extractor.command} exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });

  await Promise.all([
    pipeline(child.stdout, createWriteStream(outputPath)),
    exitPromise,
  ]);
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

  if (asset.contentType === STL_CONTENT_TYPE) {
    const header = await readHeader(filePath, 84);
    if (header.length < 84) return false;
    const triangles = header.readUInt32LE(80);
    return 84 + triangles * 50 === info.size;
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
  const tempArchivePath = `${tempPath}.archive`;

  try {
    if (asset.archiveMember) {
      await downloadUpstreamToFile(asset, tempArchivePath);
      await extractArchiveMember(tempArchivePath, asset.archiveMember, tempPath);
      const extracted = await stat(tempPath);
      if (!extracted.isFile() || extracted.size <= 0) {
        throw new Error("archived model extraction produced no data");
      }
      if (extracted.size > MAX_MODEL_BYTES) {
        throw new Error("extracted model too large");
      }
    } else {
      await downloadUpstreamToFile(asset, tempPath);
    }

    await assertValidModelFile(asset, tempPath);
    await rename(tempPath, cachePath);
  } catch (err) {
    await unlink(tempPath).catch(() => {});
    throw err;
  } finally {
    await unlink(tempArchivePath).catch(() => {});
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

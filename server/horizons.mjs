import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api";
const CACHE_SCHEMA = "celestia.horizons.v1";
const CACHE_ROOT = process.env.COSMOSMAP_HORIZONS_CACHE_DIR
  ? path.resolve(process.env.COSMOSMAP_HORIZONS_CACHE_DIR)
  : path.join(REPO_ROOT, "cache", "nasa", "horizons");
const PUBLIC_CACHE_ROOT = path.join(REPO_ROOT, "public", "cache", "horizons");
const D2Y = 365.25;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const inFlight = new Map();

const TARGETS = [
  ["Sun", "10"],
  ["Mercury", "199"],
  ["Venus", "299"],
  ["Earth", "399"],
  ["Mars", "499"],
  ["Jupiter", "599"],
  ["Saturn", "699"],
  ["Uranus", "799"],
  ["Neptune", "899"],
  ["Moon", "301"],
  ["Io", "501"],
  ["Europa", "502"],
  ["Ganymede", "503"],
  ["Callisto", "504"],
  ["Mimas", "601"],
  ["Enceladus", "602"],
  ["Tethys", "603"],
  ["Dione", "604"],
  ["Rhea", "605"],
  ["Titan", "606"],
  ["Iapetus", "608"],
  ["Miranda", "705"],
  ["Ariel", "701"],
  ["Umbriel", "702"],
  ["Titania", "703"],
  ["Oberon", "704"],
  ["Triton", "801"],
  ["Pluto", "999"],
  ["Charon", "901"],
  ["Ceres", "1;"],
  ["Eris", "136199;"],
  ["Haumea", "136108;"],
  ["Makemake", "136472;"],
];

function utcDateStr(date) {
  return date.toISOString().slice(0, 10);
}

function nextUtcDate(dateStr) {
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return utcDateStr(next);
}

function normalizeDate(input) {
  const raw = String(input || utcDateStr(new Date())).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && utcDateStr(parsed) === raw ? raw : null;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cacheFileFor(dateStr) {
  return path.join(CACHE_ROOT, `${dateStr}.json`);
}

function publicCacheFileFor(dateStr) {
  return path.join(PUBLIC_CACHE_ROOT, `${dateStr}.json`);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isStateVector(value) {
  return value &&
    typeof value.name === "string" &&
    isFiniteNumber(value.x) && isFiniteNumber(value.y) && isFiniteNumber(value.z) &&
    isFiniteNumber(value.vx) && isFiniteNumber(value.vy) && isFiniteNumber(value.vz);
}

function normalizeSnapshot(raw, dateStr) {
  if (!raw || raw.schema !== CACHE_SCHEMA || raw.date !== dateStr || !Array.isArray(raw.vectors)) {
    return null;
  }
  const vectors = raw.vectors.filter(isStateVector);
  if (vectors.length === 0) return null;
  return {
    schema: CACHE_SCHEMA,
    date: dateStr,
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "",
    source: typeof raw.source === "string" ? raw.source : "NASA/JPL Horizons API",
    frame: {
      center: "500@0",
      centerName: "Solar System Barycenter",
      refPlane: "ECLIPTIC",
      refSystem: "ICRF",
      units: "AU, AU/yr",
    },
    vectors,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(w => typeof w === "string") : [],
    targetCount: Number.isFinite(raw.targetCount) ? raw.targetCount : TARGETS.length,
    ...(typeof raw.apiVersion === "string" ? { apiVersion: raw.apiVersion } : {}),
  };
}

async function readSnapshot(filePath, dateStr) {
  try {
    return normalizeSnapshot(JSON.parse(await readFile(filePath, "utf8")), dateStr);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function writeSnapshot(filePath, snapshot) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

function withCacheStatus(snapshot, cacheStatus, extra = {}) {
  return {
    ...snapshot,
    cacheStatus,
    cacheHit: cacheStatus !== "network",
    ...extra,
  };
}

function parseVector(name, text) {
  const i0 = text.indexOf("$$SOE");
  const i1 = text.indexOf("$$EOE");
  if (i0 === -1 || i1 === -1) throw new Error(`No ephemeris for ${name}`);

  const lines = text.slice(i0 + 5, i1).split("\n").filter(line => line.trim());
  const posLine = lines.find(line => /\bX\s*=/.test(line) && /\bY\s*=/.test(line) && /\bZ\s*=/.test(line) && !/\bVX\s*=/.test(line));
  const velLine = lines.find(line => /\bVX\s*=/.test(line) && /\bVY\s*=/.test(line) && /\bVZ\s*=/.test(line));
  if (!posLine || !velLine) throw new Error(`No vectors for ${name}`);

  const nums = line => [...line.matchAll(/([-+]?\d+\.\d+[Ee][+-]\d+)/g)].map(match => Number.parseFloat(match[1]));
  const p = nums(posLine);
  const v = nums(velLine);
  if (p.length < 3 || v.length < 3) throw new Error(`Incomplete data for ${name}`);

  return {
    name,
    x: p[0], y: p[1], z: p[2],
    vx: v[0] * D2Y, vy: v[1] * D2Y, vz: v[2] * D2Y,
  };
}

async function fetchTarget([name, command], dateStr) {
  const params = new URLSearchParams({
    format: "json",
    COMMAND: command,
    OBJ_DATA: "NO",
    MAKE_EPHEM: "YES",
    EPHEM_TYPE: "VECTORS",
    CENTER: "500@0",
    START_TIME: dateStr,
    STOP_TIME: nextUtcDate(dateStr),
    STEP_SIZE: "1d",
    OUT_UNITS: "AU-D",
    TIME_TYPE: "UT",
    TIME_DIGITS: "SECONDS",
    REF_PLANE: "ECLIPTIC",
    REF_SYSTEM: "ICRF",
    VEC_TABLE: "2",
    VEC_LABELS: "YES",
  });

  const url = `${HORIZONS}?${params}`;
  let response = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "CosmosMap Horizons cache (https://github.com/bekirdag/space_simulation)",
        },
      });
    } catch {
      if (attempt < 5) {
        await delay(600 * 2 ** attempt);
        continue;
      }
      throw new Error("network error");
    }
    if (response.ok || !RETRY_STATUSES.has(response.status)) break;
    await delay(600 * 2 ** attempt);
  }

  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "network"}`);
  const json = await response.json();
  if (json.code && json.code !== "200") throw new Error(json.message ?? `API ${json.code}`);
  if (!json.result) throw new Error("Empty response");
  return parseVector(name, json.result);
}

async function mapLimit(items, limit, task) {
  const settled = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        settled[index] = { status: "fulfilled", value: await task(items[index], index) };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return settled;
}

async function fetchSnapshotFromJpl(dateStr) {
  const settled = await mapLimit(TARGETS, 2, async (target, index) => {
    await delay(index * 150);
    return fetchTarget(target, dateStr);
  });

  const vectors = [];
  const warnings = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      vectors.push(result.value);
    } else {
      const name = TARGETS[index]?.[0] ?? `target-${index}`;
      warnings.push(`${name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }

  vectors.sort((a, b) => TARGETS.findIndex(target => target[0] === a.name) - TARGETS.findIndex(target => target[0] === b.name));
  return {
    schema: CACHE_SCHEMA,
    date: dateStr,
    fetchedAt: new Date().toISOString(),
    source: "NASA/JPL Horizons API",
    frame: {
      center: "500@0",
      centerName: "Solar System Barycenter",
      refPlane: "ECLIPTIC",
      refSystem: "ICRF",
      units: "AU, AU/yr",
    },
    vectors,
    warnings,
    targetCount: TARGETS.length,
  };
}

async function resolveSnapshot(dateStr, refresh) {
  const cacheFile = cacheFileFor(dateStr);
  const cached = await readSnapshot(cacheFile, dateStr);
  if (cached && !refresh) return withCacheStatus(cached, "runtime-cache");

  if (!refresh) {
    const publicSeed = await readSnapshot(publicCacheFileFor(dateStr), dateStr);
    if (publicSeed) {
      await writeSnapshot(cacheFile, publicSeed);
      return withCacheStatus(publicSeed, "public-cache");
    }
  }

  try {
    const fresh = await fetchSnapshotFromJpl(dateStr);
    await writeSnapshot(cacheFile, fresh);
    return withCacheStatus(fresh, "network");
  } catch (err) {
    if (cached) {
      return withCacheStatus(cached, "stale-runtime-cache", {
        stale: true,
        warning: `Returned stale Horizons cache after JPL lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    throw err;
  }
}

async function horizonsResponse(dateStr, refresh) {
  const key = `${dateStr}:${refresh ? "refresh" : "cache"}`;
  const existing = inFlight.get(key);
  if (existing) return existing;

  const promise = resolveSnapshot(dateStr, refresh).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

function sendJson(res, statusCode, payload, cacheable = false) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cacheable ? "public, max-age=86400, stale-while-revalidate=604800" : "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res) {
  res.writeHead(405, {
    "Allow": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}

export async function handleHorizonsRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/horizons") return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Allow": "GET, OPTIONS" });
    res.end();
    return true;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res);
    return true;
  }

  const dateStr = normalizeDate(url.searchParams.get("date"));
  if (!dateStr) {
    sendJson(res, 400, { error: "invalid_date", message: "Expected date as YYYY-MM-DD." });
    return true;
  }

  const refresh = url.searchParams.get("refresh") === "1";
  try {
    const payload = await horizonsResponse(dateStr, refresh);
    sendJson(res, 200, payload, !refresh);
  } catch (err) {
    console.error("CosmosMap Horizons lookup failed:", err);
    sendJson(res, 502, {
      error: "horizons_lookup_failed",
      date: dateStr,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return true;
}


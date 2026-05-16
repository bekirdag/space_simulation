import { backendFetch, readBackendJson } from "./backend";

/**
 * JPL Horizons snapshot client.
 *
 * The browser never calls NASA/JPL directly. Runtime requests go through the
 * local CosmosMap backend so daily Horizons snapshots can be cached under
 * cache/nasa/horizons and reused across browser sessions.
 */

const HORIZONS_CACHE_SCHEMA = "celestia.horizons.v1";
const LOCAL_CACHE_PREFIX = "celestia:horizons:";
const PUBLIC_CACHE_BASE_URL = "/cache/horizons";

export interface HorizonsBodyTarget { name: string; command: string; }

export const HORIZONS_BODY_TARGETS: readonly HorizonsBodyTarget[] = [
  { name: "Sun", command: "10" },
  { name: "Mercury", command: "199" },
  { name: "Venus", command: "299" },
  { name: "Earth", command: "399" },
  { name: "Mars", command: "499" },
  { name: "Jupiter", command: "599" },
  { name: "Saturn", command: "699" },
  { name: "Uranus", command: "799" },
  { name: "Neptune", command: "899" },
  { name: "Moon", command: "301" },
  { name: "Io", command: "501" },
  { name: "Europa", command: "502" },
  { name: "Ganymede", command: "503" },
  { name: "Callisto", command: "504" },
  { name: "Mimas", command: "601" },
  { name: "Enceladus", command: "602" },
  { name: "Tethys", command: "603" },
  { name: "Dione", command: "604" },
  { name: "Rhea", command: "605" },
  { name: "Titan", command: "606" },
  { name: "Iapetus", command: "608" },
  { name: "Miranda", command: "705" },
  { name: "Ariel", command: "701" },
  { name: "Umbriel", command: "702" },
  { name: "Titania", command: "703" },
  { name: "Oberon", command: "704" },
  { name: "Triton", command: "801" },
  { name: "Pluto", command: "999" },
  { name: "Charon", command: "901" },
  { name: "Ceres", command: "1;" },
  { name: "Eris", command: "136199;" },
  { name: "Haumea", command: "136108;" },
  { name: "Makemake", command: "136472;" },
];

export const TOTAL_BODIES = HORIZONS_BODY_TARGETS.length;

export interface StateVector {
  name: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

export interface HorizonsSnapshot {
  schema: typeof HORIZONS_CACHE_SCHEMA;
  date: string;
  fetchedAt: string;
  source: string;
  frame: {
    center: "500@0";
    centerName: "Solar System Barycenter";
    refPlane: "ECLIPTIC";
    refSystem: "ICRF";
    units: "AU, AU/yr";
  };
  vectors: StateVector[];
  warnings: string[];
  targetCount: number;
  apiVersion?: string;
  cacheStatus?: string;
  cacheHit?: boolean;
  stale?: boolean;
  requestedDate?: string;
  refreshQueued?: boolean;
  warning?: string;
}

export type HorizonsResultSource =
  "jpl-network" |
  "backend-cache" |
  "file-cache" |
  "browser-cache" |
  "stale-cache";

export interface HorizonsResult {
  vectors: StateVector[];
  epochMs: number;
  warnings: string[];
  source: HorizonsResultSource;
  snapshot: HorizonsSnapshot;
}

export function utcDateStr(d: Date): string { return d.toISOString().slice(0, 10); }
export function dateStrToMs(s: string): number { return new Date(s + "T00:00:00Z").getTime(); }

function cacheKey(dateStr: string): string { return `${LOCAL_CACHE_PREFIX}${dateStr}`; }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStateVector(value: unknown): value is StateVector {
  const vector = value as Partial<StateVector> | null;
  return !!vector &&
    typeof vector.name === "string" &&
    isFiniteNumber(vector.x) && isFiniteNumber(vector.y) && isFiniteNumber(vector.z) &&
    isFiniteNumber(vector.vx) && isFiniteNumber(vector.vy) && isFiniteNumber(vector.vz);
}

function normalizeSnapshot(
  raw: Partial<HorizonsSnapshot> | null | undefined,
  expectedDate: string,
  allowStaleDate = false,
): HorizonsSnapshot | null {
  if (!raw || raw.schema !== HORIZONS_CACHE_SCHEMA || !Array.isArray(raw.vectors)) return null;
  if (typeof raw.date !== "string" || (!allowStaleDate && raw.date !== expectedDate)) return null;

  const vectors = raw.vectors.filter(isStateVector);
  if (vectors.length === 0) return null;

  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.filter((warning): warning is string => typeof warning === "string")
    : [];
  if (typeof raw.warning === "string" && raw.warning) warnings.push(raw.warning);

  return {
    schema: HORIZONS_CACHE_SCHEMA,
    date: raw.date,
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
    warnings,
    targetCount: Number.isFinite(raw.targetCount) ? raw.targetCount! : TOTAL_BODIES,
    ...(typeof raw.apiVersion === "string" ? { apiVersion: raw.apiVersion } : {}),
    ...(typeof raw.cacheStatus === "string" ? { cacheStatus: raw.cacheStatus } : {}),
    ...(typeof raw.cacheHit === "boolean" ? { cacheHit: raw.cacheHit } : {}),
    ...(raw.stale === true ? { stale: true } : {}),
    ...(typeof raw.requestedDate === "string" ? { requestedDate: raw.requestedDate } : {}),
    ...(raw.refreshQueued === true ? { refreshQueued: true } : {}),
    ...(typeof raw.warning === "string" ? { warning: raw.warning } : {}),
  };
}

function readBrowserCache(dateStr: string): HorizonsSnapshot | null {
  try {
    const raw = localStorage.getItem(cacheKey(dateStr));
    if (!raw) return null;
    return normalizeSnapshot(JSON.parse(raw) as Partial<HorizonsSnapshot>, dateStr);
  } catch { return null; }
}

function writeBrowserCache(snapshot: HorizonsSnapshot): void {
  try { localStorage.setItem(cacheKey(snapshot.date), JSON.stringify(snapshot)); } catch { /* quota */ }
}

async function readFileCache(dateStr: string): Promise<HorizonsSnapshot | null> {
  try {
    const resp = await fetch(`${PUBLIC_CACHE_BASE_URL}/${dateStr}.json`, { cache: "force-cache" });
    if (!resp.ok) return null;
    return normalizeSnapshot(await resp.json() as Partial<HorizonsSnapshot>, dateStr);
  } catch { return null; }
}

function toResult(snapshot: HorizonsSnapshot, source: HorizonsResultSource): HorizonsResult {
  return {
    vectors: snapshot.vectors,
    epochMs: dateStrToMs(snapshot.date),
    warnings: snapshot.warnings,
    source,
    snapshot,
  };
}

function backendSource(snapshot: HorizonsSnapshot, requestedDate: string): HorizonsResultSource {
  const status = snapshot.cacheStatus ?? "";
  if (snapshot.stale || snapshot.date !== requestedDate || status.startsWith("stale-")) {
    return "stale-cache";
  }
  return status === "network" ? "jpl-network" : "backend-cache";
}

async function readBackendCache(dateStr: string, refresh: boolean): Promise<HorizonsResult | null> {
  const params = new URLSearchParams({ date: dateStr });
  if (refresh) params.set("refresh", "1");

  const response = await backendFetch(`/api/horizons?${params}`, {
    cache: refresh ? "no-store" : "default",
  });
  const payload = await readBackendJson<Partial<HorizonsSnapshot> & { message?: string }>(response);
  if (!response.ok) {
    throw new Error(payload.message || `Horizons backend returned HTTP ${response.status}`);
  }

  const snapshot = normalizeSnapshot(payload, dateStr, true);
  if (!snapshot) throw new Error("Horizons backend returned an invalid snapshot");

  writeBrowserCache(snapshot);
  return toResult(snapshot, backendSource(snapshot, dateStr));
}

// Stale-cache fallback: find the most recent cached snapshot when the backend is
// unavailable. Browser cache is instant; public cache scans only a short window.
async function findLatestCache(): Promise<{ snapshot: HorizonsSnapshot; stale: boolean } | null> {
  let bestBrowser: HorizonsSnapshot | null = null;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(LOCAL_CACHE_PREFIX)) continue;
      const dateStr = key.slice(LOCAL_CACHE_PREFIX.length);
      const snap = readBrowserCache(dateStr);
      if (snap && (!bestBrowser || snap.date > bestBrowser.date)) bestBrowser = snap;
    }
  } catch { /* localStorage unavailable */ }
  if (bestBrowser) return { snapshot: bestBrowser, stale: true };

  const today = new Date();
  for (let d = 0; d < 30; d++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - d);
    const snap = await readFileCache(utcDateStr(date));
    if (snap) return { snapshot: snap, stale: d > 0 };
  }

  return null;
}

export async function fetchStatesForDate(
  dateStr: string,
  onProgress?: (loaded: number, total: number) => void,
  options: { refresh?: boolean } = {},
): Promise<HorizonsResult> {
  const total = TOTAL_BODIES;

  if (!options.refresh) {
    const browserCache = readBrowserCache(dateStr);
    if (browserCache) {
      onProgress?.(total, total);
      return toResult(browserCache, "browser-cache");
    }
  }

  try {
    const backendResult = await readBackendCache(dateStr, options.refresh === true);
    if (backendResult) {
      onProgress?.(total, total);
      return backendResult;
    }
  } catch (err) {
    console.warn("Horizons backend cache failed:", err);
  }

  if (!options.refresh) {
    const fileCache = await readFileCache(dateStr);
    if (fileCache) {
      onProgress?.(total, total);
      writeBrowserCache(fileCache);
      return toResult(fileCache, "file-cache");
    }
  }

  const cached = await findLatestCache();
  if (cached) {
    console.warn(`Using cached Horizons positions from ${cached.snapshot.date}.`);
    onProgress?.(total, total);
    return toResult(cached.snapshot, "stale-cache");
  }

  throw new Error("No Horizons cache is available and the CosmosMap backend could not provide one.");
}

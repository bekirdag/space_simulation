/**
 * JPL Horizons API client — calls NASA directly via the Vite dev-server proxy.
 *
 * The proxy is configured in vite.config.ts:
 *   /horizons-proxy  →  https://ssd.jpl.nasa.gov/api/horizons.api
 *
 * This avoids CORS (browser cannot call NASA directly) and the backend-discovery
 * dance that was causing up to 18 s of startup delay.
 */

const HORIZONS              = '/horizons-proxy';
const HORIZONS_CACHE_SCHEMA = 'celestia.horizons.v1';
const LOCAL_CACHE_PREFIX    = 'celestia:horizons:';
const PUBLIC_CACHE_BASE_URL = '/cache/horizons';

export interface HorizonsBodyTarget { name: string; command: string; }

export const HORIZONS_BODY_TARGETS: readonly HorizonsBodyTarget[] = [
  { name: 'Sun',       command: '10'  },
  { name: 'Mercury',   command: '199' },
  { name: 'Venus',     command: '299' },
  { name: 'Earth',     command: '399' },
  { name: 'Mars',      command: '499' },
  { name: 'Jupiter',   command: '599' },
  { name: 'Saturn',    command: '699' },
  { name: 'Uranus',    command: '799' },
  { name: 'Neptune',   command: '899' },
  { name: 'Moon',      command: '301' },
  { name: 'Io',        command: '501' },
  { name: 'Europa',    command: '502' },
  { name: 'Ganymede',  command: '503' },
  { name: 'Callisto',  command: '504' },
  { name: 'Mimas',     command: '601' },
  { name: 'Enceladus', command: '602' },
  { name: 'Tethys',    command: '603' },
  { name: 'Dione',     command: '604' },
  { name: 'Rhea',      command: '605' },
  { name: 'Titan',     command: '606' },
  { name: 'Iapetus',   command: '608' },
  { name: 'Miranda',   command: '705' },
  { name: 'Ariel',     command: '701' },
  { name: 'Umbriel',   command: '702' },
  { name: 'Titania',   command: '703' },
  { name: 'Oberon',    command: '704' },
  { name: 'Triton',    command: '801' },
  { name: 'Pluto',     command: '999' },
  { name: 'Charon',    command: '901' },
  { name: 'Ceres',     command: '1;'      },
  { name: 'Eris',      command: '136199;' },
  { name: 'Haumea',    command: '136108;' },
  { name: 'Makemake',  command: '136472;' },
];

export const TOTAL_BODIES = HORIZONS_BODY_TARGETS.length; // 33

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
    center: '500@0';
    centerName: 'Solar System Barycenter';
    refPlane: 'ECLIPTIC';
    refSystem: 'ICRF';
    units: 'AU, AU/yr';
  };
  vectors: StateVector[];
  warnings: string[];
  targetCount: number;
  apiVersion?: string;
}

export type HorizonsResultSource = 'jpl-network' | 'file-cache' | 'browser-cache' | 'stale-cache';

export interface HorizonsResult {
  vectors:  StateVector[];
  epochMs:  number;
  warnings: string[];
  source:   HorizonsResultSource;
  snapshot: HorizonsSnapshot;
}

export function utcDateStr(d: Date): string { return d.toISOString().slice(0, 10); }
export function dateStrToMs(s: string): number { return new Date(s + 'T00:00:00Z').getTime(); }

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function settleWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const settled = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        settled[index] = { status: 'fulfilled', value: await task(items[index]!, index) };
      } catch (reason) {
        settled[index] = { status: 'rejected', reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return settled;
}

// ── Caching ───────────────────────────────────────────────────────────────────

function cacheKey(dateStr: string): string { return `${LOCAL_CACHE_PREFIX}${dateStr}`; }

function readBrowserCache(dateStr: string): HorizonsSnapshot | null {
  try {
    const raw = localStorage.getItem(cacheKey(dateStr));
    if (!raw) return null;
    const obj = JSON.parse(raw) as Partial<HorizonsSnapshot>;
    if (obj.schema !== HORIZONS_CACHE_SCHEMA || obj.date !== dateStr) return null;
    if (!Array.isArray(obj.vectors) || obj.vectors.length === 0) return null;
    return obj as HorizonsSnapshot;
  } catch { return null; }
}

function writeBrowserCache(snapshot: HorizonsSnapshot): void {
  try { localStorage.setItem(cacheKey(snapshot.date), JSON.stringify(snapshot)); } catch { /* quota */ }
}

async function readFileCache(dateStr: string): Promise<HorizonsSnapshot | null> {
  try {
    const resp = await fetch(`${PUBLIC_CACHE_BASE_URL}/${dateStr}.json`, { cache: 'force-cache' });
    if (!resp.ok) return null;
    const obj = await resp.json() as Partial<HorizonsSnapshot>;
    if (obj.schema !== HORIZONS_CACHE_SCHEMA || obj.date !== dateStr) return null;
    if (!Array.isArray(obj.vectors) || obj.vectors.length === 0) return null;
    return obj as HorizonsSnapshot;
  } catch { return null; }
}

// ── NASA fetch ────────────────────────────────────────────────────────────────

function createSnapshot(dateStr: string, vectors: StateVector[], warnings: string[]): HorizonsSnapshot {
  return {
    schema: HORIZONS_CACHE_SCHEMA,
    date: dateStr,
    fetchedAt: new Date().toISOString(),
    source: 'NASA/JPL Horizons API',
    frame: {
      center: '500@0',
      centerName: 'Solar System Barycenter',
      refPlane: 'ECLIPTIC',
      refSystem: 'ICRF',
      units: 'AU, AU/yr',
    },
    vectors,
    warnings,
    targetCount: HORIZONS_BODY_TARGETS.length,
  };
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

function parse(name: string, text: string): StateVector {
  const i0 = text.indexOf('$$SOE');
  const i1 = text.indexOf('$$EOE');
  if (i0 === -1 || i1 === -1) throw new Error(`No ephemeris for ${name}`);

  const lines = text.slice(i0 + 5, i1).split('\n').filter(l => l.trim());
  const posLine = lines.find(l => /\bX\s*=/.test(l) && /\bY\s*=/.test(l) && !/\bVX\s*=/.test(l));
  const velLine = lines.find(l => /\bVX\s*=/.test(l) && /\bVY\s*=/.test(l));
  if (!posLine || !velLine) throw new Error(`No vectors for ${name}`);

  const nums = (l: string) => [...l.matchAll(/([-+]?\d+\.\d+[Ee][+-]\d+)/g)].map(m => parseFloat(m[1]!));
  const p = nums(posLine);
  const v = nums(velLine);
  if (p.length < 3 || v.length < 3) throw new Error(`Incomplete data for ${name}`);

  const D2Y = 365.25;
  return { name, x:p[0]!, y:p[1]!, z:p[2]!, vx:v[0]!*D2Y, vy:v[1]!*D2Y, vz:v[2]!*D2Y };
}

async function fetchOne(target: HorizonsBodyTarget, dateStr: string): Promise<StateVector> {
  const next = new Date(dateStr + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);

  const p = new URLSearchParams({
    format: 'json', COMMAND: target.command, OBJ_DATA: 'NO',
    MAKE_EPHEM: 'YES', EPHEM_TYPE: 'VECTORS', CENTER: '500@0',
    START_TIME: dateStr, STOP_TIME: utcDateStr(next), STEP_SIZE: '1d',
    OUT_UNITS: 'AU-D', TIME_TYPE: 'UT', TIME_DIGITS: 'SECONDS',
    REF_PLANE: 'ECLIPTIC', REF_SYSTEM: 'ICRF', VEC_TABLE: '2', VEC_LABELS: 'YES',
  });

  const url = `${HORIZONS}?${p}`;
  let resp: Response | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { resp = await fetch(url); }
    catch {
      if (attempt < 5) { await delay(600 * 2 ** attempt); continue; }
      throw new Error('network error');
    }
    if (resp.ok || ![429, 500, 502, 503, 504].includes(resp.status)) break;
    await delay(600 * 2 ** attempt);
  }
  if (!resp?.ok) throw new Error(`HTTP ${resp?.status ?? 'network'}`);
  const json = await resp.json() as { result?: string; message?: string; code?: string };
  if (json.code && json.code !== '200') throw new Error(json.message ?? `API ${json.code}`);
  if (!json.result) throw new Error('Empty response');
  return parse(target.name, json.result);
}

// ── Stale-cache fallback: find the most recent cached snapshot ────────────────
// Used when NASA rate-limits or is unreachable. Prefers browser cache (instant)
// then falls back to scanning the last 30 days of file-cache entries.
async function findLatestCache(): Promise<{ snapshot: HorizonsSnapshot; stale: boolean } | null> {
  // 1. Scan browser localStorage for any cached date
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

  // 2. Try file cache for the last 30 days
  const today = new Date();
  for (let d = 0; d < 30; d++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - d);
    const snap = await readFileCache(utcDateStr(date));
    if (snap) return { snapshot: snap, stale: d > 0 };
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function fetchStatesForDate(
  dateStr: string,
  onProgress?: (loaded: number, total: number) => void,
  options: { refresh?: boolean } = {},
): Promise<HorizonsResult> {
  let loaded = 0;
  const total = TOTAL_BODIES;

  if (!options.refresh) {
    // Browser localStorage is synchronous and instant — check it first.
    // This avoids the network round-trip to /cache/horizons/ on every startup
    // when the user has already fetched for today in this browser.
    const browserCache = readBrowserCache(dateStr);
    if (browserCache) { onProgress?.(total, total); return toResult(browserCache, 'browser-cache'); }

    // Fall back to pre-committed public file cache (served statically, no NASA call).
    const fileCache = await readFileCache(dateStr);
    if (fileCache) { onProgress?.(total, total); return toResult(fileCache, 'file-cache'); }
  }

  const settled = await settleWithLimit(
    HORIZONS_BODY_TARGETS, 2,
    async (target, index) => {
      await delay(index * 150);
      try { return await fetchOne(target, dateStr); }
      finally { onProgress?.(++loaded, total); }
    },
  );

  const vectors: StateVector[] = [];
  const warnings: string[] = [];
  for (const [i, r] of settled.entries()) {
    if (r.status === 'fulfilled') vectors.push(r.value);
    else warnings.push(`${HORIZONS_BODY_TARGETS[i]!.name}: ${(r.reason as Error).message}`);
  }

  // All bodies failed (e.g. rate-limited) — fall back to latest available cache
  if (vectors.length === 0) {
    const cached = await findLatestCache();
    if (cached) {
      console.warn(`NASA unavailable — using cached positions from ${cached.snapshot.date}`);
      return toResult(cached.snapshot, 'stale-cache');
    }
    throw new Error(`NASA rate-limited and no cached data available. Warnings: ${warnings.join('; ')}`);
  }

  // Partial success: some bodies fetched, some failed — still usable
  const snapshot = createSnapshot(dateStr, vectors, warnings);
  writeBrowserCache(snapshot);
  return toResult(snapshot, 'jpl-network');
}

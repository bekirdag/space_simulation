/**
 * JPL Horizons API client.
 * Frame: ecliptic ICRF, BARYCENTRIC (CENTER=500@0 = SSB).
 * 33 bodies total: Sun + 8 planets + 18 major moons + 5 dwarf planets + Charon.
 */

const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const HORIZONS_CACHE_SCHEMA = 'celestia.horizons.v1';
const HORIZONS_CACHE_BASE_URL = '/cache/horizons';
const LOCAL_CACHE_PREFIX = 'celestia:horizons:';

export interface HorizonsBodyTarget {
  name: string;
  command: string;
}

export const HORIZONS_BODY_TARGETS: readonly HorizonsBodyTarget[] = [
  // Sun + planets
  { name: 'Sun',       command: '10'  },
  { name: 'Mercury',   command: '199' },
  { name: 'Venus',     command: '299' },
  { name: 'Earth',     command: '399' },
  { name: 'Mars',      command: '499' },
  { name: 'Jupiter',   command: '599' },
  { name: 'Saturn',    command: '699' },
  { name: 'Uranus',    command: '799' },
  { name: 'Neptune',   command: '899' },

  // Earth
  { name: 'Moon',      command: '301' },

  // Jupiter — Galilean moons
  { name: 'Io',        command: '501' },
  { name: 'Europa',    command: '502' },
  { name: 'Ganymede',  command: '503' },
  { name: 'Callisto',  command: '504' },

  // Saturn
  { name: 'Mimas',     command: '601' },
  { name: 'Enceladus', command: '602' },
  { name: 'Tethys',    command: '603' },
  { name: 'Dione',     command: '604' },
  { name: 'Rhea',      command: '605' },
  { name: 'Titan',     command: '606' },
  { name: 'Iapetus',   command: '608' },

  // Uranus
  { name: 'Miranda',   command: '705' },
  { name: 'Ariel',     command: '701' },
  { name: 'Umbriel',   command: '702' },
  { name: 'Titania',   command: '703' },
  { name: 'Oberon',    command: '704' },

  // Neptune
  { name: 'Triton',    command: '801' },

  // Pluto system
  { name: 'Pluto',     command: '999' },
  { name: 'Charon',    command: '901' },

  // Minor bodies require the semicolon selector; COMMAND=1 alone is Mercury barycenter.
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

export type HorizonsResultSource = 'file-cache' | 'browser-cache' | 'jpl-network';

export interface HorizonsResult {
  vectors:  StateVector[];
  epochMs:  number;
  warnings: string[];
  source: HorizonsResultSource;
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

function cacheKey(dateStr: string): string {
  return `${LOCAL_CACHE_PREFIX}${dateStr}`;
}

function createSnapshot(
  dateStr: string,
  vectors: StateVector[],
  warnings: string[],
  apiVersion?: string,
): HorizonsSnapshot {
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
    ...(apiVersion ? { apiVersion } : {}),
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

function isStateVector(value: unknown): value is StateVector {
  const vector = value as Partial<StateVector>;
  return typeof vector.name === 'string'
    && Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z)
    && Number.isFinite(vector.vx) && Number.isFinite(vector.vy) && Number.isFinite(vector.vz);
}

function parseSnapshot(value: unknown, dateStr: string): HorizonsSnapshot | null {
  const raw = value as Partial<HorizonsSnapshot>;
  if (raw.schema !== HORIZONS_CACHE_SCHEMA || raw.date !== dateStr || !Array.isArray(raw.vectors)) {
    return null;
  }
  const vectors = raw.vectors.filter(isStateVector);
  if (vectors.length === 0) return null;

  const snapshot: HorizonsSnapshot = {
    schema: HORIZONS_CACHE_SCHEMA,
    date: dateStr,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : '',
    source: typeof raw.source === 'string' ? raw.source : 'NASA/JPL Horizons API',
    frame: {
      center: '500@0',
      centerName: 'Solar System Barycenter',
      refPlane: 'ECLIPTIC',
      refSystem: 'ICRF',
      units: 'AU, AU/yr',
    },
    vectors,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter(w => typeof w === 'string') : [],
    targetCount: Number.isFinite(raw.targetCount) ? raw.targetCount! : HORIZONS_BODY_TARGETS.length,
  };
  if (typeof raw.apiVersion === 'string') snapshot.apiVersion = raw.apiVersion;
  return snapshot;
}

async function readFileCache(dateStr: string): Promise<HorizonsSnapshot | null> {
  try {
    const resp = await fetch(`${HORIZONS_CACHE_BASE_URL}/${dateStr}.json`, { cache: 'force-cache' });
    if (!resp.ok) return null;
    return parseSnapshot(await resp.json(), dateStr);
  } catch {
    return null;
  }
}

function readBrowserCache(dateStr: string): HorizonsSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(cacheKey(dateStr));
    return raw ? parseSnapshot(JSON.parse(raw), dateStr) : null;
  } catch {
    return null;
  }
}

function writeBrowserCache(snapshot: HorizonsSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(cacheKey(snapshot.date), JSON.stringify(snapshot));
  } catch {
    // localStorage may be unavailable or full; the simulation should still run.
  }
}

async function fetchOne(target: HorizonsBodyTarget, dateStr: string): Promise<StateVector> {
  const next = new Date(dateStr + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);

  const p = new URLSearchParams({
    format:     'json',
    COMMAND:    target.command,
    OBJ_DATA:   'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER:     '500@0',
    START_TIME: dateStr,
    STOP_TIME:  utcDateStr(next),
    STEP_SIZE:  '1d',
    OUT_UNITS:  'AU-D',
    TIME_TYPE:  'UT',
    TIME_DIGITS:'SECONDS',
    REF_PLANE:  'ECLIPTIC',
    REF_SYSTEM: 'ICRF',
    VEC_TABLE:  '2',
    VEC_LABELS: 'YES',
  });

  const url = `${HORIZONS}?${p}`;
  let resp: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    resp = await fetch(url);
    if (resp.ok || ![429, 500, 502, 503, 504].includes(resp.status)) break;
    await delay(450 * 2 ** attempt);
  }
  if (!resp?.ok) throw new Error(`HTTP ${resp?.status ?? 'network'}`);
  const json = await resp.json() as { result?: string; message?: string; code?: string };
  if (json.code && json.code !== '200') throw new Error(json.message ?? `API ${json.code}`);
  if (!json.result) throw new Error('Empty response');
  return parse(target.name, json.result);
}

function parse(name: string, text: string): StateVector {
  const i0 = text.indexOf('$$SOE');
  const i1 = text.indexOf('$$EOE');
  if (i0 === -1 || i1 === -1) throw new Error(`No ephemeris for ${name}`);

  const lines = text.slice(i0 + 5, i1).split('\n').filter(l => l.trim());
  const posLine = lines.find(l => /\bX\s*=/.test(l) && /\bY\s*=/.test(l) && /\bZ\s*=/.test(l) && !/\bVX\s*=/.test(l));
  const velLine = lines.find(l => /\bVX\s*=/.test(l) && /\bVY\s*=/.test(l) && /\bVZ\s*=/.test(l));
  if (!posLine || !velLine) throw new Error(`No vectors for ${name}`);

  const nums = (l: string) =>
    [...l.matchAll(/([-+]?\d+\.\d+[Ee][+-]\d+)/g)].map(m => parseFloat(m[1]!));

  const p = nums(posLine);
  const v = nums(velLine);
  if (p.length < 3 || v.length < 3) throw new Error(`Incomplete data for ${name}`);

  const D2Y = 365.25;
  return { name, x:p[0]!, y:p[1]!, z:p[2]!, vx:v[0]!*D2Y, vy:v[1]!*D2Y, vz:v[2]!*D2Y };
}

export async function fetchStatesForDate(
  dateStr: string,
  onProgress?: (loaded: number, total: number) => void,
  options: { refresh?: boolean } = {},
): Promise<HorizonsResult> {
  let loaded = 0;
  const total = HORIZONS_BODY_TARGETS.length;

  if (!options.refresh) {
    const fileCache = await readFileCache(dateStr);
    if (fileCache) {
      onProgress?.(total, total);
      return toResult(fileCache, 'file-cache');
    }

    const browserCache = readBrowserCache(dateStr);
    if (browserCache) {
      onProgress?.(total, total);
      return toResult(browserCache, 'browser-cache');
    }
  }

  const settled = await settleWithLimit(
    HORIZONS_BODY_TARGETS,
    4,
    async (target) => {
      try {
        return await fetchOne(target, dateStr);
      } finally {
        onProgress?.(++loaded, total);
      }
    },
  );

  const vectors: StateVector[] = [];
  const warnings: string[] = [];
  for (const [i, r] of settled.entries()) {
    if (r.status === 'fulfilled') vectors.push(r.value);
    else warnings.push(`${HORIZONS_BODY_TARGETS[i]!.name}: ${(r.reason as Error).message}`);
  }

  const snapshot = createSnapshot(dateStr, vectors, warnings);
  writeBrowserCache(snapshot);
  return toResult(snapshot, 'jpl-network');
}

export function fetchCurrentStates(
  onProgress?: (loaded: number, total: number) => void,
): Promise<HorizonsResult> {
  return fetchStatesForDate(utcDateStr(new Date()), onProgress);
}

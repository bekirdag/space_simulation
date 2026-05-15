/**
 * Backend-backed JPL Horizons client.
 *
 * The browser never calls NASA/JPL directly. It asks the CosmosMap backend for
 * a date snapshot; the backend serves its runtime cache, seeds from committed
 * public cache files when available, and only then calls NASA/JPL Horizons.
 */

const HORIZONS_CACHE_SCHEMA = 'celestia.horizons.v1';
const HORIZONS_API_URL = '/api/horizons';
const PUBLIC_HORIZONS_CACHE_BASE_URL = '/cache/horizons';

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

  // Jupiter - Galilean moons
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

export type HorizonsCacheStatus =
  | 'runtime-cache'
  | 'public-cache'
  | 'network'
  | 'stale-runtime-cache';

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
  cacheStatus?: HorizonsCacheStatus;
  cacheHit?: boolean;
  stale?: boolean;
  warning?: string;
}

export type HorizonsResultSource =
  | 'backend-cache'
  | 'backend-network'
  | 'backend-stale'
  | 'public-cache';

export interface HorizonsResult {
  vectors:  StateVector[];
  epochMs:  number;
  warnings: string[];
  source: HorizonsResultSource;
  snapshot: HorizonsSnapshot;
}

export function utcDateStr(d: Date): string { return d.toISOString().slice(0, 10); }
export function dateStrToMs(s: string): number { return new Date(s + 'T00:00:00Z').getTime(); }

function isStateVector(value: unknown): value is StateVector {
  const vector = value as Partial<StateVector>;
  return typeof vector.name === 'string'
    && Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z)
    && Number.isFinite(vector.vx) && Number.isFinite(vector.vy) && Number.isFinite(vector.vz);
}

function parseCacheStatus(value: unknown): HorizonsCacheStatus | undefined {
  return value === 'runtime-cache' ||
    value === 'public-cache' ||
    value === 'network' ||
    value === 'stale-runtime-cache'
    ? value
    : undefined;
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
  const cacheStatus = parseCacheStatus(raw.cacheStatus);
  if (cacheStatus) snapshot.cacheStatus = cacheStatus;
  if (typeof raw.cacheHit === 'boolean') snapshot.cacheHit = raw.cacheHit;
  if (typeof raw.stale === 'boolean') snapshot.stale = raw.stale;
  if (typeof raw.warning === 'string') snapshot.warning = raw.warning;
  return snapshot;
}

function resultSourceFor(snapshot: HorizonsSnapshot): HorizonsResultSource {
  if (snapshot.stale) return 'backend-stale';
  return snapshot.cacheStatus === 'network' ? 'backend-network' : 'backend-cache';
}

function toResult(snapshot: HorizonsSnapshot, source: HorizonsResultSource): HorizonsResult {
  return {
    vectors: snapshot.vectors,
    epochMs: dateStrToMs(snapshot.date),
    warnings: snapshot.warning ? [...snapshot.warnings, snapshot.warning] : snapshot.warnings,
    source,
    snapshot,
  };
}

async function readPublicCache(dateStr: string): Promise<HorizonsSnapshot | null> {
  try {
    const resp = await fetch(`${PUBLIC_HORIZONS_CACHE_BASE_URL}/${dateStr}.json`, { cache: 'force-cache' });
    if (!resp.ok) return null;
    return parseSnapshot(await resp.json(), dateStr);
  } catch {
    return null;
  }
}

async function fetchBackendSnapshot(dateStr: string, refresh: boolean): Promise<HorizonsSnapshot> {
  const params = new URLSearchParams({ date: dateStr });
  if (refresh) params.set('refresh', '1');
  const resp = await fetch(`${HORIZONS_API_URL}?${params}`, {
    cache: refresh ? 'no-store' : 'default',
  });
  const payload = await resp.json() as unknown;
  if (!resp.ok) {
    const message = typeof (payload as { message?: unknown }).message === 'string'
      ? (payload as { message: string }).message
      : `HTTP ${resp.status}`;
    throw new Error(message);
  }

  const snapshot = parseSnapshot(payload, dateStr);
  if (!snapshot) throw new Error('Invalid backend Horizons snapshot');
  return snapshot;
}

export async function fetchStatesForDate(
  dateStr: string,
  onProgress?: (loaded: number, total: number) => void,
  options: { refresh?: boolean } = {},
): Promise<HorizonsResult> {
  const total = HORIZONS_BODY_TARGETS.length;
  onProgress?.(0, total);

  try {
    const snapshot = await fetchBackendSnapshot(dateStr, options.refresh === true);
    onProgress?.(total, total);
    return toResult(snapshot, resultSourceFor(snapshot));
  } catch (err) {
    if (!options.refresh) {
      const publicCache = await readPublicCache(dateStr);
      if (publicCache) {
        onProgress?.(total, total);
        return toResult(publicCache, 'public-cache');
      }
    }
    throw err;
  }
}

export function fetchCurrentStates(
  onProgress?: (loaded: number, total: number) => void,
): Promise<HorizonsResult> {
  return fetchStatesForDate(utcDateStr(new Date()), onProgress);
}

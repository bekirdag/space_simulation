/**
 * JPL Horizons API client.
 * Frame: ecliptic J2000.0, BARYCENTRIC (CENTER=500@0 = SSB).
 * 33 bodies total: Sun + 8 planets + 18 major moons + 5 dwarf planets + Charon.
 */

const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';

const BODY_IDS: [string, string][] = [
  // Sun + planets
  ['Sun',       '10' ],
  ['Mercury',   '199'],
  ['Venus',     '299'],
  ['Earth',     '399'],
  ['Mars',      '499'],
  ['Jupiter',   '599'],
  ['Saturn',    '699'],
  ['Uranus',    '799'],
  ['Neptune',   '899'],

  // Earth
  ['Moon',      '301'],

  // Jupiter — Galilean moons
  ['Io',        '501'],
  ['Europa',    '502'],
  ['Ganymede',  '503'],
  ['Callisto',  '504'],

  // Saturn
  ['Mimas',     '601'],
  ['Enceladus', '602'],
  ['Tethys',    '603'],
  ['Dione',     '604'],
  ['Rhea',      '605'],
  ['Titan',     '606'],
  ['Iapetus',   '608'],

  // Uranus
  ['Miranda',   '705'],
  ['Ariel',     '701'],
  ['Umbriel',   '702'],
  ['Titania',   '703'],
  ['Oberon',    '704'],

  // Neptune
  ['Triton',    '801'],

  // Pluto system
  ['Pluto',     '999'],
  ['Charon',    '901'],

  // Dwarf planets (minor bodies — Horizons accepts the number directly)
  ['Ceres',     '1'],        // asteroid 1 Ceres
  ['Eris',      '136199'],   // trans-neptunian object
  ['Haumea',    '136108'],
  ['Makemake',  '136472'],
];

export const TOTAL_BODIES = BODY_IDS.length; // 33

export interface StateVector {
  name: string;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

export interface HorizonsResult {
  vectors:  StateVector[];
  epochMs:  number;
  warnings: string[];
}

export function utcDateStr(d: Date): string { return d.toISOString().slice(0, 10); }
export function dateStrToMs(s: string): number { return new Date(s + 'T00:00:00Z').getTime(); }

async function fetchOne(name: string, id: string, dateStr: string): Promise<StateVector> {
  const next = new Date(dateStr + 'T00:00:00Z');
  next.setUTCDate(next.getUTCDate() + 1);

  const p = new URLSearchParams({
    format:     'json',
    COMMAND:    id,
    OBJ_DATA:   'NO',
    MAKE_EPHEM: 'YES',
    EPHEM_TYPE: 'VECTORS',
    CENTER:     '500@0',
    START_TIME: dateStr,
    STOP_TIME:  utcDateStr(next),
    STEP_SIZE:  '1d',
    OUT_UNITS:  'AU-D',
    REF_PLANE:  'ECLIPTIC',
    REF_SYSTEM: 'J2000',
    VEC_LABELS: 'YES',
  });

  const resp = await fetch(`${HORIZONS}?${p}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json() as { result?: string; message?: string; code?: string };
  if (json.code && json.code !== '200') throw new Error(json.message ?? `API ${json.code}`);
  if (!json.result) throw new Error('Empty response');
  return parse(name, json.result);
}

function parse(name: string, text: string): StateVector {
  const i0 = text.indexOf('$$SOE');
  const i1 = text.indexOf('$$EOE');
  if (i0 === -1 || i1 === -1) throw new Error(`No ephemeris for ${name}`);

  const lines = text.slice(i0 + 5, i1).split('\n').filter(l => l.trim());
  const posLine = lines.find(l => / X /.test(l) && !/VX/.test(l));
  const velLine = lines.find(l => /VX/.test(l));
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
): Promise<HorizonsResult> {
  const epochMs = dateStrToMs(dateStr);
  let loaded = 0;
  const total = BODY_IDS.length;

  const settled = await Promise.allSettled(
    BODY_IDS.map(async ([name, id]) => {
      const sv = await fetchOne(name, id, dateStr);
      onProgress?.(++loaded, total);
      return sv;
    }),
  );

  const vectors: StateVector[] = [];
  const warnings: string[] = [];
  for (const [i, r] of settled.entries()) {
    if (r.status === 'fulfilled') vectors.push(r.value);
    else warnings.push(`${BODY_IDS[i]![0]}: ${(r.reason as Error).message}`);
  }
  return { vectors, epochMs, warnings };
}

export function fetchCurrentStates(
  onProgress?: (loaded: number, total: number) => void,
): Promise<HorizonsResult> {
  return fetchStatesForDate(utcDateStr(new Date()), onProgress);
}

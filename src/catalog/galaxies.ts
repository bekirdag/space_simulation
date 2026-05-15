/**
 * Galaxy catalog — 100k nearest galaxies (50k real Simbad + 50k procedural).
 *
 * Binary: 100 000 × 8 floats = 3.1 MB
 *   [0-2] visual position AU (ecliptic J2000, Local Group linear + deep-field log)
 *   [3]   size multiplier
 *   [4-6] RGB colour
 *   [7]   alpha
 */

export const GALAXY_FLOATS = 8;
export const GALAXY_SCALE_VERSION = "local-group-linear-log-v2";
export const GALAXY_KPC_TO_AU = 8_000; // matches the Milky Way background scale
export const GALAXY_MPC_TO_AU = GALAXY_KPC_TO_AU * 1_000;
export const GALAXY_LINEAR_LIMIT_MPC = 2;
export const GALAXY_LOG_INTERVAL_MPC = 2;
export const GALAXY_LOG_SCALE_AU = 1_200_000;
export const GALAXY_LINEAR_LIMIT_AU = GALAXY_LINEAR_LIMIT_MPC * GALAXY_MPC_TO_AU;
export const MILKY_WAY_DIAMETER_AU = 30.7 * GALAXY_KPC_TO_AU;
export const MILKY_WAY_RADIUS_AU = MILKY_WAY_DIAMETER_AU * 0.5;

const LEGACY_GALAXY_BASE_AU = 200_000;
const LEGACY_GALAXY_LOG_SCALE_AU = 50_000;
const LEGACY_GALAXY_REFERENCE_MPC = 0.01;
const EPS = 23.4393 * Math.PI / 180;

export type GalaxyBuffer = Float32Array;

export interface NamedGalaxy {
  index: number;
  name:  string;
  dist:  number; // Mpc
}

export interface LocalGroupGalaxyLabel {
  id:    string;
  name:  string;
  dist:  number; // Mpc
  x: number; y: number; z: number;
  focusDistance: number;
  color: readonly [number, number, number];
  size:  number;
  alpha: number;
}

export interface GalaxyLoad {
  data:   GalaxyBuffer;
  names:  NamedGalaxy[];
  source: string;
}

interface GalaxyMeta {
  distanceScaleVersion?: string;
  galaxyBaseAU?: number;
  galaxyLogScaleAU?: number;
}

interface LocalGroupGalaxySource {
  id: string;
  name: string;
  ra: number;
  dec: number;
  dist: number;
  size: number;
  color: readonly [number, number, number];
  alpha: number;
}

export function galaxyVisualDistanceAU(mpc: number): number {
  const d = Number.isFinite(mpc) ? Math.max(0, mpc) : 0;
  if (d <= GALAXY_LINEAR_LIMIT_MPC) return d * GALAXY_MPC_TO_AU;

  const beyond = (d - GALAXY_LINEAR_LIMIT_MPC) / GALAXY_LOG_INTERVAL_MPC;
  return GALAXY_LINEAR_LIMIT_AU + GALAXY_LOG_SCALE_AU * Math.log2(beyond + 1);
}

function d2r(deg: number): number {
  return deg * Math.PI / 180;
}

function galaxyRaDecToWorldAU(ra: number, dec: number, distMpc: number): [number, number, number] {
  const r = galaxyVisualDistanceAU(distMpc);
  const xe = Math.cos(d2r(dec)) * Math.cos(d2r(ra));
  const ye = Math.cos(d2r(dec)) * Math.sin(d2r(ra));
  const ze = Math.sin(d2r(dec));
  return [
    xe * r,
    (ye * Math.cos(EPS) + ze * Math.sin(EPS)) * r,
    (-ye * Math.sin(EPS) + ze * Math.cos(EPS)) * r,
  ];
}

// Bright, well-known Local Group galaxies. The redshift-built 100k catalog is
// excellent at larger scales, but it omits many nearby galaxies because their
// redshifts are small or negative. These anchors use the same visual scale.
const LOCAL_GROUP_SOURCES: LocalGroupGalaxySource[] = [
  { id: "lmc", name: "Large Magellanic Cloud", ra: 80.8939, dec: -69.7561, dist: 0.050, size: 1.85, color: [0.62, 0.72, 1.00], alpha: 0.78 },
  { id: "smc", name: "Small Magellanic Cloud", ra: 13.1867, dec: -72.8286, dist: 0.061, size: 1.50, color: [0.62, 0.72, 1.00], alpha: 0.70 },
  { id: "sculptor-dwarf", name: "Sculptor Dwarf Galaxy", ra: 15.0392, dec: -33.7092, dist: 0.086, size: 1.05, color: [0.86, 0.82, 0.72], alpha: 0.56 },
  { id: "fornax-dwarf", name: "Fornax Dwarf Galaxy", ra: 39.9971, dec: -34.4492, dist: 0.147, size: 1.08, color: [0.86, 0.82, 0.72], alpha: 0.56 },
  { id: "leo-i-dwarf", name: "Leo I Dwarf Galaxy", ra: 152.1171, dec: 12.3064, dist: 0.254, size: 1.02, color: [0.86, 0.82, 0.72], alpha: 0.52 },
  { id: "barnards-galaxy", name: "Barnard's Galaxy", ra: 296.2366, dec: -14.8039, dist: 0.490, size: 1.25, color: [0.58, 0.68, 1.00], alpha: 0.62 },
  { id: "ngc-185", name: "NGC 185", ra: 9.7416, dec: 48.3374, dist: 0.616, size: 1.10, color: [0.98, 0.83, 0.58], alpha: 0.58 },
  { id: "ngc-147", name: "NGC 147", ra: 8.3005, dec: 48.5087, dist: 0.712, size: 1.05, color: [0.98, 0.83, 0.58], alpha: 0.54 },
  { id: "andromeda", name: "Andromeda Galaxy", ra: 10.6847, dec: 41.2688, dist: 0.780, size: 2.45, color: [0.82, 0.88, 1.00], alpha: 0.86 },
  { id: "ic-10", name: "IC 10", ra: 5.0721, dec: 59.3039, dist: 0.790, size: 1.20, color: [0.58, 0.68, 1.00], alpha: 0.60 },
  { id: "triangulum", name: "Triangulum Galaxy", ra: 23.4621, dec: 30.6602, dist: 0.850, size: 1.90, color: [0.74, 0.82, 1.00], alpha: 0.76 },
  { id: "wlm", name: "WLM Galaxy", ra: 0.4923, dec: -15.4610, dist: 0.985, size: 1.12, color: [0.58, 0.68, 1.00], alpha: 0.54 },
];

export const LOCAL_GROUP_GALAXY_LABELS: LocalGroupGalaxyLabel[] = LOCAL_GROUP_SOURCES.map(source => {
  const [x, y, z] = galaxyRaDecToWorldAU(source.ra, source.dec, source.dist);
  const r = Math.hypot(x, y, z);
  return {
    id: source.id,
    name: source.name,
    dist: source.dist,
    x, y, z,
    focusDistance: Math.min(10_000, Math.max(500, r * 0.02)),
    color: source.color,
    size: source.size,
    alpha: source.alpha,
  };
});

async function loadGalaxyMeta(): Promise<GalaxyMeta | null> {
  try {
    const resp = await fetch("/data/galaxies-100k.meta.json");
    if (!resp.ok) return null;
    return await resp.json() as GalaxyMeta;
  } catch {
    return null;
  }
}

function legacyMpcFromVisualAU(radiusAU: number, meta: GalaxyMeta | null): number {
  const base = meta?.galaxyBaseAU ?? LEGACY_GALAXY_BASE_AU;
  const logScale = meta?.galaxyLogScaleAU ?? LEGACY_GALAXY_LOG_SCALE_AU;
  if (!Number.isFinite(radiusAU) || !Number.isFinite(base) || !Number.isFinite(logScale) || logScale <= 0) {
    return 0;
  }

  const exponent = (radiusAU - base) / logScale;
  return Math.max(0, LEGACY_GALAXY_REFERENCE_MPC * (2 ** exponent - 1));
}

function remapLegacyGalaxyDistances(input: Float32Array, meta: GalaxyMeta | null): GalaxyBuffer {
  const output = new Float32Array(input);
  for (let o = 0; o < output.length; o += GALAXY_FLOATS) {
    const x = output[o]!;
    const y = output[o + 1]!;
    const z = output[o + 2]!;
    const radius = Math.hypot(x, y, z);
    if (!Number.isFinite(radius) || radius <= 0) continue;

    const mpc = legacyMpcFromVisualAU(radius, meta);
    const scaledRadius = galaxyVisualDistanceAU(mpc);
    const scale = scaledRadius / radius;
    if (!Number.isFinite(scale) || scale <= 0) continue;

    output[o] = x * scale;
    output[o + 1] = y * scale;
    output[o + 2] = z * scale;
  }
  return output;
}

function addLocalGroupAnchors(data: GalaxyBuffer, names: NamedGalaxy[]): GalaxyLoad {
  const rowCount = Math.floor(data.length / GALAXY_FLOATS);
  const localCount = Math.min(LOCAL_GROUP_GALAXY_LABELS.length, rowCount);
  if (localCount <= 0) {
    return { data, names, source: "" };
  }

  const output = new Float32Array(data.length);
  for (let i = 0; i < localCount; i++) {
    const galaxy = LOCAL_GROUP_GALAXY_LABELS[i]!;
    const o = i * GALAXY_FLOATS;
    output[o] = galaxy.x;
    output[o + 1] = galaxy.y;
    output[o + 2] = galaxy.z;
    output[o + 3] = galaxy.size;
    output[o + 4] = galaxy.color[0];
    output[o + 5] = galaxy.color[1];
    output[o + 6] = galaxy.color[2];
    output[o + 7] = galaxy.alpha;
  }

  const remainingFloats = output.length - localCount * GALAXY_FLOATS;
  if (remainingFloats > 0) {
    output.set(data.subarray(0, remainingFloats), localCount * GALAXY_FLOATS);
  }

  const shiftedNameLimit = rowCount - localCount;
  const shiftedNames = names
    .filter(g => g.index < shiftedNameLimit)
    .map(g => ({ index: g.index + localCount, name: g.name, dist: g.dist }));
  const localNames = LOCAL_GROUP_GALAXY_LABELS
    .slice(0, localCount)
    .map((g, index) => ({ index, name: g.name, dist: +g.dist.toFixed(3) }));

  return {
    data: output,
    names: [...localNames, ...shiftedNames],
    source: `${localCount} Local Group anchors + `,
  };
}

export async function loadGalaxyCatalog(): Promise<GalaxyLoad> {
  const [binResp, nameResp, meta] = await Promise.all([
    fetch("/data/galaxies-100k.bin"),
    fetch("/data/galaxy-names.json"),
    loadGalaxyMeta(),
  ]);

  if (!binResp.ok)  throw new Error(`galaxies-100k.bin  HTTP ${binResp.status}`);
  if (!nameResp.ok) throw new Error(`galaxy-names.json  HTTP ${nameResp.status}`);

  const [buf, names] = await Promise.all([
    binResp.arrayBuffer(),
    nameResp.json() as Promise<NamedGalaxy[]>,
  ]);

  if (buf.byteLength % (GALAXY_FLOATS * 4) !== 0) {
    throw new Error("Galaxy binary stride mismatch");
  }

  const raw = new Float32Array(buf);
  const remapLegacy = meta?.distanceScaleVersion !== GALAXY_SCALE_VERSION;
  const data = remapLegacy ? remapLegacyGalaxyDistances(raw, meta) : raw;
  const withLocalGroup = addLocalGroupAnchors(data, names);
  const scaleLabel = remapLegacy
    ? "legacy binary remapped to Local Group-linear scale"
    : GALAXY_SCALE_VERSION;

  return {
    data: withLocalGroup.data,
    names: withLocalGroup.names,
    source: `${withLocalGroup.source}${buf.byteLength / GALAXY_FLOATS / 4 / 1000}k galaxies (Simbad + procedural, ${scaleLabel})`,
  };
}

export interface GalaxySearchResult {
  name:         string;
  dist:         number;
  /** Visual world-space position in AU */
  x: number; y: number; z: number;
}

export function searchGalaxies(
  names:  NamedGalaxy[],
  data:   GalaxyBuffer,
  query:  string,
  limit   = 8,
): GalaxySearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  return names
    .filter(g => g.name.toLowerCase().includes(q))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit)
    .map(g => {
      const o = g.index * GALAXY_FLOATS;
      return { name: g.name, dist: g.dist, x: data[o]!, y: data[o+1]!, z: data[o+2]! };
    });
}

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

const LEGACY_GALAXY_BASE_AU = 200_000;
const LEGACY_GALAXY_LOG_SCALE_AU = 50_000;
const LEGACY_GALAXY_REFERENCE_MPC = 0.01;

export type GalaxyBuffer = Float32Array;

export interface NamedGalaxy {
  index: number;
  name:  string;
  dist:  number; // Mpc
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

export function galaxyVisualDistanceAU(mpc: number): number {
  const d = Number.isFinite(mpc) ? Math.max(0, mpc) : 0;
  if (d <= GALAXY_LINEAR_LIMIT_MPC) return d * GALAXY_MPC_TO_AU;

  const beyond = (d - GALAXY_LINEAR_LIMIT_MPC) / GALAXY_LOG_INTERVAL_MPC;
  return GALAXY_LINEAR_LIMIT_AU + GALAXY_LOG_SCALE_AU * Math.log2(beyond + 1);
}

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
  const scaleLabel = remapLegacy
    ? "legacy binary remapped to Local Group-linear scale"
    : GALAXY_SCALE_VERSION;

  return {
    data,
    names,
    source: `${buf.byteLength / GALAXY_FLOATS / 4 / 1000}k galaxies (Simbad + procedural, ${scaleLabel})`,
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

/**
 * Galaxy catalog — 100k nearest galaxies (50k real Simbad + 50k procedural).
 *
 * Binary: 100 000 × 8 floats = 3.1 MB
 *   [0-2] visual position AU (ecliptic J2000, log-compressed)
 *   [3]   size multiplier
 *   [4-6] RGB colour
 *   [7]   alpha
 */

export const GALAXY_FLOATS = 8;
export const GALAXY_BASE_AU   = 200_000;
export const GALAXY_LOG_SCALE = 50_000;

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

export async function loadGalaxyCatalog(): Promise<GalaxyLoad> {
  const [binResp, nameResp] = await Promise.all([
    fetch("/data/galaxies-100k.bin"),
    fetch("/data/galaxy-names.json"),
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

  return {
    data:   new Float32Array(buf),
    names,
    source: `${buf.byteLength / GALAXY_FLOATS / 4 / 1000}k galaxies (Simbad + procedural)`,
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

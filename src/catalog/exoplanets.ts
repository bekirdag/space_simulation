/**
 * Individual exoplanet orbital data for well-known systems.
 * Sources: NASA Exoplanet Archive (confirmed planet data, 2025).
 *
 * These are NOT part of the N-body physics simulation. They are rendered as
 * colored bodies orbiting their host star's visual catalog position using
 * simple circular orbit mechanics synchronized with simYears.
 */

export interface ExoplanetData {
  name:        string;          // e.g. "TRAPPIST-1 b"
  hostName:    string;          // must match CatalogStar.name
  semiMajorAU: number;          // semi-major axis (AU)
  periodDays:  number;          // orbital period (Earth days)
  radiusEarth: number | null;   // planet radius (Earth radii), null if unknown
  massEarth:   number | null;   // planet mass (Earth masses), null if unknown
}

// Colour based on radius:  > 8 Re = hot Jupiter (blue-grey), 4-8 = gas giant, 2-4 = sub-Neptune, 1-2 = super-Earth, ≤1 = rocky
export function exoplanetColor(radiusEarth: number | null): [number, number, number] {
  if (radiusEarth === null) return [0.75, 0.75, 0.75];
  if (radiusEarth >= 8)    return [0.55, 0.70, 0.95]; // hot Jupiter – blue-grey
  if (radiusEarth >= 4)    return [0.85, 0.78, 0.60]; // gas giant – tan
  if (radiusEarth >= 2)    return [0.45, 0.80, 0.80]; // sub-Neptune / mini-Neptune – teal
  if (radiusEarth >= 1.25) return [0.80, 0.60, 0.42]; // super-Earth – rusty
  return [0.38, 0.62, 0.52];                           // rocky – muted teal-green
}

const KM_PER_AU = 149_597_870.7;
const EARTH_MEAN_RADIUS_KM = 6_371.0;
export const EARTH_RADIUS_AU = EARTH_MEAN_RADIUS_KM / KM_PER_AU;

/** Physical exoplanet radius in AU. Unknown catalog radii fall back to Earth radius. */
export function exoplanetRadiusAU(radiusEarth: number | null): number {
  const radiusRe = radiusEarth !== null && Number.isFinite(radiusEarth) && radiusEarth > 0
    ? radiusEarth
    : 1;
  return radiusRe * EARTH_RADIUS_AU;
}

/** Deterministic initial orbital phase from planet name hash. */
export function initialPhase(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 1000 * 2 * Math.PI;
}

/** Compute planet world position for a given epoch offset (simYears). */
export function planetWorldPos(
  starX: number, starY: number, starZ: number,
  planet: ExoplanetData,
  simYears: number,
): [number, number, number] {
  const periodYr = planet.periodDays / 365.25;
  const phase    = (simYears / periodYr) * 2 * Math.PI + initialPhase(planet.name);
  return [
    starX + planet.semiMajorAU * Math.cos(phase),
    starY + planet.semiMajorAU * Math.sin(phase),
    starZ,
  ];
}

// ── Catalog (well-known confirmed systems) ────────────────────────────────────

export const EXOPLANET_CATALOG: ExoplanetData[] = [
  // ── TRAPPIST-1 (7 planets) ────────────────────────────────────────────────
  { name:"TRAPPIST-1 b", hostName:"TRAPPIST-1", semiMajorAU:0.01111, periodDays:1.51087,  radiusEarth:1.116, massEarth:1.374 },
  { name:"TRAPPIST-1 c", hostName:"TRAPPIST-1", semiMajorAU:0.01522, periodDays:2.42180,  radiusEarth:1.097, massEarth:1.308 },
  { name:"TRAPPIST-1 d", hostName:"TRAPPIST-1", semiMajorAU:0.02143, periodDays:4.04961,  radiusEarth:0.788, massEarth:0.388 },
  { name:"TRAPPIST-1 e", hostName:"TRAPPIST-1", semiMajorAU:0.02817, periodDays:6.10130,  radiusEarth:0.920, massEarth:0.692 },
  { name:"TRAPPIST-1 f", hostName:"TRAPPIST-1", semiMajorAU:0.03710, periodDays:9.20750,  radiusEarth:1.045, massEarth:1.039 },
  { name:"TRAPPIST-1 g", hostName:"TRAPPIST-1", semiMajorAU:0.04510, periodDays:12.35240, radiusEarth:1.129, massEarth:1.321 },
  { name:"TRAPPIST-1 h", hostName:"TRAPPIST-1", semiMajorAU:0.06300, periodDays:18.76720, radiusEarth:0.755, massEarth:0.326 },

  // ── Proxima Centauri ──────────────────────────────────────────────────────
  { name:"Proxima Cen b", hostName:"Proxima Centauri", semiMajorAU:0.04856, periodDays:11.18600, radiusEarth:null, massEarth:1.07 },

  // ── 51 Peg ────────────────────────────────────────────────────────────────
  { name:"51 Peg b", hostName:"51 Peg", semiMajorAU:0.05272, periodDays:4.23077, radiusEarth:null, massEarth:146.0 },

  // ── HD 209458 ─────────────────────────────────────────────────────────────
  { name:"HD 209458 b", hostName:"HD 209458", semiMajorAU:0.04707, periodDays:3.52472, radiusEarth:15.0, massEarth:220.0 },

  // ── Kepler-22 ─────────────────────────────────────────────────────────────
  { name:"Kepler-22 b",  hostName:"Kepler-22", semiMajorAU:0.849, periodDays:289.864, radiusEarth:2.38, massEarth:null },

  // ── 55 Cnc (5 planets) ───────────────────────────────────────────────────
  { name:"55 Cnc e", hostName:"55 Cnc", semiMajorAU:0.01560, periodDays:0.73654,  radiusEarth:1.99,  massEarth:8.09 },
  { name:"55 Cnc b", hostName:"55 Cnc", semiMajorAU:0.11340, periodDays:14.6516,  radiusEarth:null,  massEarth:264.0 },
  { name:"55 Cnc c", hostName:"55 Cnc", semiMajorAU:0.24030, periodDays:44.3790,  radiusEarth:null,  massEarth:55.0 },
  { name:"55 Cnc f", hostName:"55 Cnc", semiMajorAU:0.77080, periodDays:260.750,  radiusEarth:null,  massEarth:46.0 },
  { name:"55 Cnc d", hostName:"55 Cnc", semiMajorAU:5.74000, periodDays:5218.0,   radiusEarth:null,  massEarth:1243.0 },

  // ── Tau Ceti (4 confirmed planets) ────────────────────────────────────────
  { name:"Tau Ceti g", hostName:"Tau Ceti", semiMajorAU:0.1330, periodDays:20.00,  radiusEarth:null, massEarth:1.75 },
  { name:"Tau Ceti h", hostName:"Tau Ceti", semiMajorAU:0.2430, periodDays:49.41,  radiusEarth:null, massEarth:1.83 },
  { name:"Tau Ceti e", hostName:"Tau Ceti", semiMajorAU:0.5380, periodDays:162.87, radiusEarth:null, massEarth:3.93 },
  { name:"Tau Ceti f", hostName:"Tau Ceti", semiMajorAU:1.3340, periodDays:636.13, radiusEarth:null, massEarth:3.93 },

  // ── WASP-12 ───────────────────────────────────────────────────────────────
  { name:"WASP-12 b", hostName:"WASP-12", semiMajorAU:0.02340, periodDays:1.09142, radiusEarth:20.3, massEarth:445.0 },

  // ── Kepler-452 ────────────────────────────────────────────────────────────
  { name:"Kepler-452 b", hostName:"Kepler-452", semiMajorAU:1.046, periodDays:384.843, radiusEarth:1.63, massEarth:null },

  // ── LHS 1140 ─────────────────────────────────────────────────────────────
  { name:"LHS 1140 c", hostName:"LHS 1140", semiMajorAU:0.02672, periodDays:3.7779,  radiusEarth:1.282, massEarth:1.81 },
  { name:"LHS 1140 b", hostName:"LHS 1140", semiMajorAU:0.09360, periodDays:24.7369, radiusEarth:1.727, massEarth:6.98 },

  // ── HD 189733 ─────────────────────────────────────────────────────────────
  { name:"HD 189733 b", hostName:"HD 189733", semiMajorAU:0.03142, periodDays:2.21858, radiusEarth:13.0, massEarth:360.0 },

  // ── GJ 1214 ───────────────────────────────────────────────────────────────
  { name:"GJ 1214 b", hostName:"GJ 1214", semiMajorAU:0.01411, periodDays:1.58040, radiusEarth:2.742, massEarth:6.55 },

  // ── K2-18 ─────────────────────────────────────────────────────────────────
  { name:"K2-18 b", hostName:"K2-18", semiMajorAU:0.14290, periodDays:32.9440, radiusEarth:2.711, massEarth:8.63 },

  // ── Kepler-186 ────────────────────────────────────────────────────────────
  { name:"Kepler-186 b", hostName:"Kepler-186", semiMajorAU:0.07390, periodDays:3.8867,   radiusEarth:1.07, massEarth:null },
  { name:"Kepler-186 c", hostName:"Kepler-186", semiMajorAU:0.08810, periodDays:7.2676,   radiusEarth:1.25, massEarth:null },
  { name:"Kepler-186 d", hostName:"Kepler-186", semiMajorAU:0.22650, periodDays:13.3428,  radiusEarth:1.40, massEarth:null },
  { name:"Kepler-186 e", hostName:"Kepler-186", semiMajorAU:0.32930, periodDays:22.4077,  radiusEarth:1.61, massEarth:null },
  { name:"Kepler-186 f", hostName:"Kepler-186", semiMajorAU:0.43210, periodDays:129.9441, radiusEarth:1.17, massEarth:null },

  // ── Kepler-11 (6-planet system) ───────────────────────────────────────────
  { name:"Kepler-11 b", hostName:"Kepler-11", semiMajorAU:0.0910, periodDays:10.3039,  radiusEarth:1.97, massEarth:1.9  },
  { name:"Kepler-11 c", hostName:"Kepler-11", semiMajorAU:0.1060, periodDays:13.0241,  radiusEarth:3.15, massEarth:2.9  },
  { name:"Kepler-11 d", hostName:"Kepler-11", semiMajorAU:0.1550, periodDays:22.6845,  radiusEarth:3.43, massEarth:7.3  },
  { name:"Kepler-11 e", hostName:"Kepler-11", semiMajorAU:0.1950, periodDays:31.9959,  radiusEarth:4.52, massEarth:8.0  },
  { name:"Kepler-11 f", hostName:"Kepler-11", semiMajorAU:0.2500, periodDays:46.6888,  radiusEarth:2.61, massEarth:2.0  },
  { name:"Kepler-11 g", hostName:"Kepler-11", semiMajorAU:0.4620, periodDays:118.3779, radiusEarth:3.33, massEarth:null },

  // ── TOI-700 ───────────────────────────────────────────────────────────────
  { name:"TOI-700 b", hostName:"TOI-700", semiMajorAU:0.07890, periodDays:9.9767,  radiusEarth:1.01, massEarth:null },
  { name:"TOI-700 c", hostName:"TOI-700", semiMajorAU:0.16340, periodDays:27.8098, radiusEarth:2.63, massEarth:null },
  { name:"TOI-700 d", hostName:"TOI-700", semiMajorAU:0.16340, periodDays:37.4228, radiusEarth:1.14, massEarth:null },
  { name:"TOI-700 e", hostName:"TOI-700", semiMajorAU:0.13390, periodDays:27.8098, radiusEarth:0.95, massEarth:null },

  // ── Kepler-90 (8 planets — most in one system) ────────────────────────────
  { name:"Kepler-90 b", hostName:"Kepler-90", semiMajorAU:0.0736, periodDays:7.00869,   radiusEarth:1.31,  massEarth:null },
  { name:"Kepler-90 c", hostName:"Kepler-90", semiMajorAU:0.0890, periodDays:8.71958,   radiusEarth:1.18,  massEarth:null },
  { name:"Kepler-90 i", hostName:"Kepler-90", semiMajorAU:0.1253, periodDays:14.44913,  radiusEarth:1.32,  massEarth:null },
  { name:"Kepler-90 d", hostName:"Kepler-90", semiMajorAU:0.3200, periodDays:59.73668,  radiusEarth:2.88,  massEarth:null },
  { name:"Kepler-90 e", hostName:"Kepler-90", semiMajorAU:0.4230, periodDays:91.93913,  radiusEarth:2.67,  massEarth:null },
  { name:"Kepler-90 f", hostName:"Kepler-90", semiMajorAU:0.4800, periodDays:124.91440, radiusEarth:2.89,  massEarth:null },
  { name:"Kepler-90 g", hostName:"Kepler-90", semiMajorAU:0.7100, periodDays:210.60697, radiusEarth:8.13,  massEarth:null },
  { name:"Kepler-90 h", hostName:"Kepler-90", semiMajorAU:1.0100, periodDays:331.60059, radiusEarth:11.32, massEarth:null },
];

// ── Index structures ──────────────────────────────────────────────────────────

/** Map from host star name → its planets. */
const BY_HOST = new Map<string, ExoplanetData[]>();
/** Map from planet name (lower-case) → planet. */
const BY_NAME = new Map<string, ExoplanetData>();

for (const p of EXOPLANET_CATALOG) {
  const list = BY_HOST.get(p.hostName) ?? [];
  list.push(p);
  BY_HOST.set(p.hostName, list);
  BY_NAME.set(p.name.toLowerCase(), p);
}

export function planetsForHost(hostName: string): ExoplanetData[] {
  return BY_HOST.get(hostName) ?? [];
}

export function planetByName(name: string): ExoplanetData | undefined {
  return BY_NAME.get(name.toLowerCase());
}

export interface ExoplanetSearchResult {
  planet:       ExoplanetData;
  label:        string;
  subtitle:     string;
  x: number; y: number; z: number;
  focusDistance: number;
}

/** Search for exoplanets matching the query. Returns up to `limit` results. */
export function searchExoplanets(
  query:       string,
  getStarPos:  (hostName: string) => [number, number, number] | null,
  simYears:    number,
  limit = 8,
): ExoplanetSearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  const results: Array<{ planet: ExoplanetData; score: number }> = [];

  for (const planet of EXOPLANET_CATALOG) {
    const n = planet.name.toLowerCase();
    const h = planet.hostName.toLowerCase();
    let score = 0;
    if (n === q)                  score += 100;
    if (n.startsWith(q))          score += 65;
    if (n.includes(q))            score += 35;
    if (h.includes(q))            score += 15;
    if (score === 0) continue;
    results.push({ planet, score });
  }

  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit).flatMap(({ planet }) => {
    const sp = getStarPos(planet.hostName);
    if (!sp) return [];
    const [x, y, z] = planetWorldPos(sp[0], sp[1], sp[2], planet, simYears);
    const radiusAU = exoplanetRadiusAU(planet.radiusEarth);
    const rStr  = planet.radiusEarth ? `${planet.radiusEarth.toFixed(2)} R⊕` : 'radius unknown';
    const pStr  = `${planet.periodDays < 10 ? planet.periodDays.toFixed(2) : planet.periodDays.toFixed(1)} d orbit`;
    const aStr  = `${planet.semiMajorAU < 0.1 ? planet.semiMajorAU.toFixed(4) : planet.semiMajorAU.toFixed(3)} AU`;
    return [{
      planet,
      label:        planet.name,
      subtitle:     `${planet.hostName} · ${rStr} · ${pStr} · ${aStr}`,
      x, y, z,
      focusDistance: Math.max(1e-4, radiusAU * 6),
    }];
  });
}

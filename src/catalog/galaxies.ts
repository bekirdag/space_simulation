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

// All labeled nearby galaxies injected at runtime. The binary catalog (galaxies-100k.bin)
// does NOT contain these; they are placed at positions 0..N-1 by addLocalGroupAnchors.
// Coordinates: J2000 equatorial degrees. Distances: Mpc (McConnachie 2012 + NED).
// Color: [r,g,b] in sRGB. Size/alpha: calibrated for visual quality.
// ADD ONLY entries with verified RA/Dec/dist — wrong coords create phantom blobs.
const LOCAL_GROUP_SOURCES: LocalGroupGalaxySource[] = [
  // ── Milky Way satellites (0–0.45 Mpc) ────────────────────────────────────
  // Sgr Dwarf sits behind the galactic centre — label prevents confusion with MW blob.
  { id:"sgr-dwarf",    name:"Sagittarius Dwarf Spheroidal", ra:283.8313, dec:-30.4783, dist:0.026, size:1.40, color:[0.90,0.80,0.65], alpha:0.60 },
  { id:"lmc",          name:"Large Magellanic Cloud",       ra: 80.8939, dec:-69.7561, dist:0.050, size:1.85, color:[0.62,0.72,1.00], alpha:0.78 },
  { id:"smc",          name:"Small Magellanic Cloud",       ra: 13.1867, dec:-72.8286, dist:0.062, size:1.50, color:[0.62,0.72,1.00], alpha:0.70 },
  { id:"ursa-minor",   name:"Ursa Minor Dwarf",             ra:227.2833, dec: 67.2222, dist:0.076, size:0.92, color:[0.88,0.83,0.70], alpha:0.50 },
  { id:"draco",        name:"Draco Dwarf",                  ra:260.0514, dec: 57.9153, dist:0.082, size:0.92, color:[0.88,0.83,0.70], alpha:0.50 },
  { id:"sculptor-dwarf",name:"Sculptor Dwarf Galaxy",       ra: 15.0392, dec:-33.7092, dist:0.086, size:1.05, color:[0.86,0.82,0.72], alpha:0.56 },
  { id:"sextans-dwarf",name:"Sextans Dwarf",                ra:153.2625, dec: -1.6147, dist:0.086, size:0.88, color:[0.88,0.83,0.70], alpha:0.48 },
  { id:"ursa-major-i", name:"Ursa Major I Dwarf",           ra:158.7208, dec: 51.9208, dist:0.097, size:0.85, color:[0.88,0.83,0.70], alpha:0.48 },
  { id:"carina-dwarf", name:"Carina Dwarf",                 ra:100.4028, dec:-50.9661, dist:0.105, size:0.95, color:[0.86,0.82,0.72], alpha:0.52 },
  { id:"tucana-ii",    name:"Tucana II",                    ra:248.7167, dec:-50.2333, dist:0.130, size:0.80, color:[0.88,0.83,0.70], alpha:0.44 },
  { id:"fornax-dwarf", name:"Fornax Dwarf Galaxy",          ra: 39.9971, dec:-34.4492, dist:0.147, size:1.08, color:[0.86,0.82,0.72], alpha:0.56 },
  { id:"reticulum-ii", name:"Reticulum II",                 ra: 53.9208, dec:-54.0500, dist:0.158, size:0.80, color:[0.88,0.83,0.70], alpha:0.44 },
  { id:"hydrus-i",     name:"Hydrus I",                     ra:186.4333, dec:-57.9417, dist:0.160, size:0.80, color:[0.88,0.83,0.70], alpha:0.44 },
  { id:"leo-ii-dwarf", name:"Leo II Dwarf",                 ra:168.3667, dec: 22.1519, dist:0.233, size:0.88, color:[0.86,0.82,0.72], alpha:0.48 },
  { id:"leo-i-dwarf",  name:"Leo I Dwarf Galaxy",           ra:152.1171, dec: 12.3064, dist:0.254, size:1.02, color:[0.86,0.82,0.72], alpha:0.52 },
  { id:"phoenix-dwarf",name:"Phoenix Dwarf Galaxy",         ra:354.3500, dec:-15.2667, dist:0.415, size:0.85, color:[0.62,0.75,1.00], alpha:0.46 },
  { id:"leo-t",        name:"Leo T Dwarf",                  ra:143.7233, dec: 17.0514, dist:0.420, size:0.80, color:[0.62,0.75,1.00], alpha:0.44 },
  // ── Local Group — outer members (0.49–1.3 Mpc) ───────────────────────────
  { id:"barnards-galaxy",name:"Barnard's Galaxy (NGC 6822)",ra:296.2366, dec:-14.8039, dist:0.490, size:1.25, color:[0.58,0.68,1.00], alpha:0.62 },
  { id:"ngc-185",      name:"NGC 185",                      ra:  9.7416, dec: 48.3374, dist:0.616, size:1.10, color:[0.95,0.83,0.58], alpha:0.58 },
  { id:"andromeda-ii", name:"Andromeda II",                 ra: 19.1167, dec: 33.4167, dist:0.652, size:0.80, color:[0.90,0.84,0.70], alpha:0.44 },
  { id:"ngc-147",      name:"NGC 147",                      ra:  8.3005, dec: 48.5087, dist:0.712, size:1.05, color:[0.95,0.83,0.58], alpha:0.54 },
  { id:"andromeda-xvi",name:"Andromeda XVI",                ra:355.0000, dec: 46.4500, dist:0.731, size:0.72, color:[0.90,0.84,0.70], alpha:0.40 },
  { id:"andromeda-i",  name:"Andromeda I",                  ra:  5.7583, dec: 43.5028, dist:0.745, size:0.78, color:[0.90,0.84,0.70], alpha:0.43 },
  { id:"andromeda-iii",name:"Andromeda III",                ra: 17.4333, dec: 36.5028, dist:0.749, size:0.75, color:[0.90,0.84,0.70], alpha:0.42 },
  { id:"andromeda-x",  name:"Andromeda X",                  ra:  2.3750, dec: 33.5528, dist:0.750, size:0.72, color:[0.90,0.84,0.70], alpha:0.40 },
  { id:"ic-1613",      name:"IC 1613",                      ra: 15.9600, dec:  2.1100, dist:0.755, size:1.05, color:[0.62,0.75,1.00], alpha:0.54 },
  { id:"pegasus-dwarf",name:"Pegasus Dwarf Irregular",      ra:350.8000, dec: 14.7500, dist:0.760, size:0.88, color:[0.62,0.75,1.00], alpha:0.46 },
  { id:"andromeda-vii",name:"Andromeda VII",                ra:350.0167, dec: 26.3333, dist:0.762, size:0.78, color:[0.90,0.84,0.70], alpha:0.43 },
  { id:"andromeda-v",  name:"Andromeda V",                  ra:  2.6125, dec: 40.9028, dist:0.774, size:0.75, color:[0.90,0.84,0.70], alpha:0.42 },
  { id:"andromeda",    name:"Andromeda Galaxy (M31)",        ra: 10.6847, dec: 41.2688, dist:0.785, size:2.45, color:[0.82,0.88,1.00], alpha:0.86 },
  { id:"andromeda-vi", name:"Andromeda VI (Pegasus dSph)",  ra: 16.5208, dec: 24.3639, dist:0.783, size:0.76, color:[0.90,0.84,0.70], alpha:0.42 },
  { id:"ic-10",        name:"IC 10",                        ra:  5.0721, dec: 59.3039, dist:0.790, size:1.20, color:[0.58,0.68,1.00], alpha:0.60 },
  { id:"m32",          name:"M32 (NGC 221)",                ra: 10.6742, dec: 40.8653, dist:0.805, size:1.10, color:[0.95,0.83,0.58], alpha:0.62 },
  { id:"ngc-205",      name:"NGC 205 (M110)",               ra: 10.0917, dec: 41.6861, dist:0.815, size:1.12, color:[0.90,0.84,0.70], alpha:0.60 },
  { id:"triangulum",   name:"Triangulum Galaxy (M33)",      ra: 23.4621, dec: 30.6602, dist:0.850, size:1.90, color:[0.74,0.82,1.00], alpha:0.76 },
  { id:"wlm",          name:"WLM Galaxy",                   ra:  0.4923, dec:-15.4610, dist:0.985, size:1.12, color:[0.58,0.68,1.00], alpha:0.54 },
  { id:"antlia-dwarf", name:"Antlia Dwarf",                 ra:143.7208, dec: -0.8167, dist:1.300, size:0.78, color:[0.86,0.82,0.72], alpha:0.42 },
  // ── Nearby groups (1.5–20 Mpc) ───────────────────────────────────────────
  { id:"maffei-1",     name:"Maffei 1",                     ra: 50.6625, dec: 59.6092, dist:3.000, size:1.40, color:[0.95,0.83,0.58], alpha:0.60 },
  { id:"maffei-2",     name:"Maffei 2",                     ra: 51.5167, dec: 59.5917, dist:3.400, size:1.20, color:[0.78,0.85,1.00], alpha:0.55 },
  { id:"ic-342",       name:"IC 342",                       ra: 56.7000, dec: 68.1000, dist:3.300, size:1.35, color:[0.78,0.85,1.00], alpha:0.58 },
  { id:"ngc-2403",     name:"NGC 2403",                     ra:114.2100, dec: 65.6000, dist:3.180, size:1.25, color:[0.78,0.85,1.00], alpha:0.58 },
  { id:"ngc-253",      name:"NGC 253 (Sculptor Galaxy)",    ra: 11.8900, dec:-25.2900, dist:3.500, size:1.60, color:[0.78,0.85,1.00], alpha:0.65 },
  { id:"m82",          name:"M82 (Cigar Galaxy)",           ra:148.9700, dec: 69.6800, dist:3.530, size:1.30, color:[0.68,0.82,1.00], alpha:0.62 },
  { id:"m81",          name:"M81 (Bode's Galaxy)",          ra:148.8800, dec: 69.0700, dist:3.630, size:1.80, color:[0.82,0.88,1.00], alpha:0.70 },
  { id:"cen-a",        name:"Centaurus A (NGC 5128)",       ra:201.3700, dec:-43.0200, dist:3.800, size:2.00, color:[0.95,0.83,0.58], alpha:0.72 },
  { id:"m83",          name:"M83 (Southern Pinwheel)",      ra:204.2500, dec:-29.8700, dist:4.610, size:1.50, color:[0.78,0.85,1.00], alpha:0.62 },
  { id:"m96",          name:"M96 (NGC 3368)",               ra:159.4700, dec: 11.8200, dist:4.690, size:1.20, color:[0.92,0.86,0.70], alpha:0.56 },
  { id:"m66",          name:"M66 (NGC 3627)",               ra:170.0700, dec: 13.1500, dist:5.210, size:1.22, color:[0.78,0.85,1.00], alpha:0.55 },
  { id:"m65",          name:"M65 (NGC 3623)",               ra:169.7300, dec: 13.5900, dist:5.220, size:1.15, color:[0.92,0.86,0.70], alpha:0.53 },
  { id:"m101",         name:"M101 (Pinwheel Galaxy)",       ra:210.8000, dec: 54.3500, dist:6.400, size:1.60, color:[0.68,0.80,1.00], alpha:0.62 },
  { id:"m51",          name:"M51 (Whirlpool Galaxy)",       ra:202.4700, dec: 47.2000, dist:7.220, size:1.45, color:[0.68,0.80,1.00], alpha:0.60 },
  { id:"m106",         name:"M106 (NGC 4258)",              ra:185.0300, dec: 47.3000, dist:7.200, size:1.40, color:[0.78,0.85,1.00], alpha:0.58 },
  { id:"m63",          name:"M63 (Sunflower Galaxy)",       ra:198.9600, dec: 42.0300, dist:7.900, size:1.30, color:[0.78,0.85,1.00], alpha:0.56 },
  { id:"m104",         name:"M104 (Sombrero Galaxy)",       ra:189.9900, dec:-11.6200, dist:9.550, size:1.40, color:[0.92,0.86,0.70], alpha:0.58 },
  { id:"m87",          name:"M87 (Virgo A)",                ra:187.7100, dec: 12.3900, dist:16.40, size:1.80, color:[0.95,0.83,0.58], alpha:0.65 },
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

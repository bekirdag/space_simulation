import { NEBULA_FLOATS } from "./nebulas";

// Partial Milky Way dust clouds generated from the NASA/GSFC LAMBDA
// Meisner-Finkbeiner 2015 E(B-V) all-sky Galactic dust map.
//
// Each dust instance reuses the nebula billboard buffer layout so the renderer
// can draw the clouds as batched procedural cloud models. The source map is a
// 2D total line-of-sight reddening product: it has angular density, not true
// distances. We therefore sample cloud positions in a Milky Way-centered
// galactocentric disk/spiral model, then use the measured all-sky map only as
// an angular density weight seen from the Sun.

export const DUST_CLOUD_FLOATS = NEBULA_FLOATS;
export const DUST_CLOUD_COUNT = 48_000;
export const DUST_CLOUD_DEFAULT_DRAW_COUNT = 24_000;
export const DUST_CLOUD_CAPACITY = DUST_CLOUD_COUNT;
export const DUST_MAP_FLOATS = 8;
export const DUST_MILKY_WAY_KPC_TO_AU = 8_000;
export const DUST_SUN_GALACTIC_RADIUS_KPC = 8.5;
export const DUST_GALAXY_RADIUS_KPC = 16.5;
export const DUST_GALAXY_HALF_HEIGHT_KPC = 1.6;
export const DUST_GALAXY_HALF_HEIGHT_AU = DUST_GALAXY_HALF_HEIGHT_KPC * DUST_MILKY_WAY_KPC_TO_AU;
export const DUST_CLOUD_SOURCE =
  `${DUST_CLOUD_COUNT.toLocaleString()} MF2015 reddening-weighted Milky Way disk dust clouds ` +
  `(${DUST_CLOUD_DEFAULT_DRAW_COUNT.toLocaleString()} drawn by default)`;

const DUST_MAP_DATA_URL = "/data/dust-map-mf2015.bin";
const DUST_MAP_META_URL = "/data/dust-map-mf2015.meta.json";
const DUST_MAP_MIN_ALPHA = 0.006;
const DUST_MAP_ALPHA_RANGE = 0.080;
const DUST_CLOUD_MIN_RADIUS_AU = 180;
const DUST_CLOUD_MAX_RADIUS_AU = 950;
const DUST_DISK_SAMPLE_HALF_HEIGHT_KPC = 0.52;
const DUST_VERTICAL_SCALE_KPC = 0.12;
const DUST_DIRECTION_LON_BINS = 360;
const DUST_DIRECTION_LAT_BINS = 160;

const TAU = Math.PI * 2;
const GAL_TO_ECL = [
  [-0.054876,  0.494109, -0.867666],
  [-0.993911, -0.111106, -0.000312],
  [-0.096390,  0.862326,  0.497159],
] as const;

function srgbChannelToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function linearHexColor(hex: number): [number, number, number] {
  return [
    srgbChannelToLinear(((hex >> 16) & 0xff) / 255),
    srgbChannelToLinear(((hex >> 8) & 0xff) / 255),
    srgbChannelToLinear((hex & 0xff) / 255),
  ];
}

const DUST_DARK_PALETTE: Array<[number, number, number]> = [
  linearHexColor(0x0c0a0a), // inky cosmic black
  linearHexColor(0x1e1613), // silhouette charcoal brown
];
const DUST_REDDENING_PALETTE: Array<[number, number, number]> = [
  linearHexColor(0x8a3d19), // deep cosmic rust
  linearHexColor(0xd46a27), // muted sunset amber
];
const DUST_REFLECTION_PALETTE: Array<[number, number, number]> = [
  linearHexColor(0x528ca3), // dusty sky blue
  linearHexColor(0x31647d), // deep cosmic cyan
];
const DUST_DARK_SHARE = 0.80;
const DUST_REDDENING_SHARE = 0.17;

const ARMS = [
  { theta0: Math.PI * 0.0,  r0: 6.0, tanp: Math.tan(0.21), width: 0.45 },
  { theta0: Math.PI * 0.5,  r0: 5.5, tanp: Math.tan(0.21), width: 0.45 },
  { theta0: Math.PI * 1.0,  r0: 6.0, tanp: Math.tan(0.21), width: 0.45 },
  { theta0: Math.PI * 1.5,  r0: 5.5, tanp: Math.tan(0.21), width: 0.45 },
  { theta0: Math.PI * 0.35, r0: 8.5, tanp: Math.tan(0.19), width: 0.35 },
] as const;

export interface DustMapBuffer {
  data: Float32Array;
  source: string;
}

export async function loadDustMap(): Promise<DustMapBuffer> {
  const res = await fetch(DUST_MAP_DATA_URL, { cache: "force-cache" });
  if (!res.ok) throw new Error(`Failed to fetch ${DUST_MAP_DATA_URL}: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength % (DUST_MAP_FLOATS * 4) !== 0) {
    throw new Error(`Dust map buffer has invalid byte length: ${buf.byteLength}`);
  }

  let source = "NASA/GSFC LAMBDA Meisner-Finkbeiner 2015 E(B-V) dust map";
  try {
    const metaRes = await fetch(DUST_MAP_META_URL, { cache: "force-cache" });
    if (metaRes.ok) {
      const meta = await metaRes.json() as { sourceName?: string; cellCount?: number };
      source = meta.sourceName ?? source;
    }
  } catch {
    // Metadata is informative only; the binary is enough to seed the clouds.
  }

  return { data: new Float32Array(buf), source };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function createRand(seed = 0x8f6e5a31): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function randn(rand: () => number): number {
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(TAU * u2);
}

function normalize3(x: number, y: number, z: number): [number, number, number] {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function galacticCartesianToEclipticAU(xgc: number, ygc: number, zgc: number): [number, number, number] {
  const xh = xgc + DUST_SUN_GALACTIC_RADIUS_KPC;
  const yh = ygc;
  const zh = zgc;
  return [
    (GAL_TO_ECL[0][0] * xh + GAL_TO_ECL[0][1] * yh + GAL_TO_ECL[0][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
    (GAL_TO_ECL[1][0] * xh + GAL_TO_ECL[1][1] * yh + GAL_TO_ECL[1][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
    (GAL_TO_ECL[2][0] * xh + GAL_TO_ECL[2][1] * yh + GAL_TO_ECL[2][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
  ];
}

function eclipticToGalacticDirection(xe: number, ye: number, ze: number): [number, number, number] {
  const [x, y, z] = normalize3(xe, ye, ze);
  return normalize3(
    GAL_TO_ECL[0][0] * x + GAL_TO_ECL[1][0] * y + GAL_TO_ECL[2][0] * z,
    GAL_TO_ECL[0][1] * x + GAL_TO_ECL[1][1] * y + GAL_TO_ECL[2][1] * z,
    GAL_TO_ECL[0][2] * x + GAL_TO_ECL[1][2] * y + GAL_TO_ECL[2][2] * z,
  );
}

function armBoost(radiusKpc: number, theta: number): number {
  if (radiusKpc < 1.4) return 1;
  let boost = 1;
  for (const arm of ARMS) {
    for (let wind = -1; wind <= 1; wind++) {
      const thetaArm = arm.theta0 + Math.log(radiusKpc / arm.r0) / arm.tanp + wind * TAU;
      const dAng = Math.abs(theta - thetaArm) % TAU;
      const dArc = Math.min(dAng, TAU - dAng) * radiusKpc;
      boost = Math.max(boost, 1 + 3.6 * Math.exp(-(dArc * dArc) / (arm.width * arm.width)));
    }
  }
  return boost;
}

function galacticDustDensity(xgc: number, ygc: number, zgc: number, mapDensity: number): number {
  const radius = Math.hypot(xgc, ygc);
  if (radius > DUST_GALAXY_RADIUS_KPC || Math.abs(zgc) > DUST_DISK_SAMPLE_HALF_HEIGHT_KPC) return 0;

  const theta = Math.atan2(ygc, xgc);
  const radial = Math.exp(-radius / 5.2);
  const vertical = Math.exp(-Math.abs(zgc) / DUST_VERTICAL_SCALE_KPC);
  const arms = armBoost(radius, theta);
  const centralBar = Math.exp(-Math.abs(radius * Math.sin(theta)) / 0.55) *
    Math.exp(-Math.abs(radius * Math.cos(theta)) / 3.1) *
    (1 - smoothstep(2.0, 5.2, radius));
  const localHole = smoothstep(0.35, 1.15, Math.hypot(xgc + DUST_SUN_GALACTIC_RADIUS_KPC, ygc));
  const disk = radial * (0.16 + arms * 0.24) + centralBar * 0.24;
  return clamp(mapDensity * disk * vertical * localHole, 0, 1);
}

interface DustSeed {
  x: number;
  y: number;
  z: number;
  density: number;
  sizeAU: number;
}

function fallbackDustPosition(rand: () => number): DustSeed {
  for (let attempt = 0; attempt < 32; attempt++) {
    const r = Math.sqrt(rand()) * DUST_GALAXY_RADIUS_KPC;
    const theta = rand() * TAU;
    const z = clamp(randn(rand) * 0.34, -DUST_GALAXY_HALF_HEIGHT_KPC * 0.92, DUST_GALAXY_HALF_HEIGHT_KPC * 0.92);
    const arms = armBoost(r, theta);
    const radial = Math.exp(-r / 3.2);
    const vertical = Math.exp(-Math.abs(z) / 0.34);
    const bar = Math.exp(-Math.abs(r * Math.sin(theta)) / 0.65) *
      Math.exp(-Math.abs(r * Math.cos(theta)) / 3.4) *
      (1 - smoothstep(1.2, 4.8, r));
    const density = clamp((radial * (0.20 + arms * 0.26) + bar * 0.34) * vertical, 0, 1);
    if (rand() < density * 1.35 + 0.02) {
      const [x, y, zz] = galacticCartesianToEclipticAU(r * Math.cos(theta), r * Math.sin(theta), z);
      return { x, y, z: zz, density, sizeAU: (0.40 + density * 0.62) * DUST_MILKY_WAY_KPC_TO_AU };
    }
  }
  const [x, y, z] = galacticCartesianToEclipticAU(0, 0, 0);
  return { x, y, z, density: 1, sizeAU: 0.90 * DUST_MILKY_WAY_KPC_TO_AU };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

interface DustColorSample {
  color: [number, number, number];
  opacityScale: number;
}

function scaleColor(color: readonly [number, number, number], exposure: number): [number, number, number] {
  return [
    clamp(color[0] * exposure, 0, 1),
    clamp(color[1] * exposure, 0, 1),
    clamp(color[2] * exposure, 0, 1),
  ];
}

function dustColor(rand: () => number, density: number): DustColorSample {
  const roll = rand();
  const d = clamp(density, 0, 1);
  let base: [number, number, number];
  let jitter: number;
  let exposure: number;
  let opacityScale: number;

  // Approximate wide-angle visual abundance in HDR: ~80% dark obscuration,
  // ~17% warm interstellar reddening, and a rare ~3% blue reflection component.
  // Dense clouds are biased darker so warm dust remains an edge/backlight cue
  // instead of turning the whole Milky Way dust layer reddish brown.
  const denseDarkBias = smoothstep(0.42, 0.86, d) * 0.10;
  const darkLimit = clamp(DUST_DARK_SHARE + denseDarkBias, DUST_DARK_SHARE, 0.91);
  const reddeningShare = DUST_REDDENING_SHARE * (1 - smoothstep(0.64, 0.96, d) * 0.55);
  const reddeningLimit = clamp(darkLimit + reddeningShare, darkLimit, 0.985);

  if (roll < darkLimit) {
    const blackBias = 0.70 + d * 0.24;
    base = DUST_DARK_PALETTE[rand() < blackBias ? 0 : 1]!;
    jitter = 0.004;
    exposure = 0.72 + rand() * 0.16;
    opacityScale = 0.92 + d * 0.28;
  } else if (roll < reddeningLimit) {
    const rustBias = 0.74 + d * 0.18;
    base = DUST_REDDENING_PALETTE[rand() < rustBias ? 0 : 1]!;
    jitter = 0.012;
    exposure = 0.24 + (1 - d) * 0.18;
    opacityScale = 0.24 + (1 - d) * 0.16;
  } else {
    const cyanBias = 0.58 + d * 0.20;
    base = DUST_REFLECTION_PALETTE[rand() < cyanBias ? 1 : 0]!;
    jitter = 0.010;
    exposure = 0.20 + (1 - d) * 0.14;
    opacityScale = 0.18 + (1 - d) * 0.12;
  }

  const color = scaleColor(base, exposure);
  return {
    color: [
      clamp(color[0] + (rand() - 0.5) * jitter, 0, 1),
      clamp(color[1] + (rand() - 0.5) * jitter, 0, 1),
      clamp(color[2] + (rand() - 0.5) * jitter, 0, 1),
    ],
    opacityScale,
  };
}

function dustMapCellDensity(dustMap: Float32Array, offset: number): number {
  const alpha = dustMap[offset + 7] ?? 0;
  return clamp((alpha - DUST_MAP_MIN_ALPHA) / DUST_MAP_ALPHA_RANGE, 0.04, 1);
}

interface DustDirectionGrid {
  lonBins: number;
  latBins: number;
  values: Float32Array;
}

function directionGridIndex(lonBins: number, latBins: number, lon: number, lat: number): number {
  const lonUnit = (lon + Math.PI) / TAU;
  const latUnit = (lat + Math.PI * 0.5) / Math.PI;
  const lonIndex = ((Math.floor(lonUnit * lonBins) % lonBins) + lonBins) % lonBins;
  const latIndex = clamp(Math.floor(latUnit * latBins), 0, latBins - 1);
  return latIndex * lonBins + lonIndex;
}

function buildDustDirectionGrid(dustMap: Float32Array, dustCellCount: number): DustDirectionGrid {
  const lonBins = DUST_DIRECTION_LON_BINS;
  const latBins = DUST_DIRECTION_LAT_BINS;
  const values = new Float32Array(lonBins * latBins);

  for (let i = 0; i < dustCellCount; i++) {
    const offset = i * DUST_MAP_FLOATS;
    const dir = eclipticToGalacticDirection(
      dustMap[offset + 0] ?? 0,
      dustMap[offset + 1] ?? 0,
      dustMap[offset + 2] ?? 0,
    );
    const lon = Math.atan2(dir[1], dir[0]);
    const lat = Math.asin(clamp(dir[2], -1, 1));
    const gridIndex = directionGridIndex(lonBins, latBins, lon, lat);
    values[gridIndex] = Math.max(values[gridIndex] ?? 0, dustMapCellDensity(dustMap, offset));
  }

  return { lonBins, latBins, values };
}

function lookupDustDirectionDensity(
  grid: DustDirectionGrid,
  dir: readonly [number, number, number],
): number {
  const lon = Math.atan2(dir[1], dir[0]);
  const lat = Math.asin(clamp(dir[2], -1, 1));
  const lonUnit = (lon + Math.PI) / TAU;
  const latUnit = (lat + Math.PI * 0.5) / Math.PI;
  const lonCenter = ((Math.floor(lonUnit * grid.lonBins) % grid.lonBins) + grid.lonBins) % grid.lonBins;
  const latCenter = clamp(Math.floor(latUnit * grid.latBins), 0, grid.latBins - 1);
  let weighted = 0;
  let weightSum = 0;

  for (let dy = -1; dy <= 1; dy++) {
    const latIndex = clamp(latCenter + dy, 0, grid.latBins - 1);
    for (let dx = -1; dx <= 1; dx++) {
      const lonIndex = (lonCenter + dx + grid.lonBins) % grid.lonBins;
      const value = grid.values[latIndex * grid.lonBins + lonIndex] ?? 0;
      if (value <= 0) continue;
      const weight = dx === 0 && dy === 0 ? 1 : 0.45;
      weighted += value * weight;
      weightSum += weight;
    }
  }

  return weightSum > 0 ? clamp(weighted / weightSum, 0.04, 1) : 0.04;
}

function spiralArmCandidate(rand: () => number): [number, number] {
  const arm = ARMS[Math.floor(rand() * ARMS.length)] ?? ARMS[0]!;
  const radius = 1.2 + Math.pow(rand(), 0.72) * (DUST_GALAXY_RADIUS_KPC - 1.2);
  const winding = Math.floor(rand() * 3) - 1;
  const thetaArm = arm.theta0 + Math.log(radius / arm.r0) / arm.tanp + winding * TAU;
  const theta = thetaArm + randn(rand) * (arm.width / Math.max(1.2, radius)) * 0.82;
  return [radius, theta];
}

function diskCandidate(rand: () => number): [number, number] {
  const radius = DUST_GALAXY_RADIUS_KPC * Math.sqrt(rand());
  return [radius, rand() * TAU];
}

function dustSeedFromDirectionGrid(grid: DustDirectionGrid, rand: () => number): DustSeed {
  let best: DustSeed | null = null;
  let bestDensity = 0;

  for (let attempt = 0; attempt < 44; attempt++) {
    const [radius, theta] = rand() < 0.68 ? spiralArmCandidate(rand) : diskCandidate(rand);
    const zgc = clamp(randn(rand) * 0.105, -DUST_DISK_SAMPLE_HALF_HEIGHT_KPC, DUST_DISK_SAMPLE_HALF_HEIGHT_KPC);
    const xgc = radius * Math.cos(theta);
    const ygc = radius * Math.sin(theta);
    const sunDir = normalize3(xgc + DUST_SUN_GALACTIC_RADIUS_KPC, ygc, zgc);
    const mapDensity = lookupDustDirectionDensity(grid, sunDir);
    const density = galacticDustDensity(xgc, ygc, zgc, mapDensity);

    if (density > bestDensity) {
      const [x, y, z] = galacticCartesianToEclipticAU(xgc, ygc, zgc);
      best = {
        x,
        y,
        z,
        density,
        sizeAU: (0.34 + density * 0.78) * DUST_MILKY_WAY_KPC_TO_AU,
      };
      bestDensity = density;
    }

    if (best && rand() < density * 2.35 + 0.012) {
      return best;
    }
  }

  return best ?? fallbackDustPosition(rand);
}

export function buildDustCloudBuffer(dustMap?: Float32Array, count = DUST_CLOUD_COUNT): Float32Array {
  const rand = createRand();
  const dustCellCount = dustMap ? Math.floor(dustMap.length / DUST_MAP_FLOATS) : 0;
  const directionGrid = dustMap && dustCellCount > 0
    ? buildDustDirectionGrid(dustMap, dustCellCount)
    : null;
  const n = clamp(Math.floor(count), 0, DUST_CLOUD_CAPACITY);
  const buf = new Float32Array(n * DUST_CLOUD_FLOATS);

  for (let i = 0; i < n; i++) {
    const seed = directionGrid
      ? dustSeedFromDirectionGrid(directionGrid, rand)
      : fallbackDustPosition(rand);
    const radiusAU = clamp(
      seed.sizeAU * (0.045 + Math.pow(rand(), 1.35) * 0.12 + seed.density * 0.05),
      DUST_CLOUD_MIN_RADIUS_AU,
      DUST_CLOUD_MAX_RADIUS_AU,
    );
    const aspectX = 1;
    const aspectY = 1;
    const colorSample = dustColor(rand, seed.density);
    const color = colorSample.color;
    const alpha = clamp(
      (0.22 + rand() * 0.50) * (0.70 + seed.density * 0.32) * colorSample.opacityScale,
      0.035,
      0.82,
    );
    const style = Math.floor(rand() * 5);

    const o = i * DUST_CLOUD_FLOATS;
    buf[o + 0] = seed.x;
    buf[o + 1] = seed.y;
    buf[o + 2] = seed.z;
    buf[o + 3] = radiusAU;
    buf[o + 4] = color[0];
    buf[o + 5] = color[1];
    buf[o + 6] = color[2];
    buf[o + 7] = alpha;
    buf[o + 8] = style;
    buf[o + 9] = rand() * 1000;
    buf[o + 10] = 0.82 + seed.density * 0.36;
    buf[o + 11] = rand() * TAU;
    buf[o + 12] = aspectX;
    buf[o + 13] = aspectY;
    buf[o + 14] = seed.density;
    buf[o + 15] = 0;
  }

  return buf;
}

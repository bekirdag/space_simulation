import { NEBULA_FLOATS } from "./nebulas";

// Partial Milky Way dust clouds generated from the NASA/GSFC LAMBDA
// Meisner-Finkbeiner 2015 E(B-V) all-sky Galactic dust map.
//
// Each dust instance reuses the nebula billboard buffer layout so the renderer
// can draw the clouds as batched procedural cloud models. The source map is a
// 2D total line-of-sight reddening product: we use those measured directions
// and weights, then project samples through a Milky Way disk/spiral density
// model so the rendered cloud positions form a galaxy-scale dust map instead
// of a Sun-centered shell.

export const DUST_CLOUD_FLOATS = NEBULA_FLOATS;
export const DUST_CLOUD_COUNT = 96_000;
export const DUST_CLOUD_CAPACITY = DUST_CLOUD_COUNT;
export const DUST_MAP_FLOATS = 8;
export const DUST_MILKY_WAY_KPC_TO_AU = 8_000;
export const DUST_SUN_GALACTIC_RADIUS_KPC = 8.5;
export const DUST_GALAXY_RADIUS_KPC = 16.5;
export const DUST_GALAXY_HALF_HEIGHT_KPC = 1.6;
export const DUST_GALAXY_HALF_HEIGHT_AU = DUST_GALAXY_HALF_HEIGHT_KPC * DUST_MILKY_WAY_KPC_TO_AU;
export const DUST_CLOUD_MAX_MODEL_HEIGHT_KPC = 0.02;
export const DUST_CLOUD_MAX_MODEL_HEIGHT_AU = DUST_CLOUD_MAX_MODEL_HEIGHT_KPC * DUST_MILKY_WAY_KPC_TO_AU;
export const DUST_CLOUD_SOURCE =
  `${DUST_CLOUD_COUNT.toLocaleString()} MF2015 reddening-weighted Milky Way disk dust clouds`;

const DUST_MAP_DATA_URL = "/data/dust-map-mf2015.bin";
const DUST_MAP_META_URL = "/data/dust-map-mf2015.meta.json";
const DUST_MAP_MIN_ALPHA = 0.006;
const DUST_MAP_ALPHA_RANGE = 0.080;
const DUST_CLOUD_MIN_RADIUS_AU = 12;
const DUST_MIN_LINE_OF_SIGHT_KPC = 0.75;
const DUST_DISK_SAMPLE_HALF_HEIGHT_KPC = 0.52;
const DUST_VERTICAL_SCALE_KPC = 0.12;

const TAU = Math.PI * 2;
const GAL_TO_ECL = [
  [-0.054876,  0.494109, -0.867666],
  [-0.993911, -0.111106, -0.000312],
  [-0.096390,  0.862326,  0.497159],
] as const;

const DUST_PALETTE: Array<[number, number, number]> = [
  [0.54, 0.39, 0.23], // light brown
  [0.22, 0.13, 0.07], // dark brown
  [0.27, 0.265, 0.245], // gray
  [0.028, 0.024, 0.020], // near-black
];

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
  const res = await fetch(DUST_MAP_DATA_URL);
  if (!res.ok) throw new Error(`Failed to fetch ${DUST_MAP_DATA_URL}: ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength % (DUST_MAP_FLOATS * 4) !== 0) {
    throw new Error(`Dust map buffer has invalid byte length: ${buf.byteLength}`);
  }

  let source = "NASA/GSFC LAMBDA Meisner-Finkbeiner 2015 E(B-V) dust map";
  try {
    const metaRes = await fetch(DUST_MAP_META_URL);
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

function rayMaxDistanceInMilkyWayDiskKpc(dir: readonly [number, number, number]): number {
  const sx = -DUST_SUN_GALACTIC_RADIUS_KPC;
  const sy = 0;
  const a = dir[0] * dir[0] + dir[1] * dir[1];
  const b = 2 * (sx * dir[0] + sy * dir[1]);
  const c = sx * sx + sy * sy - DUST_GALAXY_RADIUS_KPC * DUST_GALAXY_RADIUS_KPC;
  let maxDistance = DUST_GALAXY_RADIUS_KPC * 2;

  if (a > 1e-8) {
    const disc = b * b - 4 * a * c;
    if (disc <= 0) return 0;
    const root = Math.sqrt(disc);
    const t0 = (-b - root) / (2 * a);
    const t1 = (-b + root) / (2 * a);
    maxDistance = Math.max(t0, t1);
  }

  if (Math.abs(dir[2]) > 1e-5) {
    maxDistance = Math.min(maxDistance, DUST_DISK_SAMPLE_HALF_HEIGHT_KPC / Math.abs(dir[2]));
  }

  return Math.max(0, maxDistance);
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
      return { x, y, z: zz, density, sizeAU: (0.22 + density * 0.28) * DUST_MILKY_WAY_KPC_TO_AU };
    }
  }
  const [x, y, z] = galacticCartesianToEclipticAU(0, 0, 0);
  return { x, y, z, density: 1, sizeAU: 0.42 * DUST_MILKY_WAY_KPC_TO_AU };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function dustColor(rand: () => number, density: number): [number, number, number] {
  const roll = rand();
  const index = roll < density * 0.32 ? 3
    : roll < 0.28 + density * 0.20 ? 1
      : roll < 0.68 ? 2
        : 0;
  const base = DUST_PALETTE[index]!;
  const jitter = index === 3 ? 0.015 : 0.055;
  return [
    clamp(base[0] + (rand() - 0.5) * jitter, 0, 1),
    clamp(base[1] + (rand() - 0.5) * jitter, 0, 1),
    clamp(base[2] + (rand() - 0.5) * jitter, 0, 1),
  ];
}

function dustMapCellDensity(dustMap: Float32Array, offset: number): number {
  const alpha = dustMap[offset + 7] ?? 0;
  return clamp((alpha - DUST_MAP_MIN_ALPHA) / DUST_MAP_ALPHA_RANGE, 0.04, 1);
}

function chooseDustMapCell(dustMap: Float32Array, dustCellCount: number, rand: () => number): number {
  let bestOffset = 0;
  let bestDensity = 0;
  for (let attempt = 0; attempt < 32; attempt++) {
    const offset = Math.floor(rand() * dustCellCount) * DUST_MAP_FLOATS;
    const density = dustMapCellDensity(dustMap, offset);
    if (density > bestDensity) {
      bestDensity = density;
      bestOffset = offset;
    }
    if (rand() < Math.pow(density, 0.62)) return offset;
  }
  return bestOffset;
}

function dustSeedFromMap(dustMap: Float32Array, dustCellCount: number, rand: () => number): DustSeed {
  const offset = chooseDustMapCell(dustMap, dustCellCount, rand);
  const x = dustMap[offset + 0] ?? 0;
  const y = dustMap[offset + 1] ?? 0;
  const z = dustMap[offset + 2] ?? 0;
  const mapDensity = dustMapCellDensity(dustMap, offset);
  const dir = eclipticToGalacticDirection(x, y, z);
  const maxDistanceKpc = rayMaxDistanceInMilkyWayDiskKpc(dir);
  if (maxDistanceKpc <= DUST_MIN_LINE_OF_SIGHT_KPC) {
    return fallbackDustPosition(rand);
  }

  let best: DustSeed | null = null;
  let bestDensity = 0;
  for (let attempt = 0; attempt < 24; attempt++) {
    const pathT = Math.pow(rand(), 0.62);
    const distanceKpc = DUST_MIN_LINE_OF_SIGHT_KPC +
      (maxDistanceKpc - DUST_MIN_LINE_OF_SIGHT_KPC) * pathT;
    const xgc = -DUST_SUN_GALACTIC_RADIUS_KPC + dir[0] * distanceKpc;
    const ygc = dir[1] * distanceKpc;
    const zgc = dir[2] * distanceKpc + randn(rand) * 0.018;
    const density = galacticDustDensity(xgc, ygc, zgc, mapDensity);
    if (density > bestDensity) {
      const [ex, ey, ez] = galacticCartesianToEclipticAU(xgc, ygc, zgc);
      best = {
        x: ex,
        y: ey,
        z: ez,
        density,
        sizeAU: (0.10 + density * 0.16) * DUST_MILKY_WAY_KPC_TO_AU,
      };
      bestDensity = density;
    }
    if (rand() < density * 2.1 + 0.015 && best) return best;
  }

  return best ?? fallbackDustPosition(rand);
}

export function buildDustCloudBuffer(dustMap?: Float32Array, count = DUST_CLOUD_COUNT): Float32Array {
  const rand = createRand();
  const dustCellCount = dustMap ? Math.floor(dustMap.length / DUST_MAP_FLOATS) : 0;
  const n = clamp(Math.floor(count), 0, DUST_CLOUD_CAPACITY);
  const buf = new Float32Array(n * DUST_CLOUD_FLOATS);

  for (let i = 0; i < n; i++) {
    const seed = dustCellCount > 0 && dustMap
      ? dustSeedFromMap(dustMap, dustCellCount, rand)
      : fallbackDustPosition(rand);
    const stretch = 1.1 + rand() * 2.65;
    const squash = 0.48 + rand() * 0.82;
    const aspectX = rand() < 0.5 ? stretch : squash;
    const aspectY = rand() < 0.5 ? squash : stretch;
    const maxRadiusAU = DUST_CLOUD_MAX_MODEL_HEIGHT_AU / (2 * Math.max(0.001, aspectY));
    const minRadiusAU = Math.min(DUST_CLOUD_MIN_RADIUS_AU, maxRadiusAU);
    const radiusAU = clamp(seed.sizeAU * (0.52 + Math.pow(rand(), 1.7) * 0.95 + seed.density * 0.26), minRadiusAU, maxRadiusAU);
    const color = dustColor(rand, seed.density);
    const alpha = 0.20 + rand() * 0.60;
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

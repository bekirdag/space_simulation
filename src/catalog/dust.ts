import { MW_FLOATS } from "./milkyway";
import { NEBULA_FLOATS } from "./nebulas";

// Partial Milky Way dust clouds generated from the galaxy-scale star field.
//
// Each dust instance reuses the nebula billboard buffer layout so the renderer
// can draw the clouds as batched procedural cloud models. When the Milky Way
// star catalog is available, locations are sampled directly from those stars:
// dense spiral-arm regions therefore receive proportionally more dust clouds.

export const DUST_CLOUD_FLOATS = NEBULA_FLOATS;
export const DUST_CLOUD_COUNT = 5_200;
export const DUST_CLOUD_CAPACITY = DUST_CLOUD_COUNT;
export const DUST_MILKY_WAY_KPC_TO_AU = 8_000;
export const DUST_SUN_GALACTIC_RADIUS_KPC = 8.5;
export const DUST_GALAXY_RADIUS_KPC = 16.5;
export const DUST_GALAXY_HALF_HEIGHT_KPC = 1.6;
export const DUST_GALAXY_HALF_HEIGHT_AU = DUST_GALAXY_HALF_HEIGHT_KPC * DUST_MILKY_WAY_KPC_TO_AU;
export const DUST_CLOUD_SOURCE =
  `${DUST_CLOUD_COUNT.toLocaleString()} star-density sampled procedural nebula dust clouds`;

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

function fallbackDustPosition(rand: () => number): [number, number, number, number] {
  for (let attempt = 0; attempt < 32; attempt++) {
    const r = Math.sqrt(rand()) * 16.0;
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
      return [x, y, zz, density];
    }
  }
  const [x, y, z] = galacticCartesianToEclipticAU(0, 0, 0);
  return [x, y, z, 1];
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

export function buildDustCloudBuffer(stars?: Float32Array, count = DUST_CLOUD_COUNT): Float32Array {
  const rand = createRand();
  const starCount = stars ? Math.floor(stars.length / MW_FLOATS) : 0;
  const n = clamp(Math.floor(count), 0, DUST_CLOUD_CAPACITY);
  const buf = new Float32Array(n * DUST_CLOUD_FLOATS);

  for (let i = 0; i < n; i++) {
    let x: number;
    let y: number;
    let z: number;
    let density = 0.55;

    if (starCount > 0 && stars) {
      const starIndex = Math.floor(rand() * starCount);
      const so = starIndex * MW_FLOATS;
      x = stars[so + 0] ?? 0;
      y = stars[so + 1] ?? 0;
      z = stars[so + 2] ?? 0;
      const starAlpha = stars[so + 7] ?? 0.32;
      density = clamp((starAlpha - 0.20) / 0.34, 0.25, 1);
      const jitterAU = 120 + rand() * 760;
      x += randn(rand) * jitterAU;
      y += randn(rand) * jitterAU;
      z += randn(rand) * jitterAU * 0.34;
    } else {
      [x, y, z, density] = fallbackDustPosition(rand);
    }

    const stretch = 1.1 + rand() * 2.65;
    const squash = 0.48 + rand() * 0.82;
    const aspectX = rand() < 0.5 ? stretch : squash;
    const aspectY = rand() < 0.5 ? squash : stretch;
    const maxRadiusAU = (DUST_GALAXY_HALF_HEIGHT_AU * 0.72) / Math.max(aspectX, aspectY);
    const radiusKpc = 0.070 + Math.pow(rand(), 1.7) * 0.34 + density * 0.055;
    const radiusAU = clamp(radiusKpc * DUST_MILKY_WAY_KPC_TO_AU, 460, maxRadiusAU);
    const color = dustColor(rand, density);
    const alpha = 0.20 + rand() * 0.60;
    const style = Math.floor(rand() * 5);

    const o = i * DUST_CLOUD_FLOATS;
    buf[o + 0] = x;
    buf[o + 1] = y;
    buf[o + 2] = z;
    buf[o + 3] = radiusAU;
    buf[o + 4] = color[0];
    buf[o + 5] = color[1];
    buf[o + 6] = color[2];
    buf[o + 7] = alpha;
    buf[o + 8] = style;
    buf[o + 9] = rand() * 1000;
    buf[o + 10] = 0.82 + density * 0.36;
    buf[o + 11] = rand() * TAU;
    buf[o + 12] = aspectX;
    buf[o + 13] = aspectY;
    buf[o + 14] = density;
    buf[o + 15] = 0;
  }

  return buf;
}

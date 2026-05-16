// Procedural Milky Way dust cloud layer.
//
// This replaces the old fetched 2D dust-map overlay with a deterministic set of
// low-poly 3D cloud meshes distributed through the galactic disk and spiral
// arms. The layer is visual only: it does not affect physics or calibrated
// photometry.

export const DUST_FLOATS = 24;
export const DUST_CLOUD_COUNT = 28_000;
export const DUST_SHAPE_COUNT = 1_024;
export const DUST_MILKY_WAY_KPC_TO_AU = 8_000;
export const DUST_SUN_GALACTIC_RADIUS_KPC = 8.5;

// Same galactic -> ecliptic J2000 rotation used by build-milkyway-stars.mjs.
const GAL_TO_ECL = [
  [-0.054876,  0.494109, -0.867666],
  [-0.993911, -0.111106, -0.000312],
  [-0.096390,  0.862326,  0.497159],
] as const;

const SPIRAL_ARMS = [
  { theta0: Math.PI * 0.00, r0: 6.0, tanp: Math.tan(0.21), width: 0.34 },
  { theta0: Math.PI * 0.50, r0: 5.5, tanp: Math.tan(0.21), width: 0.36 },
  { theta0: Math.PI * 1.00, r0: 6.0, tanp: Math.tan(0.21), width: 0.36 },
  { theta0: Math.PI * 1.50, r0: 5.5, tanp: Math.tan(0.21), width: 0.34 },
  { theta0: Math.PI * 0.35, r0: 8.5, tanp: Math.tan(0.19), width: 0.28 },
] as const;

export interface DustCloudBuffer {
  data:   Float32Array;
  source: string;
}

let cachedDust: DustCloudBuffer | null = null;

function galacticCartesianToEclipticAU(
  xgc: number,
  ygc: number,
  zgc: number,
): [number, number, number] {
  // Galactocentric kpc -> heliocentric galactic kpc. The Sun sits at
  // (-8.5, 0, 0), so the Galactic center is 8.5 kpc toward +X.
  const xh = xgc + DUST_SUN_GALACTIC_RADIUS_KPC;
  const yh = ygc;
  const zh = zgc;
  return [
    (GAL_TO_ECL[0][0] * xh + GAL_TO_ECL[0][1] * yh + GAL_TO_ECL[0][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
    (GAL_TO_ECL[1][0] * xh + GAL_TO_ECL[1][1] * yh + GAL_TO_ECL[1][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
    (GAL_TO_ECL[2][0] * xh + GAL_TO_ECL[2][1] * yh + GAL_TO_ECL[2][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
  ];
}

function normalize(v: [number, number, number]): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function subtract(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function rotateAroundAxis(
  v: [number, number, number],
  axis: [number, number, number],
  angle: number,
): [number, number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const cr = cross(axis, v);
  return normalize([
    v[0] * c + cr[0] * s + axis[0] * dot * (1 - c),
    v[1] * c + cr[1] * s + axis[1] * dot * (1 - c),
    v[2] * c + cr[2] * s + axis[2] * dot * (1 - c),
  ]);
}

function createRng(seedValue: number): () => number {
  let seed = seedValue >>> 0;
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function randn(rand: () => number): number {
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleDiskRadius(rand: () => number): number {
  const min = 0.8;
  const max = 16.5;
  const u = rand();
  // Area-biased sampling keeps dust around the whole disk instead of clumping
  // only near the center.
  return Math.sqrt(min * min + u * (max * max - min * min));
}

function armTheta(radiusKpc: number, armIndex: number, rand: () => number): number {
  const arm = SPIRAL_ARMS[armIndex % SPIRAL_ARMS.length]!;
  const wind = Math.floor(rand() * 3) - 1;
  const naturalWidth = arm.width + radiusKpc * 0.018;
  return arm.theta0
    + Math.log(Math.max(0.2, radiusKpc) / arm.r0) / arm.tanp
    + wind * Math.PI * 2
    + randn(rand) * naturalWidth / Math.max(1, radiusKpc);
}

function pickDustColor(rand: () => number, density: number): [number, number, number] {
  const u = rand();
  const darkBias = Math.min(0.35, density * 0.18);

  if (u < 0.30 + darkBias) {
    // Dark brown.
    return [
      0.16 + rand() * 0.12,
      0.11 + rand() * 0.09,
      0.07 + rand() * 0.06,
    ];
  }
  if (u < 0.55 + darkBias) {
    // Black.
    const v = 0.015 + rand() * 0.055;
    return [v, v * (0.92 + rand() * 0.12), v * (0.88 + rand() * 0.12)];
  }
  if (u < 0.78) {
    // Gray.
    const g = 0.22 + rand() * 0.17;
    return [g * (0.96 + rand() * 0.08), g, g * (0.94 + rand() * 0.10)];
  }

  // Light brown.
  return [
    0.40 + rand() * 0.17,
    0.28 + rand() * 0.13,
    0.17 + rand() * 0.10,
  ];
}

function writeCloud(
  out: Float32Array,
  index: number,
  center: [number, number, number],
  radiusAU: number,
  color: [number, number, number],
  alpha: number,
  axisX: [number, number, number],
  axisY: [number, number, number],
  axisZ: [number, number, number],
  stretchX: number,
  stretchY: number,
  stretchZ: number,
  shapeId: number,
  roughness: number,
): void {
  const o = index * DUST_FLOATS;
  out[o + 0] = center[0];
  out[o + 1] = center[1];
  out[o + 2] = center[2];
  out[o + 3] = radiusAU;
  out[o + 4] = color[0];
  out[o + 5] = color[1];
  out[o + 6] = color[2];
  out[o + 7] = Math.min(0.10, Math.max(0.02, alpha));
  out[o + 8] = axisX[0];
  out[o + 9] = axisX[1];
  out[o + 10] = axisX[2];
  out[o + 11] = stretchX;
  out[o + 12] = axisY[0];
  out[o + 13] = axisY[1];
  out[o + 14] = axisY[2];
  out[o + 15] = stretchY;
  out[o + 16] = axisZ[0];
  out[o + 17] = axisZ[1];
  out[o + 18] = axisZ[2];
  out[o + 19] = stretchZ;
  out[o + 20] = shapeId;
  out[o + 21] = roughness;
  out[o + 22] = Math.max(stretchX, stretchY, stretchZ);
  out[o + 23] = 0;
}

export function buildProceduralDustClouds(count = DUST_CLOUD_COUNT): DustCloudBuffer {
  if (cachedDust && count === DUST_CLOUD_COUNT) return cachedDust;

  const rand = createRng(0x51a7d057);
  const out = new Float32Array(count * DUST_FLOATS);

  for (let i = 0; i < count; i++) {
    const zone = rand();
    const radiusKpc = sampleDiskRadius(rand);
    let theta: number;
    let zScale = 0.10 + radiusKpc * 0.010;
    let density = 0.65;

    if (zone < 0.68) {
      theta = armTheta(radiusKpc, Math.floor(rand() * SPIRAL_ARMS.length), rand);
      density = 0.90 + rand() * 0.35;
    } else if (zone < 0.90) {
      theta = rand() * Math.PI * 2;
      density = 0.42 + rand() * 0.35;
      zScale *= 1.45;
    } else {
      // Central/bar dust near the bulge, still oriented in the galactic disk.
      const barR = 0.5 + Math.pow(rand(), 1.6) * 3.8;
      const barTheta = randn(rand) * 0.34 + (rand() < 0.5 ? 0 : Math.PI);
      const xbar = barR * Math.cos(barTheta) * 1.45;
      const ybar = barR * Math.sin(barTheta) * 0.55;
      const center = galacticCartesianToEclipticAU(xbar, ybar, randn(rand) * 0.16);
      const barBase = galacticCartesianToEclipticAU(xbar, ybar, 0);
      const zAxis = normalize(subtract(galacticCartesianToEclipticAU(xbar, ybar, 1), center));
      let xAxis = normalize(subtract(galacticCartesianToEclipticAU(xbar + 1, ybar, 0), barBase));
      xAxis = rotateAroundAxis(xAxis, zAxis, rand() * Math.PI * 2);
      const yAxis = normalize(cross(zAxis, xAxis));
      const radiusAU = (0.055 + rand() * 0.24) * DUST_MILKY_WAY_KPC_TO_AU;
      const color = pickDustColor(rand, 1.25);
      writeCloud(
        out,
        i,
        center,
        radiusAU,
        color,
        0.075 + rand() * 0.025,
        xAxis,
        yAxis,
        zAxis,
        1.0 + rand() * 2.5,
        0.45 + rand() * 1.15,
        0.20 + rand() * 0.55,
        Math.floor(rand() * DUST_SHAPE_COUNT),
        0.25 + rand() * 0.55,
      );
      continue;
    }

    const xgc = radiusKpc * Math.cos(theta);
    const ygc = radiusKpc * Math.sin(theta);
    const zgc = randn(rand) * zScale;
    const center = galacticCartesianToEclipticAU(xgc, ygc, zgc);

    const radial = normalize(subtract(
      galacticCartesianToEclipticAU(xgc + Math.cos(theta), ygc + Math.sin(theta), zgc),
      center,
    ));
    const vertical = normalize(subtract(
      galacticCartesianToEclipticAU(xgc, ygc, zgc + 1),
      center,
    ));
    let tangent = normalize(cross(vertical, radial));
    tangent = rotateAroundAxis(tangent, vertical, randn(rand) * 0.28);
    const minor = normalize(cross(vertical, tangent));

    const armScale = zone < 0.68 ? 1.25 : 0.85;
    const sizeKpc = (0.035 + Math.pow(rand(), 1.8) * 0.28) * armScale;
    const color = pickDustColor(rand, density);
    const elongated = 1.4 + Math.pow(rand(), 1.2) * 4.2;
    const puffy = 0.22 + rand() * 0.58;

    writeCloud(
      out,
      i,
      center,
      sizeKpc * DUST_MILKY_WAY_KPC_TO_AU,
      color,
      0.055 + Math.min(0.045, density * 0.028 + rand() * 0.020),
      tangent,
      minor,
      vertical,
      elongated,
      0.55 + rand() * 1.20,
      puffy,
      Math.floor(rand() * DUST_SHAPE_COUNT),
      0.22 + rand() * 0.62,
    );
  }

  const result = {
    data: out,
    source: `${count.toLocaleString()} procedural Milky Way spiral dust clouds`,
  };
  if (count === DUST_CLOUD_COUNT) cachedDust = result;
  return result;
}

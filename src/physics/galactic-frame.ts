import { type Body } from "./body";

type Vec3 = { x: number; y: number; z: number };

const KM_PER_AU = 149_597_870.7;
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
const PARSEC_AU = 206_264.80624709636;
const KM_S_TO_AU_YR = SECONDS_PER_YEAR / KM_PER_AU;
const MODEL_EPOCH_MS = Date.UTC(2000, 0, 1, 12);

// Local galactic reference model. JPL Horizons is solar-system scoped; this
// model supplies a stable external frame without moving GPU coordinates to
// billion-AU galactocentric values.
export const GALACTIC_FRAME = {
  name: "local circular galactic frame",
  radiusAu: 8_178 * PARSEC_AU,
  circularSpeedAuYr: 240 * KM_S_TO_AU_YR,
} as const;

export interface GalacticOriginState {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
}

function accelerationAt(x: number, y: number, z: number): Vec3 {
  const r2 = Math.max(x*x + y*y + z*z, 1);
  const scale = -(GALACTIC_FRAME.circularSpeedAuYr ** 2) / r2;
  return { x: scale * x, y: scale * y, z: scale * z };
}

export function createGalacticOriginState(epochMs = MODEL_EPOCH_MS): GalacticOriginState {
  const dtYr = (epochMs - MODEL_EPOCH_MS) / (SECONDS_PER_YEAR * 1000);
  const omega = GALACTIC_FRAME.circularSpeedAuYr / GALACTIC_FRAME.radiusAu;
  const theta = omega * dtYr;
  const c = Math.cos(theta);
  const s = Math.sin(theta);

  return {
    x: GALACTIC_FRAME.radiusAu * c,
    y: GALACTIC_FRAME.radiusAu * s,
    z: 0,
    vx: -GALACTIC_FRAME.circularSpeedAuYr * s,
    vy:  GALACTIC_FRAME.circularSpeedAuYr * c,
    vz: 0,
  };
}

export function stepGalacticOrigin(origin: GalacticOriginState, dtYr: number): void {
  const a1 = accelerationAt(origin.x, origin.y, origin.z);
  origin.vx += 0.5 * a1.x * dtYr;
  origin.vy += 0.5 * a1.y * dtYr;
  origin.vz += 0.5 * a1.z * dtYr;

  origin.x += origin.vx * dtYr;
  origin.y += origin.vy * dtYr;
  origin.z += origin.vz * dtYr;

  const a2 = accelerationAt(origin.x, origin.y, origin.z);
  origin.vx += 0.5 * a2.x * dtYr;
  origin.vy += 0.5 * a2.y * dtYr;
  origin.vz += 0.5 * a2.z * dtYr;
}

export function galacticTidalAcceleration(body: Body, origin: GalacticOriginState): Vec3 {
  const center = accelerationAt(origin.x, origin.y, origin.z);
  const bodyAbs = accelerationAt(origin.x + body.x, origin.y + body.y, origin.z + body.z);
  return {
    x: bodyAbs.x - center.x,
    y: bodyAbs.y - center.y,
    z: bodyAbs.z - center.z,
  };
}

export function galacticSpeedKmS(origin: GalacticOriginState): number {
  const speedAuYr = Math.hypot(origin.vx, origin.vy, origin.vz);
  return speedAuYr / KM_S_TO_AU_YR;
}

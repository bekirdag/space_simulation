import { type Body } from "./body";
import { GALACTIC_CENTER_DISTANCE_PC, galacticToEcliptic } from "../catalog/scale";

type Vec3 = { x: number; y: number; z: number };

const KM_PER_AU = 149_597_870.7;
const SECONDS_PER_YEAR = 365.25 * 24 * 3600;
const PARSEC_AU = 206_264.80624709636;
const KM_S_TO_AU_YR = SECONDS_PER_YEAR / KM_PER_AU;
const MODEL_EPOCH_MS = Date.UTC(2000, 0, 1, 12);

// Local galactic reference model. JPL Horizons is solar-system scoped; this
// model supplies a stable external frame without moving GPU coordinates to
// billion-AU galactocentric values. Physical (not visual) AU. The orbit lies in
// the real galactic plane: the Sun sits at −R0 along the galactic-centre
// direction (the same direction as the Sgr A* marker) and moves towards l=90°
// (clockwise seen from the north galactic pole). Axes are ecliptic J2000.
export const GALACTIC_FRAME = {
  name: "local circular galactic frame",
  radiusAu: GALACTIC_CENTER_DISTANCE_PC * PARSEC_AU,
  circularSpeedAuYr: 240 * KM_S_TO_AU_YR,
} as const;

// Galactic X (towards the centre) and Y (direction of rotation, l=90°) in ecliptic axes.
const GALACTIC_X = galacticToEcliptic(1, 0, 0);
const GALACTIC_Y = galacticToEcliptic(0, 1, 0);

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
  const R = GALACTIC_FRAME.radiusAu;
  const V = GALACTIC_FRAME.circularSpeedAuYr;

  // Galactocentric position of the Sun: r = R(−cosθ X + sinθ Y), v = V(sinθ X + cosθ Y).
  const pos = (i: 0 | 1 | 2) => R * (-c * GALACTIC_X[i] + s * GALACTIC_Y[i]);
  const vel = (i: 0 | 1 | 2) => V * (s * GALACTIC_X[i] + c * GALACTIC_Y[i]);
  return {
    x: pos(0), y: pos(1), z: pos(2),
    vx: vel(0), vy: vel(1), vz: vel(2),
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

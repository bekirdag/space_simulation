// J2000.0 solar system — real masses, radii, and orbital elements.
//
// Epoch: January 1.5, 2000 (J2000.0)
// Reference frame: ecliptic J2000.0
// Units: AU, M☉, years  →  G = 4π²
//
// Radii are mean volumetric sphere equivalents, not equatorial bulge.
// Orbital elements from NASA JPL Keplerian elements for approximate
// planetary positions (https://ssd.jpl.nasa.gov/planets/approx_pos.html).

import { type Body } from "./body";
import { BodyType, G } from "./constants";

let _id = 0;
const uid = () => _id++;

// ── Unit conversions ────────────────────────────────────────────────────────
const KM_PER_AU  = 149_597_870.7;
const M_SUN_KG   = 1.989e30; // kg

function kmToAU(km: number)  { return km  / KM_PER_AU; }
function kgToMsun(kg: number){ return kg  / M_SUN_KG; }

// ── Physical data ────────────────────────────────────────────────────────────
// Radii (mean volumetric, km) → AU
const R = {
  Sun:     kmToAU(696_000),
  Mercury: kmToAU(  2_439.7),
  Venus:   kmToAU(  6_051.8),
  Earth:   kmToAU(  6_371.0),
  Mars:    kmToAU(  3_389.5),
  Jupiter: kmToAU( 69_911  ),
  Saturn:  kmToAU( 58_232  ),
  Uranus:  kmToAU( 25_362  ),
  Neptune: kmToAU( 24_622  ),
} as const;

// Masses (kg) → solar masses
const M = {
  Sun:     1.0,
  Mercury: kgToMsun(3.301e23),
  Venus:   kgToMsun(4.867e24),
  Earth:   kgToMsun(5.972e24),
  Mars:    kgToMsun(6.417e23),
  Jupiter: kgToMsun(1.898e27),
  Saturn:  kgToMsun(5.683e26),
  Uranus:  kgToMsun(8.681e25),
  Neptune: kgToMsun(1.024e26),
} as const;

// ── Kepler solver ────────────────────────────────────────────────────────────
/** Solve Kepler's equation  M = E − e·sin(E)  for the eccentric anomaly E. */
function solveKepler(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 60; i++) {
    const dE = (M - E + e * Math.sin(E)) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// ── Orbital elements → Cartesian state ──────────────────────────────────────
interface Elements {
  a: number;     // semi-major axis (AU)
  e: number;     // eccentricity
  i: number;     // inclination (°)
  Omega: number; // longitude of ascending node (°, Ω)
  omega: number; // argument of perihelion (°, ω — measured from ascending node)
  M0: number;    // mean anomaly at J2000.0 (°)
}

/** Returns Cartesian position + velocity in the ecliptic J2000.0 frame (AU, AU/yr). */
function elementsToCartesian(el: Elements): {
  x:number; y:number; z:number;
  vx:number; vy:number; vz:number;
} {
  const D = Math.PI / 180;
  const i  = el.i     * D;
  const ω  = el.omega * D;
  const Ω  = el.Omega * D;
  const M  = ((el.M0 % 360) + 360) % 360 * D; // normalise to [0, 2π]

  const E    = solveKepler(M, el.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const ecc1 = Math.sqrt(1 - el.e * el.e);

  // Position in orbital plane (perifocal frame)
  const xO = el.a * (cosE - el.e);
  const yO = el.a * ecc1 * sinE;

  // Velocity in orbital plane.
  // dE/dt = n / (1 − e·cos E),  n = mean motion (rad/yr)
  const n    = Math.sqrt(G / (el.a * el.a * el.a)); // G·Msun = G·1 = 4π²
  const dEdt = n / (1 - el.e * cosE);
  const vxO  = -el.a * sinE  * dEdt;
  const vyO  =  el.a * ecc1  * cosE * dEdt;

  // Rotation from perifocal frame to ecliptic frame (Gauss basis vectors P̂, Q̂)
  const cΩ = Math.cos(Ω); const sΩ = Math.sin(Ω);
  const cω = Math.cos(ω); const sω = Math.sin(ω);
  const ci = Math.cos(i); const si = Math.sin(i);

  const Px =  cΩ*cω - sΩ*sω*ci;
  const Py =  sΩ*cω + cΩ*sω*ci;
  const Pz =     sω*si;
  const Qx = -cΩ*sω - sΩ*cω*ci;
  const Qy = -sΩ*sω + cΩ*cω*ci;
  const Qz =     cω*si;

  return {
    x:  Px*xO  + Qx*yO,
    y:  Py*xO  + Qy*yO,
    z:  Pz*xO  + Qz*yO,
    vx: Px*vxO + Qx*vyO,
    vy: Py*vxO + Qy*vyO,
    vz: Pz*vxO + Qz*vyO,
  };
}

// ── Presets ──────────────────────────────────────────────────────────────────

/**
 * Solar system at the J2000.0 epoch (2000-Jan-01 12:00 TT).
 * Positions match the real solar system on that date.
 */
export function solarSystem(): Body[] {
  // J2000.0 elements: a(AU), e, i(°), Ω(°), ω(°), M0(°)
  // Source: NASA JPL Keplerian elements, Table 1 (centennial rates omitted)
  const data: [
    string,                              // name
    [number,number,number],              // RGB color
    Elements,
  ][] = [
    ["Mercury", [0.72,0.66,0.60], { a:0.38709927, e:0.20563593, i:7.00497902, Omega:48.33076593, omega:29.12703, M0:174.79253 }],
    ["Venus",   [0.95,0.85,0.50], { a:0.72333566, e:0.00677672, i:3.39467605, Omega:76.67984255, omega:54.92263, M0: 50.37663 }],
    ["Earth",   [0.30,0.60,1.00], { a:1.00000261, e:0.01671123, i:0.00001531, Omega:0.0,         omega:102.9377, M0:357.52311 }],
    ["Mars",    [0.90,0.45,0.25], { a:1.52371034, e:0.09339410, i:1.84969142, Omega:49.55953891, omega:286.4968, M0: 19.39020 }],
    ["Jupiter", [0.85,0.75,0.60], { a:5.20288700, e:0.04838624, i:1.30439695, Omega:100.4739091, omega:274.2546, M0: 19.66796 }],
    ["Saturn",  [0.95,0.90,0.70], { a:9.53667594, e:0.05386179, i:2.48599187, Omega:113.6624245, omega:338.9365, M0:317.35537 }],
    ["Uranus",  [0.50,0.85,0.90], { a:19.1891646, e:0.04725744, i:0.77263783, Omega:74.01692503, omega: 96.9374, M0:142.28383 }],
    ["Neptune", [0.30,0.50,1.00], { a:30.0699228, e:0.00859048, i:1.77004347, Omega:131.7842257, omega:273.1805, M0:259.91521 }],
  ];

  const bodies: Body[] = [];

  // Sun — placed at origin; its slight barycentric wobble develops naturally
  bodies.push({
    id: uid(), name: "Sun",
    mass: M.Sun, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    radius: R.Sun, color: [1.0, 0.95, 0.4], type: BodyType.Star,
  });

  for (const [name, color, elements] of data) {
    const c = elementsToCartesian(elements);
    bodies.push({
      id: uid(), name,
      mass:   M[name as keyof typeof M],
      radius: R[name as keyof typeof R],
      color,
      type: BodyType.Planet,
      ...c,
    });
  }

  return bodies;
}

/**
 * Two equal-mass sun-like stars in a tight circular orbit.
 */
export function binaryStars(): Body[] {
  const m = 0.5, d = 1.0;
  // Orbital velocity for two equal masses: v = sqrt(G·m / (2·d))
  const v = Math.sqrt(G * m / (2 * d));
  return [
    { id:uid(), name:"Star A", mass:m, x:-d/2, y:0, z:0, vx:0, vy:-v, vz:0, radius:R.Sun, color:[1.0,0.8,0.3], type:BodyType.Star },
    { id:uid(), name:"Star B", mass:m, x: d/2, y:0, z:0, vx:0, vy: v, vz:0, radius:R.Sun, color:[0.5,0.7,1.0], type:BodyType.Star },
  ];
}

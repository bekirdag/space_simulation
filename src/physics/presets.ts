// J2000.0 solar system — real masses, radii, and orbital elements.
//
// All moons and dwarf planets are included here so they are ALWAYS present
// in the simulation regardless of whether Horizons data is available.
// When applyHorizons() runs it finds each body by name and updates its
// position/velocity with Horizons-accurate SSB-frame data.

import { type Body } from "./body";
import { BodyType, G } from "./constants";
import { createSecondaryBody } from "./moons";

let _id = 0;
const uid = () => _id++;

const KM_PER_AU = 149_597_870.7;
const M_SUN_KG  = 1.989e30;

function kmToAU(km: number)   { return km / KM_PER_AU; }
function kgToMsun(kg: number) { return kg / M_SUN_KG; }

// ── Physical data (planets only — moons/dwarfs come from moons.ts) ────────────
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

// ── Kepler solver ─────────────────────────────────────────────────────────────
function solveKepler(M: number, e: number): number {
  let E = M;
  for (let i = 0; i < 60; i++) {
    const dE = (M - E + e * Math.sin(E)) / (1 - e * Math.cos(E));
    E += dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

interface Elements {
  a: number; e: number; i: number;
  Omega: number; omega: number; M0: number;
}

/** Cartesian position + velocity in ecliptic J2000.0 (AU, AU/yr). */
function elementsToCartesian(el: Elements): {
  x:number; y:number; z:number; vx:number; vy:number; vz:number;
} {
  const D  = Math.PI / 180;
  const i  = el.i     * D;
  const ω  = el.omega * D;
  const Ω  = el.Omega * D;
  const Mv = ((el.M0 % 360) + 360) % 360 * D;

  const E    = solveKepler(Mv, el.e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const ecc1 = Math.sqrt(1 - el.e * el.e);

  const xO = el.a * (cosE - el.e);
  const yO = el.a * ecc1 * sinE;

  const n    = Math.sqrt(G / (el.a * el.a * el.a));
  const dEdt = n / (1 - el.e * cosE);
  const vxO  = -el.a * sinE  * dEdt;
  const vyO  =  el.a * ecc1  * cosE * dEdt;

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
    x: Px*xO+Qx*yO, y: Py*xO+Qy*yO, z: Pz*xO+Qz*yO,
    vx:Px*vxO+Qx*vyO, vy:Py*vxO+Qy*vyO, vz:Pz*vxO+Qz*vyO,
  };
}

/**
 * Place a moon in a circular orbit around a parent body.
 * phase  — orbital phase in radians (0 = moon along +x relative to parent)
 * retrograde — true for Triton (orbits opposite direction)
 */
function moonState(
  parent: Body, sma: number, phase: number,
  retrograde = false,
): { x:number; y:number; z:number; vx:number; vy:number; vz:number } {
  const cv = Math.sqrt(G * parent.mass / sma);
  const cos = Math.cos(phase);
  const sin = Math.sin(phase);
  const sign = retrograde ? -1 : 1;
  return {
    x:  parent.x + sma * cos,
    y:  parent.y + sma * sin,
    z:  parent.z,
    vx: parent.vx - sign * cv * sin,
    vy: parent.vy + sign * cv * cos,
    vz: parent.vz,
  };
}

// ── Presets ───────────────────────────────────────────────────────────────────

/**
 * Solar system at J2000.0 with all major moons and dwarf planets.
 * Positions are approximate circular-orbit fallbacks for moons;
 * applyHorizons() replaces them with accurate SSB-frame data.
 */
export function solarSystem(): Body[] {
  // J2000.0 elements: a, e, i(°), Ω(°), ω(°), M0(°)
  const planetData: [string, [number,number,number], Elements][] = [
    ["Mercury",[0.72,0.66,0.60],{a:0.38709927,e:0.20563593,i:7.00497902,Omega:48.33076593,omega:29.12703,M0:174.79253}],
    ["Venus",  [0.95,0.85,0.50],{a:0.72333566,e:0.00677672,i:3.39467605,Omega:76.67984255,omega:54.92263,M0: 50.37663}],
    ["Earth",  [0.30,0.60,1.00],{a:1.00000261,e:0.01671123,i:0.00001531,Omega:0.0,        omega:102.9377,M0:357.52311}],
    ["Mars",   [0.90,0.45,0.25],{a:1.52371034,e:0.09339410,i:1.84969142,Omega:49.55953891,omega:286.4968,M0: 19.39020}],
    ["Jupiter",[0.85,0.75,0.60],{a:5.20288700,e:0.04838624,i:1.30439695,Omega:100.4739091,omega:274.2546,M0: 19.66796}],
    ["Saturn", [0.95,0.90,0.70],{a:9.53667594,e:0.05386179,i:2.48599187,Omega:113.6624245,omega:338.9365,M0:317.35537}],
    ["Uranus", [0.50,0.85,0.90],{a:19.1891646,e:0.04725744,i:0.77263783,Omega:74.01692503,omega: 96.9374,M0:142.28383}],
    ["Neptune",[0.30,0.50,1.00],{a:30.0699228,e:0.00859048,i:1.77004347,Omega:131.7842257,omega:273.1805,M0:259.91521}],
  ];

  const bodies: Body[] = [];

  bodies.push({
    id:uid(), name:"Sun", mass:M.Sun,
    x:0,y:0,z:0,vx:0,vy:0,vz:0,
    radius:R.Sun, color:[1.0,0.95,0.4], type:BodyType.Star,
  });

  const planetMap = new Map<string, Body>();
  for (const [name, color, el] of planetData) {
    const c = elementsToCartesian(el);
    const b: Body = {
      id:uid(), name, mass:M[name as keyof typeof M],
      radius:R[name as keyof typeof R], color, type:BodyType.Planet, ...c,
    };
    bodies.push(b);
    planetMap.set(name, b);
  }

  // ── Dwarf planets (J2000.0 orbital elements) ─────────────────────────────
  const dwarfData: [string, Elements][] = [
    ["Pluto",    {a:39.48,   e:0.2488,  i:17.14,  Omega:110.30,  omega:113.83, M0: 14.9  }],
    ["Eris",     {a:67.84,   e:0.4361,  i:44.04,  Omega: 35.87,  omega:151.43, M0:203.8  }],
    ["Ceres",    {a: 2.7675, e:0.0760,  i:10.593, Omega: 80.305, omega: 73.60, M0: 95.0  }],
    ["Haumea",   {a:43.22,   e:0.1912,  i:28.19,  Omega:121.90,  omega:239.03, M0:218.2  }],
    ["Makemake", {a:45.79,   e:0.1622,  i:29.01,  Omega: 79.38,  omega:297.24, M0:137.9  }],
  ];

  for (const [name, el] of dwarfData) {
    const mb = createSecondaryBody(name);
    if (!mb) continue;
    const c = elementsToCartesian(el);
    bodies.push({ ...mb, id: uid(), ...c });
  }

  // ── Moons — circular orbit approximation relative to parent ──────────────
  // Semi-major axes in AU (from parent body).
  // Phase angles spread out so moons don't stack on the same axis.
  // These positions are overridden by Horizons SSB-frame data at load time.

  const P = Math.PI;

  // Earth
  const earth = planetMap.get("Earth")!;
  const moonData: [string, Body, number, number, boolean][] = [
    // [name, parent, SMA (AU), phase (rad), retrograde?]
    ["Moon",     earth,                  0.00257, 0.0,      false],

    // Jupiter — Galilean moons at different phases
    ["Io",       planetMap.get("Jupiter")!, 0.00282, 0.0,      false],
    ["Europa",   planetMap.get("Jupiter")!, 0.00449, P*0.5,    false],
    ["Ganymede", planetMap.get("Jupiter")!, 0.00716, P,        false],
    ["Callisto", planetMap.get("Jupiter")!, 0.01259, P*1.5,    false],

    // Saturn
    ["Mimas",     planetMap.get("Saturn")!, 0.001239, 0.0,     false],
    ["Enceladus", planetMap.get("Saturn")!, 0.001591, P*0.4,   false],
    ["Tethys",    planetMap.get("Saturn")!, 0.001970, P*0.8,   false],
    ["Dione",     planetMap.get("Saturn")!, 0.002523, P*1.2,   false],
    ["Rhea",      planetMap.get("Saturn")!, 0.003523, P*1.6,   false],
    ["Titan",     planetMap.get("Saturn")!, 0.008168, P*0.3,   false],
    ["Iapetus",   planetMap.get("Saturn")!, 0.023808, P*0.7,   false],

    // Uranus
    ["Miranda",  planetMap.get("Uranus")!, 0.000865, 0.0,     false],
    ["Ariel",    planetMap.get("Uranus")!, 0.001277, P*0.5,   false],
    ["Umbriel",  planetMap.get("Uranus")!, 0.001778, P,       false],
    ["Titania",  planetMap.get("Uranus")!, 0.002913, P*1.5,   false],
    ["Oberon",   planetMap.get("Uranus")!, 0.003901, P*0.25,  false],

    // Neptune — Triton is RETROGRADE
    ["Triton",   planetMap.get("Neptune")!, 0.002372, 0.0,    true],

    // Pluto–Charon (Charon orbits Pluto; Pluto is in bodies as dwarf planet)
  ];

  for (const [name, parent, sma, phase, retro] of moonData) {
    if (!parent) continue;
    const mb = createSecondaryBody(name);
    if (!mb) continue;
    const s = moonState(parent, sma, phase, retro);
    bodies.push({ ...mb, id: uid(), ...s });
  }

  // Charon orbits Pluto — find Pluto in the bodies array we just built
  const pluto = bodies.find(b => b.name === "Pluto");
  if (pluto) {
    const charon = createSecondaryBody("Charon");
    if (charon) {
      const s = moonState(pluto, 0.000131, 0.0);
      bodies.push({ ...charon, id: uid(), ...s });
    }
  }

  return bodies;
}

/**
 * Two equal-mass sun-like stars in a tight circular orbit.
 */
export function binaryStars(): Body[] {
  const m = 0.5, d = 1.0;
  const v = Math.sqrt(G * m / (2 * d));
  return [
    { id:uid(), name:"Star A", mass:m, x:-d/2,y:0,z:0,vx:0,vy:-v,vz:0,
      radius:kmToAU(696_000), color:[1.0,0.8,0.3], type:BodyType.Star },
    { id:uid(), name:"Star B", mass:m, x: d/2,y:0,z:0,vx:0,vy: v,vz:0,
      radius:kmToAU(696_000), color:[0.5,0.7,1.0], type:BodyType.Star },
  ];
}

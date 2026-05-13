/**
 * Physical data for all secondary bodies:
 *   • Moons (orbit planets)
 *   • Dwarf planets (orbit the Sun, added via Horizons only)
 *
 * The factory `createSecondaryBody()` is used by applyHorizons()
 * to create Body entries for any name not already in the planets array.
 */

import { type Body } from "./body";
import { BodyType } from "./constants";

const AU_KM = 149_597_870.7;
const M_SUN = 1.989e30;

interface Datum {
  mass:     number;
  radiusKm: number;
  color:    [number, number, number];
  type:     typeof BodyType[keyof typeof BodyType];
}

const DATA: Record<string, Datum> = {
  // ── Earth ─────────────────────────────────────────────────────────────────
  Moon:      { mass:7.342e22,  radiusKm:1737.4, color:[0.85,0.82,0.78], type:BodyType.Moon },

  // ── Jupiter — Galilean moons ───────────────────────────────────────────────
  Io:        { mass:8.932e22,  radiusKm:1821.6, color:[0.90,0.72,0.28], type:BodyType.Moon },
  Europa:    { mass:4.800e22,  radiusKm:1560.8, color:[0.84,0.80,0.75], type:BodyType.Moon },
  Ganymede:  { mass:1.482e23,  radiusKm:2634.1, color:[0.62,0.56,0.50], type:BodyType.Moon },
  Callisto:  { mass:1.076e23,  radiusKm:2410.3, color:[0.48,0.43,0.40], type:BodyType.Moon },

  // ── Saturn ────────────────────────────────────────────────────────────────
  Mimas:     { mass:3.750e19,  radiusKm: 198.2, color:[0.85,0.83,0.80], type:BodyType.Moon },
  Enceladus: { mass:1.080e20,  radiusKm: 252.1, color:[0.96,0.96,0.98], type:BodyType.Moon },
  Tethys:    { mass:6.180e20,  radiusKm: 531.1, color:[0.83,0.80,0.78], type:BodyType.Moon },
  Dione:     { mass:1.095e21,  radiusKm: 561.4, color:[0.80,0.77,0.75], type:BodyType.Moon },
  Rhea:      { mass:2.307e21,  radiusKm: 763.8, color:[0.78,0.74,0.72], type:BodyType.Moon },
  Titan:     { mass:1.345e23,  radiusKm:2574.7, color:[0.90,0.65,0.30], type:BodyType.Moon },
  Iapetus:   { mass:1.806e21,  radiusKm: 734.5, color:[0.65,0.60,0.55], type:BodyType.Moon },

  // ── Uranus ────────────────────────────────────────────────────────────────
  Miranda:   { mass:6.590e19,  radiusKm: 235.8, color:[0.68,0.65,0.62], type:BodyType.Moon },
  Ariel:     { mass:1.353e21,  radiusKm: 578.9, color:[0.72,0.70,0.68], type:BodyType.Moon },
  Umbriel:   { mass:1.172e21,  radiusKm: 584.7, color:[0.42,0.40,0.40], type:BodyType.Moon },
  Titania:   { mass:3.527e21,  radiusKm: 788.9, color:[0.62,0.60,0.58], type:BodyType.Moon },
  Oberon:    { mass:3.014e21,  radiusKm: 761.4, color:[0.52,0.48,0.46], type:BodyType.Moon },

  // ── Neptune ───────────────────────────────────────────────────────────────
  Triton:    { mass:2.140e22,  radiusKm:1353.4, color:[0.72,0.78,0.90], type:BodyType.Moon },

  // ── Pluto system ──────────────────────────────────────────────────────────
  Pluto:     { mass:1.303e22,  radiusKm:1188.3, color:[0.82,0.75,0.68], type:BodyType.DwarfPlanet },
  Charon:    { mass:1.587e21,  radiusKm: 606.0, color:[0.72,0.68,0.65], type:BodyType.Moon },

  // ── Other dwarf planets ───────────────────────────────────────────────────
  Eris:      { mass:1.660e22,  radiusKm:1163.0, color:[0.92,0.90,0.88], type:BodyType.DwarfPlanet },
  Ceres:     { mass:9.384e20,  radiusKm: 469.7, color:[0.58,0.55,0.52], type:BodyType.DwarfPlanet },
  Haumea:    { mass:4.006e21,  radiusKm: 780.0, color:[0.88,0.86,0.84], type:BodyType.DwarfPlanet },
  Makemake:  { mass:3.100e21,  radiusKm: 715.0, color:[0.80,0.72,0.65], type:BodyType.DwarfPlanet },
};

let _id = 10_000;

/** Create a Body shell for any secondary body. Caller must apply Horizons state. */
export function createSecondaryBody(name: string): Body | null {
  const d = DATA[name];
  if (!d) return null;
  return {
    id:     _id++,
    name,
    mass:   d.mass   / M_SUN,
    radius: d.radiusKm / AU_KM,
    color:  d.color,
    type:   d.type,
    x:0, y:0, z:0, vx:0, vy:0, vz:0,
  };
}

// Keep old name as alias so nav.ts import still works
export { createSecondaryBody as createMoonBody };

export function isSecondaryBody(name: string): boolean {
  return name in DATA;
}

// ── Travel zoom distances ────────────────────────────────────────────────────

/** Zoom when travelling directly to a moon/dwarf planet (AU from body). */
export const MOON_ZOOM: Record<string, number> = {
  // Earth
  Moon:     0.004,
  // Jupiter
  Io:0.003, Europa:0.003, Ganymede:0.004, Callisto:0.004,
  // Saturn
  Titan:0.005, Enceladus:0.002, Rhea:0.003, Iapetus:0.003,
  Mimas:0.002, Tethys:0.002,  Dione:0.002,
  // Uranus
  Miranda:0.002, Ariel:0.002, Umbriel:0.002, Titania:0.003, Oberon:0.003,
  // Neptune
  Triton:0.004,
  // Pluto system
  Pluto:0.001, Charon:0.0005,
  // Dwarf planets
  Eris:0.005, Ceres:0.004, Haumea:0.004, Makemake:0.004,
};

/**
 * When clicking a planet on the canvas, zoom to this distance (AU) to show
 * the planet AND all of its major moons in frame.
 * Uses the orbit radius of the furthest major moon × ~3.
 */
export const SYSTEM_VIEW: Record<string, number> = {
  Sun:     55,    // solar system overview
  Mercury: 0.015, // no significant moons
  Venus:   0.015,
  Earth:   0.008, // Moon at 0.0026 AU
  Mars:    0.015,
  Jupiter: 0.05,  // Callisto at 0.013 AU
  Saturn:  0.08,  // Iapetus at 0.024 AU
  Uranus:  0.015, // Oberon at 0.004 AU
  Neptune: 0.010, // Triton at 0.002 AU
  Pluto:   0.001, // Charon at 0.00013 AU
  // Dwarf planets — no moons in sim except Charon
  Eris:    0.005,
  Ceres:   0.004,
  Haumea:  0.004,
  Makemake:0.004,
};

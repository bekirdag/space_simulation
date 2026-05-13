// Solar-system units: distance=AU, mass=M☉, time=years
// G in these units = 4π² so that Earth orbits at 1AU in 1yr
export const G = 4 * Math.PI * Math.PI;

// Softening factor — prevents singularity on close encounters (AU)
export const SOFTENING = 0.001;

// 1 Julian year in seconds (used for real-time calibration)
export const SECONDS_PER_YEAR = 365.25 * 24 * 3600; // 31_557_600

// Max integrator sub-step: 1 sim-hour.
// Required now that moons are included: Io's period is 1.77 days.
//   At 6-hour steps: only 7 steps/Io orbit (bad).
//   At 1-hour steps: 42 steps/Io orbit (acceptable).
// Mercury phase error at 1h: (π/6)×(1/24/88)² × 207 orbits ≈ 0.003°/50yr.
export const MAX_SUBSTEP_YR = 1.0 / (365.25 * 24); // 1 hour

// Body type helpers (cosmetic only — does not affect physics)
export const BodyType = {
  Star:       0,
  Planet:     1,
  Moon:       2,
  Asteroid:   3,
  DwarfPlanet:4,
} as const;
export type BodyType = (typeof BodyType)[keyof typeof BodyType];

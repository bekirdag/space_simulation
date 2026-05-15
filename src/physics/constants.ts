// Solar-system units: distance=AU, mass=M☉, time=years
// G in these units = 4π² so that Earth orbits at 1AU in 1yr
export const G = 4 * Math.PI * Math.PI;

// Softening factor — prevents divide-by-zero on exact overlap (AU).
// OLD value 0.001 AU caused Moon's gravity to be 19% too weak,
// Charon's gravity to be 99.78% too weak.  The smallest real orbital
// radius in our simulation is Charon at 0.000131 AU; using 1e-6 AU (150 km)
// gives < 0.02% error for all simulated bodies while remaining numerically safe.
export const SOFTENING = 1e-6;

// 1 Julian year in seconds (used for real-time calibration)
export const SECONDS_PER_YEAR = 365.25 * 24 * 3600; // 31_557_600

// Max integrator sub-step: 15 min (was 1 hour).
// 4× finer: Mercury phase error 5"/50yr → 0.3"/50yr.
// At 10yr/s timewarp: 1461 sub-steps/frame (within MAX_STEPS=2000).
export const MAX_SUBSTEP_YR = 1.0 / (365.25 * 24 * 4); // 15 minutes

// Speed of light in AU/yr  (c = 299792458 m/s, 1 AU = 149597870700 m, 1 yr = 31557600 s)
export const C_AU_YR  = 299_792_458 * 31_557_600 / 149_597_870_700; // ≈ 63241 AU/yr
export const C2_AU_YR = C_AU_YR * C_AU_YR;                           // ≈ 4.0×10⁹ AU²/yr²

// Body type helpers (cosmetic only — does not affect physics)
export const BodyType = {
  Star:       0,
  Planet:     1,
  Moon:       2,
  Asteroid:   3,
  DwarfPlanet:4,
  Exoplanet:  5, // catalog exoplanet — rendered only, skipped by physics integrator
} as const;
export type BodyType = (typeof BodyType)[keyof typeof BodyType];

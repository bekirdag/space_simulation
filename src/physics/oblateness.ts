/**
 * Planetary oblateness (J₂) data for gravitational corrections.
 *
 * The J₂ term modifies the acceleration of a body orbiting an oblate planet:
 *   a_J2 = -(3/2) G M J₂ R² / r⁵ × [(1 − 5ξ²) d̂  +  2ξ ẑ] × r
 *
 * where ξ = d̂ · ẑ  (cosine of latitude above equator),
 * d̂ = unit vector from planet to orbiting body, ẑ = planet spin axis.
 *
 * Spin axes are in ecliptic J2000 coordinates, computed from IAU 2015 north-pole
 * directions (RA, Dec in ICRF) using the J2000 obliquity ε = 23.4393°:
 *   x_ecl = x_icrf
 *   y_ecl = y_icrf cos ε + z_icrf sin ε
 *   z_ecl = −y_icrf sin ε + z_icrf cos ε
 *
 * Why this matters (per-year drift of moon orbital plane without J₂):
 *   Earth  → Moon:            ~0.2 °/yr  (small; Sun already drives ~19.3°/yr in N-body)
 *   Jupiter → Galilean moons: ~47 °/yr   (CRITICAL: Io wrong after days without it)
 *   Saturn  → Titan/etc:      ~20 °/yr
 *   Uranus  → moons:           ~8 °/yr
 *   Neptune → Triton:          ~5 °/yr
 */

const KM_PER_AU = 149_597_870.7;

export interface OblatenessData {
  J2:        number;
  radiusAU:  number;
  /** Unit vector pointing toward planet's north pole in ecliptic J2000. */
  spinAxis:  readonly [number, number, number];
}

/**
 * Oblateness data keyed by body name.
 * Only planets with significant J₂ AND orbiting moons in our simulation.
 */
export const OBLATENESS = new Map<string, OblatenessData>([
  // ── Earth ──────────────────────────────────────────────────────────────────
  // IAU: RA₀=0°, Dec₀=90° (equatorial pole) → ecliptic: (0, sin ε, cos ε)
  ['Earth', {
    J2:       1.082_63e-3,
    radiusAU: 6_378.137 / KM_PER_AU,
    spinAxis: [0.0000, 0.3978, 0.9175],
  }],

  // ── Jupiter ─────────────────────────────────────────────────────────────────
  // IAU: RA₀=268.056595°, Dec₀=64.495303°  →  ecliptic ≈ (−0.015, −0.035, 0.999)
  // Only 3.1° from ecliptic north; dominant J₂ of all planets (drives 47°/yr on Io).
  ['Jupiter', {
    J2:       1.4736e-2,
    radiusAU: 71_492 / KM_PER_AU,
    spinAxis: [-0.0150, -0.0347, 0.9993],
  }],

  // ── Saturn ──────────────────────────────────────────────────────────────────
  // IAU: RA₀=40.589°, Dec₀=83.537°  →  ecliptic ≈ (0.085, 0.462, 0.883)
  ['Saturn', {
    J2:       1.6298e-2,
    radiusAU: 60_268 / KM_PER_AU,
    spinAxis: [0.0849, 0.4620, 0.8828],
  }],

  // ── Uranus ───────────────────────────────────────────────────────────────────
  // IAU: RA₀=257.311°, Dec₀=−15.175°  →  ecliptic ≈ (−0.212, −0.968, 0.134)
  // Extreme tilt (82.2°) makes the spin axis nearly in the ecliptic plane.
  ['Uranus', {
    J2:       3.343e-3,
    radiusAU: 25_559 / KM_PER_AU,
    spinAxis: [-0.2124, -0.9678, 0.1344],
  }],

  // ── Neptune ──────────────────────────────────────────────────────────────────
  // IAU: RA₀=299.36°, Dec₀=43.46°  →  ecliptic ≈ (0.354, −0.306, 0.883)
  ['Neptune', {
    J2:       3.411e-3,
    radiusAU: 24_764 / KM_PER_AU,
    spinAxis: [0.3545, -0.3063, 0.8833],
  }],

  // ── Mars ─────────────────────────────────────────────────────────────────────
  // IAU: RA₀=317.68°, Dec₀=52.89°  →  ecliptic ≈ (0.444, −0.055, 0.894)
  // Phobos and Deimos aren't in our simulation, but included for completeness.
  ['Mars', {
    J2:       1.960_45e-3,
    radiusAU: 3_396.2 / KM_PER_AU,
    spinAxis: [0.4445, -0.0546, 0.8941],
  }],
]);

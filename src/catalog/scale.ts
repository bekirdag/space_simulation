// Shared visual distance scale and galactic reference frame.
//
// Every object outside the solar system — catalog stars, exoplanet hosts,
// nebulas, Milky Way background field, dust, Sgr A*, Local Group galaxies —
// is placed at 80 visual AU per parsec (80 000 AU/kpc). Keeping one scale is
// what makes relative positions consistent (e.g. the Orion Nebula at 412 pc
// sits ~2x farther than Betelgeuse at ~197 pc). Build scripts that emit
// positions (build-visible-stars.mjs, build-milkyway-stars.mjs,
// build-dust-map.mjs, build-galaxy-catalog.mjs) duplicate these values; keep
// them in sync.
//
// World frame: heliocentric ecliptic J2000 (Horizons REF_PLANE=ECLIPTIC).

export const AU_PER_PARSEC = 80;
export const AU_PER_KPC = AU_PER_PARSEC * 1_000;
export const AU_PER_MPC = AU_PER_KPC * 1_000;

// Sun - Sgr A* distance, GRAVITY Collaboration 2019 (R0 = 8.178 kpc).
export const GALACTIC_CENTER_DISTANCE_KPC = 8.178;
export const GALACTIC_CENTER_DISTANCE_PC = GALACTIC_CENTER_DISTANCE_KPC * 1_000;
export const GALACTIC_CENTER_DISTANCE_AU = GALACTIC_CENTER_DISTANCE_KPC * AU_PER_KPC;

// ── Equatorial → ecliptic (rotation about +X by the J2000 obliquity) ────────
const J2000_OBLIQUITY_RAD = 23.4392911 * Math.PI / 180;
const COS_OBLIQUITY = Math.cos(J2000_OBLIQUITY_RAD);
const SIN_OBLIQUITY = Math.sin(J2000_OBLIQUITY_RAD);

export function equatorialToEcliptic(x: number, y: number, z: number): [number, number, number] {
  return [
    x,
    y * COS_OBLIQUITY + z * SIN_OBLIQUITY,
    -y * SIN_OBLIQUITY + z * COS_OBLIQUITY,
  ];
}

/** Unit vector (ecliptic J2000) for an ICRS/J2000 RA/Dec in degrees. */
export function raDecToEclipticUnit(raDeg: number, decDeg: number): [number, number, number] {
  const ra = raDeg * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  return equatorialToEcliptic(
    Math.cos(dec) * Math.cos(ra),
    Math.cos(dec) * Math.sin(ra),
    Math.sin(dec),
  );
}

/** Visual world position (AU, ecliptic J2000) for RA/Dec degrees and a distance in parsecs. */
export function raDecDistancePcToWorldAU(raDeg: number, decDeg: number, distancePc: number): [number, number, number] {
  const [x, y, z] = raDecToEclipticUnit(raDeg, decDeg);
  const r = distancePc * AU_PER_PARSEC;
  return [x * r, y * r, z * r];
}

// ── Galactic → ecliptic ─────────────────────────────────────────────────────
// ICRS → galactic matrix (Hipparcos, ESA 1997 Vol. 1 §1.5.3). Galactic → ICRS
// is its transpose; then rotate ICRS → ecliptic. Columns of the result are the
// galactic X (towards l=0,b=0: RA 266.405°, Dec −28.936°), Y (l=90°) and Z
// (north galactic pole) axes expressed in ecliptic J2000.
const ICRS_TO_GALACTIC = [
  [-0.0548755604162154, -0.8734370902348850, -0.4838350155487132],
  [+0.4941094278755837, -0.4448296299600112, +0.7469822444972189],
  [-0.8676661490190047, -0.1980763734312015, +0.4559837761750669],
] as const;

function buildGalacticToEcliptic(): [[number, number, number], [number, number, number], [number, number, number]] {
  const cols = ICRS_TO_GALACTIC.map(row => equatorialToEcliptic(row[0], row[1], row[2]));
  return [
    [cols[0]![0], cols[1]![0], cols[2]![0]],
    [cols[0]![1], cols[1]![1], cols[2]![1]],
    [cols[0]![2], cols[1]![2], cols[2]![2]],
  ];
}

/** Row-major 3×3: ecliptic = M · galactic. */
export const GALACTIC_TO_ECLIPTIC = buildGalacticToEcliptic();

export function galacticToEcliptic(xg: number, yg: number, zg: number): [number, number, number] {
  const m = GALACTIC_TO_ECLIPTIC;
  return [
    m[0][0] * xg + m[0][1] * yg + m[0][2] * zg,
    m[1][0] * xg + m[1][1] * yg + m[1][2] * zg,
    m[2][0] * xg + m[2][1] * yg + m[2][2] * zg,
  ];
}

export function eclipticToGalactic(xe: number, ye: number, ze: number): [number, number, number] {
  const m = GALACTIC_TO_ECLIPTIC;
  return [
    m[0][0] * xe + m[1][0] * ye + m[2][0] * ze,
    m[0][1] * xe + m[1][1] * ye + m[2][1] * ze,
    m[0][2] * xe + m[1][2] * ye + m[2][2] * ze,
  ];
}

/** Ecliptic unit vector from the Sun towards the galactic centre. */
export const GALACTIC_CENTER_DIRECTION: readonly [number, number, number] = galacticToEcliptic(1, 0, 0);

/**
 * Heliocentric galactic-frame kpc (Sun at origin, +X towards the galactic
 * centre) → visual world AU. The Milky Way field, dust and Sgr A* all use this.
 */
export function heliocentricGalacticKpcToWorldAU(xh: number, yh: number, zh: number): [number, number, number] {
  const [x, y, z] = galacticToEcliptic(xh, yh, zh);
  return [x * AU_PER_KPC, y * AU_PER_KPC, z * AU_PER_KPC];
}

/** Sgr A* / galactic centre visual world position (≈ 654 000 AU from the Sun). */
export const GALACTIC_CENTER_WORLD_AU: [number, number, number] =
  heliocentricGalacticKpcToWorldAU(GALACTIC_CENTER_DISTANCE_KPC, 0, 0);

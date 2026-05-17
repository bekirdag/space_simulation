// Named stars visible as labels while the camera moves through nearby space.
// Also exports the galactic-center (Sgr A*) world position for the permanent label.
// Sorted by distance from Sun; tiers are kept as broad distance metadata while
// LabelManager drives actual visibility from camera distance vs. each star.
//
//   Tier 0  (< ~10 pc)   — nearest neighbourhood, Alpha Cen, Sirius, Vega …
//   Tier 1  (10–50 pc)   — nearby Milky Way, Pollux, Arcturus, Capella …
//   Tier 2  (50–400 pc)  — arm stars, Betelgeuse, Antares, Canopus …
//   Tier 3  (400+ pc)    — very distant landmarks, Deneb, Rigel …
//
// Positions are in compressed equatorial J2000 render AU (AU_PER_PARSEC = 80).
// This matches the HYG x/y/z render buffer and exoplanet-host catalog stars.

import {
  colorFromSpectralType,
  starColorFromBv,
  stellarRadiusSolarFromPhotometry,
  stellarRenderRadiusAU,
} from "./stars";

export interface NearbyStarLabel {
  name:   string;
  x:      number;
  y:      number;
  z:      number;
  distPc: number;
  tier:   number;
  color:  [number, number, number];
  bv?: number;
  spectralType?: string;
  magnitude?: number;
  radiusSolar?: number;
  radiusAU?: number;
}

export const NEARBY_STAR_AU_PER_PARSEC = 80; // must match build-visible-stars.mjs
const APc = NEARBY_STAR_AU_PER_PARSEC;

function p(ra: number, dec: number, d: number): [number, number, number] {
  const r  = ra  * Math.PI / 180;
  const dc = dec * Math.PI / 180;
  const xe = d * Math.cos(dc) * Math.cos(r);
  const ye = d * Math.cos(dc) * Math.sin(r);
  const ze = d * Math.sin(dc);
  return [xe * APc, ye * APc, ze * APc];
}

interface NearbyStarPhotometry {
  bv?: number;
  spectralType?: string;
  magnitude?: number;
  radiusSolar?: number;
}

// HYG 4.2 photometry for named nearby-star anchors. These anchors are drawn
// separately from the 100k mapped-star binary, so they need their own B-V or
// spectral color metadata instead of a generic blue-white fallback.
const NEARBY_STAR_PHOTOMETRY: Record<string, NearbyStarPhotometry> = {
  "Proxima Centauri": { bv: 1.807, spectralType: "M5Ve", magnitude: 11.01 },
  "Alpha Centauri": { bv: 0.71, spectralType: "G2V", magnitude: -0.01 },
  "Barnard's Star": { bv: 1.57, spectralType: "sdM4", magnitude: 9.54 },
  "Wolf 359": { bv: 2.0, spectralType: "M6", magnitude: 13.45 },
  "Lalande 21185": { bv: 1.502, spectralType: "M2V", magnitude: 7.49 },
  Sirius: { bv: 0.009, spectralType: "A0m...", magnitude: -1.44 },
  "Ross 154": { bv: 1.51, spectralType: "M3.5Ve", magnitude: 10.37 },
  "Ross 248": { bv: 1.9, spectralType: "dM6  e", magnitude: 12.29 },
  "Epsilon Eridani": { bv: 0.88, spectralType: "K2V", magnitude: 3.73 },
  "Lacaille 9352": { bv: 1.483, spectralType: "M2/M3V", magnitude: 7.35 },
  "Ross 128": { bv: 1.746, spectralType: "M4.5V", magnitude: 11.12 },
  "61 Cygni": { bv: 1.18, spectralType: "K5V+K7V", magnitude: 5.21 },
  Procyon: { bv: 0.432, spectralType: "F5IV-V", magnitude: 0.4 },
  "Struve 2398": { bv: 1.504, spectralType: "K5", magnitude: 8.94 },
  "Groombridge 34": { bv: 1.56, spectralType: "M1V", magnitude: 8.09 },
  "Epsilon Indi": { bv: 1.06, spectralType: "K5V", magnitude: 4.69 },
  "Tau Ceti": { bv: 0.72, spectralType: "G8.5V", magnitude: 3.5 },
  "Luyten's Star": { bv: 1.573, spectralType: "M5", magnitude: 9.84 },
  "Kapteyn's Star": { bv: 1.543, spectralType: "M0V", magnitude: 8.86 },
  "Lacaille 8760": { bv: 1.397, spectralType: "M1/M2V", magnitude: 6.69 },
  "Kruger 60": { bv: 1.613, spectralType: "M2V", magnitude: 9.59 },
  "Ross 614": { bv: 1.69, spectralType: "M4.5Ve", magnitude: 11.12 },
  "van Maanen's Star": { bv: 0.554, spectralType: "DG", magnitude: 12.37 },
  "40 Eridani": { bv: 0.82, spectralType: "K1V", magnitude: 4.43 },
  Altair: { bv: 0.221, spectralType: "A7IV-V", magnitude: 0.76 },
  "70 Ophiuchi": { bv: 0.86, spectralType: "K0V+K5V", magnitude: 4.03 },
  "Eta Cassiopeiae": { bv: 0.587, spectralType: "G0V SB", magnitude: 3.46 },
  "82 Eridani": { bv: 0.711, spectralType: "G8V", magnitude: 4.26 },
  "Delta Pavonis": { bv: 0.75, spectralType: "G8IV", magnitude: 3.56 },
  "Beta Hydri": { bv: 0.62, spectralType: "G2IV", magnitude: 2.8 },
  Fomalhaut: { bv: 0.145, spectralType: "A3V", magnitude: 1.17 },
  Vega: { bv: -0.001, spectralType: "A0Vvar", magnitude: 0.03 },
  Pollux: { bv: 0.991, spectralType: "K0IIIvar", magnitude: 1.16 },
  Arcturus: { bv: 1.239, spectralType: "K2IIIp", magnitude: -0.05 },
  Capella: { bv: 0.795, spectralType: "G8III+G0III", magnitude: 0.08 },
  "Alpha Lupi": { bv: -0.2, spectralType: "B1.5III", magnitude: 2.3 },
  Castor: { bv: 0.034, spectralType: "A2Vm", magnitude: 1.58 },
  "Gemma (Alphecca)": { bv: 0.032, spectralType: "A0V", magnitude: 2.22 },
  Mizar: { bv: 0.057, spectralType: "A2V", magnitude: 2.23 },
  Aldebaran: { bv: 1.538, spectralType: "K5III", magnitude: 0.87 },
  Algol: { bv: -0.003, spectralType: "B8V", magnitude: 2.09 },
  Gacrux: { bv: 1.6, spectralType: "M4III", magnitude: 1.59 },
  Regulus: { bv: -0.087, spectralType: "B7V", magnitude: 1.36 },
  Shaula: { bv: -0.231, spectralType: "B1.5IV+...", magnitude: 1.62 },
  Izar: { bv: 0.966, spectralType: "A0", magnitude: 2.35 },
  Denebola: { bv: 0.09, spectralType: "A3Vvar", magnitude: 2.14 },
  Wezen: { bv: 0.671, spectralType: "F8Ia", magnitude: 1.83 },
  Mirfak: { bv: 0.481, spectralType: "F5Ib", magnitude: 1.79 },
  Achernar: { bv: -0.158, spectralType: "B3Vp", magnitude: 0.45 },
  Spica: { bv: -0.235, spectralType: "B1V", magnitude: 0.98 },
  Acrux: { bv: -0.243, spectralType: "B0.5IV", magnitude: 0.77 },
  Hadar: { bv: -0.231, spectralType: "B1III", magnitude: 0.61 },
  Antares: { bv: 1.865, spectralType: "M1Ib + B2.5V", magnitude: 1.06 },
  Canopus: { bv: 0.164, spectralType: "F0Ib", magnitude: -0.62 },
  Bellatrix: { bv: -0.224, spectralType: "B2III", magnitude: 1.64 },
  Alnilam: { bv: -0.184, spectralType: "B0Ia", magnitude: 1.69 },
  Betelgeuse: { bv: 1.5, spectralType: "M2Ib", magnitude: 0.45 },
  Alnitak: { bv: -0.199, spectralType: "O9.5Ib SB", magnitude: 1.74 },
  Mintaka: { bv: -0.175, spectralType: "O9.5II", magnitude: 2.25 },
  Rigel: { bv: -0.03, spectralType: "B8Ia", magnitude: 0.18 },
  Deneb: { bv: 0.092, spectralType: "A2Ia", magnitude: 1.25 },
  Naos: { bv: -0.269, spectralType: "O5IAf", magnitude: 2.21 },
  "VY Canis Majoris": { bv: 2.0, spectralType: "M3-M4II", magnitude: 7.95 },
  Mira: { bv: 0.966, spectralType: "M5e-M9e", magnitude: 6.47 },
  Saiph: { bv: -0.168, spectralType: "B0.5Iavar", magnitude: 2.07 },
  Adhara: { bv: -0.211, spectralType: "B2II", magnitude: 1.5 },
};

function visualColorForStar(name: string): [number, number, number] {
  const photometry = NEARBY_STAR_PHOTOMETRY[name];
  if (photometry?.bv !== undefined) return starColorFromBv(photometry.bv);
  if (photometry?.spectralType) {
    const spectralColor = colorFromSpectralType(photometry.spectralType);
    if (spectralColor) return spectralColor;
  }
  return starColorFromBv(0.65);
}

// ── Galactic centre — Sgr A* ─────────────────────────────────────────────────
// The Milky Way background star field uses 8 000 AU/kpc (build-milkyway-stars.mjs).
// The Sun sits at R_SUN = 8.5 kpc from the galactic centre in that model, so
// the visual centre of the galaxy is at heliocentric galactic (8.5, 0, 0) kpc.
// Convert to ecliptic J2000 using the same R_gal_to_ecl matrix as the build script.
// Result: ≈ (−3 732, −67 586, −6 555) AU — the dense core of the MW star field.
const MW_KPC_AU = 8_000;
const _gcx = 8.5 * MW_KPC_AU; // heliocentric galactic X, 68 000 AU
export const SGR_A_STAR_POS: [number, number, number] = [
  -0.054876 * _gcx,   // ≈ -3 732 AU
  -0.993911 * _gcx,   // ≈ -67 586 AU
  -0.096390 * _gcx,   // ≈ -6 555 AU
];

function s(
  name: string, ra: number, dec: number, d: number, tier: number,
): NearbyStarLabel {
  const [x, y, z] = p(ra, dec, d);
  const photometry = NEARBY_STAR_PHOTOMETRY[name];
  const label: NearbyStarLabel = {
    name,
    x,
    y,
    z,
    distPc: d,
    tier,
    color: visualColorForStar(name),
  };
  const radiusSolar = photometry?.radiusSolar ?? stellarRadiusSolarFromPhotometry(
    photometry?.magnitude,
    d,
    photometry?.bv,
    photometry?.spectralType,
  );
  if (photometry?.bv !== undefined) label.bv = photometry.bv;
  if (photometry?.spectralType !== undefined) label.spectralType = photometry.spectralType;
  if (photometry?.magnitude !== undefined) label.magnitude = photometry.magnitude;
  label.radiusSolar = radiusSolar;
  label.radiusAU = stellarRenderRadiusAU(radiusSolar);
  return label;
}

export const NEARBY_STAR_LABELS: NearbyStarLabel[] = [
  // ── Tier 0: nearest neighbourhood (< ~12 pc) ───────────────────────────
  s("Proxima Centauri",  217.429, -62.679,   1.295, 0),
  s("Alpha Centauri",    219.921, -60.835,   1.339, 0),
  s("Barnard's Star",    269.454,   4.693,   1.828, 0),
  s("Wolf 359",          164.120,   7.015,   2.390, 0),
  s("Lalande 21185",     175.284,  35.966,   2.548, 0),
  s("Sirius",            101.287, -16.716,   2.637, 0),
  s("UV Ceti",            24.756, -17.950,   2.680, 0),
  s("Ross 154",          283.812, -23.836,   2.972, 0),
  s("Ross 248",          355.494,  44.178,   3.162, 0),
  s("Epsilon Eridani",    53.233,  -9.458,   3.218, 0),
  s("Lacaille 9352",     346.467, -35.854,   3.291, 0),
  s("Ross 128",          176.929,   0.806,   3.375, 0),
  s("EZ Aquarii",        316.744, -15.292,   3.452, 0),
  s("61 Cygni",          316.728,  38.749,   3.496, 0),
  s("Procyon",           114.828,   5.228,   3.510, 0),
  s("Struve 2398",       288.146,  59.629,   3.524, 0),
  s("Groombridge 34",      2.728,  44.015,   3.565, 0),
  s("Epsilon Indi",      330.840, -56.796,   3.642, 0),
  s("Tau Ceti",           26.017, -15.939,   3.650, 0),
  s("YZ Ceti",            22.706, -16.989,   3.722, 0),
  s("Luyten's Star",     115.541,   5.226,   3.812, 0),
  s("Teegarden's Star",   36.913,   8.444,   3.831, 0),
  s("Kapteyn's Star",     77.861, -45.016,   3.934, 0),
  s("Lacaille 8760",     319.316, -38.866,   3.990, 0),
  s("Kruger 60",         328.758,  57.699,   4.001, 0),
  s("Ross 614",          105.718,  -2.486,   4.110, 0),
  s("Gliese 1",            0.547, -37.364,   4.360, 0),
  s("van Maanen's Star",  21.979,   5.376,   4.363, 0),
  s("Wolf 424",          178.767,   9.040,   4.386, 0),
  s("TZ Arietis",         35.088,  16.537,   4.449, 0),
  s("GJ 687",            269.698,  68.347,   4.534, 0),
  s("GJ 674",            263.319, -46.884,   4.546, 0),
  s("Gliese 380",        148.760,  21.270,   4.870, 0),
  s("GJ 1002",             2.700,  -7.900,   4.860, 0),
  s("40 Eridani",         63.817,  -7.655,   4.983, 0),
  s("EV Lacertae",       349.025,  44.334,   5.047, 0),
  s("Altair",            297.696,   8.868,   5.130, 0),
  s("70 Ophiuchi",       261.910,   2.500,   5.090, 0),
  s("Gliese 229",         92.640, -21.870,   5.770, 0),
  s("Sigma Draconis",    234.025,  69.661,   5.770, 0),
  s("36 Ophiuchi",       261.560, -26.600,   5.970, 0),
  s("Eta Cassiopeiae",    12.276,  57.815,   5.930, 0),
  s("82 Eridani",         50.520, -43.070,   6.060, 0),
  s("Delta Pavonis",     304.740, -66.180,   6.110, 0),
  s("Beta Hydri",         16.920, -77.255,   7.470, 0),
  s("Gliese 570",        228.680, -21.370,   5.890, 0),
  s("GJ 832",            324.730, -49.010,   4.964, 0),
  s("Fomalhaut",         344.413, -29.622,   7.690, 0),
  s("Vega",              279.235,  38.784,   7.681, 0),
  s("Gliese 667",        259.748, -34.993,   6.840, 0),

  // ── Tier 1: 10–50 pc neighbourhood ──────────────────────────────────────
  s("Pollux",            116.329,  28.026,  10.340, 1),
  s("Arcturus",          213.915,  19.182,  11.260, 1),
  s("Capella",            79.172,  45.998,  13.160, 1),
  s("Alpha Lupi",        220.480, -47.380, 114.000, 2),  // HIP 71860; actual ~114 pc (was wrongly entered as 14)
  s("Castor",            113.649,  31.888,  15.600, 1),
  s("Gemma (Alphecca)",  233.672,  26.715,  22.700, 1),
  s("Mizar",             200.981,  54.925,  23.000, 1),
  s("Aldebaran",          68.980,  16.509,  20.000, 1),
  s("Algol",              47.042,  40.957,  28.200, 1),
  s("Gacrux",            187.791, -57.113,  27.200, 1),
  s("Regulus",           152.093,  11.967,  24.300, 1),
  s("Shaula",            263.402, -37.104,  216.00, 2), // moved to tier 2
  // Castor B removed — duplicate position of Castor A; both are the same binary.
  s("Izar",              221.247,  27.074,  64.100, 2), // moved to tier 2
  s("Denebola",          177.265,  14.572,  11.000, 1),
  s("Wezen",             107.098, -26.393, 490.000, 3),
  s("Mirfak",             51.081,  49.861, 181.000, 2),

  // ── Tier 2: 50–400 pc — Milky Way arm landmarks ─────────────────────────
  s("Achernar",           24.429, -57.237,  43.800, 1),
  s("Spica",             201.298, -11.162,  77.300, 2),
  s("Acrux",             186.650, -63.099,  99.000, 2),
  s("Hadar",             210.956, -60.373, 161.000, 2),
  s("Antares",           247.352, -26.432, 170.000, 2),
  s("Canopus",            95.988, -52.696,  95.900, 2),
  s("Bellatrix",          81.283,   6.350,  82.900, 2),
  s("Alnilam",            84.053,  -1.202, 410.000, 3),
  s("Betelgeuse",         88.793,   7.407, 197.000, 2),
  s("Alnitak",            85.190,  -1.943, 387.000, 3),
  s("Mintaka",            83.002,  -0.300, 380.000, 3),

  // ── Tier 3: 400+ pc — deep landmarks ────────────────────────────────────
  s("Rigel",              78.634,  -8.202, 265.000, 2), // famous, show earlier
  s("Deneb",             310.358,  45.280, 802.000, 3),
  s("Naos",              120.896, -40.003, 429.000, 3),
  s("Eta Carinae",       161.265, -59.685, 2300.00, 3),
  s("VY Canis Majoris",  110.740, -25.768, 1170.00, 3),
  s("Mira",               34.836,  -2.978, 273.000, 2),
  s("Saiph",              86.939,  -9.670, 222.000, 2),
  s("Adhara",            104.656, -28.972, 132.000, 2),
];

// Sort within each tier by distance (build order above is already roughly sorted,
// but make it canonical so the "farthest star in tier" check is reliable).
NEARBY_STAR_LABELS.sort((a, b) => {
  if (a.tier !== b.tier) return a.tier - b.tier;
  return a.distPc - b.distPc;
});

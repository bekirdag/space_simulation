type Vec3 = [number, number, number];
type Polynomial3 = readonly [number, number, number];

export interface BodyRotationElements {
  readonly bodyId: number;
  readonly source: string;
  readonly poleRaDeg: Polynomial3;
  readonly poleDecDeg: Polynomial3;
  readonly primeMeridianDeg: Polynomial3;
}

export interface BodyRotationBasis {
  readonly right: Vec3;
  readonly up: Vec3;
  readonly axis: Vec3;
  readonly primeMeridianDeg: number;
  readonly source: string;
}

const DEG = Math.PI / 180;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const DAY_MS = 86_400_000;
const DAYS_PER_CENTURY = 36_525;
const J2000_OBLIQUITY = 23.439291111 * DEG;
const SOURCE = "NAIF/JPL generic PCK pck00011.tpc";

/**
 * IAU/NAIF rotational elements for the bodies currently simulated.
 *
 * The polynomial terms are taken from cache/nasa/pck00011.tpc. Per NAIF PCK,
 * RA/Dec use Julian centuries past J2000 and W uses days past J2000.
 * Trigonometric nutation/precession terms are intentionally omitted for this
 * render path; the resulting pole/prime-meridian orientation is stable and
 * visually correct at the scale/resolution of the app.
 */
export const BODY_ROTATION_ELEMENTS = new Map<string, BodyRotationElements>([
  ["Sun",      { bodyId: 10,      source: SOURCE, poleRaDeg: [286.13, 0, 0],       poleDecDeg: [63.87, 0, 0],       primeMeridianDeg: [84.176, 14.1844, 0] }],
  ["Mercury",  { bodyId: 199,     source: SOURCE, poleRaDeg: [281.0103, -0.0328, 0], poleDecDeg: [61.4155, -0.0049, 0], primeMeridianDeg: [329.5988, 6.1385108, 0] }],
  ["Venus",    { bodyId: 299,     source: SOURCE, poleRaDeg: [272.76, 0, 0],       poleDecDeg: [67.16, 0, 0],       primeMeridianDeg: [160.2, -1.4813688, 0] }],
  ["Earth",    { bodyId: 399,     source: SOURCE, poleRaDeg: [0, -0.641, 0],       poleDecDeg: [90, -0.557, 0],     primeMeridianDeg: [190.147, 360.9856235, 0] }],
  ["Moon",     { bodyId: 301,     source: SOURCE, poleRaDeg: [269.9949, 0.0031, 0], poleDecDeg: [66.5392, 0.013, 0], primeMeridianDeg: [38.3213, 13.17635815, -1.4e-12] }],
  ["Mars",     { bodyId: 499,     source: SOURCE, poleRaDeg: [317.269202, -0.10927547, 0], poleDecDeg: [54.432516, -0.05827105, 0], primeMeridianDeg: [176.049863, 350.891982443297, 0] }],

  ["Jupiter",  { bodyId: 599,     source: SOURCE, poleRaDeg: [268.056595, -0.006499, 0], poleDecDeg: [64.495303, 0.002413, 0], primeMeridianDeg: [284.95, 870.536, 0] }],
  ["Io",       { bodyId: 501,     source: SOURCE, poleRaDeg: [268.05, -0.009, 0],  poleDecDeg: [64.5, 0.003, 0],    primeMeridianDeg: [200.39, 203.4889538, 0] }],
  ["Europa",   { bodyId: 502,     source: SOURCE, poleRaDeg: [268.08, -0.009, 0],  poleDecDeg: [64.51, 0.003, 0],   primeMeridianDeg: [36.022, 101.3747235, 0] }],
  ["Ganymede", { bodyId: 503,     source: SOURCE, poleRaDeg: [268.2, -0.009, 0],   poleDecDeg: [64.57, 0.003, 0],   primeMeridianDeg: [44.064, 50.3176081, 0] }],
  ["Callisto", { bodyId: 504,     source: SOURCE, poleRaDeg: [268.72, -0.009, 0],  poleDecDeg: [64.83, 0.003, 0],   primeMeridianDeg: [259.51, 21.5710715, 0] }],

  ["Saturn",   { bodyId: 699,     source: SOURCE, poleRaDeg: [40.589, -0.036, 0],  poleDecDeg: [83.537, -0.004, 0], primeMeridianDeg: [38.9, 810.7939024, 0] }],
  ["Mimas",    { bodyId: 601,     source: SOURCE, poleRaDeg: [40.66, -0.036, 0],   poleDecDeg: [83.52, -0.004, 0],  primeMeridianDeg: [333.46, 381.994555, 0] }],
  ["Enceladus",{ bodyId: 602,     source: SOURCE, poleRaDeg: [40.66, -0.036, 0],   poleDecDeg: [83.52, -0.004, 0],  primeMeridianDeg: [6.32, 262.7318996, 0] }],
  ["Tethys",   { bodyId: 603,     source: SOURCE, poleRaDeg: [40.66, -0.036, 0],   poleDecDeg: [83.52, -0.004, 0],  primeMeridianDeg: [8.95, 190.6979085, 0] }],
  ["Dione",    { bodyId: 604,     source: SOURCE, poleRaDeg: [40.66, -0.036, 0],   poleDecDeg: [83.52, -0.004, 0],  primeMeridianDeg: [357.6, 131.5349316, 0] }],
  ["Rhea",     { bodyId: 605,     source: SOURCE, poleRaDeg: [40.38, -0.036, 0],   poleDecDeg: [83.55, -0.004, 0],  primeMeridianDeg: [235.16, 79.6900478, 0] }],
  ["Titan",    { bodyId: 606,     source: SOURCE, poleRaDeg: [39.4827, 0, 0],      poleDecDeg: [83.4279, 0, 0],     primeMeridianDeg: [186.5855, 22.5769768, 0] }],
  ["Iapetus",  { bodyId: 608,     source: SOURCE, poleRaDeg: [318.16, -3.949, 0],  poleDecDeg: [75.03, -1.143, 0],  primeMeridianDeg: [355.2, 4.5379572, 0] }],

  ["Uranus",   { bodyId: 799,     source: SOURCE, poleRaDeg: [257.311, 0, 0],      poleDecDeg: [-15.175, 0, 0],     primeMeridianDeg: [203.81, -501.1600928, 0] }],
  ["Ariel",    { bodyId: 701,     source: SOURCE, poleRaDeg: [257.43, 0, 0],       poleDecDeg: [-15.1, 0, 0],       primeMeridianDeg: [156.22, -142.8356681, 0] }],
  ["Umbriel",  { bodyId: 702,     source: SOURCE, poleRaDeg: [257.43, 0, 0],       poleDecDeg: [-15.1, 0, 0],       primeMeridianDeg: [108.05, -86.8688923, 0] }],
  ["Titania",  { bodyId: 703,     source: SOURCE, poleRaDeg: [257.43, 0, 0],       poleDecDeg: [-15.1, 0, 0],       primeMeridianDeg: [77.74, -41.3514316, 0] }],
  ["Oberon",   { bodyId: 704,     source: SOURCE, poleRaDeg: [257.43, 0, 0],       poleDecDeg: [-15.1, 0, 0],       primeMeridianDeg: [6.77, -26.7394932, 0] }],
  ["Miranda",  { bodyId: 705,     source: SOURCE, poleRaDeg: [257.43, 0, 0],       poleDecDeg: [-15.08, 0, 0],      primeMeridianDeg: [30.7, -254.6906892, 0] }],

  ["Neptune",  { bodyId: 899,     source: SOURCE, poleRaDeg: [299.36, 0, 0],       poleDecDeg: [43.46, 0, 0],       primeMeridianDeg: [249.978, 541.1397757, 0] }],
  ["Triton",   { bodyId: 801,     source: SOURCE, poleRaDeg: [299.36, 0, 0],       poleDecDeg: [41.17, 0, 0],       primeMeridianDeg: [296.53, -61.2572637, 0] }],

  ["Pluto",    { bodyId: 999,     source: SOURCE, poleRaDeg: [132.993, 0, 0],      poleDecDeg: [-6.163, 0, 0],      primeMeridianDeg: [302.695, 56.3625225, 0] }],
  ["Charon",   { bodyId: 901,     source: SOURCE, poleRaDeg: [132.993, 0, 0],      poleDecDeg: [-6.163, 0, 0],      primeMeridianDeg: [122.695, 56.3625225, 0] }],
  ["Ceres",    { bodyId: 2000001, source: SOURCE, poleRaDeg: [291.418, 0, 0],      poleDecDeg: [66.764, 0, 0],      primeMeridianDeg: [170.65, 952.1532, 0] }],
]);

export const IDENTITY_BODY_ROTATION_BASIS: BodyRotationBasis = {
  right: [1, 0, 0],
  up: [0, 1, 0],
  axis: [0, 0, 1],
  primeMeridianDeg: 0,
  source: "identity fallback",
};

export function bodyRotationBasis(name: string, epochMs: number): BodyRotationBasis | null {
  const elements = BODY_ROTATION_ELEMENTS.get(name);
  if (!elements) return null;

  const days = (epochMs - J2000_MS) / DAY_MS;
  const centuries = days / DAYS_PER_CENTURY;
  const ra = evaluatePolynomial(elements.poleRaDeg, centuries) * DEG;
  const dec = evaluatePolynomial(elements.poleDecDeg, centuries) * DEG;
  const wDeg = evaluatePolynomial(elements.primeMeridianDeg, days);
  const w = normalizeDegrees(wDeg) * DEG;

  // NAIF PCK orientation: inertial-to-body = [W]3 [PI/2-Dec]1 [PI/2+RA]3.
  const inertialToBody = multiply3(
    multiply3(rotation3(w), rotation1(Math.PI / 2 - dec)),
    rotation3(Math.PI / 2 + ra),
  );
  const bodyToIcrf = transpose3(inertialToBody);

  return {
    right: normalizeVec3(icrfToEcliptic(column3(bodyToIcrf, 0))),
    up: normalizeVec3(icrfToEcliptic(column3(bodyToIcrf, 1))),
    axis: normalizeVec3(icrfToEcliptic(column3(bodyToIcrf, 2))),
    primeMeridianDeg: normalizeDegrees(wDeg),
    source: elements.source,
  };
}

function evaluatePolynomial(coeffs: Polynomial3, x: number): number {
  return coeffs[0] + coeffs[1] * x + coeffs[2] * x * x;
}

function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

function rotation1(rad: number): number[][] {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    [1, 0, 0],
    [0, c, s],
    [0, -s, c],
  ];
}

function rotation3(rad: number): number[][] {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [
    [c, s, 0],
    [-s, c, 0],
    [0, 0, 1],
  ];
}

function multiply3(a: number[][], b: number[][]): number[][] {
  return [
    [
      a[0]![0]! * b[0]![0]! + a[0]![1]! * b[1]![0]! + a[0]![2]! * b[2]![0]!,
      a[0]![0]! * b[0]![1]! + a[0]![1]! * b[1]![1]! + a[0]![2]! * b[2]![1]!,
      a[0]![0]! * b[0]![2]! + a[0]![1]! * b[1]![2]! + a[0]![2]! * b[2]![2]!,
    ],
    [
      a[1]![0]! * b[0]![0]! + a[1]![1]! * b[1]![0]! + a[1]![2]! * b[2]![0]!,
      a[1]![0]! * b[0]![1]! + a[1]![1]! * b[1]![1]! + a[1]![2]! * b[2]![1]!,
      a[1]![0]! * b[0]![2]! + a[1]![1]! * b[1]![2]! + a[1]![2]! * b[2]![2]!,
    ],
    [
      a[2]![0]! * b[0]![0]! + a[2]![1]! * b[1]![0]! + a[2]![2]! * b[2]![0]!,
      a[2]![0]! * b[0]![1]! + a[2]![1]! * b[1]![1]! + a[2]![2]! * b[2]![1]!,
      a[2]![0]! * b[0]![2]! + a[2]![1]! * b[1]![2]! + a[2]![2]! * b[2]![2]!,
    ],
  ];
}

function transpose3(m: number[][]): number[][] {
  return [
    [m[0]![0]!, m[1]![0]!, m[2]![0]!],
    [m[0]![1]!, m[1]![1]!, m[2]![1]!],
    [m[0]![2]!, m[1]![2]!, m[2]![2]!],
  ];
}

function column3(m: number[][], index: number): Vec3 {
  return [m[0]![index]!, m[1]![index]!, m[2]![index]!];
}

function icrfToEcliptic(v: Vec3): Vec3 {
  const c = Math.cos(J2000_OBLIQUITY);
  const s = Math.sin(J2000_OBLIQUITY);
  return [
    v[0],
    v[1] * c + v[2] * s,
    -v[1] * s + v[2] * c,
  ];
}

function normalizeVec3(v: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len <= 1e-12) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

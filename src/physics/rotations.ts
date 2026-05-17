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

interface BodyRotationNutation {
  readonly angleBodyId: number;
  readonly raSinDeg?: readonly number[];
  readonly decCosDeg?: readonly number[];
  readonly pmSinDeg?: readonly number[];
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
 * The terms are taken from cache/nasa/pck00011.tpc. Per NAIF PCK, RA/Dec use
 * Julian centuries past J2000 and W uses days past J2000. Periodic terms are
 * applied below using the PCK convention: RA/W add sine terms, Dec adds cosine
 * terms, and nutation/precession angles are evaluated in Julian centuries.
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

const BODY_NUTATION_ANGLES = new Map<number, readonly Polynomial3[]>([
  [1, [
    [174.7910857, 149472.53587500003, 0], [349.5821714, 298945.07175000006, 0],
    [164.3732571, 448417.60762500006, 0], [339.1643429, 597890.1435000001, 0],
    [153.9554286, 747362.679375, 0],
  ]],
  [3, [
    [125.045, -1935.5364525, 0], [250.089, -3871.072905, 0], [260.008, 475263.3328725, 0],
    [176.625, 487269.629985, 0], [357.529, 35999.0509575, 0], [311.589, 964468.49931, 0],
    [134.963, 477198.869325, 0], [276.617, 12006.300765, 0], [34.226, 63863.5132425, 0],
    [15.134, -5806.6093575, 0], [119.743, 131.84064, 0], [239.961, 6003.1503825, 0],
    [25.053, 473327.79642, 0],
  ]],
  [4, [
    [190.72646643, 15917.10818695, 0], [21.4689247, 31834.27934054, 0],
    [332.86082793, 19139.89694742, 0], [394.93256437, 38280.79631835, 0],
    [189.6327156, 41215158.1842005, 12.711923222], [121.46893664, 660.22803474, 0],
    [231.05028581, 660.9912354, 0], [251.37314025, 1320.50145245, 0],
    [217.98635955, 38279.9612555, 0], [196.19729402, 19139.83628608, 0],
    [198.991226, 19139.4819985, 0], [226.292679, 38280.8511281, 0],
    [249.663391, 57420.7251593, 0], [266.18351, 76560.636795, 0],
    [79.398797, 0.5042615, 0], [122.433576, 19139.9407476, 0],
    [43.058401, 38280.8753272, 0], [57.663379, 57420.7517205, 0],
    [79.476401, 76560.6495004, 0], [166.325722, 0.5042615, 0],
    [129.071773, 19140.0328244, 0], [36.352167, 38281.0473591, 0],
    [56.668646, 57420.929536, 0], [67.364003, 76560.2552215, 0],
    [104.79268, 95700.4387578, 0], [95.391654, 0.5042615, 0],
  ]],
  [5, [
    [73.32, 91472.9, 0], [24.62, 45137.2, 0], [283.9, 4850.7, 0],
    [355.8, 1191.3, 0], [119.9, 262.1, 0], [229.8, 64.3, 0],
    [352.25, 2382.6, 0], [113.35, 6070, 0], [146.64, 182945.8, 0],
    [49.24, 90274.4, 0], [99.360714, 4850.4046, 0], [175.895369, 1191.9605, 0],
    [300.323162, 262.5475, 0], [114.012305, 6070.2476, 0], [49.511251, 64.3, 0],
  ]],
  [6, [
    [353.32, 75706.7, 0], [28.72, 75706.7, 0], [177.4, -36505.5, 0],
    [300, -7225.9, 0], [316.45, 506.2, 0], [345.2, -1016.3, 0],
    [706.64, 151413.4, 0], [57.44, 151413.4, 0],
  ]],
  [7, [
    [115.75, 54991.87, 0], [141.69, 41887.66, 0], [135.03, 29927.35, 0],
    [61.77, 25733.59, 0], [249.32, 24471.46, 0], [43.86, 22278.41, 0],
    [77.66, 20289.42, 0], [157.36, 16652.76, 0], [101.81, 12872.63, 0],
    [138.64, 8061.81, 0], [102.23, -2024.22, 0], [316.41, 2863.96, 0],
    [304.01, -51.94, 0], [308.71, -93.17, 0], [340.82, -75.32, 0],
    [259.14, -504.81, 0], [204.46, -4048.44, 0], [632.82, 5727.92, 0],
  ]],
  [8, [
    [357.85, 52.316, 0], [323.92, 62606.6, 0], [220.51, 55064.2, 0],
    [354.27, 46564.5, 0], [75.31, 26109.4, 0], [35.36, 14325.4, 0],
    [142.61, 2824.6, 0], [177.85, 52.316, 0], [647.84, 125213.2, 0],
    [355.7, 104.632, 0], [533.55, 156.948, 0], [711.4, 209.264, 0],
    [889.25, 261.58, 0], [1067.1, 313.896, 0], [1244.95, 366.212, 0],
    [1422.8, 418.528, 0], [1600.65, 470.844, 0],
  ]],
]);

const BODY_ROTATION_NUTATION = new Map<string, BodyRotationNutation>([
  ["Mercury", { angleBodyId: 1, pmSinDeg: [0.01067257, -0.00112309, -0.0001104, -0.00002539, -0.00000571] }],
  ["Moon", {
    angleBodyId: 3,
    raSinDeg: [-3.8787, -0.1204, 0.07, -0.0172, 0, 0.0072, 0, 0, 0, -0.0052, 0, 0, 0.0043],
    decCosDeg: [1.5419, 0.0239, -0.0278, 0.0068, 0, -0.0029, 0.0009, 0, 0, 0.0008, 0, 0, -0.0009],
    pmSinDeg: [3.561, 0.1208, -0.0642, 0.0158, 0.0252, -0.0066, -0.0047, -0.0046, 0.0028, 0.0052, 0.004, 0.0019, -0.0044],
  }],
  ["Mars", {
    angleBodyId: 4,
    raSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.000068, 0.000238, 0.000052, 0.000009, 0.419057],
    decCosDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.000051, 0.000141, 0.000031, 0.000005, 1.591274],
    pmSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.000145, 0.000157, 0.00004, 0.000001, 0.000001, 0.584542],
  }],
  ["Jupiter", {
    angleBodyId: 5,
    raSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.000117, 0.000938, 0.001432, 0.00003, 0.00215],
    decCosDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.00005, 0.000404, 0.000617, -0.000013, 0.000926],
  }],
  ["Io", { angleBodyId: 5, raSinDeg: [0, 0, 0.094, 0.024], decCosDeg: [0, 0, 0.04, 0.011], pmSinDeg: [0, 0, -0.085, -0.022] }],
  ["Europa", { angleBodyId: 5, raSinDeg: [0, 0, 0, 1.086, 0.06, 0.015, 0.009], decCosDeg: [0, 0, 0, 0.468, 0.026, 0.007, 0.002], pmSinDeg: [0, 0, 0, -0.98, -0.054, -0.014, -0.008] }],
  ["Ganymede", { angleBodyId: 5, raSinDeg: [0, 0, 0, -0.037, 0.431, 0.091], decCosDeg: [0, 0, 0, -0.016, 0.186, 0.039], pmSinDeg: [0, 0, 0, 0.033, -0.389, -0.082] }],
  ["Callisto", { angleBodyId: 5, raSinDeg: [0, 0, 0, 0, -0.068, 0.59, 0, 0.01], decCosDeg: [0, 0, 0, 0, -0.029, 0.254, 0, -0.004], pmSinDeg: [0, 0, 0, 0, 0.061, -0.533, 0, -0.009] }],
  ["Mimas", { angleBodyId: 6, raSinDeg: [0, 0, 13.56, 0, 0, 0, 0, 0], decCosDeg: [0, 0, -1.53, 0, 0, 0, 0, 0], pmSinDeg: [0, 0, -13.48, 0, -44.85, 0, 0, 0] }],
  ["Tethys", { angleBodyId: 6, raSinDeg: [0, 0, 0, 9.66, 0, 0, 0, 0], decCosDeg: [0, 0, 0, -1.09, 0, 0, 0, 0], pmSinDeg: [0, 0, 0, -9.6, 2.23, 0, 0, 0] }],
  ["Rhea", { angleBodyId: 6, raSinDeg: [0, 0, 0, 0, 0, 3.1, 0, 0], decCosDeg: [0, 0, 0, 0, 0, -0.35, 0, 0], pmSinDeg: [0, 0, 0, 0, 0, -3.08, 0, 0] }],
  ["Ariel", { angleBodyId: 7, raSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.29], decCosDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.28], pmSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.05, 0.08] }],
  ["Umbriel", { angleBodyId: 7, raSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.21], decCosDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2], pmSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -0.09, 0, 0.06] }],
  ["Titania", { angleBodyId: 7, raSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.29], decCosDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.28], pmSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.08] }],
  ["Oberon", { angleBodyId: 7, raSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.16], decCosDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.16], pmSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.04] }],
  ["Miranda", { angleBodyId: 7, raSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4.41, 0, 0, 0, 0, 0, -0.04, 0], decCosDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4.25, 0, 0, 0, 0, 0, -0.02, 0], pmSinDeg: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1.15, -1.27, 0, 0, 0, 0, -0.09, 0.15] }],
  ["Neptune", { angleBodyId: 8, raSinDeg: [0.7], decCosDeg: [-0.51], pmSinDeg: [-0.48] }],
  ["Triton", {
    angleBodyId: 8,
    raSinDeg: [0, 0, 0, 0, 0, 0, 0, -32.35, 0, -6.28, -2.08, -0.74, -0.28, -0.11, -0.07, -0.02, -0.01],
    decCosDeg: [0, 0, 0, 0, 0, 0, 0, 22.55, 0, 2.1, 0.55, 0.16, 0.05, 0.02, 0.01, 0, 0],
    pmSinDeg: [0, 0, 0, 0, 0, 0, 0, 22.25, 0, 6.73, 2.05, 0.74, 0.28, 0.11, 0.05, 0.02, 0.01],
  }],
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
  let raDeg = evaluatePolynomial(elements.poleRaDeg, centuries);
  let decDeg = evaluatePolynomial(elements.poleDecDeg, centuries);
  let wDeg = evaluatePolynomial(elements.primeMeridianDeg, days);
  const nutation = BODY_ROTATION_NUTATION.get(name);
  const angles = nutation ? BODY_NUTATION_ANGLES.get(nutation.angleBodyId) : undefined;
  if (nutation && angles) {
    raDeg += evaluatePeriodicTerms(nutation.raSinDeg, angles, centuries, "sin");
    decDeg += evaluatePeriodicTerms(nutation.decCosDeg, angles, centuries, "cos");
    wDeg += evaluatePeriodicTerms(nutation.pmSinDeg, angles, centuries, "sin");
  }
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
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

function evaluatePeriodicTerms(
  coeffs: readonly number[] | undefined,
  anglePolys: readonly Polynomial3[],
  centuries: number,
  mode: "sin" | "cos",
): number {
  if (!coeffs) return 0;
  let sum = 0;
  const count = Math.min(coeffs.length, anglePolys.length);
  for (let i = 0; i < count; i++) {
    const coefficient = coeffs[i] ?? 0;
    if (coefficient === 0) continue;
    const angle = evaluatePolynomial(anglePolys[i]!, centuries) * DEG;
    sum += coefficient * (mode === "sin" ? Math.sin(angle) : Math.cos(angle));
  }
  return sum;
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

// Procedural Milky Way volumetric dust layer.
//
// The renderer builds a cached 3D density/color texture on the GPU, then
// raymarches it through the galactic disk. This keeps the dust visual only while
// avoiding thousands of per-frame mesh instances.

export const DUST_VOLUME_SIZE = 80;
export const DUST_VOLUME_RADIUS_KPC = 16.5;
export const DUST_VOLUME_HALF_HEIGHT_KPC = 1.6;
export const DUST_MILKY_WAY_KPC_TO_AU = 8_000;
export const DUST_SUN_GALACTIC_RADIUS_KPC = 8.5;

export const DUST_VOLUME_RADIUS_AU = DUST_VOLUME_RADIUS_KPC * DUST_MILKY_WAY_KPC_TO_AU;
export const DUST_VOLUME_HALF_HEIGHT_AU = DUST_VOLUME_HALF_HEIGHT_KPC * DUST_MILKY_WAY_KPC_TO_AU;

// Same galactic -> ecliptic J2000 rotation used by build-milkyway-stars.mjs.
const GAL_TO_ECL = [
  [-0.054876,  0.494109, -0.867666],
  [-0.993911, -0.111106, -0.000312],
  [-0.096390,  0.862326,  0.497159],
] as const;

function galacticCartesianToEclipticAU(
  xgc: number,
  ygc: number,
  zgc: number,
): [number, number, number] {
  // Galactocentric kpc -> heliocentric galactic kpc. The Sun sits at
  // (-8.5, 0, 0), so the Galactic center is 8.5 kpc toward +X.
  const xh = xgc + DUST_SUN_GALACTIC_RADIUS_KPC;
  const yh = ygc;
  const zh = zgc;
  return [
    (GAL_TO_ECL[0][0] * xh + GAL_TO_ECL[0][1] * yh + GAL_TO_ECL[0][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
    (GAL_TO_ECL[1][0] * xh + GAL_TO_ECL[1][1] * yh + GAL_TO_ECL[1][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
    (GAL_TO_ECL[2][0] * xh + GAL_TO_ECL[2][1] * yh + GAL_TO_ECL[2][2] * zh) * DUST_MILKY_WAY_KPC_TO_AU,
  ];
}

export const DUST_VOLUME_CENTER_AU = galacticCartesianToEclipticAU(0, 0, 0);

export const DUST_VOLUME_SOURCE =
  `${DUST_VOLUME_SIZE}^3 cached WebGPU density texture with spiral-arm FBM/Worley dust`;

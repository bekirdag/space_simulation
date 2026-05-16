// Visual Galactic dust map layer.
//
// The checked-in binary is a compact high-resolution visual product derived
// from the NASA/GSFC LAMBDA Meisner & Finkbeiner 2015 E(B-V) all-sky dust map.
// Positions encode a world-anchored Galactic shell using the same 8,000 AU/kpc
// Milky Way scale as the background star field. Galactic l=0,b=0 lands on the
// simulation's Sagittarius A* / Milky Way center direction. It is visual only:
// no body physics, extinction math, or star photometry is changed here.

export const DUST_FLOATS = 8;
export const DUST_MILKY_WAY_KPC_TO_AU = 8_000;
export const DUST_SUN_GALACTIC_RADIUS_KPC = 8.5;
export const DUST_SHELL_RADIUS_AU = DUST_MILKY_WAY_KPC_TO_AU * DUST_SUN_GALACTIC_RADIUS_KPC;

const DUST_DATA_URL = "/data/dust-map-mf2015.bin";
const DUST_META_URL = "/data/dust-map-mf2015.meta.json";

// Same galactic -> ecliptic J2000 rotation used by build-milkyway-stars.mjs.
const GAL_TO_ECL = [
  [-0.054876,  0.494109, -0.867666],
  [-0.993911, -0.111106, -0.000312],
  [-0.096390,  0.862326,  0.497159],
] as const;

export interface DustMapBuffer {
  data:   Float32Array;
  source: string;
}

export function galacticDirectionToEcliptic(
  lonRad: number,
  latRad: number,
  radiusAU = DUST_SHELL_RADIUS_AU,
): [number, number, number] {
  const cb = Math.cos(latRad);
  const xg = cb * Math.cos(lonRad);
  const yg = cb * Math.sin(lonRad);
  const zg = Math.sin(latRad);
  return [
    (GAL_TO_ECL[0][0] * xg + GAL_TO_ECL[0][1] * yg + GAL_TO_ECL[0][2] * zg) * radiusAU,
    (GAL_TO_ECL[1][0] * xg + GAL_TO_ECL[1][1] * yg + GAL_TO_ECL[1][2] * zg) * radiusAU,
    (GAL_TO_ECL[2][0] * xg + GAL_TO_ECL[2][1] * yg + GAL_TO_ECL[2][2] * zg) * radiusAU,
  ];
}

export async function loadDustMap(): Promise<DustMapBuffer> {
  const res = await fetch(DUST_DATA_URL);
  if (res.ok) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength % (DUST_FLOATS * 4) !== 0) {
      throw new Error(`Dust map buffer has invalid byte length: ${buf.byteLength}`);
    }

    let source = "dust-map-mf2015.bin";
    try {
      const metaRes = await fetch(DUST_META_URL);
      if (metaRes.ok) {
        const meta = await metaRes.json() as { sourceName?: string };
        source = meta.sourceName ?? source;
      }
    } catch {
      // Metadata is informative only; the binary is enough to render.
    }

    return { data: new Float32Array(buf), source };
  }

  console.warn(`Dust map ${DUST_DATA_URL} unavailable (${res.status}); using procedural fallback.`);
  return { data: createFallbackDustMap(), source: "procedural fallback dust band" };
}

function createFallbackDustMap(): Float32Array {
  // Distribute dust at MULTIPLE distances along each line of sight so it
  // fills the galactic disk volumetrically instead of forming a single ring.
  // Radii are in the MW star scale (8 000 AU/kpc): 1 kpc → 8 000 AU.
  // Dust is denser in the inner disk and drops off exponentially outward.
  const KPC_TO_AU = 8_000;
  const lonSteps  = 120;
  const latSteps  = 32;
  // Distance shells: 0.5, 1, 2, 3.5, 6, 10 kpc from Sun
  const shells: { kpc: number; weight: number }[] = [
    { kpc: 0.5,  weight: 0.55 },
    { kpc: 1.0,  weight: 0.80 },
    { kpc: 2.0,  weight: 1.00 },
    { kpc: 3.5,  weight: 0.85 },
    { kpc: 6.0,  weight: 0.65 },
    { kpc: 10.0, weight: 0.40 },
  ];

  const cells: number[] = [];

  for (const { kpc, weight } of shells) {
    const radius   = kpc * KPC_TO_AU;
    const baseSize = radius * (Math.PI / lonSteps) * 2.4;

    for (let j = 0; j < latSteps; j++) {
      const t   = (j + 0.5) / latSteps;
      const lat = (t - 0.5) * Math.PI;
      // Disk scale height shrinks with distance (outer disk is thinner)
      const hz    = 0.12 + 0.04 * (kpc / 10);
      const plane = Math.exp(-Math.pow(lat / hz, 2)) * weight;
      if (plane < 0.03) continue;

      for (let i = 0; i < lonSteps; i++) {
        const lon = ((i + 0.5) / lonSteps) * Math.PI * 2;
        // Spiral arm modulation + inner bulge concentration
        const arm = 0.50
          + 0.28 * Math.sin(lon * 2.0 + Math.sin(lon * 3.0))
          + 0.22 * Math.sin(lon * 5.0 + lat * 9.0);
        const density = Math.max(0, Math.min(1, plane * arm));
        if (density < 0.06) continue;

        const [x, y, z] = galacticDirectionToEcliptic(lon, lat, radius);
        // Alpha is lower for distant shells (more diffuse) and higher nearby
        const alpha = (0.008 + density * 0.055) * (1.0 - kpc / 14);
        cells.push(
          x, y, z, baseSize * (0.7 + density * 0.8),
          0.62 + density * 0.18,
          0.30 + density * 0.12,
          0.12 + density * 0.06,
          alpha,
        );
      }
    }
  }

  return new Float32Array(cells);
}

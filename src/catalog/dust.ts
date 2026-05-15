// Visual Galactic dust map layer.
//
// The checked-in binary is a reduced visual product derived from the NASA/GSFC
// LAMBDA Meisner & Finkbeiner 2015 E(B-V) all-sky dust map. It is visual only:
// no body physics, extinction math, or star photometry is changed here.

export const DUST_FLOATS = 8;
export const DUST_SHELL_RADIUS_AU = 85_000;

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
  const lonSteps = 160;
  const latSteps = 48;
  const cells: number[] = [];
  const radius = DUST_SHELL_RADIUS_AU;
  const baseSize = radius * (Math.PI / lonSteps) * 2.2;

  for (let j = 0; j < latSteps; j++) {
    const t = (j + 0.5) / latSteps;
    const lat = (t - 0.5) * Math.PI;
    const plane = Math.exp(-Math.pow(lat / 0.16, 2));
    if (plane < 0.025) continue;

    for (let i = 0; i < lonSteps; i++) {
      const lon = ((i + 0.5) / lonSteps) * Math.PI * 2;
      const arm = 0.55
        + 0.25 * Math.sin(lon * 2.0 + Math.sin(lon * 3.0))
        + 0.20 * Math.sin(lon * 5.0 + lat * 9.0);
      const density = Math.max(0, Math.min(1, plane * arm));
      if (density < 0.08) continue;

      const [x, y, z] = galacticDirectionToEcliptic(lon, lat, radius);
      const alpha = 0.010 + density * 0.075;
      cells.push(
        x, y, z, baseSize * (0.8 + density * 0.9),
        0.66 + density * 0.16,
        0.34 + density * 0.10,
        0.16 + density * 0.05,
        alpha,
      );
    }
  }

  return new Float32Array(cells);
}

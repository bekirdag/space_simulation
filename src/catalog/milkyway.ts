// Milky Way background star catalog — 200k stars distributed across the galactic disk.
// Positions use the same 8-float layout as the nearby HYG catalog (star.wgsl),
// at the shared 80 000 AU/kpc scale (scale.ts), so the galaxy spans ~2.6 M AU. The fourth
// float is physical stellar radius in AU, not a screen-size multiplier.
//
// Only rendered when the camera is far from the solar system origin (LOD).

export const MW_FLOATS = 8; // same layout as STAR_FLOATS
export const MW_STAR_COUNT = 200_000;

export interface MilkywayBuffer {
  data:   Float32Array;
  source: string;
}

export async function loadMilkywayStars(): Promise<MilkywayBuffer> {
  const url = `/data/milkyway-stars.bin?v=scale-80au-pc-gc-clear-v3`;
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return { data: new Float32Array(buf), source: "milkyway-stars.bin" };
}

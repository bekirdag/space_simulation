// Milky Way background star catalog — 100k stars distributed across the galactic disk.
// Positions use the same 8-float layout as the nearby HYG catalog (star.wgsl),
// but are scaled at 8 000 AU/kpc so the galaxy spans ~240 000 AU.
//
// Only rendered when the camera is far from the solar system origin (LOD).

export const MW_FLOATS = 8; // same layout as STAR_FLOATS
export const MW_STAR_COUNT = 200_000;

export interface MilkywayBuffer {
  data:   Float32Array;
  source: string;
}

export async function loadMilkywayStars(): Promise<MilkywayBuffer> {
  const url = `/data/milkyway-stars.bin`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  return { data: new Float32Array(buf), source: "milkyway-stars.bin" };
}

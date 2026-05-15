/**
 * Octant sorting for large point catalogs (stars, galaxies).
 *
 * The sky sphere is divided into 8 octants by the signs of (x, y, z).
 * We pre-sort the Float32Array buffer so each octant's instances are
 * contiguous, then use those ranges to spread Settings LOD caps across the sky.
 *
 * Frustum rejection stays in the WGSL instance shaders, where each billboard's
 * projected position is known accurately enough to avoid hard-cutting visible
 * Milky Way or galaxy regions.
 */

export const FLOATS_PER_STAR = 8; // pos(3) + size(1) + color(3) + alpha(1)

export interface OctantRange {
  first: number; // first instance index (not byte offset)
  count: number; // instance count
}

/** Octant index from the signs of x,y,z (0–7). */
function octant(x: number, y: number, z: number): number {
  return (x >= 0 ? 4 : 0) | (y >= 0 ? 2 : 0) | (z >= 0 ? 1 : 0);
}

/**
 * Sort `buffer` in-place so instances within the same octant are contiguous.
 * Returns the 8 OctantRanges (first + count within the reordered buffer).
 */
export function sortIntoOctants(
  buffer: Float32Array,
  floatsPerInstance = FLOATS_PER_STAR,
): OctantRange[] {
  const n = buffer.length / floatsPerInstance;

  // Assign each instance to an octant
  const octants = new Uint8Array(n);
  const counts  = new Int32Array(8);
  for (let i = 0; i < n; i++) {
    const o = i * floatsPerInstance;
    const oct = octant(buffer[o]!, buffer[o + 1]!, buffer[o + 2]!);
    octants[i] = oct;
    counts[oct]!++;
  }

  // Compute destination starts
  const starts = new Int32Array(8);
  let off = 0;
  for (let q = 0; q < 8; q++) { starts[q] = off; off += counts[q]!; }

  // Scatter into a temp buffer
  const tmp    = new Float32Array(buffer.length);
  const cursor = starts.slice(); // copy
  for (let i = 0; i < n; i++) {
    const dst = cursor[octants[i]!]!;
    const srcOff = i   * floatsPerInstance;
    const dstOff = dst * floatsPerInstance;
    tmp.set(buffer.subarray(srcOff, srcOff + floatsPerInstance), dstOff);
    cursor[octants[i]!]!++;
  }
  buffer.set(tmp);

  return Array.from({ length: 8 }, (_, q) => ({
    first: starts[q]!,
    count: counts[q]!,
  }));
}

/**
 * CPU-side octant culling for large point catalogs (stars, galaxies).
 *
 * The sky sphere is divided into 8 octants by the signs of (x, y, z).
 * We pre-sort the Float32Array buffer so that each octant's instances are
 * contiguous.  At render time, 4 corner rays from the camera frustum determine
 * which octants are (conservatively) visible, and we submit only those slices
 * via separate draw calls with the correct firstInstance offset.
 *
 * For a 45° FOV facing an arbitrary direction, typically 2–4 of 8 octants
 * overlap the frustum, reducing vertex invocations by 50–75%.
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

/**
 * Given the 4 frustum corner directions in world space (unit vectors),
 * return a bitmask of the 8 octants that may overlap the frustum.
 *
 * Conservative: an octant is included if any direction inside that octant can
 * fall within the view cone plus a safety margin. This avoids dropping an
 * octant just because its representative corner is outside the frustum while
 * another part of the octant is still visible.
 */
export function visibleOctantMask(
  eye:      [number, number, number],
  forward:  [number, number, number],
  right:    [number, number, number],
  up:       [number, number, number],
  fovH:     number, // horizontal half-FOV in radians
  fovV:     number, // vertical   half-FOV in radians
): number {
  const diagHalfFov = Math.atan(Math.hypot(Math.tan(fovH), Math.tan(fovV)));
  const cullAngle = Math.min(Math.PI * 0.5, diagHalfFov + Math.PI / 10);
  const threshold = Math.cos(cullAngle);

  let mask = 0;
  for (let q = 0; q < 8; q++) {
    const sx = (q & 4) ? 1 : -1;
    const sy = (q & 2) ? 1 : -1;
    const sz = (q & 1) ? 1 : -1;

    const ax = Math.max(0, sx * forward[0]);
    const ay = Math.max(0, sy * forward[1]);
    const az = Math.max(0, sz * forward[2]);
    const maxDot = Math.hypot(ax, ay, az);
    if (maxDot >= threshold) mask |= (1 << q);
  }
  return mask || 0xff;
}

/** Octant indices whose bit is set in mask. */
export function visibleOctants(mask: number): number[] {
  const result: number[] = [];
  for (let q = 0; q < 8; q++) if (mask & (1 << q)) result.push(q);
  return result;
}

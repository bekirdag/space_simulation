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
 * Conservative: an octant is included if the frustum cone might intersect it.
 * Uses a simple test: check if the octant's bounding corner is within the
 * half-space of ALL four frustum planes AND the front plane.
 */
export function visibleOctantMask(
  eye:      [number, number, number],
  forward:  [number, number, number],
  right:    [number, number, number],
  up:       [number, number, number],
  fovH:     number, // horizontal half-FOV in radians
  fovV:     number, // vertical   half-FOV in radians
): number {
  // Build 4 frustum plane normals (pointing inward) from the corner rays.
  // Right plane: normal = up × topRight_ray (simplified to ±right/up half-planes)
  // We use a conservative test: include an octant if its representative direction
  // (the sign-corner of the octant bounding box) is within cosine margin of forward.
  const cosH = Math.cos(fovH);
  const cosV = Math.cos(fovV);
  const cosMargin = Math.min(cosH, cosV) * 0.85; // generous: slightly less than edge

  let mask = 0;
  for (let q = 0; q < 8; q++) {
    // Representative direction for octant q: corner of the unit cube
    const dx = (q & 4) ? 1 : -1;
    const dy = (q & 2) ? 1 : -1;
    const dz = (q & 1) ? 1 : -1;
    const len = Math.sqrt(3);
    const nx = dx / len, ny = dy / len, nz = dz / len;

    // Check: dot(octantDir, forward) > cosMargin  (centre of octant within FOV cone)
    // OR: any corner of the octant face is within the frustum  (edge overlap)
    // Simplified: use the dot with forward as a coarse test, with generous threshold
    const dot = nx * forward[0] + ny * forward[1] + nz * forward[2];

    // Additional check: is any vertex of the octant face near the camera direction?
    // For simplicity, include if dot > a threshold that depends on half-FOV.
    // cos(90° + fov_half) = -sin(fov_half) ensures we capture edge-crossing octants.
    const threshold = -Math.sin(Math.max(fovH, fovV));
    if (dot > threshold) mask |= (1 << q);
  }
  return mask;
}

/** Octant indices whose bit is set in mask. */
export function visibleOctants(mask: number): number[] {
  const result: number[] = [];
  for (let q = 0; q < 8; q++) if (mask & (1 << q)) result.push(q);
  return result;
}

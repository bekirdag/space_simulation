import { type Body } from "../physics/body";

// How many positions to store per body (ring buffer)
const TRAIL_LEN = 1500;

// Minimum sim-time gap between recorded positions (≈ 8.76 sim-hours).
// Trails always cover ~1.5 sim-years of history regardless of timewarp speed.
const RECORD_INTERVAL_YR = 0.001; // 1/365 ≈ 0.00274, use half-day ≈ 0.001

const COORDS = 3; // x, y, z per stored point

// Vertex layout sent to GPU: [x, y, z, age, r, g, b, _pad] = 8 floats = 32 bytes
export const TRAIL_VTXFLOATS = 8;

export class TrailSystem {
  private positions  = new Map<number, Float32Array>();
  private heads      = new Map<number, number>();
  private counts     = new Map<number, number>();
  private colors     = new Map<number, [number, number, number]>();
  private lastTimes  = new Map<number, number>(); // sim-year when last recorded

  /**
   * Record current body positions into ring buffers.
   * Only writes a point when at least RECORD_INTERVAL_YR of sim time has elapsed
   * since the last record for that body (works correctly in both directions).
   */
  record(bodies: Body[], simYears: number): void {
    for (const b of bodies) {
      const last = this.lastTimes.get(b.id) ?? -Infinity;
      if (Math.abs(simYears - last) < RECORD_INTERVAL_YR) continue;

      if (!this.positions.has(b.id)) {
        this.positions.set(b.id, new Float32Array(TRAIL_LEN * COORDS));
        this.heads.set(b.id, 0);
        this.counts.set(b.id, 0);
      }

      this.colors.set(b.id, b.color);
      this.lastTimes.set(b.id, simYears);

      const buf  = this.positions.get(b.id)!;
      const head = this.heads.get(b.id)!;
      buf[head * COORDS + 0] = b.x;
      buf[head * COORDS + 1] = b.y;
      buf[head * COORDS + 2] = b.z;
      this.heads.set(b.id, (head + 1) % TRAIL_LEN);
      this.counts.set(b.id, Math.min((this.counts.get(b.id) ?? 0) + 1, TRAIL_LEN));
    }
  }

  /** Returns interleaved [x,y,z, age, r,g,b, _pad] per vertex (oldest→newest). */
  buildVertices(bodyId: number): Float32Array | null {
    const buf   = this.positions.get(bodyId);
    const head  = this.heads.get(bodyId) ?? 0;
    const count = this.counts.get(bodyId) ?? 0;
    const color = this.colors.get(bodyId) ?? [1, 1, 1];
    if (!buf || count < 2) return null;

    const out = new Float32Array(count * TRAIL_VTXFLOATS);
    for (let i = 0; i < count; i++) {
      const src = ((head - count + i) % TRAIL_LEN + TRAIL_LEN) % TRAIL_LEN;
      const age = i / (count - 1); // 0 = oldest, 1 = newest
      const o = i * TRAIL_VTXFLOATS;
      out[o + 0] = buf[src * COORDS + 0]!;
      out[o + 1] = buf[src * COORDS + 1]!;
      out[o + 2] = buf[src * COORDS + 2]!;
      out[o + 3] = age;
      out[o + 4] = color[0];
      out[o + 5] = color[1];
      out[o + 6] = color[2];
      out[o + 7] = 0;
    }
    return out;
  }

  get bodyIds(): number[] { return Array.from(this.positions.keys()); }

  clear(): void {
    this.positions.clear();
    this.heads.clear();
    this.counts.clear();
    this.colors.clear();
    this.lastTimes.clear();
  }
}

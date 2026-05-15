import { type Body } from "../physics/body";
import { BodyType } from "../physics/constants";

const TRAIL_LEN        = 15_000;
const POINTS_PER_ORBIT = 3_000;
const ANGLE_STEP       = (2 * Math.PI) / POINTS_PER_ORBIT;

const MAX_SEGMENT_AU   = 5e-4;
const MOON_ANGLE_FACTOR = 0.02;
const MIN_RECORD_DIST_AU = 1e-6;

const COORDS = 3;
export const TRAIL_VTXFLOATS = 8;

// Bytes reserved in the GPU buffer for one body's trail.
export const TRAIL_SLOT_BYTES = TRAIL_LEN * TRAIL_VTXFLOATS * 4;

export class TrailSystem {
  private positions = new Map<number, Float32Array>();
  private heads     = new Map<number, number>();
  private counts    = new Map<number, number>();
  private colors    = new Map<number, [number, number, number]>();
  private lastPos   = new Map<number, [number, number, number]>();

  // ── Dirty tracking ────────────────────────────────────────────────────────
  // Set when a new point is recorded; cleared by the renderer after upload.
  // When not dirty the renderer re-uses the existing GPU data — zero upload cost.
  private dirty = new Set<number>();

  // Pre-allocated CPU vertex cache: one fixed-size Float32Array per body.
  // Eliminates the ~15 MB / frame of Float32Array allocations.
  private vcache = new Map<number, Float32Array>();

  record(bodies: Body[]): void {
    for (const b of bodies) {
      const last = this.lastPos.get(b.id);
      const r = Math.hypot(b.x, b.y, b.z);
      const isMoon = b.type === BodyType.Moon;
      const angularStep = r * ANGLE_STEP * (isMoon ? MOON_ANGLE_FACTOR : 1.0);
      const threshold = Math.max(MIN_RECORD_DIST_AU, Math.min(MAX_SEGMENT_AU, angularStep));

      if (last) {
        const dx = b.x - last[0]!, dy = b.y - last[1]!, dz = b.z - last[2]!;
        if (dx*dx + dy*dy + dz*dz < threshold * threshold) continue;
      }

      if (!this.positions.has(b.id)) {
        this.positions.set(b.id, new Float32Array(TRAIL_LEN * COORDS));
        this.heads.set(b.id, 0);
        this.counts.set(b.id, 0);
        // Pre-allocate vertex cache at max size — done once, never reallocated.
        this.vcache.set(b.id, new Float32Array(TRAIL_LEN * TRAIL_VTXFLOATS));
      }

      this.colors.set(b.id, b.color);
      this.lastPos.set(b.id, [b.x, b.y, b.z]);

      const buf  = this.positions.get(b.id)!;
      const head = this.heads.get(b.id)!;
      buf[head * COORDS + 0] = b.x;
      buf[head * COORDS + 1] = b.y;
      buf[head * COORDS + 2] = b.z;
      this.heads.set(b.id, (head + 1) % TRAIL_LEN);
      this.counts.set(b.id, Math.min((this.counts.get(b.id) ?? 0) + 1, TRAIL_LEN));
      this.dirty.add(b.id);
    }
  }

  /**
   * Rebuild the vertex cache for this body (oldest→newest order).
   * Only called when isDirty() is true — never on unchanged frames.
   * Returns a *view* into the pre-allocated cache (no allocation).
   */
  buildVertices(bodyId: number): Float32Array | null {
    const buf   = this.positions.get(bodyId);
    const head  = this.heads.get(bodyId) ?? 0;
    const count = this.counts.get(bodyId) ?? 0;
    const color = this.colors.get(bodyId) ?? [1, 1, 1];
    const cache = this.vcache.get(bodyId);
    if (!buf || !cache || count < 2) return null;

    for (let i = 0; i < count; i++) {
      const src = ((head - count + i) % TRAIL_LEN + TRAIL_LEN) % TRAIL_LEN;
      const age = i / (count - 1);
      const o   = i * TRAIL_VTXFLOATS;
      cache[o + 0] = buf[src * COORDS + 0]!;
      cache[o + 1] = buf[src * COORDS + 1]!;
      cache[o + 2] = buf[src * COORDS + 2]!;
      cache[o + 3] = age;
      cache[o + 4] = color[0];
      cache[o + 5] = color[1];
      cache[o + 6] = color[2];
      cache[o + 7] = 0;
    }
    // Return a view of exactly count vertices — no allocation, no copy.
    return cache.subarray(0, count * TRAIL_VTXFLOATS);
  }

  getCount(bodyId: number): number { return this.counts.get(bodyId) ?? 0; }
  isDirty(bodyId: number): boolean { return this.dirty.has(bodyId); }
  clearDirty(bodyId: number): void { this.dirty.delete(bodyId); }

  get bodyIds(): number[] { return Array.from(this.positions.keys()); }

  clear(): void {
    this.positions.clear();
    this.heads.clear();
    this.counts.clear();
    this.colors.clear();
    this.lastPos.clear();
    this.dirty.clear();
    this.vcache.clear();
  }
}

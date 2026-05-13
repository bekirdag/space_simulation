import { type Body } from "./body";
import { G, SOFTENING } from "./constants";

type Vec3 = { x: number; y: number; z: number };

export interface IntegratorOptions {
  externalAcceleration?: (body: Body, index: number) => Vec3;
}

function acceleration(bodies: Body[], idx: number, options: IntegratorOptions): Vec3 {
  const b = bodies[idx]!;
  let ax = 0, ay = 0, az = 0;
  for (let j = 0; j < bodies.length; j++) {
    if (j === idx) continue;
    const o = bodies[j]!;
    const dx = o.x - b.x;
    const dy = o.y - b.y;
    const dz = o.z - b.z;
    const r2 = dx*dx + dy*dy + dz*dz + SOFTENING*SOFTENING;
    const r  = Math.sqrt(r2);
    const f  = (G * o.mass) / (r2 * r);
    ax += f * dx;
    ay += f * dy;
    az += f * dz;
  }

  const external = options.externalAcceleration?.(b, idx);
  if (external) {
    ax += external.x;
    ay += external.y;
    az += external.z;
  }

  return { x: ax, y: ay, z: az };
}

export function stepLeapfrog(bodies: Body[], dt: number, options: IntegratorOptions = {}): void {
  const a1 = bodies.map((_, i) => acceleration(bodies, i, options));

  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!; const a = a1[i]!;
    b.vx += 0.5 * a.x * dt;
    b.vy += 0.5 * a.y * dt;
    b.vz += 0.5 * a.z * dt;
  }
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
  }

  const a2 = bodies.map((_, i) => acceleration(bodies, i, options));
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i]!; const a = a2[i]!;
    b.vx += 0.5 * a.x * dt;
    b.vy += 0.5 * a.y * dt;
    b.vz += 0.5 * a.z * dt;
  }
}

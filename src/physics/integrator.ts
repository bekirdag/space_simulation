import { type Body } from "./body";
import { G, SOFTENING, BodyType, C2_AU_YR } from "./constants";
import { OBLATENESS } from "./oblateness";

type Vec3 = { x: number; y: number; z: number };

export interface IntegratorOptions {
  externalAcceleration?: (body: Body, index: number) => Vec3;
}

/**
 * Gravitational acceleration of body[idx] due to all other bodies,
 * including three physics corrections layered on top of Newton:
 *
 * 1. 1PN Schwarzschild GR (orbital precession):
 *    Δa = (GMⱼ / c²r²) × [ (4GMⱼ/r − v²)r̂  +  4(r̂·v)v ]
 *    → Mercury 43"/cy, Venus 8.6"/cy, Earth 3.8"/cy
 *
 * 2. Planetary J₂ oblateness (equatorial bulge):
 *    Δa = −(3/2) GMⱼ J₂ Rⱼ² / r⁵ × [(1 − 5ξ²) d̂r  +  2ξ ẑⱼ r]
 *    where ξ = d̂ · ẑⱼ (latitude above equator)
 *    → Io orbital plane: 47°/yr from Jupiter J₂ (critical for Galilean moons)
 *    → Titan, Uranus/Neptune moons: 5–20°/yr from their parent's J₂
 *
 * 3. External acceleration (galactic tidal forces via options callback)
 */
function acceleration(bodies: Body[], idx: number, options: IntegratorOptions): Vec3 {
  const b = bodies[idx]!;
  let ax = 0, ay = 0, az = 0;

  const v2 = b.vx*b.vx + b.vy*b.vy + b.vz*b.vz;

  for (let j = 0; j < bodies.length; j++) {
    if (j === idx) continue;
    const o = bodies[j]!;

    // Vector from b to o (toward the attracting body)
    const dx = o.x - b.x;
    const dy = o.y - b.y;
    const dz = o.z - b.z;
    const r2s = dx*dx + dy*dy + dz*dz + SOFTENING*SOFTENING; // softened
    const rs  = Math.sqrt(r2s);                               // softened r
    const GM  = G * o.mass;

    // ── 1. Newtonian gravity ────────────────────────────────────────────────
    const fN = GM / (r2s * rs);
    ax += fN * dx;
    ay += fN * dy;
    az += fN * dz;

    // ── 2. 1PN GR Schwarzschild correction ─────────────────────────────────
    // r̂ = unit vector FROM o TO b = −(dx,dy,dz)/rs
    // ṙ  = r̂ · v_b  (radial velocity of b away from o)
    const r_dot_v  = -(dx*b.vx + dy*b.vy + dz*b.vz) / rs;
    const radial   = 4.0*GM/rs - v2;
    const grCoeff  = GM / (C2_AU_YR * r2s);
    ax += grCoeff * (-radial*dx/rs + 4.0*r_dot_v*b.vx);
    ay += grCoeff * (-radial*dy/rs + 4.0*r_dot_v*b.vy);
    az += grCoeff * (-radial*dz/rs + 4.0*r_dot_v*b.vz);

    // ── 3. J₂ oblateness correction ─────────────────────────────────────────
    // Applies when the attracting body o is an oblate planet with known J₂.
    // Use geometric (unsoftened) distance for accuracy.
    const obl = OBLATENESS.get(o.name);
    if (obl) {
      const r2g = dx*dx + dy*dy + dz*dz;
      const rg  = Math.sqrt(r2g);       // geometric distance (no softening)
      // d_from_o = position of b relative to o (outward vector)
      const [zx, zy, zz] = obl.spinAxis;
      const xi       = ((-dx)*zx + (-dy)*zy + (-dz)*zz) / rg; // cos latitude
      const j2Coeff  = -1.5 * GM * obl.J2 * (obl.radiusAU * obl.radiusAU)
                       / (r2g * r2g * rg);
      const f1       = 1.0 - 5.0*xi*xi;
      ax += j2Coeff * (f1*(-dx) + 2.0*xi*rg*zx);
      ay += j2Coeff * (f1*(-dy) + 2.0*xi*rg*zy);
      az += j2Coeff * (f1*(-dz) + 2.0*xi*rg*zz);
    }
  }

  const ext = options.externalAcceleration?.(b, idx);
  if (ext) { ax += ext.x; ay += ext.y; az += ext.z; }

  return { x: ax, y: ay, z: az };
}

export function stepLeapfrog(bodies: Body[], dt: number, options: IntegratorOptions = {}): void {
  // Exoplanet bodies are catalog decoration driven by orbital mechanics, not N-body.
  const physBodies = bodies.filter(b => b.type !== BodyType.Exoplanet);

  const a1 = physBodies.map((_, i) => acceleration(physBodies, i, options));
  for (let i = 0; i < physBodies.length; i++) {
    const b = physBodies[i]!; const a = a1[i]!;
    b.vx += 0.5*a.x*dt; b.vy += 0.5*a.y*dt; b.vz += 0.5*a.z*dt;
  }
  for (let i = 0; i < physBodies.length; i++) {
    const b = physBodies[i]!;
    b.x += b.vx*dt; b.y += b.vy*dt; b.z += b.vz*dt;
  }
  const a2 = physBodies.map((_, i) => acceleration(physBodies, i, options));
  for (let i = 0; i < physBodies.length; i++) {
    const b = physBodies[i]!; const a = a2[i]!;
    b.vx += 0.5*a.x*dt; b.vy += 0.5*a.y*dt; b.vz += 0.5*a.z*dt;
  }
}

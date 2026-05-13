// Minimal 3D math — column-major Float32Array matrices.
// WebGPU clip-space: NDC z ∈ [0, 1]  (not OpenGL's −1..1).

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
}

export function normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  return len > 0 ? [v[0]/len, v[1]/len, v[2]/len] : [0, 0, 1];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
}

/** Column-major lookAt (right-handed, camera looks toward −Z in view space). */
export function lookAt(eye: Vec3, center: Vec3, up: Vec3): Mat4 {
  const f = normalize(sub(center, eye));
  const r = normalize(cross(f, up));
  const u = cross(r, f);
  return new Float32Array([
     r[0],  u[0], -f[0], 0,
     r[1],  u[1], -f[1], 0,
     r[2],  u[2], -f[2], 0,
    -dot(r, eye), -dot(u, eye), dot(f, eye), 1,
  ]);
}

/** Column-major perspective, WebGPU z-range [0,1]. */
export function perspective(fovY: number, aspect: number, near: number, far: number): Mat4 {
  const f   = 1 / Math.tan(fovY / 2);
  const nf  = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0,  0,
    0,          f, 0,  0,
    0, 0,  far * nf, -1,
    0, 0, far * near * nf, 0,
  ]);
}

/** Multiply two column-major 4×4 matrices: result = a × b. */
export function mulMat4(a: Mat4, b: Mat4): Mat4 {
  const o = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k*4+row]! * b[col*4+k]!;
      o[col*4+row] = s;
    }
  }
  return o;
}

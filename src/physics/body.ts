import { type BodyType } from "./constants";

export interface Body {
  id:     number;
  name:   string;
  mass:   number;           // solar masses
  x: number; y: number; z: number;    // AU
  vx: number; vy: number; vz: number; // AU/yr
  radius: number;           // AU (visual)
  color:  [number, number, number];    // RGB 0–1
  type:   BodyType;
}

// GPU buffer layout — 4 × vec4 = 16 floats = 64 bytes.
// Using vec4 throughout avoids all WGSL vec3 alignment surprises.
//
//   vec4 0  pos_mass : x, y, z, mass
//   vec4 1  vel_rad  : vx, vy, vz, radius
//   vec4 2  acc_type : ax, ay, az, btype
//   vec4 3  col_id   : r, g, b, id
//
export const BODY_FLOATS = 16;

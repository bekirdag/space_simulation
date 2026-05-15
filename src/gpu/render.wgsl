// 3D billboard body renderer.
//
// Camera uniform (96 bytes = 6 × vec4):
//   mat4x4 viewProj         — view-projection matrix (64 bytes)
//   vec4   rightAndMNR      — xyz = camera right, w = minNDCRadius for point layers
//   vec4   upAndFocal       — xyz = camera up,    w = focalY (= 1/tan(fovY/2))
//
// Body storage (64 bytes = 4 × vec4, matches JS BODY_FLOATS=16):
//   vec4 pos_mass  — x, y, z, mass
//   vec4 vel_rad   — vx, vy, vz, radius
//   vec4 acc_type  — ax, ay, render visibility, btype
//   vec4 col_id    — r, g, b, id
//
// Billboard: quad vertices are offset from body center along camera right/up,
// so each body always faces the camera regardless of view angle.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,  // xyz=right, w=minNDCRadius for point layers
  upAndFocal:  vec4<f32>,  // xyz=up,    w=focalY
};

struct Body {
  pos_mass: vec4<f32>,
  vel_rad:  vec4<f32>,
  acc_type: vec4<f32>,
  col_id:   vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera: Camera;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       btype:    f32,
  @location(3)       fade:     f32,  // 1.0 = fully visible, 0.0 = hidden
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
  vec2(-1.0, 1.0), vec2(1.0,-1.0), vec2( 1.0,1.0),
);

@vertex
fn vs_main(
  @builtin(vertex_index)   vi:  u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let b   = bodies[idx];
  let uv  = quad[vi];

  let center   = b.pos_mass.xyz;
  let r_phys   = b.vel_rad.w;
  let camRight = camera.rightAndMNR.xyz;
  let camUp    = camera.upAndFocal.xyz;

  // Project center to get clip-space depth (W component)
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv      = uv;
  out.color   = b.col_id.xyz;
  out.btype   = b.acc_type.w;
  out.fade    = clamp(b.acc_type.z, 0.0, 1.0);

  // Discard body behind the camera or suppressed by screen-density reduction.
  if clip_c.w <= 0.0 || out.fade <= 0.001 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Expand billboard at the body's actual physical radius. Do not
  // clamp to a minimum dot; distant bodies should become naturally tiny.
  let world_pos = center + uv.x * camRight * r_phys + uv.y * camUp * r_phys;
  out.clip_pos  = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  let z = sqrt(max(0.0, 1.0 - d * d));
  let edge = 1.0 - smoothstep(0.985, 1.0, d);
  let a = edge * in.fade;
  var col = in.color;
  if in.btype < 0.5 {
    let core = 1.0 - smoothstep(0.0, 0.55, d);
    let limb = 0.76 + 0.24 * z;
    col = col * (limb + core * 0.35) + vec3(core * 0.18);
  } else {
    let normal = normalize(vec3(in.uv.x, in.uv.y, z));
    let lightDir = normalize(vec3(-0.42, 0.34, 0.84));
    let diffuse = max(dot(normal, lightDir), 0.0);
    let rimShade = 0.78 + 0.22 * z;
    let nightSide = 0.18;
    col = col * (nightSide + diffuse * 0.82) * rimShade;
  }
  return vec4<f32>(col * a, a);
}

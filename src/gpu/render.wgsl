// 3D billboard body renderer.
//
// Camera uniform (96 bytes = 6 × vec4):
//   mat4x4 viewProj         — view-projection matrix (64 bytes)
//   vec4   rightAndMNR      — xyz = camera right, w = minNDCRadius
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
  rightAndMNR: vec4<f32>,  // xyz=right, w=minNDCRadius
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
  @location(3)       clamped:  f32,
  @location(4)       fade:     f32,  // 1.0 = fully visible, 0.0 = hidden
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
  var mnr      = camera.rightAndMNR.w;
  let focalY   = camera.upAndFocal.w;

  // Project center to get clip-space depth (W component)
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv      = uv;
  out.color   = b.col_id.xyz;
  out.btype   = b.acc_type.w;
  out.clamped = 0.0;
  out.fade    = clamp(b.acc_type.z, 0.0, 1.0);

  // Discard body behind the camera or suppressed by screen-density reduction.
  if clip_c.w <= 0.0 || out.fade <= 0.001 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Perspective-correct radius: how large is the body in NDC at this depth?
  let r_ndc = r_phys * focalY / clip_c.w;
  var r_eff  = r_phys;

  // Moons (btype=2): no distance/occlusion discard. Visibility is driven by
  // screen-density reduction on the CPU; keep a larger minimum dot when shown.
  if (out.btype > 1.5 && out.btype < 2.5) {
    mnr = max(mnr, camera.rightAndMNR.w * 7.0);
  }

  // Exoplanets (btype=5): catalog bodies orbiting distant stars.
  // No distance/occlusion discard; slightly smaller minimum dot for distinction.
  if (out.btype > 4.5 && out.btype < 5.5) {
    mnr = max(mnr, camera.rightAndMNR.w * 5.0);
  }

  if r_ndc < mnr {
    r_eff       = mnr * clip_c.w / focalY;
    out.clamped = 1.0;
  }

  // Expand billboard in world space along camera right/up
  let world_pos = center + uv.x * camRight * r_eff + uv.y * camUp * r_eff;
  out.clip_pos  = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  // Minimum-size (clamped) bodies
  if in.clamped > 0.5 {
    let a = (1.0 - smoothstep(0.45, 1.0, d)) * in.fade;
    var col = in.color;
    // Boost dark moons so they read against black space
    if in.btype > 1.5 && in.btype < 2.5 {
      col = clamp(col * 1.8 + vec3(0.12), vec3(0.0), vec3(1.0));
    }
    // Exoplanets: bright distinct dot with subtle ring highlight
    if in.btype > 4.5 && in.btype < 5.5 {
      col = clamp(col * 2.0 + vec3(0.15), vec3(0.0), vec3(1.0));
    }
    return vec4<f32>(col * a, a);
  }

  // Full-size body
  let a = (1.0 - smoothstep(0.75, 1.0, d)) * in.fade;
  var col = in.color;
  if in.btype < 0.5 {
    let core = 1.0 - smoothstep(0.0, 0.35, d);
    col = col + vec3(core * 0.2);
  }
  return vec4<f32>(col * a, a);
}

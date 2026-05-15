// Milky Way background star renderer — 100k stars spanning the galactic disk.
// Same 8-float buffer layout as star.wgsl but this pipeline has no selected-star
// boost.  Visibility is gated by lodFade (binding 2) so these stars only appear
// when the camera is far from the solar system origin.
//
// Buffer layout per star (32 bytes):
//   vec4 pos_size:    xyz = compressed ecliptic AU position, w = size multiplier
//   vec4 color_alpha: rgb = star colour, w = base alpha

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

struct Star {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera:  Camera;
@group(0) @binding(1) var<storage, read> stars:   array<Star>;
@group(0) @binding(2) var<uniform>       lodFade: vec4<f32>; // x=fade 0..1

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
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
  let star   = stars[idx];
  let uv     = quad[vi];
  let center = star.pos_size.xyz;
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv    = uv;
  out.color = star.color_alpha.xyz;
  out.alpha = star.color_alpha.w * lodFade.x;

  // Skip invisible or back-facing instances
  if lodFade.x < 0.01 || clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // ── Frustum culling ────────────────────────────────────────────────────────
  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  if abs(ndcX) > 1.1 || abs(ndcY) > 1.1 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Fixed-NDC billboard — same as normal stars
  let focalY      = camera.upAndFocal.w;
  let pxRadius    = camera.rightAndMNR.w * max(star.pos_size.w * 1.8, 0.6);
  let worldRadius = pxRadius * clip_c.w / focalY;
  let world_pos   = center
    + uv.x * camera.rightAndMNR.xyz * worldRadius
    + uv.y * camera.upAndFocal.xyz  * worldRadius;

  out.clip_pos = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  // Same Lorentzian PSF as the nearby star shader
  let d2    = d * d;
  let core  = exp(-d2 * 22.0);
  let wings = max(0.0, 1.0 / (1.0 + d2 * 10.0) - 0.09);

  var col    = in.color;
  let bleach = clamp(core * in.alpha * 1.6, 0.0, 1.0);
  col = mix(col, vec3<f32>(1.0, 0.97, 0.94), bleach * 0.65);

  let alpha = clamp((core * 0.80 + wings * 0.55) * in.alpha * 2.8, 0.0, 1.0);
  return vec4<f32>(col * alpha, alpha);
}

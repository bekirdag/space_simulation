// Static catalog-star renderer.
//
// Star storage (32 bytes = 2 x vec4):
//   vec4 pos_size    - xyz = compressed catalog position, w = visual size multiplier
//   vec4 color_alpha - rgb = star color, w = alpha

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

struct Star {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera: Camera;
@group(0) @binding(1) var<storage, read> stars: array<Star>;

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
  let star = stars[idx];
  let uv = quad[vi];
  let center = star.pos_size.xyz;
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv = uv;
  out.color = star.color_alpha.xyz;
  out.alpha = star.color_alpha.w;

  if clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let pxRadius = camera.rightAndMNR.w * star.pos_size.w;
  let focalY = camera.upAndFocal.w;
  let worldRadius = pxRadius * clip_c.w / focalY;
  let world_pos = center
    + uv.x * camera.rightAndMNR.xyz * worldRadius
    + uv.y * camera.upAndFocal.xyz * worldRadius;

  out.clip_pos = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  let core = 1.0 - smoothstep(0.0, 0.42, d);
  let halo = 1.0 - smoothstep(0.35, 1.0, d);
  let alpha = (core * 0.75 + halo * 0.25) * in.alpha;
  return vec4<f32>(in.color * alpha, alpha);
}

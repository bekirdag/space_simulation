// Galactic dust map renderer.
//
// Buffer layout per cell (32 bytes):
//   vec4 pos_size:    xyz = world AU position on the Galactic sky shell, w = billboard radius AU
//   vec4 color_alpha: rgb = dust colour, w = base alpha

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct DustCell {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera: Camera;
@group(0) @binding(1) var<storage, read> dust:   array<DustCell>;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       seed:     f32,
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
  let cell = dust[idx];
  let uv = quad[vi];
  let center = cell.pos_size.xyz;
  let radius = cell.pos_size.w;
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv = uv;
  out.color = cell.color_alpha.xyz;
  out.alpha = cell.color_alpha.w;
  out.seed = fract(f32(idx) * 0.61803398875);

  if radius <= 0.0 || out.alpha <= 0.0001 || clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let pxSize = radius * camera.upAndFocal.w / clip_c.w;
  if ndcX - pxSize > 1.20 || ndcX + pxSize < -1.20 ||
     ndcY - pxSize > 1.20 || ndcY + pxSize < -1.20 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let world_pos = center
    + uv.x * camera.rightAndMNR.xyz * radius
    + uv.y * camera.upAndFocal.xyz  * radius;

  out.clip_pos = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

fn hash2(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn noise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x),
    mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x),
    u.y,
  );
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  let p = in.uv * 2.8 + vec2<f32>(in.seed * 11.7, in.seed * 5.3);
  let wisps = noise2(p) * 0.55 + noise2(p * 2.1 + 3.7) * 0.30 + noise2(p * 4.2 + 1.9) * 0.15;
  let softEdge = 1.0 - smoothstep(0.45, 1.0, d);
  let filament = smoothstep(0.18, 0.92, wisps) * softEdge;
  let veil = (1.0 - smoothstep(0.0, 1.0, d)) * 0.35;
  let density = max(filament, veil);
  if density < 0.015 { discard; }

  let a = clamp(density * in.alpha, 0.0, 0.28);
  let col = mix(in.color * 0.70, in.color, filament);
  return vec4<f32>(col * a, a);
}

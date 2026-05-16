// Textured nebula renderer — uses a real NASA/ESA astronomical image instead of
// procedural FBM noise. Used for Eta Carinae (Homunculus Nebula) and similar
// objects where the actual Hubble image is available.
//
// Buffer layout (same as nebula.wgsl, 4 × vec4 = 64 bytes):
//   vec4 pos_size:    xyz = ecliptic AU position, w = billboard radius AU
//   vec4 color_alpha: rgb = tint colour (1,1,1 = no tint), w = base alpha
//   vec4 params:      x = type, y = seed, z = brightness, w = aspect_ratio
//   vec4 _pad

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

struct Nebula {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
  params:      vec4<f32>,
  _pad:        vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera:    Camera;
@group(0) @binding(1) var<storage, read> nebulas:   array<Nebula>;
@group(0) @binding(2) var                nebulaTex: texture_2d<f32>;
@group(0) @binding(3) var                nebulaSmp: sampler;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,  // -1..+1 billboard UV
  @location(1)       tint:     vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       aspect:   f32,
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
  let neb    = nebulas[idx];
  let uv     = quad[vi];
  let center = neb.pos_size.xyz;
  let radius = neb.pos_size.w;
  let aspect = neb.params.w;  // image width/height ratio
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv     = uv;
  out.tint   = neb.color_alpha.xyz;
  out.alpha  = neb.color_alpha.w * neb.params.z;  // base alpha × brightness
  out.aspect = select(1.0, aspect, aspect > 0.01);

  if clip_c.w <= 0.0 || radius <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Frustum cull with generous margin for large billboards
  let ndcX   = clip_c.x / clip_c.w;
  let ndcY   = clip_c.y / clip_c.w;
  let pxSize = radius * camera.upAndFocal.w / clip_c.w;
  if ndcX - pxSize > 1.4 || ndcX + pxSize < -1.4 ||
     ndcY - pxSize > 1.4 || ndcY + pxSize < -1.4 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Aspect-correct billboard: stretch horizontally for landscape images
  let world_pos = center
    + uv.x * camera.rightAndMNR.xyz * (radius * out.aspect)
    + uv.y * camera.upAndFocal.xyz  * radius;

  out.clip_pos = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  // Map billboard -1..1 UV to texture 0..1
  let tex_uv = vec2<f32>(in.uv.x * 0.5 + 0.5, 0.5 - in.uv.y * 0.5);
  let tex = textureSample(nebulaTex, nebulaSmp, tex_uv);

  // NASA images have black backgrounds — use luminance as transparency mask.
  // The smoothstep lifts faint detail above noise while keeping bright regions
  // fully opaque. This avoids hard edges around bright lobes.
  let lum = dot(tex.rgb, vec3<f32>(0.299, 0.587, 0.114));
  let mask = smoothstep(0.04, 0.28, lum);

  let a = clamp(mask * in.alpha, 0.0, 1.0);
  if a < 0.005 { discard; }

  // Subtle warm boost on the hot inner core (high lum → slightly warmer)
  // Real Hubble color scheme for Eta Carinae: orange/gold lobes, blue ejecta
  let warmBoost = vec3<f32>(1.15, 1.0, 0.80);
  let col = mix(tex.rgb * in.tint, tex.rgb * in.tint * warmBoost, lum * 0.5);

  return vec4<f32>(col * a, a);
}

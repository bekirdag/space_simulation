// Textured nearby-galaxy LOD renderer.
//
// These are not scientific 3D reconstructions. They are real astronomical
// images placed on oriented, galaxy-scale planes at the catalogued positions,
// used as the close LOD above the far-away procedural galaxy blobs.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct GalaxyModel {
  pos_radius:   vec4<f32>, // xyz center, w = vertical half-height AU
  right_aspect: vec4<f32>, // xyz plane right, w = width/height
  up_alpha:     vec4<f32>, // xyz plane up, w = base opacity
  lod:          vec4<f32>, // x = full-visible distance, y = fully-hidden far distance
};

@group(0) @binding(0) var<uniform>       camera:      Camera;
@group(0) @binding(1) var<storage, read> galaxyModels: array<GalaxyModel>;
@group(0) @binding(2) var                galaxyTex:   texture_2d<f32>;
@group(0) @binding(3) var                galaxySmp:   sampler;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       alpha:    f32,
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2( 1.0,-1.0), vec2(-1.0, 1.0),
  vec2(-1.0, 1.0), vec2( 1.0,-1.0), vec2( 1.0, 1.0),
);

fn smoother01(value: f32) -> f32 {
  let t = clamp(value, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

@vertex
fn vs_main(
  @builtin(vertex_index)   vi:  u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let model = galaxyModels[idx];
  let uv = quad[vi];
  let center = model.pos_radius.xyz;
  let radius = model.pos_radius.w;
  let aspect = max(model.right_aspect.w, 0.1);
  let camDist = length(camera.eyeAndFlags.xyz - center);
  let fade = 1.0 - smoother01((camDist - model.lod.x) / max(model.lod.y - model.lod.x, 1.0));
  let alpha = model.up_alpha.w * fade;

  var out: VertexOut;
  out.uv = uv;
  out.alpha = alpha;

  if alpha <= 0.003 || radius <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let clip_c = camera.viewProj * vec4(center, 1.0);
  if clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let worldRadius = radius * max(aspect, 1.0);
  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let ndcRadius = worldRadius * camera.upAndFocal.w / clip_c.w;
  if ndcX - ndcRadius > 1.6 || ndcX + ndcRadius < -1.6 ||
     ndcY - ndcRadius > 1.6 || ndcY + ndcRadius < -1.6 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let worldPos = center
    + uv.x * model.right_aspect.xyz * radius * aspect
    + uv.y * model.up_alpha.xyz * radius;

  out.clip_pos = camera.viewProj * vec4(worldPos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let texUv = vec2<f32>(in.uv.x * 0.5 + 0.5, 0.5 - in.uv.y * 0.5);
  let tex = textureSample(galaxyTex, galaxySmp, texUv);
  let lum = dot(tex.rgb, vec3<f32>(0.299, 0.587, 0.114));
  let mask = smoothstep(0.018, 0.16, lum);
  let edge = 1.0 - smoother01((length(in.uv) - 0.82) / 0.30);
  let alpha = clamp(mask * edge * in.alpha, 0.0, 1.0);
  if alpha < 0.004 { discard; }

  let coreLift = smoothstep(0.25, 0.85, lum);
  let color = mix(tex.rgb * 0.72, min(tex.rgb * 1.35, vec3<f32>(1.0)), coreLift);
  return vec4<f32>(color, alpha);
}

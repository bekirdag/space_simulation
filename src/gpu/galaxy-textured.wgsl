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
  screenAndTarget: vec4<f32>,
  eyeOffset:       vec4<f32>,
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

const CAMERA_NEAR: f32 = 1e-8;
const CAMERA_FAR:  f32 = 50000000.0;

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

fn camera_back() -> vec3<f32> {
  return normalize(cross(camera.rightAndMNR.xyz, camera.upAndFocal.xyz));
}

fn camera_relative(pos: vec3<f32>) -> vec3<f32> {
  let rel = (pos - camera.screenAndTarget.yzw) - camera.eyeOffset.xyz;
  let back = camera_back();
  return vec3<f32>(
    dot(rel, camera.rightAndMNR.xyz),
    dot(rel, camera.upAndFocal.xyz),
    dot(rel, back),
  );
}

fn project_world(pos: vec3<f32>) -> vec4<f32> {
  let v = camera_relative(pos);
  let nf = 1.0 / (CAMERA_NEAR - CAMERA_FAR);
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let focalY = camera.upAndFocal.w;
  return vec4<f32>(
    v.x * focalY / aspect,
    v.y * focalY,
    CAMERA_FAR * nf * v.z + CAMERA_FAR * CAMERA_NEAR * nf,
    -v.z,
  );
}

fn camera_distance(center: vec3<f32>) -> f32 {
  return length(camera_relative(center));
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
  let camDist = camera_distance(center);
  let farFade = 1.0 - smoother01((camDist - model.lod.x) / max(model.lod.y - model.lod.x, 1.0));
  let closeFade = smoother01((camDist - model.lod.z) / max(model.lod.w - model.lod.z, 1.0));
  let alpha = model.up_alpha.w * farFade * closeFade;

  var out: VertexOut;
  out.uv = uv;
  out.alpha = alpha;

  if alpha <= 0.003 || radius <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let clip_c = project_world(center);
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

  out.clip_pos = project_world(worldPos);
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
  let color = tex.rgb * (0.72 + coreLift * 0.63);
  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  return vec4<f32>(color * objectBrightness, alpha);
}

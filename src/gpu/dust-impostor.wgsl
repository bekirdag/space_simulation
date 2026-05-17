// Distant Milky Way dust cloud impostor renderer.
//
// This pass is the cheap baked/proxy LOD for dust clouds. It uses the same
// storage layout as the close procedural dust model shader, but avoids FBM
// loops and fades out as soon as the projected cloud is large enough for the
// high-detail model pass.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

struct DustSettings {
  // x = opacity after Settings transparency, y = galaxy-scale visibility fade
  opacityVisibility: vec4<f32>,
};

struct DustCloud {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
  params:      vec4<f32>,
  transform:   vec4<f32>,
};

const CAMERA_MIN_PIXEL_RADIUS: f32 = 2.5;
const MICRO_CLOUD_PIXEL_RADIUS: f32 = 0.45;
const MODEL_LOD_BEGIN_PIXEL_RADIUS: f32 = 14.0;
const MODEL_LOD_FULL_PIXEL_RADIUS: f32 = 34.0;

@group(0) @binding(0) var<uniform>       camera:   Camera;
@group(0) @binding(1) var<storage, read> clouds:   array<DustCloud>;
@group(0) @binding(2) var<uniform>       settings: DustSettings;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0) uv:       vec2<f32>,
  @location(1) color:    vec3<f32>,
  @location(2) alpha:    f32,
  @location(3) style:    f32,
  @location(4) seed:     f32,
  @location(5) density:  f32,
  @location(6) px_size:  f32,
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
  vec2<f32>(-1.0,  1.0), vec2<f32>(1.0, -1.0), vec2<f32>( 1.0, 1.0),
);

@vertex
fn vs_main(
  @builtin(vertex_index) vi: u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let cloud = clouds[idx];
  let uv = quad[vi];
  let center = cloud.pos_size.xyz;
  let radius = cloud.pos_size.w;
  let clipCenter = camera.viewProj * vec4<f32>(center, 1.0);
  let sx = select(1.0, cloud.transform.x, cloud.transform.x > 0.01);
  let sy = select(1.0, cloud.transform.y, cloud.transform.y > 0.01);
  let rot = cloud.params.w;
  let cr = cos(rot);
  let sr = sin(rot);
  let rotated = vec2<f32>(
    uv.x * cr - uv.y * sr,
    uv.x * sr + uv.y * cr,
  );

  var out: VertexOut;
  out.uv = uv;
  out.color = cloud.color_alpha.xyz;
  out.alpha = cloud.color_alpha.w * settings.opacityVisibility.x * settings.opacityVisibility.y;
  out.style = cloud.params.x;
  out.seed = cloud.params.y;
  out.density = cloud.transform.z;
  out.px_size = 0.0;

  if (clipCenter.w <= 0.0 || radius <= 0.0 || out.alpha <= 0.001) {
    out.clip_pos = vec4<f32>(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let ndcX = clipCenter.x / clipCenter.w;
  let ndcY = clipCenter.y / clipCenter.w;
  let pxSize = radius * max(sx, sy) * camera.upAndFocal.w / clipCenter.w;
  let pixelRadius = pxSize * CAMERA_MIN_PIXEL_RADIUS / max(camera.rightAndMNR.w, 0.000001);
  out.px_size = pixelRadius;

  let microNdcRadius = camera.rightAndMNR.w * (MICRO_CLOUD_PIXEL_RADIUS / CAMERA_MIN_PIXEL_RADIUS);
  if (pxSize < microNdcRadius) {
    out.clip_pos = vec4<f32>(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let modelLod = smoothstep(MODEL_LOD_BEGIN_PIXEL_RADIUS, MODEL_LOD_FULL_PIXEL_RADIUS, pixelRadius);
  let tinyLod = smoothstep(MICRO_CLOUD_PIXEL_RADIUS, 1.8, pixelRadius);
  let impostorLod = (1.0 - modelLod) * tinyLod;
  out.alpha *= impostorLod;
  if (impostorLod <= 0.002 || out.alpha <= 0.001) {
    out.clip_pos = vec4<f32>(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  if (ndcX - pxSize > 1.35 || ndcX + pxSize < -1.35 ||
      ndcY - pxSize > 1.35 || ndcY + pxSize < -1.35) {
    out.clip_pos = vec4<f32>(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let worldPos = center
    + rotated.x * camera.rightAndMNR.xyz * radius * sx
    + rotated.y * camera.upAndFocal.xyz * radius * sy;
  out.clip_pos = camera.viewProj * vec4<f32>(worldPos, 1.0);
  return out;
}

fn seededWave(p: vec2<f32>, seed: f32) -> f32 {
  let a = sin(dot(p, vec2<f32>(2.91, -1.73)) + seed * 0.017);
  let b = sin(dot(p, vec2<f32>(-1.37, 3.23)) + seed * 0.031);
  let c = sin((p.x + p.y) * 2.07 + seed * 0.011);
  return clamp(0.5 + (a * 0.20 + b * 0.18 + c * 0.12), 0.0, 1.0);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if (d > 1.0) {
    discard;
  }

  let edge = 1.0 - smoothstep(0.66, 0.99, d);
  if (edge <= 0.02) {
    discard;
  }

  let seed = in.seed * 0.0137;
  let p = in.uv * 2.35 + vec2<f32>(seed, seed * 1.271);
  let grain = seededWave(p, in.seed);
  var shape = edge * (0.56 + grain * 0.32);

  if (in.style < 1.5) {
    let lane = 1.0 - smoothstep(0.05, 0.38, abs(in.uv.y + sin(p.x * 1.7 + seed) * 0.18));
    shape *= 0.80 + lane * 0.32;
  } else if (in.style < 2.5) {
    let pocket = smoothstep(0.34, 0.84, grain);
    shape *= 0.68 + pocket * 0.42;
  } else if (in.style < 3.5) {
    shape *= 0.74 + abs(sin((p.x - p.y) * 1.9 + seed)) * 0.34;
  } else {
    let shell = clamp(1.0 - abs(d - 0.50) * 1.9, 0.0, 1.0);
    shape *= 0.70 + shell * 0.30;
  }

  let densityBoost = 0.58 + clamp(in.density, 0.0, 1.0) * 0.36;
  let alpha = clamp(shape * in.alpha * densityBoost, 0.0, 0.44);
  if (alpha < 0.003) {
    discard;
  }

  let darkCore = mix(in.color, vec3<f32>(0.0038, 0.0031, 0.0031), shape * 0.16);
  return vec4<f32>(darkCore, alpha);
}

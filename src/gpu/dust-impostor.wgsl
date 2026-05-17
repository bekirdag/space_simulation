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
const MODEL_LOD_BEGIN_PIXEL_RADIUS: f32 = 4.0;
const MODEL_LOD_FULL_PIXEL_RADIUS: f32 = 14.0;

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

fn hash2(p: vec2<f32>) -> f32 {
  let k = vec2<f32>(0.31831, 0.36788);
  let q = p * k + k.yx;
  return -1.0 + 2.0 * fract(16.0 * k.x * fract(q.x * q.y * (q.x + q.y)));
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

fn noise01(p: vec2<f32>) -> f32 {
  return (noise2(p) + 1.0) * 0.5;
}

fn rot2(p: vec2<f32>, angle: f32) -> vec2<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if (d > 1.0) {
    discard;
  }

  let edge = 1.0 - smoothstep(0.70, 0.99, d);
  if (edge <= 0.02) {
    discard;
  }

  let seed = in.seed * 0.0137;
  let spunUv = rot2(in.uv, seed * 1.93);
  let p = spunUv * 2.05 + vec2<f32>(seed, seed * 1.271);
  let base = noise01(p);
  let detail = noise01(p * 2.55 + vec2<f32>(seed * 0.37, seed * 0.19));
  let holes = noise01(p * 4.20 + vec2<f32>(5.7, seed * 0.43));
  let raggedEdge = edge * (0.62 + base * 0.26) * (1.0 - smoothstep(0.58, 0.88, holes) * 0.58);
  var shape = smoothstep(0.40, 0.82, base * 0.66 + detail * 0.30) * raggedEdge;

  if (in.style < 1.5) {
    let laneNoise = (noise01(p * 1.45 + vec2<f32>(1.9, 4.1)) - 0.5) * 0.44;
    let lane = 1.0 - smoothstep(0.08, 0.40, abs(spunUv.y + laneNoise));
    shape = max(shape * 0.82, lane * raggedEdge * 0.78);
  } else if (in.style < 2.5) {
    let pocket = 1.0 - smoothstep(0.22, 0.82, detail);
    shape = smoothstep(0.26, 0.72, base * 0.58 + pocket * 0.48) * raggedEdge;
  } else if (in.style < 3.5) {
    let filament = abs(noise01(vec2<f32>(spunUv.x * 2.9, spunUv.y * 0.9) + vec2<f32>(seed, seed * 0.61)) - 0.48);
    shape *= 0.68 + smoothstep(0.02, 0.36, filament) * 0.34;
  } else {
    let shell = clamp(1.0 - abs(d - 0.50) * 1.85, 0.0, 1.0);
    shape = max(shape * 0.74, shell * base * raggedEdge * 0.48);
  }

  let densityBoost = 0.58 + clamp(in.density, 0.0, 1.0) * 0.36;
  let alpha = clamp(shape * in.alpha * densityBoost, 0.0, 0.30);
  if (alpha < 0.003) {
    discard;
  }

  let tone = 0.82 + base * 0.13 + clamp(in.density, 0.0, 1.0) * 0.06;
  let darkCore = mix(in.color * tone, vec3<f32>(0.0038, 0.0031, 0.0031), shape * 0.18);
  return vec4<f32>(darkCore, alpha);
}

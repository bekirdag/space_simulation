// Close-range procedural Milky Way dust cloud renderer.
//
// This intentionally renders partial cloud instances instead of a continuous
// galactic disk. A cheaper impostor shader handles distant clouds; this pass
// fades in only when an individual cloud is large enough on screen. The
// instance layout matches the nebula buffer layout:
//   vec4 pos_size:    xyz = ecliptic AU position, w = base radius AU
//   vec4 color_alpha: rgb = dust color, w = per-cloud opacity
//   vec4 params:      x = shape style, y = seed, z = density/contrast, w = rotation
//   vec4 transform:   x/y = uniform scale axes, z = density, w = reserved

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
  out.alpha *= modelLod;
  if (modelLod <= 0.002 || out.alpha <= 0.001) {
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

fn fbm(p0: vec2<f32>, octaves: i32) -> f32 {
  var p = p0;
  var amp = 0.54;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0; i < octaves; i = i + 1) {
    sum += noise2(p) * amp;
    norm += amp;
    p = mat2x2<f32>(1.56, -1.12, 1.12, 1.56) * p + vec2<f32>(0.73, 1.31) * f32(i + 1);
    amp *= 0.52;
  }
  return sum / max(0.0001, norm);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if (d > 1.0) {
    discard;
  }

  let seed = in.seed * 0.0137;
  let p = in.uv * 3.2 + vec2<f32>(seed, seed * 1.271);
  let edgeMask = 1.0 - smoothstep(0.72, 0.98, d);
  if (edgeMask <= 0.05) {
    discard;
  }

  let compact = in.px_size < 22.0;
  var base: f32;
  var detail: f32;
  if (compact) {
    base = (fbm(p, 3) + 1.0) * 0.5;
    detail = (noise2(p * 2.4 + vec2<f32>(2.7, 1.3)) + 1.0) * 0.5;
  } else {
    base = (fbm(p, 5) + 1.0) * 0.5;
    detail = (fbm(p * 2.4 + vec2<f32>(2.7, 1.3), 4) + 1.0) * 0.5;
  }
  // Keep each cloud as a defined translucent object instead of a broad soft veil.
  let edge = edgeMask;

  var shape = base * edge;
  if (in.style < 0.5) {
    shape = smoothstep(0.48, 0.68, base * 0.72 + detail * 0.42) * edge;
  } else if (in.style < 1.5) {
    var laneNoise: f32;
    if (compact) {
      laneNoise = noise2(p * 1.6);
    } else {
      laneNoise = fbm(p * 1.6, 3);
    }
    let lane = 1.0 - smoothstep(0.04, 0.42, abs(in.uv.y + laneNoise * 0.28));
    shape = smoothstep(0.44, 0.66, base * 0.58 + lane * 0.46) * edge;
  } else if (in.style < 2.5) {
    let pocket = 1.0 - smoothstep(0.20, 0.88, detail);
    shape = smoothstep(0.42, 0.64, base * 0.55 + pocket * 0.55) * edge;
  } else if (in.style < 3.5) {
    let raggedP = p * 3.4 + vec2<f32>(7.1, 5.4);
    var raggedNoise: f32;
    if (compact) {
      raggedNoise = noise2(raggedP);
    } else {
      raggedNoise = fbm(raggedP, 4);
    }
    let ragged = abs(raggedNoise);
    shape = smoothstep(0.46, 0.67, base * 0.50 + ragged * 0.62) * edge;
  } else {
    let shell = 1.0 - abs(d - 0.48) * 1.8;
    shape = smoothstep(0.43, 0.66, base * 0.62 + max(shell, 0.0) * 0.36) * edge;
  }

  if (shape < 0.045) {
    discard;
  }

  let density = clamp(in.density, 0.0, 1.0);
  let densityBoost = 0.72 + density * 0.42;
  let alpha = clamp(shape * in.alpha * densityBoost, 0.0, 0.72);
  if (alpha < 0.004) {
    discard;
  }

  let hdrAlbedo = in.color * (0.42 + (1.0 - density) * 0.18);
  let darkMix = clamp(shape * (0.48 + density * 0.28), 0.0, 0.86);
  let darkCore = mix(hdrAlbedo, vec3<f32>(0.0038, 0.0031, 0.0031), darkMix);
  return vec4<f32>(darkCore, alpha);
}

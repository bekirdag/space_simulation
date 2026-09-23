// 3D trail renderer — line-strip per body, alpha-faded from head (bright) to tail (transparent).
//
// Drawn inside the HDR scene pass after opaque bodies/models, depth-tested
// (log depth, see logDepth below) so trail segments behind planets, moons, the
// Sun and 3D models are hidden, and covered by the black-hole composite.
//
// Vertex layout (12 floats = 48 bytes per vertex, see trail-system.ts):
//   location 0: posHigh vec3 — f32(x, y, z)            (world AU)
//   location 1: age     f32  — 0=oldest, 1=newest
//   location 2: color   vec3 — r, g, b
//   (float 7 is padding)
//   location 3: posLow  vec3 — f32(pos - posHigh), from f64 on the CPU
//   (float 11 is padding)
// The eye is split the same way in TrailParams, so the camera-relative
// position is (posHigh - eyeHigh) + (posLow - eyeLow): no f32 cancellation
// against large absolute coordinates, hence no jitter when zoomed close.

struct Camera {
  viewProj:        mat4x4<f32>,
  rightAndMNR:     vec4<f32>,
  upAndFocal:      vec4<f32>,
  eyeAndFlags:     vec4<f32>,
  screenAndTarget: vec4<f32>, // x = aspect
  eyeOffset:       vec4<f32>,
};

struct TrailParams {
  // xy = one pixel in NDC, z = desired stroke thickness in pixels
  screen:  vec4<f32>,
  eyeHigh: vec4<f32>,
  eyeLow:  vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> trailParams: TrailParams;

// Keep in sync with blackhole.wgsl (tone map applied by the composite pass).
const HDR_EXPOSURE: f32 = 0.92;
const TRAIL_LAYER_GAIN: f32 = 1.55;

struct VertexOut {
  @builtin(position) clip_pos:  vec4<f32>,
  @location(0)       age:       f32,
  @location(1)       color:     vec3<f32>,
  @location(2)       weight:    f32,
  @location(3)       viewDepth: f32,
};

struct FragmentOut {
  @location(0)         color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

fn stroke_offset(instanceIndex: u32) -> vec3<f32> {
  switch instanceIndex {
    case 1u: { return vec3<f32>( 1.0,  0.0, 0.38); }
    case 2u: { return vec3<f32>(-1.0,  0.0, 0.38); }
    case 3u: { return vec3<f32>( 0.0,  1.0, 0.38); }
    case 4u: { return vec3<f32>( 0.0, -1.0, 0.38); }
    default: { return vec3<f32>( 0.0,  0.0, 0.72); }
  }
}

fn project_eye_relative(rel: vec3<f32>) -> vec4<f32> {
  let right = camera.rightAndMNR.xyz;
  let up = camera.upAndFocal.xyz;
  let back = cross(right, up);
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let focalY = camera.upAndFocal.w;
  let w = -dot(rel, back);
  return vec4<f32>(dot(rel, right) * focalY / aspect, dot(rel, up) * focalY, 0.0, w);
}

@vertex
fn vs_main(
  @location(0) posHigh: vec3<f32>,
  @location(1) age:     f32,
  @location(2) color:   vec3<f32>,
  @location(3) posLow:  vec3<f32>,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOut {
  var out: VertexOut;
  let stroke = stroke_offset(instanceIndex);
  let halfExtraPx = max(trailParams.screen.z - 1.0, 0.0) * 0.5;
  let ndcOffset = stroke.xy * trailParams.screen.xy * halfExtraPx;
  let rel = (posHigh - trailParams.eyeHigh.xyz) + (posLow - trailParams.eyeLow.xyz);
  var clipPos = project_eye_relative(rel);
  clipPos = vec4<f32>(clipPos.xy + ndcOffset * clipPos.w, clipPos.zw);
  out.clip_pos = with_log_depth(clipPos);
  out.viewDepth = clipPos.w;
  out.age      = age;
  out.color    = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  out.weight   = stroke.z;
  return out;
}

// Inverse of the composite's tone map (ACES curve + 1/2.2 gamma), so a trail
// drawn into the HDR scene displays with the same colour/fade it had when it
// was an LDR overlay on the swap chain. aces_tonemap() is 82% luminance-based
// (hue preserving), so invert that path: scale the linear target by
// acesInverse(luma) / luma.
fn aces_inverse(y: f32) -> f32 {
  let t = clamp(y, 0.0, 0.95);
  let a = 2.51 - 2.43 * t;
  let b = 0.03 - 0.59 * t;
  let c = -0.14 * t;
  return (-b + sqrt(max(b * b - 4.0 * a * c, 0.0))) / (2.0 * a) / HDR_EXPOSURE;
}

fn inverse_display(ldr: vec3<f32>) -> vec3<f32> {
  let lin = pow(clamp(ldr, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(2.2));
  let luma = dot(lin, vec3<f32>(0.2126, 0.7152, 0.0722));
  if luma <= 1e-7 { return vec3<f32>(0.0); }
  return lin * (aces_inverse(luma) / luma);
}

@fragment
fn fs_main(in: VertexOut) -> FragmentOut {
  let alpha = in.age * 0.78 * in.weight;
  var out: FragmentOut;
  // Premultiplied, inverse-tone-mapped. The 5 stroke instances overlap 2-3
  // deep per pixel and "over" in linear HDR accumulates less than it did in
  // display space, so each layer is lifted ~1.55x to keep the old brightness.
  out.color = vec4<f32>(inverse_display(in.color * min(alpha * TRAIL_LAYER_GAIN, 1.0)), alpha);
  // Per-fragment log depth (view depth interpolates linearly with perspective
  // correction, log depth does not) so long segments occlude correctly.
  out.depth = logDepth(in.viewDepth);
  return out;
}

// Logarithmic depth shared with solar-system-model.wgsl / milkyway-model.wgsl /
// render.wgsl / trail.wgsl (keep LOG_DEPTH_* in sync). The standard hyperbolic
// depth collapses to 1.0 beyond a few AU, so every depth-tested scene layer
// writes log2 view depth instead. Billboards keep the same clip w on all
// corners, so z = logDepth(w) * w is exact for the whole sprite (centre depth).
const LOG_DEPTH_K: f32 = 1e-9;
const LOG_DEPTH_INV_RANGE: f32 = 0.016666667; // 1 / log2(1 + 1e9 / 1e-9) ~= 1 / 59.79

fn logDepth(viewDepth: f32) -> f32 {
  return clamp(log2(1.0 + max(viewDepth, 0.0) / LOG_DEPTH_K) * LOG_DEPTH_INV_RANGE, 0.0, 1.0);
}

fn with_log_depth(clip: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(clip.xy, logDepth(clip.w) * clip.w, clip.w);
}

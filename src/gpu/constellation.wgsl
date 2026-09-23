struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       alpha:    f32,
};

@vertex
fn vs_main(
  @location(0) pos:   vec3<f32>,
  @location(1) alpha: f32,
) -> VertexOut {
  var out: VertexOut;
  out.clip_pos = with_log_depth(camera.viewProj * vec4<f32>(pos, 1.0));
  out.alpha = alpha;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let color = vec3<f32>(0.46, 0.70, 1.0);
  let alpha = clamp(in.alpha, 0.0, 0.7);
  return vec4<f32>(color, alpha);
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

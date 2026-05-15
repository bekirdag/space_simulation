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
  out.clip_pos = camera.viewProj * vec4<f32>(pos, 1.0);
  out.alpha = alpha;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let color = vec3<f32>(0.46, 0.70, 1.0);
  let alpha = clamp(in.alpha, 0.0, 0.7);
  return vec4<f32>(color, alpha);
}

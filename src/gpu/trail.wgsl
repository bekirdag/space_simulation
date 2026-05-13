// 3D trail renderer — line-strip per body, alpha-faded from head (bright) to tail (transparent).
//
// Vertex layout (8 floats = 32 bytes per vertex):
//   location 0: pos   vec3  — x, y, z
//   location 1: age   f32   — 0=oldest, 1=newest
//   location 2: color vec3  — r, g, b
//   (8th float is padding)

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       age:      f32,
  @location(1)       color:    vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) pos:   vec3<f32>,
  @location(1) age:   f32,
  @location(2) color: vec3<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.clip_pos = camera.viewProj * vec4(pos, 1.0);
  out.age      = age;
  out.color    = color;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  // Linear fade with a bright head — more visible than quadratic
  let alpha = in.age * 0.85;
  return vec4<f32>(in.color * alpha, alpha);
}

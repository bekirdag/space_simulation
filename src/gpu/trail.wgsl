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

struct TrailParams {
  // xy = one pixel in NDC, z = desired stroke thickness in pixels
  screen: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> trailParams: TrailParams;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       age:      f32,
  @location(1)       color:    vec3<f32>,
  @location(2)       weight:   f32,
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

@vertex
fn vs_main(
  @location(0) pos:   vec3<f32>,
  @location(1) age:   f32,
  @location(2) color: vec3<f32>,
  @builtin(instance_index) instanceIndex: u32,
) -> VertexOut {
  var out: VertexOut;
  let stroke = stroke_offset(instanceIndex);
  let halfExtraPx = max(trailParams.screen.z - 1.0, 0.0) * 0.5;
  let ndcOffset = stroke.xy * trailParams.screen.xy * halfExtraPx;
  var clipPos = camera.viewProj * vec4(pos, 1.0);
  clipPos = vec4<f32>(clipPos.xy + ndcOffset * clipPos.w, clipPos.zw);
  out.clip_pos = clipPos;
  out.age      = age;
  out.color    = clamp(color, vec3<f32>(0.0), vec3<f32>(1.0));
  out.weight   = stroke.z;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  // LDR overlay output: clean alpha-blended trails, no HDR bloom contribution.
  let alpha = in.age * 0.78 * in.weight;
  return vec4<f32>(in.color, alpha);
}

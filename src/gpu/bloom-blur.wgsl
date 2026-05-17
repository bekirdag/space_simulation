// Separable Gaussian blur for HDR bloom.
//
// Binding 2 stores the texel step direction:
//   horizontal = vec4(1 / width, 0, 0, 0)
//   vertical   = vec4(0, 1 / height, 0, 0)

@group(0) @binding(0) var sourceTex: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> blurStep: vec4<f32>;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

var<private> pos: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
  vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0),
);

var<private> uvq: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(0.0, 0.0),
  vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(1.0, 0.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  var out: VertexOut;
  out.clip_pos = vec4<f32>(pos[vi], 0.0, 1.0);
  out.uv = uvq[vi];
  return out;
}

fn sample_source(uv: vec2<f32>) -> vec3<f32> {
  return textureSampleLevel(sourceTex, sourceSampler, uv, 0.0).rgb;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let step = blurStep.xy;
  var color = sample_source(in.uv) * 0.22702703;
  color += sample_source(in.uv + step * 1.38461538) * 0.31621622;
  color += sample_source(in.uv - step * 1.38461538) * 0.31621622;
  color += sample_source(in.uv + step * 3.23076923) * 0.07027027;
  color += sample_source(in.uv - step * 3.23076923) * 0.07027027;
  return vec4<f32>(color, 1.0);
}

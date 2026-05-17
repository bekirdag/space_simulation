// Bright-pass extraction for the HDR scene.
//
// The star shaders write physically-inspired HDR intensity proxies into the
// scene texture. This pass keeps only values bright enough to bloom, preserving
// the source color instead of flattening hot stars to white.

@group(0) @binding(0) var sceneTex: texture_2d<f32>;
@group(0) @binding(1) var sceneSampler: sampler;

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

fn bright_pass(color: vec3<f32>) -> vec3<f32> {
  let threshold = 1.12;
  let knee = 0.68;
  let luma = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let soft = clamp(luma - threshold + knee, 0.0, knee * 2.0);
  let softContribution = soft * soft / max(knee * 4.0, 0.0001);
  let hardContribution = max(luma - threshold, 0.0);
  let contribution = max(hardContribution, softContribution);
  return color * (contribution / max(luma, 0.0001));
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let color = textureSampleLevel(sceneTex, sceneSampler, in.uv, 0.0).rgb;
  return vec4<f32>(bright_pass(color), 1.0);
}

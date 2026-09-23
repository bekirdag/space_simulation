// Minimal HDR presentation pass, used only when the full post-process
// (blackhole.wgsl: Sgr A* ray march + flight warp) fails to compile or
// validate on a WebGPU implementation. It shares the black-hole bind group
// layout and applies the same bloom + ACES tone map, so the scene stays
// visible without the black-hole effects.

@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var sceneSampler: sampler;
@group(0) @binding(4) var bloomTex: texture_2d<f32>;
@group(0) @binding(5) var bloomSampler: sampler;

const HDR_EXPOSURE: f32 = 0.92;
const BLOOM_STRENGTH: f32 = 0.72;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  // Two triangles covering the viewport, generated without a lookup table.
  let corner = vec2<f32>(f32(vi == 1u || vi == 4u || vi == 5u), f32(vi == 2u || vi == 3u || vi == 5u));
  var out: VertexOut;
  out.clip_pos = vec4<f32>(corner * 2.0 - vec2<f32>(1.0), 0.0, 1.0);
  out.uv = vec2<f32>(corner.x, 1.0 - corner.y);
  return out;
}

fn finite_hdr(c: vec3<f32>) -> vec3<f32> {
  let bad = (c != c) | (abs(c) > vec3<f32>(65504.0));
  return select(c, vec3<f32>(0.0), bad);
}

fn aces_curve_vec(color: vec3<f32>) -> vec3<f32> {
  let x = max(color * HDR_EXPOSURE, vec3<f32>(0.0));
  return clamp(
    (x * (2.51 * x + vec3<f32>(0.03))) / (x * (2.43 * x + vec3<f32>(0.59)) + vec3<f32>(0.14)),
    vec3<f32>(0.0),
    vec3<f32>(1.0)
  );
}

fn aces_tonemap(color: vec3<f32>) -> vec3<f32> {
  let hdr = max(color, vec3<f32>(0.0));
  let luma = max(dot(hdr, vec3<f32>(0.2126, 0.7152, 0.0722)), 0.000001);
  let mappedLuma = aces_curve_vec(vec3<f32>(luma)).x;
  let chromaMapped = hdr * (mappedLuma / luma);
  let mapped = mix(aces_curve_vec(hdr), chromaMapped, 0.82);
  return clamp(pow(clamp(mapped, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let scene = finite_hdr(textureSampleLevel(sceneTex, sceneSampler, in.uv, 0.0).rgb);
  let bloom = finite_hdr(textureSampleLevel(bloomTex, bloomSampler, in.uv, 0.0).rgb) * BLOOM_STRENGTH;
  return vec4<f32>(aces_tonemap(scene + bloom), 1.0);
}

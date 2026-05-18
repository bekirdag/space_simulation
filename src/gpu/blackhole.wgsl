// HDR presentation post-process.
//
// Combines the HDR scene texture with bloom, applies the cinematic travel warp,
// and tone maps to the swap-chain format. Sagittarius A* itself is rendered as a
// normal GLB scene model.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

struct BlackHole {
  // Legacy uniform layout retained for renderer compatibility.
  pos_size: vec4<f32>,
  // y = viewport width, z = viewport height
  params:   vec4<f32>,
  // x = cinematic flight space-warp strength, y = cinematic motion-blur strength
  flight:   vec4<f32>,
};

const HDR_EXPOSURE: f32 = 0.92;
const BLOOM_STRENGTH: f32 = 0.72;

@group(0) @binding(0) var<uniform> camera:    Camera;
@group(0) @binding(1) var<uniform> blackHole: BlackHole;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var sceneSampler: sampler;
@group(0) @binding(4) var bloomTex: texture_2d<f32>;
@group(0) @binding(5) var bloomSampler: sampler;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
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

fn sample_scene(uv: vec2<f32>) -> vec3<f32> {
  // textureSampleLevel is valid inside non-uniform branches; implicit LOD is not.
  if uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 {
    return vec3<f32>(0.0);
  }
  return textureSampleLevel(sceneTex, sceneSampler, uv, 0.0).rgb;
}

fn sample_bloom(uv: vec2<f32>) -> vec3<f32> {
  if uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 {
    return vec3<f32>(0.0);
  }
  return textureSampleLevel(bloomTex, bloomSampler, uv, 0.0).rgb * BLOOM_STRENGTH;
}

fn aces_curve_scalar(value: f32) -> f32 {
  let x = max(value * HDR_EXPOSURE, 0.0);
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
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
  let mappedLuma = aces_curve_scalar(luma);
  let chromaMapped = hdr * (mappedLuma / luma);
  let channelMapped = aces_curve_vec(hdr);
  let mapped = mix(channelMapped, chromaMapped, 0.82);
  return clamp(pow(clamp(mapped, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(1.0 / 2.2)), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn sample_composite(uv: vec2<f32>) -> vec3<f32> {
  return sample_scene(uv) + sample_bloom(uv);
}

fn apply_flight_warp(hdrColor: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let warpStrength = clamp(blackHole.flight.x, 0.0, 1.0);
  let blurStrength = clamp(blackHole.flight.y, 0.0, 1.0);
  let base = hdrColor + sample_bloom(uv);
  if warpStrength <= 0.001 && blurStrength <= 0.001 {
    return base;
  }

  let center = vec2<f32>(0.5, 0.5);
  let delta = uv - center;
  let radius = length(delta);
  if radius <= 0.001 {
    return base;
  }

  let dir = delta / radius;
  let viewport = max(blackHole.params.yz, vec2<f32>(1.0, 1.0));
  let pixelSpan = max(1.0 / viewport.x, 1.0 / viewport.y);
  let radialMask = smoothstep(0.035, 0.82, radius) * (1.0 - smoothstep(1.05, 1.35, radius));
  let warpAmount = warpStrength * radialMask;
  let blurAmount = blurStrength * radialMask;
  let effectAmount = max(warpAmount, blurAmount);
  let warpScale = warpAmount * (0.035 + 0.045 * radius);
  let warpedUv = center + delta * (1.0 - warpScale);

  var col = mix(base, sample_composite(warpedUv), warpAmount * 0.52);
  var weight = 1.0;
  if blurAmount > 0.001 {
    for (var i: i32 = 1; i <= 5; i = i + 1) {
      let t = f32(i) / 5.0;
      let tapOffset = dir * blurAmount * (pixelSpan * 2.0 + 0.070 * t);
      let tapWeight = (1.0 - t * 0.12) * 0.13;
      col += sample_composite(warpedUv - tapOffset) * tapWeight;
      weight += tapWeight;
    }
  }

  let forwardTap = sample_bloom(warpedUv - dir * effectAmount * 0.095);
  let sideGlow = smoothstep(0.22, 0.95, radius) * (1.0 - smoothstep(1.02, 1.28, radius));
  let warpTint = vec3<f32>(0.035, 0.050, 0.080) * warpAmount * sideGlow;
  return col / max(weight, 0.0001) + forwardTap * effectAmount * 0.75 + warpTint;
}

fn present_color(hdrColor: vec3<f32>, uv: vec2<f32>) -> vec4<f32> {
  return vec4<f32>(aces_tonemap(apply_flight_warp(hdrColor, uv)), 1.0);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  return present_color(sample_scene(in.uv), in.uv);
}

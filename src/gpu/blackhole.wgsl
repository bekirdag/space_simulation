// Sagittarius A* visual post-process.
//
// This is an illustrative screen-space lens, not a GR ray tracer. It bends the
// already-rendered scene texture around Sgr A*, then overlays a dark shadow,
// photon ring, and hot accretion disk shaped after NASA/EHT visual references.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

struct BlackHole {
  // xyz = world-space position, w = visual ring scale in AU
  pos_size: vec4<f32>,
  // x = time seconds, y = viewport width, z = viewport height, w = lens strength
  params:   vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera:    Camera;
@group(0) @binding(1) var<uniform> blackHole: BlackHole;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var sceneSampler: sampler;

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
  if uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 {
    return vec3<f32>(0.006, 0.006, 0.020);
  }
  return textureSample(sceneTex, sceneSampler, uv).rgb;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let raw = sample_scene(in.uv);
  let clip = camera.viewProj * vec4<f32>(blackHole.pos_size.xyz, 1.0);
  if clip.w <= 0.0 || blackHole.pos_size.w <= 0.0 || blackHole.params.w <= 0.0 {
    return vec4<f32>(raw, 1.0);
  }

  let centerNdc = clip.xy / clip.w;
  let centerUv = vec2<f32>(centerNdc.x * 0.5 + 0.5, 0.5 - centerNdc.y * 0.5);
  let viewport = max(blackHole.params.yz, vec2<f32>(1.0, 1.0));
  let aspect = viewport.x / viewport.y;

  // Convert the physical AU scale into projected UV units. The clamp keeps the
  // lens inspectable at the Sgr A* focus distance without covering the screen.
  let ringR = clamp(0.5 * blackHole.pos_size.w * camera.upAndFocal.w / clip.w, 0.006, 0.22);

  if centerUv.x < -ringR * 7.0 || centerUv.x > 1.0 + ringR * 7.0 ||
     centerUv.y < -ringR * 7.0 || centerUv.y > 1.0 + ringR * 7.0 {
    return vec4<f32>(raw, 1.0);
  }

  let deltaUv = in.uv - centerUv;
  let duv = vec2<f32>(deltaUv.x * aspect, deltaUv.y);
  let r = length(duv);
  let safeR = max(r, ringR * 0.12);
  let dir = duv / safeR;
  let tangent = vec2<f32>(-dir.y, dir.x);

  let lensMask = 1.0 - smoothstep(ringR * 4.7, ringR * 8.5, r);
  let bend = (ringR * ringR) / (safeR * safeR + ringR * ringR * 0.22);
  let swirl = sin(blackHole.params.x * 0.35 + safeR * 90.0) * ringR * 0.045;
  let lensedAspect = duv
    + dir * bend * ringR * 0.92 * lensMask * blackHole.params.w
    + tangent * swirl * lensMask * blackHole.params.w;
  let lensedUv = centerUv + vec2<f32>(lensedAspect.x / aspect, lensedAspect.y);
  var col = mix(raw, sample_scene(lensedUv), lensMask * 0.86);

  // Event-horizon shadow and photon rings.
  let shadow = 1.0 - smoothstep(ringR * 0.40, ringR * 0.57, r);
  col *= 1.0 - shadow * 0.98;

  let photon = exp(-pow((r - ringR * 0.67) / max(ringR * 0.032, 0.0004), 2.0));
  let innerPhoton = exp(-pow((r - ringR * 0.49) / max(ringR * 0.022, 0.0003), 2.0)) * 0.42;

  // Nearly edge-on hot disk. The left side is boosted to mimic Doppler
  // brightening of gas moving toward the camera.
  let wave = sin((duv.x / max(ringR, 0.0001)) * 3.5 + blackHole.params.x * 0.55);
  let tiltedY = duv.y + wave * ringR * 0.028;
  let diskEllipse = length(vec2<f32>(duv.x / (ringR * 3.15), tiltedY / (ringR * 0.33)));
  let diskBand = exp(-pow((diskEllipse - 1.0) / 0.15, 2.0));
  let midDisk = exp(-pow(abs(tiltedY) / max(ringR * 0.060, 0.0004), 2.0))
    * smoothstep(ringR * 0.55, ringR * 1.20, abs(duv.x))
    * (1.0 - smoothstep(ringR * 3.35, ringR * 4.35, abs(duv.x)));
  let knots = 0.80 + 0.20
    * sin((duv.x / max(ringR, 0.0001)) * 8.0 - blackHole.params.x * 1.15)
    * sin((duv.x / max(ringR, 0.0001)) * 2.2 + blackHole.params.x * 0.35);
  let doppler = 0.72 + 0.58 * smoothstep(-0.95, 0.85, -dir.x);
  let disk = max(diskBand * 0.80, midDisk * 1.16) * knots * doppler;

  let hot = mix(vec3<f32>(1.0, 0.36, 0.11), vec3<f32>(1.0, 0.86, 0.56), diskBand);
  let ringCol = vec3<f32>(1.0, 0.78, 0.42);
  col += hot * disk * 0.34;
  col += ringCol * photon * 0.72;
  col += vec3<f32>(1.0, 0.50, 0.22) * innerPhoton * 0.42;

  // A soft reddish bloom gives the ring the fuzzy EHT-like emission look.
  let bloom = exp(-pow((r - ringR * 0.95) / max(ringR * 0.42, 0.001), 2.0));
  col += vec3<f32>(0.85, 0.20, 0.06) * bloom * 0.085 * lensMask;

  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}

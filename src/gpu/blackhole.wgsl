// Sagittarius A* visual post-process.
//
// This is an illustrative screen-space lens, not a GR ray tracer. It keeps the
// physical Sgr A* event-horizon radius from main.ts, projects the corresponding
// apparent shadow, bends the already-rendered scene texture, and overlays a
// cleaner photon ring plus an edge-on accretion disk.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
};

struct BlackHole {
  // xyz = world-space position, w = event-horizon radius in AU
  pos_size: vec4<f32>,
  // x = time seconds, y = viewport width, z = viewport height, w = lens strength
  params:   vec4<f32>,
};

const SHADOW_RADIUS_PER_HORIZON: f32 = 2.6;
const PI: f32 = 3.14159265359;

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
  // textureSampleLevel is valid inside non-uniform branches; implicit LOD is not.
  if uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 {
    return vec3<f32>(0.006, 0.006, 0.020);
  }
  return textureSampleLevel(sceneTex, sceneSampler, uv, 0.0).rgb;
}

fn hash1(x: f32) -> f32 {
  return fract(sin(x * 127.1) * 43758.5453123);
}

fn ring_gauss(r: f32, center: f32, width: f32) -> f32 {
  let w = max(width, 0.00001);
  return exp(-pow((r - center) / w, 2.0));
}

fn disk_range(absX: f32, inner: f32, outer: f32) -> f32 {
  return smoothstep(inner * 0.72, inner, absX) * (1.0 - smoothstep(outer, outer * 1.18, absX));
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

  // AU radius -> UV radius. No minimum clamp: Sgr A* disappears naturally when
  // its actual projected size is below the pixel threshold.
  let horizonUvR = max(0.5 * blackHole.pos_size.w * camera.upAndFocal.w / clip.w, 0.0);
  let shadowR = horizonUvR * SHADOW_RADIUS_PER_HORIZON;
  if shadowR < 0.75 / viewport.y {
    return vec4<f32>(raw, 1.0);
  }

  if centerUv.x < -shadowR * 8.0 || centerUv.x > 1.0 + shadowR * 8.0 ||
     centerUv.y < -shadowR * 8.0 || centerUv.y > 1.0 + shadowR * 8.0 {
    return vec4<f32>(raw, 1.0);
  }

  let deltaUv = in.uv - centerUv;
  let p = vec2<f32>(deltaUv.x * aspect, deltaUv.y);
  let r = length(p);
  let safeR = max(r, shadowR * 0.055);
  let dir = p / safeR;
  let tangent = vec2<f32>(-dir.y, dir.x);
  let theta = atan2(p.y, p.x);

  // Background lensing: strong near the photon sphere, fades smoothly outward.
  let lensMask = 1.0 - smoothstep(shadowR * 3.2, shadowR * 6.4, r);
  let bend = shadowR * shadowR / (safeR * safeR + shadowR * shadowR * 0.24);
  let spinShear = blackHole.params.w * shadowR * 0.025 * lensMask / (1.0 + safeR / max(shadowR, 0.0001));
  let lensedAspect = p
    + dir * bend * shadowR * 0.42 * lensMask * blackHole.params.w
    + tangent * (spinShear + sin(theta * 2.0 + blackHole.params.x * 0.22) * shadowR * 0.005 * lensMask);
  let lensedUv = centerUv + vec2<f32>(lensedAspect.x / aspect, lensedAspect.y);
  let nearLens = 1.0 - smoothstep(shadowR * 0.95, shadowR * 3.65, r);
  let lensBlend = lensMask * (0.18 + 0.16 * smoothstep(shadowR * 1.15, shadowR * 3.4, r));
  var col = mix(raw, sample_scene(lensedUv), lensBlend);
  col = mix(col, vec3<f32>(0.003, 0.0025, 0.006), nearLens * 0.56);

  // The apparent black-hole shadow is larger than the event horizon. The old
  // shader only dimmed this region, which made the hole look like a smoky blob.
  let shadowCore = 1.0 - smoothstep(shadowR * 0.70, shadowR * 0.84, r);
  let shadowFeather = 1.0 - smoothstep(shadowR * 0.84, shadowR * 1.00, r);
  col *= 1.0 - shadowFeather * 0.50;
  col = mix(col, vec3<f32>(0.0), shadowCore * 0.995);

  // Hot edge-on accretion disk. Separate lensed back arcs from the foreground
  // band so the silhouette stays black while the disk wraps around it.
  let diskTilt = -0.075;
  let c = cos(diskTilt);
  let s = sin(diskTilt);
  let q = vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
  let absX = abs(q.x);
  let diskOuter = shadowR * 3.65;
  let diskInner = shadowR * 0.76;

  let backEllipse = length(vec2<f32>(q.x / (shadowR * 2.55), (q.y + shadowR * 0.12) / (shadowR * 0.58)));
  let upperArcMask = smoothstep(-shadowR * 0.12, shadowR * 0.34, q.y);
  let upperArc = ring_gauss(backEllipse, 1.0, 0.075) * upperArcMask * disk_range(absX, diskInner, diskOuter);

  let lowerEllipse = length(vec2<f32>(q.x / (shadowR * 2.20), (q.y - shadowR * 0.16) / (shadowR * 0.45)));
  let lowerArcMask = 1.0 - smoothstep(-shadowR * 0.30, shadowR * 0.05, q.y);
  let lowerArc = ring_gauss(lowerEllipse, 1.0, 0.105) * lowerArcMask * disk_range(absX, diskInner, diskOuter) * 0.45;

  let frontY = q.y + shadowR * 0.20;
  let frontBand = exp(-pow(frontY / max(shadowR * 0.070, 0.0002), 2.0))
    * disk_range(absX, shadowR * 0.88, diskOuter * 1.16);

  let laneY = q.y + shadowR * 0.05;
  let dustLane = exp(-pow(laneY / max(shadowR * 0.050, 0.0002), 2.0))
    * disk_range(absX, shadowR * 0.82, diskOuter * 1.05);

  let orbit = q.x / max(shadowR, 0.0001);
  let bands = 0.72
    + 0.18 * sin(orbit * 10.0 - blackHole.params.x * 0.90)
    + 0.10 * sin(orbit * 24.0 + sin(orbit * 2.3) * 2.0 + blackHole.params.x * 0.35);
  let grain = 0.88 + 0.12 * hash1(floor((theta + PI) * 95.0) + floor(r / max(shadowR, 0.0001) * 28.0) * 17.0);
  let doppler = 0.58 + 1.18 * smoothstep(-1.0, 0.85, -dir.x);
  let redshift = 0.78 + 0.34 * smoothstep(shadowR * 2.6, shadowR * 0.65, r);
  let disk = max(max(upperArc * 1.20, lowerArc), frontBand * 1.05) * max(0.0, bands) * grain * doppler * redshift;

  let diskHot = mix(vec3<f32>(0.95, 0.28, 0.08), vec3<f32>(1.0, 0.86, 0.55), clamp(doppler * 0.48, 0.0, 1.0));
  let diskWarm = vec3<f32>(0.95, 0.40, 0.12);
  col += mix(diskWarm, diskHot, upperArc + frontBand) * disk * 0.52;
  col *= 1.0 - dustLane * 0.18;

  // Photon ring and secondary inner ring. Narrow, bright, and mostly white,
  // similar to the user references, instead of a broad orange haze.
  let photonAzimuth = 0.72 + 0.34 * smoothstep(-1.0, 0.92, -dir.x);
  let photon = ring_gauss(r, shadowR * 0.845, shadowR * 0.022) * photonAzimuth;
  let secondary = ring_gauss(r, shadowR * 0.955, shadowR * 0.030) * 0.38;
  let photonCol = mix(vec3<f32>(1.0, 0.52, 0.20), vec3<f32>(1.0, 0.93, 0.76), clamp(photonAzimuth * 0.65, 0.0, 1.0));
  col += photonCol * photon * 1.30;
  col += vec3<f32>(1.0, 0.70, 0.34) * secondary * 0.54;

  // Soft glow outside the disk. Kept subdued so it reads as plasma emission,
  // not as the hole itself becoming physically larger.
  let halo = ring_gauss(r, shadowR * 1.20, shadowR * 0.52) * lensMask;
  col += vec3<f32>(0.90, 0.22, 0.055) * halo * 0.060;
  col = mix(col, vec3<f32>(0.0), shadowCore * 0.998);

  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}

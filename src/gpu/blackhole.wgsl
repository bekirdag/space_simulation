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
  let invShadowR = 1.0 / max(shadowR, 0.0001);
  let u = r * invShadowR;
  let safeR = max(r, shadowR * 0.050);
  let dir = p / safeR;
  let tangent = vec2<f32>(-dir.y, dir.x);
  let theta = atan2(p.y, p.x);

  // Background lensing: approximate the reference simulations with a compact
  // strong-lensing zone near the photon ring plus a weaker far-field bend.
  let lensMask = 1.0 - smoothstep(4.3, 8.2, u);
  let photonFold = exp(-pow((u - 1.08) / 0.42, 2.0));
  let deflect = blackHole.params.w * shadowR *
    (0.50 / (u + 0.32) + 0.21 * photonFold) * lensMask;
  let spinShear = blackHole.params.w * shadowR * 0.030 * lensMask / (u + 0.55);
  let lensedAspect = p
    + dir * deflect
    + tangent * (spinShear + sin(theta * 2.0 + blackHole.params.x * 0.18) * shadowR * 0.004 * lensMask);
  let lensedUv = centerUv + vec2<f32>(lensedAspect.x / aspect, lensedAspect.y);
  let secondaryUv = centerUv + vec2<f32>(
    (-p.x * (1.0 + 0.13 / (u + 0.18)) + tangent.x * spinShear * 0.9) / aspect,
    -p.y * (1.0 + 0.13 / (u + 0.18)) + tangent.y * spinShear * 0.9
  );
  let secondaryImage = ring_gauss(u, 1.15, 0.42) * lensMask * 0.20;
  let nearLens = 1.0 - smoothstep(0.92, 3.85, u);
  let lensBlend = lensMask * (0.18 + 0.22 * smoothstep(1.00, 3.20, u));
  var col = mix(raw, sample_scene(lensedUv), lensBlend);
  col += sample_scene(secondaryUv) * secondaryImage;
  col = mix(col, vec3<f32>(0.002, 0.0018, 0.005), nearLens * 0.48);

  // Mild Kerr-like horizontal asymmetry. This is intentionally small because
  // Sgr A* spin/orientation is not fixed in the app data.
  let shadowSpinX = clamp(p.x * invShadowR, -1.0, 1.0);
  let shadowScaleX = 1.0 - 0.055 * smoothstep(-0.12, 0.95, shadowSpinX);
  let shadowP = vec2<f32>(
    (p.x + shadowR * 0.035) / max(shadowR * shadowScaleX, 0.0001),
    p.y * invShadowR
  );
  let shadowDist = length(shadowP);
  let shadowHard = 1.0 - smoothstep(0.88, 0.995, shadowDist);
  let shadowFeather = 1.0 - smoothstep(0.995, 1.18, shadowDist);
  col = mix(col, vec3<f32>(0.0), shadowFeather * 0.42);
  col = mix(col, vec3<f32>(0.0), shadowHard * 0.96);

  // Hot edge-on accretion disk. The top image is gravitationally lensed over
  // the hole while the thinner foreground band crosses the lower edge.
  let diskTilt = -0.065;
  let c = cos(diskTilt);
  let s = sin(diskTilt);
  let q = vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
  let qn = q * invShadowR;
  let absXn = abs(qn.x);
  let radialBand = smoothstep(0.82, 1.04, absXn) * (1.0 - smoothstep(3.55, 4.20, absXn));

  let backEllipse = length(vec2<f32>(qn.x / 2.72, (qn.y + 0.18) / 0.52));
  let upperArcMask = smoothstep(-0.10, 0.44, qn.y);
  let upperArc = ring_gauss(backEllipse, 1.0, 0.070) * upperArcMask * radialBand * (1.0 - shadowHard * 0.86);

  let lowerEllipse = length(vec2<f32>(qn.x / 2.22, (qn.y - 0.18) / 0.42));
  let lowerArcMask = 1.0 - smoothstep(-0.36, 0.05, qn.y);
  let lowerArc = ring_gauss(lowerEllipse, 1.0, 0.092) * lowerArcMask * radialBand * 0.38;

  let frontBand = exp(-pow((qn.y + 0.185) / 0.060, 2.0))
    * smoothstep(0.76, 1.00, absXn)
    * (1.0 - smoothstep(3.70, 4.35, absXn));

  let dustLane = exp(-pow((qn.y + 0.035) / 0.050, 2.0))
    * smoothstep(0.78, 1.02, absXn)
    * (1.0 - smoothstep(3.55, 4.10, absXn));

  let orbit = qn.x;
  let bands = 0.72
    + 0.16 * sin(orbit * 10.0 - blackHole.params.x * 0.72)
    + 0.08 * sin(orbit * 23.0 + sin(orbit * 2.1) * 1.8 + blackHole.params.x * 0.30);
  let grain = 0.86 + 0.14 * hash1(floor((theta + PI) * 110.0) + floor(u * 31.0) * 17.0);
  let doppler = 0.42 + 1.38 * smoothstep(-1.10, 0.78, -dir.x);
  let redshift = 0.70 + 0.42 * smoothstep(2.9, 0.72, u);
  let disk = max(max(upperArc * 1.25, lowerArc), frontBand * 1.12) * max(0.0, bands) * grain * doppler * redshift;

  let diskHot = mix(vec3<f32>(0.95, 0.26, 0.07), vec3<f32>(1.0, 0.90, 0.62), clamp(doppler * 0.50, 0.0, 1.0));
  let diskWarm = vec3<f32>(0.95, 0.40, 0.12);
  col += mix(diskWarm, diskHot, clamp(upperArc + frontBand, 0.0, 1.0)) * disk * 0.62;
  col *= 1.0 - dustLane * 0.22;

  // Photon ring: narrow, bright, and aligned to the actual apparent shadow
  // boundary instead of floating inside it.
  let photonAzimuth = 0.66 + 0.42 * smoothstep(-1.05, 0.86, -dir.x);
  let photon = ring_gauss(shadowDist, 1.015, 0.033) * photonAzimuth;
  let innerEcho = ring_gauss(shadowDist, 0.925, 0.026) * 0.22 * (1.0 - shadowHard);
  let outerEcho = ring_gauss(shadowDist, 1.118, 0.060) * 0.20;
  let photonCol = mix(vec3<f32>(1.0, 0.50, 0.18), vec3<f32>(1.0, 0.95, 0.78), clamp(photonAzimuth * 0.66, 0.0, 1.0));
  col += photonCol * photon * 1.45;
  col += vec3<f32>(1.0, 0.70, 0.34) * (innerEcho + outerEcho) * 0.46;

  // Soft glow outside the disk. Kept subdued so it reads as plasma emission,
  // not as the hole itself becoming physically larger.
  let halo = ring_gauss(u, 1.28, 0.58) * lensMask;
  col += vec3<f32>(0.88, 0.20, 0.052) * halo * 0.050;

  let finalCore = 1.0 - smoothstep(0.84, 0.98, shadowDist);
  let finalFeather = 1.0 - smoothstep(0.98, 1.10, shadowDist);
  col = mix(col, vec3<f32>(0.0), finalFeather * 0.35);
  col = mix(col, vec3<f32>(0.0), finalCore * 0.998);

  return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
}

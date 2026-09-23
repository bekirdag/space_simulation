// HDR presentation post-process with a procedural Sagittarius A* view.
//
// The base scene is rendered into an HDR texture first. This pass adds the
// raymarched black-hole shadow/accretion disk, applies the cinematic travel
// warp, and tone maps to the swap-chain format.

struct Camera {
  viewProj:         mat4x4<f32>,
  rightAndMNR:      vec4<f32>,
  upAndFocal:       vec4<f32>,
  eyeAndFlags:      vec4<f32>,
  screenAndTarget:  vec4<f32>,
  eyeOffset:        vec4<f32>,
};

struct BlackHole {
  // xyz = Sgr A* world position, w = event-horizon radius in AU
  pos_size: vec4<f32>,
  // x = time, y = viewport width, z = viewport height, w = visual strength
  params:   vec4<f32>,
  // x = cinematic flight space-warp strength, y = cinematic motion-blur strength
  flight:   vec4<f32>,
};

struct BlackHoleSample {
  color:     vec3<f32>,
  alpha:     f32,
  occlusion: f32,
  minR:      f32,
};

const HDR_EXPOSURE: f32 = 0.92;
const BLOOM_STRENGTH: f32 = 0.72;
const PI: f32 = 3.141592653589793;

const DISK_INNER_RADIUS: f32 = 4.1;
const DISK_OUTER_RADIUS: f32 = 14.5;
const DISK_TEMPERATURE: f32 = 49.78;
const TEMPERATURE_FALLOFF: f32 = 5.22;
const DISK_BRIGHTNESS: f32 = 5.0;
const DISK_ROTATION_SPEED: f32 = -8.7;
const TURBULENCE_SCALE: f32 = 1.81;
const TURBULENCE_STRETCH: f32 = 0.75;
const TURBULENCE_SHARPNESS: f32 = 7.4;
const TURBULENCE_CYCLE_TIME: f32 = 5.0;
const TURBULENCE_LACUNARITY: f32 = 2.5;
const TURBULENCE_PERSISTENCE: f32 = 0.8;
const DISK_EDGE_SOFTNESS_INNER: f32 = 0.18;
const DISK_EDGE_SOFTNESS_OUTER: f32 = 0.5;
const DOPPLER_STRENGTH: f32 = 0.42;
// Geodesics are integrated in Schwarzschild-radius units (Rs = 1), so all of
// the procedural logic below is independent of the world's AU scale.
const PHOTON_SPHERE_RS: f32 = 1.5;
// Critical impact parameter 3*sqrt(3)/2 Rs: apparent radius of the shadow.
const SHADOW_RADIUS_RS: f32 = 2.598076;
// Rays are only integrated inside this sphere; outside it bending is tiny.
const BOUNDING_RADIUS_RS: f32 = 116.0; // 8 x DISK_OUTER_RADIUS
const MAX_RAY_STEPS: i32 = 220;
const MAX_DISK_CROSSINGS: i32 = 3;
// Image LOD: the EHT image's half-width covers this many Rs; its opaque
// shadow is sized from SHADOW_RADIUS_RS in the same units.
const LOD_IMAGE_HALF_RS: f32 = 12.0;
const LOD_MIN_RADIUS_UV: f32 = 0.010;
// Procedural -> image handover, keyed on the physical on-screen image
// half-radius (uv units of viewport height). Always above LOD_MIN_RADIUS_UV
// so both representations have identical size and shadow during the fade.
const LOD_HANDOVER_START_UV: f32 = 0.020;
const LOD_HANDOVER_END_UV: f32 = 0.011;
const LOD_FADE_OUT_START_RS: f32 = 260000.0;
const LOD_FADE_OUT_END_RS: f32 = 760000.0;

@group(0) @binding(0) var<uniform> camera:    Camera;
@group(0) @binding(1) var<uniform> blackHole: BlackHole;
@group(0) @binding(2) var sceneTex: texture_2d<f32>;
@group(0) @binding(3) var sceneSampler: sampler;
@group(0) @binding(4) var bloomTex: texture_2d<f32>;
@group(0) @binding(5) var bloomSampler: sampler;
@group(0) @binding(6) var blackHoleLodTex: texture_2d<f32>;
@group(0) @binding(7) var blackHoleLodSampler: sampler;

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

fn camera_back() -> vec3<f32> {
  return normalize(cross(camera.rightAndMNR.xyz, camera.upAndFocal.xyz));
}

fn camera_forward() -> vec3<f32> {
  return -camera_back();
}

fn camera_relative(posWorld: vec3<f32>) -> vec3<f32> {
  return (posWorld - camera.screenAndTarget.yzw) - camera.eyeOffset.xyz;
}

fn project_world(posWorld: vec3<f32>) -> vec4<f32> {
  let rel = camera_relative(posWorld);
  let back = camera_back();
  let viewPos = vec3<f32>(
    dot(rel, camera.rightAndMNR.xyz),
    dot(rel, camera.upAndFocal.xyz),
    dot(rel, back)
  );
  let cameraNear = 1e-8;
  let cameraFar = 500000000.0;
  let nf = 1.0 / (cameraNear - cameraFar);
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let focalY = camera.upAndFocal.w;
  return vec4<f32>(
    viewPos.x * focalY / aspect,
    viewPos.y * focalY,
    cameraFar * nf * viewPos.z + cameraFar * cameraNear * nf,
    -viewPos.z
  );
}

fn screen_ray(uv: vec2<f32>) -> vec3<f32> {
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let focalY = max(camera.upAndFocal.w, 0.000001);
  let screen = vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  return normalize(
    camera_forward() +
    camera.rightAndMNR.xyz * (screen.x * aspect / focalY) +
    camera.upAndFocal.xyz * (screen.y / focalY)
  );
}

fn black_hole_space(v: vec3<f32>) -> vec3<f32> {
  let diskNormal = normalize(vec3<f32>(0.24, 0.55, 0.80));
  let diskRight = normalize(cross(vec3<f32>(0.0, 0.0, 1.0), diskNormal));
  let diskForward = normalize(cross(diskNormal, diskRight));
  return vec3<f32>(dot(v, diskRight), dot(v, diskNormal), dot(v, diskForward));
}

fn hash21(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn hash31(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453);
}

fn noise3d(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (vec3<f32>(3.0) - f * 2.0);
  let a = hash31(i);
  let b = hash31(i + vec3<f32>(1.0, 0.0, 0.0));
  let c = hash31(i + vec3<f32>(0.0, 1.0, 0.0));
  let d = hash31(i + vec3<f32>(1.0, 1.0, 0.0));
  let e = hash31(i + vec3<f32>(0.0, 0.0, 1.0));
  let f2 = hash31(i + vec3<f32>(1.0, 0.0, 1.0));
  let g = hash31(i + vec3<f32>(0.0, 1.0, 1.0));
  let h = hash31(i + vec3<f32>(1.0, 1.0, 1.0));
  return mix(
    mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
    mix(mix(e, f2, u.x), mix(g, h, u.x), u.y),
    u.z
  );
}

fn fbm(p: vec3<f32>, lacunarity: f32, persistence: f32) -> f32 {
  var value = 0.0;
  var amplitude = 0.5;
  var pos = p;
  for (var i: i32 = 0; i < 4; i = i + 1) {
    value += noise3d(pos) * amplitude;
    pos *= lacunarity;
    amplitude *= persistence;
  }
  return value;
}

fn blackbody_color(tempK: f32) -> vec3<f32> {
  let t = clamp((tempK - 1000.0) / 9000.0, 0.0, 1.0);
  let ember = vec3<f32>(0.50, 0.14, 0.035);
  let orange = vec3<f32>(1.00, 0.42, 0.08);
  let gold = vec3<f32>(1.00, 0.70, 0.22);
  let whiteGold = vec3<f32>(1.00, 0.92, 0.66);
  let low = mix(ember, orange, smoothstep(0.0, 0.45, t));
  let high = mix(gold, whiteGold, smoothstep(0.45, 1.0, t));
  return mix(low, high, smoothstep(0.22, 0.88, t));
}

fn rotate_disk_unit(unitXZ: vec2<f32>, angle: f32) -> vec2<f32> {
  let c = cos(angle);
  let s = sin(angle);
  return vec2<f32>(
    unitXZ.x * c - unitXZ.y * s,
    unitXZ.y * c + unitXZ.x * s
  );
}

fn accretion_disk_color(hitR: f32, unitXZ: vec2<f32>, time: f32, rayDir: vec3<f32>) -> vec4<f32> {
  let normR = clamp((hitR - DISK_INNER_RADIUS) / (DISK_OUTER_RADIUS - DISK_INNER_RADIUS), 0.0, 1.0);
  let peakTempK = DISK_TEMPERATURE * 1000.0;
  let outerTempK = 1500.0;
  let tempFalloff = pow(DISK_INNER_RADIUS / hitR, TEMPERATURE_FALLOFF);
  let tempK = mix(outerTempK, peakTempK, tempFalloff);
  var diskColor = blackbody_color(tempK);

  let rotationSign = sign(DISK_ROTATION_SPEED);
  let velocityDir = normalize(vec3<f32>(-unitXZ.y * rotationSign, 0.0, unitXZ.x * rotationSign));
  let velocityMagnitude = 1.0 / sqrt(hitR / DISK_INNER_RADIUS);
  let beta = velocityMagnitude * 0.3;
  let cosTheta = dot(velocityDir, rayDir);
  let dopplerFactor = 1.0 / max(1.0 - beta * cosTheta, 0.12);
  let dopplerBoost = pow(dopplerFactor, 3.0 * DOPPLER_STRENGTH);
  diskColor *= clamp(dopplerBoost, 0.22, 2.65);

  let edgeFalloff =
    smoothstep(0.0, DISK_EDGE_SOFTNESS_INNER, normR) *
    (1.0 - smoothstep(1.0 - DISK_EDGE_SOFTNESS_OUTER, 1.0, normR));

  let cyclicTime = time - floor(time / TURBULENCE_CYCLE_TIME) * TURBULENCE_CYCLE_TIME;
  let blendFactor = cyclicTime / TURBULENCE_CYCLE_TIME;
  let keplerianPhase1 = cyclicTime * DISK_ROTATION_SPEED / pow(hitR, 1.5);
  let keplerianPhase2 = (cyclicTime + TURBULENCE_CYCLE_TIME) * DISK_ROTATION_SPEED / pow(hitR, 1.5);
  let unit1 = rotate_disk_unit(unitXZ, keplerianPhase1);
  let unit2 = rotate_disk_unit(unitXZ, keplerianPhase2);
  let noiseCoord1 = vec3<f32>(
    hitR * TURBULENCE_SCALE,
    unit1.x / max(TURBULENCE_STRETCH, 0.1),
    unit1.y / max(TURBULENCE_STRETCH, 0.1)
  );
  let noiseCoord2 = vec3<f32>(
    hitR * TURBULENCE_SCALE,
    unit2.x / max(TURBULENCE_STRETCH, 0.1),
    unit2.y / max(TURBULENCE_STRETCH, 0.1)
  );
  let turbulence1 = fbm(noiseCoord1, TURBULENCE_LACUNARITY, TURBULENCE_PERSISTENCE);
  let turbulence2 = fbm(noiseCoord2, TURBULENCE_LACUNARITY, TURBULENCE_PERSISTENCE);
  let turbulence = mix(turbulence2, turbulence1, blendFactor);
  let ringOpacity = pow(clamp(turbulence, 0.0, 1.0), TURBULENCE_SHARPNESS);
  let filamentLift = smoothstep(0.35, 0.92, turbulence) * 0.18;
  let finalOpacity = clamp((ringOpacity + filamentLift) * edgeFalloff, 0.0, 1.0);
  let radialGlow = 0.48 + (1.0 - normR) * 0.72;
  let finalColor = diskColor * DISK_BRIGHTNESS * radialGlow;
  return vec4<f32>(finalColor, finalOpacity);
}

fn black_hole_accel(x: vec3<f32>, h2: f32) -> vec3<f32> {
  // Photon path in Schwarzschild geometry (Rs = 1): x'' = -1.5 h^2 x / r^5.
  let r2 = max(dot(x, x), 1e-6);
  return -1.5 * h2 * x / (r2 * r2 * sqrt(r2));
}

// camPos: camera position relative to the hole, in Rs. pixelAngle: angular
// size of one pixel (radians), used to anti-alias the shadow edge and ring.
fn raymarch_black_hole(camPos: vec3<f32>, rayDir0: vec3<f32>, time: f32, pixelAngle: f32) -> BlackHoleSample {
  let dir = normalize(rayDir0);
  var color = vec3<f32>(0.0);
  var alpha = 0.0;
  let empty = BlackHoleSample(color, 0.0, 0.0, 1e5);

  // Conserved impact parameter and closest-approach distance along the ray.
  let impact = length(cross(camPos, dir));
  let tClosest = -dot(camPos, dir);
  let camR = length(camPos);
  let R = BOUNDING_RADIUS_RS;

  // Start marching where the ray enters the bounding sphere.
  var tStart = 0.0;
  if camR > R {
    if impact >= R || tClosest <= 0.0 {
      return empty;
    }
    tStart = tClosest - sqrt(max(R * R - impact * impact, 0.0));
  }

  var x = camPos + dir * tStart;
  var v = dir;
  let h2 = impact * impact;
  var a = black_hole_accel(x, h2);
  var minR = 1e5;
  var crossings: i32 = 0;

  // Quality: flight.z >= 1 lengthens each step and shrinks the step budget
  // proportionally, so rays still cover the same distance (1 = full quality).
  let stepScale = clamp(blackHole.flight.z, 1.0, 4.0);
  let maxSteps = i32(ceil(f32(MAX_RAY_STEPS) / stepScale));
  for (var i: i32 = 0; i < MAX_RAY_STEPS; i = i + 1) {
    if i >= maxSteps {
      break;
    }
    let r = length(x);
    minR = min(minR, r);
    if alpha > 0.995 {
      break;
    }
    // Inside the photon sphere and falling inward: certain capture.
    if r < 1.0 || (r < PHOTON_SPHERE_RS && dot(x, v) < 0.0) {
      break;
    }
    if r > R * 1.001 && dot(x, v) > 0.0 {
      break;
    }

    let dt = clamp(0.08 * r, 0.02, 2.5) * stepScale;
    let prev = x;
    // Kick-drift-kick leapfrog.
    v += a * (0.5 * dt);
    x += v * dt;
    a = black_hole_accel(x, h2);
    v += a * (0.5 * dt);

    if prev.y * x.y <= 0.0 && abs(x.y - prev.y) > 1e-6 && crossings < MAX_DISK_CROSSINGS {
      let t = clamp(-prev.y / (x.y - prev.y), 0.0, 1.0);
      let hitPos = mix(prev, x, t);
      let hitR = length(hitPos.xz);
      if hitR > DISK_INNER_RADIUS && hitR < DISK_OUTER_RADIUS {
        let unitXZ = hitPos.xz / max(hitR, 0.0001);
        let disk = accretion_disk_color(hitR, unitXZ, time, normalize(v));
        // Front-to-back: nearer samples already occlude later ones.
        let w = disk.w * (1.0 - alpha);
        color += disk.xyz * w;
        alpha += w;
        crossings = crossings + 1;
      }
    }
  }

  // Shadow and photon ring from the exact critical impact parameter, so the
  // ring always sits on the shadow edge regardless of step size.
  let pixelRs = max(pixelAngle * max(tClosest, 1.0), 0.002);
  let edgeWidth = max(pixelRs, 0.01);
  let approaching = tClosest > 0.0 || camR < PHOTON_SPHERE_RS;
  let shadowCov = select(0.0, 1.0 - smoothstep(SHADOW_RADIUS_RS - edgeWidth, SHADOW_RADIUS_RS + edgeWidth, impact), approaching);

  let ringWidth = max(0.05, pixelRs * 0.9);
  let ringX = (impact - SHADOW_RADIUS_RS - ringWidth * 0.6) / ringWidth;
  // Keep the ring's integrated brightness roughly constant when it gets thin
  // on screen instead of letting it bloom into a halo.
  let ringEnergy = sqrt(0.05 / ringWidth);
  let photonRing = exp(-ringX * ringX) * ringEnergy;
  let haloX = max(impact - SHADOW_RADIUS_RS, 0.0) / max(0.9, pixelRs * 2.0);
  let secondaryRing = exp(-haloX * haloX) * select(0.0, 1.0, impact > SHADOW_RADIUS_RS);
  let ringColor = vec3<f32>(1.0, 0.66, 0.20) * photonRing * 3.1 +
    vec3<f32>(1.0, 0.88, 0.62) * secondaryRing * 0.24;
  color += ringColor * (1.0 - alpha) * select(0.0, 1.0, approaching);

  // Shadow only adds coverage behind what is already in front of it.
  alpha += (1.0 - alpha) * shadowCov;

  return BlackHoleSample(color, clamp(alpha, 0.0, 1.0), shadowCov, minR);
}

fn apply_black_hole_scene_lensing(sceneColor: vec3<f32>, uv: vec2<f32>, centerUv: vec2<f32>, radiusUv: f32, strength: f32) -> vec3<f32> {
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let delta = (uv - centerUv) * vec2<f32>(aspect, 1.0);
  let radius = length(delta);
  if radius <= 0.0001 {
    return sceneColor;
  }

  let window = (1.0 - smoothstep(radiusUv * 1.1, radiusUv * 3.2 + 0.08, radius)) *
    smoothstep(0.0, radiusUv * 2.2 + 0.08, radius);
  if window <= 0.001 {
    return sceneColor;
  }

  // Radial direction in aspect-corrected space, mapped back to uv units.
  let dir = (delta / radius) / vec2<f32>(aspect, 1.0);
  let pull = min(strength * window * radiusUv * radiusUv / max(radius, 0.025), 0.12);
  let lensedUv = uv - dir * pull;
  // Return only the displaced sample: the pull already tapers to zero at the
  // window edges. Blending with the unlensed scene drew every star twice.
  return sample_composite(lensedUv);
}

// Composites the distant EHT image LOD fully over sceneColor; the caller fades
// the result. halfRadiusUv is the image half-width in viewport-height uv.
fn apply_black_hole_image_lod(sceneColor: vec3<f32>, uv: vec2<f32>, centerUv: vec2<f32>, halfRadiusUv: f32) -> vec3<f32> {
  if halfRadiusUv <= 0.0001 {
    return sceneColor;
  }

  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let delta = (uv - centerUv) * vec2<f32>(aspect, 1.0) / halfRadiusUv;
  let r = length(delta);
  if r > 1.12 {
    return sceneColor;
  }

  // Opaque shadow sized from the real critical impact parameter, feathered
  // by about one pixel.
  let viewportH = max(blackHole.params.z, 1.0);
  let pixelImage = 1.0 / (viewportH * halfRadiusUv);
  let shadowR = SHADOW_RADIUS_RS / LOD_IMAGE_HALF_RS;
  let shadowCov = 1.0 - smoothstep(shadowR - pixelImage, shadowR + pixelImage, r);

  let imageUv = delta * 0.5 + vec2<f32>(0.5);
  var imageColor = vec3<f32>(0.0);
  if imageUv.x >= 0.0 && imageUv.x <= 1.0 && imageUv.y >= 0.0 && imageUv.y <= 1.0 {
    imageColor = textureSampleLevel(blackHoleLodTex, blackHoleLodSampler, imageUv, 0.0).rgb;
  }
  let luma = dot(imageColor, vec3<f32>(0.2126, 0.7152, 0.0722));
  let edgeFeather = 1.0 - smoothstep(0.88, 1.10, r);
  let diskAlpha = smoothstep(0.025, 0.18, luma) * edgeFeather * (1.0 - shadowCov);
  let warmColor = imageColor * vec3<f32>(1.10, 0.94, 0.76);
  let hdrColor = warmColor * (2.2 + smoothstep(0.12, 0.78, luma) * 3.4);
  let behind = sceneColor * (1.0 - shadowCov);
  return behind * (1.0 - diskAlpha) + hdrColor * diskAlpha;
}

struct BlackHoleView {
  valid:          bool,
  centerUv:       vec2<f32>,
  distanceRs:     f32,
  // viewport-height uv per Rs at the hole's distance
  uvPerRs:        f32,
  proceduralFade: f32,
  lodFade:        f32,
  lodRadiusUv:    f32,
};

fn black_hole_view() -> BlackHoleView {
  var bh: BlackHoleView;
  bh.valid = false;
  let strength = clamp(blackHole.params.w, 0.0, 1.0);
  let eventRadiusAU = max(blackHole.pos_size.w, 0.0);
  if strength <= 0.001 || eventRadiusAU <= 0.0 {
    return bh;
  }
  let centerRelWorld = camera_relative(blackHole.pos_size.xyz);
  bh.distanceRs = length(centerRelWorld) / eventRadiusAU;
  if bh.distanceRs > LOD_FADE_OUT_END_RS {
    return bh;
  }
  let centerClip = project_world(blackHole.pos_size.xyz);
  if centerClip.w <= 0.0 {
    return bh;
  }
  let centerNdc = centerClip.xy / max(centerClip.w, 0.000001);
  bh.centerUv = vec2<f32>(centerNdc.x * 0.5 + 0.5, 0.5 - centerNdc.y * 0.5);
  bh.uvPerRs = 0.5 * eventRadiusAU * camera.upAndFocal.w / max(centerClip.w, 0.000001);

  let physicalLodUv = LOD_IMAGE_HALF_RS * bh.uvPerRs;
  let handover = 1.0 - smoothstep(LOD_HANDOVER_END_UV, LOD_HANDOVER_START_UV, physicalLodUv);
  let farFade = (1.0 - smoothstep(LOD_FADE_OUT_START_RS, LOD_FADE_OUT_END_RS, bh.distanceRs)) * strength;
  bh.proceduralFade = (1.0 - handover) * strength;
  bh.lodFade = handover * farFade;
  bh.lodRadiusUv = max(physicalLodUv, LOD_MIN_RADIUS_UV);
  bh.valid = true;
  return bh;
}

// Analytic shadow coverage at uv (both LODs share the same shadow), used to
// keep resampling passes such as the flight warp from leaking stars into it.
fn black_hole_shadow_mask(uv: vec2<f32>) -> f32 {
  let bh = black_hole_view();
  if !bh.valid {
    return 0.0;
  }
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let screenRadius = length((uv - bh.centerUv) * vec2<f32>(aspect, 1.0));
  let pixelUv = 1.0 / max(blackHole.params.z, 1.0);
  let proceduralR = SHADOW_RADIUS_RS * bh.uvPerRs;
  let lodR = SHADOW_RADIUS_RS / LOD_IMAGE_HALF_RS * bh.lodRadiusUv;
  let proceduralCov = 1.0 - smoothstep(proceduralR - pixelUv, proceduralR + pixelUv, screenRadius);
  let lodCov = 1.0 - smoothstep(lodR - pixelUv, lodR + pixelUv, screenRadius);
  return max(proceduralCov * bh.proceduralFade, lodCov * bh.lodFade);
}

fn black_hole_composite(sceneColor: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let bh = black_hole_view();
  if !bh.valid {
    return sceneColor;
  }

  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let screenRadius = length((uv - bh.centerUv) * vec2<f32>(aspect, 1.0));
  var result = sceneColor;

  if bh.lodFade > 0.001 && screenRadius <= bh.lodRadiusUv * 1.13 {
    let lod = apply_black_hole_image_lod(sceneColor, uv, bh.centerUv, bh.lodRadiusUv);
    result = mix(sceneColor, lod, bh.lodFade);
  }

  if bh.proceduralFade > 0.001 {
    let diskRadiusUv = clamp(DISK_OUTER_RADIUS * bh.uvPerRs, 0.012, 0.92);
    var base = apply_black_hole_scene_lensing(sceneColor, uv, bh.centerUv, diskRadiusUv, 1.0);

    let eventRadiusAU = blackHole.pos_size.w;
    let camPos = black_hole_space(-camera_relative(blackHole.pos_size.xyz)) / eventRadiusAU;
    // Skip the march for pixels whose ray misses the bounding sphere.
    let sphereUv = BOUNDING_RADIUS_RS * bh.uvPerRs * 1.05;
    if bh.distanceRs <= BOUNDING_RADIUS_RS * 1.2 || screenRadius <= sphereUv {
      let focalY = max(camera.upAndFocal.w, 0.000001);
      let pixelAngle = 2.0 / (focalY * max(blackHole.params.z, 1.0));
      let rayDir = black_hole_space(screen_ray(uv));
      let sample = raymarch_black_hole(camPos, rayDir, blackHole.params.x, pixelAngle);
      // Front-to-back: sample.color is premultiplied, alpha covers the scene.
      base = sample.color + base * (1.0 - sample.alpha);
    }
    // Fade only the output; geometry and bending stay physical.
    result = mix(result, base, bh.proceduralFade);
  }
  return result;
}

fn apply_flight_warp(hdrColor: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let warpStrength = clamp(blackHole.flight.x, 0.0, 1.0);
  let blurStrength = clamp(blackHole.flight.y, 0.0, 1.0);
  let base = hdrColor;
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

  // Resampled taps come from the raw scene; mask them by the black-hole
  // shadow at the tap position so they cannot reintroduce stars inside it.
  let warpedTap = sample_composite(warpedUv) * (1.0 - black_hole_shadow_mask(warpedUv));
  var col = mix(base, warpedTap, warpAmount * 0.52);
  var weight = 1.0;
  if blurAmount > 0.001 {
    for (var i: i32 = 1; i <= 5; i = i + 1) {
      let t = f32(i) / 5.0;
      let tapUv = warpedUv - dir * blurAmount * (pixelSpan * 2.0 + 0.070 * t);
      let tapWeight = (1.0 - t * 0.12) * 0.13;
      col += sample_composite(tapUv) * (1.0 - black_hole_shadow_mask(tapUv)) * tapWeight;
      weight += tapWeight;
    }
  }

  let forwardUv = warpedUv - dir * effectAmount * 0.095;
  let forwardTap = sample_bloom(forwardUv) * (1.0 - black_hole_shadow_mask(forwardUv));
  let sideGlow = smoothstep(0.22, 0.95, radius) * (1.0 - smoothstep(1.02, 1.28, radius));
  let warpTint = vec3<f32>(0.035, 0.050, 0.080) * warpAmount * sideGlow;
  return col / max(weight, 0.0001) + forwardTap * effectAmount * 0.75 + warpTint;
}

fn present_color(hdrColor: vec3<f32>, uv: vec2<f32>) -> vec4<f32> {
  // Bloom is added before the black hole composite so the shadow occludes
  // bloomed stars behind it instead of glowing blurry stars through it.
  let withBlackHole = black_hole_composite(hdrColor + sample_bloom(uv), uv);
  return vec4<f32>(aces_tonemap(apply_flight_warp(withBlackHole, uv)), 1.0);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  return present_color(sample_scene(in.uv), in.uv);
}

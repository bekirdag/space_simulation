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
const GRAVITATIONAL_LENSING: f32 = 2.4;
const DOPPLER_STRENGTH: f32 = 0.42;
const RAY_STEP_SIZE: f32 = 0.85;
const PROCEDURAL_FADE_START_RS: f32 = 5200.0;
const PROCEDURAL_FADE_END_RS: f32 = 9000.0;
const LOD_FADE_IN_START_RS: f32 = 850.0;
const LOD_FADE_IN_END_RS: f32 = 6000.0;
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
  let view = vec3<f32>(
    dot(rel, camera.rightAndMNR.xyz),
    dot(rel, camera.upAndFocal.xyz),
    dot(rel, back)
  );
  let cameraNear = 1e-8;
  let cameraFar = 50000000.0;
  let nf = 1.0 / (cameraNear - cameraFar);
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let focalY = camera.upAndFocal.w;
  return vec4<f32>(
    view.x * focalY / aspect,
    view.y * focalY,
    cameraFar * nf * view.z + cameraFar * cameraNear * nf,
    -view.z
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

fn raymarch_black_hole(rayPos0: vec3<f32>, rayDir0: vec3<f32>, time: f32, visualStrength: f32) -> BlackHoleSample {
  let rs = 1.0;
  var rayPos = rayPos0;
  var rayDir = normalize(rayDir0);
  var prevPos = rayPos0;
  var color = vec3<f32>(0.0);
  var alpha = 0.0;
  var occlusion = 0.0;
  var minR = 100000.0;
  var diskCrossings: i32 = 0;
  var foregroundDiskAlpha = 0.0;
  var captured = false;
  var escaped = false;

  for (var i: i32 = 0; i < 72; i = i + 1) {
    if captured || escaped || alpha > 0.99 {
      break;
    }

    let r = length(rayPos);
    minR = min(minR, r);

    if r < rs * 1.015 {
      captured = true;
      break;
    }

    if r > 115.0 && dot(rayPos, rayDir) > 0.0 {
      escaped = true;
      break;
    }

    let toCenter = -rayPos / max(r, 0.0001);
    let bendStrength = rs / max(r * r, 0.0001) * RAY_STEP_SIZE * GRAVITATIONAL_LENSING * visualStrength;
    rayDir = normalize(rayDir + toCenter * bendStrength);

    prevPos = rayPos;
    rayPos += rayDir * RAY_STEP_SIZE;

    let crossedPlane = prevPos.y * rayPos.y <= 0.0 && abs(rayPos.y - prevPos.y) > 0.00001;
    if crossedPlane && alpha < 0.99 {
      let t = clamp(-prevPos.y / (rayPos.y - prevPos.y), 0.0, 1.0);
      let hitPos = mix(prevPos, rayPos, t);
      let hitR = length(hitPos.xz);
      if diskCrossings < 1 && hitR > DISK_INNER_RADIUS && hitR < DISK_OUTER_RADIUS {
        let unitXZ = hitPos.xz / max(hitR, 0.0001);
        let disk = accretion_disk_color(hitR, unitXZ, time, rayDir);
        let shadowDiskMask = 1.0 - smoothstep(1.62, 1.02, minR) * 0.96;
        let diskAlpha = disk.w * shadowDiskMask;
        let cameraSide = dot(normalize(hitPos), normalize(rayPos0));
        let foregroundWeight = smoothstep(-0.10, 0.35, cameraSide);
        foregroundDiskAlpha = max(foregroundDiskAlpha, diskAlpha * foregroundWeight);
        let remainingAlpha = 1.0 - alpha;
        color += disk.xyz * diskAlpha * remainingAlpha;
        alpha += diskAlpha * remainingAlpha;
        diskCrossings = diskCrossings + 1;
      }
    }
  }

  let photonRing = pow(1.0 - smoothstep(0.025, 0.16, abs(minR - 1.54)), 2.0);
  let secondaryRing = pow(1.0 - smoothstep(0.05, 0.30, abs(minR - 2.12)), 2.0);
  var captureShadow = 0.0;
  if captured {
    captureShadow = 1.0;
  }
  let shadowInterior = max(smoothstep(1.46, 1.04, minR), captureShadow);
  let hardCoreShadow = max(smoothstep(1.34, 1.08, minR), captureShadow);
  let foregroundDiskProtection = smoothstep(0.015, 0.18, foregroundDiskAlpha) * 0.92;
  let protectedOuterShadow = shadowInterior * (1.0 - foregroundDiskProtection * (1.0 - hardCoreShadow));
  let visibleShadowInterior = max(hardCoreShadow, protectedOuterShadow);
  color *= 1.0 - visibleShadowInterior * 0.995;
  alpha = max(alpha, visibleShadowInterior * 0.96);
  occlusion = max(occlusion, visibleShadowInterior);

  let ringColor = vec3<f32>(1.0, 0.66, 0.20) * photonRing * 3.1 +
    vec3<f32>(1.0, 0.88, 0.62) * secondaryRing * 0.24;
  color += ringColor * (1.0 - alpha * 0.35);
  alpha = max(alpha, photonRing * 0.42 + secondaryRing * 0.18);

  return BlackHoleSample(color, clamp(alpha, 0.0, 1.0), clamp(occlusion, 0.0, 1.0), minR);
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

  let dir = (uv - centerUv) / max(length(uv - centerUv), 0.0001);
  let pull = min(strength * window * radiusUv * radiusUv / max(radius, 0.025), 0.12);
  let lensedUv = uv - dir * pull;
  let lensed = sample_composite(lensedUv);
  return mix(sceneColor, lensed, clamp(window * 0.62, 0.0, 0.82));
}

fn apply_black_hole_image_lod(sceneColor: vec3<f32>, uv: vec2<f32>, centerUv: vec2<f32>, radiusUv: f32, opacity: f32) -> vec3<f32> {
  if opacity <= 0.001 || radiusUv <= 0.0001 {
    return sceneColor;
  }

  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let delta = (uv - centerUv) * vec2<f32>(aspect, 1.0) / radiusUv;
  let r = length(delta);
  if r > 1.12 {
    return sceneColor;
  }

  let imageUv = delta * 0.5 + vec2<f32>(0.5);
  if imageUv.x < 0.0 || imageUv.x > 1.0 || imageUv.y < 0.0 || imageUv.y > 1.0 {
    return sceneColor;
  }

  let imageColor = textureSampleLevel(blackHoleLodTex, blackHoleLodSampler, imageUv, 0.0).rgb;
  let luma = dot(imageColor, vec3<f32>(0.2126, 0.7152, 0.0722));
  let edgeFeather = 1.0 - smoothstep(0.88, 1.10, r);
  let diskAlpha = smoothstep(0.025, 0.18, luma) * edgeFeather;
  let shadowAlpha = (1.0 - smoothstep(0.20, 0.38, r)) * edgeFeather * 0.72;
  let alpha = clamp(max(diskAlpha, shadowAlpha) * opacity, 0.0, 0.9);
  let warmColor = imageColor * vec3<f32>(1.10, 0.94, 0.76);
  let hdrColor = warmColor * (2.2 + smoothstep(0.12, 0.78, luma) * 3.4);
  return sceneColor * (1.0 - alpha) + hdrColor * alpha;
}

fn black_hole_composite(sceneColor: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let strength = clamp(blackHole.params.w, 0.0, 1.0);
  let eventRadiusAU = max(blackHole.pos_size.w, 0.0);
  if strength <= 0.001 || eventRadiusAU <= 0.0 {
    return sceneColor;
  }

  let centerRelWorld = camera_relative(blackHole.pos_size.xyz);
  let centerDistanceAU = length(centerRelWorld);
  let distanceRs = centerDistanceAU / eventRadiusAU;
  if distanceRs > LOD_FADE_OUT_END_RS {
    return sceneColor;
  }

  let centerClip = project_world(blackHole.pos_size.xyz);
  if centerClip.w <= 0.0 {
    return sceneColor;
  }

  let centerNdc = centerClip.xy / max(centerClip.w, 0.000001);
  let centerUv = vec2<f32>(centerNdc.x * 0.5 + 0.5, 0.5 - centerNdc.y * 0.5);
  let diskRadiusNdcY = DISK_OUTER_RADIUS * eventRadiusAU * camera.upAndFocal.w / max(centerClip.w, 0.000001);
  let physicalDiskRadiusUv = max(diskRadiusNdcY * 0.5, 0.0);
  let diskRadiusUv = clamp(physicalDiskRadiusUv, 0.012, 0.92);
  let lodRadiusUv = clamp(max(physicalDiskRadiusUv * 8.0, 0.012), 0.012, 0.075);
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let screenRadius = length((uv - centerUv) * vec2<f32>(aspect, 1.0));

  let proceduralFade = (1.0 - smoothstep(PROCEDURAL_FADE_START_RS, PROCEDURAL_FADE_END_RS, distanceRs)) * strength;
  let lodFade = smoothstep(LOD_FADE_IN_START_RS, LOD_FADE_IN_END_RS, distanceRs) *
    (1.0 - smoothstep(LOD_FADE_OUT_START_RS, LOD_FADE_OUT_END_RS, distanceRs)) *
    strength;
  let proceduralWindowRadius = select(0.0, diskRadiusUv * 3.35 + 0.12, proceduralFade > 0.001);
  let lodWindowRadius = select(0.0, lodRadiusUv * 1.16, lodFade > 0.001);
  let effectWindowRadius = max(proceduralWindowRadius, lodWindowRadius);

  var base = sceneColor;
  if proceduralFade > 0.001 {
    base = apply_black_hole_scene_lensing(base, uv, centerUv, diskRadiusUv, proceduralFade);
  }
  if screenRadius > effectWindowRadius {
    return base;
  }
  if lodFade > 0.001 {
    base = apply_black_hole_image_lod(base, uv, centerUv, lodRadiusUv, lodFade);
  }
  if proceduralFade <= 0.001 {
    return base;
  }

  let rayWorld = screen_ray(uv);
  let rayPos = black_hole_space(-centerRelWorld) / eventRadiusAU;
  let rayDir = black_hole_space(rayWorld);
  let sample = raymarch_black_hole(rayPos, rayDir, blackHole.params.x, proceduralFade);
  let effectWindow = (1.0 - smoothstep(diskRadiusUv * 2.65 + 0.08, diskRadiusUv * 3.35 + 0.12, screenRadius)) * proceduralFade;
  let occlusion = sample.occlusion * effectWindow;
  let emissionAlpha = sample.alpha * effectWindow;

  base *= 1.0 - occlusion;
  base = mix(base, sample.color + base * (1.0 - emissionAlpha), emissionAlpha);
  return base + sample.color * (1.0 - emissionAlpha) * 0.20 * effectWindow;
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
  let withBlackHole = black_hole_composite(hdrColor, uv);
  return vec4<f32>(aces_tonemap(apply_flight_warp(withBlackHole, uv)), 1.0);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  return present_color(sample_scene(in.uv), in.uv);
}

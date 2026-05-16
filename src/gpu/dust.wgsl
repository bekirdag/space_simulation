// Cached volumetric Milky Way dust renderer.
//
// A compute pass writes procedural FBM/Worley spiral-arm density into a 3D
// texture once. The render pass raymarches the galactic volume and blends a
// low-opacity extinction/scattering layer over the already-rendered stars.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct DustVolume {
  // xyz = galactic center in ecliptic AU, w = disk radius in AU
  center_radius: vec4<f32>,
  // x = half height AU, y = AU/kpc, z = coverage threshold, w = texture size
  params0: vec4<f32>,
  // x = absorption, y = scattering, z = HG g, w = max opacity
  params1: vec4<f32>,
  // rgb = galactic core color, w = raymarch steps
  coreColor_steps: vec4<f32>,
  // xy = viewport pixels, zw reserved
  viewport: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> dustParams: DustVolume;
@group(0) @binding(2) var dustTex: texture_3d<f32>;
@group(0) @binding(3) var dustSampler: sampler;
@group(0) @binding(4) var dustStorage: texture_storage_3d<rgba8unorm, write>;

const SUN_GALACTIC_RADIUS_KPC: f32 = 8.5;
const GAL_TO_ECL_0: vec3<f32> = vec3<f32>(-0.054876,  0.494109, -0.867666);
const GAL_TO_ECL_1: vec3<f32> = vec3<f32>(-0.993911, -0.111106, -0.000312);
const GAL_TO_ECL_2: vec3<f32> = vec3<f32>(-0.096390,  0.862326,  0.497159);

fn hash31(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453123);
}

fn hash33(p: vec3<f32>) -> vec3<f32> {
  return fract(sin(vec3<f32>(
    dot(p, vec3<f32>(127.1, 311.7, 74.7)),
    dot(p, vec3<f32>(269.5, 183.3, 246.1)),
    dot(p, vec3<f32>(113.5, 271.9, 124.6)),
  )) * 43758.5453123);
}

fn valueNoise(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);

  let n000 = hash31(i + vec3<f32>(0.0, 0.0, 0.0));
  let n100 = hash31(i + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = hash31(i + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = hash31(i + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = hash31(i + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = hash31(i + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = hash31(i + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = hash31(i + vec3<f32>(1.0, 1.0, 1.0));

  let nx00 = mix(n000, n100, u.x);
  let nx10 = mix(n010, n110, u.x);
  let nx01 = mix(n001, n101, u.x);
  let nx11 = mix(n011, n111, u.x);
  let nxy0 = mix(nx00, nx10, u.y);
  let nxy1 = mix(nx01, nx11, u.y);
  return mix(nxy0, nxy1, u.z);
}

fn fbm(p0: vec3<f32>) -> f32 {
  var p = p0;
  var amp = 0.52;
  var sum = 0.0;
  var norm = 0.0;
  for (var i = 0; i < 5; i = i + 1) {
    sum += valueNoise(p) * amp;
    norm += amp;
    p = p * 2.03 + vec3<f32>(13.1, 7.7, 5.3);
    amp *= 0.5;
  }
  return sum / max(0.0001, norm);
}

fn worley(p: vec3<f32>) -> f32 {
  let base = vec3<i32>(floor(p));
  var minDist = 10.0;
  for (var z = -1; z <= 1; z = z + 1) {
    for (var y = -1; y <= 1; y = y + 1) {
      for (var x = -1; x <= 1; x = x + 1) {
        let cellI = base + vec3<i32>(x, y, z);
        let cell = vec3<f32>(cellI);
        let feature = cell + hash33(cell);
        minDist = min(minDist, length(feature - p));
      }
    }
  }
  return clamp(minDist, 0.0, 1.0);
}

fn spiralMask(galXY: vec2<f32>, radiusKpc: f32) -> f32 {
  let angle = atan2(galXY.y, galXY.x);
  let arm4 = smoothstep(0.38, 1.0, sin(angle * 4.0 + radiusKpc * 2.35));
  let arm2 = smoothstep(0.52, 1.0, sin(angle * 2.0 - radiusKpc * 1.10));
  let local = smoothstep(0.50, 1.0, sin(angle * 5.0 + radiusKpc * 3.05));
  return clamp(max(arm4, arm2 * 0.62) + local * 0.18, 0.0, 1.0);
}

fn galacticDustDensityKpc(p: vec3<f32>) -> vec4<f32> {
  let radiusKpc = dustParams.center_radius.w / dustParams.params0.y;
  let halfHeightKpc = dustParams.params0.x / dustParams.params0.y;
  let diskRadius = length(p.xy);

  let diskEdge = 1.0 - smoothstep(radiusKpc * 0.88, radiusKpc, diskRadius);
  let vertical = exp(-abs(p.z) / 0.22);
  let radial = exp(-diskRadius / 7.4);
  let centralBar = exp(-abs(p.y) / 0.62) * exp(-abs(p.x) / 3.5) * (1.0 - smoothstep(1.1, 4.8, diskRadius));
  let arms = spiralMask(p.xy, diskRadius);

  let noiseP = vec3<f32>(p.x * 0.18, p.z * 1.35, p.y * 0.18);
  let filaments = fbm(noiseP * 1.45 + vec3<f32>(3.0, 17.0, 9.0));
  let broadFilaments = fbm(noiseP * 0.55 + vec3<f32>(29.0, 5.0, 41.0));
  let pocketDistance = worley(noiseP * 3.4 + vec3<f32>(11.0, 2.0, 19.0));
  let pockets = 1.0 - smoothstep(0.12, 0.78, pocketDistance);

  var shape = filaments * 0.58 + broadFilaments * 0.35 + pockets * 0.28 + arms * 0.24 + centralBar * 0.22;
  shape = max(shape - dustParams.params0.z, 0.0);
  let envelope = diskEdge * vertical * (radial * (0.42 + arms * 0.95) + centralBar * 0.55);
  let heightFade = 1.0 - smoothstep(halfHeightKpc * 0.80, halfHeightKpc, abs(p.z));
  let density = clamp(shape * envelope * heightFade * 1.55, 0.0, 1.0);

  let darkBrown = vec3<f32>(0.16, 0.095, 0.055);
  let lightBrown = vec3<f32>(0.54, 0.38, 0.22);
  let gray = vec3<f32>(0.22, 0.215, 0.20);
  let black = vec3<f32>(0.018, 0.016, 0.014);
  let warm = mix(darkBrown, lightBrown, smoothstep(0.22, 0.78, filaments));
  let cool = mix(gray, black, clamp(pockets * 0.88 + density * 0.35, 0.0, 1.0));
  let color = mix(warm, cool, clamp(pockets * 0.58 + (1.0 - arms) * 0.18, 0.0, 1.0));

  return vec4<f32>(color, density);
}

@compute @workgroup_size(4, 4, 4)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(dustStorage);
  if (gid.x >= dims.x || gid.y >= dims.y || gid.z >= dims.z) {
    return;
  }

  let uvw = (vec3<f32>(gid) + vec3<f32>(0.5)) / vec3<f32>(dims);
  let radiusKpc = dustParams.center_radius.w / dustParams.params0.y;
  let halfHeightKpc = dustParams.params0.x / dustParams.params0.y;
  let gal = vec3<f32>(
    (uvw.x * 2.0 - 1.0) * radiusKpc,
    (uvw.z * 2.0 - 1.0) * radiusKpc,
    (uvw.y * 2.0 - 1.0) * halfHeightKpc,
  );
  let dust = galacticDustDensityKpc(gal);
  textureStore(dustStorage, vec3<i32>(gid), dust);
}

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

var<private> tri: array<vec2<f32>, 3> = array<vec2<f32>, 3>(
  vec2<f32>(-1.0, -3.0),
  vec2<f32>( 3.0,  1.0),
  vec2<f32>(-1.0,  1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOut {
  let p = tri[vi];
  var out: VertexOut;
  out.clip_pos = vec4<f32>(p, 0.0, 1.0);
  out.uv = p * 0.5 + vec2<f32>(0.5);
  return out;
}

fn eclipticToGalactocentricKpc(worldAU: vec3<f32>) -> vec3<f32> {
  let eclKpc = worldAU / dustParams.params0.y;
  let xh = dot(eclKpc, vec3<f32>(GAL_TO_ECL_0.x, GAL_TO_ECL_1.x, GAL_TO_ECL_2.x));
  let yh = dot(eclKpc, vec3<f32>(GAL_TO_ECL_0.y, GAL_TO_ECL_1.y, GAL_TO_ECL_2.y));
  let zh = dot(eclKpc, vec3<f32>(GAL_TO_ECL_0.z, GAL_TO_ECL_1.z, GAL_TO_ECL_2.z));
  return vec3<f32>(xh - SUN_GALACTIC_RADIUS_KPC, yh, zh);
}

fn dustTexCoord(worldAU: vec3<f32>) -> vec3<f32> {
  let gal = eclipticToGalactocentricKpc(worldAU);
  let radiusKpc = dustParams.center_radius.w / dustParams.params0.y;
  let halfHeightKpc = dustParams.params0.x / dustParams.params0.y;
  return vec3<f32>(
    gal.x / (radiusKpc * 2.0) + 0.5,
    gal.z / (halfHeightKpc * 2.0) + 0.5,
    gal.y / (radiusKpc * 2.0) + 0.5,
  );
}

fn sampleDust(worldAU: vec3<f32>) -> vec4<f32> {
  let tc = dustTexCoord(worldAU);
  if (tc.x < 0.0 || tc.x > 1.0 || tc.y < 0.0 || tc.y > 1.0 || tc.z < 0.0 || tc.z > 1.0) {
    return vec4<f32>(0.0);
  }
  return textureSampleLevel(dustTex, dustSampler, tc, 0.0);
}

fn intersectSphere(ro: vec3<f32>, rd: vec3<f32>, center: vec3<f32>, radius: f32) -> vec2<f32> {
  let oc = ro - center;
  let b = dot(oc, rd);
  let c = dot(oc, oc) - radius * radius;
  let h = b * b - c;
  if (h < 0.0) {
    return vec2<f32>(1.0, -1.0);
  }
  let s = sqrt(h);
  return vec2<f32>(-b - s, -b + s);
}

fn cameraRay(uv: vec2<f32>) -> vec3<f32> {
  let viewport = max(dustParams.viewport.xy, vec2<f32>(1.0, 1.0));
  let aspect = viewport.x / viewport.y;
  let right = normalize(camera.rightAndMNR.xyz);
  let up = normalize(camera.upAndFocal.xyz);
  let forward = -normalize(cross(right, up));
  let focalY = max(camera.upAndFocal.w, 0.001);
  let ndc = uv * 2.0 - vec2<f32>(1.0, 1.0);
  return normalize(forward + right * (ndc.x * aspect / focalY) + up * (ndc.y / focalY));
}

fn interleavedGradientNoise(pixel: vec2<f32>) -> f32 {
  return fract(52.9829189 * fract(dot(pixel, vec2<f32>(0.06711056, 0.00583715))));
}

fn hgPhase(cosTheta: f32, g: f32) -> f32 {
  let gg = g * g;
  return (1.0 - gg) / pow(max(0.05, 1.0 + gg - 2.0 * g * cosTheta), 1.5);
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let ro = camera.eyeAndFlags.xyz;
  let rd = cameraRay(in.uv);
  let bounds = intersectSphere(ro, rd, dustParams.center_radius.xyz, dustParams.center_radius.w);
  if (bounds.x > bounds.y || bounds.y <= 0.0) {
    return vec4<f32>(0.0);
  }

  if (dustParams.params1.w <= 0.001) {
    return vec4<f32>(0.0);
  }

  let steps = clamp(dustParams.coreColor_steps.w, 6.0, 18.0);
  let nearT = max(bounds.x, 0.0);
  let farT = bounds.y;
  let stepSizeAU = (farT - nearT) / steps;
  if (stepSizeAU <= 0.0) {
    return vec4<f32>(0.0);
  }

  let pixel = in.uv * max(dustParams.viewport.xy, vec2<f32>(1.0, 1.0));
  var t = nearT + interleavedGradientNoise(pixel) * stepSizeAU;
  var transmittance = 1.0;
  var glow = vec3<f32>(0.0);
  var weightedLaneColor = vec3<f32>(0.0);
  var laneWeight = 0.0;

  for (var i = 0; i < 18; i = i + 1) {
    if (f32(i) >= steps || t > farT || transmittance < 0.012) {
      break;
    }

    let pos = ro + rd * t;
    let dust = sampleDust(pos);
    let density = dust.a;
    if (density > 0.002) {
      let stepKpc = stepSizeAU / dustParams.params0.y;
      let toCore = normalize(dustParams.center_radius.xyz - pos);
      let phase = clamp(hgPhase(dot(rd, toCore), dustParams.params1.z) * 0.045, 0.0, 1.35);
      let laneColor = max(dust.rgb, vec3<f32>(0.012, 0.010, 0.009));
      let sampleWeight = transmittance * density;
      weightedLaneColor += laneColor * sampleWeight;
      laneWeight += sampleWeight;

      let scatterColor = mix(laneColor, dustParams.coreColor_steps.rgb, 0.34);
      let scatter = density * dustParams.params1.y * (0.18 + phase) * stepKpc;
      glow += transmittance * scatter * scatterColor;
      transmittance *= exp(-density * dustParams.params1.x * stepKpc);
    }
    t += stepSizeAU;
  }

  let extinction = clamp(1.0 - transmittance, 0.0, 1.0);
  if (extinction <= 0.0005 && length(glow) <= 0.0005) {
    return vec4<f32>(0.0);
  }

  var avgLaneColor = vec3<f32>(0.055, 0.040, 0.030);
  if (laneWeight > 0.0001) {
    avgLaneColor = weightedLaneColor / laneWeight;
  }
  let darkLaneColor = mix(vec3<f32>(0.010, 0.009, 0.008), avgLaneColor, 0.48);
  let glowColor = glow + avgLaneColor * 0.22;
  let glowMix = clamp(length(glow) * 0.75, 0.0, 0.42);
  let outColor = mix(darkLaneColor, glowColor, glowMix);
  let alpha = clamp(extinction * dustParams.params1.w * 4.4 + length(glow) * 0.14, 0.0, dustParams.params1.w);
  return vec4<f32>(outColor, alpha);
}

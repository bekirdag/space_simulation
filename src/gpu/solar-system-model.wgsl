// Textured solar-system body mesh renderer.
// Mesh vertices use the parsed model-loader layout:
//   position.xyz, normal.xyz, uv.xy, vertexColor.rgba

struct Camera {
  viewProj:         mat4x4<f32>,
  rightAndMNR:     vec4<f32>,
  upAndFocal:      vec4<f32>,
  eyeAndFlags:     vec4<f32>,
  screenAndTarget: vec4<f32>,
  eyeOffset:       vec4<f32>,
};

struct ModelUniform {
  centerRadius:     vec4<f32>, // xyz=center AU, w=physical radius AU
  lightAndKind:     vec4<f32>, // xyz=direction toward Sun, w=1 for emissive Sun
  fallbackOpacity:  vec4<f32>, // rgb=fallback color, w=opacity
  params:           vec4<f32>, // x=emissive strength, y=prime meridian degrees
  orientationRight: vec4<f32>, // body +X axis in ecliptic J2000
  orientationUp:    vec4<f32>, // body +Y axis in ecliptic J2000
  orientationAxis:  vec4<f32>, // body north pole/+Z axis in ecliptic J2000
};

struct MaterialUniform {
  baseColor: vec4<f32>,
  emissive:  vec4<f32>,
  params:    vec4<f32>, // x=useTexture, y=useProcedural, z=useVertexColor, w=textureEmission
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: ModelUniform;
@group(0) @binding(2) var<uniform> material: MaterialUniform;
@group(0) @binding(3) var modelTexture: texture_2d<f32>;
@group(0) @binding(4) var modelSampler: sampler;

struct VertexOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) vertexColor: vec4<f32>,
  @location(3) viewDir: vec3<f32>,
};

const CAMERA_NEAR: f32 = 1e-8;
const CAMERA_FAR: f32 = 50000000.0;

fn hash31(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453123);
}

fn valueNoise3(p: vec3<f32>) -> f32 {
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

fn fbm3(p: vec3<f32>) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  for (var i = 0; i < 4; i++) {
    sum += valueNoise3(p * freq) * amp;
    freq *= 2.07;
    amp *= 0.52;
  }
  return sum;
}

fn solarSurfaceColor(normal: vec3<f32>, viewDir: vec3<f32>, uv: vec2<f32>) -> vec3<f32> {
  let spinPhase = model.params.y * 0.0027777778;
  let p = normal + vec3<f32>(spinPhase, 0.0, -spinPhase * 0.47);
  let convection = fbm3(p * 28.0);
  let fineCells = fbm3(p * 86.0 + vec3<f32>(7.1, 13.7, 3.5));
  let filament = sin((uv.x + spinPhase * 0.03) * 92.0 + sin(uv.y * 38.0) * 1.8) * 0.5 + 0.5;
  let activeSeed = fbm3(p * 9.5 + vec3<f32>(21.0, 4.0, 11.0));
  let equatorialBias = 1.0 - smoothstep(0.15, 0.92, abs(normal.y));
  let sunspot = smoothstep(0.82, 0.96, activeSeed) * equatorialBias;
  let faculae = smoothstep(0.62, 0.90, convection) * (1.0 - sunspot * 0.85);
  let detail = clamp(convection * 0.58 + fineCells * 0.30 + filament * 0.12, 0.0, 1.0);
  let cool = vec3<f32>(0.92, 0.36, 0.055);
  let base = vec3<f32>(1.0, 0.62, 0.14);
  let hot = vec3<f32>(1.0, 0.88, 0.42);
  let spot = vec3<f32>(0.34, 0.085, 0.018);
  var color = mix(cool, hot, detail);
  color = mix(color, base, 0.28);
  color = mix(color, hot * 1.08, faculae * 0.38);
  color = mix(color, spot, sunspot * 0.72);
  let facing = clamp(abs(dot(normalize(normal), normalize(viewDir))), 0.0, 1.0);
  let limb = 0.48 + 0.52 * pow(facing, 0.32);
  return color * limb;
}

fn projectCameraRelative(relativeToEye: vec3<f32>) -> vec4<f32> {
  let right = normalize(camera.rightAndMNR.xyz);
  let up = normalize(camera.upAndFocal.xyz);
  let back = normalize(cross(right, up));
  let view = vec3<f32>(
    dot(relativeToEye, right),
    dot(relativeToEye, up),
    dot(relativeToEye, back),
  );
  let aspect = max(camera.screenAndTarget.x, 1e-6);
  let focalY = camera.upAndFocal.w;
  let nf = 1.0 / (CAMERA_NEAR - CAMERA_FAR);
  return vec4<f32>(
    (focalY / aspect) * view.x,
    focalY * view.y,
    CAMERA_FAR * nf * view.z + CAMERA_FAR * CAMERA_NEAR * nf,
    -view.z,
  );
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) vertexColor: vec4<f32>,
) -> VertexOut {
  var out: VertexOut;
  let orientedPosition =
    model.orientationRight.xyz * position.x +
    model.orientationUp.xyz * position.y +
    model.orientationAxis.xyz * position.z;
  let orientedNormal = normalize(
    model.orientationRight.xyz * normal.x +
    model.orientationUp.xyz * normal.y +
    model.orientationAxis.xyz * normal.z
  );
  let relativeToTarget = (model.centerRadius.xyz - camera.screenAndTarget.yzw) + orientedPosition * model.centerRadius.w;
  let relativeToEye = relativeToTarget - camera.eyeOffset.xyz;
  out.clipPos = projectCameraRelative(relativeToEye);
  out.uv = uv;
  out.normal = orientedNormal;
  out.vertexColor = vertexColor;
  out.viewDir = normalize(-relativeToEye);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  var base = material.baseColor;
  if material.params.x > 0.5 {
    let tex = textureSample(modelTexture, modelSampler, in.uv);
    base *= tex;
  } else {
    base = vec4<f32>(base.rgb * model.fallbackOpacity.rgb, base.a);
  }
  if material.params.z > 0.5 {
    base *= in.vertexColor;
  }

  let alpha = clamp(base.a * model.fallbackOpacity.w, 0.0, 1.0);
  if alpha < 0.01 {
    discard;
  }

  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  let normal = normalize(in.normal);
  var color = base.rgb;

  if model.lightAndKind.w > 0.5 {
    let emissiveStrength = max(model.params.x, 1.0);
    let texEmission = max(material.params.w, 0.0);
    let materialEmission = material.emissive.rgb * max(material.emissive.a, texEmission);
    let proceduralSurface = solarSurfaceColor(normal, normalize(in.viewDir), in.uv);
    color = mix(color * model.fallbackOpacity.rgb, proceduralSurface, clamp(material.params.y, 0.0, 1.0));
    color = (color * emissiveStrength + materialEmission) * objectBrightness;
  } else {
    let lightDir = normalize(model.lightAndKind.xyz);
    let viewDir = normalize(in.viewDir);
    let diffuse = max(dot(normal, lightDir), 0.0);
    let fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 2.0);
    let ambient = 0.075;
    color = color * (ambient + diffuse * 0.925) * (0.94 + fresnel * 0.08) * objectBrightness;
    color += material.emissive.rgb * max(material.emissive.a, 0.0);
  }

  return vec4<f32>(color * alpha, alpha);
}

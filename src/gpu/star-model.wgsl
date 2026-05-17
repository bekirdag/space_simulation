// Close selected-star 3D surface model.
// Mesh vertices use the shared parsed model-loader layout:
//   position.xyz, normal.xyz, uv.xy, vertexColor.rgba

struct Camera {
  viewProj:         mat4x4<f32>,
  rightAndMNR:     vec4<f32>,
  upAndFocal:      vec4<f32>,
  eyeAndFlags:     vec4<f32>,
  screenAndTarget: vec4<f32>,
  eyeOffset:       vec4<f32>,
};

struct StarModel {
  centerRadius: vec4<f32>, // xyz=center AU, w=physical radius AU
  colorType:    vec4<f32>, // rgb=catalog spectral color, w=star model type index
  params:       vec4<f32>, // x=active, y=apparent alpha, z=brightness effects, w=reserved
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: StarModel;

const CAMERA_NEAR: f32 = 1e-8;
const CAMERA_FAR:  f32 = 50000000.0;
const SOLAR_RADIUS_AU: f32 = 0.00465047;

struct VertexOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) worldPos: vec3<f32>,
  @location(3) lod: f32,
  @location(4) pixelRadius: f32,
};

fn camera_back() -> vec3<f32> {
  return normalize(cross(camera.rightAndMNR.xyz, camera.upAndFocal.xyz));
}

fn camera_relative(pos: vec3<f32>) -> vec3<f32> {
  let rel = (pos - camera.screenAndTarget.yzw) - camera.eyeOffset.xyz;
  let back = camera_back();
  return vec3<f32>(
    dot(rel, camera.rightAndMNR.xyz),
    dot(rel, camera.upAndFocal.xyz),
    dot(rel, back),
  );
}

fn project_world(pos: vec3<f32>) -> vec4<f32> {
  let v = camera_relative(pos);
  let nf = 1.0 / (CAMERA_NEAR - CAMERA_FAR);
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  let focalY = camera.upAndFocal.w;
  return vec4<f32>(
    v.x * focalY / aspect,
    v.y * focalY,
    CAMERA_FAR * nf * v.z + CAMERA_FAR * CAMERA_NEAR * nf,
    -v.z,
  );
}

fn hash31(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453123);
}

fn value_noise(p: vec3<f32>) -> f32 {
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

fn fbm(p: vec3<f32>) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  for (var i = 0; i < 4; i++) {
    sum += value_noise(p * freq) * amp;
    freq *= 2.08;
    amp *= 0.52;
  }
  return sum;
}

fn type_color(typeIndex: i32, fallback: vec3<f32>) -> vec3<f32> {
  if typeIndex == 0 { return mix(vec3<f32>(0.62, 0.74, 1.0), fallback, 0.36); }
  if typeIndex == 1 { return mix(vec3<f32>(0.90, 0.95, 1.0), fallback, 0.34); }
  if typeIndex == 2 { return mix(vec3<f32>(1.0, 0.90, 0.66), fallback, 0.42); }
  if typeIndex == 3 { return mix(vec3<f32>(1.0, 0.64, 0.32), fallback, 0.38); }
  if typeIndex == 4 { return mix(vec3<f32>(1.0, 0.34, 0.22), fallback, 0.30); }
  if typeIndex == 5 { return mix(vec3<f32>(1.0, 0.42, 0.18), fallback, 0.28); }
  if typeIndex == 6 { return mix(vec3<f32>(1.0, 0.26, 0.12), fallback, 0.22); }
  if typeIndex == 7 { return mix(vec3<f32>(0.88, 0.94, 1.0), fallback, 0.18); }
  return fallback;
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) _vertexColor: vec4<f32>,
) -> VertexOut {
  var out: VertexOut;
  let active = model.params.x;
  let center = model.centerRadius.xyz;
  let radius = max(model.centerRadius.w, SOLAR_RADIUS_AU * 0.01);
  let clipCenter = project_world(center);
  let projectedNdcRadius = radius * camera.upAndFocal.w / max(clipCenter.w, 0.000001);
  let pixelRadius = projectedNdcRadius * 2.5 / max(camera.rightAndMNR.w, 0.000001);
  let lod = smoothstep(14.0, 30.0, pixelRadius) * active;

  let world = center + position * radius;
  out.clipPos = project_world(world);
  if clipCenter.w <= 0.0 || lod <= 0.001 {
    out.clipPos = vec4<f32>(10.0, 10.0, 10.0, 1.0);
  }
  out.normal = normalize(normal);
  out.uv = uv;
  out.worldPos = world;
  out.lod = lod;
  out.pixelRadius = pixelRadius;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  if in.lod <= 0.001 {
    discard;
  }

  let typeIndex = i32(model.colorType.w + 0.5);
  let effects = clamp(model.params.z, 0.0, 1.0);
  let base = type_color(typeIndex, clamp(model.colorType.rgb, vec3<f32>(0.0), vec3<f32>(1.0)));
  let normal = normalize(in.normal);
  let viewDir = normalize(camera.eyeAndFlags.xyz - in.worldPos);
  let facing = clamp(dot(normal, viewDir), 0.0, 1.0);
  let limb = pow(facing, 0.38);
  let radiusSolar = clamp(model.centerRadius.w / SOLAR_RADIUS_AU, 0.01, 1800.0);

  var scale = 16.0;
  var contrast = 0.12;
  if typeIndex == 5 {
    scale = 5.5;
    contrast = 0.26;
  } else if typeIndex == 6 {
    scale = 3.8;
    contrast = 0.34;
  } else if typeIndex == 7 {
    scale = 38.0;
    contrast = 0.035;
  } else if typeIndex == 4 {
    scale = 9.0;
    contrast = 0.18;
  } else if typeIndex == 0 {
    scale = 24.0;
    contrast = 0.06;
  }

  let cells = fbm(normal * scale + vec3<f32>(0.0, 0.0, radiusSolar * 0.007));
  let detail = fbm(normal * scale * 4.2 + vec3<f32>(7.3, 1.1, 3.7));
  let convection = (cells - 0.5) * contrast + (detail - 0.5) * contrast * 0.42;
  let spot = smoothstep(0.70, 0.94, fbm(normal * (scale * 0.72) + vec3<f32>(11.0, 5.0, 2.0)));
  let coolSpotStrength = select(0.05, 0.16, typeIndex == 5 || typeIndex == 6 || typeIndex == 4);
  let photosphere = base * (0.82 + limb * 0.36 + convection) * (1.0 - spot * coolSpotStrength);

  let rimColor = mix(base, base * 1.22, select(0.16, 0.035, typeIndex == 4 || typeIndex == 5 || typeIndex == 6));
  let rim = pow(1.0 - facing, 2.2);
  let corona = rim * mix(0.18, 0.55, effects);
  let typeEmission = select(1.0, 1.65, typeIndex == 0 || typeIndex == 1 || typeIndex == 7);
  let radiusEmission = clamp(pow(radiusSolar, 0.11), 0.55, 2.6);
  let hdrIntensity = mix(1.0, (3.0 + radiusEmission * 5.5) * typeEmission, effects);

  let alpha = clamp(in.lod * model.params.y, 0.0, 1.0);
  let color = (photosphere * hdrIntensity + rimColor * corona * hdrIntensity * 0.46) * max(camera.eyeAndFlags.w, 0.0);
  return vec4<f32>(color * alpha, alpha);
}

struct Camera {
  viewProj: mat4x4<f32>,
  rightAndMinRadius: vec4<f32>,
  upAndFocal: vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct ModelUniform {
  centerRadius: vec4<f32>,
  lodOpacity: vec4<f32>,
  colorPad: vec4<f32>,
  pad: vec4<f32>,
};

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) alpha: f32,
  @location(2) viewDir: vec3<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: ModelUniform;

fn smoother(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / max(1e-5, edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
) -> VSOut {
  let center = model.centerRadius.xyz;
  let radius = model.centerRadius.w;
  let camDist = distance(camera.eyeAndFlags.xyz, center);
  let fadeOut = 1.0 - smoother(model.lodOpacity.x, model.lodOpacity.y, camDist);
  let alpha = clamp(fadeOut * model.lodOpacity.z, 0.0, 1.0);
  let world = center + position * radius;

  var out: VSOut;
  out.position = camera.viewProj * vec4<f32>(world, 1.0);
  out.normal = normalize(normal);
  out.alpha = alpha;
  out.viewDir = normalize(camera.eyeAndFlags.xyz - world);
  if (alpha <= 0.002) {
    out.position = vec4<f32>(2.0, 2.0, 1.0, 1.0);
  }
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let v = normalize(in.viewDir);
  let rim = pow(1.0 - abs(dot(n, v)), 2.1);
  let lightDir = normalize(v * 0.55 + camera.upAndFocal.xyz * 0.35 + camera.rightAndMinRadius.xyz * 0.25);
  let lambert = 0.22 + 0.78 * max(dot(n, lightDir), 0.0);
  let backScatter = 0.12 + 0.38 * max(dot(-n, v), 0.0);
  let color = model.colorPad.rgb * (lambert + rim * 0.42 + backScatter);
  return vec4<f32>(color * in.alpha, in.alpha);
}

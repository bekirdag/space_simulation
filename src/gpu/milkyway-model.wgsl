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

struct MaterialUniform {
  baseColor: vec4<f32>,
  emissive: vec4<f32>,
  params: vec4<f32>,
};

struct VSOut {
  @builtin(position) position: vec4<f32>,
  @location(0) normal: vec3<f32>,
  @location(1) uv: vec2<f32>,
  @location(2) vertexColor: vec4<f32>,
  @location(3) alpha: f32,
  @location(4) viewDir: vec3<f32>,
  @location(5) localPos: vec3<f32>,
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> model: ModelUniform;
@group(0) @binding(2) var<uniform> material: MaterialUniform;
@group(0) @binding(3) var modelTexture: texture_2d<f32>;
@group(0) @binding(4) var modelSampler: sampler;

fn smoother(edge0: f32, edge1: f32, x: f32) -> f32 {
  let t = clamp((x - edge0) / max(1e-5, edge1 - edge0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

fn hash31(p: vec3<f32>) -> f32 {
  let q = fract(p * 0.1031);
  let r = q + vec3<f32>(dot(q, q.yzx + vec3<f32>(33.33)));
  return fract((r.x + r.y) * r.z);
}

fn fbmNebula(p: vec3<f32>) -> f32 {
  var amp = 0.55;
  var freq = 1.0;
  var sum = 0.0;
  for (var i = 0; i < 4; i++) {
    let a = sin(p.x * freq * 5.1 + p.y * freq * 2.7);
    let b = cos(p.z * freq * 4.3 - p.x * freq * 1.9);
    let c = hash31(p * freq + vec3<f32>(f32(i) * 17.0));
    sum += (0.5 + 0.22 * a + 0.18 * b + 0.18 * c) * amp;
    amp *= 0.52;
    freq *= 2.07;
  }
  return clamp(sum, 0.0, 1.0);
}

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) vertexColor: vec4<f32>,
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
  out.uv = uv;
  out.vertexColor = vertexColor;
  out.alpha = alpha;
  out.viewDir = normalize(camera.eyeAndFlags.xyz - world);
  out.localPos = position;
  if (alpha <= 0.002) {
    out.position = vec4<f32>(2.0, 2.0, 1.0, 1.0);
  }
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  let n = normalize(in.normal);
  let v = normalize(in.viewDir);
  let rim = pow(1.0 - abs(dot(n, v)), 2.0);
  let lightDir = normalize(v * 0.42 + camera.upAndFocal.xyz * 0.36 + camera.rightAndMinRadius.xyz * 0.22);
  let lambert = max(dot(n, lightDir), 0.0);

  let texel = textureSample(modelTexture, modelSampler, in.uv);
  let textureMix = material.params.x;
  let proceduralMix = material.params.y;
  let vertexColorMix = material.params.z;
  let textureEmission = material.params.w;
  let vertexColor = mix(vec4<f32>(1.0), in.vertexColor, vec4<f32>(vertexColorMix));
  var albedo = material.baseColor * vertexColor * mix(vec4<f32>(1.0), texel, vec4<f32>(textureMix));

  let nebula = fbmNebula(in.localPos * 2.1 + n * 0.7);
  let filament = smoothstep(0.24, 0.92, nebula);
  let proceduralColor = albedo.rgb * (0.42 + filament * 0.95) + model.colorPad.rgb * (rim * 0.55 + filament * 0.22);
  let litColor = albedo.rgb * (0.22 + lambert * 0.46 + rim * 0.58);
  let emissive = material.emissive.rgb * material.emissive.a;
  let projectedTexture = texel.rgb * textureMix * textureEmission;
  let color = mix(litColor, proceduralColor, vec3<f32>(proceduralMix)) + emissive + projectedTexture + albedo.rgb * rim * 0.22;
  let alpha = in.alpha * clamp(albedo.a, 0.0, 1.0) * mix(1.0, 0.72 + rim * 0.22 + filament * 0.18, proceduralMix);

  return vec4<f32>(color * alpha, alpha);
}

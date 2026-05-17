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
  params:           vec4<f32>, // x=emissive strength, remaining reserved
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
  @location(3) worldPos: vec3<f32>,
};

@vertex
fn vs_main(
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) vertexColor: vec4<f32>,
) -> VertexOut {
  var out: VertexOut;
  let world = model.centerRadius.xyz + position * model.centerRadius.w;
  out.clipPos = camera.viewProj * vec4<f32>(world, 1.0);
  out.uv = uv;
  out.normal = normalize(normal);
  out.vertexColor = vertexColor;
  out.worldPos = world;
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  var base = material.baseColor;
  if material.params.x > 0.5 {
    let tex = textureSample(modelTexture, modelSampler, in.uv);
    base *= tex;
  } else {
    base.rgb *= model.fallbackOpacity.rgb;
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
    let limb = 0.74 + 0.26 * abs(dot(normal, normalize(camera.eyeAndFlags.xyz - in.worldPos)));
    color = (color * model.fallbackOpacity.rgb * emissiveStrength + materialEmission) * limb * objectBrightness;
  } else {
    let lightDir = normalize(model.lightAndKind.xyz);
    let viewDir = normalize(camera.eyeAndFlags.xyz - in.worldPos);
    let diffuse = max(dot(normal, lightDir), 0.0);
    let fresnel = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 2.0);
    let ambient = 0.075;
    color = color * (ambient + diffuse * 0.925) * (0.94 + fresnel * 0.08) * objectBrightness;
    color += material.emissive.rgb * max(material.emissive.a, 0.0);
  }

  return vec4<f32>(color * alpha, alpha);
}

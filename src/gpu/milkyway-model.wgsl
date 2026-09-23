struct Camera {
  viewProj: mat4x4<f32>,
  rightAndMinRadius: vec4<f32>,
  upAndFocal: vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct ModelUniform {
  centerRadius: vec4<f32>,
  // x = fade-out start, y = fade-out end, z = opacity, w = glow rim power (fs_glow)
  lodOpacity: vec4<f32>,
  // rgb = tint / outer gas colour, w = glow gain (fs_glow)
  colorPad: vec4<f32>,
  // rgb = inner gas colour (fs_glow), w = head-on emission floor (fs_glow)
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
  @location(6) viewDepth: f32,
};

struct MeshFragmentOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

// Logarithmic depth shared with solar-system-model.wgsl (keep LOG_DEPTH_* in sync).
const LOG_DEPTH_K: f32 = 1e-9;
const LOG_DEPTH_INV_RANGE: f32 = 0.016666667; // 1 / log2(1 + 1e9 / 1e-9) ~= 1 / 59.79

fn logDepth(viewDepth: f32) -> f32 {
  return clamp(log2(1.0 + max(viewDepth, 0.0) / LOG_DEPTH_K) * LOG_DEPTH_INV_RANGE, 0.0, 1.0);
}

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
  out.viewDepth = out.position.w;
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

// Galaxy morphology meshes (renderer milkyWayModelPipeline), log depth so
// they are depth-tested against bodies like every other scene layer.
// A galaxy is starlight on black sky, not a lit surface: the photo (sampled at
// each vertex's sky projection, renderer galaxySkyUv) is emitted with the same
// luminance mask as the billboard LOD (galaxy-textured.wgsl), so dark sky and
// black mosaic gaps are transparent instead of occluding what lies behind.
// Spheroid (bulge) vertices carry alpha + GALAXY_MESH_SPHEROID_ALPHA_FLAG
// (renderer.ts) and fade towards their silhouette from any view direction.
const GALAXY_MESH_SPHEROID_ALPHA_FLAG: f32 = 2.0;

@fragment
fn fs_main(in: VSOut) -> MeshFragmentOut {
  let texel = textureSample(modelTexture, modelSampler, in.uv);
  let lum = dot(texel.rgb, vec3<f32>(0.299, 0.587, 0.114));
  let mask = smoothstep(0.018, 0.16, lum);
  let coreLift = smoothstep(0.25, 0.85, lum);

  let isSpheroid = in.vertexColor.a >= GALAXY_MESH_SPHEROID_ALPHA_FLAG * 0.75;
  var partAlpha = in.vertexColor.a;
  if (isSpheroid) {
    let ndv = abs(dot(normalize(in.normal), normalize(in.viewDir)));
    partAlpha = (in.vertexColor.a - GALAXY_MESH_SPHEROID_ALPHA_FLAG) * pow(ndv, 1.4);
  }

  let tint = mix(vec3<f32>(1.0), in.vertexColor.rgb, 0.5);
  let alpha = clamp(in.alpha * partAlpha * mask, 0.0, 1.0);
  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  let color = texel.rgb * (0.72 + coreLift * 0.63) * tint;

  var out: MeshFragmentOut;
  out.color = vec4<f32>(color * alpha * objectBrightness, alpha);
  out.depth = logDepth(in.viewDepth);
  return out;
}

// Close-LOD NASA/Chandra supernova-remnant / nebula meshes. These are
// isosurfaces of emission / element maps, not solid bodies, so they are drawn
// as optically thin glowing gas: additive blending, no depth write, no diffuse
// lighting. Emission is weighted by the fresnel term, so a thin shell glows
// where the line of sight grazes it (limb brightening) and is faint head-on.
// Every layer accumulates, which reads as volume instead of plastic.
fn gasRecolor(rgb: vec3<f32>, inner: vec3<f32>, outer: vec3<f32>, radial: f32) -> vec3<f32> {
  // Grey / white texels in the NASA texture carry no element information:
  // map them onto the model's gas palette (Chandra-style blast-wave blue).
  let hi = max(rgb.r, max(rgb.g, rgb.b));
  let lo = min(rgb.r, min(rgb.g, rgb.b));
  let sat = (hi - lo) / max(hi, 1e-4);
  let luma = dot(rgb, vec3<f32>(0.3, 0.5, 0.2));
  let palette = mix(inner, outer, radial) * (0.4 + luma * 0.5);
  // Saturated texels keep their hue but are normalised so dark reds still glow.
  let vivid = rgb / max(hi, 0.05) * (0.55 + hi * 0.45);
  return mix(palette, vivid, smoothstep(0.18, 0.45, sat));
}

fn gasNoise(p: vec3<f32>) -> f32 {
  // Smooth value noise (trilinear) so the variation looks like gas density,
  // not per-vertex speckle.
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash31(i);
  let n100 = hash31(i + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = hash31(i + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = hash31(i + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = hash31(i + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = hash31(i + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = hash31(i + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = hash31(i + vec3<f32>(1.0, 1.0, 1.0));
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
}

fn gasFbm(p: vec3<f32>) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 3; i++) {
    sum += gasNoise(q) * amp;
    q = q * 2.13 + vec3<f32>(1.7, 9.2, 3.1);
    amp *= 0.5;
  }
  return sum / 0.875;
}

// Extinction pass (blend: dst *= 1 - src.a) run before fs_glow. Each crossed
// shell layer absorbs a little of the background; grazing (limb) crossings
// have a longer path through the shell and absorb more, so dense, many-layer
// regions darken the stars behind while thin gas stays see-through.
const GAS_ABSORB_PER_LAYER: f32 = 0.11;

@fragment
fn fs_absorb(in: VSOut, @builtin(front_facing) frontFacing: bool) -> MeshFragmentOut {
  var n = normalize(in.normal);
  if (!frontFacing) {
    n = -n;
  }
  let ndv = clamp(abs(dot(n, normalize(in.viewDir))), 0.0, 1.0);
  let path = 0.35 + 0.65 * pow(1.0 - ndv, 1.5);
  var out: MeshFragmentOut;
  out.color = vec4<f32>(0.0, 0.0, 0.0, clamp(GAS_ABSORB_PER_LAYER * path * in.alpha, 0.0, 0.3));
  out.depth = logDepth(in.viewDepth);
  return out;
}

@fragment
fn fs_glow(in: VSOut, @builtin(front_facing) frontFacing: bool) -> MeshFragmentOut {
  var n = normalize(in.normal);
  if (!frontFacing) {
    n = -n;
  }
  let v = normalize(in.viewDir);
  let ndv = clamp(abs(dot(n, v)), 0.0, 1.0);
  let rimPower = select(2.2, model.lodOpacity.w, model.lodOpacity.w > 0.0);
  let headOn = select(0.05, model.pad.w, model.pad.w > 0.0);
  let gain = select(1.0, model.colorPad.w, model.colorPad.w > 0.0);
  let rim = pow(1.0 - ndv, rimPower);

  let radial = clamp(length(in.localPos) * 0.95, 0.0, 1.0);
  let density = gasFbm(in.localPos * 4.2);
  let fine = gasNoise(in.localPos * 17.0);
  let paletteT = clamp(radial + (density - 0.5) * 0.7, 0.0, 1.0);
  let inner = model.pad.rgb;
  let outer = model.colorPad.rgb;

  let texel = textureSample(modelTexture, modelSampler, in.uv);
  let textureMix = material.params.x;
  let vertexColorMix = material.params.z;
  var base = mix(inner, outer, vec3<f32>(smoothstep(0.1, 0.95, paletteT)));
  if (textureMix > 0.5) {
    base = gasRecolor(texel.rgb, inner, outer, paletteT);
  } else if (vertexColorMix > 0.5) {
    base = gasRecolor(in.vertexColor.rgb, inner, outer, paletteT);
  }

  // Filamentary brightness variation + slight hot-spot whitening at bright rims.
  let clump = 0.45 + 1.1 * smoothstep(0.25, 0.85, density) + 0.25 * (fine - 0.5);
  let emission = (headOn + rim * (1.0 - headOn)) * max(clump, 0.08);
  let hot = smoothstep(0.55, 1.0, rim * clump);
  let color = mix(base, vec3<f32>(1.0), hot * 0.15) * emission;

  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  var out: MeshFragmentOut;
  out.color = vec4<f32>(color * gain * in.alpha * objectBrightness, 0.0);
  out.depth = logDepth(in.viewDepth);
  return out;
}

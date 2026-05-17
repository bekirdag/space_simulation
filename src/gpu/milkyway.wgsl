// Milky Way background star renderer — 100k stars spanning the galactic disk.
// Same 8-float buffer layout as star.wgsl but this pipeline has no selected-star
// boost.  Visibility is gated by lodFade (binding 2) so these stars only appear
// when the camera is far from the solar system origin.
//
// Buffer layout per star (32 bytes):
//   vec4 pos_size:    xyz = compressed ecliptic AU position, w = size multiplier
//   vec4 color_alpha: rgb = star colour, w = base alpha

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct Star {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera:  Camera;
@group(0) @binding(1) var<storage, read> stars:   array<Star>;
@group(0) @binding(2) var<uniform>       lodFade: vec4<f32>; // x=fade 0..1, y=legacy apparent boost, z=brightness effects

const CLOSE_STAR_SPHERE_LOD_START_PX: f32 = 2.25;
const CLOSE_STAR_SPHERE_LOD_FULL_PX:  f32 = 4.50;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       brightness: f32,
  @location(4)       effects: f32,
  @location(5)       pixel_radius: f32,
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
  vec2(-1.0, 1.0), vec2(1.0,-1.0), vec2( 1.0,1.0),
);

fn stellar_luminosity_proxy(color: vec3<f32>, size: f32, alpha: f32) -> f32 {
  let blueWeight = clamp((color.b - color.r + 0.35) / 0.70, 0.0, 1.0);
  let warmWeight = clamp((color.r - color.b + 0.20) / 0.80, 0.0, 1.0);
  let spectralLum = mix(0.65, 18.0, blueWeight) * mix(1.0, 0.55, warmWeight * (1.0 - blueWeight));
  return spectralLum * (0.35 + size * 0.65) * (0.65 + alpha);
}

fn apparent_mw_brightness(cameraDistanceAU: f32, color: vec3<f32>, size: f32, alpha: f32) -> f32 {
  let distKpc = max(cameraDistanceAU / 8000.0, 0.10);
  let flux = stellar_luminosity_proxy(color, size, alpha) / (distKpc * distKpc);
  return clamp(pow(max(flux * 8.0, 0.0001), 0.45), 0.05, 2.8);
}

fn subtle_spectral_color(color: vec3<f32>) -> vec3<f32> {
  // Preserve temperature class without pushing the Milky Way field into
  // over-saturated red/blue pixels after HDR tone mapping.
  return clamp(mix(vec3<f32>(1.0), color, 0.82), vec3<f32>(0.0), vec3<f32>(1.0));
}

@vertex
fn vs_main(
  @builtin(vertex_index)   vi:  u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let star   = stars[idx];
  let uv     = quad[vi];
  let center = star.pos_size.xyz;
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv    = uv;
  out.color = star.color_alpha.xyz;
  let actual = lodFade.y > 0.5;
  out.effects = clamp(lodFade.z, 0.0, 1.0);
  out.pixel_radius = 0.0;
  let cameraDistanceAU = length(center - camera.eyeAndFlags.xyz);
  out.brightness = select(1.0, apparent_mw_brightness(cameraDistanceAU, out.color, star.pos_size.w, star.color_alpha.w), actual);
  out.alpha = star.color_alpha.w * lodFade.x * select(1.0, clamp(0.35 + out.brightness, 0.25, 2.1), actual);

  // Skip invisible or back-facing instances
  if lodFade.x < 0.01 || clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // ── Frustum culling ────────────────────────────────────────────────────────
  // Cull only once the complete billboard is outside the frame.
  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let sizeMult = star.pos_size.w * select(1.0, clamp(0.55 + out.brightness, 0.45, 2.8), actual);
  let pxRadius = camera.rightAndMNR.w * max(sizeMult * 1.8, 0.6);
  out.pixel_radius = pxRadius * 2.5 / max(camera.rightAndMNR.w, 0.000001);
  let cullMargin = max(pxRadius * 1.5, 0.06);
  if ndcX - cullMargin > 1.0 || ndcX + cullMargin < -1.0 ||
     ndcY - cullMargin > 1.0 || ndcY + cullMargin < -1.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Fixed-size billboard expanded from the projected center in clip space.
  // This keeps small but inspectable Milky Way stars round instead of letting
  // large galactic coordinates quantize the quad corners.
  let focalY      = camera.upAndFocal.w;
  let worldRadius = pxRadius * clip_c.w / focalY;
  let clipRight = camera.viewProj * vec4(camera.rightAndMNR.xyz * worldRadius, 0.0);
  let clipUp = camera.viewProj * vec4(camera.upAndFocal.xyz * worldRadius, 0.0);
  let clipOffset = uv.x * clipRight + uv.y * clipUp;

  out.clip_pos = clip_c + vec4(clipOffset.xy, 0.0, 0.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }
  let edgeAa = clamp(max(fwidth(d), 0.85 / max(in.pixel_radius, 1.0)), 0.0015, 0.085);
  let silhouette = 1.0 - smoothstep(1.0 - edgeAa, 1.0, d);
  if silhouette <= 0.001 { discard; }

  // Same Lorentzian PSF as the nearby star shader
  let d2    = d * d;
  let core  = exp(-d2 * 22.0);
  let wings = max(0.0, 1.0 / (1.0 + d2 * 10.0) - 0.09);

  let spectral = mix(in.color, subtle_spectral_color(in.color), in.effects);
  var col = spectral;
  let lift   = mix(1.0, clamp(pow(max(in.brightness, 0.08), 0.28), 0.55, 1.8), in.effects);
  let bleach = clamp(core * in.alpha * (0.95 + lift * 0.42) * in.effects, 0.0, 1.0);
  let coreWhite = mix(spectral, vec3<f32>(1.0, 0.985, 0.94), 0.30);
  col = mix(spectral, coreWhite, bleach);

  let psf = mix(core, core * 1.12 + wings * 0.58, in.effects);
  var alpha = clamp(psf * in.alpha * mix(1.0, 0.72 + lift * 0.42, in.effects) * silhouette, 0.0, 1.0);
  let intensity = mix(1.0, clamp(pow(max(in.brightness, 0.05), 1.55) * 10.5, 0.40, 95.0), in.effects);
  var hdr = col * psf * in.alpha * intensity * silhouette;

  // Close/background Milky Way stars should not expose the quad impostor.
  // Keep the cheap PSF for tiny distant points, then blend into an implicit
  // spherical photosphere once the projected radius is large enough to inspect.
  let sphereLod = smoothstep(CLOSE_STAR_SPHERE_LOD_START_PX, CLOSE_STAR_SPHERE_LOD_FULL_PX, in.pixel_radius);
  if sphereLod > 0.001 {
    let z = sqrt(max(0.0, 1.0 - d2));
    let normal = normalize(vec3<f32>(in.uv.x, in.uv.y, z));
    let lightDir = normalize(vec3<f32>(-0.38, 0.32, 0.87));
    let diffuse = max(dot(normal, lightDir), 0.0);
    let limb = pow(max(z, 0.0), 0.45);
    let hotSpot = pow(max(diffuse, 0.0), 18.0);
    let sphereCol = mix(
      spectral * (0.50 + diffuse * 0.34 + limb * 0.32),
      vec3<f32>(1.0, 0.985, 0.94),
      hotSpot * 0.30
    );
    let sphereAlpha = clamp(silhouette * in.alpha * (0.46 + limb * 0.54), 0.0, 1.0);
    let corona = exp(-d2 * 4.8) * 0.24;
    let sphereHdr = (
      sphereCol * in.alpha * intensity * (0.36 + limb * 0.72 + hotSpot * 0.42) +
      (spectral + vec3<f32>(corona * 0.20)) * intensity * corona * in.alpha
    ) * silhouette;
    hdr = mix(hdr, sphereHdr, sphereLod);
    alpha = mix(alpha, max(alpha, sphereAlpha), sphereLod);
  }

  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  return vec4<f32>(hdr * objectBrightness, alpha);
}

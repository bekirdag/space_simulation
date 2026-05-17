// Static catalog-star renderer.
//
// Star storage (32 bytes = 2 x vec4):
//   vec4 pos_size    - xyz = compressed catalog position, w = visual size multiplier
//   vec4 color_alpha - rgb = star color, w = alpha
//
// Binding 2: selectedStar (16 bytes)
//   xyz = world-space position of selected star, w = 1.0 if active else 0.0
//   When a star matches, its size is boosted 20× so it fills the view.

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

@group(0) @binding(0) var<uniform>       camera:       Camera;
@group(0) @binding(1) var<storage, read> stars:        array<Star>;
@group(0) @binding(2) var<uniform>       selectedStar: vec4<f32>; // xyz=pos, w=active
@group(0) @binding(3) var<uniform>       lodFade:      vec4<f32>; // x=1, y=camera AU from Sun, z=brightness effects

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       selected: f32,
  @location(4)       intensity: f32,
  @location(5)       effects: f32,
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
  vec2(-1.0, 1.0), vec2(1.0,-1.0), vec2( 1.0,1.0),
);

fn star_hdr_intensity(color: vec3<f32>, size: f32, alpha: f32) -> f32 {
  let blueWeight = clamp((color.b - color.r + 0.32) / 0.82, 0.0, 1.0);
  let warmWeight = clamp((color.r - color.b + 0.20) / 0.90, 0.0, 1.0);
  let spectralLum = mix(0.75, 4.5, blueWeight) * mix(1.0, 0.72, warmWeight * (1.0 - blueWeight));
  let catalogFlux = max(size * size * (0.28 + alpha * 1.35), 0.01);
  return clamp(pow(catalogFlux * spectralLum * 2.35, 1.85) * 8.0, 0.65, 260.0);
}

fn camera_distance_flux(center: vec3<f32>) -> f32 {
  let referenceDistanceAU = max(length(center), 1.0);
  let cameraDistanceAU = max(length(center - camera.eyeAndFlags.xyz), referenceDistanceAU * 0.0005);
  let ratio = clamp(referenceDistanceAU / cameraDistanceAU, 0.02, 400.0);
  return clamp(ratio * ratio, 0.0004, 160000.0);
}

fn subtle_spectral_color(color: vec3<f32>) -> vec3<f32> {
  // Keep the catalog temperature tint visible but restrained. Full-saturation
  // stellar colors look artificial once HDR bloom is added.
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
  out.uv       = uv;
  out.color    = star.color_alpha.xyz;
  out.alpha    = star.color_alpha.w;
  out.selected = 0.0;
  out.effects   = clamp(lodFade.z, 0.0, 1.0);
  let distanceFlux = camera_distance_flux(center);
  let distanceIntensity = clamp(pow(distanceFlux, 0.72), 0.08, 96.0);
  let distanceAlpha = clamp(pow(distanceFlux, 0.18), 0.22, 2.4);
  out.intensity = mix(1.0, star_hdr_intensity(out.color, star.pos_size.w, out.alpha) * distanceIntensity, out.effects);

  // ── Global LOD fade ────────────────────────────────────────────────────────
  // HYG nearby stars fade out as the camera moves far from the solar system
  // (>500 AU). At galaxy scale they all cluster into a dot and add visual noise.
  let cameraAU   = lodFade.y;
  let globalFade = clamp(1.0 - (cameraAU - 500.0) / 19500.0, 0.0, 1.0);
  let isSelected = selectedStar.w > 0.5 && length(center - selectedStar.xyz) < 0.5;
  out.alpha     *= select(globalFade, max(globalFade, 0.9), isSelected);
  out.alpha     *= mix(1.0, distanceAlpha, out.effects);

  if out.alpha <= 0.001 && !isSelected {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }
  if clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }
  out.selected = select(0.0, 1.0, isSelected);
  out.intensity = select(out.intensity, max(out.intensity, mix(1.0, 520.0, out.effects)), isSelected);

  // ── Frustum culling ────────────────────────────────────────────────────────
  // Cull only when the whole billboard is outside the frame plus a small margin.
  // Center-only tests can hide visible edge billboards.
  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let distanceSizeLift = mix(1.0, clamp(pow(distanceFlux, 0.14), 0.65, 7.0), out.effects);
  let billboardNdcRadius = camera.rightAndMNR.w * max(star.pos_size.w * distanceSizeLift * 1.8, 0.6);
  let cullMargin = max(billboardNdcRadius * 1.5, 0.06);
  if ndcX - cullMargin > 1.0 || ndcX + cullMargin < -1.0 ||
     ndcY - cullMargin > 1.0 || ndcY + cullMargin < -1.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let focalY = camera.upAndFocal.w;

  // Selected star: render as a PHYSICAL SPHERE so it grows as you zoom in.
  // A fixed-NDC billboard stays the same size regardless of distance, which
  // makes zoom feel broken. A sphere with radius ≈ 1 solar radius in our
  // compressed coordinate system creates the natural "approaching a star" sensation.
  if isSelected {

    // Physical radius ≈ 1 solar radius = 0.005 AU in compressed coordinates.
    // At 0.5 AU camera distance: apparent radius ≈ 24px. At 0.05 AU: ≈ 240px.
    let physRadius = 0.005;
    let physNdcR   = physRadius * focalY / clip_c.w;
    // Never shrink below 3× the base minimum so the star stays visible at range.
    let worldR = max(physNdcR, camera.rightAndMNR.w * 3.0) * clip_c.w / focalY;

    out.clip_pos = camera.viewProj * vec4(
      center + uv.x * camera.rightAndMNR.xyz * worldR
             + uv.y * camera.upAndFocal.xyz  * worldR,
      1.0,
    );
    return out;
  }

  // Normal (non-selected) stars: enforce minimum pixel radius (fixed-NDC billboard).
  let pxRadius    = billboardNdcRadius;
  let worldRadius = pxRadius * clip_c.w / focalY;
  let world_pos   = center
    + uv.x * camera.rightAndMNR.xyz * worldRadius
    + uv.y * camera.upAndFocal.xyz  * worldRadius;

  out.clip_pos = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  // ── Physically realistic stellar PSF ─────────────────────────────────────
  // Real stars have a Lorentzian (power-law) halo, not a smoothstep.
  // Combination of tight Gaussian core + Lorentzian wings closely matches
  // what a real star looks like on a CCD or to the dark-adapted human eye.
  let d2    = d * d;
  let core  = exp(-d2 * 22.0);                            // tight Gaussian nucleus
  let wings = max(0.0, 1.0 / (1.0 + d2 * 10.0) - 0.09); // Lorentzian halo

  // ── Core bleaching ────────────────────────────────────────────────────────
  // Bright stars saturate to near-white in their centres (CCDs overexpose,
  // the eye bleaches at peak brightness). Faint stars retain their hue fully.
  let spectral = mix(in.color, subtle_spectral_color(in.color), in.effects);
  let coreWhite = mix(spectral, vec3<f32>(1.0, 0.985, 0.94), 0.34);
  var col = spectral;
  let bleach = clamp(core * in.alpha * 1.25 * in.effects, 0.0, 1.0);
  col = mix(spectral, coreWhite, bleach);

  let psf = mix(core, core * 1.20 + wings * 0.62, in.effects);
  var alpha = clamp(psf * in.alpha * mix(1.0, 1.35, in.effects), 0.0, 1.0);
  var hdr = col * psf * in.intensity * in.alpha;

  // ── Selected star: glowing physical sphere ────────────────────────────────
  if in.selected > 0.5 && in.effects > 0.001 {
    let glow  = exp(-d2 * 4.0);
    let bloom = max(0.0, 1.0 - d);
    hdr  += (spectral + vec3<f32>(glow * 0.42)) * (glow * 120.0 + bloom * bloom * 60.0);
    alpha = clamp(glow * 0.9 + bloom * bloom * 0.35, 0.0, 1.0);
  }

  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  return vec4<f32>(hdr * objectBrightness, alpha);
}

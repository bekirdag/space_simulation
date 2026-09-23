// Static catalog-star renderer.
//
// Star storage (32 bytes = 2 x vec4):
//   vec4 pos_size    - xyz = compressed catalog position, w = physical radius AU
//   vec4 color_alpha - rgb = star color, w = apparent-brightness alpha
//
// Binding 2: selectedStar (16 bytes)
//   xyz = world-space position of selected star, w = 1.0 if active else 0.0
//   When a star matches, it switches to a close spherical LOD.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
  eyeAndFlags: vec4<f32>,
  screenAndTarget: vec4<f32>,
  eyeOffset:       vec4<f32>,
};

struct Star {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera:       Camera;
@group(0) @binding(1) var<storage, read> stars:        array<Star>;
@group(0) @binding(2) var<uniform>       selectedStar: vec4<f32>; // xyz=pos, w=active
@group(0) @binding(3) var<uniform>       lodFade:      vec4<f32>; // x=1, y=camera AU from Sun, z=brightness effects

const CLOSE_STAR_SPHERE_LOD_START_PX: f32 = 2.25;
const CLOSE_STAR_SPHERE_LOD_FULL_PX:  f32 = 4.50;
const CAMERA_NEAR: f32 = 1e-8;
const CAMERA_FAR:  f32 = 500000000.0;
const SOLAR_RADIUS_AU: f32 = 0.00465047;
const SUN_STELLAR_MARKER_FADE_START_AU: f32 = 128.0;
const SUN_STELLAR_MARKER_FADE_FULL_AU:  f32 = 512.0;

// ── Band-limited point PSF (anti-twinkle) ─────────────────────────────────
// Unresolved stars are drawn as a Gaussian evaluated in *pixel* units. A PSF
// narrower than ~0.7 px is under-sampled by the pixel grid, so its per-pixel
// energy swings with the sub-pixel phase and stars wink while the view rotates.
// With sigma >= 0.72 px the summed pixel energy is phase invariant to <0.1 %.
const POINT_SIGMA_MIN_PX: f32 = 0.72;
const POINT_SIGMA_MAX_PX: f32 = 0.95;
// Soft ceiling for the per-star HDR peak so saturated cores (and the bloom
// bright-pass fed by them) stay a stable size instead of spreading along the
// Gaussian tails of very bright stars.
const POINT_PEAK_SOFT_MAX: f32 = 28.0;
// HDR level at which the Gaussian tail is cut by the quad edge.
const POINT_TAIL_CUTOFF: f32 = 0.004;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       selected: f32,
  @location(4)       intensity: f32,
  @location(5)       effects: f32,
  @location(6)       pixel_radius: f32, // quad radius in device pixels
  @location(7)       disk_px: f32,      // sphere-LOD radius in device pixels
  @location(8)       point_sigma: f32,  // PSF sigma in device pixels
  @location(9)       point_gain: f32,   // flux-normalised, clamped PSF peak
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
  vec2(-1.0, 1.0), vec2(1.0,-1.0), vec2( 1.0,1.0),
);

fn star_hdr_intensity(color: vec3<f32>, radiusAU: f32, alpha: f32) -> f32 {
  let blueWeight = clamp((color.b - color.r + 0.32) / 0.82, 0.0, 1.0);
  let warmWeight = clamp((color.r - color.b + 0.20) / 0.90, 0.0, 1.0);
  let spectralLum = mix(0.75, 4.5, blueWeight) * mix(1.0, 0.72, warmWeight * (1.0 - blueWeight));
  let radiusSolar = clamp(radiusAU / SOLAR_RADIUS_AU, 0.01, 1800.0);
  let radiusLift = clamp(pow(radiusSolar, 0.16), 0.38, 3.2);
  let catalogFlux = max(alpha * alpha * (0.55 + radiusLift * 0.35), 0.008);
  return clamp(pow(catalogFlux * spectralLum * 2.15, 1.65) * 7.5, 0.45, 240.0);
}

fn point_sigma_px(markerPx: f32) -> f32 {
  return clamp(markerPx * 0.46, POINT_SIGMA_MIN_PX, POINT_SIGMA_MAX_PX);
}

// The legacy marker (0.72 plateau of radius 0.54·marker plus a tight core)
// emitted ≈ 0.70·marker² of energy. Keep that total flux so apparent star
// brightness is unchanged while the energy is spread over a sampled PSF.
fn point_flux_norm(markerPx: f32, sigmaPx: f32) -> f32 {
  return 0.70 * markerPx * markerPx / (6.2831853 * sigmaPx * sigmaPx);
}

fn soft_clamp_peak(v: f32) -> f32 {
  return POINT_PEAK_SOFT_MAX * (1.0 - exp(-max(v, 0.0) / POINT_PEAK_SOFT_MAX));
}

fn point_extent_px(sigmaPx: f32, peak: f32) -> f32 {
  let reach = sqrt(2.0 * log(max(peak / POINT_TAIL_CUTOFF, 1.0)));
  return sigmaPx * clamp(reach, 3.0, 4.6) + 0.5;
}

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

fn camera_distance(center: vec3<f32>) -> f32 {
  return length(camera_relative(center));
}

fn clip_billboard_offset(uv: vec2<f32>, radiusNdcY: f32, clipW: f32) -> vec4<f32> {
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  // NDC x covers the viewport width while NDC y covers the viewport height.
  // Use an aspect-corrected x radius so a circular UV mask stays circular in
  // screen pixels on wide displays.
  return vec4<f32>(uv.x * radiusNdcY / aspect * clipW, uv.y * radiusNdcY * clipW, 0.0, 0.0);
}

fn camera_distance_flux(center: vec3<f32>) -> f32 {
  let referenceDistanceAU = max(length(center), 1.0);
  let distanceAU = max(camera_distance(center), referenceDistanceAU * 0.02);
  // The catalog alpha already stores apparent brightness near the Sun. Camera
  // distance should shape brightness, but not make stars pulse while panning.
  let ratio = clamp(referenceDistanceAU / distanceAU, 0.18, 22.0);
  return clamp(pow(ratio, 1.15), 0.20, 34.8);
}

fn subtle_spectral_color(color: vec3<f32>) -> vec3<f32> {
  // Keep the catalog temperature tint visible but restrained. Full-saturation
  // stellar colors look artificial once HDR bloom is added.
  return clamp(mix(vec3<f32>(1.0), color, 0.94), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn cool_star_weight(color: vec3<f32>) -> f32 {
  return clamp((color.r - max(color.g, color.b) + 0.08) / 0.58, 0.0, 1.0);
}

fn bright_spectral_color(color: vec3<f32>, coolWeight: f32) -> vec3<f32> {
  return color * mix(1.06, 1.24, coolWeight);
}

@vertex
fn vs_main(
  @builtin(vertex_index)   vi:  u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let star   = stars[idx];
  let uv     = quad[vi];
  let center = star.pos_size.xyz;
  let clip_c = project_world(center);

  var out: VertexOut;
  out.uv       = uv;
  out.color    = star.color_alpha.xyz;
  out.alpha    = star.color_alpha.w;
  out.selected = 0.0;
  out.effects   = clamp(lodFade.z, 0.0, 1.0);
  out.pixel_radius = 0.0;
  out.disk_px = 0.0;
  out.point_sigma = POINT_SIGMA_MIN_PX;
  out.point_gain = 0.0;
  let distanceFlux = camera_distance_flux(center);
  let distanceIntensity = clamp(pow(distanceFlux, 0.82), 0.28, 18.0);
  let distanceAlpha = clamp(pow(distanceFlux, 0.10), 0.72, 1.38);
  out.intensity = mix(1.0, star_hdr_intensity(out.color, star.pos_size.w, out.alpha) * distanceIntensity, out.effects);

  // ── Global LOD fade ────────────────────────────────────────────────────────
  // HYG nearby stars fade out as the camera moves far from the solar system
  // (>5 000 AU). At galaxy scale they all cluster into a dot and add visual noise.
  let cameraAU   = lodFade.y;
  // Range scaled with the 80 AU/pc galaxy (galactic centre ≈ 640 000 AU):
  // fully visible within ~60 pc, gone by ~2.5 kpc from the Sun.
  let globalFade = clamp(1.0 - (cameraAU - 5000.0) / 195000.0, 0.0, 1.0);
  let isSelected = selectedStar.w > 0.5 && length(center - selectedStar.xyz) < 0.5;
  let isSunAnchor = length(center) < 0.05 &&
    star.pos_size.w > SOLAR_RADIUS_AU * 0.80 &&
    star.pos_size.w < SOLAR_RADIUS_AU * 1.20;
  let sunAnchorFade = select(
    1.0,
    smoothstep(SUN_STELLAR_MARKER_FADE_START_AU, SUN_STELLAR_MARKER_FADE_FULL_AU, cameraAU),
    isSunAnchor,
  );
  let persistentAnchor = isSelected || isSunAnchor;
  out.alpha     *= select(globalFade, max(globalFade, 0.9), persistentAnchor);
  out.alpha     *= sunAnchorFade;
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

  // ── Frustum culling ────────────────────────────────────────────────────────
  // Cull only when the whole billboard is outside the frame plus a small margin.
  // Center-only tests can hide visible edge billboards.
  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let focalY = camera.upAndFocal.w;
  let radiusAU = max(star.pos_size.w, SOLAR_RADIUS_AU * 0.01);
  let radiusSolar = clamp(radiusAU / SOLAR_RADIUS_AU, 0.01, 1800.0);
  let physicalNdcRadius = radiusAU * focalY / max(clip_c.w, 0.000001);
  // Keep unresolved stars close to a point-marker size. Physical radius takes
  // over through `physicalNdcRadius` only when the stellar disk is actually
  // resolvable, so giants do not make the Sun look wrongly tiny at catalog scale.
  let radiusMarkerLift = clamp(pow(radiusSolar, 0.06), 0.85, 1.35);
  let alphaMarkerLift = clamp(pow(max(out.alpha, 0.04), 0.35), 0.55, 1.35);
  let pointNdcRadius = camera.rightAndMNR.w * max(
    (0.58 + 0.12 * alphaMarkerLift) * radiusMarkerLift,
    0.38,
  );
  // All sizing below is in device pixels (MNR corresponds to 2.5 px).
  let ndcToPx = 2.5 / max(camera.rightAndMNR.w, 0.000001);
  let markerPx = pointNdcRadius * ndcToPx;
  // Sphere-LOD radius: physical disk once resolved, legacy marker otherwise.
  out.disk_px = max(physicalNdcRadius, pointNdcRadius) * ndcToPx;
  out.point_sigma = point_sigma_px(markerPx);
  out.point_gain = soft_clamp_peak(
    point_flux_norm(markerPx, out.point_sigma) * out.intensity * out.alpha
  );
  // The quad must hold the whole Gaussian (>= 3 sigma, more for bright stars)
  // and the anti-aliased sphere silhouette.
  let quadPx = max(out.disk_px + 1.0, point_extent_px(out.point_sigma, out.point_gain));
  let billboardNdcRadius = quadPx / ndcToPx;
  let cullMargin = max(billboardNdcRadius * 1.5, 0.06);
  if ndcX - cullMargin > 1.0 || ndcX + cullMargin < -1.0 ||
     ndcY - cullMargin > 1.0 || ndcY + cullMargin < -1.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Expand from the projected center in clip space so tiny star quads do not
  // lose precision when their catalog positions are far from the origin.
  out.pixel_radius = quadPx;
  out.clip_pos = with_log_depth(clip_c + clip_billboard_offset(uv, billboardNdcRadius, clip_c.w));
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);

  // ── Band-limited point PSF ─────────────────────────────────────────────────
  // Gaussian in device-pixel units: wide enough to be sampled by the pixel
  // grid, so the star's summed energy does not depend on its sub-pixel phase.
  // The window only removes the (already < POINT_TAIL_CUTOFF) quad edge.
  let rPx = d * in.pixel_radius;
  let sigma = max(in.point_sigma, 0.001);
  let psf = exp(-(rPx * rPx) / (2.0 * sigma * sigma)) * (1.0 - smoothstep(0.82, 1.0, d));

  // Sphere-LOD coordinates: the resolved disk may be smaller than the quad.
  let diskScale = in.pixel_radius / max(in.disk_px, 0.0001);
  let suv = in.uv * diskScale;
  let sd = d * diskScale;
  let edgeAa = clamp(max(fwidth(sd), 0.85 / max(in.disk_px, 1.0)), 0.0015, 0.42);
  let silhouette = 1.0 - smoothstep(1.0 - edgeAa, 1.0 + edgeAa, sd);
  let sphereLod = max(
    in.selected,
    smoothstep(CLOSE_STAR_SPHERE_LOD_START_PX, CLOSE_STAR_SPHERE_LOD_FULL_PX, in.disk_px)
  );
  if psf <= 0.00001 && (silhouette <= 0.001 || sphereLod <= 0.001) { discard; }

  // ── Color-preserving bright core ───────────────────────────────────────────
  // Brightness should increase the star's own spectral color, not bleach every
  // star toward white. The final tone mapper preserves luminance/chroma ratios.
  let baseSpectral = mix(in.color, subtle_spectral_color(in.color), in.effects);
  let coolWeight = cool_star_weight(baseSpectral);
  let spectral = mix(baseSpectral, pow(baseSpectral, vec3<f32>(2.25)), coolWeight * in.effects * 0.72);
  let coreTint = bright_spectral_color(spectral, coolWeight);
  var col = spectral;
  let bleach = clamp(psf * in.alpha * mix(1.10, 0.06, coolWeight) * in.effects, 0.0, 1.0);
  col = mix(spectral, coreTint, bleach);

  var alpha = clamp(psf * in.alpha * mix(1.0, 1.18, in.effects), 0.0, 1.0);
  var hdr = col * psf * in.point_gain;

  // ── Close LOD: implicit spherical photosphere ─────────────────────────────
  // Large star billboards expose the underlying quad/PSF approximation. Blend
  // them into a shaded sphere with an anti-aliased silhouette when close.
  if sphereLod > 0.001 {
    let sd2 = sd * sd;
    let z = sqrt(max(0.0, 1.0 - sd2));
    let normal = normalize(vec3<f32>(suv.x, suv.y, z));
    let lightDir = normalize(vec3<f32>(-0.38, 0.32, 0.87));
    let diffuse = max(dot(normal, lightDir), 0.0);
    let limb = pow(max(z, 0.0), 0.45);
    let hotSpot = pow(max(diffuse, 0.0), 18.0);
    let sphereHotMix = mix(0.26, 0.015, coolWeight);
    let sphereCol = mix(spectral * (0.50 + diffuse * 0.36 + limb * 0.32), bright_spectral_color(spectral, coolWeight), hotSpot * sphereHotMix);
    let sphereAlpha = clamp(silhouette * mix(in.alpha * (0.45 + limb * 0.55), 1.0, in.selected), 0.0, 1.0);
    let corona = exp(-sd2 * 4.8) * mix(0.28, 0.52, in.selected);
    let sphereHdr = (
      sphereCol * in.intensity * mix(in.alpha, 1.0, in.selected) * (0.38 + limb * 0.74 + hotSpot * 0.60) +
      (spectral + vec3<f32>(corona * 0.28 * (1.0 - coolWeight * 0.72))) * in.intensity * corona
    ) * silhouette;
    hdr = mix(hdr, sphereHdr, sphereLod);
    alpha = mix(alpha, max(alpha, sphereAlpha), sphereLod);
  }

  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  return vec4<f32>(hdr * objectBrightness, alpha);
}

// Logarithmic depth shared with solar-system-model.wgsl / milkyway-model.wgsl /
// render.wgsl / trail.wgsl (keep LOG_DEPTH_* in sync). The standard hyperbolic
// depth collapses to 1.0 beyond a few AU, so every depth-tested scene layer
// writes log2 view depth instead. Billboards keep the same clip w on all
// corners, so z = logDepth(w) * w is exact for the whole sprite (centre depth).
const LOG_DEPTH_K: f32 = 1e-9;
const LOG_DEPTH_INV_RANGE: f32 = 0.016666667; // 1 / log2(1 + 1e9 / 1e-9) ~= 1 / 59.79

fn logDepth(viewDepth: f32) -> f32 {
  return clamp(log2(1.0 + max(viewDepth, 0.0) / LOG_DEPTH_K) * LOG_DEPTH_INV_RANGE, 0.0, 1.0);
}

fn with_log_depth(clip: vec4<f32>) -> vec4<f32> {
  return vec4<f32>(clip.xy, logDepth(clip.w) * clip.w, clip.w);
}

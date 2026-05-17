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
const CAMERA_FAR:  f32 = 50000000.0;
const SOLAR_RADIUS_AU: f32 = 0.00465047;
const SUN_STELLAR_MARKER_FADE_START_AU: f32 = 128.0;
const SUN_STELLAR_MARKER_FADE_FULL_AU:  f32 = 512.0;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       selected: f32,
  @location(4)       intensity: f32,
  @location(5)       effects: f32,
  @location(6)       pixel_radius: f32,
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
  let cameraDistanceAU = max(camera_distance(center), referenceDistanceAU * 0.0005);
  let ratio = clamp(referenceDistanceAU / cameraDistanceAU, 0.02, 400.0);
  return clamp(ratio * ratio, 0.0004, 160000.0);
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
  let distanceSizeLift = mix(1.0, clamp(pow(distanceFlux, 0.045), 0.85, 1.8), out.effects);
  let pointNdcRadius = camera.rightAndMNR.w * max(
    (0.58 + 0.12 * alphaMarkerLift) * radiusMarkerLift * distanceSizeLift,
    0.38,
  );
  let billboardNdcRadius = max(physicalNdcRadius, pointNdcRadius);
  let cullMargin = max(billboardNdcRadius * 1.5, 0.06);
  if ndcX - cullMargin > 1.0 || ndcX + cullMargin < -1.0 ||
     ndcY - cullMargin > 1.0 || ndcY + cullMargin < -1.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Normal (non-selected) stars: enforce minimum pixel radius. Expand from the
  // projected center in clip space so tiny star quads do not lose precision
  // when their catalog positions are far from the origin.
  let pxRadius    = billboardNdcRadius;
  out.pixel_radius = pxRadius * 2.5 / max(camera.rightAndMNR.w, 0.000001);
  out.clip_pos = clip_c + clip_billboard_offset(uv, pxRadius, clip_c.w);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  let edgeAa = clamp(max(fwidth(d), 0.85 / max(in.pixel_radius, 1.0)), 0.0015, 0.42);
  let silhouette = 1.0 - smoothstep(1.0 - edgeAa, 1.0 + edgeAa, d);
  if silhouette <= 0.001 { discard; }

  // ── Crisp distant-star impostor ─────────────────────────────────────────
  // Far stars should read as defined points, not blurred smears. Keep only a
  // tight anti-aliased core here; close selections still blend into a sphere.
  let d2    = d * d;
  let core  = exp(-d2 * 46.0);
  let pointDisk = 1.0 - smoothstep(0.54 - edgeAa, 0.54 + edgeAa, d);
  let pointCore = max(core, pointDisk * 0.72);

  // ── Color-preserving bright core ───────────────────────────────────────────
  // Brightness should increase the star's own spectral color, not bleach every
  // star toward white. The final tone mapper preserves luminance/chroma ratios.
  let baseSpectral = mix(in.color, subtle_spectral_color(in.color), in.effects);
  let coolWeight = cool_star_weight(baseSpectral);
  let spectral = mix(baseSpectral, pow(baseSpectral, vec3<f32>(2.25)), coolWeight * in.effects * 0.72);
  let coreTint = bright_spectral_color(spectral, coolWeight);
  var col = spectral;
  let bleach = clamp(pointCore * in.alpha * mix(1.10, 0.06, coolWeight) * in.effects, 0.0, 1.0);
  col = mix(spectral, coreTint, bleach);

  let pointProfile = pointCore * silhouette;
  var alpha = clamp(pointProfile * in.alpha * mix(1.0, 1.18, in.effects), 0.0, 1.0);
  var hdr = col * pointProfile * in.intensity * in.alpha;

  // ── Close LOD: implicit spherical photosphere ─────────────────────────────
  // Large star billboards expose the underlying quad/PSF approximation. Blend
  // them into a shaded sphere with an anti-aliased silhouette when close.
  let sphereLod = max(
    in.selected,
    smoothstep(CLOSE_STAR_SPHERE_LOD_START_PX, CLOSE_STAR_SPHERE_LOD_FULL_PX, in.pixel_radius)
  );
  if sphereLod > 0.001 {
    let z = sqrt(max(0.0, 1.0 - d2));
    let normal = normalize(vec3<f32>(in.uv.x, in.uv.y, z));
    let lightDir = normalize(vec3<f32>(-0.38, 0.32, 0.87));
    let diffuse = max(dot(normal, lightDir), 0.0);
    let limb = pow(max(z, 0.0), 0.45);
    let hotSpot = pow(max(diffuse, 0.0), 18.0);
    let sphereHotMix = mix(0.26, 0.015, coolWeight);
    let sphereCol = mix(spectral * (0.50 + diffuse * 0.36 + limb * 0.32), bright_spectral_color(spectral, coolWeight), hotSpot * sphereHotMix);
    let sphereAlpha = clamp(silhouette * mix(in.alpha * (0.45 + limb * 0.55), 1.0, in.selected), 0.0, 1.0);
    let corona = exp(-d2 * 4.8) * mix(0.28, 0.52, in.selected);
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

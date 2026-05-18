// Milky Way background star renderer — 100k stars spanning the galactic disk.
// Same 8-float buffer layout as star.wgsl but this pipeline has no selected-star
// boost.  Visibility is gated by lodFade (binding 2) so these stars only appear
// when the camera is far from the solar system origin.
//
// Buffer layout per star (32 bytes):
//   vec4 pos_size:    xyz = compressed ecliptic AU position, w = physical radius AU
//   vec4 color_alpha: rgb = star colour, w = base alpha

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

@group(0) @binding(0) var<uniform>       camera:  Camera;
@group(0) @binding(1) var<storage, read> stars:   array<Star>;
@group(0) @binding(2) var<uniform>       lodFade: vec4<f32>; // x=fade 0..1, y=legacy apparent boost, z=brightness effects

const CLOSE_STAR_SPHERE_LOD_START_PX: f32 = 2.25;
const CLOSE_STAR_SPHERE_LOD_FULL_PX:  f32 = 4.50;
const CAMERA_NEAR: f32 = 1e-8;
const CAMERA_FAR:  f32 = 50000000.0;
const SOLAR_RADIUS_AU: f32 = 0.00465047;

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

fn stellar_luminosity_proxy(color: vec3<f32>, radiusAU: f32, alpha: f32) -> f32 {
  let blueWeight = clamp((color.b - color.r + 0.35) / 0.70, 0.0, 1.0);
  let warmWeight = clamp((color.r - color.b + 0.20) / 0.80, 0.0, 1.0);
  let spectralLum = mix(0.65, 18.0, blueWeight) * mix(1.0, 0.55, warmWeight * (1.0 - blueWeight));
  let radiusSolar = clamp(radiusAU / SOLAR_RADIUS_AU, 0.08, 600.0);
  let radiusLum = clamp(pow(radiusSolar, 0.55), 0.35, 12.0);
  return spectralLum * radiusLum * (0.65 + alpha);
}

fn apparent_mw_brightness(cameraDistanceAU: f32, color: vec3<f32>, radiusAU: f32, alpha: f32) -> f32 {
  let distKpc = max(cameraDistanceAU / 8000.0, 0.10);
  let flux = stellar_luminosity_proxy(color, radiusAU, alpha) / (distKpc * distKpc);
  return clamp(pow(max(flux * 8.0, 0.0001), 0.45), 0.05, 2.8);
}

fn subtle_spectral_color(color: vec3<f32>) -> vec3<f32> {
  // Preserve temperature class without pushing the Milky Way field into
  // over-saturated red/blue pixels after HDR tone mapping.
  return clamp(mix(vec3<f32>(1.0), color, 0.94), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn cool_star_weight(color: vec3<f32>) -> f32 {
  return clamp((color.r - max(color.g, color.b) + 0.08) / 0.58, 0.0, 1.0);
}

fn bright_spectral_color(color: vec3<f32>, coolWeight: f32) -> vec3<f32> {
  return color * mix(1.06, 1.24, coolWeight);
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

fn stable_focus_distance(center: vec3<f32>) -> f32 {
  let targetDelta = center - camera.screenAndTarget.yzw;
  let orbitDelta = camera.eyeOffset.xyz;
  return max(sqrt(dot(targetDelta, targetDelta) + dot(orbitDelta, orbitDelta)), 1e-6);
}

fn clip_billboard_offset(uv: vec2<f32>, radiusNdcY: f32, clipW: f32) -> vec4<f32> {
  let aspect = max(camera.screenAndTarget.x, 0.000001);
  return vec4<f32>(uv.x * radiusNdcY / aspect * clipW, uv.y * radiusNdcY * clipW, 0.0, 0.0);
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
  out.uv    = uv;
  out.color = star.color_alpha.xyz;
  let actual = lodFade.z > 0.5;
  out.effects = clamp(lodFade.z, 0.0, 1.0);
  out.pixel_radius = 0.0;
  let cameraDistanceAU = stable_focus_distance(center);
  let radiusAU = max(star.pos_size.w, SOLAR_RADIUS_AU * 0.08);
  out.brightness = select(1.0, apparent_mw_brightness(cameraDistanceAU, out.color, radiusAU, star.color_alpha.w), actual);
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
  let focalY = camera.upAndFocal.w;
  let radiusSolar = clamp(radiusAU / SOLAR_RADIUS_AU, 0.08, 600.0);
  let physicalNdcRadius = radiusAU * focalY / max(clip_c.w, 0.000001);
  // Background stars are mostly unresolved point sources. Use physical radius
  // for angular disk size, but keep the fallback marker from exaggerating
  // giant/supergiant radii while they are still sub-pixel objects.
  let radiusMarkerLift = clamp(pow(radiusSolar, 0.06), 0.85, 1.35);
  let brightnessMarkerLift = select(
    1.0,
    clamp(pow(max(out.brightness, 0.08), 0.12), 0.75, 1.75),
    actual,
  );
  let pointNdcRadius = camera.rightAndMNR.w * max(
    (0.46 + 0.12 * out.alpha) * radiusMarkerLift * brightnessMarkerLift,
    0.35,
  );
  let pxRadius = max(physicalNdcRadius, pointNdcRadius);
  out.pixel_radius = pxRadius * 2.5 / max(camera.rightAndMNR.w, 0.000001);
  let cullMargin = max(pxRadius * 1.5, 0.06);
  if ndcX - cullMargin > 1.0 || ndcX + cullMargin < -1.0 ||
     ndcY - cullMargin > 1.0 || ndcY + cullMargin < -1.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Fixed-size billboard expanded from the projected center in clip space.
  // Keep the math target-relative like the catalog-star shader. Absolute
  // viewProj projection loses precision at galaxy scale and makes star HDR
  // brightness/culling flicker while orbiting or panning.
  out.clip_pos = clip_c + clip_billboard_offset(uv, pxRadius, clip_c.w);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  let edgeAa = clamp(max(fwidth(d), 0.85 / max(in.pixel_radius, 1.0)), 0.0015, 0.42);
  let silhouette = 1.0 - smoothstep(1.0 - edgeAa, 1.0 + edgeAa, d);
  if silhouette <= 0.001 { discard; }

  // Crisp distant-star impostor: use a tight point core instead of a soft PSF.
  let d2    = d * d;
  let core  = exp(-d2 * 46.0);
  let pointDisk = 1.0 - smoothstep(0.54 - edgeAa, 0.54 + edgeAa, d);
  let pointCore = max(core, pointDisk * 0.72);

  let baseSpectral = mix(in.color, subtle_spectral_color(in.color), in.effects);
  let coolWeight = cool_star_weight(baseSpectral);
  let spectral = mix(baseSpectral, pow(baseSpectral, vec3<f32>(2.25)), coolWeight * in.effects * 0.72);
  var col = spectral;
  let lift   = mix(1.0, clamp(pow(max(in.brightness, 0.08), 0.28), 0.55, 1.8), in.effects);
  let bleach = clamp(pointCore * in.alpha * (0.95 + lift * 0.42) * mix(1.0, 0.38, coolWeight) * in.effects, 0.0, 1.0);
  let coreTint = bright_spectral_color(spectral, coolWeight);
  col = mix(spectral, coreTint, bleach);

  let pointProfile = pointCore * silhouette;
  var alpha = clamp(pointProfile * in.alpha * mix(1.0, 0.72 + lift * 0.42, in.effects), 0.0, 1.0);
  let intensity = mix(1.0, clamp(pow(max(in.brightness, 0.05), 1.55) * 10.5, 0.40, 95.0), in.effects);
  var hdr = col * pointProfile * in.alpha * intensity;

  // Close/background Milky Way stars should not expose the quad impostor.
  // Keep a crisp point for tiny distant stars, then blend into an implicit
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
      bright_spectral_color(spectral, coolWeight),
      hotSpot * mix(0.30, 0.08, coolWeight)
    );
    let sphereAlpha = clamp(silhouette * in.alpha * (0.46 + limb * 0.54), 0.0, 1.0);
    let corona = exp(-d2 * 4.8) * 0.24;
    let sphereHdr = (
      sphereCol * in.alpha * intensity * (0.36 + limb * 0.72 + hotSpot * 0.42) +
      (spectral + vec3<f32>(corona * 0.20 * (1.0 - coolWeight * 0.72))) * intensity * corona * in.alpha
    ) * silhouette;
    hdr = mix(hdr, sphereHdr, sphereLod);
    alpha = mix(alpha, max(alpha, sphereAlpha), sphereLod);
  }

  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  return vec4<f32>(hdr * objectBrightness, alpha);
}

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
};

struct Star {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera:       Camera;
@group(0) @binding(1) var<storage, read> stars:        array<Star>;
@group(0) @binding(2) var<uniform>       selectedStar: vec4<f32>; // xyz=pos, w=active
@group(0) @binding(3) var<uniform>       lodFade:      vec4<f32>; // x=brightness, y=camera radius from Sun

// src/catalog/stars.ts compresses catalog positions to 80 render AU per parsec.
const RENDER_AU_PER_LIGHT_YEAR: f32 = 80.0 / 3.26156;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       selected: f32, // 1.0 if this is the selected star
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
  vec2(-1.0, 1.0), vec2(1.0,-1.0), vec2( 1.0,1.0),
);

fn smoother01(v: f32) -> f32 {
  let t = clamp(v, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
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

  let selectedMatch = selectedStar.w > 0.5 && length(center - selectedStar.xyz) < 0.5;
  let starDistanceLy = max(length(center) / RENDER_AU_PER_LIGHT_YEAR, 0.05);
  let cameraDistanceLy = max(lodFade.y / RENDER_AU_PER_LIGHT_YEAR, 0.0);
  let fadeInStartLy  = max(0.05, starDistanceLy * 0.24);
  let fadeInEndLy    = max(fadeInStartLy + 0.35, starDistanceLy * 0.55);
  let fadeOutStartLy = max(fadeInEndLy + 0.50, starDistanceLy * 2.35);
  let fadeOutEndLy   = max(fadeOutStartLy + 2.00, starDistanceLy * 3.40);
  let fadeIn  = smoother01((cameraDistanceLy - fadeInStartLy) / (fadeInEndLy - fadeInStartLy));
  let fadeOut = 1.0 - smoother01((cameraDistanceLy - fadeOutStartLy) / (fadeOutEndLy - fadeOutStartLy));
  let shellVisibility = fadeIn * fadeOut;
  out.alpha *= clamp(lodFade.x, 0.0, 1.0) * select(shellVisibility, max(shellVisibility, 0.9), selectedMatch);

  if out.alpha <= 0.001 && !selectedMatch {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  if clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // ── Frustum culling ────────────────────────────────────────────────────────
  // Cull only when the whole billboard is outside the frame plus a small margin.
  // Center-only tests can hide visible edge billboards.
  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let billboardNdcRadius = camera.rightAndMNR.w * max(star.pos_size.w * 1.8, 0.6);
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
  if selectedMatch {
    out.selected = 1.0;

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
  var col    = in.color;
  let bleach = clamp(core * in.alpha * 1.6, 0.0, 1.0);
  col = mix(col, vec3<f32>(1.0, 0.97, 0.94), bleach * 0.65);

  var alpha = clamp((core * 0.80 + wings * 0.55) * in.alpha * 2.8, 0.0, 1.0);

  // ── Selected star: glowing physical sphere ────────────────────────────────
  if in.selected > 0.5 {
    let glow  = exp(-d2 * 4.0);
    let bloom = max(0.0, 1.0 - d);
    col   = col + vec3<f32>(glow * 0.5);
    alpha = clamp(glow * 0.9 + bloom * bloom * 0.35, 0.0, 1.0);
  }

  return vec4<f32>(col * alpha, alpha);
}

// Galaxy renderer — soft elliptical blobs distinct from point-like stars.
//
// Each galaxy is a billboard quad scaled by size_mult and rendered with a
// gentle core + extended halo to suggest a fuzzy galactic disk.
//
// Buffer layout identical to stars (8 floats per entry):
//   vec4 pos_size  — xyz = ecliptic visual position (AU), w = size multiplier
//   vec4 col_alpha — rgb = colour, w = alpha

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct Galaxy {
  pos_size:  vec4<f32>,
  col_alpha: vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera:  Camera;
@group(0) @binding(1) var<storage, read> galaxies: array<Galaxy>;
@group(0) @binding(2) var<uniform>       galaxyLod: vec4<f32>; // x=legacy apparent boost, y=brightness effects

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       brightness: f32,
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
  vec2(-1.0, 1.0), vec2(1.0,-1.0), vec2( 1.0,1.0),
);

fn visual_radius_to_mpc(radiusAU: f32) -> f32 {
  let linearLimitMpc = 2.0;
  let mpcToAU = 8000000.0;
  let linearLimitAU = linearLimitMpc * mpcToAU;
  if radiusAU <= linearLimitAU {
    return max(radiusAU / mpcToAU, 0.02);
  }
  return linearLimitMpc + 2.0 * (pow(2.0, (radiusAU - linearLimitAU) / 1200000.0) - 1.0);
}

// ── Physically-grounded brightness ───────────────────────────────────────
//
// Three requirements:
//   1. Bigger / more luminous galaxies are brighter.
//   2. High-energy (warm-colour) objects are brighter.
//   3. Camera distance to the galaxy drives apparent brightness (1/r²).
//
// Bug in old code: visual_radius_to_mpc() inverts the log-scale applied to
// a galaxy's *position from the origin*. Passing the camera→galaxy vector
// through it produces nonsense once the camera moves away from the origin.
//
// Fix: derive galaxy Mpc from its origin distance; scale by how close the
// camera is relative to that distance.

fn apparent_galaxy_brightness(center: vec3<f32>, eye: vec3<f32>,
                               size: f32, col: vec3<f32>, alpha: f32) -> f32 {
  // ── Physical distance (Mpc) ───────────────────────────────────────────────
  let galMpc    = max(visual_radius_to_mpc(length(center)), 0.008);
  let galAU     = max(length(center), 1.0);
  let distRatio = max(length(center - eye), 0.01) / galAU;
  let effMpc    = max(galMpc * distRatio, 0.005);

  // ── Intrinsic luminosity proxy ────────────────────────────────────────────
  let sizeLum = max(size * size, 0.09);
  let warmth  = clamp((col.r - col.b + 0.5) * 1.2, 0.5, 2.2);
  let surfBrt = 0.35 + alpha * 1.1;
  let intrinsic = sizeLum * warmth * surfBrt;

  // ── Calibrated flux → display brightness ─────────────────────────────────
  // NOTE: galaxy fragment returns vec4(col, a) — non-premultiplied.
  // With srcFactor=src_alpha blend: output = col * a + dst (correct additive glow).
  // If we returned vec4(col*a, a) the GPU would do col*a*a = col*a², making
  // everything ~10-100x too dark (which is why galaxies appeared invisible).
  //
  // Calibrated to NASA apparent magnitudes (additive display, dark background):
  //   LMC       (V=0.9,  0.050 Mpc) → peak pixel alpha ≈ 0.37 (bright naked-eye)
  //   Andromeda (V=3.44, 0.785 Mpc) → peak pixel alpha ≈ 0.09 (faint naked-eye)
  //   M87 Virgo (V=8.6,  16.4  Mpc) → peak pixel alpha ≈ 0.02 (small telescope)
  //   100 Mpc galaxy                 → peak pixel alpha ≈ 0.006
  let flux = intrinsic / (effMpc * effMpc);
  let C = 0.00010;
  return clamp(pow(max(flux * C, 0.000000001), 0.25), 0.0002, 0.60);
}

@vertex
fn vs_main(
  @builtin(vertex_index)   vi:  u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let g      = galaxies[idx];
  let uv     = quad[vi];
  let center = g.pos_size.xyz;
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv    = uv;
  out.color = g.col_alpha.xyz;
  let actual = galaxyLod.x > 0.5;
  out.brightness = select(1.0,
    apparent_galaxy_brightness(center, camera.eyeAndFlags.xyz,
                               g.pos_size.w, g.col_alpha.xyz, g.col_alpha.w),
    actual);
  // ── Zoom-out brightness boost (> 10 kpc from origin) ─────────────────────
  // At galaxy-scale distances the camera is far from the solar system.
  // Boost all galaxy brightnesses so they remain visible, while keeping
  // their relative brightness ordering (LMC still brighter than M87).
  // Uses a power-law ramp: starts at 10 kpc (80 000 AU), max ~15× at ≥1 Mpc.
  let camDistKpc  = length(camera.eyeAndFlags.xyz) / 8000.0;
  let boostRatio  = max(camDistKpc / 10.0, 1.0);         // 1.0 at ≤10 kpc
  let zoomBoost   = clamp(pow(boostRatio, 0.65), 1.0, 15.0);
  // Apply boost to intrinsic brightness; cap so nothing blows out completely.
  let boostedBr   = select(1.0, min(out.brightness * zoomBoost, 2.0), actual);

  out.alpha = g.col_alpha.w * boostedBr;

  if clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Size also scales with the boosted brightness so galaxies look like proper
  // blobs (not just single pixels) when the whole catalog is visible.
  let sizeMult = g.pos_size.w * select(1.0, clamp(0.55 + boostedBr * 2.5, 0.55, 2.0), actual);
  let catalogRadius = camera.rightAndMNR.w * max(sizeMult * 2.5, 0.8);

  // Catalog-only galaxies do not have physical 3D meshes. When the camera has
  // intentionally traveled very close to one, expand the billboard so the
  // clicked galaxy reads as a close-up target instead of remaining a tiny dot.
  let closeDist = length(center - camera.eyeAndFlags.xyz);
  let closeFocus = 1.0 - smoothstep(220.0, 900.0, closeDist);
  let pxRadius = max(catalogRadius, closeFocus * 0.5);

  // ── Frustum culling ────────────────────────────────────────────────────────
  // Cull only when the whole billboard is outside the frame plus a small margin.
  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let cullMargin = max(pxRadius * 1.5, 0.08);
  if ndcX - cullMargin > 1.0 || ndcX + cullMargin < -1.0 ||
     ndcY - cullMargin > 1.0 || ndcY + cullMargin < -1.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let focalY      = camera.upAndFocal.w;
  let worldRadius = pxRadius * clip_c.w / focalY;

  let world_pos = center
    + uv.x * camera.rightAndMNR.xyz * worldRadius
    + uv.y * camera.upAndFocal.xyz  * worldRadius;

  out.clip_pos = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  // ── Sérsic-like galaxy surface brightness profile ─────────────────────────
  // Real galaxies follow I(r) ∝ exp(-b·(r/re)^(1/n)):
  //   Ellipticals  n≈4  — concentrated bright core, extended faint halo
  //   Spirals      n≈1  — roughly exponential, more uniform
  //
  // We approximate with three radial components:
  //   Nucleus:  very tight, models the galactic bulge / AGN
  //   Disk:     exponential falloff, models the stellar disk
  //   Envelope: faint outer light, models the stellar halo / intracluster
  let d2      = d * d;
  let nucleus = exp(-d2 * 40.0);           // tight bulge
  let disk    = exp(-d  *  3.5);           // exponential disk
  let env     = max(0.0, 1.0 - d) * 0.4;  // faint outer envelope

  let profileBrightness = nucleus * 0.65 + disk * 0.45 + env * 0.15;
  let lift = clamp(pow(max(in.brightness, 0.08), 0.30), 0.55, 1.85);
  let a = clamp(profileBrightness * in.alpha * (1.10 + lift * 0.55), 0.0, 1.0);

  // ── Nucleus colour ────────────────────────────────────────────────────────
  // Galaxy nuclei are dominated by old K/M stars → warmer than the outer disk.
  // Ellipticals are warm throughout; spiral disks are bluer; irregular galaxies
  // are blue everywhere. We tint the centre toward warm yellow-white regardless
  // of type, which is physically correct (bulge stars are generally old and red).
  var col = in.color;
  let nucWarm = nucleus * 0.50;  // how much to shift toward warm nucleus colour
  col = mix(col, vec3<f32>(1.0, 0.88, 0.68), nucWarm * 0.55);

  // Return NON-premultiplied: (col, a) not (col*a, a).
  // The blend srcFactor=src_alpha then gives: col*a + dst (correct).
  return vec4<f32>(col, a);
}

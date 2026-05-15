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
@group(0) @binding(2) var<uniform>       galaxyLod: vec4<f32>; // x=actual brightness

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

fn apparent_galaxy_brightness(cameraDistanceAU: f32, size: f32, alpha: f32) -> f32 {
  let distMpc = max(visual_radius_to_mpc(cameraDistanceAU), 0.02);
  let luminosityProxy = size * size * (0.55 + alpha);
  let flux = luminosityProxy / (distMpc * distMpc);
  return clamp(pow(max(flux * 2.0, 0.00001), 0.42), 0.04, 3.4);
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
  let cameraDistanceAU = length(center - camera.eyeAndFlags.xyz);
  out.brightness = select(1.0, apparent_galaxy_brightness(cameraDistanceAU, g.pos_size.w, g.col_alpha.w), actual);
  out.alpha = g.col_alpha.w * select(1.0, clamp(0.28 + out.brightness, 0.18, 2.0), actual);

  if clip_c.w <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // Galaxies are rendered slightly larger than stars to give a "nebulous" feel
  let sizeMult = g.pos_size.w * select(1.0, clamp(0.65 + out.brightness * 0.75, 0.55, 2.7), actual);
  let pxRadius = camera.rightAndMNR.w * max(sizeMult * 2.5, 0.8);

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

  return vec4<f32>(col * a, a);
}

// 3D billboard body renderer.
//
// Camera uniform (112 bytes = 7 × vec4):
//   mat4x4 viewProj         — view-projection matrix (64 bytes)
//   vec4   rightAndMNR      — xyz = camera right, w = minNDCRadius for point layers
//   vec4   upAndFocal       — xyz = camera up,    w = focalY (= 1/tan(fovY/2))
//   vec4   eyeAndFlags      — xyz = camera world position, w = object brightness
//
// Body storage (64 bytes = 4 × vec4, matches JS BODY_FLOATS=16):
//   vec4 pos_mass  — x, y, z, mass
//   vec4 vel_rad   — vx, vy, vz, radius
//   vec4 acc_type  — brightness, observer reference distance AU, render visibility, btype
//   vec4 col_id    — r, g, b, id
//
// Billboard: quad vertices are offset from body center along camera right/up,
// so each body always faces the camera regardless of view angle.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,  // xyz=right, w=minNDCRadius for point layers
  upAndFocal:  vec4<f32>,  // xyz=up,    w=focalY
  eyeAndFlags: vec4<f32>,  // xyz=camera eye, w=object brightness
};

struct Body {
  pos_mass: vec4<f32>,
  vel_rad:  vec4<f32>,
  acc_type: vec4<f32>,
  col_id:   vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera: Camera;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,
  @location(1)       color:    vec3<f32>,
  @location(2)       btype:    f32,
  @location(3)       fade:     f32,  // 1.0 = fully visible, 0.0 = hidden
  @location(4)       brightness: f32,
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
  vec2(-1.0, 1.0), vec2(1.0,-1.0), vec2( 1.0,1.0),
);

fn camera_distance_adjusted_brightness(
  baseBrightness: f32,
  referenceDistanceAU: f32,
  cameraDistanceAU: f32,
  bodyRadiusAU: f32,
) -> f32 {
  if referenceDistanceAU <= 0.0 {
    return baseBrightness;
  }

  let safeReference = max(referenceDistanceAU, 1e-6);
  let minCameraDistance = max(bodyRadiusAU * 1.25, safeReference * 0.02);
  let safeCameraDistance = max(cameraDistanceAU, max(minCameraDistance, 1e-6));
  let ratio = clamp(safeReference / safeCameraDistance, 0.001, 1000.0);
  // Display brightness is already tone-mapped from magnitude, so apply the
  // inverse-square distance law through the same magnitude/display curve.
  return clamp(baseBrightness * pow(ratio, 0.7142857), 0.04, 240.0);
}

@vertex
fn vs_main(
  @builtin(vertex_index)   vi:  u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let b   = bodies[idx];
  let uv  = quad[vi];

  let center   = b.pos_mass.xyz;
  let r_phys   = b.vel_rad.w;
  let camRight = camera.rightAndMNR.xyz;
  let camUp    = camera.upAndFocal.xyz;

  // Project center to get clip-space depth (W component)
  let clip_c = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv      = uv;
  out.color   = b.col_id.xyz;
  out.btype   = b.acc_type.w;
  out.fade    = clamp(b.acc_type.z, 0.0, 1.0);
  let cameraDistanceAU = length(center - camera.eyeAndFlags.xyz);
  out.brightness = camera_distance_adjusted_brightness(
    max(b.acc_type.x, 0.0),
    b.acc_type.y,
    cameraDistanceAU,
    r_phys,
  );

  // Discard body behind the camera or suppressed by screen-density reduction.
  if clip_c.w <= 0.0 || out.fade <= 0.001 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // The core body keeps its actual physical radius. Brightness mode may expand
  // the quad only for optical glow around that core.
  let glowScale = clamp(1.0 + log2(max(out.brightness, 1.0)) * 0.65, 1.0, 8.0);
  let world_pos = center + uv.x * camRight * r_phys * glowScale + uv.y * camUp * r_phys * glowScale;
  out.clip_pos  = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  let brightness = max(in.brightness, 0.0);
  let displayLift = clamp(pow(max(brightness, 0.08), 0.35), 0.50, 5.25);
  let glowScale = clamp(1.0 + log2(max(brightness, 1.0)) * 0.65, 1.0, 8.0);
  let sphereD = d * glowScale;
  let coreEdge = 1.0 - smoothstep(0.985, 1.0, sphereD);
  var coreAlpha = coreEdge * in.fade;
  var coreCol = in.color;
  if sphereD <= 1.0 {
    let z = sqrt(max(0.0, 1.0 - sphereD * sphereD));
    if in.btype < 0.5 {
      let core = 1.0 - smoothstep(0.0, 0.55, sphereD);
      let limb = 0.76 + 0.24 * z;
      let starLift = clamp(pow(max(brightness, 1.0), 0.22), 1.0, 3.2);
      let hdrStarLift = clamp(pow(max(brightness, 1.0), 0.58), 1.0, 85.0);
      coreCol = (coreCol * (limb + core * 0.35) * starLift + vec3(core * 0.18)) * hdrStarLift;
    } else {
      let sphereUv = in.uv * glowScale;
      let normal = normalize(vec3(sphereUv.x, sphereUv.y, z));
      let lightDir = normalize(vec3(-0.42, 0.34, 0.84));
      let diffuse = max(dot(normal, lightDir), 0.0);
      let rimShade = 0.78 + 0.22 * z;
      let nightSide = 0.18;
      coreCol = coreCol * (nightSide + diffuse * 0.82) * rimShade * displayLift;
    }
  } else {
    coreAlpha = 0.0;
  }

  let coreRadius = 1.0 / glowScale;
  let glowPower = clamp(log2(max(brightness, 1.0)) * 0.10, 0.0, 0.55);
  var haloAlpha = 0.0;
  if glowPower > 0.0 && glowScale > 1.001 {
    haloAlpha = (1.0 - smoothstep(coreRadius, 1.0, d)) * glowPower * in.fade;
  }
  var haloCol = in.color * (0.55 + glowPower * 1.5);
  if in.btype < 0.5 {
    haloAlpha = max(haloAlpha, (1.0 - smoothstep(0.0, 1.0, d)) * clamp(log2(max(brightness, 1.0)) * 0.045, 0.0, 0.38) * in.fade);
    haloCol *= clamp(pow(max(brightness, 1.0), 0.42), 1.0, 34.0);
  }
  let outAlpha = max(coreAlpha, haloAlpha);
  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  let outCol = (coreCol * coreAlpha + haloCol * haloAlpha) * objectBrightness;
  return vec4<f32>(outCol, outAlpha);
}

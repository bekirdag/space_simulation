// Textured solar-system bodies as ray-traced ellipsoid impostors.
//
// Each body is drawn as the back faces of its bounding box; the fragment shader
// intersects the view ray with the (tri-axial) ellipsoid in the body-fixed IAU
// frame, so the silhouette is exactly round at any zoom and the depth written
// is the true surface depth (log depth, shared with the other model passes).
//
// Body frame (IAU/NAIF): +X prime meridian, +Z north pole, +Y 90 deg east.
// Textures are equirectangular with u = 0.5 at longitude 0 and east longitude
// increasing with u; `params.x` shifts that for maps with no surface reference.

struct Camera {
  viewProj:         mat4x4<f32>,
  rightAndMNR:     vec4<f32>,
  upAndFocal:      vec4<f32>,
  eyeAndFlags:     vec4<f32>,
  screenAndTarget: vec4<f32>,
  eyeOffset:       vec4<f32>,
};

struct Body {
  centerEye: vec4<f32>, // xyz = body centre relative to the eye (ecliptic AU), w = mean radius AU
  axes:      vec4<f32>, // xyz = semi-axes / radius (body frame), w = ring shadow flag
  right:     vec4<f32>, // body +X in ecliptic J2000
  up:        vec4<f32>, // body +Y in ecliptic J2000
  axis:      vec4<f32>, // body +Z (north pole) in ecliptic J2000
  sun:       vec4<f32>, // xyz = unit direction toward the Sun, w = kind
  params:    vec4<f32>, // x = texture longitude at u=0.5 (deg), y = opacity, z = has texture, w = limb darkening
  rings:     vec4<f32>, // x = inner radius, y = outer radius (body radii), z = atmosphere rim strength, w = emissive
  tint:      vec4<f32>, // rgb = fallback / atmosphere colour, w = ambient
};

@group(0) @binding(0) var<uniform> camera: Camera;
@group(0) @binding(1) var<uniform> body: Body;
@group(0) @binding(2) var surfaceSampler: sampler;
@group(0) @binding(3) var colorTex: texture_2d<f32>;
@group(0) @binding(4) var auxTex: texture_2d<f32>;

const KIND_ROCKY: f32 = 0.0;
const KIND_GAS: f32 = 1.0;
const KIND_SUN: f32 = 2.0;
const KIND_EARTH: f32 = 3.0;

const CAMERA_NEAR: f32 = 1e-8;
const CAMERA_FAR: f32 = 500000000.0;
const PI: f32 = 3.14159265358979;
const TAU: f32 = 6.28318530717959;

// Logarithmic depth shared with milkyway-model.wgsl / render.wgsl.
const LOG_DEPTH_K: f32 = 1e-9;
const LOG_DEPTH_INV_RANGE: f32 = 0.016666667;
// The colour pass re-computes the depth written by the depth pre-pass in a
// separately compiled entry point; pull it forward by a few 24-bit ULPs so it
// always passes less-equal against its own pre-pass value.
const COLOR_PASS_DEPTH_BIAS: f32 = 3e-7;

fn logDepth(viewDepth: f32) -> f32 {
  return clamp(log2(1.0 + max(viewDepth, 0.0) / LOG_DEPTH_K) * LOG_DEPTH_INV_RANGE, 0.0, 1.0);
}

fn cameraBack() -> vec3<f32> {
  return normalize(cross(normalize(camera.rightAndMNR.xyz), normalize(camera.upAndFocal.xyz)));
}

fn projectEyeRelative(relativeToEye: vec3<f32>) -> vec4<f32> {
  let right = normalize(camera.rightAndMNR.xyz);
  let up = normalize(camera.upAndFocal.xyz);
  let back = cross(right, up);
  let view = vec3<f32>(dot(relativeToEye, right), dot(relativeToEye, up), dot(relativeToEye, back));
  let aspect = max(camera.screenAndTarget.x, 1e-6);
  let focalY = camera.upAndFocal.w;
  // Constant NDC z (0.5): real depth comes from frag_depth. Clipping still
  // removes geometry behind the eye (w <= 0).
  return vec4<f32>((focalY / aspect) * view.x, focalY * view.y, 0.5 * -view.z, -view.z);
}

fn bodyToWorld(v: vec3<f32>) -> vec3<f32> {
  return body.right.xyz * v.x + body.up.xyz * v.y + body.axis.xyz * v.z;
}

fn worldToBody(v: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(v, body.right.xyz), dot(v, body.up.xyz), dot(v, body.axis.xyz));
}

// ── Bounding box (36 vertices, back faces drawn) ─────────────────────────────

var<private> CUBE: array<vec3<f32>, 36> = array<vec3<f32>, 36>(
  // +X
  vec3(1.0, -1.0, -1.0), vec3(1.0, 1.0, -1.0), vec3(1.0, 1.0, 1.0),
  vec3(1.0, -1.0, -1.0), vec3(1.0, 1.0, 1.0), vec3(1.0, -1.0, 1.0),
  // -X
  vec3(-1.0, -1.0, -1.0), vec3(-1.0, 1.0, 1.0), vec3(-1.0, 1.0, -1.0),
  vec3(-1.0, -1.0, -1.0), vec3(-1.0, -1.0, 1.0), vec3(-1.0, 1.0, 1.0),
  // +Y
  vec3(-1.0, 1.0, -1.0), vec3(1.0, 1.0, 1.0), vec3(1.0, 1.0, -1.0),
  vec3(-1.0, 1.0, -1.0), vec3(-1.0, 1.0, 1.0), vec3(1.0, 1.0, 1.0),
  // -Y
  vec3(-1.0, -1.0, -1.0), vec3(1.0, -1.0, -1.0), vec3(1.0, -1.0, 1.0),
  vec3(-1.0, -1.0, -1.0), vec3(1.0, -1.0, 1.0), vec3(-1.0, -1.0, 1.0),
  // +Z
  vec3(-1.0, -1.0, 1.0), vec3(1.0, -1.0, 1.0), vec3(1.0, 1.0, 1.0),
  vec3(-1.0, -1.0, 1.0), vec3(1.0, 1.0, 1.0), vec3(-1.0, 1.0, 1.0),
  // -Z
  vec3(-1.0, -1.0, -1.0), vec3(1.0, 1.0, -1.0), vec3(1.0, -1.0, -1.0),
  vec3(-1.0, -1.0, -1.0), vec3(-1.0, 1.0, -1.0), vec3(1.0, 1.0, -1.0),
);

struct GlobeOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) eyeRel: vec3<f32>,
};

@vertex
fn vs_globe(@builtin(vertex_index) vi: u32) -> GlobeOut {
  // Slightly oversized so the anti-aliased rim stays inside the box.
  let local = CUBE[vi] * body.axes.xyz * body.centerEye.w * 1.02;
  let eyeRel = body.centerEye.xyz + bodyToWorld(local);
  var out: GlobeOut;
  out.clipPos = projectEyeRelative(eyeRel);
  out.eyeRel = eyeRel;
  return out;
}

struct Hit {
  pB: vec3<f32>,       // hit point on the unit sphere (scaled body frame)
  coverage: f32,       // analytic anti-aliased silhouette coverage
  viewDepth: f32,
  normalW: vec3<f32>,
  viewW: vec3<f32>,    // unit vector toward the eye
  normalB: vec3<f32>,
};

fn traceGlobe(eyeRel: vec3<f32>) -> Hit {
  let radius = body.centerEye.w;
  let axes = body.axes.xyz;
  let rdW = normalize(eyeRel);
  // Ray in the scaled body frame, where the ellipsoid is the unit sphere.
  let ro = worldToBody(-body.centerEye.xyz) / (axes * radius);
  let rd = worldToBody(rdW) / axes;
  let a = dot(rd, rd);
  let tca = -dot(ro, rd) / a;
  let closest = ro + rd * tca;
  let h = length(closest);
  // Silhouette AA: distance to the limb in pixels via screen derivatives.
  let aa = max(fwidth(h), 1e-7);
  let coverage = clamp((1.0 - h) / aa + 0.5, 0.0, 1.0);
  let hc = min(h, 1.0);
  let t = tca - sqrt(max(1.0 - hc * hc, 0.0) / a);
  let pB = normalize(ro + rd * t);
  let hitEye = body.centerEye.xyz + bodyToWorld(pB * axes * radius);

  var out: Hit;
  out.pB = pB;
  out.coverage = coverage;
  out.viewDepth = -dot(hitEye, cameraBack());
  out.normalB = normalize(pB / axes);
  out.normalW = normalize(bodyToWorld(out.normalB));
  out.viewW = -rdW;
  return out;
}

// ── Surface shading ──────────────────────────────────────────────────────────

fn hash31(p: vec3<f32>) -> f32 {
  return fract(sin(dot(p, vec3<f32>(127.1, 311.7, 74.7))) * 43758.5453123);
}

fn valueNoise3(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash31(i + vec3<f32>(0.0, 0.0, 0.0));
  let n100 = hash31(i + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = hash31(i + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = hash31(i + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = hash31(i + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = hash31(i + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = hash31(i + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = hash31(i + vec3<f32>(1.0, 1.0, 1.0));
  let nx00 = mix(n000, n100, u.x);
  let nx10 = mix(n010, n110, u.x);
  let nx01 = mix(n001, n101, u.x);
  let nx11 = mix(n011, n111, u.x);
  return mix(mix(nx00, nx10, u.y), mix(nx01, nx11, u.y), u.z);
}

fn fbm3(p: vec3<f32>) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  for (var i = 0; i < 4; i++) {
    sum += valueNoise3(p * freq) * amp;
    freq *= 2.07;
    amp *= 0.52;
  }
  return sum;
}

fn solarSurfaceColor(p: vec3<f32>, mu: f32) -> vec3<f32> {
  let convection = fbm3(p * 28.0);
  let fineCells = fbm3(p * 86.0 + vec3<f32>(7.1, 13.7, 3.5));
  let lon = atan2(p.y, p.x);
  let filament = sin(lon * 14.6 + sin(asin(clamp(p.z, -1.0, 1.0)) * 12.0) * 1.8) * 0.5 + 0.5;
  let activeSeed = fbm3(p * 9.5 + vec3<f32>(21.0, 4.0, 11.0));
  let equatorialBias = 1.0 - smoothstep(0.15, 0.92, abs(p.z));
  let sunspot = smoothstep(0.82, 0.96, activeSeed) * equatorialBias;
  let faculae = smoothstep(0.62, 0.90, convection) * (1.0 - sunspot * 0.85);
  let detail = clamp(convection * 0.58 + fineCells * 0.30 + filament * 0.12, 0.0, 1.0);
  let cool = vec3<f32>(0.92, 0.36, 0.055);
  let base = vec3<f32>(1.0, 0.62, 0.14);
  let hot = vec3<f32>(1.0, 0.88, 0.42);
  let spot = vec3<f32>(0.34, 0.085, 0.018);
  var color = mix(cool, hot, detail);
  color = mix(color, base, 0.28);
  color = mix(color, hot * 1.08, faculae * 0.38);
  color = mix(color, spot, sunspot * 0.72);
  // Photospheric limb darkening.
  let limb = 0.40 + 0.60 * pow(clamp(mu, 0.0, 1.0), 0.45);
  return color * limb;
}

fn ringCoord(r: f32) -> f32 {
  return (r - body.rings.x) / max(body.rings.y - body.rings.x, 1e-6);
}

// `lod` is the mip level of the 2048-texel radial ring strip.
fn ringAlpha(r: f32, lod: f32) -> vec4<f32> {
  let s = ringCoord(r);
  if s <= 0.0 || s >= 1.0 { return vec4<f32>(0.0); }
  return textureSampleLevel(auxTex, surfaceSampler, vec2<f32>(s, 0.5), lod);
}

fn ringLod(r: f32) -> f32 {
  return log2(max(fwidth(ringCoord(r)) * 2048.0, 1.0));
}

// Equirectangular UV with seam-safe gradients (Tarini): pick the derivative of
// whichever of u / u+0.5 does not wrap across this pixel quad.
struct SurfaceUv {
  uv: vec2<f32>,
  ddx: vec2<f32>,
  ddy: vec2<f32>,
};

fn surfaceUv(pB: vec3<f32>) -> SurfaceUv {
  let lon = atan2(pB.y, pB.x);
  let lat = asin(clamp(pB.z, -1.0, 1.0));
  let u = lon / TAU + 0.5 - body.params.x / 360.0;
  let v = 0.5 - lat / PI;
  let u1 = fract(u);
  let u2 = fract(u + 0.5) - 0.5;
  let dx1 = dpdx(u1);
  let dy1 = dpdy(u1);
  let dx2 = dpdx(u2);
  let dy2 = dpdy(u2);
  let useFirst = abs(dx1) + abs(dy1) <= abs(dx2) + abs(dy2) + 1e-6;
  var out: SurfaceUv;
  out.uv = vec2<f32>(u1, v);
  out.ddx = vec2<f32>(select(dx2, dx1, useFirst), dpdx(v));
  out.ddy = vec2<f32>(select(dy2, dy1, useFirst), dpdy(v));
  return out;
}

struct FragmentOut {
  @location(0) color: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fs_globe_depth(in: GlobeOut) -> @builtin(frag_depth) f32 {
  let hit = traceGlobe(in.eyeRel);
  if hit.coverage < 0.5 { discard; }
  return logDepth(hit.viewDepth);
}

@fragment
fn fs_globe(in: GlobeOut) -> FragmentOut {
  let hit = traceGlobe(in.eyeRel);
  let suv = surfaceUv(hit.pB);
  let kind = body.sun.w;
  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  let n = hit.normalW;
  let viewW = hit.viewW;
  let mu = clamp(dot(n, viewW), 0.0, 1.0);

  var albedo = body.tint.rgb;
  if body.params.z > 0.5 {
    albedo = textureSampleGrad(colorTex, surfaceSampler, suv.uv, suv.ddx, suv.ddy).rgb;
  }
  let aux = textureSampleGrad(auxTex, surfaceSampler, suv.uv, suv.ddx, suv.ddy);

  var color: vec3<f32>;
  if kind == KIND_SUN {
    color = solarSurfaceColor(hit.pB, mu) * body.rings.w;
  } else {
    let L = normalize(body.sun.xyz);
    let ndl = dot(n, L);
    var diffuse = max(ndl, 0.0);
    // Gas giants: soft terminator (deep atmosphere scattering).
    if kind == KIND_GAS {
      diffuse = smoothstep(-0.06, 0.35, ndl) * (0.35 + 0.65 * max(ndl, 0.0));
    }
    // Limb darkening (strong for gas giants, weak for regoliths).
    let limb = mix(1.0, 0.35 + 0.65 * pow(mu, 0.55), body.params.w);

    // Saturn: ring shadow on the globe.
    var shadow = 1.0;
    if body.axes.w > 0.5 {
      let pReal = hit.pB * body.axes.xyz;
      let Lb = worldToBody(L);
      if abs(Lb.z) > 1e-4 {
        let t = -pReal.z / Lb.z;
        if t > 0.0 {
          let q = pReal + Lb * t;
          shadow = 1.0 - ringAlpha(length(q.xy), 3.0).a * 0.85;
        }
      }
    }

    var surface = albedo;
    if kind == KIND_EARTH {
      let clouds = aux.g;
      surface = mix(surface, vec3<f32>(0.96, 0.97, 1.0), clamp(clouds * 1.05, 0.0, 1.0));
    }
    let sunGain = 1.3;
    let ambient = body.tint.w;
    color = surface * (ambient + diffuse * sunGain * shadow) * limb;

    if kind == KIND_EARTH {
      // City lights on the night side, dimmed under clouds.
      let night = 1.0 - smoothstep(-0.12, 0.06, ndl);
      let lights = pow(aux.r, 2.2) * night * (1.0 - aux.g * 0.85);
      color += vec3<f32>(1.0, 0.72, 0.38) * lights * 1.6;
    }
    // Thin-atmosphere rim (Earth, Titan, Venus...).
    if body.rings.z > 0.0 {
      let rim = pow(1.0 - mu, 3.0);
      let lit = smoothstep(-0.25, 0.35, ndl);
      color += body.tint.rgb * rim * lit * body.rings.z;
    }
    // Faint emissive floor keeps the night side readable at sprite scales.
    color += surface * body.rings.w;
  }

  let alpha = hit.coverage * clamp(body.params.y, 0.0, 1.0);
  if alpha <= 0.002 { discard; }
  var out: FragmentOut;
  out.color = vec4<f32>(color * objectBrightness * alpha, alpha);
  out.depth = max(logDepth(hit.viewDepth) - COLOR_PASS_DEPTH_BIAS, 0.0);
  return out;
}

// ── Rings (planar annulus in the body equatorial plane) ──────────────────────

var<private> QUAD: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(1.0, 1.0),
  vec2(-1.0, -1.0), vec2(1.0, 1.0), vec2(-1.0, 1.0),
);

struct RingOut {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) planeB: vec2<f32>, // body-frame position in body radii
  @location(1) eyeRel: vec3<f32>,
};

@vertex
fn vs_ring(@builtin(vertex_index) vi: u32) -> RingOut {
  let q = QUAD[vi] * body.rings.y * 1.01;
  let eyeRel = body.centerEye.xyz + bodyToWorld(vec3<f32>(q, 0.0) * body.centerEye.w);
  var out: RingOut;
  out.clipPos = projectEyeRelative(eyeRel);
  out.planeB = q;
  out.eyeRel = eyeRel;
  return out;
}

fn shadeRing(in: RingOut, lod: f32) -> vec4<f32> {
  let r = length(in.planeB);
  let tex = ringAlpha(r, lod);
  if tex.a <= 0.004 { return vec4<f32>(0.0); }
  let L = normalize(body.sun.xyz);
  let Lb = worldToBody(L);
  let Vb = worldToBody(-normalize(in.eyeRel));
  // Planet shadow on the rings: does the ray toward the Sun hit the globe?
  let ro = vec3<f32>(in.planeB, 0.0) / body.axes.xyz;
  let rd = Lb / body.axes.xyz;
  let a = dot(rd, rd);
  let b = dot(ro, rd);
  let c = dot(ro, ro) - 1.0;
  let disc = b * b - a * c;
  var shadow = 1.0;
  if disc > 0.0 && -b > 0.0 { shadow = 0.04; }
  // Lit face vs. the unlit face seen in diffuse transmission.
  let litSide = sign(Lb.z) * sign(Vb.z) > 0.0;
  let sunElevation = clamp(abs(Lb.z), 0.0, 1.0);
  let illum = select(0.30 * (1.0 - tex.a) + 0.08, 0.55 + 0.45 * pow(sunElevation, 0.25), litSide);
  let albedo = clamp(tex.rgb * 1.9, vec3<f32>(0.0), vec3<f32>(1.0));
  let color = albedo * illum * shadow * 1.35 + albedo * body.tint.w;
  return vec4<f32>(color, tex.a);
}

@fragment
fn fs_ring_depth(in: RingOut) -> @builtin(frag_depth) f32 {
  let r = length(in.planeB);
  if ringAlpha(r, ringLod(r)).a < 0.5 { discard; }
  return logDepth(-dot(in.eyeRel, cameraBack()));
}

@fragment
fn fs_ring(in: RingOut) -> FragmentOut {
  let shaded = shadeRing(in, ringLod(length(in.planeB)));
  let alpha = shaded.a * clamp(body.params.y, 0.0, 1.0);
  if alpha <= 0.004 { discard; }
  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  var out: FragmentOut;
  out.color = vec4<f32>(shaded.rgb * objectBrightness * alpha, alpha);
  out.depth = max(logDepth(-dot(in.eyeRel, cameraBack())) - COLOR_PASS_DEPTH_BIAS, 0.0);
  return out;
}

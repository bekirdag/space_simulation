// Nebula renderer — procedural billboard sprites using FBM noise.
//
// No texture files: each nebula's shape is uniquely generated from its
// `seed` parameter using Fractal Brownian Motion (FBM) noise.
// The result looks like real long-exposure astrophotography nebulas.
//
// Buffer layout per nebula (4 × vec4 = 64 bytes):
//   vec4 pos_size:    xyz = ecliptic AU position, w = billboard radius AU
//   vec4 color_alpha: rgb = emission colour, w = base alpha
//   vec4 params:      x = type (0-4), y = seed (0-1000), z = brightness, w = _pad
//   vec4 _pad

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct Nebula {
  pos_size:    vec4<f32>,
  color_alpha: vec4<f32>,
  params:      vec4<f32>,
  _pad:        vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera:  Camera;
@group(0) @binding(1) var<storage, read> nebulas: array<Nebula>;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       uv:       vec2<f32>,  // -1..+1
  @location(1)       color:    vec3<f32>,
  @location(2)       alpha:    f32,
  @location(3)       ntype:    f32,
  @location(4)       seed:     f32,
};

var<private> quad: array<vec2<f32>, 6> = array<vec2<f32>, 6>(
  vec2(-1.0,-1.0), vec2(1.0,-1.0), vec2(-1.0,1.0),
  vec2(-1.0, 1.0), vec2(1.0,-1.0), vec2( 1.0,1.0),
);

@vertex
fn vs_main(
  @builtin(vertex_index)   vi:  u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let neb     = nebulas[idx];
  let uv      = quad[vi];
  let center  = neb.pos_size.xyz;
  let radius  = neb.pos_size.w;
  let clip_c  = camera.viewProj * vec4(center, 1.0);

  var out: VertexOut;
  out.uv    = uv;
  out.color = neb.color_alpha.xyz;
  out.alpha = neb.color_alpha.w;
  out.ntype = neb.params.x;
  out.seed  = neb.params.y;

  if clip_c.w <= 0.0 || radius <= 0.0 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  // ── Frustum cull ─────────────────────────────────────────────────────────
  // Nebulas can be large billboards so we use a generous 1.25 margin.
  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let pxSize = radius * camera.upAndFocal.w / clip_c.w; // NDC size
  if ndcX - pxSize > 1.25 || ndcX + pxSize < -1.25 ||
     ndcY - pxSize > 1.25 || ndcY + pxSize < -1.25 {
    out.clip_pos = vec4(10.0, 10.0, 10.0, 1.0);
    return out;
  }

  let world_pos = center
    + uv.x * camera.rightAndMNR.xyz * radius
    + uv.y * camera.upAndFocal.xyz  * radius;

  out.clip_pos = camera.viewProj * vec4(world_pos, 1.0);
  return out;
}

// ── Procedural noise ──────────────────────────────────────────────────────────

fn hash2(p: vec2<f32>) -> f32 {
  let k = vec2<f32>(0.31831, 0.36788);
  let q = p * k + k.yx;
  return -1.0 + 2.0 * fract(16.0 * k.x * fract(q.x * q.y * (q.x + q.y)));
}

fn noise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);  // smoothstep
  return mix(
    mix(hash2(i),               hash2(i + vec2(1.0, 0.0)), u.x),
    mix(hash2(i + vec2(0.0, 1.0)), hash2(i + vec2(1.0, 1.0)), u.x),
    u.y,
  );
}

fn fbm(p: vec2<f32>, octaves: i32) -> f32 {
  var f   = 0.0;
  var amp = 0.5;
  var q   = p;
  for (var i = 0; i < octaves; i++) {
    f  += amp * noise2(q);
    q  *= 2.17;     // slight rotation helps avoid axis-aligned artefacts
    q  += vec2<f32>(0.73, 1.31) * f32(i);
    amp *= 0.52;
  }
  return f;
}

// ── Fragment shader ───────────────────────────────────────────────────────────

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  let d = length(in.uv);
  if d > 1.0 { discard; }

  // Seed shifts the noise to give each nebula a unique shape
  let s   = in.seed * 0.01;
  let p   = in.uv * 3.5 + vec2<f32>(s, s * 1.27);

  // ── Cloud shape from FBM noise ─────────────────────────────────────────────
  // 5 octaves → detailed wispy structure
  let cloud = (fbm(p, 5) + 1.0) * 0.5;  // normalise 0..1

  // ── Radial profile: softer at edges (no sharp boundary) ───────────────────
  let falloff = 1.0 - smoothstep(0.2, 1.0, d);
  let density = cloud * falloff;

  // ── Type-specific appearance ───────────────────────────────────────────────
  var shape = density;
  var col   = in.color;

  if in.ntype < 0.5 {
    // Emission: wispy, irregular, with bright knots
    let knot = max(0.0, fbm(p * 2.5 + vec2<f32>(1.3, 2.1), 3));
    shape = smoothstep(0.25, 0.85, density + knot * 0.35);
    // Emission core slightly brighter/whiter
    col = mix(col, col + vec3<f32>(0.15, 0.05, 0.05), shape * 0.4);

  } else if in.ntype < 1.5 {
    // Planetary: fairly symmetric shell with brighter rim
    let shell = select(0.3, 1.0, abs(d - 0.45) < 0.25); // WGSL uses select(), not ? :
    shape = smoothstep(0.3, 0.9, density) * (0.6 + shell * 0.7);
    shape = min(shape, 1.0 - d * d * 0.6);
    col = mix(col, vec3<f32>(0.7, 1.0, 0.9), 0.25);

  } else if in.ntype < 2.5 {
    // SNR (supernova remnant): diffuse shell, filamentary
    let fila = fbm(p * 4.0 + vec2<f32>(2.7, 3.1), 4);
    shape = smoothstep(0.20, 0.75, density + fila * 0.25);
    let rim = 1.0 - abs(d - 0.6) * 2.5;
    shape *= (0.4 + max(0.0, rim) * 0.8);

  } else if in.ntype < 3.5 {
    // Reflection: smoother, more uniform blue cloud
    shape = smoothstep(0.25, 0.80, density);
    col   = mix(col, vec3<f32>(0.65, 0.82, 1.0), 0.3);

  } else {
    // Mixed (emission + reflection): layered clouds
    let cloud2 = (fbm(p * 1.5 + vec2<f32>(3.2, 0.9), 4) + 1.0) * 0.5;
    shape = smoothstep(0.20, 0.78, density * 0.6 + cloud2 * 0.5);
  }

  if shape < 0.02 { discard; }

  let a = clamp(shape * in.alpha * 1.2, 0.0, 1.0);
  let objectBrightness = max(camera.eyeAndFlags.w, 0.0);
  return vec4<f32>(col * a * objectBrightness, a);
}

// Procedural Milky Way dust cloud renderer.
//
// Each instance is a low-poly faceted ellipsoid. The mesh is generated in the
// vertex shader from an icosahedron and a stable shape id, so many clouds can
// share the same draw call without texture lookups or blur-like impostors.

struct Camera {
  viewProj:    mat4x4<f32>,
  rightAndMNR: vec4<f32>,
  upAndFocal:  vec4<f32>,
  eyeAndFlags: vec4<f32>,
};

struct DustCloud {
  center_radius: vec4<f32>,
  color_alpha:   vec4<f32>,
  axis_x:        vec4<f32>,
  axis_y:        vec4<f32>,
  axis_z:        vec4<f32>,
  shape:         vec4<f32>,
};

@group(0) @binding(0) var<uniform>       camera: Camera;
@group(0) @binding(1) var<storage, read> dust:   array<DustCloud>;

struct VertexOut {
  @builtin(position) clip_pos: vec4<f32>,
  @location(0)       color:    vec3<f32>,
  @location(1)       alpha:    f32,
  @location(2)       shade:    f32,
};

const X: f32 = 0.5257311121;
const Z: f32 = 0.8506508084;

var<private> icoVerts: array<vec3<f32>, 12> = array<vec3<f32>, 12>(
  vec3<f32>(-X, 0.0,  Z), vec3<f32>( X, 0.0,  Z),
  vec3<f32>(-X, 0.0, -Z), vec3<f32>( X, 0.0, -Z),
  vec3<f32>(0.0,  Z,  X), vec3<f32>(0.0,  Z, -X),
  vec3<f32>(0.0, -Z,  X), vec3<f32>(0.0, -Z, -X),
  vec3<f32>( Z,  X, 0.0), vec3<f32>(-Z,  X, 0.0),
  vec3<f32>( Z, -X, 0.0), vec3<f32>(-Z, -X, 0.0),
);

var<private> icoFaces: array<u32, 60> = array<u32, 60>(
   0u,  4u,  1u,   0u,  9u,  4u,   9u,  5u,  4u,   4u,  5u,  8u,
   4u,  8u,  1u,   8u, 10u,  1u,   8u,  3u, 10u,   5u,  3u,  8u,
   5u,  2u,  3u,   2u,  7u,  3u,   7u, 10u,  3u,   7u,  6u, 10u,
   7u, 11u,  6u,  11u,  0u,  6u,   0u,  1u,  6u,   6u,  1u, 10u,
   9u,  0u, 11u,   9u, 11u,  2u,   9u,  2u,  5u,   7u,  2u, 11u,
);

fn hash11(n: f32) -> f32 {
  return fract(sin(n) * 43758.5453123);
}

fn shapeLobe(shapeId: f32, vertexId: u32, roughness: f32, dir: vec3<f32>) -> f32 {
  let v = f32(vertexId);
  let a = hash11(shapeId * 17.17 + v * 23.31);
  let b = hash11(shapeId * 31.71 + dot(dir, vec3<f32>(91.7, 37.3, 13.1)));
  let c = hash11(shapeId * 7.93 + dir.x * 53.0 + dir.y * 97.0 + dir.z * 29.0);
  return max(0.42, 1.0 + ((a - 0.5) * 0.95 + (b - 0.5) * 0.45 + (c - 0.5) * 0.30) * roughness);
}

fn hiddenVertex() -> VertexOut {
  var out: VertexOut;
  out.clip_pos = vec4<f32>(10.0, 10.0, 10.0, 1.0);
  out.color = vec3<f32>(0.0);
  out.alpha = 0.0;
  out.shade = 0.0;
  return out;
}

@vertex
fn vs_main(
  @builtin(vertex_index)   vi:  u32,
  @builtin(instance_index) idx: u32,
) -> VertexOut {
  let cloud = dust[idx];
  let center = cloud.center_radius.xyz;
  let radius = cloud.center_radius.w;
  let alpha = cloud.color_alpha.w;

  if radius <= 0.0 || alpha <= 0.0001 {
    return hiddenVertex();
  }

  let clip_c = camera.viewProj * vec4<f32>(center, 1.0);
  let boundRadius = radius * cloud.shape.z * 1.65;

  if clip_c.w <= 0.0 {
    return hiddenVertex();
  }

  let ndcX = clip_c.x / clip_c.w;
  let ndcY = clip_c.y / clip_c.w;
  let ndcRadius = boundRadius * camera.upAndFocal.w / clip_c.w;
  if ndcRadius < 0.00035 ||
     ndcX - ndcRadius > 1.20 || ndcX + ndcRadius < -1.20 ||
     ndcY - ndcRadius > 1.20 || ndcY + ndcRadius < -1.20 {
    return hiddenVertex();
  }

  let faceVertex = icoFaces[vi % 60u];
  let dir = icoVerts[faceVertex];
  let lobe = shapeLobe(cloud.shape.x, faceVertex, cloud.shape.y, dir);
  let local = dir * lobe;

  let worldOffset =
      cloud.axis_x.xyz * (local.x * radius * cloud.axis_x.w)
    + cloud.axis_y.xyz * (local.y * radius * cloud.axis_y.w)
    + cloud.axis_z.xyz * (local.z * radius * cloud.axis_z.w);
  let worldPos = center + worldOffset;

  let normal = normalize(worldOffset);
  let lightDir = normalize(vec3<f32>(-0.33, 0.44, 0.83));
  let viewDir = normalize(camera.eyeAndFlags.xyz - worldPos);
  let light = max(0.0, dot(normal, lightDir));
  let rim = 1.0 - abs(dot(normal, viewDir));
  let shapeDark = hash11(cloud.shape.x * 19.19 + f32(faceVertex) * 5.13);

  var out: VertexOut;
  out.clip_pos = camera.viewProj * vec4<f32>(worldPos, 1.0);
  out.color = cloud.color_alpha.xyz;
  out.alpha = min(0.10, alpha);
  out.shade = clamp(0.58 + light * 0.25 + rim * 0.10 - shapeDark * 0.10, 0.42, 0.96);
  return out;
}

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  if in.alpha <= 0.0001 {
    discard;
  }

  let color = clamp(in.color * in.shade, vec3<f32>(0.0), vec3<f32>(0.58));
  return vec4<f32>(color, in.alpha);
}

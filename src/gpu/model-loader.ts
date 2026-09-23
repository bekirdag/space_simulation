import { Matrix3, Vector3, type Material, type Mesh, type Object3D, type Texture } from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { USDZLoader } from "three/examples/jsm/loaders/USDZLoader.js";

export const MILKY_WAY_MODEL_VERTEX_FLOATS = 12;
export type ParsedModelFormat = "glb" | "stl" | "usdz";

export interface ParsedMilkyWayTexture {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

export interface ParsedMilkyWayMaterial {
  baseColor: [number, number, number, number];
  emissive: [number, number, number, number];
  textureIndex: number;
  useTexture: number;
  useProcedural: number;
  useVertexColor: number;
  textureEmission: number;
}

export interface ParsedMilkyWayMeshPart {
  vertices: Float32Array;
  vertexCount: number;
  /** Triangle-list indices into `vertices`; null for non-indexed parts. */
  indices: Uint32Array | null;
  /** Number of indices to draw (0 when `indices` is null). */
  indexCount: number;
  material: ParsedMilkyWayMaterial;
}

export interface ModelParseOptions {
  /**
   * How the unit-radius normalization is derived:
   * - "all": bounding box of every kept part (default; nebula/remnant meshes).
   * - "largest-part": bounding box of the part with the most triangles, so a
   *   planet globe fills radius 1 and rings/atmospheres extend beyond it.
   */
  normalizeTo?: "all" | "largest-part";
  /** Triangle budget; meshes above it are simplified with meshoptimizer. */
  maxTriangles?: number;
}

export interface ParsedMilkyWayMesh {
  parts: ParsedMilkyWayMeshPart[];
  textures: ParsedMilkyWayTexture[];
  vertexCount: number;
  sourceTriangleCount: number;
  usedTriangleCount: number;
}

interface PrimitiveData {
  positions: Float32Array;
  normals: Float32Array | null;
  uvs: Float32Array | null;
  colors: Float32Array | null;
  indices: Uint32Array | null;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
  material: Material | null;
}

interface TextureCache {
  textureIndexByImage: Map<object, number>;
  textures: ParsedMilkyWayTexture[];
}

type ThreeColorLike = { r: number; g: number; b: number };
type ThreeMaterialLike = Material & {
  color?: ThreeColorLike;
  emissive?: ThreeColorLike;
  emissiveIntensity?: number;
  map?: Texture | null;
  emissiveMap?: Texture | null;
  opacity?: number;
  transparent?: boolean;
  vertexColors?: boolean;
};

// Meshes above this budget are welded and simplified with meshoptimizer
// (quadric edge collapse) instead of dropping every Nth triangle, which left
// holes and a speckled look on the Chandra supernova-remnant meshes.
const MAX_TRIANGLES = 400_000;
const STL_MAX_TRIANGLES = 160_000;
const UV_SPHERE_MIN_LAT_BANDS = 8;
const UV_SPHERE_MIN_LON_BANDS = 16;
const UV_SPHERE_MAX_LAT_BANDS = 64;
const UV_SPHERE_MAX_LON_BANDS = 128;
const UV_SPHERE_FALLBACK_LAT_BANDS = 12;
const UV_SPHERE_FALLBACK_LON_BANDS = 24;
let gltfLoader: GLTFLoader | null = null;

function getGltfLoader(): GLTFLoader {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader();
  draco.setDecoderPath("/draco/");
  draco.setDecoderConfig({ type: "wasm" });
  gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(draco);
  return gltfLoader;
}

function defaultMaterial(useProcedural = 0): ParsedMilkyWayMaterial {
  return {
    baseColor: [1, 1, 1, 1],
    emissive: [0, 0, 0, 0],
    textureIndex: -1,
    useTexture: 0,
    useProcedural,
    useVertexColor: 0,
    textureEmission: 0,
  };
}

function clampBandCount(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function colorToTuple(color: ThreeColorLike | undefined, fallback: [number, number, number]): [number, number, number] {
  if (!color) return fallback;
  return [clamp01(color.r), clamp01(color.g), clamp01(color.b)];
}

function materialOpacity(material: ThreeMaterialLike | null): number {
  if (!material) return 1;
  const opacity = Number.isFinite(material.opacity) ? Number(material.opacity) : 1;
  return clamp01(opacity);
}

function imageDimensions(value: unknown): { width: number; height: number } | null {
  const image = value as { width?: unknown; height?: unknown };
  const width = typeof image.width === "number" ? image.width : 0;
  const height = typeof image.height === "number" ? image.height : 0;
  return width > 0 && height > 0 ? { width, height } : null;
}

function dataTextureBitmap(value: unknown): Promise<ImageBitmap | null> | null {
  const image = value as { data?: unknown; width?: unknown; height?: unknown };
  const width = typeof image.width === "number" ? image.width : 0;
  const height = typeof image.height === "number" ? image.height : 0;
  if (width <= 0 || height <= 0 || !image.data) return null;

  const source = image.data;
  let bytes: Uint8ClampedArray<ArrayBuffer> | null = null;
  if (ArrayBuffer.isView(source)) {
    const view = source as ArrayBufferView;
    bytes = new Uint8ClampedArray(view.byteLength);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  } else if (Array.isArray(source)) {
    bytes = new Uint8ClampedArray(source);
  }
  if (!bytes || bytes.length < width * height * 4) return null;
  const pixels: Uint8ClampedArray<ArrayBuffer> = bytes.length === width * height * 4
    ? bytes
    : new Uint8ClampedArray(bytes.slice(0, width * height * 4));
  return createImageBitmap(new ImageData(pixels, width, height));
}

async function imageToBitmap(value: unknown): Promise<ImageBitmap | null> {
  if (!value || typeof createImageBitmap !== "function") return null;
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) return createImageBitmap(value);
  if (typeof HTMLImageElement !== "undefined" && value instanceof HTMLImageElement) {
    if (!value.complete && typeof value.decode === "function") {
      await value.decode().catch(() => undefined);
    }
    return createImageBitmap(value);
  }
  if (typeof HTMLCanvasElement !== "undefined" && value instanceof HTMLCanvasElement) {
    return createImageBitmap(value);
  }
  if (typeof OffscreenCanvas !== "undefined" && value instanceof OffscreenCanvas) {
    return createImageBitmap(value);
  }
  if (typeof ImageData !== "undefined" && value instanceof ImageData) {
    return createImageBitmap(value);
  }
  const dataBitmap = dataTextureBitmap(value);
  if (dataBitmap) return dataBitmap;
  return null;
}

async function textureIndexFor(texture: Texture | null | undefined, cache: TextureCache): Promise<number> {
  const image = texture?.image as unknown;
  if (!image || typeof image !== "object") return -1;
  const cached = cache.textureIndexByImage.get(image);
  if (cached !== undefined) return cached;

  const bitmap = await imageToBitmap(image);
  if (!bitmap) return -1;
  const dims = imageDimensions(bitmap);
  if (!dims) return -1;
  const index = cache.textures.length;
  cache.textureIndexByImage.set(image, index);
  cache.textures.push({ bitmap, width: dims.width, height: dims.height });
  return index;
}

async function parseMaterial(
  material: Material | null,
  hasUvs: boolean,
  hasVertexColors: boolean,
  cache: TextureCache,
): Promise<ParsedMilkyWayMaterial> {
  if (!material) return defaultMaterial();
  const mat = material as ThreeMaterialLike;
  const [r, g, b] = colorToTuple(mat.color, [1, 1, 1]);
  const [er, eg, eb] = colorToTuple(mat.emissive, [0, 0, 0]);
  const emissiveIntensity = Math.max(0, Number.isFinite(mat.emissiveIntensity) ? Number(mat.emissiveIntensity) : 1);
  const textureIndex = hasUvs ? await textureIndexFor(mat.map, cache) : -1;
  const emissiveStrength = Math.max(er, eg, eb) * emissiveIntensity;
  // glTF emissiveFactor multiplies emissiveTexture. Without an emissive map a
  // uniform emissive colour on a textured surface just washes it out (the
  // Matteo Pascale Earth has emissiveFactor [1,1,1] and no emissive map), so
  // plain emissive colour is only honoured on untextured materials. An
  // emissive map that is the base-colour image is expressed as texture
  // emission; other emissive maps are not supported and are ignored.
  const emissiveMapImage = mat.emissiveMap?.image as unknown;
  const baseMapImage = mat.map?.image as unknown;
  const emissiveFromBaseMap = textureIndex >= 0 && !!emissiveMapImage && emissiveMapImage === baseMapImage;
  const plainEmissive = textureIndex < 0 && !emissiveMapImage;
  return {
    baseColor: [r, g, b, materialOpacity(mat)],
    emissive: plainEmissive ? [er, eg, eb, emissiveIntensity] : [0, 0, 0, 0],
    textureIndex,
    useTexture: textureIndex >= 0 ? 1 : 0,
    useProcedural: 0,
    useVertexColor: hasVertexColors || mat.vertexColors ? 1 : 0,
    textureEmission: emissiveFromBaseMap ? emissiveStrength : 0,
  };
}

function materialIsEmissive(material: ParsedMilkyWayMaterial): boolean {
  const [er, eg, eb, ei] = material.emissive;
  return Math.max(er, eg, eb) * ei > 1e-3 || material.textureEmission > 1e-3;
}

/** Open-addressing hash that welds vertices whose selected float attributes are bit-identical. */
class VertexWelder {
  private table: Int32Array;
  private mask: number;
  private keys: Uint32Array;
  private readonly keyFloats: number;
  count = 0;

  constructor(capacity: number, keyFloats: number) {
    let size = 1024;
    while (size < capacity * 2) size *= 2;
    this.table = new Int32Array(size).fill(-1);
    this.mask = size - 1;
    this.keyFloats = keyFloats;
    this.keys = new Uint32Array(Math.max(1, capacity) * keyFloats);
  }

  /** Returns the welded index for `key` (bit patterns of `keyFloats` floats). */
  insert(key: Uint32Array): number {
    const n = this.keyFloats;
    let h = 2166136261;
    for (let i = 0; i < n; i++) {
      h = Math.imul(h ^ key[i]!, 16777619);
      h ^= h >>> 15;
    }
    let slot = h & this.mask;
    for (;;) {
      const existing = this.table[slot]!;
      if (existing < 0) {
        const index = this.count++;
        this.keys.set(key.subarray(0, n), index * n);
        this.table[slot] = index;
        return index;
      }
      let same = true;
      const o = existing * n;
      for (let i = 0; i < n; i++) {
        if (this.keys[o + i] !== key[i]) { same = false; break; }
      }
      if (same) return existing;
      slot = (slot + 1) & this.mask;
    }
  }
}

interface IndexedPrimitive {
  /** Source vertex index for every output vertex. */
  sourceVertex: Uint32Array;
  indices: Uint32Array;
  /** Smooth normals (xyz per output vertex) when the source normals are not used. */
  normals: Float32Array | null;
}

function primitiveCorner(prim: PrimitiveData, i: number): number {
  return prim.indices ? prim.indices[i]! : i;
}

/**
 * Converts a primitive to a compact indexed triangle list.
 * - Without simplification and with source normals the source index topology
 *   is kept as-is (only referenced vertices are copied).
 * - Otherwise vertices are welded on position (+uv), optionally simplified with
 *   meshoptimizer, and smooth area-weighted normals are recomputed.
 */
async function indexPrimitive(prim: PrimitiveData, targetTriangles: number): Promise<IndexedPrimitive | null> {
  const start = prim.indexStart;
  const cornerCount = Math.floor(prim.indexCount / 3) * 3;
  if (cornerCount < 3) return null;
  const triangles = cornerCount / 3;
  const simplify = targetTriangles < triangles;

  if (!simplify && prim.normals) {
    const remap = new Int32Array(prim.vertexCount).fill(-1);
    const sourceVertex: number[] = [];
    const indices = new Uint32Array(cornerCount);
    for (let i = 0; i < cornerCount; i++) {
      const src = primitiveCorner(prim, start + i);
      let dst = remap[src]!;
      if (dst < 0) {
        dst = sourceVertex.length;
        remap[src] = dst;
        sourceVertex.push(src);
      }
      indices[i] = dst;
    }
    return { sourceVertex: Uint32Array.from(sourceVertex), indices, normals: null };
  }

  // Weld on position (+uv so texture seams survive).
  const keyFloats = prim.uvs ? 5 : 3;
  const welder = new VertexWelder(Math.min(prim.vertexCount, cornerCount), keyFloats);
  const keyF = new Float32Array(keyFloats);
  const keyU = new Uint32Array(keyF.buffer);
  const weldOfSource = new Int32Array(prim.vertexCount).fill(-1);
  const sourceOfWeld: number[] = [];
  let indices: Uint32Array = new Uint32Array(cornerCount);
  let kept = 0;
  const tri = [0, 0, 0];
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const src = primitiveCorner(prim, start + t * 3 + k);
      let w = weldOfSource[src]!;
      if (w < 0) {
        keyF[0] = prim.positions[src * 3]!;
        keyF[1] = prim.positions[src * 3 + 1]!;
        keyF[2] = prim.positions[src * 3 + 2]!;
        if (prim.uvs) {
          keyF[3] = prim.uvs[src * 2]!;
          keyF[4] = prim.uvs[src * 2 + 1]!;
        }
        w = welder.insert(keyU);
        if (w === sourceOfWeld.length) sourceOfWeld.push(src);
        weldOfSource[src] = w;
      }
      tri[k] = w;
    }
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    indices[kept++] = tri[0]!;
    indices[kept++] = tri[1]!;
    indices[kept++] = tri[2]!;
  }
  if (kept < 3) return null;
  indices = indices.slice(0, kept);
  let sourceVertex: Uint32Array = Uint32Array.from(sourceOfWeld);

  if (simplify) {
    const positions = new Float32Array(sourceVertex.length * 3);
    for (let v = 0; v < sourceVertex.length; v++) {
      const src = sourceVertex[v]!;
      positions[v * 3] = prim.positions[src * 3]!;
      positions[v * 3 + 1] = prim.positions[src * 3 + 1]!;
      positions[v * 3 + 2] = prim.positions[src * 3 + 2]!;
    }
    const { MeshoptSimplifier } = await import("meshoptimizer");
    await MeshoptSimplifier.ready;
    const targetIndexCount = Math.max(3, Math.floor(targetTriangles) * 3);
    const [simplified] = MeshoptSimplifier.simplify(indices, positions, 3, targetIndexCount, 0.02);
    if (simplified.length >= 3) {
      // compactMesh rewrites the indices in place and returns old->new vertex remap.
      const [remap, unique] = MeshoptSimplifier.compactMesh(simplified);
      const compactSource = new Uint32Array(unique);
      for (let v = 0; v < remap.length; v++) {
        const dst = remap[v]!;
        if (dst < unique) compactSource[dst] = sourceVertex[v]!;
      }
      indices = simplified;
      sourceVertex = compactSource;
    }
  }

  // Smooth area-weighted normals on the welded topology.
  const normals = new Float32Array(sourceVertex.length * 3);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
    const sa = sourceVertex[a]! * 3, sb = sourceVertex[b]! * 3, sc = sourceVertex[c]! * 3;
    const ux = prim.positions[sb]! - prim.positions[sa]!;
    const uy = prim.positions[sb + 1]! - prim.positions[sa + 1]!;
    const uz = prim.positions[sb + 2]! - prim.positions[sa + 2]!;
    const vx = prim.positions[sc]! - prim.positions[sa]!;
    const vy = prim.positions[sc + 1]! - prim.positions[sa + 1]!;
    const vz = prim.positions[sc + 2]! - prim.positions[sa + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      normals[v * 3] = normals[v * 3]! + nx;
      normals[v * 3 + 1] = normals[v * 3 + 1]! + ny;
      normals[v * 3 + 2] = normals[v * 3 + 2]! + nz;
    }
  }
  for (let v = 0; v < sourceVertex.length; v++) {
    const len = Math.hypot(normals[v * 3]!, normals[v * 3 + 1]!, normals[v * 3 + 2]!);
    if (len > 0) {
      normals[v * 3] = normals[v * 3]! / len;
      normals[v * 3 + 1] = normals[v * 3 + 1]! / len;
      normals[v * 3 + 2] = normals[v * 3 + 2]! / len;
    } else {
      normals[v * 3 + 1] = 1;
    }
  }
  return { sourceVertex, indices, normals };
}

function primitiveBounds(prims: readonly PrimitiveData[]): { cx: number; cy: number; cz: number; radius: number } | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const prim of prims) {
    const end = prim.indexStart + prim.indexCount;
    for (let i = prim.indexStart; i < end; i++) {
      const v = primitiveCorner(prim, i) * 3;
      const x = prim.positions[v]!;
      const y = prim.positions[v + 1]!;
      const z = prim.positions[v + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return {
    cx: (minX + maxX) * 0.5,
    cy: (minY + maxY) * 0.5,
    cz: (minZ + maxZ) * 0.5,
    radius: Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 || 1,
  };
}

async function normalizeAndPack(prims: PrimitiveData[], options: ModelParseOptions = {}): Promise<ParsedMilkyWayMesh> {
  const cache: TextureCache = { textureIndexByImage: new Map(), textures: [] };
  let sourceTriangles = 0;
  const withMaterials: Array<{ prim: PrimitiveData; material: ParsedMilkyWayMaterial }> = [];
  for (const prim of prims) {
    sourceTriangles += Math.floor(prim.indexCount / 3);
    const material = await parseMaterial(prim.material, prim.uvs !== null, prim.colors !== null, cache);
    withMaterials.push({ prim, material });
  }
  if (sourceTriangles <= 0) throw new Error("Model has no triangles.");

  // When a model has a textured surface, untextured parts without vertex colour
  // or emission are empty material shells (e.g. the Matteo Pascale Earth's two
  // outer spheres) that would render as opaque white over the real surface.
  const hasTexturedPart = withMaterials.some(entry => entry.material.useTexture > 0.5);
  const kept = hasTexturedPart
    ? withMaterials.filter(({ material }) =>
      material.useTexture > 0.5 || material.useVertexColor > 0.5 || materialIsEmissive(material))
    : withMaterials;
  if (kept.length <= 0) throw new Error("Model has no drawable parts.");

  let boundsPrims = kept.map(entry => entry.prim);
  if (options.normalizeTo === "largest-part") {
    const largest = boundsPrims.reduce((best, prim) => (prim.indexCount > best.indexCount ? prim : best));
    boundsPrims = [largest];
  }
  const bounds = primitiveBounds(boundsPrims);
  if (!bounds) throw new Error("Model has no triangles.");
  const { cx, cy, cz, radius } = bounds;

  const keptTriangles = kept.reduce((sum, entry) => sum + Math.floor(entry.prim.indexCount / 3), 0);
  const budget = Math.max(1, options.maxTriangles ?? MAX_TRIANGLES);
  const ratio = keptTriangles > budget ? budget / keptTriangles : 1;
  const parts: ParsedMilkyWayMeshPart[] = [];
  let usedTriangles = 0;
  let vertexCount = 0;

  for (const { prim, material } of kept) {
    const triangles = Math.floor(prim.indexCount / 3);
    const indexed = await indexPrimitive(prim, ratio < 1 ? Math.max(1, Math.floor(triangles * ratio)) : triangles);
    if (!indexed) continue;
    const { sourceVertex, indices, normals } = indexed;
    const count = sourceVertex.length;
    const vertices = new Float32Array(count * MILKY_WAY_MODEL_VERTEX_FLOATS);
    for (let v = 0; v < count; v++) {
      const src = sourceVertex[v]!;
      const o = v * MILKY_WAY_MODEL_VERTEX_FLOATS;
      vertices[o] = (prim.positions[src * 3]! - cx) / radius;
      vertices[o + 1] = (prim.positions[src * 3 + 1]! - cy) / radius;
      vertices[o + 2] = (prim.positions[src * 3 + 2]! - cz) / radius;
      const normalSource = normals ?? prim.normals;
      const ni = normals ? v * 3 : src * 3;
      vertices[o + 3] = normalSource ? normalSource[ni]! : 0;
      vertices[o + 4] = normalSource ? normalSource[ni + 1]! : 1;
      vertices[o + 5] = normalSource ? normalSource[ni + 2]! : 0;
      vertices[o + 6] = prim.uvs ? prim.uvs[src * 2]! : 0;
      vertices[o + 7] = prim.uvs ? prim.uvs[src * 2 + 1]! : 0;
      vertices[o + 8] = prim.colors ? prim.colors[src * 4]! : 1;
      vertices[o + 9] = prim.colors ? prim.colors[src * 4 + 1]! : 1;
      vertices[o + 10] = prim.colors ? prim.colors[src * 4 + 2]! : 1;
      vertices[o + 11] = prim.colors ? prim.colors[src * 4 + 3]! : 1;
    }
    parts.push({ vertices, vertexCount: count, indices, indexCount: indices.length, material });
    usedTriangles += indices.length / 3;
    vertexCount += count;
  }

  if (parts.length <= 0) throw new Error("Model has no drawable triangles.");
  return {
    parts,
    textures: cache.textures,
    vertexCount,
    sourceTriangleCount: sourceTriangles,
    usedTriangleCount: usedTriangles,
  };
}

function materialAt(mesh: Mesh, index: number): Material | null {
  const material = mesh.material;
  if (Array.isArray(material)) return material[index] ?? material[0] ?? null;
  return material ?? null;
}

function collectMeshPrimitives(root: Object3D): PrimitiveData[] {
  const prims: PrimitiveData[] = [];
  const tmp = new Vector3();
  const normalTmp = new Vector3();
  const normalMatrix = new Matrix3();

  root.updateMatrixWorld(true);
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry;
    const pos = geometry.getAttribute("position");
    if (!pos || pos.itemSize < 3 || pos.count <= 0) return;
    const normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv");
    const color = geometry.getAttribute("color");
    const positions = new Float32Array(pos.count * 3);
    const normals = normal && normal.itemSize >= 3 ? new Float32Array(pos.count * 3) : null;
    const uvs = uv && uv.itemSize >= 2 ? new Float32Array(pos.count * 2) : null;
    const colors = color && color.itemSize >= 3 ? new Float32Array(pos.count * 4) : null;

    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < pos.count; i++) {
      tmp.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(mesh.matrixWorld);
      positions[i * 3 + 0] = tmp.x;
      positions[i * 3 + 1] = tmp.y;
      positions[i * 3 + 2] = tmp.z;
      if (normals && normal) {
        normalTmp.set(normal.getX(i), normal.getY(i), normal.getZ(i)).applyMatrix3(normalMatrix).normalize();
        normals[i * 3 + 0] = normalTmp.x;
        normals[i * 3 + 1] = normalTmp.y;
        normals[i * 3 + 2] = normalTmp.z;
      }
      if (uvs && uv) {
        uvs[i * 2 + 0] = uv.getX(i);
        uvs[i * 2 + 1] = uv.getY(i);
      }
      if (colors && color) {
        colors[i * 4 + 0] = color.getX(i);
        colors[i * 4 + 1] = color.getY(i);
        colors[i * 4 + 2] = color.getZ(i);
        colors[i * 4 + 3] = color.itemSize >= 4 ? color.getW(i) : 1;
      }
    }

    const index = geometry.getIndex();
    let indices: Uint32Array | null = null;
    const indexCount = index?.count ?? pos.count;
    if (index) {
      indices = new Uint32Array(index.count);
      for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
    }

    if (geometry.groups.length > 0) {
      for (const group of geometry.groups) {
        const start = Math.max(0, group.start);
        const count = Math.max(0, Math.min(group.count, indexCount - start));
        if (count < 3) continue;
        prims.push({
          positions,
          normals,
          uvs,
          colors,
          indices,
          vertexCount: pos.count,
          indexStart: start,
          indexCount: count,
          material: materialAt(mesh, group.materialIndex ?? 0),
        });
      }
    } else {
      prims.push({
        positions,
        normals,
        uvs,
        colors,
        indices,
        vertexCount: pos.count,
        indexStart: 0,
        indexCount,
        material: materialAt(mesh, 0),
      });
    }
  });

  return prims;
}

export async function parseGlbMesh(buffer: ArrayBuffer, options: ModelParseOptions = {}): Promise<ParsedMilkyWayMesh> {
  const loader = getGltfLoader();
  const gltf = await loader.parseAsync(buffer.slice(0), "");
  return normalizeAndPack(collectMeshPrimitives(gltf.scene), options);
}

export async function parseUsdzMesh(buffer: ArrayBuffer, options: ModelParseOptions = {}): Promise<ParsedMilkyWayMesh> {
  const loader = new USDZLoader();
  const scene = loader.parse(buffer.slice(0));
  return normalizeAndPack(collectMeshPrimitives(scene), options);
}

function looksLikeBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  return 84 + triCount * 50 === buffer.byteLength;
}

function longestAxis(sizeX: number, sizeY: number, sizeZ: number): 0 | 1 | 2 {
  if (sizeX >= sizeY && sizeX >= sizeZ) return 0;
  if (sizeY >= sizeX && sizeY >= sizeZ) return 1;
  return 2;
}

function cylindricalStlUv(
  x: number,
  y: number,
  z: number,
  cx: number,
  cy: number,
  cz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  axis: 0 | 1 | 2,
): [number, number] {
  let radialA = x - cx;
  let radialB = y - cy;
  let axisValue = z;
  let axisMin = minZ;
  let axisMax = maxZ;

  if (axis === 0) {
    radialA = y - cy;
    radialB = z - cz;
    axisValue = x;
    axisMin = minX;
    axisMax = maxX;
  } else if (axis === 1) {
    radialA = x - cx;
    radialB = z - cz;
    axisValue = y;
    axisMin = minY;
    axisMax = maxY;
  }

  const u = (Math.atan2(radialB, radialA) / (Math.PI * 2) + 1.5) % 1;
  const v = 1 - clamp01((axisValue - axisMin) / Math.max(1e-6, axisMax - axisMin));
  return [u, v];
}

export function parseStlMesh(buffer: ArrayBuffer): ParsedMilkyWayMesh {
  if (!looksLikeBinaryStl(buffer)) throw new Error("Only binary STL models are supported.");
  const dv = new DataView(buffer);
  const sourceTriangles = dv.getUint32(80, true);
  const triStep = Math.max(1, Math.ceil(sourceTriangles / STL_MAX_TRIANGLES));
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let t = 0; t < sourceTriangles; t++) {
    const base = 84 + t * 50 + 12;
    for (let v = 0; v < 3; v++) {
      const p = base + v * 12;
      const x = dv.getFloat32(p + 0, true);
      const y = dv.getFloat32(p + 4, true);
      const z = dv.getFloat32(p + 8, true);
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
  }

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const radius = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 || 1;
  const uvAxis = longestAxis(maxX - minX, maxY - minY, maxZ - minZ);
  const packed: number[] = [];
  let usedTriangles = 0;

  for (let t = 0; t < sourceTriangles; t++) {
    if (t % triStep !== 0) continue;
    const base = 84 + t * 50;
    let nx = dv.getFloat32(base + 0, true);
    let ny = dv.getFloat32(base + 4, true);
    let nz = dv.getFloat32(base + 8, true);
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;
    for (let v = 0; v < 3; v++) {
      const p = base + 12 + v * 12;
      const x = dv.getFloat32(p + 0, true);
      const y = dv.getFloat32(p + 4, true);
      const z = dv.getFloat32(p + 8, true);
      const [u, uv] = cylindricalStlUv(
        x, y, z,
        cx, cy, cz,
        minX, minY, minZ,
        maxX, maxY, maxZ,
        uvAxis,
      );
      packed.push(
        (x - cx) / radius,
        (y - cy) / radius,
        (z - cz) / radius,
        nx, ny, nz,
        u, uv,
        1, 1, 1, 1,
      );
    }
    usedTriangles++;
  }

  const vertices = new Float32Array(packed);
  const vertexCount = vertices.length / MILKY_WAY_MODEL_VERTEX_FLOATS;
  return {
    parts: [{
      vertices,
      vertexCount,
      indices: null,
      indexCount: 0,
      material: defaultMaterial(1),
    }],
    textures: [],
    vertexCount,
    sourceTriangleCount: sourceTriangles,
    usedTriangleCount: usedTriangles,
  };
}

export function createUvSphereMesh(latitudeBands = 24, longitudeBands = 48): ParsedMilkyWayMesh {
  const latBands = clampBandCount(
    latitudeBands,
    24,
    UV_SPHERE_MIN_LAT_BANDS,
    UV_SPHERE_MAX_LAT_BANDS,
  );
  const lonBands = clampBandCount(
    longitudeBands,
    48,
    UV_SPHERE_MIN_LON_BANDS,
    UV_SPHERE_MAX_LON_BANDS,
  );

  const buildVertices = (latCount: number, lonCount: number): Float32Array => {
    const vertexCount = latCount * lonCount * 6;
    const vertices = new Float32Array(vertexCount * MILKY_WAY_MODEL_VERTEX_FLOATS);
    let offset = 0;

    const pushVertex = (lat: number, lon: number): void => {
      const v = lat / latCount;
      const u = lon / lonCount;
      const theta = v * Math.PI;
      const phi = (1 - u) * Math.PI * 2;
      const sinTheta = Math.sin(theta);
      const x = Math.cos(phi) * sinTheta;
      const y = Math.cos(theta);
      const z = Math.sin(phi) * sinTheta;
      vertices[offset++] = x;
      vertices[offset++] = y;
      vertices[offset++] = z;
      vertices[offset++] = x;
      vertices[offset++] = y;
      vertices[offset++] = z;
      vertices[offset++] = u;
      vertices[offset++] = v;
      vertices[offset++] = 1;
      vertices[offset++] = 1;
      vertices[offset++] = 1;
      vertices[offset++] = 1;
    };

    for (let lat = 0; lat < latCount; lat++) {
      for (let lon = 0; lon < lonCount; lon++) {
        const nextLat = lat + 1;
        const nextLon = lon + 1;
        pushVertex(lat, lon);
        pushVertex(nextLat, lon);
        pushVertex(lat, nextLon);
        pushVertex(lat, nextLon);
        pushVertex(nextLat, lon);
        pushVertex(nextLat, nextLon);
      }
    }

    return vertices;
  };

  let vertices: Float32Array;
  try {
    vertices = buildVertices(latBands, lonBands);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    try {
      vertices = buildVertices(UV_SPHERE_FALLBACK_LAT_BANDS, UV_SPHERE_FALLBACK_LON_BANDS);
    } catch (fallbackError) {
      if (!(fallbackError instanceof RangeError)) throw fallbackError;
      vertices = new Float32Array([
        0, 1, 0, 0, 1, 0, 0.5, 0, 1, 1, 1, 1,
        -1, -1, 0, -1, -1, 0, 0, 1, 1, 1, 1, 1,
        1, -1, 0, 1, -1, 0, 1, 1, 1, 1, 1, 1,
      ]);
    }
  }
  const vertexCount = vertices.length / MILKY_WAY_MODEL_VERTEX_FLOATS;
  const triangleCount = vertexCount / 3;
  return {
    parts: [{
      vertices,
      vertexCount,
      indices: null,
      indexCount: 0,
      material: defaultMaterial(0),
    }],
    textures: [],
    vertexCount,
    sourceTriangleCount: triangleCount,
    usedTriangleCount: triangleCount,
  };
}

export async function parseMilkyWayModel(
  buffer: ArrayBuffer,
  format: ParsedModelFormat,
  options: ModelParseOptions = {},
): Promise<ParsedMilkyWayMesh> {
  if (format === "glb") return parseGlbMesh(buffer, options);
  if (format === "usdz") return parseUsdzMesh(buffer, options);
  return parseStlMesh(buffer);
}

import { Matrix3, Vector3, type Material, type Mesh, type Texture } from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export const MILKY_WAY_MODEL_VERTEX_FLOATS = 12;

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
  material: ParsedMilkyWayMaterial;
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
  opacity?: number;
  transparent?: boolean;
  vertexColors?: boolean;
};

const MAX_TRIANGLES = 160_000;
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
  return {
    baseColor: [r, g, b, materialOpacity(mat)],
    emissive: [er, eg, eb, emissiveIntensity],
    textureIndex,
    useTexture: textureIndex >= 0 ? 1 : 0,
    useProcedural: 0,
    useVertexColor: hasVertexColors || mat.vertexColors ? 1 : 0,
    textureEmission: 0,
  };
}

async function normalizeAndPack(prims: PrimitiveData[]): Promise<ParsedMilkyWayMesh> {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let sourceTriangles = 0;

  for (const prim of prims) {
    for (let i = 0; i < prim.positions.length; i += 3) {
      const x = prim.positions[i]!;
      const y = prim.positions[i + 1]!;
      const z = prim.positions[i + 2]!;
      minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
    }
    sourceTriangles += Math.floor(prim.indexCount / 3);
  }

  if (!Number.isFinite(minX) || sourceTriangles <= 0) throw new Error("Model has no triangles.");
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const radius = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 || 1;
  const triStep = Math.max(1, Math.ceil(sourceTriangles / MAX_TRIANGLES));
  const cache: TextureCache = { textureIndexByImage: new Map(), textures: [] };
  const parts: ParsedMilkyWayMeshPart[] = [];
  let globalTri = 0;
  let usedTriangles = 0;
  let vertexCount = 0;

  const pushVertex = (
    packed: number[],
    prim: PrimitiveData,
    index: number,
    nx: number,
    ny: number,
    nz: number,
  ) => {
    packed.push(
      ((prim.positions[index * 3 + 0] ?? cx) - cx) / radius,
      ((prim.positions[index * 3 + 1] ?? cy) - cy) / radius,
      ((prim.positions[index * 3 + 2] ?? cz) - cz) / radius,
      prim.normals ? (prim.normals[index * 3 + 0] ?? nx) : nx,
      prim.normals ? (prim.normals[index * 3 + 1] ?? ny) : ny,
      prim.normals ? (prim.normals[index * 3 + 2] ?? nz) : nz,
      prim.uvs ? (prim.uvs[index * 2 + 0] ?? 0) : 0,
      prim.uvs ? (prim.uvs[index * 2 + 1] ?? 0) : 0,
      prim.colors ? (prim.colors[index * 4 + 0] ?? 1) : 1,
      prim.colors ? (prim.colors[index * 4 + 1] ?? 1) : 1,
      prim.colors ? (prim.colors[index * 4 + 2] ?? 1) : 1,
      prim.colors ? (prim.colors[index * 4 + 3] ?? 1) : 1,
    );
  };

  for (const prim of prims) {
    const material = await parseMaterial(prim.material, prim.uvs !== null, prim.colors !== null, cache);
    const packed: number[] = [];
    const indices = prim.indices;
    const end = prim.indexStart + prim.indexCount;
    for (let i = prim.indexStart; i + 2 < end; i += 3) {
      if (globalTri++ % triStep !== 0) continue;
      const ia = indices ? indices[i]! : i;
      const ib = indices ? indices[i + 1]! : i + 1;
      const ic = indices ? indices[i + 2]! : i + 2;
      const ax = prim.positions[ia * 3 + 0] ?? 0;
      const ay = prim.positions[ia * 3 + 1] ?? 0;
      const az = prim.positions[ia * 3 + 2] ?? 0;
      const bx = prim.positions[ib * 3 + 0] ?? 0;
      const by = prim.positions[ib * 3 + 1] ?? 0;
      const bz = prim.positions[ib * 3 + 2] ?? 0;
      const cxv = prim.positions[ic * 3 + 0] ?? 0;
      const cyv = prim.positions[ic * 3 + 1] ?? 0;
      const czv = prim.positions[ic * 3 + 2] ?? 0;
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const nLen = Math.hypot(nx, ny, nz) || 1;
      nx /= nLen; ny /= nLen; nz /= nLen;
      pushVertex(packed, prim, ia, nx, ny, nz);
      pushVertex(packed, prim, ib, nx, ny, nz);
      pushVertex(packed, prim, ic, nx, ny, nz);
      usedTriangles++;
    }
    if (packed.length > 0) {
      const vertices = new Float32Array(packed);
      const partVertexCount = vertices.length / MILKY_WAY_MODEL_VERTEX_FLOATS;
      parts.push({ vertices, vertexCount: partVertexCount, material });
      vertexCount += partVertexCount;
    }
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

export async function parseGlbMesh(buffer: ArrayBuffer): Promise<ParsedMilkyWayMesh> {
  const loader = getGltfLoader();
  const gltf = await loader.parseAsync(buffer.slice(0), "");
  gltf.scene.updateMatrixWorld(true);
  const prims: PrimitiveData[] = [];
  const tmp = new Vector3();
  const normalTmp = new Vector3();
  const normalMatrix = new Matrix3();

  gltf.scene.traverse((object) => {
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

  return normalizeAndPack(prims);
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
  const triStep = Math.max(1, Math.ceil(sourceTriangles / MAX_TRIANGLES));
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
      material: defaultMaterial(1),
    }],
    textures: [],
    vertexCount,
    sourceTriangleCount: sourceTriangles,
    usedTriangleCount: usedTriangles,
  };
}

export async function parseMilkyWayModel(buffer: ArrayBuffer, format: "glb" | "stl"): Promise<ParsedMilkyWayMesh> {
  return format === "glb" ? parseGlbMesh(buffer) : parseStlMesh(buffer);
}

import { Matrix3, Vector3, type Mesh } from "three";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export interface ParsedMilkyWayMesh {
  vertices: Float32Array;
  vertexCount: number;
  sourceTriangleCount: number;
  usedTriangleCount: number;
}

interface PrimitiveData {
  positions: Float32Array;
  normals: Float32Array | null;
  indices: Uint32Array | null;
  vertexCount: number;
}

const MAX_TRIANGLES = 38_000;
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

function normalizeAndPack(prims: PrimitiveData[]): ParsedMilkyWayMesh {
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
    sourceTriangles += Math.floor((prim.indices?.length ?? prim.vertexCount) / 3);
  }

  if (!Number.isFinite(minX) || sourceTriangles <= 0) throw new Error("Model has no triangles.");
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const radius = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 || 1;
  const triStep = Math.max(1, Math.ceil(sourceTriangles / MAX_TRIANGLES));
  const packed: number[] = [];
  let globalTri = 0;
  let usedTriangles = 0;

  const pushVertex = (pos: Float32Array, normals: Float32Array | null, index: number, nx: number, ny: number, nz: number) => {
    packed.push(
      ((pos[index * 3 + 0] ?? cx) - cx) / radius,
      ((pos[index * 3 + 1] ?? cy) - cy) / radius,
      ((pos[index * 3 + 2] ?? cz) - cz) / radius,
      normals ? (normals[index * 3 + 0] ?? nx) : nx,
      normals ? (normals[index * 3 + 1] ?? ny) : ny,
      normals ? (normals[index * 3 + 2] ?? nz) : nz,
    );
  };

  for (const prim of prims) {
    const indices = prim.indices;
    const indexCount = indices?.length ?? prim.vertexCount;
    for (let i = 0; i + 2 < indexCount; i += 3) {
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
      pushVertex(prim.positions, prim.normals, ia, nx, ny, nz);
      pushVertex(prim.positions, prim.normals, ib, nx, ny, nz);
      pushVertex(prim.positions, prim.normals, ic, nx, ny, nz);
      usedTriangles++;
    }
  }

  return {
    vertices: new Float32Array(packed),
    vertexCount: packed.length / 6,
    sourceTriangleCount: sourceTriangles,
    usedTriangleCount: usedTriangles,
  };
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
    const positions = new Float32Array(pos.count * 3);
    const normals = normal && normal.itemSize >= 3 ? new Float32Array(normal.count * 3) : null;

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
    }

    const index = geometry.getIndex();
    let indices: Uint32Array | null = null;
    if (index) {
      indices = new Uint32Array(index.count);
      for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
    }
    prims.push({ positions, normals, indices, vertexCount: pos.count });
  });

  return normalizeAndPack(prims);
}

function looksLikeBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  return 84 + triCount * 50 === buffer.byteLength;
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
      packed.push(
        (dv.getFloat32(p + 0, true) - cx) / radius,
        (dv.getFloat32(p + 4, true) - cy) / radius,
        (dv.getFloat32(p + 8, true) - cz) / radius,
        nx, ny, nz,
      );
    }
    usedTriangles++;
  }

  return {
    vertices: new Float32Array(packed),
    vertexCount: packed.length / 6,
    sourceTriangleCount: sourceTriangles,
    usedTriangleCount: usedTriangles,
  };
}

export async function parseMilkyWayModel(buffer: ArrayBuffer, format: "glb" | "stl"): Promise<ParsedMilkyWayMesh> {
  return format === "glb" ? parseGlbMesh(buffer) : parseStlMesh(buffer);
}

import renderWGSL   from "./render.wgsl?raw";
import starWGSL     from "./star.wgsl?raw";
import starModelWGSL from "./star-model.wgsl?raw";
import milkywayWGSL from "./milkyway.wgsl?raw";
import galaxyWGSL   from "./galaxy.wgsl?raw";
import galaxyTexturedWGSL from "./galaxy-textured.wgsl?raw";
import nebulaWGSL         from "./nebula.wgsl?raw";
import nebulaTexturedWGSL from "./nebula-textured.wgsl?raw";
import milkyWayModelWGSL  from "./milkyway-model.wgsl?raw";
import solarSystemModelWGSL from "./solar-system-model.wgsl?raw";
import dustImpostorWGSL from "./dust-impostor.wgsl?raw";
import dustWGSL     from "./dust.wgsl?raw";
import bloomExtractWGSL from "./bloom-extract.wgsl?raw";
import bloomBlurWGSL from "./bloom-blur.wgsl?raw";
import blackholeWGSL from "./blackhole.wgsl?raw";
import constellationWGSL from "./constellation.wgsl?raw";
import trailWGSL    from "./trail.wgsl?raw";
import { type GPUContext } from "./device";
import { type Body, BODY_FLOATS } from "../physics/body";
import { STAR_FLOATS } from "../catalog/stars";
import { type StarModelTypeId, starModelTypeIndex } from "../catalog/star-types";
import { MW_FLOATS } from "../catalog/milkyway";
import { GALAXY_FLOATS } from "../catalog/galaxies";
import { GALAXY_MODEL_FLOATS, type GalaxyTextureModel } from "../catalog/galaxy-models";
import { type MilkyWayModelObject } from "../catalog/milkyway-models";
import { type SolarSystemModelAsset } from "../catalog/solar-system-models";
import { NEBULA_FLOATS } from "../catalog/nebulas";
import {
  DUST_CLOUD_CAPACITY,
  DUST_CLOUD_DEFAULT_DRAW_COUNT,
  DUST_CLOUD_FLOATS,
} from "../catalog/dust";
import { CONSTELLATION_FLOATS } from "../catalog/constellations";
import { type TrailSystem, TRAIL_VTXFLOATS, TRAIL_SLOT_BYTES } from "../scene/trail-system";
import { type OctantRange } from "./sky-cull";
import { type CameraUniforms } from "../scene/camera";
import {
  MILKY_WAY_MODEL_VERTEX_FLOATS,
  createUvSphereMesh,
  parseMilkyWayModel,
  type ParsedMilkyWayMaterial,
  type ParsedModelFormat,
} from "./model-loader";
import { BackendUnavailableError, backendFetch } from "../services/backend";

// Camera uniform: mat4 (64) + right/min vec4 + up/focal vec4 + eye vec4 + screen/target vec4 + eye-offset vec4 = 144 bytes
const CAMERA_BYTES = 144;
const CAMERA_NEAR = 1e-8;
const CAMERA_FAR = 50_000_000;
const BLACK_HOLE_BYTES = 48;
const MILKY_WAY_MODEL_UNIFORM_BYTES = 64;
const MILKY_WAY_MODEL_MATERIAL_BYTES = 48;
const STAR_MODEL_UNIFORM_BYTES = 48;
const MODEL_DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const SCENE_COLOR_FORMAT: GPUTextureFormat = "rgba16float";
const BLOOM_SCALE = 4;
const BLOOM_BLUR_BYTES = 16;
const SCENE_DEPTH_DISABLED: GPUDepthStencilState = {
  format: MODEL_DEPTH_FORMAT,
  depthWriteEnabled: false,
  depthCompare: "always",
};
const TEXTURED_GALAXY_MODEL_CAPACITY = 32;
const DUST_CLOUD_UNIFORM_BYTES = 16;
const DUST_DEFAULT_TRANSPARENCY = 0.55;
const TRAIL_SCREEN_UNIFORM_BYTES = 16;
const TRAIL_THICKNESS_INSTANCES = 5;
const TRAIL_THICKNESS_PX = 2;
const MILKY_WAY_MODEL_RETRY_MS = 120_000;
const MILKY_WAY_MODEL_BACKEND_RETRY_MS = 120_000;

const TRAIL_MAX_BODIES   = 64;
const TRAIL_VTXBUF_BYTES = TRAIL_MAX_BODIES * TRAIL_SLOT_BYTES; // 64 × fixed slot = ~31 MB

interface BodyBrightnessSample {
  display: number;
  observerDistanceAU: number;
}

interface MilkyWayModelEntry {
  id: string;
  modelGroup: string;
  uniformBuffer: GPUBuffer;
  parts: MilkyWayModelPartEntry[];
  textures: GPUTexture[];
  vertexCount: number;
}

interface GalaxyTypeModelEntry {
  id: string;
  morphology: string;
  uniformBuffer: GPUBuffer;
  parts: MilkyWayModelPartEntry[];
  vertexCount: number;
}

interface SolarSystemModelEntry {
  id: string;
  bodyName: string;
  emissive: number;
  fallbackColor: [number, number, number];
  uniformBuffer: GPUBuffer;
  parts: MilkyWayModelPartEntry[];
  textures: GPUTexture[];
  vertexCount: number;
}

interface MilkyWayModelPartEntry {
  vertexBuffer: GPUBuffer;
  materialBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  vertexCount: number;
}

export interface SelectedStarModel {
  position: [number, number, number];
  radiusAU: number;
  color: [number, number, number];
  starType?: StarModelTypeId;
  alpha?: number;
}

interface GalaxyMeshBuild {
  vertices: Float32Array;
  vertexCount: number;
}

type Vec3 = [number, number, number];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeVec3(v: readonly [number, number, number]): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len <= 1e-8) return [0, 0, 1];
  return [v[0] / len, v[1] / len, v[2] / len];
}

function crossVec3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function galaxyNormal(model: GalaxyTextureModel): Vec3 {
  return normalizeVec3(crossVec3(model.right, model.up));
}

function galaxyLocalPoint(
  model: GalaxyTextureModel,
  u: number,
  v: number,
  w: number,
  normal = galaxyNormal(model),
): Vec3 {
  return [
    model.right[0] * u + model.up[0] * v + normal[0] * w,
    model.right[1] * u + model.up[1] * v + normal[1] * w,
    model.right[2] * u + model.up[2] * v + normal[2] * w,
  ];
}

function pushGalaxyMeshVertex(
  out: number[],
  pos: Vec3,
  normal: Vec3,
  uv: readonly [number, number],
  color: readonly [number, number, number, number],
): void {
  out.push(
    pos[0], pos[1], pos[2],
    normal[0], normal[1], normal[2],
    uv[0], uv[1],
    color[0], color[1], color[2], color[3],
  );
}

function pushGalaxyMeshTriangle(
  out: number[],
  a: ReturnType<typeof galaxyDiskVertex>,
  b: ReturnType<typeof galaxyDiskVertex>,
  c: ReturnType<typeof galaxyDiskVertex>,
): void {
  pushGalaxyMeshVertex(out, a.pos, a.normal, a.uv, a.color);
  pushGalaxyMeshVertex(out, b.pos, b.normal, b.uv, b.color);
  pushGalaxyMeshVertex(out, c.pos, c.normal, c.uv, c.color);
}

function galaxyDiskVertex(
  model: GalaxyTextureModel,
  radius: number,
  angle: number,
  options: {
    aspect?: number;
    radiusScale?: number;
    armCount?: number;
    twist?: number;
    thickness?: number;
    offsetU?: number;
    offsetV?: number;
    angleOffset?: number;
    alphaScale?: number;
    color?: readonly [number, number, number];
  },
) {
  const aspect = options.aspect ?? model.aspect;
  const radiusScale = options.radiusScale ?? 1;
  const armCount = options.armCount ?? 2;
  const twist = options.twist ?? 5.4;
  const theta = angle + (options.angleOffset ?? 0);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const arm = 0.5 + 0.5 * Math.cos(theta * armCount - radius * twist);
  const warp = Math.sin(theta * 2.0 + radius * 4.4) * radius * 0.018;
  const dustRuffle = Math.sin(theta * 5.0 + radius * 9.0) * radius * 0.007;
  const halfThickness = (options.thickness ?? 0.03) * (0.2 + (1 - radius) * 0.8);
  const u = (options.offsetU ?? 0) + c * radius * aspect * radiusScale;
  const v = (options.offsetV ?? 0) + s * radius * radiusScale;
  const w = warp + dustRuffle + (arm - 0.5) * halfThickness;
  const normal = galaxyNormal(model);
  const pos = galaxyLocalPoint(model, u, v, w, normal);
  const edgeFade = Math.pow(clamp(1 - radius, 0, 1), 0.7);
  const armLift = 0.72 + arm * 0.32;
  const alpha = clamp((options.alphaScale ?? 1) * (0.16 + edgeFade * 0.9) * armLift, 0, 1);
  const base = options.color ?? [1, 1, 1];
  return {
    pos,
    normal,
    uv: [0.5 + c * radius * 0.5, 0.5 - s * radius * 0.5] as const,
    color: [base[0], base[1], base[2], alpha] as const,
  };
}

function addGalaxyDiskMesh(
  out: number[],
  model: GalaxyTextureModel,
  options: Parameters<typeof galaxyDiskVertex>[3] & { rings?: number; segments?: number } = {},
): void {
  const rings = Math.max(8, options.rings ?? 28);
  const segments = Math.max(24, options.segments ?? 96);
  for (let ring = 0; ring < rings; ring++) {
    const r0 = ring / rings;
    const r1 = (ring + 1) / rings;
    for (let seg = 0; seg < segments; seg++) {
      const a0 = seg / segments * Math.PI * 2;
      const a1 = (seg + 1) / segments * Math.PI * 2;
      const p00 = galaxyDiskVertex(model, r0, a0, options);
      const p10 = galaxyDiskVertex(model, r1, a0, options);
      const p01 = galaxyDiskVertex(model, r0, a1, options);
      const p11 = galaxyDiskVertex(model, r1, a1, options);
      pushGalaxyMeshTriangle(out, p00, p10, p01);
      pushGalaxyMeshTriangle(out, p01, p10, p11);
    }
  }
}

function addGalaxyBarMesh(out: number[], model: GalaxyTextureModel): void {
  addGalaxyDiskMesh(out, model, {
    aspect: Math.max(2.4, model.aspect * 1.8),
    radiusScale: 0.32,
    armCount: 1,
    twist: 0.5,
    thickness: 0.055,
    alphaScale: 0.82,
    color: [1.0, 0.92, 0.74],
    rings: 14,
    segments: 48,
  });
}

function addGalaxyEllipsoidMesh(
  out: number[],
  model: GalaxyTextureModel,
  options: { xScale: number; yScale: number; zScale: number; alphaScale: number; color?: readonly [number, number, number] },
): void {
  const normal = galaxyNormal(model);
  const latBands = 20;
  const lonBands = 48;
  const color = options.color ?? [1.0, 0.9, 0.72];
  const vertex = (lat: number, lon: number) => {
    const v = lat / latBands;
    const u = lon / lonBands;
    const theta = v * Math.PI;
    const phi = (1 - u) * Math.PI * 2;
    const sinTheta = Math.sin(theta);
    const lx = Math.cos(phi) * sinTheta * options.xScale;
    const ly = Math.cos(theta) * options.zScale;
    const lz = Math.sin(phi) * sinTheta * options.yScale;
    const pos = galaxyLocalPoint(model, lx, lz, ly, normal);
    const n = normalizeVec3(galaxyLocalPoint(model, lx / options.xScale, lz / options.yScale, ly / options.zScale, normal));
    const edge = Math.sqrt(lx * lx + lz * lz);
    const alpha = clamp(options.alphaScale * (0.35 + (1 - edge) * 0.55), 0, 1);
    return {
      pos,
      normal: n,
      uv: [u, v] as const,
      color: [color[0], color[1], color[2], alpha] as const,
    };
  };

  for (let lat = 0; lat < latBands; lat++) {
    for (let lon = 0; lon < lonBands; lon++) {
      const p00 = vertex(lat, lon);
      const p10 = vertex(lat + 1, lon);
      const p01 = vertex(lat, lon + 1);
      const p11 = vertex(lat + 1, lon + 1);
      pushGalaxyMeshTriangle(out, p00, p10, p01);
      pushGalaxyMeshTriangle(out, p01, p10, p11);
    }
  }
}

function buildGalaxyTypeMesh(model: GalaxyTextureModel): GalaxyMeshBuild {
  const packed: number[] = [];
  switch (model.morphology) {
    case "barred-spiral":
      addGalaxyDiskMesh(packed, model, { armCount: 2, twist: 7.2, thickness: 0.038, alphaScale: 0.92 });
      addGalaxyBarMesh(packed, model);
      break;
    case "lenticular":
      addGalaxyDiskMesh(packed, model, {
        armCount: 1,
        twist: 1.2,
        thickness: 0.024,
        alphaScale: 0.72,
        color: [1.0, 0.92, 0.72],
      });
      addGalaxyEllipsoidMesh(packed, model, {
        xScale: 0.38,
        yScale: 0.38,
        zScale: 0.18,
        alphaScale: 0.82,
        color: [1.0, 0.87, 0.62],
      });
      break;
    case "elliptical":
      addGalaxyEllipsoidMesh(packed, model, {
        xScale: Math.max(1.1, model.aspect * 0.9),
        yScale: 0.88,
        zScale: 0.55,
        alphaScale: 0.92,
        color: [1.0, 0.86, 0.62],
      });
      break;
    case "irregular":
      addGalaxyDiskMesh(packed, model, {
        aspect: Math.max(1.05, model.aspect * 0.95),
        armCount: 3,
        twist: 3.2,
        thickness: 0.085,
        alphaScale: 0.55,
        color: [0.78, 0.86, 1.0],
        rings: 20,
        segments: 64,
      });
      addGalaxyDiskMesh(packed, model, {
        aspect: Math.max(0.85, model.aspect * 0.7),
        radiusScale: 0.58,
        armCount: 2,
        twist: -4.0,
        thickness: 0.14,
        offsetU: 0.18,
        offsetV: -0.08,
        angleOffset: 0.7,
        alphaScale: 0.44,
        color: [1.0, 0.72, 0.45],
        rings: 14,
        segments: 48,
      });
      break;
    case "edge-on-starburst":
      addGalaxyDiskMesh(packed, model, {
        aspect: Math.max(4.5, model.aspect * 3.5),
        radiusScale: 0.58,
        armCount: 1,
        twist: 0.8,
        thickness: 0.018,
        alphaScale: 0.72,
        color: [1.0, 0.78, 0.55],
        rings: 18,
        segments: 72,
      });
      addGalaxyEllipsoidMesh(packed, model, {
        xScale: 0.24,
        yScale: 0.08,
        zScale: 0.18,
        alphaScale: 0.88,
        color: [1.0, 0.58, 0.34],
      });
      break;
    case "interacting":
      addGalaxyDiskMesh(packed, model, {
        armCount: 2,
        twist: 6.8,
        thickness: 0.04,
        offsetU: -0.18,
        alphaScale: 0.75,
        rings: 24,
        segments: 72,
      });
      addGalaxyDiskMesh(packed, model, {
        aspect: Math.max(1.0, model.aspect * 0.78),
        radiusScale: 0.44,
        armCount: 2,
        twist: -4.8,
        thickness: 0.042,
        offsetU: 0.64,
        offsetV: 0.28,
        angleOffset: 0.9,
        alphaScale: 0.62,
        color: [0.8, 0.9, 1.0],
        rings: 18,
        segments: 56,
      });
      break;
    case "spiral":
    default:
      addGalaxyDiskMesh(packed, model, {
        armCount: 2,
        twist: 7.0,
        thickness: 0.036,
        alphaScale: 0.86,
      });
      addGalaxyEllipsoidMesh(packed, model, {
        xScale: 0.22,
        yScale: 0.22,
        zScale: 0.12,
        alphaScale: 0.78,
        color: [1.0, 0.88, 0.65],
      });
      break;
  }

  const vertices = new Float32Array(packed);
  return {
    vertices,
    vertexCount: vertices.length / MILKY_WAY_MODEL_VERTEX_FLOATS,
  };
}

function projectionOnlyMatrix(focalY: number, aspect: number): Float32Array {
  const safeAspect = Math.max(1e-6, aspect);
  const nf = 1 / (CAMERA_NEAR - CAMERA_FAR);
  return new Float32Array([
    focalY / safeAspect, 0, 0, 0,
    0, focalY, 0, 0,
    0, 0, CAMERA_FAR * nf, -1,
    0, 0, CAMERA_FAR * CAMERA_NEAR * nf, 0,
  ]);
}

function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

function isHtmlResponse(buffer: ArrayBuffer): boolean {
  const head = new TextDecoder("utf-8").decode(buffer.slice(0, Math.min(buffer.byteLength, 96))).trimStart();
  return head.startsWith("<!DOCTYPE") || head.startsWith("<html") || head.startsWith("<");
}

function hasGlbMagic(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 12) return false;
  const bytes = new Uint8Array(buffer, 0, 4);
  return bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46;
}

function hasUsdzMagic(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 4) return false;
  const bytes = new Uint8Array(buffer, 0, 4);
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function responseOrigin(response: Response): string {
  try {
    return response.url ? new URL(response.url).origin : "unknown origin";
  } catch {
    return "unknown origin";
  }
}

class ModelAssetResponseError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "ModelAssetResponseError";
    this.retryable = retryable;
  }
}

function validateMilkyWayModelResponse(
  model: { format: ParsedModelFormat },
  response: Response,
  buffer: ArrayBuffer,
): void {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html") || isHtmlResponse(buffer)) {
    throw new ModelAssetResponseError(`model route returned HTML from ${responseOrigin(response)}`, true);
  }
  if (model.format === "glb" && !hasGlbMagic(buffer)) {
    throw new ModelAssetResponseError(`model route returned non-GLB data (${contentType || "unknown content type"})`, true);
  }
  if (model.format === "usdz" && !hasUsdzMagic(buffer)) {
    throw new ModelAssetResponseError(`model route returned non-USDZ data (${contentType || "unknown content type"})`, true);
  }
  if (model.format === "stl" && buffer.byteLength < 84) {
    throw new ModelAssetResponseError(`model route returned invalid STL data (${contentType || "unknown content type"})`, true);
  }
}

function cacheBustedModelAssetUrl(assetUrl: string): string {
  const separator = assetUrl.includes("?") ? "&" : "?";
  return `${assetUrl}${separator}modelRetry=${Date.now().toString(36)}`;
}

async function fetchValidatedModelAsset(
  assetUrl: string,
  model: { format: ParsedModelFormat },
): Promise<ArrayBuffer> {
  const fetchOnce = async (url: string, cache: RequestCache): Promise<ArrayBuffer> => {
    const resp = await backendFetch(url, { cache });
    if (!resp.ok) throw new Error(`asset ${resp.status}`);
    const buffer = await resp.arrayBuffer();
    validateMilkyWayModelResponse(model, resp, buffer);
    return buffer;
  };

  try {
    return await fetchOnce(assetUrl, "force-cache");
  } catch (error) {
    if (!(error instanceof ModelAssetResponseError) || !error.retryable) throw error;
    return await fetchOnce(cacheBustedModelAssetUrl(assetUrl), "reload");
  }
}

export class Renderer {
  private bodyPipeline!:    GPURenderPipeline;
  private starPipeline!:    GPURenderPipeline;
  private starModelPipeline!: GPURenderPipeline;
  private mwPipeline!:      GPURenderPipeline;
  private galaxyPipeline!:  GPURenderPipeline;
  private galaxyTexturedPipeline!: GPURenderPipeline;
  private nebulaPipeline!:          GPURenderPipeline;
  private nebulaTexturedPipeline!:  GPURenderPipeline;
  private milkyWayModelPipeline!:   GPURenderPipeline;
  private solarSystemModelPipeline!: GPURenderPipeline;
  private dustImpostorPipeline!: GPURenderPipeline;
  private dustPipeline!:    GPURenderPipeline;
  private bloomExtractPipeline!: GPURenderPipeline;
  private bloomBlurPipeline!: GPURenderPipeline;
  private blackHolePipeline!: GPURenderPipeline;
  private constellationPipeline!: GPURenderPipeline;
  private trailPipeline!:   GPURenderPipeline;

  private cameraBuffer!:      GPUBuffer;
  private bodyCameraBuffer!:  GPUBuffer;
  private bodyBuffer!:        GPUBuffer;
  private starBuffer!:        GPUBuffer;
  private mwStarBuffer!:      GPUBuffer;
  private galaxyBuffer!:      GPUBuffer;
  private galaxyModelBuffer!: GPUBuffer;
  private nebulaBuffer!:          GPUBuffer;
  private homunculusBuffer!:      GPUBuffer;
  private dustCloudBuffer!:       GPUBuffer;
  private dustUniformBuffer!:     GPUBuffer;
  private blackHoleBuffer!:   GPUBuffer;
  private constellationBuffer!: GPUBuffer;
  private trailVertexBuffer!: GPUBuffer;
  private trailScreenBuffer!: GPUBuffer;

  private bodyBindGroup!:   GPUBindGroup;
  private starBindGroup!:   GPUBindGroup;
  private mwBindGroup!:     GPUBindGroup;
  private galaxyBindGroup!: GPUBindGroup;
  private galaxyModelBGL!: GPUBindGroupLayout;
  private galaxyModelSampler!: GPUSampler;
  private galaxyModelDraws: Array<{ bindGroup: GPUBindGroup; index: number }> = [];
  private galaxyModelTextures: GPUTexture[] = [];
  private galaxyTypeModelEntries = new Map<string, GalaxyTypeModelEntry>();
  private nebulaBindGroup!:          GPUBindGroup;
  private homunculusBindGroup:       GPUBindGroup | null = null;
  private homunculusBGL!:            GPUBindGroupLayout;
  private homunculusTexture:         GPUTexture | null = null;
  private homunculusSampler!:        GPUSampler;
  private milkyWayModelBGL!:         GPUBindGroupLayout;
  private milkyWayModelSampler!:     GPUSampler;
  private milkyWayModelWhiteTexture!: GPUTexture;
  private milkyWayModelEntries = new Map<string, MilkyWayModelEntry>();
  private milkyWayModelLoading = new Set<string>();
  private milkyWayModelFailedAt = new Map<string, number>();
  private milkyWayModelBackendRetryAt = 0;
  private activeMilkyWayModelId: string | null = null;
  private solarSystemModelEntries = new Map<string, SolarSystemModelEntry>();
  private solarSystemModelLoading = new Set<string>();
  private solarSystemModelFailedAt = new Map<string, number>();
  private dustBindGroup!:   GPUBindGroup;
  private bloomExtractBindGroup: GPUBindGroup | null = null;
  private bloomBlurHBindGroup:   GPUBindGroup | null = null;
  private bloomBlurVBindGroup:   GPUBindGroup | null = null;
  private blackHoleBindGroup: GPUBindGroup | null = null;
  private constellationBindGroup!: GPUBindGroup;
  private trailBindGroup!:  GPUBindGroup;
  private starBGL!:         GPUBindGroupLayout;
  private mwBGL!:           GPUBindGroupLayout;
  private galaxyBGL!:       GPUBindGroupLayout;
  private nebulaBGL!:       GPUBindGroupLayout;
  private dustBGL!:         GPUBindGroupLayout;
  private bloomExtractBGL!: GPUBindGroupLayout;
  private bloomBlurBGL!:    GPUBindGroupLayout;
  private blackHoleBGL!:    GPUBindGroupLayout;
  private constellationBGL!: GPUBindGroupLayout;
  private sceneSampler!:    GPUSampler;
  private bloomSampler!:    GPUSampler;
  private sceneTexture:     GPUTexture | null = null;
  private sceneTextureView: GPUTextureView | null = null;
  private sceneTextureWidth = 0;
  private sceneTextureHeight = 0;
  private bloomExtractTexture:     GPUTexture | null = null;
  private bloomExtractTextureView: GPUTextureView | null = null;
  private bloomPingTexture:        GPUTexture | null = null;
  private bloomPingTextureView:    GPUTextureView | null = null;
  private bloomPongTexture:        GPUTexture | null = null;
  private bloomPongTextureView:    GPUTextureView | null = null;
  private bloomWidth = 0;
  private bloomHeight = 0;
  private depthTexture:     GPUTexture | null = null;
  private depthTextureView: GPUTextureView | null = null;
  private depthTextureWidth = 0;
  private depthTextureHeight = 0;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private selectedStarBuffer!: GPUBuffer;
  private selectedStarModelBuffer!: GPUBuffer;
  private selectedStarModelBGL!: GPUBindGroupLayout;
  private selectedStarModelBindGroup!: GPUBindGroup;
  private selectedStarModelVertexBuffer!: GPUBuffer;
  private selectedStarModelVertexCount = 0;
  private selectedStarModelUniform = new Float32Array(STAR_MODEL_UNIFORM_BYTES / 4);
  private selectedStarModelActive = false;
  private starLodBuffer!:   GPUBuffer;  // x=legacy fade, y=camera radius, z=brightness effects
  private mwLodBuffer!:     GPUBuffer;  // x=fade, y=legacy apparent boost, z=brightness effects
  private galaxyLodBuffer!: GPUBuffer;  // x=legacy apparent boost, y=brightness effects
  private bloomBlurHBuffer!: GPUBuffer;
  private bloomBlurVBuffer!: GPUBuffer;

  private bodyCount    = 0;
  private starCount    = 0;
  private mwStarCount  = 0;
  private galaxyCount  = 0;
  private galaxyModelCount = 0;
  private nebulaCount  = 0;
  private dustCloudCount = 0;
  private constellationCount = 0;
  private starCapacity = 0;
  private constellationCapacity = 0;

  // Single-entry "Milky Way as a galaxy" billboard — fades in when individual
  // MW stars fade out (camera > 10 kpc). Uses the galaxy pipeline with actual=false
  // so the stored alpha is used directly instead of the brightness formula.
  private mwSelfBuffer!:    GPUBuffer;
  private mwSelfLodBuffer!: GPUBuffer;   // always actual=0 so stored alpha is authoritative
  private mwSelfBindGroup!: GPUBindGroup;
  private _mwSelfAlpha = 0;

  // Octant ranges are used only to spread Settings LOD caps across the sky.
  // Actual frustum rejection for catalog billboards happens per instance in WGSL.
  private starOctants:   OctantRange[] | null = null;
  private mwOctants:     OctantRange[] | null = null;
  private galaxyOctants: OctantRange[] | null = null;

  // Fixed GPU-buffer slots per body (assigned on first seen, never moved).
  // Slot i occupies bytes [i * TRAIL_SLOT_BYTES, (i+1) * TRAIL_SLOT_BYTES).
  private trailSlot      = new Map<number, number>(); // bodyId → slot index
  private trailSlotCount = 0;
  // Last-drawn vertex count per slot — needed to call pass.draw with the right count.
  private trailDrawCount = new Map<number, number>(); // bodyId → vertex count

  // Performance / display settings
  private _starLimit    = Infinity;
  private _mwStarLimit  = Infinity;
  private _galaxyLimit  = Infinity;
  private _showTrails   = true;
  private _showGalaxies = true;
  private _showConstellations = false;
  // This setting now controls the realistic HDR/spectral/bloom presentation.
  // The older apparent-magnitude boost is deliberately kept disabled because it
  // inflated solar-system bodies and nearby galaxies beyond their real volume.
  private _actualBrightness = true;
  private _objectBrightness = 1;
  private _cameraDistanceFromSun = 0;
  private cameraUniforms: CameraUniforms | null = null;
  private _showDust = true;
  private _dustTransparency = DUST_DEFAULT_TRANSPARENCY;
  private _dustDrawLimit = DUST_CLOUD_DEFAULT_DRAW_COUNT;
  private _showBlackHole = true;
  private _blackHoleUniform = new Float32Array([
    0, 0, 0, 0,
    0, 1, 1, 1,
    0, 0, 0, 0,
  ]);

  applySettings(s: {
    starLimit?:   number;
    mwStarLimit?: number;
    galaxyLimit?: number;
    showGalaxies?: boolean;
    showConstellations?: boolean;
    showTrails?:  boolean;
    actualBodyBrightness?: boolean;
    objectBrightness?: number;
    showDust?: boolean;
    dustTransparency?: number;
    dustDrawLimit?: number;
    showBlackHole?: boolean;
  }): void {
    if (s.starLimit   !== undefined) this._starLimit   = s.starLimit;
    if (s.mwStarLimit !== undefined) this._mwStarLimit = s.mwStarLimit;
    if (s.galaxyLimit !== undefined) this._galaxyLimit = s.galaxyLimit;
    if (s.showGalaxies !== undefined) this._showGalaxies = s.showGalaxies;
    if (s.showConstellations !== undefined) this._showConstellations = s.showConstellations;
    if (s.showTrails  !== undefined) this._showTrails  = s.showTrails;
    if (s.actualBodyBrightness !== undefined) {
      this._actualBrightness = s.actualBodyBrightness;
      this.syncBrightnessUniforms();
      this.writeSelectedStarModelUniform();
    }
    if (s.objectBrightness !== undefined) {
      this._objectBrightness = clamp(s.objectBrightness, 0.25, 3);
    }
    if (s.showDust !== undefined) this._showDust = s.showDust;
    if (s.dustTransparency !== undefined) this._dustTransparency = clamp(s.dustTransparency, 0, 1);
    if (s.dustDrawLimit !== undefined) {
      this._dustDrawLimit = clamp(Math.floor(s.dustDrawLimit), 0, DUST_CLOUD_CAPACITY);
    }
    if (s.showBlackHole !== undefined) this._showBlackHole = s.showBlackHole;
  }

  setActiveMilkyWayModel(id: string | null): void {
    this.activeMilkyWayModelId = id?.startsWith("mwmodel:")
      ? id.slice("mwmodel:".length)
      : id;
    if (this.activeMilkyWayModelId) {
      this.milkyWayModelFailedAt.delete(this.activeMilkyWayModelId);
    }
  }

  constructor(
    private ctx: GPUContext,
    private canvasCtx: GPUCanvasContext,
  ) {}

  init(maxBodies: number, maxStars = 1, maxGalaxies = 1): void {
    const { device, format } = this.ctx;
    const sceneFormat = SCENE_COLOR_FORMAT;

    this.cameraBuffer = device.createBuffer({
      label: "camera-uniform",
      size:  CAMERA_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bodyCameraBuffer = device.createBuffer({
      label: "body-camera-uniform",
      size:  CAMERA_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bodyBuffer = device.createBuffer({
      label: "body-storage",
      size:  maxBodies * BODY_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.starCapacity = Math.max(1, maxStars);
    this.starBuffer = device.createBuffer({
      label: "catalog-star-storage",
      size:  this.starCapacity * STAR_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.galaxyBuffer = device.createBuffer({
      label: "galaxy-storage",
      size:  Math.max(1, maxGalaxies) * GALAXY_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.galaxyModelBuffer = device.createBuffer({
      label: "textured-galaxy-model-storage",
      size: TEXTURED_GALAXY_MODEL_CAPACITY * GALAXY_MODEL_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.galaxyModelSampler = device.createSampler({
      label: "textured-galaxy-model-sampler",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });

    // Nebula buffer: fixed-size (≤ 1 600 nebulas × 64 bytes = 102 kB — still tiny)
    this.nebulaBuffer = device.createBuffer({
      label: "nebula-storage",
      size:  1_600 * NEBULA_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // Homunculus buffer: single 64-byte entry for the textured Eta Carinae billboard
    this.homunculusBuffer = device.createBuffer({
      label: "homunculus-storage",
      size:  NEBULA_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.homunculusSampler = device.createSampler({
      label: "homunculus-sampler",
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });

    this.dustCloudBuffer = device.createBuffer({
      label: "galactic-dust-cloud-storage",
      size: DUST_CLOUD_CAPACITY * DUST_CLOUD_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.dustUniformBuffer = device.createBuffer({
      label: "galactic-dust-cloud-uniform",
      size: DUST_CLOUD_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.blackHoleBuffer = device.createBuffer({
      label: "black-hole-visual-uniform",
      size:  BLACK_HOLE_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.blackHoleBuffer, 0, this._blackHoleUniform);
    this.sceneSampler = device.createSampler({
      label: "black-hole-scene-sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.bloomSampler = device.createSampler({
      label: "hdr-bloom-sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });
    this.bloomBlurHBuffer = device.createBuffer({
      label: "hdr-bloom-blur-horizontal",
      size: BLOOM_BLUR_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bloomBlurVBuffer = device.createBuffer({
      label: "hdr-bloom-blur-vertical",
      size: BLOOM_BLUR_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.constellationCapacity = 1;
    this.constellationBuffer = device.createBuffer({
      label: "constellation-lines",
      size:  CONSTELLATION_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.trailVertexBuffer = device.createBuffer({
      label: "trail-vertices",
      size:  TRAIL_VTXBUF_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.trailScreenBuffer = device.createBuffer({
      label: "trail-screen-uniform",
      size: TRAIL_SCREEN_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // ── Body pipeline ──────────────────────────────────────────────────────
    const bodyBGL = device.createBindGroupLayout({
      label: "body-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    this.bodyBindGroup = device.createBindGroup({
      label: "body-bg", layout: bodyBGL,
      entries: [
        { binding: 0, resource: { buffer: this.bodyCameraBuffer } },
        { binding: 1, resource: { buffer: this.bodyBuffer } },
      ],
    });
    const bodyShader = device.createShaderModule({ code: renderWGSL });
    this.bodyPipeline = device.createRenderPipeline({
      label: "body-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [bodyBGL] }),
      vertex:   { module: bodyShader, entryPoint: "vs_main" },
      fragment: {
        module: bodyShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Selected-star uniform (xyz pos + w=active flag, 16 bytes) ─────────────
    this.selectedStarBuffer = device.createBuffer({
      label: "selected-star",
      size:  16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.selectedStarBuffer, 0, new Float32Array([0, 0, 0, 0]));
    this.selectedStarModelBuffer = device.createBuffer({
      label: "selected-star-model",
      size: STAR_MODEL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.selectedStarModelBuffer, 0, this.selectedStarModelUniform);
    const selectedStarMesh = createUvSphereMesh(48, 96);
    const selectedStarPart = selectedStarMesh.parts[0]!;
    this.selectedStarModelVertexCount = selectedStarPart.vertexCount;
    this.selectedStarModelVertexBuffer = device.createBuffer({
      label: "selected-star-model-sphere",
      size: selectedStarPart.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.selectedStarModelVertexBuffer, 0, selectedStarPart.vertices as GPUAllowSharedBufferSource);

    // ── LOD / brightness uniforms — 16-byte each ──────────────────────────
    this.starLodBuffer = device.createBuffer({
      label: "star-lod", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.mwLodBuffer = device.createBuffer({
      label: "mw-lod", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.galaxyLodBuffer = device.createBuffer({
      label: "galaxy-lod", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // MW self: 1-entry galaxy storage + flat lod (actual=0 → use stored alpha)
    this.mwSelfBuffer = device.createBuffer({
      label: "mw-self-storage",
      size:  GALAXY_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.mwSelfLodBuffer = device.createBuffer({
      label: "mw-self-lod", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // actual=0 → galaxy shader uses stored alpha directly, no brightness formula
    device.queue.writeBuffer(this.mwSelfLodBuffer, 0, new Float32Array([0, 0, 0, 0]));
    // Initialise with invisible MW (alpha=0); updated each frame via uploadMilkywayGalaxy()
    device.queue.writeBuffer(this.mwSelfBuffer, 0, new Float32Array([0,0,0, 5.0, 1.0,0.90,0.70, 0.0]));

    // Catalog stars use camera-distance shell culling in star.wgsl; named
    // nearby-star labels handle their own DOM visibility in LabelManager.
    this.syncBrightnessUniforms();

    // ── Milky Way background star buffer (fixed 100k capacity) ────────────
    this.mwStarBuffer = device.createBuffer({
      label: "mw-star-storage",
      size:  200_000 * MW_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // ── Static catalog star pipeline ───────────────────────────────────────
    this.starBGL = device.createBindGroupLayout({
      label: "catalog-star-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.starBindGroup = device.createBindGroup({
      label: "catalog-star-bg", layout: this.starBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.starBuffer } },
        { binding: 2, resource: { buffer: this.selectedStarBuffer } },
        { binding: 3, resource: { buffer: this.starLodBuffer } },
      ],
    });
    const starShader = device.createShaderModule({ code: starWGSL });
    this.starPipeline = device.createRenderPipeline({
      label: "catalog-star-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.starBGL] }),
      vertex:   { module: starShader, entryPoint: "vs_main" },
      fragment: {
        module: starShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "one",       dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Selected star close-LOD 3D surface model ───────────────────────────
    this.selectedStarModelBGL = device.createBindGroupLayout({
      label: "selected-star-model-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.selectedStarModelBindGroup = device.createBindGroup({
      label: "selected-star-model-bg",
      layout: this.selectedStarModelBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.selectedStarModelBuffer } },
      ],
    });
    const starModelShader = device.createShaderModule({ code: starModelWGSL });
    this.starModelPipeline = device.createRenderPipeline({
      label: "selected-star-model-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.selectedStarModelBGL] }),
      vertex: {
        module: starModelShader,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: MILKY_WAY_MODEL_VERTEX_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0,     format: "float32x3" },
            { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },
            { shaderLocation: 2, offset: 6 * 4, format: "float32x2" },
            { shaderLocation: 3, offset: 8 * 4, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: starModelShader,
        entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Milky Way background star pipeline ────────────────────────────────
    this.mwBGL = device.createBindGroupLayout({
      label: "mw-star-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.mwBindGroup = device.createBindGroup({
      label: "mw-star-bg", layout: this.mwBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.mwStarBuffer } },
        { binding: 2, resource: { buffer: this.mwLodBuffer } },
      ],
    });
    const mwShader = device.createShaderModule({ code: milkywayWGSL });
    this.mwPipeline = device.createRenderPipeline({
      label: "mw-star-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.mwBGL] }),
      vertex:   { module: mwShader, entryPoint: "vs_main" },
      fragment: {
        module: mwShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "one",       dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Galaxy pipeline ────────────────────────────────────────────────────
    this.galaxyBGL = device.createBindGroupLayout({
      label: "galaxy-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.galaxyBindGroup = device.createBindGroup({
      label: "galaxy-bg", layout: this.galaxyBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.galaxyBuffer } },
        { binding: 2, resource: { buffer: this.galaxyLodBuffer } },
      ],
    });
    // MW self uses the same galaxy pipeline/BGL but with its own storage+lod
    this.mwSelfBindGroup = device.createBindGroup({
      label: "mw-self-bg", layout: this.galaxyBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.mwSelfBuffer } },
        { binding: 2, resource: { buffer: this.mwSelfLodBuffer } },
      ],
    });
    const galaxyShader = device.createShaderModule({ code: galaxyWGSL });
    this.galaxyPipeline = device.createRenderPipeline({
      label: "galaxy-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.galaxyBGL] }),
      vertex:   { module: galaxyShader, entryPoint: "vs_main" },
      fragment: {
        module: galaxyShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Textured close-LOD galaxy model pipeline ───────────────────────────
    this.galaxyModelBGL = device.createBindGroupLayout({
      label: "textured-galaxy-model-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const galaxyTexturedShader = device.createShaderModule({ code: galaxyTexturedWGSL });
    this.galaxyTexturedPipeline = device.createRenderPipeline({
      label: "textured-galaxy-model-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.galaxyModelBGL] }),
      vertex:   { module: galaxyTexturedShader, entryPoint: "vs_main" },
      fragment: {
        module: galaxyTexturedShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Nebula pipeline (alpha blend — drawn BEFORE stars, AFTER galaxies) ───
    this.nebulaBGL = device.createBindGroupLayout({
      label: "nebula-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    this.nebulaBindGroup = device.createBindGroup({
      label: "nebula-bg", layout: this.nebulaBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.nebulaBuffer } },
      ],
    });
    const nebulaShader = device.createShaderModule({ code: nebulaWGSL });
    this.nebulaPipeline = device.createRenderPipeline({
      label: "nebula-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.nebulaBGL] }),
      vertex:   { module: nebulaShader, entryPoint: "vs_main" },
      fragment: {
        module: nebulaShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            // Additive blending makes emission nebulas glow correctly
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Homunculus (textured) pipeline — real NASA Hubble image of Eta Carinae
    this.homunculusBGL = device.createBindGroupLayout({
      label: "homunculus-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    const homunculusShader = device.createShaderModule({ code: nebulaTexturedWGSL });
    this.nebulaTexturedPipeline = device.createRenderPipeline({
      label: "nebula-textured-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.homunculusBGL] }),
      vertex:   { module: homunculusShader, entryPoint: "vs_main" },
      fragment: {
        module: homunculusShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Milky Way object 3D models — lazy NASA/Chandra mesh LOD ───────────
    this.milkyWayModelBGL = device.createBindGroupLayout({
      label: "milky-way-model-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.milkyWayModelSampler = device.createSampler({
      label: "milky-way-model-sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });
    this.milkyWayModelWhiteTexture = device.createTexture({
      label: "milky-way-model-white-texture",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    const whiteTexturePixels = new Uint8Array(256);
    whiteTexturePixels.set([255, 255, 255, 255]);
    device.queue.writeTexture(
      { texture: this.milkyWayModelWhiteTexture },
      whiteTexturePixels,
      { bytesPerRow: 256, rowsPerImage: 1 },
      [1, 1, 1],
    );
    const milkyWayModelShader = device.createShaderModule({ code: milkyWayModelWGSL });
    this.milkyWayModelPipeline = device.createRenderPipeline({
      label: "milky-way-model-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.milkyWayModelBGL] }),
      vertex: {
        module: milkyWayModelShader,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: MILKY_WAY_MODEL_VERTEX_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0,     format: "float32x3" },
            { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },
            { shaderLocation: 2, offset: 6 * 4, format: "float32x2" },
            { shaderLocation: 3, offset: 8 * 4, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: milkyWayModelShader,
        entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    const solarSystemModelShader = device.createShaderModule({ code: solarSystemModelWGSL });
    this.solarSystemModelPipeline = device.createRenderPipeline({
      label: "solar-system-model-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.milkyWayModelBGL] }),
      vertex: {
        module: solarSystemModelShader,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: MILKY_WAY_MODEL_VERTEX_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0,     format: "float32x3" },
            { shaderLocation: 1, offset: 3 * 4, format: "float32x3" },
            { shaderLocation: 2, offset: 6 * 4, format: "float32x2" },
            { shaderLocation: 3, offset: 8 * 4, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: solarSystemModelShader,
        entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: MODEL_DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    });

    // ── Partial galactic dust cloud pipeline ───────────────────────────────
    this.dustBGL = device.createBindGroupLayout({
      label: "dust-cloud-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.dustBindGroup = device.createBindGroup({
      label: "dust-cloud-bg", layout: this.dustBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.dustCloudBuffer } },
        { binding: 2, resource: { buffer: this.dustUniformBuffer } },
      ],
    });
    const dustImpostorShader = device.createShaderModule({ code: dustImpostorWGSL });
    this.dustImpostorPipeline = device.createRenderPipeline({
      label: "dust-cloud-impostor-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.dustBGL] }),
      vertex:   { module: dustImpostorShader, entryPoint: "vs_main" },
      fragment: {
        module: dustImpostorShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    const dustShader = device.createShaderModule({ code: dustWGSL });
    this.dustPipeline = device.createRenderPipeline({
      label: "dust-cloud-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.dustBGL] }),
      vertex:   { module: dustShader, entryPoint: "vs_main" },
      fragment: {
        module: dustShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── HDR bloom post-process: bright-pass + separable blur ──────────────
    this.bloomExtractBGL = device.createBindGroupLayout({
      label: "hdr-bloom-extract-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const bloomExtractShader = device.createShaderModule({ code: bloomExtractWGSL });
    this.bloomExtractPipeline = device.createRenderPipeline({
      label: "hdr-bloom-extract-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bloomExtractBGL] }),
      vertex:   { module: bloomExtractShader, entryPoint: "vs_main" },
      fragment: {
        module: bloomExtractShader,
        entryPoint: "fs_main",
        targets: [{ format: SCENE_COLOR_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    this.bloomBlurBGL = device.createBindGroupLayout({
      label: "hdr-bloom-blur-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    const bloomBlurShader = device.createShaderModule({ code: bloomBlurWGSL });
    this.bloomBlurPipeline = device.createRenderPipeline({
      label: "hdr-bloom-blur-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.bloomBlurBGL] }),
      vertex:   { module: bloomBlurShader, entryPoint: "vs_main" },
      fragment: {
        module: bloomBlurShader,
        entryPoint: "fs_main",
        targets: [{ format: SCENE_COLOR_FORMAT }],
      },
      primitive: { topology: "triangle-list" },
    });

    // ── Sagittarius A* black-hole lensing post-process ────────────────────
    this.blackHoleBGL = device.createBindGroupLayout({
      label: "black-hole-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const blackHoleShader = device.createShaderModule({ code: blackholeWGSL });
    this.blackHolePipeline = device.createRenderPipeline({
      label: "black-hole-postprocess-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.blackHoleBGL] }),
      vertex:   { module: blackHoleShader, entryPoint: "vs_main" },
      fragment: {
        module: blackHoleShader, entryPoint: "fs_main",
        targets: [{ format }],
      },
      primitive: { topology: "triangle-list" },
    });

    // ── Constellation line-list pipeline ──────────────────────────────────
    this.constellationBGL = device.createBindGroupLayout({
      label: "constellation-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    });
    this.constellationBindGroup = device.createBindGroup({
      label: "constellation-bg", layout: this.constellationBGL,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
    });
    const constellationShader = device.createShaderModule({ code: constellationWGSL });
    this.constellationPipeline = device.createRenderPipeline({
      label: "constellation-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.constellationBGL] }),
      vertex: {
        module: constellationShader, entryPoint: "vs_main",
        buffers: [{
          arrayStride: CONSTELLATION_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0,     format: "float32x3" },
            { shaderLocation: 1, offset: 3 * 4, format: "float32" },
          ],
        }],
      },
      fragment: {
        module: constellationShader, entryPoint: "fs_main",
        targets: [{
          format: sceneFormat,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "line-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Trail pipeline ─────────────────────────────────────────────────────
    const trailBGL = device.createBindGroupLayout({
      label: "trail-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    });
    this.trailBindGroup = device.createBindGroup({
      label: "trail-bg", layout: trailBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.trailScreenBuffer } },
      ],
    });
    const trailShader = device.createShaderModule({ code: trailWGSL });
    this.trailPipeline = device.createRenderPipeline({
      label: "trail-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [trailBGL] }),
      vertex: {
        module: trailShader, entryPoint: "vs_main",
        buffers: [{
          arrayStride: TRAIL_VTXFLOATS * 4, // 32 bytes per vertex
          attributes: [
            { shaderLocation: 0, offset: 0,      format: "float32x3" }, // pos xyz
            { shaderLocation: 1, offset: 3 * 4,  format: "float32"   }, // age
            { shaderLocation: 2, offset: 4 * 4,  format: "float32x3" }, // color rgb
          ],
        }],
      },
      fragment: {
        module: trailShader, entryPoint: "fs_main",
        targets: [{
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "line-strip" },
    });
  }

  /** Store pre-sorted octant ranges for a catalog after sortIntoOctants(). */
  setStarOctants(ranges: OctantRange[]): void   { this.starOctants   = ranges; }
  setMwOctants(ranges: OctantRange[]): void     { this.mwOctants     = ranges; }
  setGalaxyOctants(ranges: OctantRange[]): void { this.galaxyOctants = ranges; }

  /** Call after TrailSystem.clear() so slots are reassigned from scratch. */
  resetTrailSlots(): void {
    this.trailSlot.clear();
    this.trailSlotCount = 0;
    this.trailDrawCount.clear();
  }

  /** Upload the selected catalog star position (or null to deactivate). */
  uploadSelectedStar(pos: [number, number, number] | null): void {
    const data = pos
      ? new Float32Array([pos[0], pos[1], pos[2], 1.0])
      : new Float32Array([0, 0, 0, 0]);
    this.ctx.device.queue.writeBuffer(this.selectedStarBuffer, 0, data);
    if (!pos) this.uploadSelectedStarModel(null);
  }

  uploadSelectedStarModel(model: SelectedStarModel | null): void {
    if (!model) {
      if (!this.selectedStarModelActive) return;
      this.selectedStarModelActive = false;
      this.selectedStarModelUniform.fill(0);
      this.writeSelectedStarModelUniform();
      return;
    }

    const radiusAU = Math.max(0.00465047 * 0.01, Number.isFinite(model.radiusAU) ? model.radiusAU : 0.00465047);
    const alpha = clamp(Number.isFinite(model.alpha) ? Number(model.alpha) : 1, 0.05, 1);
    this.selectedStarModelActive = true;
    this.selectedStarModelUniform[0] = model.position[0];
    this.selectedStarModelUniform[1] = model.position[1];
    this.selectedStarModelUniform[2] = model.position[2];
    this.selectedStarModelUniform[3] = radiusAU;
    this.selectedStarModelUniform[4] = clamp(model.color[0], 0, 1);
    this.selectedStarModelUniform[5] = clamp(model.color[1], 0, 1);
    this.selectedStarModelUniform[6] = clamp(model.color[2], 0, 1);
    this.selectedStarModelUniform[7] = starModelTypeIndex(model.starType ?? "sun-like-star");
    this.selectedStarModelUniform[8] = 1;
    this.selectedStarModelUniform[9] = alpha;
    this.selectedStarModelUniform[10] = this._actualBrightness ? 1 : 0;
    this.selectedStarModelUniform[11] = 0;
    this.writeSelectedStarModelUniform();
  }

  /** Upload 100k Milky Way background stars (once on catalog load). */
  uploadMilkywayStars(stars: Float32Array): void {
    this.mwStarCount = stars.length / MW_FLOATS;
    this.ctx.device.queue.writeBuffer(this.mwStarBuffer, 0, stars as GPUAllowSharedBufferSource);
  }

  updateLOD(cameraDistanceFromSun: number): void {
    this._cameraDistanceFromSun = Number.isFinite(cameraDistanceFromSun) ? Math.max(0, cameraDistanceFromSun) : 0;
    this.syncBrightnessUniforms();
  }

  uploadGalaxies(galaxies: Float32Array): void {
    this.galaxyCount = galaxies.length / GALAXY_FLOATS;
    this.ctx.device.queue.writeBuffer(this.galaxyBuffer, 0, galaxies as GPUAllowSharedBufferSource);
  }

  async loadGalaxyTextureModels(models: readonly GalaxyTextureModel[]): Promise<void> {
    const usable = models.slice(0, TEXTURED_GALAXY_MODEL_CAPACITY);
    this.galaxyModelCount = usable.length;
    const data = new Float32Array(usable.length * GALAXY_MODEL_FLOATS);

    for (let i = 0; i < usable.length; i++) {
      const model = usable[i]!;
      const o = i * GALAXY_MODEL_FLOATS;
      data[o + 0] = model.x;
      data[o + 1] = model.y;
      data[o + 2] = model.z;
      data[o + 3] = model.radiusAU;
      data[o + 4] = model.right[0];
      data[o + 5] = model.right[1];
      data[o + 6] = model.right[2];
      data[o + 7] = model.aspect;
      data[o + 8] = model.up[0];
      data[o + 9] = model.up[1];
      data[o + 10] = model.up[2];
      data[o + 11] = model.opacity;
      data[o + 12] = model.fadeNearAU;
      data[o + 13] = model.fadeFarAU;
      data[o + 14] = model.billboardFadeInNearAU;
      data[o + 15] = model.billboardFadeInFarAU;
    }

    if (data.length > 0) {
      this.ctx.device.queue.writeBuffer(this.galaxyModelBuffer, 0, data as GPUAllowSharedBufferSource);
    }

    for (const texture of this.galaxyModelTextures) texture.destroy();
    this.galaxyModelTextures = [];
    this.galaxyModelDraws = [];
    for (const entry of this.galaxyTypeModelEntries.values()) {
      entry.uniformBuffer.destroy();
      for (const part of entry.parts) {
        part.vertexBuffer.destroy();
        part.materialBuffer.destroy();
      }
    }
    this.galaxyTypeModelEntries.clear();

    for (let i = 0; i < usable.length; i++) {
      const model = usable[i]!;
      try {
        const resp = await fetch(model.textureUrl, { cache: "force-cache" });
        if (!resp.ok) {
          console.warn(`Galaxy texture fetch failed for ${model.name}: ${resp.status}`);
          continue;
        }
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });
        const width = bitmap.width;
        const height = bitmap.height;
        const texture = this.ctx.device.createTexture({
          label: `galaxy-model-${model.id}`,
          size: [width, height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        this.ctx.device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture },
          [width, height],
        );
        bitmap.close();

        const bindGroup = this.ctx.device.createBindGroup({
          label: `galaxy-model-bg-${model.id}`,
          layout: this.galaxyModelBGL,
          entries: [
            { binding: 0, resource: { buffer: this.cameraBuffer } },
            { binding: 1, resource: { buffer: this.galaxyModelBuffer } },
            { binding: 2, resource: texture.createView() },
            { binding: 3, resource: this.galaxyModelSampler },
          ],
        });
        this.galaxyModelTextures.push(texture);
        this.galaxyModelDraws.push({ bindGroup, index: i });
        this.createGalaxyTypeModelEntry(model, texture);
      } catch (e) {
        console.warn(`Failed to load galaxy texture for ${model.name}:`, e);
      }
    }

    console.info(
      `Loaded ${this.galaxyModelDraws.length} textured galaxy LOD models and ` +
      `${this.galaxyTypeModelEntries.size} morphology mesh LODs.`,
    );
  }

  uploadNebulas(nebulas: Float32Array): void {
    this.nebulaCount = nebulas.length / NEBULA_FLOATS;
    this.ctx.device.queue.writeBuffer(this.nebulaBuffer, 0, nebulas as GPUAllowSharedBufferSource);
  }

  uploadDustClouds(clouds: Float32Array): void {
    const requested = Math.floor(clouds.length / DUST_CLOUD_FLOATS);
    this.dustCloudCount = Math.min(DUST_CLOUD_CAPACITY, requested);
    if (this.dustCloudCount <= 0) return;
    const floats = this.dustCloudCount * DUST_CLOUD_FLOATS;
    const upload = clouds.length === floats ? clouds : clouds.subarray(0, floats);
    this.ctx.device.queue.writeBuffer(this.dustCloudBuffer, 0, upload as GPUAllowSharedBufferSource);
  }

  uploadHomunculus(buf: Float32Array): void {
    this.ctx.device.queue.writeBuffer(this.homunculusBuffer, 0, buf as GPUAllowSharedBufferSource);
  }

  async loadEtaCarinaTexture(url: string): Promise<void> {
    try {
      const resp   = await fetch(url, { cache: "force-cache" });
      if (!resp.ok) { console.warn(`Eta Carinae texture fetch failed: ${resp.status}`); return; }
      const blob   = await resp.blob();
      const bitmap = await createImageBitmap(blob, { colorSpaceConversion: "none" });

      const texture = this.ctx.device.createTexture({
        label:  "eta-carinae-tex",
        size:   [bitmap.width, bitmap.height],
        format: "rgba8unorm",
        usage:  GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.ctx.device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture },
        [bitmap.width, bitmap.height],
      );
      bitmap.close();

      this.homunculusTexture = texture;
      this.homunculusBindGroup = this.ctx.device.createBindGroup({
        label: "homunculus-bg",
        layout: this.homunculusBGL,
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuffer } },
          { binding: 1, resource: { buffer: this.homunculusBuffer } },
          { binding: 2, resource: texture.createView() },
          { binding: 3, resource: this.homunculusSampler },
        ],
      });
      console.info(`Eta Carinae Hubble texture loaded (${bitmap.width}×${bitmap.height})`);
    } catch (e) {
      console.warn("Failed to load Eta Carinae texture:", e);
    }
  }

  async loadSolarSystemModels(models: readonly SolarSystemModelAsset[]): Promise<void> {
    await Promise.allSettled(models.map(model => this.ensureSolarSystemModelLoaded(model)));
    const loaded = models.filter(model => this.solarSystemModelEntries.has(model.bodyName)).length;
    console.info(`Loaded ${loaded}/${models.length} solar-system 3D body models.`);
  }

  async ensureSolarSystemModelLoaded(model: SolarSystemModelAsset): Promise<void> {
    if (this.solarSystemModelEntries.has(model.bodyName) || this.solarSystemModelLoading.has(model.id)) return;
    if (this.solarSystemModelFailedAt.has(model.id)) return;
    this.solarSystemModelLoading.add(model.id);
    try {
      const mesh = model.format === "procedural-sphere"
        ? createUvSphereMesh()
        : await (async (format: ParsedModelFormat) => {
          const buffer = await fetchValidatedModelAsset(model.assetUrl, { format });
          return parseMilkyWayModel(buffer, format);
        })(model.format);
      if (mesh.vertexCount <= 0) throw new Error("empty mesh");

      const { device } = this.ctx;
      const uniformBuffer = device.createBuffer({
        label: `solar-system-model-uniform-${model.id}`,
        size: MILKY_WAY_MODEL_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const textures = mesh.textures.map((texture, index) => {
        const gpuTexture = this.createMilkyWayModelTexture(texture.bitmap, `solar-system-model-texture-${model.id}-${index}`);
        texture.bitmap.close();
        return gpuTexture;
      });
      const parts: MilkyWayModelPartEntry[] = mesh.parts.map((part, index) => {
        const vertexBuffer = device.createBuffer({
          label: `solar-system-model-vertices-${model.id}-${index}`,
          size: part.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, part.vertices as GPUAllowSharedBufferSource);
        const materialBuffer = this.createSolarSystemModelMaterialBuffer(model, part.material, index);
        const texture = part.material.textureIndex >= 0
          ? textures[part.material.textureIndex] ?? this.milkyWayModelWhiteTexture
          : this.milkyWayModelWhiteTexture;
        return {
          vertexBuffer,
          materialBuffer,
          bindGroup: device.createBindGroup({
            label: `solar-system-model-bg-${model.id}-${index}`,
            layout: this.milkyWayModelBGL,
            entries: [
              { binding: 0, resource: { buffer: this.cameraBuffer } },
              { binding: 1, resource: { buffer: uniformBuffer } },
              { binding: 2, resource: { buffer: materialBuffer } },
              { binding: 3, resource: texture.createView() },
              { binding: 4, resource: this.milkyWayModelSampler },
            ],
          }),
          vertexCount: part.vertexCount,
        };
      });

      this.solarSystemModelEntries.set(model.bodyName, {
        id: model.id,
        bodyName: model.bodyName,
        emissive: model.emissive ?? 0,
        fallbackColor: model.fallbackColor,
        uniformBuffer,
        parts,
        textures,
        vertexCount: mesh.vertexCount,
      });
      console.info(
        `Loaded ${model.bodyName} solar-system model: ${mesh.usedTriangleCount.toLocaleString()} / ${mesh.sourceTriangleCount.toLocaleString()} triangles.`,
      );
    } catch (e) {
      this.solarSystemModelFailedAt.set(model.id, Date.now());
      if (e instanceof BackendUnavailableError) return;
      console.warn(`Failed to load solar-system model ${model.bodyName}:`, e);
      throw e;
    } finally {
      this.solarSystemModelLoading.delete(model.id);
    }
  }

  ensureVisibleMilkyWayModels(models: readonly MilkyWayModelObject[], eye: readonly [number, number, number]): void {
    if (Date.now() < this.milkyWayModelBackendRetryAt) return;
    this.pruneMilkyWayModelFailures();
    if (this.activeMilkyWayModelId) {
      const activeModel = models.find(model => model.id === this.activeMilkyWayModelId);
      if (activeModel && !this.milkyWayModelFailedAt.has(activeModel.id)) {
        const activeDist = Math.hypot(eye[0] - activeModel.x, eye[1] - activeModel.y, eye[2] - activeModel.z);
        if (activeDist <= activeModel.loadDistanceAU * 1.25) {
          void this.ensureMilkyWayModelLoaded(activeModel);
          return;
        }
      }
    }

    const unavailableGroups = new Set<string>();
    for (const entry of this.milkyWayModelEntries.values()) unavailableGroups.add(entry.modelGroup);
    for (const loadingId of this.milkyWayModelLoading) {
      const loadingModel = models.find(model => model.id === loadingId);
      if (loadingModel) unavailableGroups.add(loadingModel.modelGroup);
    }
    for (const failedId of this.milkyWayModelFailedAt.keys()) {
      const failedModel = models.find(model => model.id === failedId);
      if (failedModel) unavailableGroups.add(failedModel.modelGroup);
    }

    let started = 0;
    for (const model of models) {
      if (unavailableGroups.has(model.modelGroup)) continue;
      if (this.milkyWayModelEntries.has(model.id) || this.milkyWayModelLoading.has(model.id)) continue;
      const dist = Math.hypot(eye[0] - model.x, eye[1] - model.y, eye[2] - model.z);
      if (dist <= model.loadDistanceAU) {
        void this.ensureMilkyWayModelLoaded(model);
        started++;
        if (started >= 1) return;
      }
    }
  }

  async ensureMilkyWayModelLoaded(model: MilkyWayModelObject): Promise<void> {
    if (this.milkyWayModelEntries.has(model.id) || this.milkyWayModelLoading.has(model.id)) return;
    if (this.milkyWayModelFailedAt.has(model.id)) return;
    this.milkyWayModelLoading.add(model.id);
    try {
      const buffer = await fetchValidatedModelAsset(model.assetUrl, model);
      const mesh = await parseMilkyWayModel(buffer, model.format);
      if (mesh.vertexCount <= 0) throw new Error("empty mesh");

      const { device } = this.ctx;
      const uniformBuffer = device.createBuffer({
        label: `milky-way-model-uniform-${model.id}`,
        size: MILKY_WAY_MODEL_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const textures = mesh.textures.map((texture, index) => {
        const gpuTexture = this.createMilkyWayModelTexture(texture.bitmap, `milky-way-model-texture-${model.id}-${index}`);
        texture.bitmap.close();
        return gpuTexture;
      });
      const externalTextureIndex = await this.loadExternalMilkyWayModelTexture(model, textures);
      const parts: MilkyWayModelPartEntry[] = mesh.parts.map((part, index) => {
        const vertexBuffer = device.createBuffer({
          label: `milky-way-model-vertices-${model.id}-${index}`,
          size: part.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, part.vertices as GPUAllowSharedBufferSource);
        const material = this.materialWithExternalTexture(part.material, externalTextureIndex);
        const materialBuffer = this.createMilkyWayModelMaterialBuffer(model, material, index);
        const texture = material.textureIndex >= 0
          ? textures[material.textureIndex] ?? this.milkyWayModelWhiteTexture
          : this.milkyWayModelWhiteTexture;
        return {
          vertexBuffer,
          materialBuffer,
          bindGroup: device.createBindGroup({
            label: `milky-way-model-bg-${model.id}-${index}`,
            layout: this.milkyWayModelBGL,
            entries: [
              { binding: 0, resource: { buffer: this.cameraBuffer } },
              { binding: 1, resource: { buffer: uniformBuffer } },
              { binding: 2, resource: { buffer: materialBuffer } },
              { binding: 3, resource: texture.createView() },
              { binding: 4, resource: this.milkyWayModelSampler },
            ],
          }),
          vertexCount: part.vertexCount,
        };
      });
      const entry: MilkyWayModelEntry = {
        id: model.id,
        modelGroup: model.modelGroup,
        uniformBuffer,
        parts,
        textures,
        vertexCount: mesh.vertexCount,
      };
      this.writeMilkyWayModelUniform(entry, model);
      this.milkyWayModelEntries.set(model.id, entry);
      console.info(
        `Loaded ${model.name} 3D model: ${mesh.usedTriangleCount.toLocaleString()} / ${mesh.sourceTriangleCount.toLocaleString()} triangles.`,
      );
    } catch (e) {
      this.milkyWayModelFailedAt.set(model.id, Date.now());
      if (e instanceof BackendUnavailableError) {
        this.milkyWayModelBackendRetryAt = Date.now() + MILKY_WAY_MODEL_BACKEND_RETRY_MS;
        return;
      }
      console.warn(`Failed to load Milky Way model ${model.name}:`, e);
    } finally {
      this.milkyWayModelLoading.delete(model.id);
    }
  }

  private async loadExternalMilkyWayModelTexture(
    model: MilkyWayModelObject,
    textures: GPUTexture[],
  ): Promise<number> {
    if (!model.textureUrl) return -1;
    try {
      const resp = await fetch(model.textureUrl, { cache: "force-cache" });
      if (!resp.ok) throw new Error(`texture ${resp.status}`);
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      const texture = this.createMilkyWayModelTexture(bitmap, `milky-way-model-external-texture-${model.id}`);
      bitmap.close();
      const index = textures.length;
      textures.push(texture);
      return index;
    } catch (e) {
      console.warn(`Failed to load Milky Way model texture for ${model.name}:`, e);
      return -1;
    }
  }

  private materialWithExternalTexture(
    material: ParsedMilkyWayMaterial,
    textureIndex: number,
  ): ParsedMilkyWayMaterial {
    if (textureIndex < 0 || material.useTexture > 0.5) return material;
    return {
      ...material,
      baseColor: [1, 1, 1, material.baseColor[3]],
      textureIndex,
      useTexture: 1,
      useProcedural: Math.min(material.useProcedural, 0.12),
      textureEmission: 0.85,
    };
  }

  private createMilkyWayModelTexture(bitmap: ImageBitmap, label: string): GPUTexture {
    const { device } = this.ctx;
    const texture = device.createTexture({
      label,
      size: [Math.max(1, bitmap.width), Math.max(1, bitmap.height), 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture },
      [Math.max(1, bitmap.width), Math.max(1, bitmap.height), 1],
    );
    return texture;
  }

  private createGalaxyTypeModelEntry(model: GalaxyTextureModel, texture: GPUTexture): void {
    const mesh = buildGalaxyTypeMesh(model);
    if (mesh.vertexCount <= 0) return;

    const { device } = this.ctx;
    const uniformBuffer = device.createBuffer({
      label: `galaxy-type-model-uniform-${model.id}`,
      size: MILKY_WAY_MODEL_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const vertexBuffer = device.createBuffer({
      label: `galaxy-type-model-vertices-${model.id}`,
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, mesh.vertices as GPUAllowSharedBufferSource);

    const materialBuffer = this.createGalaxyTypeModelMaterialBuffer(model);
    const bindGroup = device.createBindGroup({
      label: `galaxy-type-model-bg-${model.id}`,
      layout: this.milkyWayModelBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: uniformBuffer } },
        { binding: 2, resource: { buffer: materialBuffer } },
        { binding: 3, resource: texture.createView() },
        { binding: 4, resource: this.milkyWayModelSampler },
      ],
    });

    const entry: GalaxyTypeModelEntry = {
      id: model.id,
      morphology: model.morphology,
      uniformBuffer,
      vertexCount: mesh.vertexCount,
      parts: [{
        vertexBuffer,
        materialBuffer,
        bindGroup,
        vertexCount: mesh.vertexCount,
      }],
    };
    this.galaxyTypeModelEntries.set(model.id, entry);
    this.writeGalaxyTypeModelUniform(entry, model);
  }

  private createGalaxyTypeModelMaterialBuffer(model: GalaxyTextureModel): GPUBuffer {
    const { device } = this.ctx;
    const buffer = device.createBuffer({
      label: `galaxy-type-model-material-${model.id}`,
      size: MILKY_WAY_MODEL_MATERIAL_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const data = new Float32Array(MILKY_WAY_MODEL_MATERIAL_BYTES / 4);
    data[0] = 1;
    data[1] = 1;
    data[2] = 1;
    data[3] = 1;
    data[4] = model.morphology === "edge-on-starburst" ? 0.15 : 0.06;
    data[5] = model.morphology === "irregular" ? 0.09 : 0.07;
    data[6] = model.morphology === "spiral" || model.morphology === "interacting" ? 0.12 : 0.06;
    data[7] = 0.28;
    data[8] = 1;
    data[9] = 0.08;
    data[10] = 1;
    data[11] = 0.42;
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private createMilkyWayModelMaterialBuffer(
    model: MilkyWayModelObject,
    material: ParsedMilkyWayMaterial,
    partIndex: number,
  ): GPUBuffer {
    const { device } = this.ctx;
    const buffer = device.createBuffer({
      label: `milky-way-model-material-${model.id}-${partIndex}`,
      size: MILKY_WAY_MODEL_MATERIAL_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const baseColor: [number, number, number, number] = material.useProcedural > 0.5
      ? [
        model.color[0] ?? material.baseColor[0],
        model.color[1] ?? material.baseColor[1],
        model.color[2] ?? material.baseColor[2],
        material.baseColor[3],
      ]
      : material.baseColor;
    const data = new Float32Array(MILKY_WAY_MODEL_MATERIAL_BYTES / 4);
    data[0] = baseColor[0];
    data[1] = baseColor[1];
    data[2] = baseColor[2];
    data[3] = baseColor[3];
    data[4] = material.emissive[0];
    data[5] = material.emissive[1];
    data[6] = material.emissive[2];
    data[7] = material.emissive[3];
    data[8] = material.useTexture;
    data[9] = material.useProcedural;
    data[10] = material.useVertexColor;
    data[11] = material.textureEmission;
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private createSolarSystemModelMaterialBuffer(
    model: SolarSystemModelAsset,
    material: ParsedMilkyWayMaterial,
    partIndex: number,
  ): GPUBuffer {
    const { device } = this.ctx;
    const buffer = device.createBuffer({
      label: `solar-system-model-material-${model.id}-${partIndex}`,
      size: MILKY_WAY_MODEL_MATERIAL_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const baseColor = material.baseColor;
    const data = new Float32Array(MILKY_WAY_MODEL_MATERIAL_BYTES / 4);
    data[0] = baseColor[0];
    data[1] = baseColor[1];
    data[2] = baseColor[2];
    data[3] = baseColor[3];
    data[4] = material.emissive[0];
    data[5] = material.emissive[1];
    data[6] = material.emissive[2];
    data[7] = Math.max(material.emissive[3], model.emissive ?? 0);
    data[8] = material.useTexture;
    data[9] = material.useProcedural;
    data[10] = material.useVertexColor;
    data[11] = material.textureEmission;
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private updateSolarSystemModelUniforms(bodies: readonly Body[]): void {
    if (this.solarSystemModelEntries.size <= 0) return;
    const byName = new Map<string, Body>();
    for (const body of bodies) byName.set(body.name, body);
    const sun = byName.get("Sun");

    for (const entry of this.solarSystemModelEntries.values()) {
      const body = byName.get(entry.bodyName);
      if (!body) continue;
      let lx = 1;
      let ly = 0;
      let lz = 0;
      if (sun && entry.bodyName !== "Sun") {
        lx = sun.x - body.x;
        ly = sun.y - body.y;
        lz = sun.z - body.z;
        const len = Math.hypot(lx, ly, lz) || 1;
        lx /= len; ly /= len; lz /= len;
      }
      const data = new Float32Array(MILKY_WAY_MODEL_UNIFORM_BYTES / 4);
      data[0] = body.x;
      data[1] = body.y;
      data[2] = body.z;
      data[3] = body.radius;
      data[4] = lx;
      data[5] = ly;
      data[6] = lz;
      data[7] = entry.bodyName === "Sun" ? 1 : 0;
      data[8] = entry.fallbackColor[0];
      data[9] = entry.fallbackColor[1];
      data[10] = entry.fallbackColor[2];
      data[11] = 1;
      data[12] = entry.emissive;
      this.ctx.device.queue.writeBuffer(entry.uniformBuffer, 0, data);
    }
  }

  private pruneMilkyWayModelFailures(): void {
    const now = Date.now();
    for (const [id, failedAt] of this.milkyWayModelFailedAt) {
      if (now - failedAt >= MILKY_WAY_MODEL_RETRY_MS) {
        this.milkyWayModelFailedAt.delete(id);
      }
    }
  }

  private writeSelectedStarModelUniform(): void {
    if (!this.selectedStarModelBuffer) return;
    this.selectedStarModelUniform[10] = this._actualBrightness ? 1 : 0;
    this.ctx.device.queue.writeBuffer(this.selectedStarModelBuffer, 0, this.selectedStarModelUniform);
  }

  private writeDustUniform(): void {
    if (!this.dustUniformBuffer) return;
    const data = new Float32Array(DUST_CLOUD_UNIFORM_BYTES / 4);
    data[0] = this.dustOpacity();
    data[1] = 1;
    data[2] = this._dustTransparency;
    data[3] = 0;
    this.ctx.device.queue.writeBuffer(this.dustUniformBuffer, 0, data);
  }

  updateBlackHoleVisual(
    position: [number, number, number],
    eventHorizonRadiusAU: number,
    timeSeconds: number,
    viewportWidth: number,
    viewportHeight: number,
    lensStrength = 1,
  ): void {
    this._blackHoleUniform[0] = position[0];
    this._blackHoleUniform[1] = position[1];
    this._blackHoleUniform[2] = position[2];
    this._blackHoleUniform[3] = Math.max(0, eventHorizonRadiusAU);
    this._blackHoleUniform[4] = Number.isFinite(timeSeconds) ? timeSeconds : 0;
    this._blackHoleUniform[5] = Math.max(1, viewportWidth);
    this._blackHoleUniform[6] = Math.max(1, viewportHeight);
    this._blackHoleUniform[7] = Math.max(0, lensStrength);
    this.ctx.device.queue.writeBuffer(this.blackHoleBuffer, 0, this._blackHoleUniform);
  }

  uploadConstellations(lines: Float32Array): void {
    if (lines.length % CONSTELLATION_FLOATS !== 0) {
      throw new Error("Constellation buffer length must be a multiple of CONSTELLATION_FLOATS.");
    }

    this.constellationCount = lines.length / CONSTELLATION_FLOATS;
    this.ensureConstellationCapacity(this.constellationCount);
    if (lines.length > 0) {
      this.ctx.device.queue.writeBuffer(this.constellationBuffer, 0, lines as GPUAllowSharedBufferSource);
    }
  }

  uploadStars(stars: Float32Array): void {
    if (stars.length % STAR_FLOATS !== 0) {
      throw new Error("Star buffer length must be a multiple of STAR_FLOATS.");
    }

    this.starCount = stars.length / STAR_FLOATS;
    this.ensureStarCapacity(this.starCount);
    this.ctx.device.queue.writeBuffer(this.starBuffer, 0, stars as GPUAllowSharedBufferSource);
  }

  uploadBodies(bodies: Body[], visibility: ReadonlyMap<number, number> = new Map()): void {
    this.bodyCount = bodies.length;
    const data = new Float32Array(bodies.length * BODY_FLOATS);
    const cam = this.cameraUniforms;
    const right = cam?.camRight;
    const up = cam?.camUp;
    const eye = cam?.eye;
    const back: [number, number, number] | null = right && up
      ? [
          right[1] * up[2] - right[2] * up[1],
          right[2] * up[0] - right[0] * up[2],
          right[0] * up[1] - right[1] * up[0],
        ]
      : null;
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      const o = i * BODY_FLOATS;
      const brightness = this.bodyBrightnessFactor();
      let x = b.x;
      let y = b.y;
      let z = b.z;
      if (right && up && eye && back) {
        const rx = b.x - eye[0];
        const ry = b.y - eye[1];
        const rz = b.z - eye[2];
        x = dot3(rx, ry, rz, right[0], right[1], right[2]);
        y = dot3(rx, ry, rz, up[0], up[1], up[2]);
        z = dot3(rx, ry, rz, back[0], back[1], back[2]);
      }
      // vec4 pos_mass
      data[o+0]=x;    data[o+1]=y;    data[o+2]=z;    data[o+3]=b.mass;
      // vec4 vel_rad
      data[o+4]=b.vx; data[o+5]=b.vy; data[o+6]=b.vz; data[o+7]=b.radius;
      // vec4 acc_type (x=brightness; y=reference observer distance AU; z=render visibility; w=type)
      data[o+8]=brightness.display; data[o+9]=brightness.observerDistanceAU; data[o+10]=visibility.get(b.id) ?? 1; data[o+11]=b.type;
      if (this.solarSystemModelEntries.has(b.name)) data[o+10] = 0;
      // vec4 col_id
      data[o+12]=b.color[0]; data[o+13]=b.color[1]; data[o+14]=b.color[2]; data[o+15]=b.id;
    }
    this.ctx.device.queue.writeBuffer(this.bodyBuffer, 0, data);
    this.updateSolarSystemModelUniforms(bodies);
  }

  private bodyBrightnessFactor(): BodyBrightnessSample {
    // Keep physical body volumes authoritative. The old apparent-brightness
    // mode inflated quads and halos; the setting now only gates HDR/bloom
    // presentation for star fields.
    return { display: 1, observerDistanceAU: 0 };
  }

  private syncBrightnessUniforms(): void {
    if (!this.starLodBuffer || !this.mwLodBuffer || !this.galaxyLodBuffer) return;
    const brightnessEffects = this._actualBrightness ? 1 : 0;
    const legacyApparentBoost = 0;

    // MW individual stars disappear when camera > 400 kpc (3 200 000 AU).
    // Transition: fully visible at 360 kpc → invisible at 400 kpc.
    const camKpc     = this._cameraDistanceFromSun / 8_000;
    const mwStarFade = Math.max(0, Math.min(1, (400 - camKpc) / 40));

    // MW self (single galaxy blob) fades IN as individual stars fade OUT.
    // Visible from 360 kpc, full brightness by 440 kpc. Max alpha 0.55.
    this._mwSelfAlpha = Math.max(0, Math.min(0.55, (camKpc - 360) / 80)) * (this._showGalaxies ? 1 : 0);

    this.ctx.device.queue.writeBuffer(this.starLodBuffer, 0, new Float32Array([1, this._cameraDistanceFromSun, brightnessEffects, 0]));
    this.ctx.device.queue.writeBuffer(this.mwLodBuffer,  0, new Float32Array([mwStarFade, legacyApparentBoost, brightnessEffects, 0]));
    this.ctx.device.queue.writeBuffer(this.galaxyLodBuffer, 0, new Float32Array([legacyApparentBoost, brightnessEffects, 0, 0]));

    // Update MW self billboard: centred on Sgr A* (galactic centre) not the Sun.
    // The Sun is 8.5 kpc from the galactic centre; placing the blob at the
    // galactic centre gives the correct visual anchor for the whole galaxy.
    // Position = R_gal_to_ecl × (8.5 kpc, 0, 0) × 8000 AU/kpc ≈ (-3 732, -67 586, -6 555) AU
    if (this.mwSelfBuffer) {
      this.ctx.device.queue.writeBuffer(
        this.mwSelfBuffer, 0,
        new Float32Array([-3732, -67586, -6555, 5.0, 1.0, 0.90, 0.70, this._mwSelfAlpha]),
      );
    }
  }

  private ensureStarCapacity(count: number): void {
    if (count <= this.starCapacity) return;

    const { device } = this.ctx;
    this.starCapacity = Math.ceil(count * 1.15);
    this.starBuffer.destroy();
    this.starBuffer = device.createBuffer({
      label: "catalog-star-storage",
      size: this.starCapacity * STAR_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.starBindGroup = device.createBindGroup({
      label: "catalog-star-bg", layout: this.starBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.starBuffer } },
        { binding: 2, resource: { buffer: this.selectedStarBuffer } },
        { binding: 3, resource: { buffer: this.starLodBuffer } },
      ],
    });
  }

  private writeMilkyWayModelUniform(entry: MilkyWayModelEntry, model: MilkyWayModelObject): void {
    const data = new Float32Array(MILKY_WAY_MODEL_UNIFORM_BYTES / 4);
    data[0] = model.x;
    data[1] = model.y;
    data[2] = model.z;
    data[3] = model.radiusAU;
    data[4] = model.fadeNearAU;
    data[5] = model.fadeFarAU;
    data[6] = model.opacity;
    data[7] = 0;
    data[8] = model.color[0];
    data[9] = model.color[1];
    data[10] = model.color[2];
    data[11] = 0;
    this.ctx.device.queue.writeBuffer(entry.uniformBuffer, 0, data);
  }

  private writeGalaxyTypeModelUniform(entry: GalaxyTypeModelEntry, model: GalaxyTextureModel): void {
    const color: [number, number, number] = model.morphology === "irregular"
      ? [0.55, 0.70, 1.0]
      : model.morphology === "edge-on-starburst"
        ? [1.0, 0.58, 0.34]
        : model.morphology === "elliptical" || model.morphology === "lenticular"
          ? [1.0, 0.82, 0.56]
          : [0.72, 0.82, 1.0];
    const data = new Float32Array(MILKY_WAY_MODEL_UNIFORM_BYTES / 4);
    data[0] = model.x;
    data[1] = model.y;
    data[2] = model.z;
    data[3] = model.meshRadiusAU;
    data[4] = model.meshFadeNearAU;
    data[5] = model.meshFadeFarAU;
    data[6] = model.meshOpacity;
    data[7] = 0;
    data[8] = color[0];
    data[9] = color[1];
    data[10] = color[2];
    data[11] = 0;
    this.ctx.device.queue.writeBuffer(entry.uniformBuffer, 0, data);
  }

  private dustOpacity(): number {
    return clamp(1 - this._dustTransparency, 0, 1);
  }

  private ensureSceneTexture(): void {
    const width = Math.max(1, Math.floor(this._blackHoleUniform[5] ?? 1));
    const height = Math.max(1, Math.floor(this._blackHoleUniform[6] ?? 1));
    if (
      this.sceneTexture &&
      this.sceneTextureView &&
      this.sceneTextureWidth === width &&
      this.sceneTextureHeight === height
    ) return;

    this.sceneTexture?.destroy();
    const { device } = this.ctx;
    this.sceneTextureWidth = width;
    this.sceneTextureHeight = height;
    this.sceneTexture = device.createTexture({
      label: "hdr-scene-color",
      size: { width, height },
      format: SCENE_COLOR_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sceneTextureView = this.sceneTexture.createView();
    this.bloomExtractBindGroup = null;
    this.blackHoleBindGroup = null;
  }

  private ensureBloomTextures(): void {
    if (!this.sceneTextureView) {
      throw new Error("HDR scene texture must exist before bloom textures");
    }

    const width = Math.max(1, Math.ceil(this.sceneTextureWidth / BLOOM_SCALE));
    const height = Math.max(1, Math.ceil(this.sceneTextureHeight / BLOOM_SCALE));
    const resized =
      !this.bloomExtractTexture ||
      !this.bloomExtractTextureView ||
      !this.bloomPingTexture ||
      !this.bloomPingTextureView ||
      !this.bloomPongTexture ||
      !this.bloomPongTextureView ||
      this.bloomWidth !== width ||
      this.bloomHeight !== height;

    const { device } = this.ctx;
    if (resized) {
      this.bloomExtractTexture?.destroy();
      this.bloomPingTexture?.destroy();
      this.bloomPongTexture?.destroy();
      this.bloomWidth = width;
      this.bloomHeight = height;

      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      this.bloomExtractTexture = device.createTexture({
        label: "hdr-bloom-extract",
        size: { width, height },
        format: SCENE_COLOR_FORMAT,
        usage,
      });
      this.bloomPingTexture = device.createTexture({
        label: "hdr-bloom-ping",
        size: { width, height },
        format: SCENE_COLOR_FORMAT,
        usage,
      });
      this.bloomPongTexture = device.createTexture({
        label: "hdr-bloom-pong",
        size: { width, height },
        format: SCENE_COLOR_FORMAT,
        usage,
      });
      this.bloomExtractTextureView = this.bloomExtractTexture.createView();
      this.bloomPingTextureView = this.bloomPingTexture.createView();
      this.bloomPongTextureView = this.bloomPongTexture.createView();

      device.queue.writeBuffer(this.bloomBlurHBuffer, 0, new Float32Array([1 / width, 0, 0, 0]));
      device.queue.writeBuffer(this.bloomBlurVBuffer, 0, new Float32Array([0, 1 / height, 0, 0]));
      this.bloomExtractBindGroup = null;
      this.bloomBlurHBindGroup = null;
      this.bloomBlurVBindGroup = null;
      this.blackHoleBindGroup = null;
    }

    if (!this.bloomExtractTextureView || !this.bloomPingTextureView || !this.bloomPongTextureView) {
      throw new Error("HDR bloom textures were not created");
    }
    if (!this.bloomExtractBindGroup) {
      this.bloomExtractBindGroup = device.createBindGroup({
        label: "hdr-bloom-extract-bg",
        layout: this.bloomExtractBGL,
        entries: [
          { binding: 0, resource: this.sceneTextureView },
          { binding: 1, resource: this.bloomSampler },
        ],
      });
    }
    if (!this.bloomBlurHBindGroup) {
      this.bloomBlurHBindGroup = device.createBindGroup({
        label: "hdr-bloom-blur-horizontal-bg",
        layout: this.bloomBlurBGL,
        entries: [
          { binding: 0, resource: this.bloomExtractTextureView },
          { binding: 1, resource: this.bloomSampler },
          { binding: 2, resource: { buffer: this.bloomBlurHBuffer } },
        ],
      });
    }
    if (!this.bloomBlurVBindGroup) {
      this.bloomBlurVBindGroup = device.createBindGroup({
        label: "hdr-bloom-blur-vertical-bg",
        layout: this.bloomBlurBGL,
        entries: [
          { binding: 0, resource: this.bloomPingTextureView },
          { binding: 1, resource: this.bloomSampler },
          { binding: 2, resource: { buffer: this.bloomBlurVBuffer } },
        ],
      });
    }
    if (!this.blackHoleBindGroup) {
      this.blackHoleBindGroup = device.createBindGroup({
        label: "black-hole-bg",
        layout: this.blackHoleBGL,
        entries: [
          { binding: 0, resource: { buffer: this.cameraBuffer } },
          { binding: 1, resource: { buffer: this.blackHoleBuffer } },
          { binding: 2, resource: this.sceneTextureView },
          { binding: 3, resource: this.sceneSampler },
          { binding: 4, resource: this.bloomPongTextureView },
          { binding: 5, resource: this.bloomSampler },
        ],
      });
    }
  }

  private runBloomPasses(encoder: GPUCommandEncoder): void {
    if (
      !this.bloomExtractTextureView ||
      !this.bloomPingTextureView ||
      !this.bloomPongTextureView ||
      !this.bloomExtractBindGroup ||
      !this.bloomBlurHBindGroup ||
      !this.bloomBlurVBindGroup
    ) return;

    const extractPass = encoder.beginRenderPass({
      label: "hdr-bloom-extract-pass",
      colorAttachments: [{
        view: this.bloomExtractTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    extractPass.setPipeline(this.bloomExtractPipeline);
    extractPass.setBindGroup(0, this.bloomExtractBindGroup);
    extractPass.draw(6, 1, 0, 0);
    extractPass.end();

    const blurHPass = encoder.beginRenderPass({
      label: "hdr-bloom-blur-horizontal-pass",
      colorAttachments: [{
        view: this.bloomPingTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    blurHPass.setPipeline(this.bloomBlurPipeline);
    blurHPass.setBindGroup(0, this.bloomBlurHBindGroup);
    blurHPass.draw(6, 1, 0, 0);
    blurHPass.end();

    const blurVPass = encoder.beginRenderPass({
      label: "hdr-bloom-blur-vertical-pass",
      colorAttachments: [{
        view: this.bloomPongTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    blurVPass.setPipeline(this.bloomBlurPipeline);
    blurVPass.setBindGroup(0, this.bloomBlurVBindGroup);
    blurVPass.draw(6, 1, 0, 0);
    blurVPass.end();
  }

  private clearBloomPass(encoder: GPUCommandEncoder): void {
    if (!this.bloomPongTextureView) return;
    const pass = encoder.beginRenderPass({
      label: "hdr-bloom-clear-pass",
      colorAttachments: [{
        view: this.bloomPongTextureView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.end();
  }

  private ensureDepthTexture(): GPUTextureView {
    const width = Math.max(1, Math.floor(this.viewportWidth));
    const height = Math.max(1, Math.floor(this.viewportHeight));
    if (
      this.depthTexture &&
      this.depthTextureView &&
      this.depthTextureWidth === width &&
      this.depthTextureHeight === height
    ) return this.depthTextureView;

    this.depthTexture?.destroy();
    const { device } = this.ctx;
    this.depthTextureWidth = width;
    this.depthTextureHeight = height;
    this.depthTexture = device.createTexture({
      label: "milky-way-model-depth",
      size: { width, height },
      format: MODEL_DEPTH_FORMAT,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.depthTextureView = this.depthTexture.createView();
    return this.depthTextureView;
  }

  private ensureConstellationCapacity(count: number): void {
    if (count <= this.constellationCapacity) return;

    const { device } = this.ctx;
    this.constellationCapacity = Math.ceil(count * 1.15);
    this.constellationBuffer.destroy();
    this.constellationBuffer = device.createBuffer({
      label: "constellation-lines",
      size: this.constellationCapacity * CONSTELLATION_FLOATS * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  updateCamera(uniforms: CameraUniforms, canvasWidth: number, canvasHeight: number): void {
    const MIN_PX = 2.5;
    const minNDCRadius = (MIN_PX * 2) / canvasHeight;
    this.viewportWidth = Math.max(1, canvasWidth);
    this.viewportHeight = Math.max(1, canvasHeight);
    this.cameraUniforms = uniforms;

    // 144-byte layout:
    //   [0–63]  viewProj (mat4x4, 16 floats)
    //   [64–79] rightAndMNR (vec4: right.xyz, minNDCRadius)
    //   [80–95] upAndFocal  (vec4: up.xyz,    focalY)
    //   [96–111] eyeAndFlags (vec4: camera eye xyz, object brightness)
    //   [112–127] screenAndTarget (vec4: aspect, target.xyz)
    //   [128–143] eyeOffset (vec4: eye-target xyz, unused)
    const data = new Float32Array(CAMERA_BYTES / 4);
    const aspect = this.viewportWidth / this.viewportHeight;
    data.set(uniforms.viewProj, 0);
    data[16] = uniforms.camRight[0]; data[17] = uniforms.camRight[1]; data[18] = uniforms.camRight[2];
    data[19] = minNDCRadius;
    data[20] = uniforms.camUp[0];    data[21] = uniforms.camUp[1];    data[22] = uniforms.camUp[2];
    data[23] = uniforms.focalY;
    data[24] = uniforms.eye[0];      data[25] = uniforms.eye[1];      data[26] = uniforms.eye[2];
    data[27] = this._objectBrightness;
    data[28] = aspect;                 data[29] = uniforms.target[0];    data[30] = uniforms.target[1];    data[31] = uniforms.target[2];
    data[32] = uniforms.eyeOffset[0];  data[33] = uniforms.eyeOffset[1]; data[34] = uniforms.eyeOffset[2];
    this._blackHoleUniform[8] = clamp(uniforms.flightSpaceWarp ?? uniforms.flightEffect, 0, 1);
    this._blackHoleUniform[9] = clamp(uniforms.flightMotionBlur ?? uniforms.flightEffect, 0, 1);
    this.ctx.device.queue.writeBuffer(this.cameraBuffer, 0, data);

    const bodyData = new Float32Array(CAMERA_BYTES / 4);
    bodyData.set(projectionOnlyMatrix(uniforms.focalY, aspect), 0);
    bodyData[16] = 1; bodyData[17] = 0; bodyData[18] = 0;
    bodyData[19] = minNDCRadius;
    bodyData[20] = 0; bodyData[21] = 1; bodyData[22] = 0;
    bodyData[23] = uniforms.focalY;
    bodyData[24] = 0; bodyData[25] = 0; bodyData[26] = 0;
    bodyData[27] = this._objectBrightness;
    bodyData[28] = aspect;
    this.ctx.device.queue.writeBuffer(this.bodyCameraBuffer, 0, bodyData);

    this.ctx.device.queue.writeBuffer(this.trailScreenBuffer, 0, new Float32Array([
      2 / this.viewportWidth,
      2 / this.viewportHeight,
      TRAIL_THICKNESS_PX,
      0,
    ]));
    this.writeDustUniform();
  }

  draw(trails: TrailSystem): void {
    const { device } = this.ctx;
    const swapView = this.canvasCtx.getCurrentTexture().createView();

    const encoder = device.createCommandEncoder({ label: "frame" });
    const uploadTrails = (): void => {
      if (!this._showTrails) return;
      for (const bodyId of trails.bodyIds) {
        if (!trails.isDirty(bodyId)) continue;

        if (!this.trailSlot.has(bodyId)) {
          if (this.trailSlotCount >= TRAIL_MAX_BODIES) continue;
          this.trailSlot.set(bodyId, this.trailSlotCount++);
        }

        const verts = trails.buildVertices(bodyId);
        trails.clearDirty(bodyId);
        if (!verts || verts.length < 2 * TRAIL_VTXFLOATS) continue;

        const slot = this.trailSlot.get(bodyId)!;
        const byteOffset = slot * TRAIL_SLOT_BYTES;
        device.queue.writeBuffer(this.trailVertexBuffer, byteOffset, verts as GPUAllowSharedBufferSource);
        this.trailDrawCount.set(bodyId, verts.length / TRAIL_VTXFLOATS);
      }
    };
    const drawTrails = (pass: GPURenderPassEncoder): void => {
      if (!this._showTrails) return;
      pass.setPipeline(this.trailPipeline);
      pass.setBindGroup(0, this.trailBindGroup);
      for (const bodyId of trails.bodyIds) {
        const slot = this.trailSlot.get(bodyId);
        const count = this.trailDrawCount.get(bodyId) ?? 0;
        if (slot === undefined || count < 2) continue;
        pass.setVertexBuffer(0, this.trailVertexBuffer, slot * TRAIL_SLOT_BYTES, count * TRAIL_VTXFLOATS * 4);
        pass.draw(count, TRAIL_THICKNESS_INSTANCES);
      }
    };
    const drawScene = (view: GPUTextureView): void => {
      const depthView = this.ensureDepthTexture();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view,
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          loadOp: "clear", storeOp: "store",
        }],
        depthStencilAttachment: {
          view: depthView,
          depthClearValue: 1,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      });

      // Helper: draw all octants of a catalog, or fall back to full draw.
      // Per-instance WGSL culling is deliberately used for frustum rejection;
      // a whole-octant CPU mask can cut off visible Milky Way or galaxy regions.
      const drawOctants = (
        octants: OctantRange[] | null,
        limit:   number,
        fullCount: number,
        drawFull: () => void,
      ) => {
        const cap = Math.min(fullCount, limit);
        if (cap <= 0) return;
        if (!octants) { drawFull(); return; }
        // Proportion of each octant to draw (for Settings-based LOD limits).
        // Each octant is scaled equally — avoids the "cap - first" cutoff bug
        // that zeroed out octants with high buffer indices.
        const ratio = fullCount > 0 ? cap / fullCount : 1;
        for (let q = 0; q < 8; q++) {
          const oct = octants[q]!;
          if (oct.count <= 0) continue;
          const count = Math.max(1, Math.round(oct.count * ratio));
          pass.draw(6, count, 0, oct.first);
        }
      };

    // ── Galaxies (furthest layer) ──────────────────────────────────────────
    if (this._showGalaxies) {
      pass.setPipeline(this.galaxyPipeline);
      pass.setBindGroup(0, this.galaxyBindGroup);
      drawOctants(
        this.galaxyOctants, this._galaxyLimit, this.galaxyCount,
        () => pass.draw(6, Math.min(this.galaxyCount, this._galaxyLimit), 0, 0),
      );

      // ── Milky Way as a single galaxy blob (shown when > 10 kpc from origin) ─
      // Individual MW background stars fade out at 10 kpc; this single billboard
      // fades in simultaneously so the Milky Way remains visible as one point.
      if (this._mwSelfAlpha > 0.001) {
        pass.setBindGroup(0, this.mwSelfBindGroup);
        pass.draw(6, 1, 0, 0);
      }

      if (this.galaxyModelCount > 0 && this.galaxyModelDraws.length > 0) {
        pass.setPipeline(this.galaxyTexturedPipeline);
        for (const draw of this.galaxyModelDraws) {
          pass.setBindGroup(0, draw.bindGroup);
          pass.draw(6, 1, 0, draw.index);
        }
      }

      if (this.galaxyTypeModelEntries.size > 0) {
        pass.setPipeline(this.milkyWayModelPipeline);
        for (const entry of this.galaxyTypeModelEntries.values()) {
          for (const part of entry.parts) {
            pass.setBindGroup(0, part.bindGroup);
            pass.setVertexBuffer(0, part.vertexBuffer);
            pass.draw(part.vertexCount);
          }
        }
      }
    }

    // ── Nebulas (inside Milky Way — between galaxies and stars) ───────────
    if (this.nebulaCount > 0) {
      pass.setPipeline(this.nebulaPipeline);
      pass.setBindGroup(0, this.nebulaBindGroup);
      pass.draw(6, this.nebulaCount, 0, 0);
    }
    // ── Eta Carinae Homunculus — real NASA/ESA Hubble image billboard ─────
    if (this.homunculusBindGroup !== null) {
      pass.setPipeline(this.nebulaTexturedPipeline);
      pass.setBindGroup(0, this.homunculusBindGroup);
      pass.draw(6, 1, 0, 0);
    }

    // ── NASA/Chandra object meshes — close LOD only, shader fades by camera distance.
    if (this.milkyWayModelEntries.size > 0) {
      pass.setPipeline(this.milkyWayModelPipeline);
      const drawModelEntry = (entry: MilkyWayModelEntry): void => {
        for (const part of entry.parts) {
          pass.setBindGroup(0, part.bindGroup);
          pass.setVertexBuffer(0, part.vertexBuffer);
          pass.draw(part.vertexCount);
        }
      };
      if (this.activeMilkyWayModelId) {
        const activeEntry = this.milkyWayModelEntries.get(this.activeMilkyWayModelId);
        if (activeEntry) drawModelEntry(activeEntry);
      } else {
        const drawnGroups = new Set<string>();
        for (const entry of this.milkyWayModelEntries.values()) {
          if (drawnGroups.has(entry.modelGroup)) continue;
          drawnGroups.add(entry.modelGroup);
          drawModelEntry(entry);
        }
      }
    }

    // ── Milky Way background stars (galaxy-scale LOD layer) ───────────────
    pass.setPipeline(this.mwPipeline);
    pass.setBindGroup(0, this.mwBindGroup);
    drawOctants(
      this.mwOctants, this._mwStarLimit, this.mwStarCount,
      () => pass.draw(6, Math.min(this.mwStarCount, this._mwStarLimit), 0, 0),
    );

    // ── Partial galactic dust clouds — between background and foreground stars.
    // Positions are sampled from the MF2015 E(B-V) map; nearby catalog stars draw over dust.
    const dustDrawCount = Math.min(this.dustCloudCount, this._dustDrawLimit);
    if (
      this._showDust &&
      dustDrawCount > 0 &&
      this.dustOpacity() > 0.001
    ) {
      pass.setBindGroup(0, this.dustBindGroup);
      pass.setPipeline(this.dustImpostorPipeline);
      pass.draw(6, dustDrawCount, 0, 0);
      pass.setPipeline(this.dustPipeline);
      pass.draw(6, dustDrawCount, 0, 0);
    }

    // ── Static catalog stars (nearby HYG) ─────────────────────────────────
    pass.setPipeline(this.starPipeline);
    pass.setBindGroup(0, this.starBindGroup);
    drawOctants(
      this.starOctants, this._starLimit, this.starCount,
      () => pass.draw(6, Math.min(this.starCount, this._starLimit), 0, 0),
    );

    if (this.selectedStarModelActive && this.selectedStarModelVertexCount > 0) {
      pass.setPipeline(this.starModelPipeline);
      pass.setBindGroup(0, this.selectedStarModelBindGroup);
      pass.setVertexBuffer(0, this.selectedStarModelVertexBuffer);
      pass.draw(this.selectedStarModelVertexCount);
    }

    // ── Constellation lines between snapped visible-star positions ─────────
    if (this._showConstellations && this.constellationCount > 0) {
      pass.setPipeline(this.constellationPipeline);
      pass.setBindGroup(0, this.constellationBindGroup);
      pass.setVertexBuffer(0, this.constellationBuffer, 0, this.constellationCount * CONSTELLATION_FLOATS * 4);
      pass.draw(this.constellationCount);
    }

    // ── Bodies ────────────────────────────────────────────────────────────
    pass.setPipeline(this.bodyPipeline);
    pass.setBindGroup(0, this.bodyBindGroup);
    pass.draw(6, this.bodyCount, 0, 0);

    if (this.solarSystemModelEntries.size > 0) {
      pass.setPipeline(this.solarSystemModelPipeline);
      for (const entry of this.solarSystemModelEntries.values()) {
        for (const part of entry.parts) {
          pass.setBindGroup(0, part.bindGroup);
          pass.setVertexBuffer(0, part.vertexBuffer);
          pass.draw(part.vertexCount);
        }
      }
    }

      pass.end();
    };

    this.ensureSceneTexture();
    this.ensureBloomTextures();
    uploadTrails();
    drawScene(this.sceneTextureView!);
    if (this._actualBrightness) {
      this.runBloomPasses(encoder);
    } else {
      this.clearBloomPass(encoder);
    }

    const blackHoleRadius = this._blackHoleUniform[3] ?? 0;
    const blackHoleStrength = this._blackHoleUniform[7] ?? 0;
    const lensStrength = this._showBlackHole && blackHoleRadius > 0 && blackHoleStrength > 0
      ? blackHoleStrength
      : 0;
    if (lensStrength !== blackHoleStrength) {
      const displayUniform = new Float32Array(this._blackHoleUniform);
      displayUniform[7] = lensStrength;
      device.queue.writeBuffer(this.blackHoleBuffer, 0, displayUniform);
    } else {
      device.queue.writeBuffer(this.blackHoleBuffer, 0, this._blackHoleUniform);
    }

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: swapView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear", storeOp: "store",
      }],
    });
    pass.setPipeline(this.blackHolePipeline);
    pass.setBindGroup(0, this.blackHoleBindGroup!);
    pass.draw(6, 1, 0, 0);
    drawTrails(pass);
    pass.end();

    device.queue.submit([encoder.finish()]);
  }
}

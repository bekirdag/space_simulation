import renderWGSL   from "./render.wgsl?raw";
import starWGSL     from "./star.wgsl?raw";
import milkywayWGSL from "./milkyway.wgsl?raw";
import galaxyWGSL   from "./galaxy.wgsl?raw";
import galaxyTexturedWGSL from "./galaxy-textured.wgsl?raw";
import nebulaWGSL         from "./nebula.wgsl?raw";
import nebulaTexturedWGSL from "./nebula-textured.wgsl?raw";
import milkyWayModelWGSL  from "./milkyway-model.wgsl?raw";
import dustWGSL     from "./dust.wgsl?raw";
import blackholeWGSL from "./blackhole.wgsl?raw";
import constellationWGSL from "./constellation.wgsl?raw";
import trailWGSL    from "./trail.wgsl?raw";
import { type GPUContext } from "./device";
import { type Body, BODY_FLOATS } from "../physics/body";
import { BodyType } from "../physics/constants";
import { STAR_FLOATS } from "../catalog/stars";
import { MW_FLOATS } from "../catalog/milkyway";
import { GALAXY_FLOATS } from "../catalog/galaxies";
import { GALAXY_MODEL_FLOATS, type GalaxyTextureModel } from "../catalog/galaxy-models";
import { type MilkyWayModelObject } from "../catalog/milkyway-models";
import { NEBULA_FLOATS } from "../catalog/nebulas";
import {
  DUST_MILKY_WAY_KPC_TO_AU,
  DUST_VOLUME_CENTER_AU,
  DUST_VOLUME_HALF_HEIGHT_AU,
  DUST_VOLUME_RADIUS_AU,
  DUST_VOLUME_SIZE,
} from "../catalog/dust";
import { CONSTELLATION_FLOATS } from "../catalog/constellations";
import { type TrailSystem, TRAIL_VTXFLOATS, TRAIL_SLOT_BYTES } from "../scene/trail-system";
import { type OctantRange } from "./sky-cull";
import { type CameraUniforms } from "../scene/camera";
import { MILKY_WAY_MODEL_VERTEX_FLOATS, parseMilkyWayModel, type ParsedMilkyWayMaterial } from "./model-loader";
import { BackendUnavailableError, backendFetch } from "../services/backend";

// Camera uniform: mat4 (64) + right/min vec4 + up/focal vec4 + eye vec4 = 112 bytes
const CAMERA_BYTES = 112;
const BLACK_HOLE_BYTES = 32;
const MILKY_WAY_MODEL_UNIFORM_BYTES = 64;
const MILKY_WAY_MODEL_MATERIAL_BYTES = 48;
const MODEL_DEPTH_FORMAT: GPUTextureFormat = "depth24plus";
const SCENE_DEPTH_DISABLED: GPUDepthStencilState = {
  format: MODEL_DEPTH_FORMAT,
  depthWriteEnabled: false,
  depthCompare: "always",
};
const TEXTURED_GALAXY_MODEL_CAPACITY = 32;
const DUST_VOLUME_UNIFORM_BYTES = 80;
const DUST_COMPUTE_WORKGROUP_SIZE = 4;
const DUST_RENDER_FADE_START_AU = 4_000;
const DUST_RENDER_FADE_END_AU = 16_000;
const DUST_DEFAULT_TRANSPARENCY = 0.76;
const DUST_RAYMARCH_STEPS = 10;
const MILKY_WAY_MODEL_RETRY_MS = 120_000;
const MILKY_WAY_MODEL_BACKEND_RETRY_MS = 120_000;

const KM_PER_AU = 149_597_870.7;
const SUN_APPARENT_MAG = -26.74;
const FULL_MOON_APPARENT_MAG = -12.74;
const MOON_MEAN_DISTANCE_AU = 384_400 / KM_PER_AU;
const MOON_RADIUS_AU = 1_737.4 / KM_PER_AU;
const DEFAULT_REFLECTIVE_ALBEDO = 0.25;
const REFLECTIVE_BODY_ALBEDO: Record<string, number> = {
  Mercury: 0.142,
  Venus: 0.689,
  Earth: 0.367,
  Mars: 0.170,
  Jupiter: 0.538,
  Saturn: 0.499,
  Uranus: 0.488,
  Neptune: 0.442,
  Moon: 0.136,
  Io: 0.63,
  Europa: 0.67,
  Ganymede: 0.43,
  Callisto: 0.17,
  Titan: 0.22,
  Enceladus: 1.38,
  Mimas: 0.96,
  Tethys: 1.23,
  Dione: 0.998,
  Rhea: 0.95,
  Iapetus: 0.5,
  Miranda: 0.32,
  Ariel: 0.39,
  Umbriel: 0.21,
  Titania: 0.27,
  Oberon: 0.23,
  Triton: 0.76,
  Pluto: 0.49,
  Charon: 0.37,
  Eris: 0.96,
  Ceres: 0.09,
  Haumea: 0.7,
  Makemake: 0.8,
};
const MOON_GEOMETRIC_ALBEDO = REFLECTIVE_BODY_ALBEDO["Moon"] ?? 0.136;
const FULL_MOON_REFLECTED_FLUX =
  MOON_GEOMETRIC_ALBEDO * MOON_RADIUS_AU * MOON_RADIUS_AU /
  (MOON_MEAN_DISTANCE_AU * MOON_MEAN_DISTANCE_AU);

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

interface MilkyWayModelPartEntry {
  vertexBuffer: GPUBuffer;
  materialBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  vertexCount: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoother01(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function bodyDistanceAU(a: Body, b: Body): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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

function responseOrigin(response: Response): string {
  try {
    return response.url ? new URL(response.url).origin : "unknown origin";
  } catch {
    return "unknown origin";
  }
}

function validateMilkyWayModelResponse(
  model: MilkyWayModelObject,
  response: Response,
  buffer: ArrayBuffer,
): void {
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html") || isHtmlResponse(buffer)) {
    throw new Error(`model route returned HTML from ${responseOrigin(response)}`);
  }
  if (model.format === "glb" && !hasGlbMagic(buffer)) {
    throw new Error(`model route returned non-GLB data (${contentType || "unknown content type"})`);
  }
  if (model.format === "stl" && buffer.byteLength < 84) {
    throw new Error(`model route returned invalid STL data (${contentType || "unknown content type"})`);
  }
}

export class Renderer {
  private bodyPipeline!:    GPURenderPipeline;
  private starPipeline!:    GPURenderPipeline;
  private mwPipeline!:      GPURenderPipeline;
  private galaxyPipeline!:  GPURenderPipeline;
  private galaxyTexturedPipeline!: GPURenderPipeline;
  private nebulaPipeline!:          GPURenderPipeline;
  private nebulaTexturedPipeline!:  GPURenderPipeline;
  private milkyWayModelPipeline!:   GPURenderPipeline;
  private dustComputePipeline!: GPUComputePipeline;
  private dustPipeline!:    GPURenderPipeline;
  private blackHolePipeline!: GPURenderPipeline;
  private constellationPipeline!: GPURenderPipeline;
  private trailPipeline!:   GPURenderPipeline;

  private cameraBuffer!:      GPUBuffer;
  private bodyBuffer!:        GPUBuffer;
  private starBuffer!:        GPUBuffer;
  private mwStarBuffer!:      GPUBuffer;
  private galaxyBuffer!:      GPUBuffer;
  private galaxyModelBuffer!: GPUBuffer;
  private nebulaBuffer!:          GPUBuffer;
  private homunculusBuffer!:      GPUBuffer;
  private dustUniformBuffer!: GPUBuffer;
  private blackHoleBuffer!:   GPUBuffer;
  private constellationBuffer!: GPUBuffer;
  private trailVertexBuffer!: GPUBuffer;

  private bodyBindGroup!:   GPUBindGroup;
  private starBindGroup!:   GPUBindGroup;
  private mwBindGroup!:     GPUBindGroup;
  private galaxyBindGroup!: GPUBindGroup;
  private galaxyModelBGL!: GPUBindGroupLayout;
  private galaxyModelSampler!: GPUSampler;
  private galaxyModelDraws: Array<{ bindGroup: GPUBindGroup; index: number }> = [];
  private galaxyModelTextures: GPUTexture[] = [];
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
  private dustComputeBindGroup!: GPUBindGroup;
  private dustBindGroup!:   GPUBindGroup;
  private dustTexture!:     GPUTexture;
  private dustSampler!:     GPUSampler;
  private blackHoleBindGroup!: GPUBindGroup;
  private constellationBindGroup!: GPUBindGroup;
  private trailBindGroup!:  GPUBindGroup;
  private starBGL!:         GPUBindGroupLayout;
  private mwBGL!:           GPUBindGroupLayout;
  private galaxyBGL!:       GPUBindGroupLayout;
  private nebulaBGL!:       GPUBindGroupLayout;
  private dustComputeBGL!:  GPUBindGroupLayout;
  private dustBGL!:         GPUBindGroupLayout;
  private blackHoleBGL!:    GPUBindGroupLayout;
  private constellationBGL!: GPUBindGroupLayout;
  private sceneSampler!:    GPUSampler;
  private sceneTexture:     GPUTexture | null = null;
  private sceneTextureView: GPUTextureView | null = null;
  private sceneTextureWidth = 0;
  private sceneTextureHeight = 0;
  private depthTexture:     GPUTexture | null = null;
  private depthTextureView: GPUTextureView | null = null;
  private depthTextureWidth = 0;
  private depthTextureHeight = 0;
  private viewportWidth = 1;
  private viewportHeight = 1;
  private selectedStarBuffer!: GPUBuffer;
  private starLodBuffer!:   GPUBuffer;  // x=legacy fade, y=camera radius
  private mwLodBuffer!:     GPUBuffer;  // x=fade, y=actual brightness
  private galaxyLodBuffer!: GPUBuffer;  // x=actual brightness

  private bodyCount    = 0;
  private starCount    = 0;
  private mwStarCount  = 0;
  private galaxyCount  = 0;
  private galaxyModelCount = 0;
  private nebulaCount  = 0;
  private constellationCount = 0;
  private starCapacity = 0;
  private constellationCapacity = 0;
  private dustVolumeReady = false;

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
  private _actualBrightness = true;
  private _cameraDistanceFromSun = 0;
  private _showDust = true;
  private _dustTransparency = DUST_DEFAULT_TRANSPARENCY;
  private _showBlackHole = true;
  private _blackHoleUniform = new Float32Array([
    0, 0, 0, 0,
    0, 1, 1, 1,
  ]);

  applySettings(s: {
    starLimit?:   number;
    mwStarLimit?: number;
    galaxyLimit?: number;
    showGalaxies?: boolean;
    showConstellations?: boolean;
    showTrails?:  boolean;
    actualBodyBrightness?: boolean;
    showDust?: boolean;
    dustTransparency?: number;
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
    }
    if (s.showDust !== undefined) this._showDust = s.showDust;
    if (s.dustTransparency !== undefined) this._dustTransparency = clamp(s.dustTransparency, 0, 1);
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

    this.cameraBuffer = device.createBuffer({
      label: "camera-uniform",
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

    this.dustUniformBuffer = device.createBuffer({
      label: "galactic-dust-volume-uniform",
      size: DUST_VOLUME_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.dustTexture = device.createTexture({
      label: "galactic-dust-density-texture",
      size: {
        width: DUST_VOLUME_SIZE,
        height: DUST_VOLUME_SIZE,
        depthOrArrayLayers: DUST_VOLUME_SIZE,
      },
      dimension: "3d",
      format: "rgba8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.dustSampler = device.createSampler({
      label: "galactic-dust-volume-sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
      addressModeW: "clamp-to-edge",
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
        { binding: 0, resource: { buffer: this.cameraBuffer } },
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
          format,
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
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
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
          format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
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
          format,
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
          format,
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
          format,
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
          format,
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
          format,
          blend: {
            color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });

    // ── Procedural galactic dust volume pipeline ───────────────────────────
    this.dustComputeBGL = device.createBindGroupLayout({
      label: "dust-volume-compute-bgl",
      entries: [
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          storageTexture: { access: "write-only", format: "rgba8unorm", viewDimension: "3d" },
        },
      ],
    });
    this.dustBGL = device.createBindGroupLayout({
      label: "dust-volume-render-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "3d" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    const dustTextureView = this.dustTexture.createView({ dimension: "3d" });
    this.dustComputeBindGroup = device.createBindGroup({
      label: "dust-volume-compute-bg", layout: this.dustComputeBGL,
      entries: [
        { binding: 1, resource: { buffer: this.dustUniformBuffer } },
        { binding: 4, resource: dustTextureView },
      ],
    });
    this.dustBindGroup = device.createBindGroup({
      label: "dust-volume-render-bg", layout: this.dustBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.dustUniformBuffer } },
        { binding: 2, resource: dustTextureView },
        { binding: 3, resource: this.dustSampler },
      ],
    });
    const dustShader = device.createShaderModule({ code: dustWGSL });
    this.dustComputePipeline = device.createComputePipeline({
      label: "dust-volume-compute-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.dustComputeBGL] }),
      compute: { module: dustShader, entryPoint: "cs_main" },
    });
    this.dustPipeline = device.createRenderPipeline({
      label: "dust-volume-render-pipeline",
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.dustBGL] }),
      vertex:   { module: dustShader, entryPoint: "vs_main" },
      fragment: {
        module: dustShader, entryPoint: "fs_main",
        targets: [{
          format,
          // Standard translucent over blend. The shader caps final dust opacity
          // near 10%; ray depth naturally makes dense lanes darker.
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: SCENE_DEPTH_DISABLED,
    });
    this.rebuildDustVolume();

    // ── Sagittarius A* black-hole lensing post-process ────────────────────
    this.blackHoleBGL = device.createBindGroupLayout({
      label: "black-hole-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
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
          format,
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
      ],
    });
    this.trailBindGroup = device.createBindGroup({
      label: "trail-bg", layout: trailBGL,
      entries: [{ binding: 0, resource: { buffer: this.cameraBuffer } }],
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
            color: { srcFactor: "src-alpha", dstFactor: "one", operation: "add" },
            alpha: { srcFactor: "one",       dstFactor: "one", operation: "add" },
          },
        }],
      },
      primitive: { topology: "line-strip" },
      depthStencil: SCENE_DEPTH_DISABLED,
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
      data[o + 14] = 0;
      data[o + 15] = 0;
    }

    if (data.length > 0) {
      this.ctx.device.queue.writeBuffer(this.galaxyModelBuffer, 0, data as GPUAllowSharedBufferSource);
    }

    for (const texture of this.galaxyModelTextures) texture.destroy();
    this.galaxyModelTextures = [];
    this.galaxyModelDraws = [];

    for (let i = 0; i < usable.length; i++) {
      const model = usable[i]!;
      try {
        const resp = await fetch(model.textureUrl);
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
      } catch (e) {
        console.warn(`Failed to load galaxy texture for ${model.name}:`, e);
      }
    }

    console.info(`Loaded ${this.galaxyModelDraws.length} textured galaxy LOD models.`);
  }

  uploadNebulas(nebulas: Float32Array): void {
    this.nebulaCount = nebulas.length / NEBULA_FLOATS;
    this.ctx.device.queue.writeBuffer(this.nebulaBuffer, 0, nebulas as GPUAllowSharedBufferSource);
  }

  uploadHomunculus(buf: Float32Array): void {
    this.ctx.device.queue.writeBuffer(this.homunculusBuffer, 0, buf as GPUAllowSharedBufferSource);
  }

  async loadEtaCarinaTexture(url: string): Promise<void> {
    try {
      const resp   = await fetch(url);
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
      const resp = await backendFetch(model.assetUrl, { cache: "force-cache" });
      if (!resp.ok) throw new Error(`asset ${resp.status}`);
      const buffer = await resp.arrayBuffer();
      validateMilkyWayModelResponse(model, resp, buffer);
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
      const parts: MilkyWayModelPartEntry[] = mesh.parts.map((part, index) => {
        const vertexBuffer = device.createBuffer({
          label: `milky-way-model-vertices-${model.id}-${index}`,
          size: part.vertices.byteLength,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(vertexBuffer, 0, part.vertices as GPUAllowSharedBufferSource);
        const materialBuffer = this.createMilkyWayModelMaterialBuffer(model, part.material, index);
        const texture = part.material.textureIndex >= 0
          ? textures[part.material.textureIndex] ?? this.milkyWayModelWhiteTexture
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
    data[11] = 0;
    device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private pruneMilkyWayModelFailures(): void {
    const now = Date.now();
    for (const [id, failedAt] of this.milkyWayModelFailedAt) {
      if (now - failedAt >= MILKY_WAY_MODEL_RETRY_MS) {
        this.milkyWayModelFailedAt.delete(id);
      }
    }
  }

  private writeDustUniform(viewportWidth: number, viewportHeight: number): void {
    if (!this.dustUniformBuffer) return;
    const dustVisibility = this.dustVisibility();
    const data = new Float32Array(DUST_VOLUME_UNIFORM_BYTES / 4);
    data[0] = DUST_VOLUME_CENTER_AU[0];
    data[1] = DUST_VOLUME_CENTER_AU[1];
    data[2] = DUST_VOLUME_CENTER_AU[2];
    data[3] = DUST_VOLUME_RADIUS_AU;

    data[4] = DUST_VOLUME_HALF_HEIGHT_AU;
    data[5] = DUST_MILKY_WAY_KPC_TO_AU;
    data[6] = 0.29; // galacticCoverage: higher values carve more empty lanes.
    data[7] = DUST_VOLUME_SIZE;

    data[8] = 5.4;   // absorption
    data[9] = 0.34;  // scattering strength
    data[10] = 0.62; // Henyey-Greenstein forward-scattering g
    data[11] = this.dustOpacity() * dustVisibility;

    data[12] = 1.0;
    data[13] = 0.82;
    data[14] = 0.55;
    data[15] = DUST_RAYMARCH_STEPS;

    data[16] = Math.max(1, viewportWidth);
    data[17] = Math.max(1, viewportHeight);
    data[18] = 0;
    data[19] = 0;
    this.ctx.device.queue.writeBuffer(this.dustUniformBuffer, 0, data);
  }

  rebuildDustVolume(): void {
    if (!this.dustComputePipeline || !this.dustComputeBindGroup) return;
    this.writeDustUniform(1, 1);

    const { device } = this.ctx;
    const encoder = device.createCommandEncoder({ label: "dust-volume-build" });
    const pass = encoder.beginComputePass({ label: "dust-volume-compute-pass" });
    pass.setPipeline(this.dustComputePipeline);
    pass.setBindGroup(0, this.dustComputeBindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(DUST_VOLUME_SIZE / DUST_COMPUTE_WORKGROUP_SIZE),
      Math.ceil(DUST_VOLUME_SIZE / DUST_COMPUTE_WORKGROUP_SIZE),
      Math.ceil(DUST_VOLUME_SIZE / DUST_COMPUTE_WORKGROUP_SIZE),
    );
    pass.end();
    device.queue.submit([encoder.finish()]);
    this.dustVolumeReady = true;
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
    const sun = bodies.find(b => b.name === "Sun" && b.type === BodyType.Star);
    const earth = bodies.find(b => b.name === "Earth" && b.type === BodyType.Planet);
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      const o = i * BODY_FLOATS;
      const brightness = this.bodyBrightnessFactor(b, sun, earth);
      // vec4 pos_mass
      data[o+0]=b.x;  data[o+1]=b.y;  data[o+2]=b.z;  data[o+3]=b.mass;
      // vec4 vel_rad
      data[o+4]=b.vx; data[o+5]=b.vy; data[o+6]=b.vz; data[o+7]=b.radius;
      // vec4 acc_type (x=brightness; y=reference observer distance AU; z=render visibility; w=type)
      data[o+8]=brightness.display; data[o+9]=brightness.observerDistanceAU; data[o+10]=visibility.get(b.id) ?? 1; data[o+11]=b.type;
      // vec4 col_id
      data[o+12]=b.color[0]; data[o+13]=b.color[1]; data[o+14]=b.color[2]; data[o+15]=b.id;
    }
    this.ctx.device.queue.writeBuffer(this.bodyBuffer, 0, data);
  }

  private bodyBrightnessFactor(body: Body, sun: Body | undefined, earth: Body | undefined): BodyBrightnessSample {
    if (!this._actualBrightness) return { display: 1, observerDistanceAU: 0 };
    if (body.type === BodyType.Star) {
      const referenceAU = body.name === "Sun" && earth ? Math.max(0.02, bodyDistanceAU(body, earth)) : 0;
      return {
        display: body.name === "Sun" ? this.apparentMagnitudeToDisplayBrightness(SUN_APPARENT_MAG) : 32,
        observerDistanceAU: referenceAU,
      };
    }
    if (body.type === BodyType.Exoplanet) {
      return { display: 1.35, observerDistanceAU: 0 };
    }
    if (!sun || !earth) return { display: 1, observerDistanceAU: 0 };
    if (body.id === earth.id) return { display: 1.25, observerDistanceAU: 1 };

    const albedo = REFLECTIVE_BODY_ALBEDO[body.name] ?? DEFAULT_REFLECTIVE_ALBEDO;
    const sunVec = [sun.x - body.x, sun.y - body.y, sun.z - body.z] as const;
    const earthVec = [earth.x - body.x, earth.y - body.y, earth.z - body.z] as const;
    const sunDistanceAU = Math.max(0.02, Math.hypot(sunVec[0], sunVec[1], sunVec[2]));
    const earthDistanceAU = Math.max(body.radius * 4, Math.hypot(earthVec[0], earthVec[1], earthVec[2]));
    const phaseCos = clamp(
      (sunVec[0] * earthVec[0] + sunVec[1] * earthVec[1] + sunVec[2] * earthVec[2]) /
      (sunDistanceAU * earthDistanceAU),
      -1,
      1,
    );
    const phaseAngle = Math.acos(phaseCos);
    const phase = Math.max(0.02, (Math.sin(phaseAngle) + (Math.PI - phaseAngle) * Math.cos(phaseAngle)) / Math.PI);
    const reflectedFlux = Math.max(
      1e-24,
      albedo * body.radius * body.radius * phase /
      (sunDistanceAU * sunDistanceAU * earthDistanceAU * earthDistanceAU),
    );
    const apparentMag = FULL_MOON_APPARENT_MAG - 2.5 * Math.log10(reflectedFlux / FULL_MOON_REFLECTED_FLUX);
    return {
      display: this.apparentMagnitudeToDisplayBrightness(apparentMag),
      observerDistanceAU: earthDistanceAU,
    };
  }

  private apparentMagnitudeToDisplayBrightness(mag: number): number {
    if (!Number.isFinite(mag)) return 1;
    return clamp(Math.pow(10, (1.0 - mag) / 7.0), 0.35, 160);
  }

  private syncBrightnessUniforms(): void {
    if (!this.starLodBuffer || !this.mwLodBuffer || !this.galaxyLodBuffer) return;
    const actual = this._actualBrightness ? 1 : 0;

    // MW individual stars disappear when camera > 400 kpc (3 200 000 AU).
    // Transition: fully visible at 360 kpc → invisible at 400 kpc.
    const camKpc     = this._cameraDistanceFromSun / 8_000;
    const mwStarFade = Math.max(0, Math.min(1, (400 - camKpc) / 40));

    // MW self (single galaxy blob) fades IN as individual stars fade OUT.
    // Visible from 360 kpc, full brightness by 440 kpc. Max alpha 0.55.
    this._mwSelfAlpha = Math.max(0, Math.min(0.55, (camKpc - 360) / 80)) * (this._showGalaxies ? 1 : 0);

    this.ctx.device.queue.writeBuffer(this.starLodBuffer, 0, new Float32Array([1, this._cameraDistanceFromSun, 0, 0]));
    this.ctx.device.queue.writeBuffer(this.mwLodBuffer,  0, new Float32Array([mwStarFade, actual, 0, 0]));
    this.ctx.device.queue.writeBuffer(this.galaxyLodBuffer, 0, new Float32Array([actual, 0, 0, 0]));

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

  private dustVisibility(): number {
    return smoother01(
      (this._cameraDistanceFromSun - DUST_RENDER_FADE_START_AU) /
      (DUST_RENDER_FADE_END_AU - DUST_RENDER_FADE_START_AU),
    );
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
    const { device, format } = this.ctx;
    this.sceneTextureWidth = width;
    this.sceneTextureHeight = height;
    this.sceneTexture = device.createTexture({
      label: "black-hole-scene-color",
      size: { width, height },
      format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.sceneTextureView = this.sceneTexture.createView();
    this.blackHoleBindGroup = device.createBindGroup({
      label: "black-hole-bg",
      layout: this.blackHoleBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.blackHoleBuffer } },
        { binding: 2, resource: this.sceneTextureView },
        { binding: 3, resource: this.sceneSampler },
      ],
    });
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

    // 112-byte layout:
    //   [0–63]  viewProj (mat4x4, 16 floats)
    //   [64–79] rightAndMNR (vec4: right.xyz, minNDCRadius)
    //   [80–95] upAndFocal  (vec4: up.xyz,    focalY)
    //   [96–111] eyeAndFlags (vec4: camera eye xyz, reserved)
    const data = new Float32Array(CAMERA_BYTES / 4);
    data.set(uniforms.viewProj, 0);
    data[16] = uniforms.camRight[0]; data[17] = uniforms.camRight[1]; data[18] = uniforms.camRight[2];
    data[19] = minNDCRadius;
    data[20] = uniforms.camUp[0];    data[21] = uniforms.camUp[1];    data[22] = uniforms.camUp[2];
    data[23] = uniforms.focalY;
    data[24] = uniforms.eye[0];      data[25] = uniforms.eye[1];      data[26] = uniforms.eye[2];
    data[27] = 0;
    this.ctx.device.queue.writeBuffer(this.cameraBuffer, 0, data);
    this.writeDustUniform(canvasWidth, canvasHeight);
  }

  draw(trails: TrailSystem): void {
    const { device } = this.ctx;
    const swapView = this.canvasCtx.getCurrentTexture().createView();

    const encoder = device.createCommandEncoder({ label: "frame" });
    const drawScene = (view: GPUTextureView): void => {
      const depthView = this.ensureDepthTexture();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view,
          clearValue: { r: 0.01, g: 0.01, b: 0.05, a: 1 },
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

    // ── Procedural galactic dust — drawn after MW stars, before nearby catalog stars.
    // Dust dims the galaxy background; nearby HYG stars render on top.
    if (
      this._showDust &&
      this.dustVolumeReady &&
      this.dustVisibility() > 0.01 &&
      this.dustOpacity() > 0.001
    ) {
      pass.setPipeline(this.dustPipeline);
      pass.setBindGroup(0, this.dustBindGroup);
      pass.draw(3, 1, 0, 0);
    }

    // ── Static catalog stars (nearby HYG) — appear in front of dust ───────
    pass.setPipeline(this.starPipeline);
    pass.setBindGroup(0, this.starBindGroup);
    drawOctants(
      this.starOctants, this._starLimit, this.starCount,
      () => pass.draw(6, Math.min(this.starCount, this._starLimit), 0, 0),
    );

    // ── Constellation lines between snapped visible-star positions ─────────
    if (this._showConstellations && this.constellationCount > 0) {
      pass.setPipeline(this.constellationPipeline);
      pass.setBindGroup(0, this.constellationBindGroup);
      pass.setVertexBuffer(0, this.constellationBuffer, 0, this.constellationCount * CONSTELLATION_FLOATS * 4);
      pass.draw(this.constellationCount);
    }

    // ── Trails ────────────────────────────────────────────────────────────
    // Each body owns a fixed slot in the GPU buffer (assigned once, never moved).
    // Only dirty bodies — those where a new point was recorded this frame — trigger
    // a writeBuffer call.  Unchanged trails are drawn from the existing GPU data
    // at zero upload cost: on a paused or slow-timewarp frame this is essentially free.
    if (this._showTrails) {
      // Upload only dirty trails
      for (const bodyId of trails.bodyIds) {
        if (!trails.isDirty(bodyId)) continue;

        // Assign slot on first encounter
        if (!this.trailSlot.has(bodyId)) {
          if (this.trailSlotCount >= TRAIL_MAX_BODIES) continue;
          this.trailSlot.set(bodyId, this.trailSlotCount++);
        }

        const verts = trails.buildVertices(bodyId);
        trails.clearDirty(bodyId);
        if (!verts || verts.length < 2 * TRAIL_VTXFLOATS) continue;

        const slot       = this.trailSlot.get(bodyId)!;
        const byteOffset = slot * TRAIL_SLOT_BYTES;
        device.queue.writeBuffer(this.trailVertexBuffer, byteOffset, verts as GPUAllowSharedBufferSource);
        this.trailDrawCount.set(bodyId, verts.length / TRAIL_VTXFLOATS);
      }

      // Draw all known trails using their cached GPU data
      pass.setPipeline(this.trailPipeline);
      pass.setBindGroup(0, this.trailBindGroup);
      for (const bodyId of trails.bodyIds) {
        const slot  = this.trailSlot.get(bodyId);
        const count = this.trailDrawCount.get(bodyId) ?? 0;
        if (slot === undefined || count < 2) continue;
        pass.setVertexBuffer(0, this.trailVertexBuffer, slot * TRAIL_SLOT_BYTES, count * TRAIL_VTXFLOATS * 4);
        pass.draw(count);
      }
    }

    // ── Bodies ────────────────────────────────────────────────────────────
    pass.setPipeline(this.bodyPipeline);
    pass.setBindGroup(0, this.bodyBindGroup);
    pass.draw(6, this.bodyCount, 0, 0);

      pass.end();
    };

    const blackHoleRadius = this._blackHoleUniform[3] ?? 0;
    const blackHoleStrength = this._blackHoleUniform[7] ?? 0;
    if (this._showBlackHole && blackHoleRadius > 0 && blackHoleStrength > 0) {
      this.ensureSceneTexture();
      drawScene(this.sceneTextureView!);
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: swapView,
          clearValue: { r: 0.01, g: 0.01, b: 0.05, a: 1 },
          loadOp: "clear", storeOp: "store",
        }],
      });
      pass.setPipeline(this.blackHolePipeline);
      pass.setBindGroup(0, this.blackHoleBindGroup);
      pass.draw(6, 1, 0, 0);
      pass.end();
    } else {
      drawScene(swapView);
    }

    device.queue.submit([encoder.finish()]);
  }
}

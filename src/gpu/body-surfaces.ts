import bodySurfaceWGSL from "./body-surface.wgsl?raw";
import { type SolarSystemModelAsset } from "../catalog/solar-system-models";
import { type Body } from "../physics/body";
import { IDENTITY_BODY_ROTATION_BASIS, bodyRotationBasis, type BodyRotationBasis } from "../physics/rotations";
import { type CameraUniforms } from "../scene/camera";

/**
 * Textured solar-system bodies drawn as ray-traced ellipsoid impostors
 * (body-surface.wgsl): pixel-exact round silhouettes at any zoom, true surface
 * log depth, IAU-oriented equirectangular maps with mipmaps, Sun-lit
 * terminator, Earth night lights/clouds and Saturn's rings.
 *
 * Bodies cross-fade from the point sprite (render.wgsl) to the surface between
 * FADE_START_PX and FADE_END_PX projected radius; textures are fetched lazily
 * the first time a body approaches that size.
 */

const AU_KM = 149_597_870.7;
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0);
const DAY_MS = 86_400_000;
const UNIFORM_FLOATS = 36; // 9 x vec4
const UNIFORM_BYTES = UNIFORM_FLOATS * 4;
const FADE_START_PX = 1.0;
const FADE_END_PX = 2.5;
const PRELOAD_PX = 0.6;
const KIND_CODE = { rocky: 0, gas: 1, sun: 2, earth: 3 } as const;

interface SurfaceEntry {
  asset: SolarSystemModelAsset;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  colorTexture: GPUTexture | null;
  auxTexture: GPUTexture | null;
  texturesRequested: boolean;
  /** 0 = sprite only, 1 = fully drawn surface. */
  fade: number;
  body: Body | null;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export class BodySurfaceRenderer {
  private readonly bgl: GPUBindGroupLayout;
  private readonly globePipeline: GPURenderPipeline;
  private readonly globeDepthPipeline: GPURenderPipeline;
  private readonly ringPipeline: GPURenderPipeline;
  private readonly ringDepthPipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly blackTexture: GPUTexture;
  private readonly mipPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  private readonly mipSampler: GPUSampler;
  private mipShader: GPUShaderModule | null = null;
  private readonly entries = new Map<string, SurfaceEntry>();
  private readonly uniformScratch = new Float32Array(UNIFORM_FLOATS);
  private bodies: readonly Body[] = [];
  private simulationTimeMs = J2000_MS;

  constructor(
    private readonly device: GPUDevice,
    private readonly cameraBuffer: GPUBuffer,
    sceneFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
  ) {
    this.bgl = device.createBindGroupLayout({
      label: "body-surface-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    this.sampler = device.createSampler({
      label: "body-surface-sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge",
      maxAnisotropy: 16,
    });
    this.mipSampler = device.createSampler({ magFilter: "linear", minFilter: "linear" });
    this.blackTexture = device.createTexture({
      label: "body-surface-black",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture: this.blackTexture }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, [1, 1, 1]);

    const module = device.createShaderModule({ label: "body-surface", code: bodySurfaceWGSL });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const blend: GPUBlendState = {
      color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const depthWrite: GPUDepthStencilState = { format: depthFormat, depthWriteEnabled: true, depthCompare: "less-equal" };
    // Back faces of the bounding box: the ray-traced surface is always in
    // front of them, also when the eye is inside the box.
    const globePrimitive: GPUPrimitiveState = { topology: "triangle-list", cullMode: "front", frontFace: "ccw" };
    this.globePipeline = device.createRenderPipeline({
      label: "body-surface-globe",
      layout,
      vertex: { module, entryPoint: "vs_globe" },
      fragment: { module, entryPoint: "fs_globe", targets: [{ format: sceneFormat, blend }] },
      primitive: globePrimitive,
      depthStencil: depthWrite,
    });
    this.globeDepthPipeline = device.createRenderPipeline({
      label: "body-surface-globe-depth",
      layout,
      vertex: { module, entryPoint: "vs_globe" },
      fragment: { module, entryPoint: "fs_globe_depth", targets: [{ format: sceneFormat, writeMask: 0 }] },
      primitive: globePrimitive,
      depthStencil: depthWrite,
    });
    this.ringPipeline = device.createRenderPipeline({
      label: "body-surface-ring",
      layout,
      vertex: { module, entryPoint: "vs_ring" },
      fragment: { module, entryPoint: "fs_ring", targets: [{ format: sceneFormat, blend }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depthWrite,
    });
    this.ringDepthPipeline = device.createRenderPipeline({
      label: "body-surface-ring-depth",
      layout,
      vertex: { module, entryPoint: "vs_ring" },
      fragment: { module, entryPoint: "fs_ring_depth", targets: [{ format: sceneFormat, writeMask: 0 }] },
      primitive: { topology: "triangle-list", cullMode: "none" },
      depthStencil: depthWrite,
    });
  }

  setAssets(assets: readonly SolarSystemModelAsset[]): void {
    for (const asset of assets) {
      if (this.entries.has(asset.bodyName)) continue;
      const uniformBuffer = this.device.createBuffer({
        label: `body-surface-uniform-${asset.id}`,
        size: UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      const entry: SurfaceEntry = {
        asset,
        uniformBuffer,
        bindGroup: null as unknown as GPUBindGroup,
        colorTexture: null,
        auxTexture: null,
        texturesRequested: false,
        fade: 0,
        body: null,
      };
      entry.bindGroup = this.createBindGroup(entry);
      this.entries.set(asset.bodyName, entry);
    }
  }

  hasSurface(bodyName: string): boolean {
    return this.entries.has(bodyName);
  }

  /** Multiplier for the point-sprite visibility of `bodyName` (1 = sprite only). */
  spriteVisibility(bodyName: string): number {
    const entry = this.entries.get(bodyName);
    return entry ? 1 - entry.fade : 1;
  }

  /**
   * Per-frame CPU update: cross-fade factors from the projected radius and lazy
   * texture loads. Uses the latest camera (may lag one frame; only affects the
   * fade, not the drawn geometry).
   */
  update(bodies: readonly Body[], simulationTimeMs: number, camera: CameraUniforms | null, viewportHeight: number): void {
    this.bodies = bodies;
    this.simulationTimeMs = simulationTimeMs;
    const byName = new Map<string, Body>();
    for (const body of bodies) byName.set(body.name, body);
    for (const entry of this.entries.values()) {
      const body = byName.get(entry.asset.bodyName) ?? null;
      entry.body = body;
      if (!body || !camera) {
        entry.fade = 0;
        continue;
      }
      const dx = body.x - camera.eye[0];
      const dy = body.y - camera.eye[1];
      const dz = body.z - camera.eye[2];
      const dist = Math.hypot(dx, dy, dz);
      const radius = body.radius * this.maxAxis(entry, body);
      const pixelRadius = dist > radius
        ? (radius / Math.sqrt(dist * dist - radius * radius)) * camera.focalY * viewportHeight * 0.5
        : Number.POSITIVE_INFINITY;
      entry.fade = smoothstep(FADE_START_PX, FADE_END_PX, pixelRadius);
      if (pixelRadius >= PRELOAD_PX && !entry.texturesRequested) {
        entry.texturesRequested = true;
        void this.loadTextures(entry);
      }
    }
  }

  /** Writes eye-relative uniforms from the camera used for this frame's draw. */
  prepareFrame(camera: CameraUniforms | null): void {
    if (!camera) return;
    const sun = this.bodies.find(body => body.name === "Sun");
    for (const entry of this.entries.values()) {
      const body = entry.body;
      if (!body || entry.fade <= 0.001) continue;
      this.writeUniform(entry, body, sun, camera);
    }
  }

  drawDepthPrepass(pass: GPURenderPassEncoder): void {
    this.drawEntries(pass, this.globeDepthPipeline, this.ringDepthPipeline, 0.5);
  }

  draw(pass: GPURenderPassEncoder): void {
    this.drawEntries(pass, this.globePipeline, this.ringPipeline, 0.001);
  }

  private drawEntries(pass: GPURenderPassEncoder, globe: GPURenderPipeline, ring: GPURenderPipeline, minFade: number): void {
    let bound = false;
    for (const entry of this.entries.values()) {
      if (!entry.body || entry.fade < minFade) continue;
      if (!bound) {
        pass.setPipeline(globe);
        bound = true;
      }
      pass.setBindGroup(0, entry.bindGroup);
      pass.draw(36);
    }
    let ringBound = false;
    for (const entry of this.entries.values()) {
      if (!entry.body || entry.fade < minFade || !entry.asset.ringRadiiKm || !entry.auxTexture) continue;
      if (!ringBound) {
        pass.setPipeline(ring);
        ringBound = true;
      }
      pass.setBindGroup(0, entry.bindGroup);
      pass.draw(6);
    }
  }

  private maxAxis(entry: SurfaceEntry, body: Body): number {
    const axes = entry.asset.semiAxesKm;
    const ringOuter = entry.asset.ringRadiiKm?.[1];
    const radiusKm = body.radius * AU_KM;
    let max = axes ? Math.max(axes[0], axes[1], axes[2]) / radiusKm : 1;
    if (ringOuter) max = Math.max(max, ringOuter / radiusKm);
    return max;
  }

  private rotationBasis(entry: SurfaceEntry): BodyRotationBasis {
    const basis = bodyRotationBasis(entry.asset.bodyName, this.simulationTimeMs);
    if (basis) return basis;
    const fallback = entry.asset.rotationFallback;
    if (!fallback) return IDENTITY_BODY_ROTATION_BASIS;
    // Spin about the ecliptic north pole (no measured pole for these bodies).
    const days = (this.simulationTimeMs - J2000_MS) / DAY_MS;
    const w = ((fallback.w0Deg + (days * 24 * 360) / fallback.periodHours) % 360) * (Math.PI / 180);
    return {
      right: [Math.cos(w), Math.sin(w), 0],
      up: [-Math.sin(w), Math.cos(w), 0],
      axis: [0, 0, 1],
      primeMeridianDeg: w * (180 / Math.PI),
      source: "approximate: ecliptic pole, catalogue rotation period",
    };
  }

  private writeUniform(entry: SurfaceEntry, body: Body, sun: Body | undefined, camera: CameraUniforms): void {
    const asset = entry.asset;
    const d = this.uniformScratch;
    d.fill(0);
    const radiusKm = body.radius * AU_KM;
    // Eye-relative centre computed in f64 so the ray tracer keeps precision.
    d[0] = body.x - camera.eye[0];
    d[1] = body.y - camera.eye[1];
    d[2] = body.z - camera.eye[2];
    d[3] = body.radius;
    const axes = asset.semiAxesKm;
    d[4] = axes ? axes[0] / radiusKm : 1;
    d[5] = axes ? axes[1] / radiusKm : 1;
    d[6] = axes ? axes[2] / radiusKm : 1;
    d[7] = asset.ringRadiiKm && entry.auxTexture ? 1 : 0;
    const basis = this.rotationBasis(entry);
    d.set(basis.right, 8);
    d.set(basis.up, 12);
    d.set(basis.axis, 16);
    let lx = 1;
    let ly = 0;
    let lz = 0;
    if (sun && sun !== body) {
      lx = sun.x - body.x;
      ly = sun.y - body.y;
      lz = sun.z - body.z;
      const len = Math.hypot(lx, ly, lz) || 1;
      lx /= len; ly /= len; lz /= len;
    }
    d[20] = lx;
    d[21] = ly;
    d[22] = lz;
    d[23] = KIND_CODE[asset.kind];
    d[24] = asset.textureCenterLonDeg ?? 0;
    d[25] = entry.fade;
    d[26] = entry.colorTexture ? 1 : 0;
    d[27] = asset.limbDarkening ?? 0.1;
    d[28] = asset.ringRadiiKm ? asset.ringRadiiKm[0] / radiusKm : 0;
    d[29] = asset.ringRadiiKm ? asset.ringRadiiKm[1] / radiusKm : 0;
    d[30] = asset.atmosphere ?? 0;
    d[31] = asset.kind === "sun" ? asset.emissive ?? 5 : 0;
    const tint = asset.atmosphere ? asset.atmosphereColor ?? asset.fallbackColor : asset.fallbackColor;
    // Fallback albedo until the texture arrives; the atmosphere colour after.
    const base = entry.colorTexture ? tint : asset.fallbackColor;
    d[32] = base[0];
    d[33] = base[1];
    d[34] = base[2];
    d[35] = 0.008; // ambient
    this.device.queue.writeBuffer(entry.uniformBuffer, 0, d);
  }

  private createBindGroup(entry: SurfaceEntry): GPUBindGroup {
    return this.device.createBindGroup({
      label: `body-surface-bg-${entry.asset.id}`,
      layout: this.bgl,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: entry.uniformBuffer } },
        { binding: 2, resource: this.sampler },
        { binding: 3, resource: (entry.colorTexture ?? this.blackTexture).createView() },
        { binding: 4, resource: (entry.auxTexture ?? this.blackTexture).createView() },
      ],
    });
  }

  private async loadTextures(entry: SurfaceEntry): Promise<void> {
    const asset = entry.asset;
    try {
      const [color, aux] = await Promise.all([
        asset.colorTexture ? this.loadTexture(asset.colorTexture, "rgba8unorm-srgb", true) : Promise.resolve(null),
        asset.auxTexture
          ? this.loadTexture(asset.auxTexture, "rgba8unorm", true)
          : asset.ringTexture
            ? this.loadTexture(asset.ringTexture, "rgba8unorm-srgb", true)
            : Promise.resolve(null),
      ]);
      entry.colorTexture = color;
      entry.auxTexture = aux;
      entry.bindGroup = this.createBindGroup(entry);
    } catch (err) {
      console.warn(`Failed to load surface texture for ${asset.bodyName}:`, err);
    }
  }

  private async loadTexture(url: string, format: GPUTextureFormat, mipmaps: boolean): Promise<GPUTexture> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url}: HTTP ${resp.status}`);
    const bitmap = await createImageBitmap(await resp.blob(), {
      colorSpaceConversion: "none",
      premultiplyAlpha: "none",
    });
    const width = Math.max(1, bitmap.width);
    const height = Math.max(1, bitmap.height);
    const mipLevelCount = mipmaps ? Math.floor(Math.log2(Math.max(width, height))) + 1 : 1;
    const texture = this.device.createTexture({
      label: `body-surface-texture ${url}`,
      size: [width, height, 1],
      format,
      mipLevelCount,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [width, height, 1]);
    bitmap.close();
    if (mipLevelCount > 1) this.generateMipmaps(texture, format, mipLevelCount);
    return texture;
  }

  private generateMipmaps(texture: GPUTexture, format: GPUTextureFormat, levels: number): void {
    const device = this.device;
    if (!this.mipShader) {
      this.mipShader = device.createShaderModule({
        label: "body-surface-mip",
        code: `
          @group(0) @binding(0) var src: texture_2d<f32>;
          @group(0) @binding(1) var samp: sampler;
          struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };
          @vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
            let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
            var o: VOut;
            o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
            o.uv = vec2<f32>(p.x, 1.0 - p.y);
            return o;
          }
          @fragment fn fs(in: VOut) -> @location(0) vec4<f32> {
            return textureSampleLevel(src, samp, in.uv, 0.0);
          }
        `,
      });
    }
    let pipeline = this.mipPipelines.get(format);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: `body-surface-mip-${format}`,
        layout: "auto",
        vertex: { module: this.mipShader, entryPoint: "vs" },
        fragment: { module: this.mipShader, entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" },
      });
      this.mipPipelines.set(format, pipeline);
    }
    const encoder = device.createCommandEncoder({ label: "body-surface-mips" });
    for (let level = 1; level < levels; level++) {
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: this.mipSampler },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
          loadOp: "clear",
          storeOp: "store",
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }
}

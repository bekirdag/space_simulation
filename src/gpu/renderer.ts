import renderWGSL   from "./render.wgsl?raw";
import starWGSL     from "./star.wgsl?raw";
import milkywayWGSL from "./milkyway.wgsl?raw";
import galaxyWGSL   from "./galaxy.wgsl?raw";
import nebulaWGSL   from "./nebula.wgsl?raw";
import trailWGSL    from "./trail.wgsl?raw";
import { type GPUContext } from "./device";
import { type Body, BODY_FLOATS } from "../physics/body";
import { STAR_FLOATS } from "../catalog/stars";
import { MW_FLOATS } from "../catalog/milkyway";
import { GALAXY_FLOATS } from "../catalog/galaxies";
import { NEBULA_FLOATS } from "../catalog/nebulas";
import { type TrailSystem, TRAIL_VTXFLOATS, TRAIL_SLOT_BYTES } from "../scene/trail-system";
import { type OctantRange } from "./sky-cull";
import { type CameraUniforms } from "../scene/camera";

// Camera uniform: mat4 (64) + vec4 rightAndMNR (16) + vec4 upAndFocal (16) = 96 bytes
const CAMERA_BYTES = 96;

const TRAIL_MAX_BODIES   = 64;
const TRAIL_VTXBUF_BYTES = TRAIL_MAX_BODIES * TRAIL_SLOT_BYTES; // 64 × fixed slot = ~31 MB

export class Renderer {
  private bodyPipeline!:    GPURenderPipeline;
  private starPipeline!:    GPURenderPipeline;
  private mwPipeline!:      GPURenderPipeline;
  private galaxyPipeline!:  GPURenderPipeline;
  private nebulaPipeline!:  GPURenderPipeline;
  private trailPipeline!:   GPURenderPipeline;

  private cameraBuffer!:      GPUBuffer;
  private bodyBuffer!:        GPUBuffer;
  private starBuffer!:        GPUBuffer;
  private mwStarBuffer!:      GPUBuffer;
  private galaxyBuffer!:      GPUBuffer;
  private nebulaBuffer!:      GPUBuffer;
  private trailVertexBuffer!: GPUBuffer;

  private bodyBindGroup!:   GPUBindGroup;
  private starBindGroup!:   GPUBindGroup;
  private mwBindGroup!:     GPUBindGroup;
  private galaxyBindGroup!: GPUBindGroup;
  private nebulaBindGroup!: GPUBindGroup;
  private trailBindGroup!:  GPUBindGroup;
  private starBGL!:         GPUBindGroupLayout;
  private mwBGL!:           GPUBindGroupLayout;
  private galaxyBGL!:       GPUBindGroupLayout;
  private nebulaBGL!:       GPUBindGroupLayout;
  private selectedStarBuffer!: GPUBuffer;
  private starLodBuffer!:   GPUBuffer;  // 16-byte uniform: x=brightness
  private mwLodBuffer!:     GPUBuffer;  // 16-byte uniform: x=fade for MW stars

  private bodyCount    = 0;
  private starCount    = 0;
  private mwStarCount  = 0;
  private galaxyCount  = 0;
  private nebulaCount  = 0;
  private starCapacity = 0;

  // Octant ranges for CPU-side culling (set after catalog sort, null = draw all)
  private starOctants:   OctantRange[] | null = null;
  private mwOctants:     OctantRange[] | null = null;
  private galaxyOctants: OctantRange[] | null = null;
  private visOctantMask  = 0xff; // all 8 octants visible by default

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

  applySettings(s: {
    starLimit?:   number;
    mwStarLimit?: number;
    galaxyLimit?: number;
    showTrails?:  boolean;
  }): void {
    if (s.starLimit   !== undefined) this._starLimit   = s.starLimit;
    if (s.mwStarLimit !== undefined) this._mwStarLimit = s.mwStarLimit;
    if (s.galaxyLimit !== undefined) this._galaxyLimit = s.galaxyLimit;
    if (s.showTrails  !== undefined) this._showTrails  = s.showTrails;
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

    // Nebula buffer: fixed-size (≤ 1 600 nebulas × 64 bytes = 102 kB — still tiny)
    this.nebulaBuffer = device.createBuffer({
      label: "nebula-storage",
      size:  1_600 * NEBULA_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
    });

    // ── Selected-star uniform (xyz pos + w=active flag, 16 bytes) ─────────────
    this.selectedStarBuffer = device.createBuffer({
      label: "selected-star",
      size:  16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.selectedStarBuffer, 0, new Float32Array([0, 0, 0, 0]));

    // ── LOD fade uniforms — 16-byte each (x=fade 0..1) ────────────────────
    this.starLodBuffer = device.createBuffer({
      label: "star-lod", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.mwLodBuffer = device.createBuffer({
      label: "mw-lod", size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Catalog stars stay visible as a render-only layer; named nearby-star labels
    // handle their own camera-distance fade in LabelManager.
    device.queue.writeBuffer(this.starLodBuffer, 0, new Float32Array([1, 0, 0, 0]));
    device.queue.writeBuffer(this.mwLodBuffer,   0, new Float32Array([1, 0, 0, 0]));

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
    });

    // ── Galaxy pipeline ────────────────────────────────────────────────────
    this.galaxyBGL = device.createBindGroupLayout({
      label: "galaxy-bgl",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      ],
    });
    this.galaxyBindGroup = device.createBindGroup({
      label: "galaxy-bg", layout: this.galaxyBGL,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.galaxyBuffer } },
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
    });
  }

  /** Store pre-sorted octant ranges for a catalog after sortIntoOctants(). */
  setStarOctants(ranges: OctantRange[]): void   { this.starOctants   = ranges; }
  setMwOctants(ranges: OctantRange[]): void     { this.mwOctants     = ranges; }
  setGalaxyOctants(ranges: OctantRange[]): void { this.galaxyOctants = ranges; }

  /**
   * Update which octants are visible this frame.
   * Call once per frame from the render loop with the current camera state.
   */
  setVisibleOctantMask(mask: number): void { this.visOctantMask = mask; }

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

  uploadGalaxies(galaxies: Float32Array): void {
    this.galaxyCount = galaxies.length / GALAXY_FLOATS;
    this.ctx.device.queue.writeBuffer(this.galaxyBuffer, 0, galaxies as GPUAllowSharedBufferSource);
  }

  uploadNebulas(nebulas: Float32Array): void {
    this.nebulaCount = nebulas.length / NEBULA_FLOATS;
    this.ctx.device.queue.writeBuffer(this.nebulaBuffer, 0, nebulas as GPUAllowSharedBufferSource);
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
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      const o = i * BODY_FLOATS;
      // vec4 pos_mass
      data[o+0]=b.x;  data[o+1]=b.y;  data[o+2]=b.z;  data[o+3]=b.mass;
      // vec4 vel_rad
      data[o+4]=b.vx; data[o+5]=b.vy; data[o+6]=b.vz; data[o+7]=b.radius;
      // vec4 acc_type (xy reserved; z=render visibility; btype in .w)
      data[o+8]=0; data[o+9]=0; data[o+10]=visibility.get(b.id) ?? 1; data[o+11]=b.type;
      // vec4 col_id
      data[o+12]=b.color[0]; data[o+13]=b.color[1]; data[o+14]=b.color[2]; data[o+15]=b.id;
    }
    this.ctx.device.queue.writeBuffer(this.bodyBuffer, 0, data);
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

  updateCamera(uniforms: CameraUniforms, canvasHeight: number): void {
    const MIN_PX = 2.5;
    const minNDCRadius = (MIN_PX * 2) / canvasHeight;

    // 96-byte layout:
    //   [0–63]  viewProj (mat4x4, 16 floats)
    //   [64–79] rightAndMNR (vec4: right.xyz, minNDCRadius)
    //   [80–95] upAndFocal  (vec4: up.xyz,    focalY)
    const data = new Float32Array(24);
    data.set(uniforms.viewProj, 0);
    data[16] = uniforms.camRight[0]; data[17] = uniforms.camRight[1]; data[18] = uniforms.camRight[2];
    data[19] = minNDCRadius;
    data[20] = uniforms.camUp[0];    data[21] = uniforms.camUp[1];    data[22] = uniforms.camUp[2];
    data[23] = uniforms.focalY;
    this.ctx.device.queue.writeBuffer(this.cameraBuffer, 0, data);
  }

  draw(trails: TrailSystem): void {
    const { device } = this.ctx;
    const view = this.canvasCtx.getCurrentTexture().createView();

    const encoder = device.createCommandEncoder({ label: "frame" });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view,
        clearValue: { r: 0.01, g: 0.01, b: 0.05, a: 1 },
        loadOp: "clear", storeOp: "store",
      }],
    });

    // Helper: draw visible octants of a catalog, or fall back to full draw.
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
        if (!(this.visOctantMask & (1 << q))) continue;
        const oct = octants[q]!;
        if (oct.count <= 0) continue;
        const count = Math.max(1, Math.round(oct.count * ratio));
        pass.draw(6, count, 0, oct.first);
      }
    };

    // ── Galaxies (furthest layer) ──────────────────────────────────────────
    pass.setPipeline(this.galaxyPipeline);
    pass.setBindGroup(0, this.galaxyBindGroup);
    drawOctants(
      this.galaxyOctants, this._galaxyLimit, this.galaxyCount,
      () => pass.draw(6, Math.min(this.galaxyCount, this._galaxyLimit), 0, 0),
    );

    // ── Nebulas (inside Milky Way — between galaxies and stars) ───────────
    if (this.nebulaCount > 0) {
      pass.setPipeline(this.nebulaPipeline);
      pass.setBindGroup(0, this.nebulaBindGroup);
      pass.draw(6, this.nebulaCount, 0, 0);
    }

    // ── Milky Way background stars (galaxy-scale LOD layer) ───────────────
    pass.setPipeline(this.mwPipeline);
    pass.setBindGroup(0, this.mwBindGroup);
    drawOctants(
      this.mwOctants, this._mwStarLimit, this.mwStarCount,
      () => pass.draw(6, Math.min(this.mwStarCount, this._mwStarLimit), 0, 0),
    );

    // ── Static catalog stars (nearby HYG, fades out when camera is far) ───
    pass.setPipeline(this.starPipeline);
    pass.setBindGroup(0, this.starBindGroup);
    drawOctants(
      this.starOctants, this._starLimit, this.starCount,
      () => pass.draw(6, Math.min(this.starCount, this._starLimit), 0, 0),
    );

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
    device.queue.submit([encoder.finish()]);
  }
}

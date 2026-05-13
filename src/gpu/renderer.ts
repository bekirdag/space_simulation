import renderWGSL from "./render.wgsl?raw";
import trailWGSL  from "./trail.wgsl?raw";
import { type GPUContext } from "./device";
import { type Body, BODY_FLOATS } from "../physics/body";
import { type TrailSystem, TRAIL_VTXFLOATS } from "../scene/trail-system";
import { type CameraUniforms } from "../scene/camera";

// Camera uniform: mat4 (64) + vec4 rightAndMNR (16) + vec4 upAndFocal (16) = 96 bytes
const CAMERA_BYTES = 96;

const TRAIL_VTXBUF_BYTES = 128 * 1500 * TRAIL_VTXFLOATS * 4; // ~6 MB (128 bodies × 1500 pts)

export class Renderer {
  private bodyPipeline!:  GPURenderPipeline;
  private trailPipeline!: GPURenderPipeline;

  private cameraBuffer!:      GPUBuffer;
  private bodyBuffer!:        GPUBuffer;
  private trailVertexBuffer!: GPUBuffer;

  private bodyBindGroup!:  GPUBindGroup;
  private trailBindGroup!: GPUBindGroup;

  private bodyCount = 0;

  constructor(
    private ctx: GPUContext,
    private canvasCtx: GPUCanvasContext,
  ) {}

  init(maxBodies: number): void {
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

  uploadBodies(bodies: Body[]): void {
    this.bodyCount = bodies.length;
    const data = new Float32Array(bodies.length * BODY_FLOATS);
    for (let i = 0; i < bodies.length; i++) {
      const b = bodies[i]!;
      const o = i * BODY_FLOATS;
      // vec4 pos_mass
      data[o+0]=b.x;  data[o+1]=b.y;  data[o+2]=b.z;  data[o+3]=b.mass;
      // vec4 vel_rad
      data[o+4]=b.vx; data[o+5]=b.vy; data[o+6]=b.vz; data[o+7]=b.radius;
      // vec4 acc_type (acc starts at 0; btype in .w)
      data[o+8]=0; data[o+9]=0; data[o+10]=0; data[o+11]=b.type;
      // vec4 col_id
      data[o+12]=b.color[0]; data[o+13]=b.color[1]; data[o+14]=b.color[2]; data[o+15]=b.id;
    }
    this.ctx.device.queue.writeBuffer(this.bodyBuffer, 0, data);
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

    // ── Trails ────────────────────────────────────────────────────────────
    pass.setPipeline(this.trailPipeline);
    pass.setBindGroup(0, this.trailBindGroup);
    let trailOffset = 0;
    for (const bodyId of trails.bodyIds) {
      const verts = trails.buildVertices(bodyId);
      if (!verts) continue;
      const bytes = verts.byteLength;
      if (trailOffset + bytes > TRAIL_VTXBUF_BYTES) break;
      device.queue.writeBuffer(this.trailVertexBuffer, trailOffset, new Float32Array(verts));
      pass.setVertexBuffer(0, this.trailVertexBuffer, trailOffset, bytes);
      pass.draw(verts.length / TRAIL_VTXFLOATS);
      trailOffset += bytes;
    }

    // ── Bodies ────────────────────────────────────────────────────────────
    pass.setPipeline(this.bodyPipeline);
    pass.setBindGroup(0, this.bodyBindGroup);
    pass.draw(6, this.bodyCount, 0, 0);

    pass.end();
    device.queue.submit([encoder.finish()]);
  }
}

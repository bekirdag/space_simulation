export interface GPUContext {
  device: GPUDevice;
  adapter: GPUAdapter;
  format: GPUTextureFormat;
}

export async function initGPU(canvas: HTMLCanvasElement): Promise<{
  ctx: GPUContext;
  canvasCtx: GPUCanvasContext;
}> {
  if (!navigator.gpu) throw new Error("WebGPU not supported in this browser.");

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter found.");

  const device = await adapter.requestDevice({
    label: "celestia-device",
  });

  device.lost.then((info) => {
    console.error("WebGPU device lost:", info.message);
  });

  const canvasCtx = canvas.getContext("webgpu");
  if (!canvasCtx) throw new Error("Failed to get WebGPU canvas context.");

  const format = navigator.gpu.getPreferredCanvasFormat();
  canvasCtx.configure({ device, format, alphaMode: "opaque" });

  return { ctx: { device, adapter, format }, canvasCtx };
}

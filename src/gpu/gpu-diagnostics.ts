/**
 * WebGPU diagnostics: shader compilation messages, pipeline / frame validation
 * errors, uncaptured device errors and a one-time render sanity probe, sent as
 * a compact JSON report to POST /api/client-diagnostics (once per session and
 * again, rate-limited, when new errors appear).
 *
 * It also tracks which render pipelines failed to create, so the renderer can
 * skip them: one invalid pipeline used in a pass invalidates the whole command
 * buffer, which would otherwise blank every layer of the frame.
 *
 * A small on-screen overlay lists the first GPU errors when the URL has
 * ?gpudebug=1, or inside the iPad app when a GPU error occurred.
 */

export type GpuDiagKind =
  | "shader-compile"
  | "shader-create"
  | "pipeline"
  | "frame"
  | "uncaptured"
  | "device-lost"
  | "probe"
  | "init";

export type GpuDiagSeverity = "error" | "warning" | "info";

export interface GpuDiagEntry {
  kind: GpuDiagKind;
  severity: GpuDiagSeverity;
  label: string;
  message: string;
  /** ms since page start of the first occurrence. */
  t: number;
  count: number;
}

export interface GpuProbeTexelStats {
  samples: number[][];
  nan: number;
  inf: number;
  allZero: boolean;
  constant: boolean;
  min: number[];
  max: number[];
}

export interface GpuProbeResult {
  frame: number;
  width: number;
  height: number;
  scene: GpuProbeTexelStats | null;
  output: GpuProbeTexelStats | null;
  outputFormat: string;
  presentPipeline: "blackhole" | "fallback";
  error?: string;
}

const REPORT_ENDPOINT = "/api/client-diagnostics";
const MAX_REPORT_BYTES = 60 * 1024;
const MAX_ENTRIES = 60;
const MAX_MESSAGE_CHARS = 1800;
const MAX_SENDS_PER_SESSION = 6;
const MIN_SEND_INTERVAL_MS = 30_000;
const ERROR_SEND_DEBOUNCE_MS = 4_000;
const BASELINE_FALLBACK_DELAY_MS = 15_000;
const FRAME_SCOPE_FRAMES = 3;
const OVERLAY_MAX_ENTRIES = 8;

function now(): number {
  return Math.round(performance.now());
}

/**
 * WebKit's pipeline errors embed the whole generated Metal source before the
 * actual compiler error; keep the head (what failed) and the tail (why).
 */
function clipMessage(message: string, max = MAX_MESSAGE_CHARS): string {
  const text = String(message ?? "").replace(/\s+\n/g, "\n");
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head - 24;
  return `${text.slice(0, head)}\n…[${text.length - head - tail} chars]…\n${text.slice(text.length - tail)}`;
}

function randomId(): string {
  try {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return Math.random().toString(16).slice(2, 18);
  }
}

function isEmbeddedNative(): boolean {
  return !!(window as { CosmosMapNative?: unknown }).CosmosMapNative;
}

function nativeVersion(): string | null {
  const native = (window as { CosmosMapNative?: { version?: unknown } }).CosmosMapNative;
  return typeof native?.version === "string" ? native.version : null;
}

function gpuDebugRequested(): boolean {
  try {
    return new URLSearchParams(window.location.search).get("gpudebug") === "1";
  } catch {
    return false;
  }
}

const LIMIT_KEYS = [
  "maxTextureDimension2D",
  "maxBindGroups",
  "maxBindingsPerBindGroup",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "maxBufferSize",
  "maxVertexBuffers",
  "maxVertexAttributes",
  "maxVertexBufferArrayStride",
  "maxInterStageShaderVariables",
  "maxInterStageShaderComponents",
  "maxColorAttachments",
  "maxColorAttachmentBytesPerSample",
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
] as const;

function pickLimits(limits: GPUSupportedLimits | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!limits) return out;
  for (const key of LIMIT_KEYS) {
    const value = (limits as unknown as Record<string, unknown>)[key];
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

async function adapterInfo(adapter: GPUAdapter): Promise<Record<string, unknown>> {
  const read = (info: GPUAdapterInfo | undefined | null): Record<string, unknown> => {
    if (!info) return {};
    const out: Record<string, unknown> = {};
    for (const key of ["vendor", "architecture", "device", "description", "subgroupMinSize", "subgroupMaxSize", "isFallbackAdapter"]) {
      const value = (info as unknown as Record<string, unknown>)[key];
      if (value !== undefined && value !== "") out[key] = value;
    }
    return out;
  };
  const direct = (adapter as unknown as { info?: GPUAdapterInfo }).info;
  if (direct) return read(direct);
  const legacy = (adapter as unknown as { requestAdapterInfo?: () => Promise<GPUAdapterInfo> }).requestAdapterInfo;
  if (typeof legacy === "function") {
    try {
      return read(await legacy.call(adapter));
    } catch {
      return {};
    }
  }
  return {};
}

type ErrorFilter = "validation" | "internal" | "out-of-memory";
const SCOPE_FILTERS: readonly ErrorFilter[] = ["validation", "internal", "out-of-memory"];

class GpuDiagnostics {
  readonly sessionId = randomId();
  private readonly entries = new Map<string, GpuDiagEntry>();
  private readonly broken = new WeakSet<object>();
  private readonly brokenLabels = new Set<string>();
  private readonly context: Record<string, unknown> = {};
  private device: GPUDevice | null = null;
  private adapter: GPUAdapter | null = null;
  private adapterDetails: Record<string, unknown> = {};
  private probe: GpuProbeResult | null = null;
  private framesScoped = 0;
  private sends = 0;
  private lastSendAt = -Infinity;
  private baselineSent = false;
  private sendTimer: number | null = null;
  private baselineTimer: number | null = null;
  private dirty = false;
  private overlayEl: HTMLElement | null = null;
  private overlayCollapsed = false;
  private readonly debug = gpuDebugRequested();
  private readonly native = isEmbeddedNative();
  private uncapturedCount = 0;

  /** Called once the device exists (before any shader/pipeline creation). */
  attach(device: GPUDevice, adapter: GPUAdapter, canvasFormat: GPUTextureFormat): void {
    this.device = device;
    this.adapter = adapter;
    this.context.canvasFormat = canvasFormat;
    this.context.features = Array.from(adapter.features ?? []).sort();
    this.context.deviceFeatures = Array.from(device.features ?? []).sort();
    this.context.adapterLimits = pickLimits(adapter.limits);
    this.context.deviceLimits = pickLimits(device.limits);
    this.context.requiredLimits = "none (WebGPU defaults)";
    void adapterInfo(adapter).then(info => {
      this.adapterDetails = info;
      this.renderOverlay();
    });

    device.addEventListener("uncapturederror", (event: Event) => {
      const error = (event as GPUUncapturedErrorEvent).error;
      this.uncapturedCount++;
      this.record("uncaptured", "error", error?.constructor?.name ?? "GPUError", error?.message ?? String(error));
    });
    device.lost.then(info => {
      if (info.reason === "destroyed") return;
      this.record("device-lost", "error", String(info.reason ?? "unknown"), info.message || "device lost");
      this.flushSoon(0);
    }).catch(() => { /* ignore */ });

    // Healthy sessions still send one baseline report, even if the probe never runs.
    this.baselineTimer = window.setTimeout(() => this.sendBaseline("timeout"), BASELINE_FALLBACK_DELAY_MS);
    if (this.debug) this.renderOverlay();
  }

  /** Records a fatal init failure (no adapter/device); sends immediately. */
  initFailure(message: string): void {
    this.record("init", "error", "initGPU", message);
    this.context.gpuInNavigator = "gpu" in navigator;
    this.flushSoon(0);
  }

  setContext(key: string, value: unknown): void {
    this.context[key] = value;
  }

  isBroken(obj: object | null | undefined): boolean {
    return !!obj && this.broken.has(obj);
  }

  hasErrors(): boolean {
    for (const entry of this.entries.values()) {
      if (entry.severity === "error") return true;
    }
    return false;
  }

  /** Creates a shader module inside error scopes and records its compilation messages. */
  createShaderModule(device: GPUDevice, label: string, code: string): GPUShaderModule {
    this.pushScopes(device);
    const module = device.createShaderModule({ label, code });
    this.popScopes(device, "shader-create", label, module);
    const getInfo = (module as { getCompilationInfo?: () => Promise<GPUCompilationInfo> }).getCompilationInfo;
    if (typeof getInfo === "function") {
      getInfo.call(module).then(info => {
        for (const msg of info.messages) {
          const severity: GpuDiagSeverity = msg.type === "error" ? "error" : msg.type === "warning" ? "warning" : "info";
          if (severity === "info") continue;
          const where = msg.lineNum ? `:${msg.lineNum}:${msg.linePos}` : "";
          this.record("shader-compile", severity, `${label}${where}`, msg.message);
          if (severity === "error") this.markBroken(module, label);
        }
      }).catch(err => {
        this.record("shader-compile", "warning", label, `getCompilationInfo failed: ${String(err)}`);
      });
    }
    return module;
  }

  /** Creates a render pipeline inside error scopes; a failed pipeline is marked broken. */
  createRenderPipeline(device: GPUDevice, descriptor: GPURenderPipelineDescriptor): GPURenderPipeline {
    const label = descriptor.label || "render-pipeline";
    this.pushScopes(device);
    const pipeline = device.createRenderPipeline(descriptor);
    this.popScopes(device, "pipeline", label, pipeline);
    return pipeline;
  }

  /** Wraps the first few frames' command encoding + submission in error scopes. */
  frameScopeBegin(device: GPUDevice): boolean {
    if (this.framesScoped >= FRAME_SCOPE_FRAMES) return false;
    this.pushScopes(device);
    return true;
  }

  frameScopeEnd(device: GPUDevice): void {
    const frame = ++this.framesScoped;
    this.popScopes(device, "frame", `frame ${frame}`, null);
  }

  recordProbe(result: GpuProbeResult): void {
    this.probe = result;
    const problems: string[] = [];
    for (const [name, stats] of [["scene", result.scene], ["output", result.output]] as const) {
      if (!stats) continue;
      if (stats.nan > 0) problems.push(`${name}: ${stats.nan} NaN`);
      if (stats.inf > 0) problems.push(`${name}: ${stats.inf} Inf`);
      if (stats.allZero) problems.push(`${name}: all sampled texels are zero`);
      else if (stats.constant) problems.push(`${name}: all sampled texels are identical`);
    }
    if (result.error) problems.push(result.error);
    if (problems.length) this.record("probe", "warning", "render-probe", problems.join("; "));
    this.renderOverlay();
    this.sendBaseline("probe");
  }

  /** Full report object (also exposed on window for console inspection). */
  report(reason: string): Record<string, unknown> {
    const canvas = document.querySelector("canvas");
    const entries = [...this.entries.values()]
      .sort((a, b) => (a.severity === b.severity ? a.t - b.t : a.severity === "error" ? -1 : 1))
      .slice(0, MAX_ENTRIES);
    return {
      v: 1,
      reason,
      session: this.sessionId,
      sentAtMs: now(),
      time: new Date().toISOString(),
      page: `${window.location.origin}${window.location.pathname}`,
      native: this.native,
      nativeVersion: nativeVersion(),
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      screen: [window.screen?.width ?? 0, window.screen?.height ?? 0],
      canvas: canvas ? [canvas.width, canvas.height] : null,
      adapter: this.adapterDetails,
      context: this.context,
      brokenPipelines: [...this.brokenLabels],
      uncapturedErrors: this.uncapturedCount,
      entries,
      probe: this.probe,
    };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private pushScopes(device: GPUDevice): void {
    for (const filter of SCOPE_FILTERS) device.pushErrorScope(filter);
  }

  private popScopes(device: GPUDevice, kind: GpuDiagKind, label: string, target: object | null): void {
    // Scopes pop in reverse push order.
    for (let i = SCOPE_FILTERS.length - 1; i >= 0; i--) {
      const filter = SCOPE_FILTERS[i]!;
      device.popErrorScope().then(error => {
        if (!error) return;
        this.record(kind, "error", `${label} [${filter}]`, error.message);
        if (target) this.markBroken(target, label);
      }).catch(err => {
        this.record(kind, "warning", label, `popErrorScope failed: ${String(err)}`);
      });
    }
  }

  private markBroken(target: object, label: string): void {
    this.broken.add(target);
    this.brokenLabels.add(label);
  }

  private record(kind: GpuDiagKind, severity: GpuDiagSeverity, label: string, message: string): void {
    const clipped = clipMessage(message);
    const key = `${kind}|${label}|${clipped.slice(0, 300)}`;
    const existing = this.entries.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    if (this.entries.size >= MAX_ENTRIES * 2) return;
    this.entries.set(key, { kind, severity, label, message: clipped, t: now(), count: 1 });
    const log = severity === "error" ? console.error : console.warn;
    log(`[gpu-diagnostics] ${kind} ${label}: ${clipped}`);
    this.renderOverlay();
    if (severity === "error") {
      this.dirty = true;
      if (this.baselineSent) this.flushSoon(ERROR_SEND_DEBOUNCE_MS);
    }
  }

  private sendBaseline(reason: string): void {
    if (this.baselineSent) return;
    this.baselineSent = true;
    if (this.baselineTimer !== null) {
      window.clearTimeout(this.baselineTimer);
      this.baselineTimer = null;
    }
    this.send(reason);
  }

  private flushSoon(delayMs: number): void {
    if (this.sendTimer !== null) return;
    const wait = Math.max(delayMs, this.lastSendAt + MIN_SEND_INTERVAL_MS - now(), 0);
    this.sendTimer = window.setTimeout(() => {
      this.sendTimer = null;
      if (!this.baselineSent) {
        this.sendBaseline("error");
      } else if (this.dirty) {
        this.send("new-errors");
      }
    }, wait);
  }

  private send(reason: string): void {
    (window as { __cosmosmapGpuDiagnostics?: unknown }).__cosmosmapGpuDiagnostics = this.report(reason);
    if (this.sends >= MAX_SENDS_PER_SESSION) return;
    this.sends++;
    this.lastSendAt = now();
    this.dirty = false;
    const body = this.serialize(reason);
    try {
      void fetch(new URL(REPORT_ENDPOINT, window.location.origin), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: body.length < 60_000,
        cache: "no-store",
        credentials: "omit",
      }).catch(() => { /* diagnostics are best-effort */ });
    } catch {
      // Ignore: fetch unavailable or blocked.
    }
  }

  private serialize(reason: string): string {
    const report = this.report(reason);
    let body = JSON.stringify(report);
    if (body.length <= MAX_REPORT_BYTES) return body;
    // Too big: shorten messages, then drop warnings, then entries.
    const entries = (report.entries as GpuDiagEntry[]).map(e => ({ ...e, message: clipMessage(e.message, 500) }));
    report.entries = entries;
    body = JSON.stringify(report);
    if (body.length <= MAX_REPORT_BYTES) return body;
    report.entries = entries.filter(e => e.severity === "error").slice(0, 20);
    body = JSON.stringify(report);
    if (body.length <= MAX_REPORT_BYTES) return body;
    report.entries = [];
    report.truncated = true;
    return JSON.stringify(report);
  }

  // ── overlay ───────────────────────────────────────────────────────────────

  private renderOverlay(): void {
    const errors = [...this.entries.values()].filter(e => e.severity === "error");
    const show = this.debug || (this.native && errors.length > 0);
    if (!show) return;
    if (!this.overlayEl) {
      const el = document.createElement("div");
      el.id = "gpu-diagnostics-overlay";
      el.setAttribute("role", "log");
      el.style.cssText = [
        "position:fixed", "left:8px", "right:8px", "bottom:8px", "z-index:150",
        "max-height:42vh", "overflow:auto", "padding:8px 10px", "border-radius:8px",
        "background:rgba(40,0,0,0.86)", "color:#ffd9d9", "border:1px solid rgba(255,120,120,0.5)",
        "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace", "white-space:pre-wrap",
        "word-break:break-word", "pointer-events:auto", "user-select:text", "-webkit-user-select:text",
      ].join(";");
      el.title = "Tap to collapse / expand";
      el.addEventListener("click", () => {
        this.overlayCollapsed = !this.overlayCollapsed;
        el.style.maxHeight = this.overlayCollapsed ? "1.6em" : "42vh";
        el.style.overflow = this.overlayCollapsed ? "hidden" : "auto";
      });
      document.body.appendChild(el);
      this.overlayEl = el;
    }
    const lines: string[] = [];
    const adapter = this.adapterDetails;
    lines.push(`GPU diagnostics · session ${this.sessionId}`);
    lines.push(`adapter: ${[adapter.vendor, adapter.architecture, adapter.device, adapter.description].filter(Boolean).join(" / ") || "?"}`);
    lines.push(`canvas: ${String(this.context.canvasFormat ?? "?")} ${document.querySelector("canvas")?.width ?? "?"}x${document.querySelector("canvas")?.height ?? "?"} dpr ${window.devicePixelRatio} quality ${String(this.context.quality ?? "?")}`);
    if (this.brokenLabels.size) lines.push(`skipped pipelines: ${[...this.brokenLabels].join(", ")}`);
    const shown = (this.debug ? [...this.entries.values()] : errors).slice(0, OVERLAY_MAX_ENTRIES);
    for (const entry of shown) {
      const count = entry.count > 1 ? ` ×${entry.count}` : "";
      lines.push(`• [${entry.severity}] ${entry.kind} ${entry.label}${count}: ${clipMessage(entry.message, 420)}`);
    }
    if (this.probe) {
      const fmt = (s: GpuProbeTexelStats | null) => s
        ? `nan ${s.nan} inf ${s.inf} zero ${s.allZero} const ${s.constant} max [${s.max.map(v => +v.toFixed(3)).join(",")}]`
        : "n/a";
      lines.push(`probe: scene ${fmt(this.probe.scene)} | output ${fmt(this.probe.output)} (${this.probe.presentPipeline})`);
    }
    this.overlayEl.textContent = lines.join("\n");
  }
}

export const gpuDiagnostics = new GpuDiagnostics();

// ── Probe helpers (used by the renderer) ─────────────────────────────────────

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 0x1f) return frac ? Number.NaN : sign * Number.POSITIVE_INFINITY;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

/** Decodes one texel per 256-byte row of `data` into RGBA channel values. */
export function decodeProbeTexels(
  data: ArrayBuffer,
  count: number,
  format: GPUTextureFormat,
): GpuProbeTexelStats {
  const samples: number[][] = [];
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  for (let i = 0; i < count; i++) {
    const base = i * 256;
    let rgba: number[];
    if (format === "rgba16float") {
      rgba = [0, 1, 2, 3].map(c => halfToFloat(view.getUint16(base + c * 2, true)));
    } else if (format === "bgra8unorm" || format === "bgra8unorm-srgb") {
      rgba = [bytes[base + 2]!, bytes[base + 1]!, bytes[base]!, bytes[base + 3]!].map(v => v / 255);
    } else {
      rgba = [bytes[base]!, bytes[base + 1]!, bytes[base + 2]!, bytes[base + 3]!].map(v => v / 255);
    }
    samples.push(rgba.map(v => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v)));
  }
  let nan = 0;
  let inf = 0;
  const min = [Infinity, Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity, -Infinity];
  for (const s of samples) {
    s.forEach((v, c) => {
      if (Number.isNaN(v)) nan++;
      else if (!Number.isFinite(v)) inf++;
      else {
        min[c] = Math.min(min[c]!, v);
        max[c] = Math.max(max[c]!, v);
      }
    });
  }
  const rgbKey = (s: number[]) => s.slice(0, 3).join(",");
  const allZero = samples.every(s => s.slice(0, 3).every(v => v === 0));
  const constant = samples.length > 1 && samples.every(s => rgbKey(s) === rgbKey(samples[0]!));
  // JSON has no NaN/Infinity: stringify them.
  const jsonSafe = samples.map(s => s.map(v => (Number.isFinite(v) ? v : (String(v) as unknown as number))));
  return {
    samples: jsonSafe,
    nan,
    inf,
    allZero,
    constant,
    min: min.map(v => (Number.isFinite(v) ? v : 0)),
    max: max.map(v => (Number.isFinite(v) ? v : 0)),
  };
}

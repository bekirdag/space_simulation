/**
 * Render-quality levels and an FPS-driven adaptive controller with hysteresis.
 *
 * "high" is the original desktop rendering (device-pixel ratio capped at 2,
 * full ray-march, 1/4-res bloom, all configured instances). "auto" starts at
 * medium on touch devices (high elsewhere), steps down when the frame rate
 * stays low and back up only after a long stable stretch.
 */

export type QualityMode = "auto" | "high" | "medium" | "low";
export type QualityLevel = "high" | "medium" | "low";

export interface QualityParams {
  /** Max canvas pixels per CSS pixel (applied as min(devicePixelRatio, cap)). */
  dprCap: number;
  /** Black-hole ray-march step length multiplier (1 = full detail). */
  blackHoleStepScale: number;
  /** Bloom buffer downscale factor. */
  bloomScale: number;
  /** Fraction of configured star/galaxy/dust instance limits drawn. */
  instanceScale: number;
}

export const QUALITY_PARAMS: Record<QualityLevel, QualityParams> = {
  high:   { dprCap: 2,   blackHoleStepScale: 1,   bloomScale: 4, instanceScale: 1 },
  medium: { dprCap: 1.5, blackHoleStepScale: 1.6, bloomScale: 4, instanceScale: 0.6 },
  low:    { dprCap: 1,   blackHoleStepScale: 2.5, bloomScale: 6, instanceScale: 0.35 },
};

const LEVELS: QualityLevel[] = ["low", "medium", "high"];

const WINDOW_MS = 2000;            // FPS averaged over this window
const WARMUP_MS = 2500;            // ignore frames after start/resize/level change/resume
const DOWNGRADE_FPS = 38;          // sustained below -> step down
const DOWNGRADE_WINDOWS = 2;
const UPGRADE_FPS = 56;            // sustained above -> step up
const UPGRADE_WINDOWS = 6;
const REUPGRADE_BLOCK_MS = 45_000; // after a downgrade, don't climb back to that level for a while

const STORAGE_KEY = "cosmosmap.quality";

export function loadQualityMode(fallback: QualityMode): QualityMode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "auto" || v === "high" || v === "medium" || v === "low") return v;
  } catch { /* storage unavailable */ }
  return fallback;
}

export function saveQualityMode(mode: QualityMode): void {
  try { window.localStorage.setItem(STORAGE_KEY, mode); } catch { /* storage unavailable */ }
}

export class AdaptiveQuality {
  private _mode: QualityMode;
  private _level: QualityLevel;
  private readonly autoStart: QualityLevel;
  private warmupUntil = 0;
  private windowStart = 0;
  private windowFrames = 0;
  private lowWindows = 0;
  private highWindows = 0;
  private blockedUpgradeTo: QualityLevel | null = null;
  private blockedUntil = 0;

  constructor(
    mode: QualityMode,
    autoStart: QualityLevel,
    private readonly onChange: (level: QualityLevel, params: QualityParams) => void,
  ) {
    this._mode = mode;
    this.autoStart = autoStart;
    this._level = mode === "auto" ? autoStart : mode;
    this.resetMeasurement();
  }

  get mode(): QualityMode { return this._mode; }
  get level(): QualityLevel { return this._level; }
  get params(): QualityParams { return QUALITY_PARAMS[this._level]; }

  setMode(mode: QualityMode): void {
    if (mode === this._mode) return;
    this._mode = mode;
    this.blockedUpgradeTo = null;
    const next = mode === "auto" ? this.autoStart : mode;
    this.applyLevel(next);
  }

  /** Discard the current measurement (resize, tab resumed, heavy one-off work). */
  resetMeasurement(): void {
    const now = performance.now();
    this.warmupUntil = now + WARMUP_MS;
    this.windowStart = now;
    this.windowFrames = 0;
  }

  /** Call once per rendered frame. */
  recordFrame(now: number): void {
    if (this._mode !== "auto" || document.hidden) return;
    if (now < this.warmupUntil) {
      this.windowStart = now;
      this.windowFrames = 0;
      return;
    }
    this.windowFrames++;
    const elapsed = now - this.windowStart;
    if (elapsed < WINDOW_MS) return;
    const fps = (this.windowFrames * 1000) / elapsed;
    this.windowStart = now;
    this.windowFrames = 0;

    if (fps < DOWNGRADE_FPS) {
      this.lowWindows++;
      this.highWindows = 0;
    } else if (fps > UPGRADE_FPS) {
      this.highWindows++;
      this.lowWindows = 0;
    } else {
      this.lowWindows = 0;
      this.highWindows = 0;
    }

    const idx = LEVELS.indexOf(this._level);
    if (this.lowWindows >= DOWNGRADE_WINDOWS && idx > 0) {
      this.blockedUpgradeTo = this._level;
      this.blockedUntil = now + REUPGRADE_BLOCK_MS;
      this.applyLevel(LEVELS[idx - 1]!);
    } else if (this.highWindows >= UPGRADE_WINDOWS && idx < LEVELS.length - 1) {
      const next = LEVELS[idx + 1]!;
      if (this.blockedUpgradeTo === next && now < this.blockedUntil) return;
      this.applyLevel(next);
    }
  }

  private applyLevel(level: QualityLevel): void {
    this.lowWindows = 0;
    this.highWindows = 0;
    this.resetMeasurement();
    this._level = level;
    this.onChange(level, QUALITY_PARAMS[level]);
  }
}

import { SECONDS_PER_YEAR } from "../physics/constants";

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Format a simulation date as "13 May 2035" (UTC). */
export function simToCalendar(epochMs: number, simYears: number): string {
  const ms = epochMs + simYears * SECONDS_PER_YEAR * 1000;
  const d  = new Date(ms);
  const yr = d.getUTCFullYear();

  // Very far future/past: just show the year
  if (yr < -9_999 || yr > 99_999) return `Year ${yr.toLocaleString()}`;

  const day = d.getUTCDate();
  const mon = MONTHS[d.getUTCMonth()]!;
  return `${day} ${mon} ${yr}`;
}

export class HUD {
  private fpsDom    = document.getElementById("hud-fps")!;
  private bodiesDom = document.getElementById("hud-bodies")!;
  private timeDom   = document.getElementById("hud-time")!;

  private frameTimes: number[] = [];

  // Set by main once Horizons data is fetched (or app start if fallback)
  epochMs = Date.now();

  recordFrame(dt: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
  }

  update(bodyCount: number, simYears: number): void {
    const avgDt = this.frameTimes.reduce((a, b) => a + b, 0) / (this.frameTimes.length || 1);
    const fps   = avgDt > 0 ? (1 / avgDt).toFixed(0) : '—';

    this.fpsDom.textContent    = `FPS ${fps}`;
    this.bodiesDom.textContent = `Bodies ${bodyCount}`;
    this.timeDom.textContent   = simToCalendar(this.epochMs, simYears);
  }
}

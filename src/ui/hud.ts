import { SECONDS_PER_YEAR } from "../physics/constants";

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/** Format a simulation date in the viewer's local timezone. */
export function simToCalendar(epochMs: number, simYears: number): string {
  const ms = epochMs + simYears * SECONDS_PER_YEAR * 1000;
  const d  = new Date(ms);
  const yr = d.getFullYear();

  if (yr < -9_999 || yr > 99_999) return `Year ${yr.toLocaleString()}`;

  const day = d.getDate();
  const mon = MONTHS[d.getMonth()]!;
  return `${day} ${mon} ${yr}`;
}

/** Format the time-of-day in the viewer's local timezone. */
function simToTime(epochMs: number, simYears: number): string {
  const ms = epochMs + simYears * SECONDS_PER_YEAR * 1000;
  const d  = new Date(ms);
  const h  = String(d.getHours()).padStart(2, '0');
  const m  = String(d.getMinutes()).padStart(2, '0');
  const s  = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export class HUD {
  private fpsDom      = document.getElementById("hud-fps")!;
  private bodiesDom   = document.getElementById("hud-bodies")!;
  private timeDom     = document.getElementById("hud-time")!;
  private clockDom    = document.getElementById("hud-clock")!;
  private galacticDom = document.getElementById("hud-galactic")!;

  private frameTimes: number[] = [];

  epochMs           = Date.now();
  galacticSpeedKms  = 0; // set each frame by main

  recordFrame(dt: number): void {
    this.frameTimes.push(dt);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
  }

  update(bodyCount: number, simYears: number): void {
    const avgDt = this.frameTimes.reduce((a, b) => a + b, 0) / (this.frameTimes.length || 1);
    const fps   = avgDt > 0 ? (1 / avgDt).toFixed(0) : '—';

    this.fpsDom.textContent      = `FPS ${fps}`;
    this.bodiesDom.textContent   = `Bodies ${bodyCount}`;
    this.timeDom.textContent     = simToCalendar(this.epochMs, simYears);
    this.clockDom.textContent    = simToTime(this.epochMs, simYears);
    this.galacticDom.textContent = this.galacticSpeedKms > 0
      ? `☀ ${Math.round(this.galacticSpeedKms).toLocaleString()} km/s galactic`
      : '';
  }
}

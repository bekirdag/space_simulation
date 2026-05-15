import { NEARBY_STAR_AU_PER_PARSEC } from "../catalog/nearby-stars";
import { GALAXY_KPC_TO_AU } from "../catalog/galaxies";

const AU_KM = 149_597_870.7;
const TARGET_BAR_PX = 150;
const SOLAR_CONTEXT_AU = 80;
const GALACTIC_CONTEXT_AU = 10_000;

interface ScaleUnit {
  label: string;
  unitAu: number;
  context: string;
}

function niceValue(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const f = value / base;
  const n = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return n * base;
}

function trimNumber(value: number): string {
  if (value >= 1_000) return Math.round(value).toLocaleString();
  if (value >= 100) return Math.round(value).toString();
  if (value >= 10) return value.toFixed(value % 1 === 0 ? 0 : 1);
  if (value >= 1) return value.toFixed(value % 1 === 0 ? 0 : 1);
  if (value >= 0.1) return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function unitFor(rawAu: number, contextDistanceAu: number): ScaleUnit {
  if (contextDistanceAu < SOLAR_CONTEXT_AU) {
    if (rawAu < 0.02) return { label: "km", unitAu: 1 / AU_KM, context: "solar scale" };
    return { label: "AU", unitAu: 1, context: "solar scale" };
  }

  if (contextDistanceAu < GALACTIC_CONTEXT_AU) {
    const rawPc = rawAu / NEARBY_STAR_AU_PER_PARSEC;
    if (rawPc < 0.08) return { label: "AU", unitAu: 1, context: "nearby-star scale" };
    if (rawPc < 1_000) return { label: "pc", unitAu: NEARBY_STAR_AU_PER_PARSEC, context: "nearby-star scale" };
    return { label: "kpc", unitAu: NEARBY_STAR_AU_PER_PARSEC * 1_000, context: "nearby-star scale" };
  }

  const rawKpc = rawAu / GALAXY_KPC_TO_AU;
  if (rawKpc < 0.08) return { label: "pc", unitAu: GALAXY_KPC_TO_AU / 1_000, context: "galactic scale" };
  if (rawKpc < 1_000) return { label: "kpc", unitAu: GALAXY_KPC_TO_AU, context: "galactic scale" };
  return { label: "Mpc", unitAu: GALAXY_KPC_TO_AU * 1_000, context: "galactic scale" };
}

export class ScaleBar {
  private root: HTMLDivElement;
  private rule: HTMLDivElement;
  private label: HTMLDivElement;
  private context: HTMLDivElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.id = "scale-bar";
    this.root.setAttribute("aria-label", "Current map scale");

    this.rule = document.createElement("div");
    this.rule.className = "scale-bar-rule";

    this.label = document.createElement("div");
    this.label.className = "scale-bar-label";

    this.context = document.createElement("div");
    this.context.className = "scale-bar-context";

    this.root.append(this.rule, this.label, this.context);
    document.body.appendChild(this.root);
  }

  update(auPerCssPixel: number, contextDistanceAu: number): void {
    if (!Number.isFinite(auPerCssPixel) || auPerCssPixel <= 0) {
      this.root.hidden = true;
      return;
    }

    const rawAu = auPerCssPixel * TARGET_BAR_PX;
    const unit = unitFor(rawAu, Math.max(0, contextDistanceAu));
    const niceUnits = niceValue(rawAu / unit.unitAu);
    const widthPx = Math.max(52, (niceUnits * unit.unitAu) / auPerCssPixel);

    this.rule.style.width = `${Math.round(widthPx)}px`;
    this.label.textContent = `${trimNumber(niceUnits)} ${unit.label}`;
    this.context.textContent = unit.context;
    this.root.hidden = false;
  }
}

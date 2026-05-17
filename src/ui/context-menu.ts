import { type Body } from "../physics/body";
import { BodyType } from "../physics/constants";
import { type CatalogStar } from "../catalog/stars";

/** Returns a CSS rgb() string from a [0–1] color triple. */
function rgb(c: [number, number, number]): string {
  return `rgb(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)})`;
}

function bodyTypeLabel(type: number): string {
  switch (type) {
    case BodyType.Star:        return "Star";
    case BodyType.Planet:      return "Planet";
    case BodyType.DwarfPlanet: return "Dwarf planet";
    case BodyType.Moon:        return "Moon";
    case BodyType.Exoplanet:   return "Exoplanet";
    default:                   return "";
  }
}

export class ContextMenu {
  private el:      HTMLElement;
  private listEl:  HTMLElement;
  private visible  = false;

  constructor() {
    this.el     = document.getElementById("ctx-menu")!;
    this.listEl = document.getElementById("ctx-menu-list")!;

    document.addEventListener("mousedown", (e) => {
      if (this.visible && !this.el.contains(e.target as Node)) this.hide();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hide();
    });
  }

  show(
    screenX: number,
    screenY: number,
    bodies: Body[],
    onSelectBody: (body: Body) => void,
    catalogStars: CatalogStar[] = [],
    onSelectStar:  (star: CatalogStar) => void = () => {},
    galaxies: { name: string; dist: number; x: number; y: number; z: number }[] = [],
    onSelectGalaxy: (g: { name: string; dist: number; x: number; y: number; z: number }) => void = () => {},
    nebulas: { name: string; type: number; x: number; y: number; z: number; radiusAU: number }[] = [],
    onSelectNebula: (n: { name: string; type: number; x: number; y: number; z: number; radiusAU: number }) => void = () => {},
  ): void {
    const totalItems = bodies.length + catalogStars.length + galaxies.length + nebulas.length;
    if (totalItems === 0) { this.hide(); return; }

    this.listEl.replaceChildren();

    // ── Body groups ────────────────────────────────────────────────────────
    const solar = bodies.filter(b =>
      b.type === BodyType.Star || b.type === BodyType.Planet ||
      b.type === BodyType.DwarfPlanet || b.type === BodyType.Moon,
    );
    const exoplanets = bodies.filter(b => !solar.includes(b));

    const addBodyItem = (body: Body) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctx-item";

      const dot = document.createElement("span");
      dot.className = "ctx-dot";
      dot.style.background = rgb(body.color);

      const label = document.createElement("span");
      label.className = "ctx-label";
      label.textContent = body.name;

      const sub = document.createElement("span");
      sub.className = "ctx-sub";
      sub.textContent = bodyTypeLabel(body.type);

      btn.append(dot, label, sub);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hide();
        onSelectBody(body);
      });
      this.listEl.appendChild(btn);
    };

    const addStar = (star: CatalogStar) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctx-item";

      const dot = document.createElement("span");
      dot.className = "ctx-dot";
      dot.style.background = rgb(star.color);

      const label = document.createElement("span");
      label.className = "ctx-label";
      label.textContent = star.name;

      const sub = document.createElement("span");
      sub.className = "ctx-sub";
      const dist = star.distancePc != null ? `${star.distancePc < 100 ? star.distancePc.toFixed(1) : Math.round(star.distancePc)} pc` : "";
      const plStr = star.planetCount > 0 ? `${star.planetCount}p` : "";
      sub.textContent = [plStr, dist].filter(Boolean).join(" · ") || "star";

      btn.append(dot, label, sub);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hide();
        onSelectStar(star);
      });
      this.listEl.appendChild(btn);
    };

    const addSep = () => {
      const s = document.createElement("div");
      s.className = "ctx-sep";
      this.listEl.appendChild(s);
    };

    // Galaxy helper
    const addGalaxy = (g: { name: string; dist: number; x: number; y: number; z: number }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctx-item";

      const dot = document.createElement("span");
      dot.className = "ctx-dot";
      // Warm elliptical-ish default colour for galaxies
      dot.style.background = "rgb(220,190,130)";

      const label = document.createElement("span");
      label.className = "ctx-label";
      label.textContent = g.name;

      const sub = document.createElement("span");
      sub.className = "ctx-sub";
      sub.textContent = g.dist > 0
        ? `${g.dist < 10 ? g.dist.toFixed(1) : Math.round(g.dist)} Mpc`
        : "galaxy";

      btn.append(dot, label, sub);
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hide();
        onSelectGalaxy(g);
      });
      this.listEl.appendChild(btn);
    };

    // Solar system bodies first
    solar.forEach(addBodyItem);

    // Then exoplanet simulation bodies
    if (solar.length > 0 && exoplanets.length > 0) addSep();
    exoplanets.forEach(addBodyItem);

    // Then catalog stars
    if (bodies.length > 0 && catalogStars.length > 0) addSep();
    catalogStars.forEach(addStar);

    // Then galaxies (furthest extragalactic)
    if ((bodies.length + catalogStars.length) > 0 && galaxies.length > 0) addSep();
    galaxies.slice(0, 8).forEach(addGalaxy);

    // Nebula helper
    const nebTypeLabel = (t: number) =>
      ['Emission', 'Planetary', 'Supernova remnant', 'Reflection', 'Mixed'][t] ?? 'Nebula';
    // Nebula dot colour from NEB_COLOR approximation (without importing full catalog)
    const nebDotCol = (t: number) =>
      [['#fa3860','Emission'],['#59f2cc','Planetary'],['#6bb8ff','SNR'],
       ['#8db8ff','Reflection'],['#e05990','Mixed']][t]?.[0] ?? '#aaa';

    const addNebula = (n: { name: string; type: number; x: number; y: number; z: number; radiusAU: number }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ctx-item";

      const dot = document.createElement("span");
      dot.className = "ctx-dot";
      dot.style.background = nebDotCol(n.type);

      const label = document.createElement("span");
      label.className = "ctx-label";
      label.textContent = n.name;

      const sub = document.createElement("span");
      sub.className = "ctx-sub";
      sub.textContent = nebTypeLabel(n.type);

      btn.append(dot, label, sub);
      btn.addEventListener("click", (e2) => {
        e2.stopPropagation();
        this.hide();
        onSelectNebula(n);
      });
      this.listEl.appendChild(btn);
    };

    // Nebulas (inside Milky Way — relevant when inside the galaxy view)
    if ((bodies.length + catalogStars.length + galaxies.length) > 0 && nebulas.length > 0) addSep();
    nebulas.slice(0, 6).forEach(addNebula);

    // ── Position ───────────────────────────────────────────────────────────
    this.el.style.display = "block";
    this.el.style.visibility = "hidden";

    const W  = window.innerWidth;
    const H  = window.innerHeight;
    const mw = this.el.offsetWidth  || 200;
    const mh = this.el.offsetHeight || totalItems * 30 + 12;

    let left = screenX + 12;
    let top  = screenY - Math.min(mh / 2, screenY - 10);

    if (left + mw > W - 8)  left = screenX - mw - 12;
    if (top  < 8)            top  = 8;
    if (top  + mh > H - 8)  top  = H - mh - 8;

    this.el.style.left       = `${Math.max(8, left)}px`;
    this.el.style.top        = `${top}px`;
    this.el.style.visibility = "";
    this.visible = true;
  }

  hide(): void {
    this.el.style.display = "none";
    this.visible = false;
  }

  get isVisible(): boolean { return this.visible; }
}

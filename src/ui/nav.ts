import { type Body } from "../physics/body";
import { type Camera } from "../scene/camera";
import { MOON_ZOOM, SYSTEM_VIEW } from "../physics/moons";

const PLANET_DIST: Record<string, number> = {
  Sun:5, Mercury:0.2, Venus:0.3, Earth:0.3, Mars:0.3,
  Jupiter:1.5, Saturn:2.0, Uranus:1.2, Neptune:1.2,
};

const TRAVEL_DIST: Record<string, number> = { ...PLANET_DIST, ...MOON_ZOOM };

export class NavPanel {
  private panel:   HTMLElement;
  private toggle:  HTMLElement;
  private search:  HTMLInputElement;
  private open     = true;

  constructor(
    private camera:    Camera,
    private getBodies: () => Body[],
    private onPreset:  (name: string) => void,
  ) {
    this.panel  = document.getElementById("nav-panel")!;
    this.toggle = document.getElementById("nav-toggle")!;
    this.search = document.getElementById("nav-search") as HTMLInputElement;

    this.toggle.addEventListener("click", () => this.setOpen(!this.open));
    this.search.addEventListener("input",  () => this.filter());
    this.search.addEventListener("click",  e => e.stopPropagation()); // don't bubble to canvas

    this.bindLinks();
  }

  private bindLinks(): void {
    this.panel.querySelectorAll<HTMLElement>("[data-travel]").forEach((el) => {
      el.addEventListener("click", () => {
        const name = el.dataset["travel"]!;
        this.travelTo(name);
      });
    });

    this.panel.querySelectorAll<HTMLElement>("[data-preset]").forEach((el) => {
      el.addEventListener("click", () => this.onPreset(el.dataset["preset"]!));
    });
  }

  /** Travel to a named body. Called from nav clicks AND canvas clicks. */
  travelTo(name: string): void {
    const body = this.getBodies().find(b => b.name === name);
    if (!body) return;
    const dist = TRAVEL_DIST[name] ?? 0.5;
    this.camera.travelTo(body.x, body.y, body.z, dist);
  }

  /** Travel to a planet with a zoom that shows all its moons. */
  travelToSystem(name: string): void {
    const body = this.getBodies().find(b => b.name === name);
    if (!body) return;
    const dist = SYSTEM_VIEW[name] ?? TRAVEL_DIST[name] ?? 0.5;
    this.camera.travelTo(body.x, body.y, body.z, dist);
  }

  private filter(): void {
    const q = this.search.value.trim().toLowerCase();

    // Show/hide individual travel items
    this.panel.querySelectorAll<HTMLElement>("[data-travel]").forEach(el => {
      const name = (el.dataset["travel"] ?? "").toLowerCase();
      const text = (el.textContent ?? "").toLowerCase();
      el.style.display = (!q || name.includes(q) || text.includes(q)) ? "" : "none";
    });

    // Show/hide preset items
    this.panel.querySelectorAll<HTMLElement>("[data-preset]").forEach(el => {
      const text = (el.textContent ?? "").toLowerCase();
      el.style.display = (!q || text.includes(q)) ? "" : "none";
    });

    // Hide section headers + dividers when all their items are hidden
    this.panel.querySelectorAll<HTMLElement>(".nav-section-block").forEach(block => {
      const hasVisible = Array.from(
        block.querySelectorAll<HTMLElement>("[data-travel],[data-preset]"),
      ).some(el => el.style.display !== "none");
      block.style.display = hasVisible ? "" : "none";
    });
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.classList.toggle("collapsed", !open);
    this.toggle.textContent = open ? "›" : "‹";
  }
}

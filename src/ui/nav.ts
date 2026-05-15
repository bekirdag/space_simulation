import { type Body } from "../physics/body";
import { type Camera } from "../scene/camera";
import {
  MOON_ZOOM,
  systemCenterForBody,
  systemMembersForBody,
  systemViewDistanceForBody,
} from "../physics/moons";
import { type StarSearchResult } from "../catalog/stars";

const DEFAULT_TRAVEL_DIST = 0.5;
const MOON_SYSTEM_PADDING = 1.15;
const MOON_SYSTEM_VIEW_FILL = 0.82;

type TravelMode = "system" | "close";

interface CatalogSearchOptions {
  searchCatalog:      (query: string) => StarSearchResult[];
  getCatalogStatus:   () => string;
  /** Called when any catalog search result is clicked, with its id. */
  onCatalogItemClick?: (id: string) => void;
}

export class NavPanel {
  private panel:   HTMLElement;
  private toggle:  HTMLElement;
  private search:  HTMLInputElement;
  private catalogResults: HTMLElement;
  private _focusedBodyName: string | null = null;
  private focusedSystemCenterName: string | null = null;
  private _selectedCatalogStar: StarSearchResult | null = null;
  private open     = true;

  /** The catalog star (exoplanet host) most recently selected from search results. */
  get selectedCatalogStar(): StarSearchResult | null { return this._selectedCatalogStar; }

  /** Select a catalog star externally (e.g. from the right-click context menu). */
  selectCatalogStar(hit: StarSearchResult): void {
    this.clearFocusedBody();
    this._selectedCatalogStar = hit;
    this.camera.travelTo(hit.x, hit.y, hit.z, hit.focusDistance);
  }

  constructor(
    private camera:    Camera,
    private getBodies: () => Body[],
    private onPreset:  (name: string) => void,
    private catalogSearch?: CatalogSearchOptions,
  ) {
    this.panel  = document.getElementById("nav-panel")!;
    this.toggle = document.getElementById("nav-toggle")!;
    this.search = document.getElementById("nav-search") as HTMLInputElement;
    this.catalogResults = document.getElementById("catalog-search-results")!;

    this.toggle.addEventListener("click", () => this.setOpen(!this.open));
    this.search.addEventListener("input",  () => this.filter());
    this.search.addEventListener("click",  e => e.stopPropagation()); // don't bubble to canvas
    this.catalogResults.addEventListener("click", e => e.stopPropagation());

    this.bindLinks();
  }

  private bindLinks(): void {
    this.panel.querySelectorAll<HTMLElement>("[data-travel]").forEach((el) => {
      el.addEventListener("click", () => {
        const name = el.dataset["travel"]!;
        this.travelTo(name, "system");
      });
      el.addEventListener("dblclick", () => {
        const name = el.dataset["travel"]!;
        this.travelTo(name, "close");
      });
    });

    this.panel.querySelectorAll<HTMLElement>("[data-preset]").forEach((el) => {
      el.addEventListener("click", () => {
        this.clearFocusedBody();
        this.onPreset(el.dataset["preset"]!);
      });
    });
  }

  private bodyByName(name: string): Body | undefined {
    return this.getBodies().find(b => b.name === name);
  }

  private travelDistanceFor(name: string): number {
    return systemViewDistanceForBody(name) ?? MOON_ZOOM[name] ?? DEFAULT_TRAVEL_DIST;
  }

  private systemDistanceFor(name: string, target: Body): number | null {
    const memberNames = new Set(systemMembersForBody(name));
    const members = this.getBodies().filter(body => memberNames.has(body.name));
    if (members.length <= 1) return null;

    const systemRadius = members.reduce((max, member) => Math.max(
      max,
      Math.hypot(member.x - target.x, member.y - target.y, member.z - target.z) + member.radius,
    ), 0);
    if (systemRadius <= 0) return null;
    return this.camera.distanceForViewRadius(systemRadius * MOON_SYSTEM_PADDING, MOON_SYSTEM_VIEW_FILL);
  }

  private closeDistanceFor(name: string, body: Body): number {
    const bodyDistance = this.camera.closeDistanceForRadius(body.radius);
    const systemDistance = this.systemDistanceFor(name, body);
    return systemDistance === null ? bodyDistance : Math.max(bodyDistance, systemDistance);
  }

  private distanceFor(name: string, body: Body, mode: TravelMode): number {
    if (mode === "close") return this.closeDistanceFor(name, body);
    return this.systemDistanceFor(name, body) ?? this.travelDistanceFor(name);
  }

  /** Public read access so main.ts can implement auto-snap/release logic. */
  get focusedBodyName(): string | null { return this._focusedBodyName; }

  focusedSystemMembers(): ReadonlySet<string> {
    if (!this.focusedSystemCenterName) return new Set();
    return new Set(systemMembersForBody(this.focusedSystemCenterName));
  }

  private setFocusedSystem(name: string): void {
    this.focusedSystemCenterName = systemCenterForBody(name);
  }

  private clearFocusedSystem(): void {
    this.focusedSystemCenterName = null;
  }

  private setFocusedBody(name: string): void {
    this._focusedBodyName = name;
    this._selectedCatalogStar = null; // simulation body takes over; dismiss star selection
    this.setFocusedSystem(name);
    this.camera.lockTarget = true; // scroll zooms orbit radius, not toward cursor
    let focusedEl: HTMLElement | undefined;
    this.panel.querySelectorAll<HTMLElement>("[data-travel]").forEach(el => {
      const isFocused = el.dataset["travel"] === name;
      el.classList.toggle("focused", isFocused);
      if (isFocused) focusedEl = el;
    });
    if (focusedEl) (focusedEl as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  clearFocusedBody(): void {
    this._focusedBodyName = null;
    this._selectedCatalogStar = null; // clear star selection when focusing a body
    this.clearFocusedSystem();
    this.camera.lockTarget = false; // re-enable zoom-toward-cursor
    this.panel.querySelectorAll<HTMLElement>("[data-travel].focused").forEach(el => {
      el.classList.remove("focused");
    });
  }

  updateFocusedBody(): void {
    if (!this._focusedBodyName) return;
    const body = this.bodyByName(this._focusedBodyName!);
    if (!body) {
      this.clearFocusedBody();
      return;
    }
    this.camera.target = [body.x, body.y, body.z];
  }

  /** Travel to a named body. Called from nav clicks AND canvas clicks. */
  travelTo(name: string, mode: TravelMode = "system"): void {
    const body = this.bodyByName(name);
    if (!body) return;
    const dist = this.distanceFor(name, body, mode);
    this.setFocusedBody(name);
    this.camera.travelTo(body.x, body.y, body.z, dist);
  }

  /** Travel to a planet with a zoom that shows all its moons. */
  travelToSystem(name: string): void {
    this.travelTo(name, "system");
  }

  /** Travel close; planets with known moons keep their local moon system in frame. */
  travelToClose(name: string): void {
    this.travelTo(name, "close");
  }

  private filter(): void {
    const q = this.search.value.trim().toLowerCase();
    const searchingCatalog = q.length >= 2;

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

    const catalogHits = this.catalogSearch?.searchCatalog(q) ?? [];
    this.renderCatalogResults(searchingCatalog ? q : "", catalogHits);
  }

  private renderCatalogResults(query: string, hits: StarSearchResult[]): void {
    this.catalogResults.replaceChildren();
    this.catalogResults.hidden = !query;
    if (!query) return;

    if (hits.length === 0) {
      const status = this.catalogSearch?.getCatalogStatus() ?? "";
      const isLoading = status.startsWith("Loading");
      const empty = document.createElement("div");
      empty.className = "catalog-search-empty";
      if (isLoading) {
        empty.textContent = status;
      } else {
        empty.innerHTML =
          `No match for "<b>${query}</b>".<br>` +
          `Catalog: exoplanet host stars only.<br>` +
          `Try: <em>TRAPPIST-1, Proxima, 51 Peg, HD 209, Kepler</em>`;
      }
      this.catalogResults.appendChild(empty);
      return;
    }

    for (const hit of hits) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "catalog-search-item";
      btn.dataset["starId"] = hit.id;

      const swatch = document.createElement("span");
      swatch.className = "catalog-search-dot";
      swatch.style.background = `rgb(${Math.round(hit.color[0] * 255)}, ${Math.round(hit.color[1] * 255)}, ${Math.round(hit.color[2] * 255)})`;

      const copy = document.createElement("span");
      copy.className = "catalog-search-copy";

      const label = document.createElement("span");
      label.className = "catalog-search-label";
      label.textContent = hit.label;

      const subtitle = document.createElement("span");
      subtitle.className = "catalog-search-subtitle";
      subtitle.textContent = hit.subtitle;

      copy.append(label, subtitle);
      btn.append(swatch, copy);
      btn.addEventListener("click", () => {
        this.clearFocusedBody();
        this._selectedCatalogStar = hit;
        this.camera.travelTo(hit.x, hit.y, hit.z, hit.focusDistance);
        this.search.value = hit.label;
        this.renderCatalogResults("", []);
        // Notify main.ts so it can load exoplanet bodies for this star/planet
        this.catalogSearch?.onCatalogItemClick?.(hit.id);
      });

      this.catalogResults.appendChild(btn);
    }
  }

  private setOpen(open: boolean): void {
    this.open = open;
    this.panel.classList.toggle("collapsed", !open);
    this.toggle.textContent = open ? "›" : "‹";
  }
}

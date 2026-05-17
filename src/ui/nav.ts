import { type Body } from "../physics/body";
import { type Camera } from "../scene/camera";
import {
  MOON_ZOOM,
  systemCenterForBody,
  systemMembersForBody,
  systemViewDistanceForBody,
} from "../physics/moons";
import { BodyType } from "../physics/constants";
import { type StarSearchResult } from "../catalog/stars";

const DEFAULT_TRAVEL_DIST = 0.5;
const MOON_SYSTEM_PADDING = 1.15;
const MOON_SYSTEM_VIEW_FILL = 0.82;
const CLOSE_TRAVEL_SECONDS = 2;

type TravelMode = "system" | "close";

interface CatalogSearchOptions {
  searchCatalog:      (query: string) => StarSearchResult[];
  getCatalogStatus:   () => string;
  modelObjects?:      readonly StarSearchResult[];
  /** Called when any catalog search result is clicked, with its id. */
  onCatalogItemClick?: (id: string) => void;
  /** Called when navigation focus changes so the page can show the current focus. */
  onFocusTitleChange?: (title: string | null, subtitle?: string, objectType?: string) => void;
}

export class NavPanel {
  private panel:   HTMLElement;
  private toggle:  HTMLElement;
  private search:  HTMLInputElement;
  private catalogResults: HTMLElement;
  private modelList: HTMLElement | null = null;
  private modelPager: HTMLElement | null = null;
  private _focusedBodyName: string | null = null;
  private focusedSystemCenterName: string | null = null;
  private _selectedCatalogStar: StarSearchResult | null = null;
  private focusedBodyTracksCamera = false;
  private selectedCatalogTracksCamera = false;
  private enterKeyCenteredLock = false;
  private modelPage = 0;
  private readonly modelPageSize = 10;
  private open     = true;

  /** The catalog/map object most recently selected from search results or map labels. */
  get selectedCatalogStar(): StarSearchResult | null { return this._selectedCatalogStar; }
  get shouldTrackSelectedCatalogStar(): boolean { return this.selectedCatalogTracksCamera; }

  /** Select a catalog/map object externally (e.g. from search or the map). */
  selectCatalogStar(hit: StarSearchResult, durationSeconds = 0): void {
    this.clearFocusedBody();
    this.resetEnterKeyNavigation();
    this._selectedCatalogStar = hit;
    this.selectedCatalogTracksCamera = true;
    this.catalogSearch?.onFocusTitleChange?.(hit.label, hit.subtitle, this.catalogObjectType(hit));
    this.camera.travelTo(hit.x, hit.y, hit.z, hit.focusDistance, durationSeconds);
    this.camera.lockTarget = true;
  }

  selectCatalogStarForWheelZoom(hit: StarSearchResult, wheelSteps = 10): void {
    this.clearFocusedBody();
    this.resetEnterKeyNavigation();
    this._selectedCatalogStar = hit;
    this.selectedCatalogTracksCamera = false;
    this.catalogSearch?.onFocusTitleChange?.(hit.label, hit.subtitle, this.catalogObjectType(hit));
    this.camera.lockTarget = false;
    this.camera.setWheelZoomPointGoal(hit.x, hit.y, hit.z, hit.focusDistance, wheelSteps);
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
    this.modelList = document.getElementById("mw-model-list");
    this.modelPager = document.getElementById("mw-model-pagination");

    this.toggle.addEventListener("click", () => this.setOpen(!this.open));
    this.search.addEventListener("input",  () => this.filter());
    this.search.addEventListener("click",  e => e.stopPropagation()); // don't bubble to canvas
    this.catalogResults.addEventListener("click", e => e.stopPropagation());

    this.bindLinks();
    this.renderModelList();
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

  private bodyObjectType(body: Body | undefined): string {
    if (!body) return "object";
    switch (body.type) {
      case BodyType.Star: return "star";
      case BodyType.Planet: return "planet";
      case BodyType.Moon: return "moon";
      case BodyType.Asteroid: return "asteroid";
      case BodyType.DwarfPlanet: return "dwarf planet";
      case BodyType.Exoplanet: return "exoplanet";
      default: return "object";
    }
  }

  private catalogObjectType(hit: StarSearchResult): string {
    if (hit.id.startsWith("blackhole:")) return "black hole";
    if (hit.id.startsWith("galaxy:")) return "galaxy";
    if (hit.id.startsWith("constellation:")) return "constellation";
    if (hit.id.startsWith("mwmodel:")) return "3D model";
    if (hit.id.startsWith("nebula:")) return "nebula";
    if (hit.id.startsWith("exo:")) return "exoplanet";
    if (hit.id.startsWith("nearby:")) return "star";
    return "exoplanet host star";
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

  private closeDistanceFor(body: Body): number {
    return this.camera.closeDistanceForRadius(body.radius);
  }

  private distanceFor(name: string, body: Body, mode: TravelMode): number {
    if (mode === "close") return this.closeDistanceFor(body);
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

  private setFocusedBody(name: string, trackCamera = true): void {
    const body = this.bodyByName(name);
    this.resetEnterKeyNavigation();
    this._focusedBodyName = name;
    this._selectedCatalogStar = null; // simulation body takes over; dismiss star selection
    this.focusedBodyTracksCamera = trackCamera;
    this.selectedCatalogTracksCamera = false;
    this.setFocusedSystem(name);
    this.catalogSearch?.onFocusTitleChange?.(name, "", this.bodyObjectType(body));
    this.camera.lockTarget = trackCamera; // scroll zooms orbit radius only after the camera is tracking.
    let focusedEl: HTMLElement | undefined;
    this.panel.querySelectorAll<HTMLElement>("[data-travel]").forEach(el => {
      const isFocused = el.dataset["travel"] === name;
      el.classList.toggle("focused", isFocused);
      if (isFocused) focusedEl = el;
    });
    if (focusedEl) (focusedEl as HTMLElement).scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  clearFocusedBody(): void {
    this.resetEnterKeyNavigation();
    this._focusedBodyName = null;
    this._selectedCatalogStar = null; // clear star selection when focusing a body
    this.focusedBodyTracksCamera = false;
    this.selectedCatalogTracksCamera = false;
    this.clearFocusedSystem();
    this.catalogSearch?.onFocusTitleChange?.(null);
    this.camera.clearWheelZoomGoal();
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
    if (!this.focusedBodyTracksCamera) {
      this.camera.updateWheelZoomPoint(body.x, body.y, body.z);
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
    this.camera.travelTo(body.x, body.y, body.z, dist, mode === "close" ? CLOSE_TRAVEL_SECONDS : 0);
  }

  /** Travel to a planet with a zoom that shows all its moons. */
  travelToSystem(name: string): void {
    this.travelTo(name, "system");
  }

  /** Travel close enough for the selected body itself to fit the screen. */
  travelToClose(name: string): void {
    this.travelTo(name, "close");
  }

  /** Keep the current camera eye but make this body the next wheel-zoom target. */
  focusBodyForWheelZoom(name: string, wheelSteps = 10): void {
    const body = this.bodyByName(name);
    if (!body) return;
    this.setFocusedBody(name, false);
    this.camera.setWheelZoomPointGoal(body.x, body.y, body.z, this.closeDistanceFor(body), wheelSteps);
  }

  private resetEnterKeyNavigation(): void {
    this.enterKeyCenteredLock = false;
  }

  /** First Enter centers the locked object; the next Enter flies close in 2 seconds. */
  handleLockedObjectEnter(): boolean {
    if (this._focusedBodyName) {
      const body = this.bodyByName(this._focusedBodyName);
      if (!body) {
        this.clearFocusedBody();
        return false;
      }

      if (!this.enterKeyCenteredLock) {
        this.travelToSystem(body.name);
        this.enterKeyCenteredLock = true;
        return true;
      }

      this.travelToClose(body.name);
      this.enterKeyCenteredLock = true;
      return true;
    }

    const selected = this._selectedCatalogStar;
    if (!selected) return false;

    if (!this.enterKeyCenteredLock) {
      this.selectedCatalogTracksCamera = true;
      this.camera.focusFromCurrentView(
        selected.x,
        selected.y,
        selected.z,
        selected.focusDistance,
      );
      this.camera.lockTarget = true;
      this.enterKeyCenteredLock = true;
      return true;
    }

    this.selectCatalogStar(selected, CLOSE_TRAVEL_SECONDS);
    this.enterKeyCenteredLock = true;
    return true;
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

    this.panel.querySelectorAll<HTMLElement>("[data-catalog-model]").forEach(el => {
      const text = (el.textContent ?? "").toLowerCase();
      el.style.display = (!q || text.includes(q)) ? "" : "none";
    });

    // Hide section headers + dividers when all their items are hidden
    this.panel.querySelectorAll<HTMLElement>(".nav-section-block").forEach(block => {
      const hasVisible = Array.from(
        block.querySelectorAll<HTMLElement>("[data-travel],[data-preset],[data-catalog-model]"),
      ).some(el => el.style.display !== "none");
      block.style.display = hasVisible ? "" : "none";
    });

    const catalogHits = this.catalogSearch?.searchCatalog(q) ?? [];
    this.renderCatalogResults(searchingCatalog ? q : "", catalogHits);
  }

  private renderModelList(): void {
    if (!this.modelList || !this.modelPager) return;
    const models = this.catalogSearch?.modelObjects ?? [];
    this.modelList.replaceChildren();
    this.modelPager.replaceChildren();

    if (models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "nav-model-empty";
      empty.textContent = "No models";
      this.modelList.appendChild(empty);
      return;
    }

    const pageCount = Math.max(1, Math.ceil(models.length / this.modelPageSize));
    this.modelPage = Math.max(0, Math.min(this.modelPage, pageCount - 1));
    const start = this.modelPage * this.modelPageSize;

    for (const hit of models.slice(start, start + this.modelPageSize)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "nav-item nav-model-item";
      btn.dataset["catalogModel"] = hit.id;

      const dot = document.createElement("span");
      dot.className = "nav-dot";
      dot.style.background = `rgb(${Math.round(hit.color[0] * 255)}, ${Math.round(hit.color[1] * 255)}, ${Math.round(hit.color[2] * 255)})`;

      const copy = document.createElement("span");
      copy.className = "nav-model-copy";
      const name = document.createElement("span");
      name.className = "nav-model-name";
      name.textContent = hit.label;
      const meta = document.createElement("span");
      meta.className = "nav-model-meta";
      meta.textContent = hit.subtitle;
      copy.append(name, meta);
      btn.append(dot, copy);
      btn.addEventListener("click", () => {
        this.selectCatalogStar(hit);
        this.catalogSearch?.onCatalogItemClick?.(hit.id);
      });
      this.modelList.appendChild(btn);
    }

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "nav-model-page-btn";
    prev.textContent = "‹";
    prev.disabled = this.modelPage <= 0;
    prev.addEventListener("click", () => {
      this.modelPage--;
      this.renderModelList();
      this.filter();
    });

    const label = document.createElement("span");
    label.className = "nav-model-page-label";
    label.textContent = `${this.modelPage + 1} / ${pageCount}`;

    const next = document.createElement("button");
    next.type = "button";
    next.className = "nav-model-page-btn";
    next.textContent = "›";
    next.disabled = this.modelPage >= pageCount - 1;
    next.addEventListener("click", () => {
      this.modelPage++;
      this.renderModelList();
      this.filter();
    });

    this.modelPager.append(prev, label, next);
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
          `Catalog: constellations, known galaxies, 3D models, exoplanet host stars, planets, and Sgr A*.<br>` +
          `Try: <em>Orion, Andromeda, LMC, Sgr A*, Crab, TRAPPIST-1, Proxima</em>`;
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
        this.selectCatalogStar(hit);
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

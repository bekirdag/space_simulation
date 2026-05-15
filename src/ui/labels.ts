import { type Body } from "../physics/body";
import { BodyType } from "../physics/constants";
import { type Mat4, type Vec3 } from "../math/mat4";
import { NEARBY_STAR_AU_PER_PARSEC, type NearbyStarLabel } from "../catalog/nearby-stars";
import { type ConstellationLabel } from "../catalog/constellations";

// Moons fade out beyond this distance from the camera eye (AU).
// Matches the shader's 1.5 AU soft cutoff.
const MOON_LABEL_MAX_DIST = 1.5;
const LIGHT_YEARS_PER_PARSEC = 3.26156;
const NEARBY_STAR_AU_PER_LIGHT_YEAR = NEARBY_STAR_AU_PER_PARSEC / LIGHT_YEARS_PER_PARSEC;
const NEARBY_STAR_MIN_OPACITY = 0.025;

const ALWAYS_VISIBLE_BODY_NAMES = new Set([
  // Planets
  "Sun", "Mercury", "Venus", "Earth", "Mars",
  "Jupiter", "Saturn", "Uranus", "Neptune",
  // Dwarf planets — pinned to viewport edge so they're always in positions map
  "Pluto", "Eris", "Ceres", "Haumea", "Makemake",
]);
const LABEL_EDGE_MARGIN = 24;
const LABEL_NAV_MARGIN = 238;
const LABEL_BOTTOM_MARGIN = 86;
const SOLAR_SYSTEM_LABEL_COLLAPSE_DISTANCE_AU = 250;
// Near a direct 180-degree behind-camera alignment, every screen edge is arbitrary.
const BEHIND_CAMERA_PIN_DEADZONE = 0.16;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function smoother01(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function nearbyStarShellOpacity(star: NearbyStarLabel, cameraDistanceLy: number): number {
  const starDistanceLy = Math.max(star.distPc * LIGHT_YEARS_PER_PARSEC, 0.05);
  const fadeInStartLy  = Math.max(0.05, starDistanceLy * 0.24);
  const fadeInEndLy    = Math.max(fadeInStartLy + 0.35, starDistanceLy * 0.55);
  const fadeOutStartLy = Math.max(fadeInEndLy + 0.50, starDistanceLy * 2.35);
  const fadeOutEndLy   = Math.max(fadeOutStartLy + 2.00, starDistanceLy * 3.40);
  const fadeIn  = smoother01((cameraDistanceLy - fadeInStartLy) / (fadeInEndLy - fadeInStartLy));
  const fadeOut = 1 - smoother01((cameraDistanceLy - fadeOutStartLy) / (fadeOutEndLy - fadeOutStartLy));
  return fadeIn * fadeOut;
}

function pinToViewport(nx: number, ny: number, cssW: number, cssH: number): ProjectedPoint {
  let dirX = nx;
  let dirY = ny;
  if (!Number.isFinite(dirX) || !Number.isFinite(dirY) || (Math.abs(dirX) < 0.001 && Math.abs(dirY) < 0.001)) {
    dirX = 0;
    dirY = -1;
  }
  const scale = Math.max(Math.abs(dirX), Math.abs(dirY), 1);
  const edgeX = dirX / scale;
  const edgeY = dirY / scale;
  const rightLimit = cssW > 720 ? cssW - LABEL_NAV_MARGIN : cssW - LABEL_EDGE_MARGIN;
  const bottomLimit = Math.max(LABEL_EDGE_MARGIN, cssH - LABEL_BOTTOM_MARGIN);
  return {
    x: clamp((edgeX + 1) * 0.5 * cssW, LABEL_EDGE_MARGIN, Math.max(LABEL_EDGE_MARGIN, rightLimit)),
    y: clamp((1 - edgeY) * 0.5 * cssH, LABEL_EDGE_MARGIN, bottomLimit),
    pinned: true,
  };
}

interface ProjectedPoint { x: number; y: number; pinned: boolean }

function project(
  x: number, y: number, z: number,
  vp: Mat4, cssW: number, cssH: number,
  pin = false,
): ProjectedPoint | null {
  /* eslint-disable @typescript-eslint/no-non-null-assertion */
  const cx = vp[0]!*x + vp[4]!*y + vp[8]! *z + vp[12]!;
  const cy = vp[1]!*x + vp[5]!*y + vp[9]! *z + vp[13]!;
  const cz = vp[2]!*x + vp[6]!*y + vp[10]!*z + vp[14]!;
  const cw = vp[3]!*x + vp[7]!*y + vp[11]!*z + vp[15]!;
  /* eslint-enable */
  if (cw <= 0) {
    if (!pin) return null;
    const cwAbs = Math.max(Math.abs(cw), 1e-6);
    const behindX = cx / cwAbs;
    const behindY = cy / cwAbs;
    if (Math.hypot(behindX, behindY) < BEHIND_CAMERA_PIN_DEADZONE) return null;
    return pinToViewport(behindX, behindY, cssW, cssH);
  }
  const nx = cx / cw, ny = cy / cw, nz = cz / cw;
  const visibleBounds = pin ? 0.98 : 1.4;
  if (nz >= 0 && nz <= 1.02 && nx >= -visibleBounds && nx <= visibleBounds && ny >= -visibleBounds && ny <= visibleBounds) {
    return { x: (nx + 1) * 0.5 * cssW, y: (1 - ny) * 0.5 * cssH, pinned: false };
  }
  if (!pin) return null;
  return pinToViewport(nx, ny, cssW, cssH);
}

interface Projected { x: number; y: number; body: Body }

export interface CatalogStarInfo {
  label:    string;
  subtitle: string;
  x: number; y: number; z: number;
}

export type NearbyStarClickHandler = (star: NearbyStarLabel) => void;

export class LabelManager {
  private container:  HTMLDivElement;
  private spans     = new Map<number, HTMLSpanElement>();
  private positions = new Map<number, Projected>(); // updated each frame
  private mouseX    = 0;
  private mouseY    = 0;
  private starLabelEl: HTMLDivElement;

  // Nearby-star label spans keyed by star name
  private nearbyStarSpans = new Map<string, HTMLSpanElement>();
  // Constellation title spans keyed by constellation id
  private constellationSpans = new Map<string, HTMLSpanElement>();
  // Sgr A* permanent label
  private galacticCenterEl: HTMLSpanElement | null = null;
  // Whether all labels are visible (controlled by settings)
  private _visible = true;

  setVisible(v: boolean): void {
    this._visible = v;
    if (!v) {
      for (const sp of this.spans.values()) sp.style.display = 'none';
      for (const sp of this.nearbyStarSpans.values()) sp.style.display = 'none';
      for (const sp of this.constellationSpans.values()) sp.style.display = 'none';
      if (this.galacticCenterEl) this.galacticCenterEl.style.display = 'none';
      if (this.starLabelEl) this.starLabelEl.style.display = 'none';
    }
  }

  constructor() {
    this.container = document.createElement('div');
    Object.assign(this.container.style, {
      position: 'fixed', inset: '0',
      pointerEvents: 'none', zIndex: '5', overflow: 'hidden',
    });
    document.body.appendChild(this.container);
    window.addEventListener('mousemove', e => { this.mouseX = e.clientX; this.mouseY = e.clientY; });

    // Label for selected catalog stars (not simulation bodies)
    this.starLabelEl = document.createElement('div');
    this.starLabelEl.className = 'catalog-star-label';
    this.starLabelEl.style.display = 'none';
    document.body.appendChild(this.starLabelEl);
  }

  update(
    bodies: Body[],
    viewProj: Mat4,
    focusedSystemMembers: ReadonlySet<string> = new Set(),
    cameraEye: Vec3 = [0, 0, 0],
    bodyVisibility: ReadonlyMap<number, number> = new Map(),
  ): boolean /* solarSystemClustered */ {
    if (!this._visible) return false;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    this.positions.clear();

    // Remove spans for departed bodies
    const ids = new Set(bodies.map(b => b.id));
    for (const [id, sp] of this.spans) {
      if (!ids.has(id)) { sp.remove(); this.spans.delete(id); }
    }

    // ── Solar system cluster detection ────────────────────────────────────────
    // When camera is zoomed out far enough, all solar system bodies cluster into
    // a tiny dot.  Measure the pixel spread from Sun to a 30 AU reference point
    // (≈ Neptune's orbital radius). If < threshold, only the Sun label is shown.
    const CLUSTER_THRESHOLD_PX = 50;
    let solarSystemClustered = false;
    const sun = bodies.find(b => b.name === "Sun");
    if (sun) {
      const cameraDistanceFromSun = Math.hypot(
        cameraEye[0] - sun.x,
        cameraEye[1] - sun.y,
        cameraEye[2] - sun.z,
      );
      solarSystemClustered = cameraDistanceFromSun > SOLAR_SYSTEM_LABEL_COLLAPSE_DISTANCE_AU;
      if (!solarSystemClustered) {
        const sunPt = project(sun.x, sun.y, sun.z, viewProj, cssW, cssH, false);
        const refPt = project(sun.x + 30, sun.y, sun.z, viewProj, cssW, cssH, false);
        if (sunPt && refPt) {
          const spread = Math.hypot(sunPt.x - refPt.x, sunPt.y - refPt.y);
          solarSystemClustered = spread < CLUSTER_THRESHOLD_PX;
        }
      }
    }

    for (const b of bodies) {
      if (!this.spans.has(b.id)) {
        const sp = document.createElement('span');
        sp.className = b.name === "Sun" ? 'body-label sun' : 'body-label';
        sp.textContent = b.name;
        this.container.appendChild(sp);
        this.spans.set(b.id, sp);
      }

      const sp  = this.spans.get(b.id)!;
      const isFocusedSystemMember = focusedSystemMembers.has(b.name);
      const isMajorBody = ALWAYS_VISIBLE_BODY_NAMES.has(b.name);
      const renderVisibility = bodyVisibility.get(b.id) ?? 1;

      if (renderVisibility <= 0.05 && !isMajorBody && !isFocusedSystemMember) {
        sp.style.display = 'none';
        sp.classList.remove('pinned', 'hovered', 'system');
        continue;
      }

      // When the whole solar system fits inside ~50 px, keep only the Sun label.
      // Focused system members stay visible so clicking a body while zoomed out
      // doesn't suddenly make its label vanish.
      const isSolarSystemBody =
        b.type === BodyType.Star   ||
        b.type === BodyType.Planet ||
        b.type === BodyType.DwarfPlanet ||
        b.type === BodyType.Moon;
      if (solarSystemClustered && isSolarSystemBody && b.name !== "Sun" && !isFocusedSystemMember) {
        sp.style.display = 'none';
        sp.classList.remove('pinned', 'hovered', 'system');
        continue;
      }

      // Hide moon labels when camera is too far to see the body.
      // Dwarf planets orbit the Sun (not a planet), so they stay visible like planets.
      const isMoon = b.type === BodyType.Moon;
      if (isMoon && !isFocusedSystemMember) {
        const distToEye = Math.hypot(
          b.x - cameraEye[0], b.y - cameraEye[1], b.z - cameraEye[2],
        );
        if (distToEye > MOON_LABEL_MAX_DIST) {
          sp.style.display = 'none';
          sp.classList.remove('pinned', 'hovered', 'system');
          continue;
        }
      }

      const pos = project(
        b.x, b.y, b.z,
        viewProj, cssW, cssH,
        ALWAYS_VISIBLE_BODY_NAMES.has(b.name) || isFocusedSystemMember,
      );

      if (!pos) {
        sp.style.display = 'none';
        sp.classList.remove('pinned', 'hovered', 'system');
        continue;
      }

      this.positions.set(b.id, { x: pos.x, y: pos.y, body: b });
      sp.style.display = 'block';
      sp.classList.toggle('pinned', pos.pinned);
      sp.classList.toggle('system', isFocusedSystemMember);
      // Round to integer pixels — fractional positions cause sub-pixel text blur
      sp.style.left = `${Math.round(pos.pinned ? pos.x : pos.x + 10)}px`;
      sp.style.top  = `${Math.round(pos.pinned ? pos.y : pos.y - 6)}px`;

      const dx = this.mouseX - pos.x;
      const dy = this.mouseY - pos.y;
      sp.classList.toggle('hovered', Math.sqrt(dx*dx + dy*dy) < 32);
    }
    return solarSystemClustered;
  }

  /**
   * Show (or hide) a persistent label for a selected catalog star.
   * Called each frame so the label tracks the star as the camera moves.
   */
  updateCatalogStarLabel(star: CatalogStarInfo | null, viewProj: Mat4): void {
    if (!star) {
      this.starLabelEl.style.display = 'none';
      return;
    }
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const pos = project(star.x, star.y, star.z, viewProj, cssW, cssH, false);
    if (!pos) {
      this.starLabelEl.style.display = 'none';
      return;
    }
    this.starLabelEl.style.display = 'block';
    this.starLabelEl.style.left = `${pos.x + 14}px`;
    this.starLabelEl.style.top  = `${pos.y - 8}px`;
    this.starLabelEl.innerHTML  =
      `<span class="csl-name">${star.label}</span>` +
      `<span class="csl-sub">${star.subtitle}</span>`;
  }

  /**
   * Return the nearest body whose screen-centre is within `threshold` CSS px
   * of the given screen coordinate. Returns null if nothing is close enough.
   */
  findBodyAtScreen(x: number, y: number, threshold = 60): Body | null {
    let best: Body | null = null;
    let bestDist = threshold;
    for (const { x: px, y: py, body } of this.positions.values()) {
      const d = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
      if (d < bestDist) { bestDist = d; best = body; }
    }
    return best;
  }

  /**
   * Return all bodies whose screen-centre falls within a `halfSize`-pixel
   * square (total 2×halfSize × 2×halfSize) centred on (x, y).
   *
   * Sorted by type priority (Star → Planet → DwarfPlanet → Moon → Exoplanet)
   * then by distance. Returns at most `limit` entries.
   */
  findBodiesAtScreen(x: number, y: number, halfSize = 10, limit = 14): Body[] {
    const results: Array<{ body: Body; dist: number }> = [];

    for (const { x: px, y: py, body } of this.positions.values()) {
      if (Math.abs(x - px) > halfSize || Math.abs(y - py) > halfSize) continue;
      results.push({ body, dist: Math.sqrt((x - px) ** 2 + (y - py) ** 2) });
    }

    const priority = (b: Body): number => {
      switch (b.type) {
        case BodyType.Star:        return 0;
        case BodyType.Planet:      return 1;
        case BodyType.DwarfPlanet: return 2;
        case BodyType.Moon:        return 3;
        case BodyType.Exoplanet:   return 4;
        default:                   return 5;
      }
    };

    results.sort((a, b) => {
      const pd = priority(a.body) - priority(b.body);
      return pd !== 0 ? pd : a.dist - b.dist;
    });

    return results.slice(0, limit).map(r => r.body);
  }

  /**
   * Show named nearby-star labels while the camera radius is near each star's
   * Sun-distance. This is intentionally separate from the 100k catalog-star
   * render layer, which stays visible without per-star shell gating.
   *
   * @param stars       The full sorted list from NEARBY_STAR_LABELS.
   * @param viewProj    Current view-projection matrix.
   * @param cameraEye   Current camera eye in simulation AU.
   * @param sunWorldPos Current Sun position in simulation AU.
   */
  updateNearbyStarLabels(
    stars:       NearbyStarLabel[],
    viewProj:    Mat4,
    cameraEye:   Vec3 = [0, 0, 0],
    sunWorldPos: Vec3 = [0, 0, 0],
    onStarClick?: NearbyStarClickHandler,
  ): void {
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    if (!this._visible) {
      for (const [, sp] of this.nearbyStarSpans) sp.style.display = 'none';
      return;
    }

    const cameraDistanceAu = Math.hypot(
      cameraEye[0] - sunWorldPos[0],
      cameraEye[1] - sunWorldPos[1],
      cameraEye[2] - sunWorldPos[2],
    );
    const cameraDistanceLy = Math.max(cameraDistanceAu / NEARBY_STAR_AU_PER_LIGHT_YEAR, 0);

    // Show/hide labels for each star.
    for (const star of stars) {
      const opacity = nearbyStarShellOpacity(star, cameraDistanceLy);
      if (opacity <= NEARBY_STAR_MIN_OPACITY) {
        const sp = this.nearbyStarSpans.get(star.name);
        if (sp) sp.style.display = 'none';
        continue;
      }

      // Create span on first use.
      let sp = this.nearbyStarSpans.get(star.name);
      if (!sp) {
        sp = document.createElement('span');
        sp.className = 'nearby-star-label';
        sp.textContent = star.name;
        sp.title = `Focus ${star.name}`;
        sp.setAttribute('role', 'button');
        sp.tabIndex = 0;
        sp.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          onStarClick?.(star);
        });
        sp.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          onStarClick?.(star);
        });
        this.container.appendChild(sp);
        this.nearbyStarSpans.set(star.name, sp);
      }

      const pt = project(star.x, star.y, star.z, viewProj, cssW, cssH, false);
      if (!pt) {
        sp.style.display = 'none';
        continue;
      }

      sp.style.display = 'block';
      sp.style.opacity = opacity.toFixed(3);
      sp.style.left = `${Math.round(pt.x + 7)}px`;
      sp.style.top  = `${Math.round(pt.y - 5)}px`;
    }
  }

  /**
   * Project constellation titles from the same 3D catalog-star positions used
   * by the constellation line buffer. The setting toggle hides lines and labels together.
   */
  updateConstellationLabels(
    constellations: readonly ConstellationLabel[],
    viewProj: Mat4,
    visible: boolean,
  ): void {
    if (!this._visible || !visible || constellations.length === 0) {
      for (const sp of this.constellationSpans.values()) sp.style.display = 'none';
      return;
    }

    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const active = new Set<string>();

    for (const label of constellations) {
      active.add(label.id);

      let sp = this.constellationSpans.get(label.id);
      if (!sp) {
        sp = document.createElement('span');
        sp.className = 'constellation-label';
        sp.textContent = label.name;
        this.container.appendChild(sp);
        this.constellationSpans.set(label.id, sp);
      }

      const pt = project(label.x, label.y, label.z, viewProj, cssW, cssH, false);
      if (!pt) {
        sp.style.display = 'none';
        continue;
      }

      sp.style.display = 'block';
      sp.style.opacity = label.alpha.toFixed(3);
      sp.style.left = `${Math.round(pt.x + 10)}px`;
      sp.style.top  = `${Math.round(pt.y - 6)}px`;
    }

    for (const [id, sp] of this.constellationSpans) {
      if (!active.has(id)) sp.style.display = 'none';
    }
  }

  /**
   * Always-visible Sgr A* label pinned to the viewport edge when off-screen.
   * Clickable: calls onClick() to navigate the camera to the galactic centre.
   * Must be called every frame so the label tracks the projected position.
   */
  updateGalacticCenterLabel(
    worldPos: [number, number, number],
    viewProj: Mat4,
    onClick:  () => void,
  ): void {
    if (!this._visible) return;
    // Create element once
    if (!this.galacticCenterEl) {
      const el = document.createElement('span');
      el.className = 'galactic-center-label';
      el.textContent = 'Sgr A*';
      el.addEventListener('click', () => onClick());
      // Appended to body directly so pointer-events work (label container is none)
      document.body.appendChild(el);
      this.galacticCenterEl = el;
    }

    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const pos  = project(worldPos[0], worldPos[1], worldPos[2], viewProj, cssW, cssH, true);

    if (!pos) {
      this.galacticCenterEl.style.display = 'none';
      return;
    }

    this.galacticCenterEl.style.display = 'block';
    this.galacticCenterEl.classList.toggle('pinned', pos.pinned);
    this.galacticCenterEl.style.left = `${Math.round(pos.pinned ? pos.x : pos.x + 8)}px`;
    this.galacticCenterEl.style.top  = `${Math.round(pos.pinned ? pos.y : pos.y - 5)}px`;
  }
}

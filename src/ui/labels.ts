import { type Body } from "../physics/body";
import { BodyType } from "../physics/constants";
import { type Mat4, type Vec3 } from "../math/mat4";
import { NEARBY_STAR_AU_PER_PARSEC, type NearbyStarLabel } from "../catalog/nearby-stars";
import { type ConstellationLabel, type ConstellationStarLabel } from "../catalog/constellations";

// Moons fade out beyond this distance from the camera eye (AU).
// Matches the shader's 1.5 AU soft cutoff.
const MOON_LABEL_MAX_DIST = 1.5;
const LIGHT_YEARS_PER_PARSEC = 3.26156;
const NEARBY_STAR_AU_PER_LIGHT_YEAR = NEARBY_STAR_AU_PER_PARSEC / LIGHT_YEARS_PER_PARSEC;
const NEARBY_STAR_MIN_OPACITY = 0.025;
const GALAXY_LABEL_MIN_OPACITY = 0.035;
const MILKY_WAY_LABEL_MIN_OPACITY = 0.035;

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
const LABEL_OUTSKIRT_GAP_PX = 24;
const LABEL_MIN_OUTSKIRT_OFFSET_PX = 34;
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

// Visual AU at which the MW background star disk ends (15 kpc × 8 AU/kpc).
// Stars whose HYG position (80 AU/pc) exceeds this appear outside the visible
// Milky Way when the camera zooms to galactic scale.  We cap their label
// fade-out at this boundary so they disappear before that happens.
const MW_DISK_VISUAL_AU     = 120_000; // 15 kpc × 8 AU/pc
const MW_DISK_VIRTUAL_LY    = MW_DISK_VISUAL_AU / NEARBY_STAR_AU_PER_LIGHT_YEAR; // ≈ 4 888 "visual ly"

function nearbyStarShellOpacity(star: NearbyStarLabel, cameraDistanceLy: number): number {
  const starDistanceLy = Math.max(star.distPc * LIGHT_YEARS_PER_PARSEC, 0.05);
  const fadeInStartLy  = Math.max(0.05, starDistanceLy * 0.24);
  const fadeInEndLy    = Math.max(fadeInStartLy + 0.35, starDistanceLy * 0.55);

  // If the star's HYG-scale position exceeds the visual MW disk boundary, cap
  // the fade-out so the label disappears before the camera exits the disk.
  // This prevents labels from floating visually outside the Milky Way structure
  // (e.g. Eta Carinae at 2300 pc → 184 kAU, while MW disk ends at 120 kAU).
  const starVisualAu   = star.distPc * NEARBY_STAR_AU_PER_PARSEC;
  const outsideMWDisk  = starVisualAu > MW_DISK_VISUAL_AU;
  const rawFadeOutEnd  = Math.max(fadeInEndLy + 0.50, starDistanceLy * 3.40);
  const fadeOutEndLy   = outsideMWDisk ? Math.min(rawFadeOutEnd, MW_DISK_VIRTUAL_LY) : rawFadeOutEnd;
  const fadeOutStartLy = Math.min(
    Math.max(fadeInEndLy + 0.50, starDistanceLy * 2.35),
    Math.max(fadeInEndLy + 0.25, fadeOutEndLy - 0.5),
  );

  const fadeIn  = smoother01((cameraDistanceLy - fadeInStartLy) / (fadeInEndLy - fadeInStartLy));
  const fadeOut = 1 - smoother01((cameraDistanceLy - fadeOutStartLy) / (fadeOutEndLy - fadeOutStartLy));
  return fadeIn * fadeOut;
}

function galaxyShellOpacity(galaxyDistanceAu: number, cameraDistanceAu: number): number {
  const d = Math.max(galaxyDistanceAu, 1);
  const fadeInStartAu  = Math.max(220_000, d * 0.22);
  const fadeInEndAu    = Math.max(fadeInStartAu + 80_000, d * 0.52);
  const fadeOutStartAu = Math.max(fadeInEndAu + 220_000, d * 2.20);
  const fadeOutEndAu   = Math.max(fadeOutStartAu + 500_000, d * 3.35);
  const fadeIn = smoother01((cameraDistanceAu - fadeInStartAu) / (fadeInEndAu - fadeInStartAu));
  const fadeOut = 1 - smoother01((cameraDistanceAu - fadeOutStartAu) / (fadeOutEndAu - fadeOutStartAu));
  return fadeIn * fadeOut;
}

function milkyWayLabelOpacity(cameraDistanceFromCenterAu: number, milkyWayRadiusAu: number): number {
  const startAu = Math.max(180_000, milkyWayRadiusAu * 2.15);
  const endAu = Math.max(startAu + 120_000, milkyWayRadiusAu * 3.65);
  return smoother01((cameraDistanceFromCenterAu - startAu) / (endAu - startAu));
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

function viewportLabelBounds(
  cssW: number,
  cssH: number,
  labelWidth = 0,
  labelHeight = 0,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const rightLimit = cssW > 720 ? cssW - LABEL_NAV_MARGIN : cssW - LABEL_EDGE_MARGIN;
  const bottomLimit = Math.max(LABEL_EDGE_MARGIN, cssH - LABEL_BOTTOM_MARGIN);
  return {
    minX: LABEL_EDGE_MARGIN,
    maxX: Math.max(LABEL_EDGE_MARGIN, rightLimit - Math.max(0, labelWidth)),
    minY: LABEL_EDGE_MARGIN,
    maxY: Math.max(LABEL_EDGE_MARGIN, bottomLimit - Math.max(0, labelHeight)),
  };
}

function cameraDepthToPoint(
  x: number,
  y: number,
  z: number,
  camera: BodyLabelCameraFrame,
): number {
  const right = camera.camRight;
  const up = camera.camUp;
  const back: Vec3 = [
    right[1] * up[2] - right[2] * up[1],
    right[2] * up[0] - right[0] * up[2],
    right[0] * up[1] - right[1] * up[0],
  ];
  const rx = x - camera.eye[0];
  const ry = y - camera.eye[1];
  const rz = z - camera.eye[2];
  return -(rx * back[0] + ry * back[1] + rz * back[2]);
}

function apparentRadiusPx(
  radiusAU: number | null | undefined,
  x: number,
  y: number,
  z: number,
  cameraFrame: BodyLabelCameraFrame | null,
  cssW: number,
  cssH: number,
): number {
  if (!cameraFrame || !Number.isFinite(radiusAU) || (radiusAU ?? 0) <= 0) return 0;
  const depth = cameraDepthToPoint(x, y, z, cameraFrame);
  if (!Number.isFinite(depth) || depth <= 1e-9) return 0;
  const radiusPx = (radiusAU! * cameraFrame.focalY / depth) * cssH * 0.5;
  return clamp(radiusPx, 0, Math.max(cssW, cssH));
}

function radiusFromFocusDistance(
  focusDistance: number | null | undefined,
  cameraFrame: BodyLabelCameraFrame | null,
  cssW: number,
  cssH: number,
): number {
  if (!cameraFrame || !Number.isFinite(focusDistance) || (focusDistance ?? 0) <= 0) return 0;
  const aspect = Math.max(0.2, cssW / Math.max(1, cssH));
  const fillNdc = clamp(0.88 * aspect, 0.25, 0.88);
  return Math.max(0, (focusDistance! * fillNdc) / Math.max(cameraFrame.focalY, 1e-6));
}

function offsetLabelToObjectOutskirts(
  pos: ProjectedPoint,
  radiusPx: number,
  cssW: number,
  cssH: number,
  labelWidth = 0,
  labelHeight = 0,
): { x: number; y: number } {
  if (pos.pinned) return { x: pos.x, y: pos.y };

  const centerX = cssW * 0.5;
  const centerY = cssH * 0.5;
  let dirX = pos.x - centerX;
  let dirY = pos.y - centerY;
  const len = Math.hypot(dirX, dirY);
  if (len < 1e-3) {
    dirX = 0.78;
    dirY = -0.62;
  } else {
    dirX /= len;
    dirY /= len;
  }

  const dynamicMax = clamp(Math.min(cssW, cssH) * 0.48, 220, 620);
  const offset = clamp(
    radiusPx + LABEL_OUTSKIRT_GAP_PX,
    LABEL_MIN_OUTSKIRT_OFFSET_PX,
    dynamicMax,
  );
  const halfLabelWidth = Math.max(0, labelWidth * 0.5);
  const halfLabelHeight = Math.max(0, labelHeight * 0.5);
  const halfLabelAlongDirection =
    Math.abs(dirX) * halfLabelWidth + Math.abs(dirY) * halfLabelHeight;
  const bounds = viewportLabelBounds(cssW, cssH, labelWidth, labelHeight);
  const labelCenterX = pos.x + dirX * (offset + halfLabelAlongDirection);
  const labelCenterY = pos.y + dirY * (offset + halfLabelAlongDirection);

  return {
    x: clamp(labelCenterX - halfLabelWidth, bounds.minX, bounds.maxX),
    y: clamp(labelCenterY - halfLabelHeight, bounds.minY, bounds.maxY),
  };
}

export interface BodyLabelCameraFrame {
  eye: Vec3;
  camRight: Vec3;
  camUp: Vec3;
  focalY: number;
}

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

function projectCameraRelative(
  x: number, y: number, z: number,
  camera: BodyLabelCameraFrame,
  cssW: number, cssH: number,
  pin = false,
): ProjectedPoint | null {
  const right = camera.camRight;
  const up = camera.camUp;
  const back: Vec3 = [
    right[1] * up[2] - right[2] * up[1],
    right[2] * up[0] - right[0] * up[2],
    right[0] * up[1] - right[1] * up[0],
  ];
  const rx = x - camera.eye[0];
  const ry = y - camera.eye[1];
  const rz = z - camera.eye[2];
  const vx = rx * right[0] + ry * right[1] + rz * right[2];
  const vy = rx * up[0] + ry * up[1] + rz * up[2];
  const vz = rx * back[0] + ry * back[1] + rz * back[2];
  const w = -vz;
  const projX = camera.focalY / Math.max(cssW / Math.max(cssH, 1), 1e-6);
  const projY = camera.focalY;

  if (w <= 0) {
    if (!pin) return null;
    const scale = Math.max(Math.abs(w), 1e-6);
    const behindX = -(vx * projX) / scale;
    const behindY = -(vy * projY) / scale;
    if (Math.hypot(behindX, behindY) < BEHIND_CAMERA_PIN_DEADZONE) return null;
    return pinToViewport(behindX, behindY, cssW, cssH);
  }

  const nx = (vx * projX) / w;
  const ny = (vy * projY) / w;
  const visibleBounds = pin ? 0.98 : 1.4;
  if (nx >= -visibleBounds && nx <= visibleBounds && ny >= -visibleBounds && ny <= visibleBounds) {
    return { x: (nx + 1) * 0.5 * cssW, y: (1 - ny) * 0.5 * cssH, pinned: false };
  }
  if (!pin) return null;
  return pinToViewport(nx, ny, cssW, cssH);
}

function projectStable(
  x: number, y: number, z: number,
  vp: Mat4, cssW: number, cssH: number,
  pin = false,
  cameraFrame: BodyLabelCameraFrame | null = null,
): ProjectedPoint | null {
  return cameraFrame
    ? projectCameraRelative(x, y, z, cameraFrame, cssW, cssH, pin)
    : project(x, y, z, vp, cssW, cssH, pin);
}

interface Projected { x: number; y: number; body: Body }

function bodyLabelClassName(body: Body): string {
  const classes = ['body-label'];
  if (body.name === "Sun") classes.push('sun');
  if (body.type === BodyType.Exoplanet) classes.push('exoplanet');
  return classes.join(' ');
}

export interface CatalogStarInfo {
  label:    string;
  subtitle: string;
  x: number; y: number; z: number;
  focusDistance?: number | undefined;
  radiusAU?: number | undefined;
  labelRadiusAU?: number | undefined;
}

export interface LockTargetInfo {
  x: number;
  y: number;
  z: number;
}

export type BodyLabelClickHandler = (body: Body) => void;
export type NearbyStarClickHandler = (star: NearbyStarLabel) => void;

export interface GalaxyNameLabel {
  id: string;
  name: string;
  dist: number;
  x: number; y: number; z: number;
  focusDistance: number;
}

export type GalaxyNameClickHandler = (galaxy: GalaxyNameLabel) => void;

export class LabelManager {
  private container:  HTMLDivElement;
  private spans     = new Map<number, HTMLSpanElement>();
  private positions = new Map<number, Projected>(); // updated each frame
  private mouseX    = 0;
  private mouseY    = 0;
  private bodyLabelClickHandler: BodyLabelClickHandler | null = null;
  private starLabelEl: HTMLDivElement;
  private starLabelNameEl: HTMLSpanElement;
  private starLabelSubEl: HTMLSpanElement;
  private targetReticleEl: HTMLDivElement;

  // Nearby-star label spans keyed by star name
  private nearbyStarSpans = new Map<string, HTMLSpanElement>();
  // Local Group galaxy title spans keyed by galaxy id
  private galaxyNameSpans = new Map<string, HTMLSpanElement>();
  // Constellation title spans keyed by constellation id
  private constellationSpans = new Map<string, HTMLSpanElement>();
  // Selected-constellation star labels keyed by snapped endpoint id
  private constellationStarSpans = new Map<string, HTMLSpanElement>();
  // Sgr A* permanent label
  private galacticCenterEl: HTMLSpanElement | null = null;
  // Large-scale Milky Way label, shown after Sgr A* stops being useful.
  private milkyWayEl: HTMLSpanElement | null = null;
  // Whether all labels are visible (controlled by settings)
  private _visible = true;

  setVisible(v: boolean): void {
    this._visible = v;
    if (!v) {
      for (const sp of this.spans.values()) sp.style.display = 'none';
      for (const sp of this.nearbyStarSpans.values()) sp.style.display = 'none';
      for (const sp of this.galaxyNameSpans.values()) sp.style.display = 'none';
      for (const sp of this.constellationSpans.values()) sp.style.display = 'none';
      for (const sp of this.constellationStarSpans.values()) sp.style.display = 'none';
      if (this.galacticCenterEl) this.galacticCenterEl.style.display = 'none';
      if (this.milkyWayEl) this.milkyWayEl.style.display = 'none';
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
    this.starLabelNameEl = document.createElement('span');
    this.starLabelNameEl.className = 'csl-name';
    this.starLabelSubEl = document.createElement('span');
    this.starLabelSubEl.className = 'csl-sub';
    this.starLabelEl.append(this.starLabelNameEl, this.starLabelSubEl);
    const stopStarLabelEvent = (event: Event): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    for (const eventType of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      this.starLabelEl.addEventListener(eventType, stopStarLabelEvent, { capture: true });
    }
    document.body.appendChild(this.starLabelEl);

    this.targetReticleEl = document.createElement('div');
    this.targetReticleEl.className = 'target-reticle';
    this.targetReticleEl.style.display = 'none';
    this.targetReticleEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(this.targetReticleEl);
  }

  private activateBodyLabel(sp: HTMLElement): void {
    const id = Number(sp.dataset["bodyId"]);
    if (!Number.isFinite(id)) return;
    const projected = this.positions.get(id);
    if (!projected) return;
    this.bodyLabelClickHandler?.(projected.body);
  }

  update(
    bodies: Body[],
    viewProj: Mat4,
    focusedSystemMembers: ReadonlySet<string> = new Set(),
    cameraEye: Vec3 = [0, 0, 0],
    bodyVisibility: ReadonlyMap<number, number> = new Map(),
    onBodyLabelClick: BodyLabelClickHandler | null = null,
    cameraFrame: BodyLabelCameraFrame | null = null,
  ): boolean /* solarSystemClustered */ {
    if (!this._visible) return false;
    this.bodyLabelClickHandler = onBodyLabelClick;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;

    this.positions.clear();
    const projectBodyPoint = (
      x: number, y: number, z: number,
      pin = false,
    ): ProjectedPoint | null => cameraFrame
      ? projectCameraRelative(x, y, z, cameraFrame, cssW, cssH, pin)
      : project(x, y, z, viewProj, cssW, cssH, pin);

    // Remove spans for departed bodies
    const ids = new Set(bodies.map(b => b.id));
    for (const [id, sp] of this.spans) {
      if (!ids.has(id)) { sp.remove(); this.spans.delete(id); }
    }

    // ── Galaxy-scale check: hide ALL solar system labels beyond 100 kpc ──────
    // At 100 kpc the MW reduces to a single point; the Sun label adds clutter.
    const camDistAU  = Math.hypot(cameraEye[0], cameraEye[1], cameraEye[2]);
    const camDistKpc = camDistAU / 8_000;
    const beyondMilkyWay = camDistKpc > 400;

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
        const sunPt = projectBodyPoint(sun.x, sun.y, sun.z, false);
        const refPt = projectBodyPoint(sun.x + 30, sun.y, sun.z, false);
        if (sunPt && refPt) {
          const spread = Math.hypot(sunPt.x - refPt.x, sunPt.y - refPt.y);
          solarSystemClustered = spread < CLUSTER_THRESHOLD_PX;
        }
      }
    }

    for (const b of bodies) {
      if (!this.spans.has(b.id)) {
        const sp = document.createElement('span');
        sp.className = bodyLabelClassName(b);
        sp.textContent = b.name;
        sp.dataset["bodyId"] = String(b.id);
        sp.addEventListener('mousedown', event => event.stopPropagation());
        sp.addEventListener('mouseup', event => event.stopPropagation());
        sp.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          this.activateBodyLabel(sp);
        });
        sp.addEventListener('dblclick', event => {
          event.preventDefault();
          event.stopPropagation();
          this.activateBodyLabel(sp);
        });
        sp.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          this.activateBodyLabel(sp);
        });
        this.container.appendChild(sp);
        this.spans.set(b.id, sp);
      }

      const sp  = this.spans.get(b.id)!;
      sp.className = bodyLabelClassName(b);
      sp.classList.toggle('clickable', this.bodyLabelClickHandler !== null);
      sp.dataset["bodyId"] = String(b.id);
      sp.tabIndex = this.bodyLabelClickHandler ? 0 : -1;
      if (this.bodyLabelClickHandler) sp.setAttribute('role', 'button');
      else sp.removeAttribute('role');
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

      // Beyond 100 kpc the MW is a single point — hide every solar system label
      // including the Sun (which is just one of 200 billion stars at this scale).
      if (beyondMilkyWay && isSolarSystemBody && !isFocusedSystemMember) {
        sp.style.display = 'none';
        sp.classList.remove('pinned', 'hovered', 'system');
        continue;
      }

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

      const pos = projectBodyPoint(
        b.x, b.y, b.z,
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
      const labelPoint = pos.pinned
        ? { x: pos.x, y: pos.y }
        : offsetLabelToObjectOutskirts(
            pos,
            apparentRadiusPx(b.radius, b.x, b.y, b.z, cameraFrame, cssW, cssH),
            cssW,
            cssH,
            sp.offsetWidth,
            sp.offsetHeight,
          );
      // Round to integer pixels — fractional positions cause sub-pixel text blur
      sp.style.left = `${Math.round(labelPoint.x)}px`;
      sp.style.top  = `${Math.round(labelPoint.y)}px`;

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
  updateCatalogStarLabel(
    star: CatalogStarInfo | null,
    viewProj: Mat4,
    cameraFrame: BodyLabelCameraFrame | null = null,
  ): void {
    if (!this._visible || !star) {
      this.starLabelEl.style.display = 'none';
      return;
    }
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const pos = projectStable(star.x, star.y, star.z, viewProj, cssW, cssH, false, cameraFrame);
    if (!pos) {
      this.starLabelEl.style.display = 'none';
      return;
    }
    this.starLabelNameEl.textContent = star.label;
    this.starLabelSubEl.textContent = star.subtitle;
    this.starLabelSubEl.style.display = star.subtitle ? 'block' : 'none';
    this.starLabelEl.style.display = 'block';
    const radiusAU =
      star.labelRadiusAU ??
      star.radiusAU ??
      radiusFromFocusDistance(star.focusDistance, cameraFrame, cssW, cssH);
    const radiusPx = apparentRadiusPx(radiusAU, star.x, star.y, star.z, cameraFrame, cssW, cssH);
    const labelPoint = offsetLabelToObjectOutskirts(
      pos,
      radiusPx,
      cssW,
      cssH,
      this.starLabelEl.offsetWidth,
      this.starLabelEl.offsetHeight,
    );
    this.starLabelEl.style.left = `${Math.round(labelPoint.x)}px`;
    this.starLabelEl.style.top  = `${Math.round(labelPoint.y)}px`;
  }

  updateLockTargetReticle(
    target: LockTargetInfo | null,
    viewProj: Mat4,
    cameraFrame: BodyLabelCameraFrame | null = null,
  ): void {
    if (!target) {
      this.targetReticleEl.style.display = 'none';
      return;
    }
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const pos = projectStable(target.x, target.y, target.z, viewProj, cssW, cssH, false, cameraFrame);
    if (!pos) {
      this.targetReticleEl.style.display = 'none';
      return;
    }
    this.targetReticleEl.style.display = 'block';
    this.targetReticleEl.style.left = `${Math.round(pos.x)}px`;
    this.targetReticleEl.style.top = `${Math.round(pos.y)}px`;
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
    selectedStarName: string | null = null,
    cameraFrame: BodyLabelCameraFrame | null = null,
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
      if (selectedStarName === star.name) {
        const sp = this.nearbyStarSpans.get(star.name);
        if (sp) sp.style.display = 'none';
        continue;
      }

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

      const pt = projectStable(star.x, star.y, star.z, viewProj, cssW, cssH, false, cameraFrame);
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
    starLabels: readonly ConstellationStarLabel[] = [],
  ): void {
    if (!this._visible || !visible || constellations.length === 0) {
      for (const sp of this.constellationSpans.values()) sp.style.display = 'none';
      for (const sp of this.constellationStarSpans.values()) sp.style.display = 'none';
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

    const activeStars = new Set<string>();
    for (const star of starLabels) {
      activeStars.add(star.id);

      let sp = this.constellationStarSpans.get(star.id);
      if (!sp) {
        sp = document.createElement('span');
        sp.className = 'constellation-star-label';
        sp.textContent = star.name;
        if (star.catalog) sp.title = star.catalog;
        this.container.appendChild(sp);
        this.constellationStarSpans.set(star.id, sp);
      }

      const pt = project(star.x, star.y, star.z, viewProj, cssW, cssH, false);
      if (!pt) {
        sp.style.display = 'none';
        continue;
      }

      sp.textContent = star.name;
      if (star.catalog) sp.title = star.catalog;
      sp.style.display = 'block';
      sp.style.opacity = star.alpha.toFixed(3);
      sp.style.left = `${Math.round(pt.x + 8)}px`;
      sp.style.top  = `${Math.round(pt.y + 7)}px`;
    }

    for (const [id, sp] of this.constellationStarSpans) {
      if (!activeStars.has(id)) sp.style.display = 'none';
    }
  }

  updateMilkyWayLabel(
    worldPos: [number, number, number],
    viewProj: Mat4,
    cameraEye: Vec3,
    milkyWayRadiusAu: number,
    visible: boolean,
    onClick: () => void,
    selected = false,
    cameraFrame: BodyLabelCameraFrame | null = null,
  ): number {
    if (!visible || !this._visible) {
      if (this.milkyWayEl) this.milkyWayEl.style.display = 'none';
      return 0;
    }

    const cameraDistanceFromCenterAu = Math.hypot(
      cameraEye[0] - worldPos[0],
      cameraEye[1] - worldPos[1],
      cameraEye[2] - worldPos[2],
    );
    const opacity = milkyWayLabelOpacity(cameraDistanceFromCenterAu, milkyWayRadiusAu);
    if (opacity <= MILKY_WAY_LABEL_MIN_OPACITY) {
      if (this.milkyWayEl) this.milkyWayEl.style.display = 'none';
      return opacity;
    }
    if (selected) {
      if (this.milkyWayEl) this.milkyWayEl.style.display = 'none';
      return opacity;
    }

    if (!this.milkyWayEl) {
      const el = document.createElement('span');
      el.className = 'galaxy-name-label milky-way-label';
      el.textContent = 'Milky Way';
      el.title = 'Focus Milky Way';
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
      el.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      el.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      this.container.appendChild(el);
      this.milkyWayEl = el;
    }

    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const pos = projectStable(worldPos[0], worldPos[1], worldPos[2], viewProj, cssW, cssH, true, cameraFrame);
    if (!pos) {
      this.milkyWayEl.style.display = 'none';
      return opacity;
    }

    this.milkyWayEl.style.display = 'block';
    this.milkyWayEl.style.opacity = opacity.toFixed(3);
    this.milkyWayEl.classList.toggle('pinned', pos.pinned);
    this.milkyWayEl.style.left = `${Math.round(pos.pinned ? pos.x : pos.x + 12)}px`;
    this.milkyWayEl.style.top  = `${Math.round(pos.pinned ? pos.y : pos.y - 8)}px`;
    return opacity;
  }

  updateGalaxyNameLabels(
    galaxies: readonly GalaxyNameLabel[],
    viewProj: Mat4,
    cameraEye: Vec3,
    milkyWayCenter: Vec3,
    visible: boolean,
    onGalaxyClick?: GalaxyNameClickHandler,
    selectedGalaxyId: string | null = null,
    cameraFrame: BodyLabelCameraFrame | null = null,
  ): void {
    if (!visible || !this._visible || galaxies.length === 0) {
      for (const sp of this.galaxyNameSpans.values()) sp.style.display = 'none';
      return;
    }

    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const cameraDistanceAu = Math.hypot(
      cameraEye[0] - milkyWayCenter[0],
      cameraEye[1] - milkyWayCenter[1],
      cameraEye[2] - milkyWayCenter[2],
    );
    const active = new Set<string>();

    for (const galaxy of galaxies) {
      active.add(galaxy.id);
      if (selectedGalaxyId === galaxy.id) {
        const sp = this.galaxyNameSpans.get(galaxy.id);
        if (sp) sp.style.display = 'none';
        continue;
      }
      const galaxyDistanceAu = Math.hypot(
        galaxy.x - milkyWayCenter[0],
        galaxy.y - milkyWayCenter[1],
        galaxy.z - milkyWayCenter[2],
      );
      const opacity = galaxyShellOpacity(galaxyDistanceAu, cameraDistanceAu);
      if (opacity <= GALAXY_LABEL_MIN_OPACITY) {
        const sp = this.galaxyNameSpans.get(galaxy.id);
        if (sp) sp.style.display = 'none';
        continue;
      }

      let sp = this.galaxyNameSpans.get(galaxy.id);
      if (!sp) {
        sp = document.createElement('span');
        sp.className = 'galaxy-name-label';
        sp.textContent = galaxy.name;
        sp.title = `Focus ${galaxy.name}`;
        sp.setAttribute('role', 'button');
        sp.tabIndex = 0;
        sp.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          onGalaxyClick?.(galaxy);
        });
        sp.addEventListener('keydown', event => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          event.stopPropagation();
          onGalaxyClick?.(galaxy);
        });
        this.container.appendChild(sp);
        this.galaxyNameSpans.set(galaxy.id, sp);
      }

      const pt = projectStable(galaxy.x, galaxy.y, galaxy.z, viewProj, cssW, cssH, false, cameraFrame);
      if (!pt) {
        sp.style.display = 'none';
        continue;
      }

      sp.style.display = 'block';
      sp.style.opacity = opacity.toFixed(3);
      sp.style.left = `${Math.round(pt.x + 9)}px`;
      sp.style.top  = `${Math.round(pt.y - 6)}px`;
    }

    for (const [id, sp] of this.galaxyNameSpans) {
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
    visible = true,
    opacity = 1,
    cameraFrame: BodyLabelCameraFrame | null = null,
  ): void {
    if (!this._visible || !visible || opacity <= 0.04) {
      if (this.galacticCenterEl) this.galacticCenterEl.style.display = 'none';
      return;
    }
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
    const pos  = projectStable(worldPos[0], worldPos[1], worldPos[2], viewProj, cssW, cssH, true, cameraFrame);

    if (!pos) {
      this.galacticCenterEl.style.display = 'none';
      return;
    }

    this.galacticCenterEl.style.display = 'block';
    this.galacticCenterEl.style.opacity = clamp(opacity, 0, 1).toFixed(3);
    this.galacticCenterEl.classList.toggle('pinned', pos.pinned);
    this.galacticCenterEl.style.left = `${Math.round(pos.pinned ? pos.x : pos.x + 8)}px`;
    this.galacticCenterEl.style.top  = `${Math.round(pos.pinned ? pos.y : pos.y - 5)}px`;
  }
}

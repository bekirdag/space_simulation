import { initGPU } from "./gpu/device";
import { Renderer, type BlackHoleModelAsset, type SelectedStarModel } from "./gpu/renderer";
import blackHoleModelUrl from "./models/blackhole-2.glb?url";
import { Camera, type CameraUniforms } from "./scene/camera";
import { HUD } from "./ui/hud";
import { ScaleBar } from "./ui/scale-bar";
import { NavPanel } from "./ui/nav";
import { ViewControls, type ViewAxis } from "./ui/view-controls";
import { LabelManager, type GalaxyNameLabel, type LockTargetInfo } from "./ui/labels";
import { ContextMenu } from "./ui/context-menu";
import { TrailSystem } from "./scene/trail-system";
import { stepLeapfrog } from "./physics/integrator";
import { solarSystem, binaryStars } from "./physics/presets";
import {
  createGalacticOriginState,
  galacticSpeedKmS,
  galacticTidalAcceleration,
  stepGalacticOrigin,
  type GalacticOriginState,
} from "./physics/galactic-frame";
import { createSecondaryBody, SYSTEM_VIEW } from "./physics/moons";
import { fetchStatesForDate, utcDateStr, dateStrToMs, TOTAL_BODIES } from "./services/horizons";
import { type Body } from "./physics/body";
import { type HorizonsResult } from "./services/horizons";
import { SECONDS_PER_YEAR, MAX_SUBSTEP_YR, BodyType } from "./physics/constants";
import { type Mat4 } from "./math/mat4";
import {
  DEFAULT_VISIBLE_STAR_COUNT,
  SOLAR_RADIUS_AU,
  STAR_FLOATS,
  STAR_DEDUPE_POSITION_TOLERANCE_AU,
  AU_PER_PARSEC,
  catalogStarsToRenderBuffer,
  combineStarBuffersUnique,
  filterStarBufferByPosition,
  focusDistanceForStarRadiusAU,
  loadExoplanetHostStars,
  loadVisibleStarField,
  searchCatalogStars,
  starDisplayFromMagnitude,
  type CatalogStar,
  type StarBuffer,
  type StarSearchResult,
} from "./catalog/stars";
import { classifyStarModelType } from "./catalog/star-types";
import {
  canonicalHostKey,
  exoplanetColor,
  exoplanetRadiusAU,
  loadExoplanetCatalog,
  planetByName,
  planetWorldPos,
  planetsForHost,
  searchExoplanets,
} from "./catalog/exoplanets";
import {
  GALAXY_FLOATS,
  LOCAL_GROUP_GALAXY_LABELS,
  MILKY_WAY_RADIUS_AU,
  loadGalaxyCatalog,
  searchGalaxies,
  type GalaxyBuffer,
  type NamedGalaxy,
} from "./catalog/galaxies";
import { galaxyModelFocusDistance, galaxyTextureModels } from "./catalog/galaxy-models";
import { SOLAR_SYSTEM_MODEL_ASSETS } from "./catalog/solar-system-models";
import {
  MILKY_WAY_MODEL_OBJECTS,
  milkyWayModelById,
  milkyWayModelNebulaExclusionSlugs,
  milkyWayModelSearchResults,
  searchMilkyWayModels,
} from "./catalog/milkyway-models";
import { loadMilkywayStars } from "./catalog/milkyway";
import {
  buildDustCloudBuffer,
  DUST_CLOUD_DEFAULT_DRAW_COUNT,
  DUST_CLOUD_FLOATS,
  DUST_CLOUD_SOURCE,
  loadDustMap,
} from "./catalog/dust";
import { NEARBY_STAR_LABELS, SGR_A_STAR_POS, type NearbyStarLabel } from "./catalog/nearby-stars";
import { sortIntoOctants } from "./gpu/sky-cull";
import {
  constellationsToSearchResults,
  loadConstellationLines,
  searchConstellations,
  type ConstellationFigure,
  type ConstellationLabel,
} from "./catalog/constellations";
import {
  buildNebulaBuffer,
  nebulaPositions,
  NEB_COLOR,
  type NebulaDet,
} from "./catalog/nebulas";
import { BackendUnavailableError, backendAssetUrl, backendFetch, readBackendJson } from "./services/backend";

const MAX_BODIES = 1024;
const MAX_CATALOG_STARS  = DEFAULT_VISIBLE_STAR_COUNT + 8_000;
const MAX_CATALOG_GALAXIES = 200_000;
const MAX_STEPS  = 2000;
const KM_PER_AU = 149_597_870.7;
const SOLAR_MASS_KG = 1.98847e30;
const GRAVITATIONAL_CONSTANT = 6.67430e-11;
const SPEED_OF_LIGHT_M_S = 299_792_458;
const SGR_A_MASS_SOLAR = 4.3e6;
const SGR_A_EVENT_HORIZON_RADIUS_AU =
  (2 * GRAVITATIONAL_CONSTANT * SGR_A_MASS_SOLAR * SOLAR_MASS_KG) /
  (SPEED_OF_LIGHT_M_S * SPEED_OF_LIGHT_M_S) /
  1000 /
  KM_PER_AU;
const SGR_A_SHADOW_RADIUS_AU = SGR_A_EVENT_HORIZON_RADIUS_AU * 2.6;
const SGR_A_DEFAULT_OBSERVER_DISTANCE_RS = 30;
const SGR_A_BLACK_HOLE_FOCUS_AU =
  SGR_A_EVENT_HORIZON_RADIUS_AU * SGR_A_DEFAULT_OBSERVER_DISTANCE_RS;
const SGR_A_MODEL_RADIUS_AU = SGR_A_EVENT_HORIZON_RADIUS_AU;
const SGR_A_BLACK_HOLE_MODEL: BlackHoleModelAsset = {
  id: "blackhole:sgr-a-model",
  assetUrl: blackHoleModelUrl,
  format: "glb",
  position: SGR_A_STAR_POS,
  radiusAU: SGR_A_MODEL_RADIUS_AU,
  color: [0.012, 0.018, 0.026],
  opacity: 1,
};
const SGR_A_SEARCH_RESULT: StarSearchResult = {
  id: "blackhole:sgr-a",
  label: "Sagittarius A*",
  subtitle: "Milky Way central black hole; event horizon diameter ~0.17 AU",
  x: SGR_A_STAR_POS[0],
  y: SGR_A_STAR_POS[1],
  z: SGR_A_STAR_POS[2],
  focusDistance: SGR_A_BLACK_HOLE_FOCUS_AU,
  color: [1.0, 0.52, 0.18],
  objectType: "black hole",
};
const KNOWN_GALAXY_ALIASES: Record<string, readonly string[]> = {
  "milky-way": ["home galaxy", "galaxy"],
  lmc: ["lmc"],
  smc: ["smc"],
  andromeda: ["m31"],
  triangulum: ["m33"],
  "ngc-205": ["m110"],
  "m81": ["bodes galaxy", "bode galaxy"],
  "m82": ["cigar galaxy"],
  "cen-a": ["centaurus a", "ngc 5128"],
  "m83": ["southern pinwheel"],
  "m101": ["pinwheel galaxy"],
  "m51": ["whirlpool galaxy"],
  "m104": ["sombrero galaxy"],
  "m87": ["virgo a"],
};
const GENERIC_GALAXY_CLOSE_FOCUS_AU = 220;
const LIGHT_YEARS_PER_PARSEC = 3.26156;
const SELECTED_NEARBY_STAR_SCREEN_WIDTH_FRACTION = 0.50;
const CAMERA_FOV_Y = Math.PI / 4; // keep in sync with src/scene/camera.ts
const CAMERA_NEAR_AU = 1e-8; // keep in sync with src/scene/camera.ts
const CAMERA_FAR_AU = 50_000_000; // keep in sync with src/scene/camera.ts
const MAP_WHEEL_ZOOM_STEPS = 10;
const MAP_DOUBLE_CLICK_TRAVEL_SECONDS = 2.5;
const MAP_TARGET_LOCK_BOX_PX = 10;
const MAP_TARGET_LOCK_HALF_PX = MAP_TARGET_LOCK_BOX_PX / 2;
const MAP_TARGET_LOCK_MIN_RADIUS_PX = 2.5;
const MAP_TARGET_LOCK_MAX_RANK_RADIUS_PX = 260;
// Active substep size (yr) — changed via Settings panel.
// Larger steps = faster simulation but reduced moon accuracy.
let simSubstepYr = MAX_SUBSTEP_YR; // default: 15 min (precise)
// Startup years determines available history for slow outer bodies; TrailSystem
// caps each body's retained path to at most one current orbital circumference.
// 50 yr: Saturn can fill one capped orbit, Uranus ~0.6 orbit, Neptune ~0.3 orbit.
const STARTUP_TRAIL_YEARS = 50;
const STARTUP_TRAIL_STEP_YR = 1 / 365.25;
const STARTUP_TRAIL_STEPS = Math.round(STARTUP_TRAIL_YEARS / STARTUP_TRAIL_STEP_YR);
const STARTUP_TRAIL_BODIES = new Set([
  "Sun",
  "Mercury",
  "Venus",
  "Earth",
  "Mars",
  "Jupiter",
  "Saturn",
  "Uranus",
  "Neptune",
  // Dwarf planets — seeded if Horizons loaded them; silently skipped otherwise
  "Pluto",
  "Eris",
  "Ceres",
  "Haumea",
  "Makemake",
]);

const DENSE_CLUSTER_CELL_PX = 3;
const DENSE_CLUSTER_MIN_BODIES = 4;

interface FocusInfo {
  title: string;
  subtitle: string;
  objectType: string;
}

interface NasaObjectInfo {
  title?: string;
  objectType?: string;
  description?: string;
  imageUrl?: string | null;
  imageCredit?: string | null;
  imageLicense?: string | null;
  imageLicenseUrl?: string | null;
  imageProvider?: string | null;
  imageSourceTitle?: string | null;
  imageSourceUrl?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  wikipediaUrl?: string | null;
  provider?: string;
  cacheHit?: boolean;
  stale?: boolean;
  warning?: string;
  error?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function nearbyStarLabelsToRenderBuffer(stars: readonly NearbyStarLabel[]): StarBuffer {
  const data = new Float32Array(stars.length * STAR_FLOATS);

  for (let i = 0; i < stars.length; i++) {
    const star = stars[i]!;
    const tierFade = Math.max(0, Math.min(1, 1 - star.tier * 0.08));
    const o = i * STAR_FLOATS;

    data[o + 0] = star.x;
    data[o + 1] = star.y;
    data[o + 2] = star.z;
    data[o + 3] = star.radiusAU ?? 0.00465047;
    data[o + 4] = star.color[0];
    data[o + 5] = star.color[1];
    data[o + 6] = star.color[2];
    const display = starDisplayFromMagnitude(star.magnitude ?? null, 0.28);
    data[o + 7] = clamp((0.08 + Math.pow(display, 0.90) * 0.82) * tierFade, 0.04, 0.98);
  }

  return data;
}

function sunStellarAnchorRenderBuffer(): StarBuffer {
  const data = new Float32Array(STAR_FLOATS);
  data[0] = 0;
  data[1] = 0;
  data[2] = 0;
  data[3] = SOLAR_RADIUS_AU;
  data[4] = 1.00;
  data[5] = 0.92;
  data[6] = 0.75;
  data[7] = 0.92;
  return data;
}

function isMajorRenderBody(body: Body): boolean {
  return body.type === BodyType.Star ||
    body.type === BodyType.Planet ||
    body.type === BodyType.DwarfPlanet ||
    body.type === BodyType.Exoplanet;
}

interface StableProjectionPoint {
  nx: number;
  ny: number;
  nz: number;
  w: number;
}

function projectStableNdc(
  x: number,
  y: number,
  z: number,
  viewProj: Mat4,
  cameraFrame: CameraUniforms | null = null,
): StableProjectionPoint | null {
  if (cameraFrame) {
    const right = cameraFrame.camRight;
    const up = cameraFrame.camUp;
    const back: [number, number, number] = [
      right[1] * up[2] - right[2] * up[1],
      right[2] * up[0] - right[0] * up[2],
      right[0] * up[1] - right[1] * up[0],
    ];
    const rx = x - cameraFrame.eye[0];
    const ry = y - cameraFrame.eye[1];
    const rz = z - cameraFrame.eye[2];
    const vx = rx * right[0] + ry * right[1] + rz * right[2];
    const vy = rx * up[0] + ry * up[1] + rz * up[2];
    const vz = rx * back[0] + ry * back[1] + rz * back[2];
    const w = -vz;
    if (w <= 0) return null;

    const aspect = Math.max(window.innerWidth / Math.max(window.innerHeight, 1), 1e-6);
    const nf = 1 / (CAMERA_NEAR_AU - CAMERA_FAR_AU);
    const cx = vx * cameraFrame.focalY / aspect;
    const cy = vy * cameraFrame.focalY;
    const cz = CAMERA_FAR_AU * nf * vz + CAMERA_FAR_AU * CAMERA_NEAR_AU * nf;
    return { nx: cx / w, ny: cy / w, nz: cz / w, w };
  }

  /* eslint-disable @typescript-eslint/no-non-null-assertion */
  const cx = viewProj[0]!*x + viewProj[4]!*y + viewProj[8]! *z + viewProj[12]!;
  const cy = viewProj[1]!*x + viewProj[5]!*y + viewProj[9]! *z + viewProj[13]!;
  const cz = viewProj[2]!*x + viewProj[6]!*y + viewProj[10]!*z + viewProj[14]!;
  const cw = viewProj[3]!*x + viewProj[7]!*y + viewProj[11]!*z + viewProj[15]!;
  /* eslint-enable */
  if (cw <= 0) return null;
  return { nx: cx / cw, ny: cy / cw, nz: cz / cw, w: cw };
}

function buildBodyRenderVisibility(
  bodies: Body[],
  viewProj: Mat4,
  focusedSystemMembers: ReadonlySet<string>,
  cameraFrame: CameraUniforms | null = null,
): Map<number, number> {
  interface ClusterEntry {
    body: Body;
    apparentRadiusPx: number;
    protected: boolean;
  }

  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const clusters = new Map<string, ClusterEntry[]>();
  const visibility = new Map<number, number>();

  for (const body of bodies) visibility.set(body.id, 1);

  for (const body of bodies) {
    const projected = projectStableNdc(body.x, body.y, body.z, viewProj, cameraFrame);
    if (!projected) continue;
    const { nx, ny, nz, w } = projected;
    if (nz < 0 || nz > 1.02 || Math.abs(nx) > 1.04 || Math.abs(ny) > 1.04) continue;

    const screenX = (nx + 1) * 0.5 * cssW;
    const screenY = (1 - ny) * 0.5 * cssH;
    const cellX = Math.round(screenX / DENSE_CLUSTER_CELL_PX);
    const cellY = Math.round(screenY / DENSE_CLUSTER_CELL_PX);
    const apparentRadiusPx = Math.max(0, body.radius / w) * cssH;
    const protectedBody = isMajorRenderBody(body) || focusedSystemMembers.has(body.name);
    const key = `${cellX}:${cellY}`;
    const bucket = clusters.get(key);
    const entry = { body, apparentRadiusPx, protected: protectedBody };
    if (bucket) bucket.push(entry);
    else clusters.set(key, [entry]);
  }

  for (const entries of clusters.values()) {
    if (entries.length < DENSE_CLUSTER_MIN_BODIES) continue;

    const protectedEntries = entries.filter(e => e.protected);
    if (protectedEntries.length > 0) {
      for (const entry of entries) {
        if (!entry.protected) visibility.set(entry.body.id, 0);
      }
      continue;
    }

    let keep = entries[0]!;
    for (const entry of entries) {
      if (entry.apparentRadiusPx > keep.apparentRadiusPx) keep = entry;
    }
    for (const entry of entries) {
      if (entry !== keep) visibility.set(entry.body.id, 0);
    }
  }

  return visibility;
}

// ── Loading overlay ───────────────────────────────────────────────────────────
const loadingEl  = document.getElementById("loading-overlay")!;
const loadProgEl = document.getElementById("loading-progress")!;
const loadTextEl = document.getElementById("loading-text")!;
const loadBarEl  = document.getElementById("loading-bar-fill") as HTMLElement;
const loadPctEl  = document.getElementById("loading-percent")!;
type LoadingUnit = "assets" | "bodies";
let loadingHideTimer: number | null = null;

function showLoading(msg: string, total = TOTAL_BODIES, unit: LoadingUnit = "bodies") {
  if (loadingHideTimer !== null) {
    window.clearTimeout(loadingHideTimer);
    loadingHideTimer = null;
  }
  loadTextEl.textContent = msg;
  setLoadProg(0, total, unit);
  loadingEl.classList.remove("hidden", "gone");
}
function setLoadProg(n: number, t: number, unit?: LoadingUnit) {
  const total = Math.max(1, t);
  const current = Math.max(0, Math.min(n, total));
  const suffix = unit ? ` ${unit}` : "";
  const pct = Math.round((current / total) * 100);
  loadProgEl.textContent = `${current} / ${total}${suffix}`;
  loadBarEl.style.width = `${pct}%`;
  loadPctEl.textContent = `${pct}%`;
}
function hideLoading() {
  loadingEl.classList.add("hidden");
  loadingHideTimer = window.setTimeout(() => {
    loadingEl.classList.add("gone");
    loadingHideTimer = null;
  }, 450);
}

function horizonsSourceLabel(result: HorizonsResult, dateStr: string): string {
  const source = result.source === "jpl-network"
    ? "NASA JPL backend refresh"
    : result.source === "backend-cache"
      ? "NASA JPL backend cache"
    : result.source === "file-cache"
      ? "NASA JPL file cache"
      : result.source === "stale-cache"
        ? `NASA JPL stale cache (${result.snapshot.date})`
        : "NASA JPL browser cache";
  const fallback = result.warnings.length ? ` (${result.warnings.length} fallback)` : "";
  return `${source}${fallback} · SSB frame · ${dateStr}`;
}

// ── Apply Horizons result to the bodies array ─────────────────────────────────
// Existing bodies (Sun + planets) get position/velocity updated.
// Unknown names (moons) get a new Body created from the moons data table.
function applyHorizons(bodies: Body[], result: HorizonsResult): void {
  for (const sv of result.vectors) {
    let b: Body | undefined = bodies.find(b => b.name === sv.name);
    if (!b) {
      const moon = createSecondaryBody(sv.name);
      if (!moon) continue; // not in our data table — skip
      bodies.push(moon);
      b = moon;
    }
    b.x = sv.x; b.y = sv.y; b.z = sv.z;
    b.vx = sv.vx; b.vy = sv.vy; b.vz = sv.vz;
  }
}

function cloneBodies(source: Body[]): Body[] {
  return source.map(b => ({
    ...b,
    color: [...b.color] as [number, number, number],
  }));
}

function stepSimulationState(
  stateBodies: Body[],
  origin: GalacticOriginState,
  dtYr: number,
): void {
  stepLeapfrog(stateBodies, dtYr, {
    externalAcceleration: body => galacticTidalAcceleration(body, origin),
  });
  stepGalacticOrigin(origin, dtYr);
}

function seedStartupTrails(
  trails: TrailSystem,
  currentBodies: Body[],
  currentOrigin: GalacticOriginState,
): void {
  const recordedCurrentBodies = currentBodies.filter(b => STARTUP_TRAIL_BODIES.has(b.name));
  const historyBodies = cloneBodies(recordedCurrentBodies);
  const historyOrigin = { ...currentOrigin };

  trails.clear();
  if (historyBodies.length === 0) return;

  for (let i = 0; i < STARTUP_TRAIL_STEPS; i++) {
    stepSimulationState(historyBodies, historyOrigin, -STARTUP_TRAIL_STEP_YR);
  }

  let historyTime = -STARTUP_TRAIL_STEPS * STARTUP_TRAIL_STEP_YR;
  trails.record(historyBodies);

  for (let i = 1; i < STARTUP_TRAIL_STEPS; i++) {
    stepSimulationState(historyBodies, historyOrigin, STARTUP_TRAIL_STEP_YR);
    historyTime += STARTUP_TRAIL_STEP_YR;
    trails.record(historyBodies);
  }

  // End on the exact loaded state rather than the numerically round-tripped clone.
  trails.record(recordedCurrentBodies);
}

async function main(): Promise<void> {
  const canvas       = document.getElementById("canvas") as HTMLCanvasElement;
  const errorOverlay = document.getElementById("error-overlay")!;
  const sourceEl     = document.getElementById("hud-source")!;
  const focusTitleEl = document.getElementById("focus-title")!;
  const objectInfoModal = document.getElementById("object-info-modal")!;
  const objectInfoClose = document.getElementById("object-info-close")!;
  const objectInfoTitle = document.getElementById("object-info-title")!;
  const objectInfoType = document.getElementById("object-info-type")!;
  const objectInfoStatus = document.getElementById("object-info-status")!;
  const objectInfoDescription = document.getElementById("object-info-description")!;
  const objectInfoSource = document.getElementById("object-info-source") as HTMLAnchorElement;
  const objectInfoImageWrap = document.getElementById("object-info-image-wrap")!;
  const objectInfoImage = document.getElementById("object-info-image") as HTMLImageElement;
  const objectInfoImageCredit = document.getElementById("object-info-image-credit") as HTMLAnchorElement;

  let currentFocusInfo: FocusInfo | null = null;
  let objectInfoRequestSeq = 0;

  function showObjectInfoModal(open: boolean): void {
    objectInfoModal.classList.toggle("open", open);
    objectInfoModal.setAttribute("aria-hidden", String(!open));
  }

  function setObjectInfoStatus(text: string, isError = false): void {
    objectInfoStatus.textContent = text;
    objectInfoStatus.classList.toggle("error", isError);
  }

  function objectInfoImageCreditText(info: NasaObjectInfo | null | undefined): string {
    const credit = normalizeObjectInfoText(info?.imageCredit);
    const license = normalizeObjectInfoText(info?.imageLicense);
    if (credit && license) return `${credit} · ${license}`;
    return credit || license;
  }

  function setObjectInfoImage(imageUrl: string | null | undefined, info?: NasaObjectInfo): void {
    const creditText = objectInfoImageCreditText(info);
    const creditHref = info?.imageSourceUrl || info?.imageLicenseUrl || "";

    if (imageUrl) {
      objectInfoImage.src = imageUrl;
      objectInfoImageWrap.classList.remove("empty");
      objectInfoImageCredit.textContent = creditText;
      objectInfoImageCredit.hidden = !creditText;
      if (creditHref) objectInfoImageCredit.href = creditHref;
      else objectInfoImageCredit.removeAttribute("href");
    } else {
      objectInfoImage.removeAttribute("src");
      objectInfoImageWrap.classList.add("empty");
      objectInfoImageCredit.textContent = "";
      objectInfoImageCredit.hidden = true;
      objectInfoImageCredit.removeAttribute("href");
    }
  }

  function setObjectInfoLoading(isLoading: boolean): void {
    objectInfoModal.classList.toggle("loading", isLoading);
    if (!isLoading) {
      objectInfoSource.removeAttribute("aria-hidden");
      return;
    }

    objectInfoTitle.textContent = "";
    objectInfoType.textContent = "";
    objectInfoDescription.textContent = "";
    objectInfoSource.textContent = "";
    objectInfoSource.removeAttribute("href");
    objectInfoSource.setAttribute("aria-hidden", "true");
    objectInfoImageCredit.textContent = "";
    objectInfoImageCredit.hidden = true;
    objectInfoImageCredit.removeAttribute("href");
    setObjectInfoStatus("");
    setObjectInfoImage(null);
  }

  function normalizeObjectInfoText(value: string | null | undefined): string {
    return (value ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  function objectTypeLabel(value: string | null | undefined): string {
    const text = normalizeObjectInfoText(value || "object");
    return text ? text[0]!.toUpperCase() + text.slice(1) : "Object";
  }

  function truncateObjectInfoStatus(value: string): string {
    if (value.length <= 150) return value;
    return `${value.slice(0, 147).replace(/\s+\S*$/, "")}...`;
  }

  function objectInfoDataStatus(info: NasaObjectInfo, focus: FocusInfo): string {
    const typeLabel = objectTypeLabel(info.objectType || focus.objectType);
    const subtitle = normalizeObjectInfoText(focus.subtitle);
    if (subtitle && subtitle.toLowerCase() !== typeLabel.toLowerCase()) {
      const detail = typeLabel.toLowerCase() === "galaxy" && /\b(?:kpc|Mpc)\b/.test(subtitle)
        ? `${subtitle} from the Milky Way`
        : subtitle;
      return `${typeLabel} · ${detail}`;
    }

    const description = normalizeObjectInfoText(info.description)
      .replace(/^NASA image release\s+[A-Za-z]+ \d{1,2}, \d{4}\s*/i, "");
    const firstSentence = (description.match(/[^.!?]+[.!?]+/)?.[0] ?? description).trim();
    return truncateObjectInfoStatus(firstSentence || `${typeLabel} · ${info.title || focus.title}`);
  }

  function objectInfoSourceText(info: NasaObjectInfo): string {
    const provider = normalizeObjectInfoText(info.provider);
    const sourceTitle = normalizeObjectInfoText(info.sourceTitle)
      .replace(/^Wikipedia:\s*/i, "")
      .replace(/^NASA(?:\s+Science)?[:\s-]*/i, "")
      .replace(/^NASA Image and Video Library$/i, "")
      .trim();
    if (/^wikipedia$/i.test(provider)) {
      if (!sourceTitle || /^wikipedia$/i.test(sourceTitle)) return "Wikipedia";
      return `Wikipedia: ${sourceTitle}`;
    }
    return sourceTitle ? `Source: ${sourceTitle}` : "Source";
  }

  function closeObjectInfo(): void {
    showObjectInfoModal(false);
  }

  function renderObjectInfo(info: NasaObjectInfo, focus: FocusInfo): void {
    setObjectInfoLoading(false);
    objectInfoTitle.textContent = info.title || focus.title;
    objectInfoType.textContent = info.objectType || focus.objectType;
    objectInfoDescription.textContent = info.description || "No description was returned for this object.";
    setObjectInfoImage(info.imageUrl, info);

    objectInfoSource.href = info.wikipediaUrl || info.sourceUrl || "https://en.wikipedia.org/";
    objectInfoSource.textContent = objectInfoSourceText(info);

    if (info.error) {
      setObjectInfoStatus("Object lookup failed.", true);
    } else if (info.stale) {
      setObjectInfoStatus("Showing previously retrieved object data.");
    } else {
      setObjectInfoStatus(objectInfoDataStatus(info, focus));
    }
  }

  async function openObjectInfo(): Promise<void> {
    const focus = currentFocusInfo;
    if (!focus) return;

    const seq = ++objectInfoRequestSeq;
    setObjectInfoLoading(true);
    showObjectInfoModal(true);

    const params = new URLSearchParams({
      title: focus.title,
      type: focus.objectType,
    });
    if (focus.subtitle) params.set("subtitle", focus.subtitle);

    try {
      const response = await backendFetch(`/api/object-info?${params}`);
      const payload = await readBackendJson<NasaObjectInfo>(response);
      payload.imageUrl = backendAssetUrl(payload.imageUrl, response.url);
      if (seq !== objectInfoRequestSeq) return;
      if (!response.ok) {
        renderObjectInfo(payload, focus);
        return;
      }
      renderObjectInfo(payload, focus);
    } catch (err) {
      if (seq !== objectInfoRequestSeq) return;
      const backendMessage = err instanceof BackendUnavailableError
        ? "This page is not connected to the CosmosMap backend. Start the app with npm run dev and open the CosmosMap dev server URL."
        : "The local CosmosMap information service is not reachable.";
      renderObjectInfo({
        title: focus.title,
        objectType: focus.objectType,
        description: backendMessage,
        sourceUrl: "https://en.wikipedia.org/",
        sourceTitle: "Wikipedia",
        provider: "Wikipedia",
        error: "service_unreachable",
      }, focus);
    }
  }

  objectInfoClose.addEventListener("click", closeObjectInfo);
  objectInfoModal.addEventListener("click", e => { if (e.target === objectInfoModal) closeObjectInfo(); });

  function setFocusTitle(title: string | null, subtitle = "", objectType = "object"): void {
    focusTitleEl.replaceChildren();
    if (!title) {
      currentFocusInfo = null;
      closeObjectInfo();
      focusTitleEl.hidden = true;
      return;
    }

    const focusChanged =
      !currentFocusInfo ||
      currentFocusInfo.title !== title ||
      currentFocusInfo.objectType !== objectType;
    if (focusChanged) closeObjectInfo();
    currentFocusInfo = { title, subtitle, objectType };

    const nameEl = document.createElement("span");
    nameEl.className = "focus-title-name";
    nameEl.textContent = title;
    focusTitleEl.appendChild(nameEl);

    if (subtitle) {
      const subEl = document.createElement("span");
      subEl.className = "focus-title-sub";
      subEl.textContent = subtitle;
      focusTitleEl.appendChild(subEl);
    }

    const infoBtn = document.createElement("button");
    infoBtn.type = "button";
    infoBtn.className = "focus-info-btn";
    infoBtn.title = "Object information";
    infoBtn.setAttribute("aria-label", `Object information for ${title}`);
    infoBtn.textContent = "ⓘ";
    infoBtn.addEventListener("click", e => {
      e.stopPropagation();
      void openObjectInfo();
    });
    focusTitleEl.appendChild(infoBtn);

    focusTitleEl.hidden = false;
  }

  function galaxyFocusSubtitle(distanceMpc: number): string {
    if (!Number.isFinite(distanceMpc) || distanceMpc <= 0) return "galaxy";
    return distanceMpc < 1
      ? `${Math.round(distanceMpc * 1000)} kpc`
      : `${distanceMpc.toFixed(distanceMpc < 10 ? 2 : 1)} Mpc`;
  }

  function normalizeGalaxySearchText(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function galaxySearchId(name: string): string {
    return `galaxy:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  }

  function mapObjectSearchId(prefix: string, name: string): string {
    return `${prefix}:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  }

  function enableConstellationLayerForFocus(): void {
    const input = document.getElementById("set-constellations") as HTMLInputElement | null;
    if (!input || input.checked) return;
    input.checked = true;
    applySettings();
  }

  function galaxySelectionFocusDistance(id: string): number {
    return galaxyModelFocusDistance(id) ?? GENERIC_GALAXY_CLOSE_FOCUS_AU;
  }

  function knownGalaxySearchRank(
    query: string,
    id: string,
    name: string,
    distanceMpc: number,
  ): number | null {
    const aliases = KNOWN_GALAXY_ALIASES[id] ?? [];
    const normalizedId = normalizeGalaxySearchText(id);
    const normalizedName = normalizeGalaxySearchText(name);
    const normalizedAliases = aliases.map(normalizeGalaxySearchText);
    const haystack = [normalizedId, normalizedName, ...normalizedAliases].join(" ");
    const index = haystack.indexOf(query);
    if (index < 0) return null;

    const exact =
      normalizedId === query ||
      normalizedName === query ||
      normalizedAliases.some(alias => alias === query);
    const starts =
      normalizedId.startsWith(query) ||
      normalizedName.startsWith(query) ||
      normalizedAliases.some(alias => alias.startsWith(query));
    return (exact ? -100 : starts ? 0 : 1000) + index + Math.max(0, distanceMpc) * 0.01;
  }

  function localGroupGalaxyResult(galaxy: (typeof LOCAL_GROUP_GALAXY_LABELS)[number]): StarSearchResult {
    return {
      id: `galaxy:${galaxy.id}`,
      label: galaxy.name,
      subtitle: galaxyFocusSubtitle(galaxy.dist),
      x: galaxy.x,
      y: galaxy.y,
      z: galaxy.z,
      focusDistance: galaxySelectionFocusDistance(galaxy.id),
      color: [galaxy.color[0], galaxy.color[1], galaxy.color[2]],
      objectType: "galaxy",
    };
  }

  function milkyWayGalaxyResult(): StarSearchResult {
    return {
      id: "galaxy:milky-way",
      label: "Milky Way",
      subtitle: "home galaxy · center at Sagittarius A*",
      x: SGR_A_STAR_POS[0],
      y: SGR_A_STAR_POS[1],
      z: SGR_A_STAR_POS[2],
      focusDistance: camera.distanceForViewRadius(MILKY_WAY_RADIUS_AU * 1.18, 0.70),
      color: [0.82, 0.88, 1.00],
      objectType: "galaxy",
    };
  }

  function searchKnownGalaxies(query: string, limit = 6): StarSearchResult[] {
    const q = normalizeGalaxySearchText(query);
    if (q.length < 2) return [];

    const hits: { rank: number; hit: StarSearchResult }[] = [];
    const milkyWayRank = knownGalaxySearchRank(q, "milky-way", "Milky Way", 0);
    if (milkyWayRank !== null) {
      hits.push({ rank: milkyWayRank, hit: milkyWayGalaxyResult() });
    }

    for (const galaxy of LOCAL_GROUP_GALAXY_LABELS) {
      const rank = knownGalaxySearchRank(q, galaxy.id, galaxy.name, galaxy.dist);
      if (rank !== null) hits.push({ rank, hit: localGroupGalaxyResult(galaxy) });
    }

    return hits
      .sort((a, b) => a.rank - b.rank || a.hit.label.localeCompare(b.hit.label))
      .slice(0, limit)
      .map(item => item.hit);
  }

  function catalogGalaxyResult(r: ReturnType<typeof searchGalaxies>[number]): StarSearchResult {
    const label = LOCAL_GROUP_GALAXY_LABELS.find(g => g.name === r.name);
    const focusDistance = label
      ? galaxySelectionFocusDistance(label.id)
      : GENERIC_GALAXY_CLOSE_FOCUS_AU;
    return {
      id: label ? `galaxy:${label.id}` : galaxySearchId(r.name),
      label: r.name,
      subtitle: galaxyFocusSubtitle(r.dist),
      x: r.x, y: r.y, z: r.z,
      focusDistance,
      color: [0.82, 0.88, 1.00],
      objectType: "galaxy",
    };
  }

  function mergeGalaxySearchHits(knownHits: StarSearchResult[], catalogHits: StarSearchResult[]): StarSearchResult[] {
    const seen = new Set<string>();
    const merged: StarSearchResult[] = [];
    for (const hit of [...knownHits, ...catalogHits]) {
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      merged.push(hit);
      if (merged.length >= 8) break;
    }
    return merged;
  }

  function genericObjectSearchScore(query: string, values: readonly string[]): number | null {
    let best: number | null = null;
    for (const value of values) {
      const normalized = normalizeGalaxySearchText(value);
      if (!normalized) continue;
      const index = normalized.indexOf(query);
      if (index < 0) continue;
      const score =
        normalized === query ? 1000 :
        normalized.startsWith(query) ? 700 :
        350 - Math.min(index, 250);
      best = best === null ? score : Math.max(best, score);
    }
    return best;
  }

  function bodyObjectTypeName(body: Body): string {
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

  function bodySearchResult(body: Body): StarSearchResult {
    const objectType = bodyObjectTypeName(body);
    return {
      id: mapObjectSearchId("body", body.name),
      label: body.name,
      subtitle: `${objectType} · currently loaded simulation body`,
      x: body.x,
      y: body.y,
      z: body.z,
      focusDistance: camera.closeDistanceForRadius(body.radius),
      color: body.color,
      objectType,
      radiusAU: body.radius,
    };
  }

  function searchVisibleBodies(query: string, limit = 8): StarSearchResult[] {
    const q = normalizeGalaxySearchText(query);
    if (q.length < 2) return [];

    return bodies
      .map(body => {
        const objectType = bodyObjectTypeName(body);
        const score = genericObjectSearchScore(q, [
          body.name,
          objectType,
          `${body.name} ${objectType}`,
        ]);
        if (score === null) return null;
        return { body, score };
      })
      .filter((item): item is { body: Body; score: number } => item !== null)
      .sort((a, b) => b.score - a.score || a.body.name.localeCompare(b.body.name))
      .slice(0, limit)
      .map(({ body }) => bodySearchResult(body));
  }

  function nearbyStarSearchResult(star: NearbyStarLabel): StarSearchResult {
    const distanceLy = star.distPc * LIGHT_YEARS_PER_PARSEC;
    return {
      id: nearbyStarId(star),
      label: star.name,
      subtitle: `${star.distPc.toFixed(star.distPc < 10 ? 2 : 1)} pc · ${distanceLy.toFixed(distanceLy < 20 ? 1 : 0)} ly`,
      x: star.x,
      y: star.y,
      z: star.z,
      focusDistance: starFocusDistance(star.radiusAU),
      color: star.color,
      objectType: "star",
      radiusAU: star.radiusAU,
      radiusSolar: star.radiusSolar,
      spectralType: star.spectralType,
      starType: star.starType,
    };
  }

  function searchNearbyStarLabels(query: string, limit = 8): StarSearchResult[] {
    const q = normalizeGalaxySearchText(query);
    if (q.length < 2) return [];

    return NEARBY_STAR_LABELS
      .map(star => {
        const score = genericObjectSearchScore(q, [
          star.name,
          star.spectralType ?? "",
          star.starType ?? "",
          "nearby star",
        ]);
        if (score === null) return null;
        return { star, score };
      })
      .filter((item): item is { star: NearbyStarLabel; score: number } => item !== null)
      .sort((a, b) => {
        const scoreDelta = b.score - a.score;
        return scoreDelta || a.star.distPc - b.star.distPc || a.star.name.localeCompare(b.star.name);
      })
      .slice(0, limit)
      .map(({ star }) => nearbyStarSearchResult(star));
  }

  function nebulaTypeLabel(type: number): string {
    switch (type) {
      case 0: return "emission nebula";
      case 1: return "planetary nebula";
      case 2: return "supernova remnant";
      case 3: return "reflection nebula";
      case 4: return "mixed nebula";
      default: return "nebula";
    }
  }

  function nebulaSearchResult(neb: { name: string; type: number; x: number; y: number; z: number; radiusAU: number }): StarSearchResult {
    const objectType = nebulaTypeLabel(neb.type);
    const color = NEB_COLOR[neb.type] ?? [0.88, 0.35, 0.55];
    return {
      id: mapObjectSearchId("nebula", neb.name),
      label: neb.name,
      subtitle: objectType,
      x: neb.x,
      y: neb.y,
      z: neb.z,
      focusDistance: nebulaFocusDistance(neb),
      color,
      objectType,
    };
  }

  function searchNebulas(query: string, limit = 8): StarSearchResult[] {
    const q = normalizeGalaxySearchText(query);
    if (q.length < 2) return [];

    return nebulaDets
      .map(neb => {
        const objectType = nebulaTypeLabel(neb.type);
        const score = genericObjectSearchScore(q, [
          neb.name,
          objectType,
          "nebula",
        ]);
        if (score === null) return null;
        return { neb, score };
      })
      .filter((item): item is { neb: NebulaDet; score: number } => item !== null)
      .sort((a, b) => b.score - a.score || a.neb.name.localeCompare(b.neb.name))
      .slice(0, limit)
      .map(({ neb }) => nebulaSearchResult(neb));
  }

  function dedupeSearchResults(hits: readonly StarSearchResult[]): StarSearchResult[] {
    const seen = new Set<string>();
    const starHits: StarSearchResult[] = [];
    const deduped: StarSearchResult[] = [];
    for (const hit of hits) {
      const objectType = hit.objectType ?? "";
      const labelOnlyKey = normalizeGalaxySearchText(hit.label);
      const labelKey = `${labelOnlyKey}|${objectType}`;
      const keys = [hit.id, labelOnlyKey, labelKey];
      if (keys.some(key => seen.has(key))) continue;
      const isStarHit = objectType === "star" || hit.id.startsWith("nearby:") || hit.id.startsWith("exo-");
      if (isStarHit) {
        const overlapsExistingStar = starHits.some(existing => (
          Math.hypot(hit.x - existing.x, hit.y - existing.y, hit.z - existing.z) <= STAR_DEDUPE_POSITION_TOLERANCE_AU
        ));
        if (overlapsExistingStar) continue;
        starHits.push(hit);
      }
      keys.forEach(key => seen.add(key));
      deduped.push(hit);
    }
    return deduped;
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(window.innerWidth  * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  // ── Fullscreen toggle ─────────────────────────────────────────────────────
  const btnFS = document.getElementById("btn-fullscreen")!;
  function updateFSIcon() {
    btnFS.textContent = document.fullscreenElement ? "✕" : "⛶";
    (btnFS as HTMLButtonElement).title = document.fullscreenElement
      ? "Exit fullscreen" : "Enter fullscreen";
  }
  btnFS.addEventListener("click", () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  });
  document.addEventListener("fullscreenchange", updateFSIcon);

  // ── Settings panel ────────────────────────────────────────────────────────
  const settingsModal   = document.getElementById("settings-modal")!;
  const settingsCloseBtn = document.getElementById("settings-close")!;
  const navSettingsBtn  = document.getElementById("nav-settings-btn")!;
  const infoModal       = document.getElementById("info-modal")!;
  const infoCloseBtn    = document.getElementById("info-close")!;
  const navAboutBtn     = document.getElementById("nav-about-btn")!;
  const navLimitsBtn    = document.getElementById("nav-limits-btn")!;
  const infoAboutPage   = document.getElementById("info-about")!;
  const infoLimitsPage  = document.getElementById("info-limits")!;

  function openSettings()  { settingsModal.classList.add("open"); }
  function closeSettings() { settingsModal.classList.remove("open"); }
  function openInfo(page: "about" | "limits") {
    infoAboutPage.classList.toggle("active", page === "about");
    infoLimitsPage.classList.toggle("active", page === "limits");
    infoModal.classList.add("open");
  }
  function closeInfo() { infoModal.classList.remove("open"); }

  navSettingsBtn.addEventListener("click",  openSettings);
  navAboutBtn.addEventListener("click", () => openInfo("about"));
  navLimitsBtn.addEventListener("click", () => openInfo("limits"));
  settingsCloseBtn.addEventListener("click", closeSettings);
  infoCloseBtn.addEventListener("click", closeInfo);
  settingsModal.addEventListener("click", e => { if (e.target === settingsModal) closeSettings(); });
  infoModal.addEventListener("click", e => { if (e.target === infoModal) closeInfo(); });
  let showGalaxies = true;
  let showConstellations = false;

  // Accumulates "owed" simulation time when at fast timewarp and using fixed
  // substeps. Apply settings runs during startup, so this must be initialized
  // before that first settings pass can reset the accumulator.
  let physicsAccumYr = 0;
  let lastTwSign     = 1;
  let actualSimRate  = 0; // smoothed actual simulation rate in yr/s

  function applySettings(): void {
    const showLabels = (document.getElementById("set-labels") as HTMLInputElement).checked;
    const showTrails = (document.getElementById("set-trails") as HTMLInputElement).checked;
    showConstellations = (document.getElementById("set-constellations") as HTMLInputElement).checked;
    const showDust = (document.getElementById("set-dust-clouds") as HTMLInputElement).checked;
    const dustTransparencyInput = document.getElementById("set-dust-transparency") as HTMLInputElement;
    const dustTransparencyValue = document.getElementById("set-dust-transparency-value")!;
    const dustTransparency = Math.max(0, Math.min(1, Number(dustTransparencyInput.value) / 100));
    dustTransparencyInput.disabled = !showDust;
    dustTransparencyValue.textContent = `${Math.round(dustTransparency * 100)}%`;
    const dustDrawLimit = parseInt(
      (document.querySelector('input[name="dust-clouds"]:checked') as HTMLInputElement)?.value ??
      String(DUST_CLOUD_DEFAULT_DRAW_COUNT),
      10,
    );
    for (const input of document.querySelectorAll<HTMLInputElement>('input[name="dust-clouds"]')) {
      input.disabled = !showDust;
    }
    const showBlackHole = (document.getElementById("set-black-hole") as HTMLInputElement).checked;
    const actualBodyBrightness = (document.getElementById("set-body-brightness") as HTMLInputElement).checked;
    const objectBrightnessInput = document.getElementById("set-object-brightness") as HTMLInputElement;
    const objectBrightnessValue = document.getElementById("set-object-brightness-value")!;
    const objectBrightness = Math.max(0.05, Math.min(2, Number(objectBrightnessInput.value) / 100));
    objectBrightnessValue.textContent = `${Math.round(objectBrightness * 100)}%`;
    showGalaxies    = (document.getElementById("set-galaxies") as HTMLInputElement).checked;
    const mwVal      = parseInt((document.querySelector('input[name="mw-stars"]:checked') as HTMLInputElement)?.value ?? "200000");
    const nearbyVal  = parseInt((document.querySelector('input[name="nearby-stars"]:checked') as HTMLInputElement)?.value ?? "100000");
    const galVal     = parseInt((document.querySelector('input[name="galaxies"]:checked') as HTMLInputElement)?.value ?? "100000");
    const stepPreset = (document.querySelector('input[name="sim-step"]:checked') as HTMLInputElement)?.value ?? "precise";

    // Map preset to substep size in years
    const stepMap: Record<string, number> = {
      precise:  1 / (365.25 * 24 * 4),   // 15 min
      balanced: 1 / (365.25 * 24),        // 1 hr
      fast:     6 / (365.25 * 24),        // 6 hr
    };
    simSubstepYr   = stepMap[stepPreset] ?? MAX_SUBSTEP_YR;
    physicsAccumYr = 0; // reset accumulator when step size changes

    labels.setVisible(showLabels);
    renderer.applySettings({
      showGalaxies,
      showConstellations,
      showDust,
      dustTransparency,
      dustDrawLimit,
      showBlackHole,
      showTrails,
      mwStarLimit:  mwVal,
      starLimit:    nearbyVal,
      galaxyLimit:  galVal,
      actualBodyBrightness,
      objectBrightness,
    });
  }

  // Apply on any change inside the modal
  settingsModal.addEventListener("change", applySettings);
  settingsModal.addEventListener("input", applySettings);

  let gpu: Awaited<ReturnType<typeof initGPU>>;
  try {
    gpu = await initGPU(canvas);
  } catch (e) {
    console.error(e);
    errorOverlay.classList.add("visible");
    loadingEl.classList.add("gone");
    return;
  }

  const renderer = new Renderer(gpu.ctx, gpu.canvasCtx);
  renderer.init(MAX_BODIES, MAX_CATALOG_STARS, MAX_CATALOG_GALAXIES);

  const camera = new Camera();
  camera.attach(canvas);

  const trails = new TrailSystem();
  const hud    = new HUD();
  const scaleBar = new ScaleBar();
  const labels = new LabelManager();
  applySettings();

  const STARTUP_ASSET_TOTAL = 13;
  let startupLoading = true;
  let startupAssetsReady = 0;
  const startupAssetPromises: Promise<void>[] = [];

  function setStartupStatus(message: string): void {
    if (!startupLoading) return;
    loadTextEl.textContent = message;
    setLoadProg(startupAssetsReady, STARTUP_ASSET_TOTAL, "assets");
  }

  function completeStartupAsset(message: string): void {
    if (!startupLoading) return;
    startupAssetsReady = Math.min(STARTUP_ASSET_TOTAL, startupAssetsReady + 1);
    loadTextEl.textContent = message;
    setLoadProg(startupAssetsReady, STARTUP_ASSET_TOTAL, "assets");
  }

  function trackStartupAsset(label: string, install: () => Promise<void> | void): Promise<void> {
    setStartupStatus(`Installing ${label}...`);
    return Promise.resolve()
      .then(install)
      .then(
        () => completeStartupAsset(`${label} ready`),
        err => {
          console.warn(`${label} failed:`, err);
          completeStartupAsset(`${label} unavailable`);
        },
      );
  }

  showLoading("Installing CosmosMap assets...", STARTUP_ASSET_TOTAL, "assets");
  // Start with empty buffers — real data loads from binary within milliseconds.
  // Avoid the 100k-star placeholder allocation that can fail on low-memory devices.
  let rawVisibleStarBuffer: StarBuffer = new Float32Array(0);
  let visibleStarBuffer: StarBuffer = new Float32Array(0);
  let exoplanetHostBuffer: StarBuffer = new Float32Array(0);
  const sunStellarAnchorBuffer = sunStellarAnchorRenderBuffer();
  const nearbyStarLabelBuffer = nearbyStarLabelsToRenderBuffer(NEARBY_STAR_LABELS);
  let exoplanetHosts: CatalogStar[] = [];
  let catalogStatus = "Loading exoplanet host catalog...";
  let lastStarDedupeLog = "";

  // Single shared function that builds the combined buffer ONCE per update and
  // uploads + sorts in one pass.  Avoids creating multiple large allocations.
  function refreshStarCatalog(): void {
    try {
      const filteredVisible = filterStarBufferByPosition(
        rawVisibleStarBuffer,
        [sunStellarAnchorBuffer, nearbyStarLabelBuffer, exoplanetHostBuffer],
      );
      visibleStarBuffer = filteredVisible.data;
      const combinedResult = combineStarBuffersUnique([
        { label: "Sun stellar anchor", buffer: sunStellarAnchorBuffer },
        { label: "nearby known stars", buffer: nearbyStarLabelBuffer },
        { label: "exoplanet host stars", buffer: exoplanetHostBuffer },
        { label: "visible mapped stars", buffer: visibleStarBuffer },
      ]);
      const combined = combinedResult.data;
      const logKey = combinedResult.stats.map(
        stat => `${stat.label}:${stat.input}:${stat.dropped}`,
      ).join("|");
      if (combinedResult.dropped > 0 && logKey !== lastStarDedupeLog) {
        lastStarDedupeLog = logKey;
        const details = combinedResult.stats
          .filter(stat => stat.dropped > 0)
          .map(stat => `${stat.dropped.toLocaleString()} ${stat.label}`)
          .join(", ");
        console.info(
          `Removed ${combinedResult.dropped.toLocaleString()} duplicate star render entries (${details}).`,
        );
      }
      renderer.setStarOctants(sortIntoOctants(combined));
      renderer.uploadStars(combined);
    } catch (e) {
      console.warn("Star catalog upload failed (low memory?):", e);
    }
  }

  // Upload the tiny named-star anchor buffer immediately. The larger catalogs
  // stream in shortly after without allocating a synthetic 100k-star fallback.
  setStartupStatus("Installing known nearby star anchors...");
  refreshStarCatalog();
  completeStartupAsset("Known nearby star anchors ready");

  startupAssetPromises.push(trackStartupAsset("visible star catalog", async () => {
    const { data, source } = await loadVisibleStarField();
    rawVisibleStarBuffer = data;
    refreshStarCatalog();
    console.info(`Loaded ${data.length / STAR_FLOATS} visible stars from ${source}.`);
  }));

  startupAssetPromises.push(trackStartupAsset("exoplanet host catalog", async () => {
    try {
      const { stars, source } = await loadExoplanetHostStars();
      exoplanetHosts = stars;
      catalogStatus = `${stars.length.toLocaleString()} host stars loaded`;
      exoplanetHostBuffer = catalogStarsToRenderBuffer(stars);
      refreshStarCatalog();
      console.info(`Loaded ${stars.length} exoplanet host stars from ${source}.`);
    } catch (err) {
      catalogStatus = "Star catalog unavailable";
      throw err;
    }
  }));

  // ── Galaxy catalog ─────────────────────────────────────────────────────────
  let galaxyBuffer: GalaxyBuffer = new Float32Array(0);
  let galaxyNames:  NamedGalaxy[] = [];

  startupAssetPromises.push(trackStartupAsset("galaxy catalog", async () => {
    const { data, names, source } = await loadGalaxyCatalog();
    galaxyBuffer = data;
    galaxyNames  = names;
    renderer.setGalaxyOctants(sortIntoOctants(data));
    renderer.uploadGalaxies(data);
    console.info(`Loaded ${data.length / GALAXY_FLOATS} galaxies from ${source}`);
  }));
  startupAssetPromises.push(trackStartupAsset("textured galaxy LODs", () => (
    renderer.loadGalaxyTextureModels(galaxyTextureModels())
  )));
  startupAssetPromises.push(trackStartupAsset("solar-system 3D models", () => (
    renderer.loadSolarSystemModels(SOLAR_SYSTEM_MODEL_ASSETS)
  )));
  startupAssetPromises.push(trackStartupAsset("Sagittarius A* 3D model", () => (
    renderer.loadBlackHoleModel(SGR_A_BLACK_HOLE_MODEL)
  )));

  // ── Milky Way background star catalog (galaxy-scale LOD layer) ───────────
  startupAssetPromises.push(trackStartupAsset("Milky Way star field", async () => {
    const { data, source } = await loadMilkywayStars();
    renderer.setMwOctants(sortIntoOctants(data));
    renderer.uploadMilkywayStars(data);
    console.info(`Loaded ${data.length / 8} Milky Way background stars from ${source}`);
  }));

  // ── Galactic dust clouds seeded from MF2015 all-sky reddening map ────────
  startupAssetPromises.push(trackStartupAsset("Galactic dust map", async () => {
    try {
      const { data, source } = await loadDustMap();
      const dustClouds = buildDustCloudBuffer(data);
      renderer.uploadDustClouds(dustClouds);
      console.info(
        `Loaded ${dustClouds.length / DUST_CLOUD_FLOATS} Milky Way dust clouds from ${source} via ${DUST_CLOUD_SOURCE}`,
      );
    } catch (err) {
      console.warn("Galactic dust map failed; using procedural fallback:", err);
      const dustClouds = buildDustCloudBuffer();
      renderer.uploadDustClouds(dustClouds);
      console.info(`Loaded ${dustClouds.length / DUST_CLOUD_FLOATS} fallback Milky Way dust clouds from ${DUST_CLOUD_SOURCE}`);
    }
  }));

  // ── Nebula catalog (Milky Way gas clouds) ─────────────────────────────────
  let nebulaDets: NebulaDet[] = [];
  startupAssetPromises.push(trackStartupAsset("nebula catalog", () => {
    const modelNebulaExclusions = milkyWayModelNebulaExclusionSlugs();
    const nebulaBuf = buildNebulaBuffer(modelNebulaExclusions);
    renderer.uploadNebulas(nebulaBuf);
    nebulaDets = nebulaPositions(modelNebulaExclusions);
    console.info(`Loaded ${nebulaDets.length} Milky Way nebulas`);
  }));

  // ── Constellation lines snapped to real visible-star positions ───────────
  let constellationLabels: ConstellationLabel[] = [];
  let constellationFigures: ConstellationFigure[] = [];
  let constellationLineData: Float32Array<ArrayBufferLike> = new Float32Array(0);
  let selectedConstellation: ConstellationFigure | null = null;
  startupAssetPromises.push(trackStartupAsset("constellation lines", async () => {
    const { data, figures, labels: loadedLabels, source, featureCount, segmentCount, snappedEndpointCount, looseEndpointCount } = await loadConstellationLines();
    constellationLineData = data;
    constellationFigures = figures;
    constellationLabels = loadedLabels;
    renderer.uploadConstellations(data);
    console.info(
      `Loaded ${segmentCount} constellation star-to-star segments across ${featureCount} figures ` +
      `(${snappedEndpointCount} snapped endpoints, ${looseEndpointCount} loose) from ${source}.`,
    );
  }));

  // ── Exoplanet visual bodies ───────────────────────────────────────────────
  // These are NOT in the physics simulation. They are added to `bodies` for
  // rendering + label display only, and are excluded by the integrator.
  let exoplanetBodyIds = new Set<number>(); // ids of current exoplanet entries in bodies
  let exoBodyIdCounter = 90_000;            // unique ids above physics bodies
  let activeExoplanetHostName: string | null = null;
  let activeExoplanetHostPos: [number, number, number] | null = null;

  function getStarWorldPos(hostName: string): [number, number, number] | null {
    const key = canonicalHostKey(hostName);
    const star = exoplanetHosts.find(s => canonicalHostKey(s.name) === key);
    if (star) return [star.x, star.y, star.z];
    const nearbyStar = NEARBY_STAR_LABELS.find(s => canonicalHostKey(s.name) === key);
    return nearbyStar ? [nearbyStar.x, nearbyStar.y, nearbyStar.z] : null;
  }

  function activeHostWorldPos(hostName: string): [number, number, number] | null {
    if (
      activeExoplanetHostName &&
      activeExoplanetHostPos &&
      canonicalHostKey(activeExoplanetHostName) === canonicalHostKey(hostName)
    ) {
      return activeExoplanetHostPos;
    }
    return getStarWorldPos(hostName);
  }

  function setExoplanetBodies(hostName: string | null, hostWorldPos?: [number, number, number]): void {
    // Remove old exoplanet bodies
    for (const id of exoplanetBodyIds) {
      const idx = bodies.findIndex(b => b.id === id);
      if (idx !== -1) bodies.splice(idx, 1);
    }
    exoplanetBodyIds.clear();
    activeExoplanetHostName = hostName;
    activeExoplanetHostPos = hostWorldPos ? [...hostWorldPos] : null;

    if (!hostName) return;
    const sp = activeHostWorldPos(hostName);
    if (!sp) return;

    const planets = planetsForHost(hostName);
    for (const p of planets) {
      const [x, y, z] = planetWorldPos(sp[0], sp[1], sp[2], p, simYears);
      const body: Body = {
        id:     exoBodyIdCounter++,
        name:   p.name,
        mass:   0,
        radius: exoplanetRadiusAU(p.radiusEarth),
        color:  exoplanetColor(p.radiusEarth),
        type:   BodyType.Exoplanet,
        x, y, z, vx: 0, vy: 0, vz: 0,
      };
      bodies.push(body);
      exoplanetBodyIds.add(body.id);
    }
  }

  startupAssetPromises.push(trackStartupAsset("exoplanet orbit catalog", async () => {
    const { planets, source } = await loadExoplanetCatalog();
    console.info(`Loaded ${planets.length} exoplanets from ${source}.`);
    if (activeExoplanetHostName) {
      setExoplanetBodies(activeExoplanetHostName, activeExoplanetHostPos ?? undefined);
      uploadBodiesForSimulation();
    }
  }));

  // ── Simulation state ──────────────────────────────────────────────────────
  let bodies: Body[] = solarSystem();
  let simYears = 0;
  let timewarp = 1.0;
  let paused   = false;
  let pausedTW = timewarp;
  let galacticOrigin = createGalacticOriginState();

  function uploadBodiesForSimulation(visibility?: ReadonlyMap<number, number>): void {
    renderer.setSimulationTimeMs(hud.epochMs + simYears * SECONDS_PER_YEAR * 1000);
    renderer.uploadBodies(bodies, visibility);
  }

  // ── Load ephemeris from Horizons (or fall back to J2000.0) ────────────────
  async function loadEphemeris(dateStr: string, msg: string, hideWhenDone = true): Promise<boolean> {
    showLoading(msg);
    try {
      const result = await fetchStatesForDate(dateStr, (n, t) => setLoadProg(n, t, "bodies"));
      applyHorizons(bodies, result);
      hud.epochMs = result.epochMs;
      galacticOrigin = createGalacticOriginState(result.epochMs);
      simYears = 0;
      loadTextEl.textContent = `Calculating ${STARTUP_TRAIL_YEARS} years of starter trails...`;
      setLoadProg(STARTUP_TRAIL_BODIES.size, STARTUP_TRAIL_BODIES.size, "bodies");
      renderer.resetTrailSlots();
      seedStartupTrails(trails, bodies, galacticOrigin);

      // ── Advance from UTC midnight to the current second ──────────────────
      // Horizons positions are at 00:00:00 UTC of dateStr.  Simulate forward
      // so the displayed time and body positions match right now.
      // At most 86 400 s ÷ 900 s/step = 96 steps — completes in milliseconds.
      const elapsedMs = Date.now() - result.epochMs;
      if (elapsedMs > 0 && elapsedMs < 86_400_000) {
        loadTextEl.textContent = 'Advancing to current time of day…';
        const elapsedYr = elapsedMs / 1000 / SECONDS_PER_YEAR;
        const nSteps    = Math.ceil(elapsedYr / MAX_SUBSTEP_YR);
        for (let i = 0; i < nSteps; i++) {
          const dt = Math.min(MAX_SUBSTEP_YR, elapsedYr - i * MAX_SUBSTEP_YR);
          stepSimulationState(bodies, galacticOrigin, dt);
          simYears += dt;
        }
        trails.record(bodies);
      }

      uploadBodiesForSimulation();

      sourceEl.textContent = horizonsSourceLabel(result, dateStr);
      if (result.warnings.length) console.warn("Horizons fallbacks:", result.warnings);
      const sun = bodies.find(b => b.name === "Sun");
      if (sun) {
        console.info("Sun SSB vector", {
          positionAu: [sun.x, sun.y, sun.z],
          velocityAuYr: [sun.vx, sun.vy, sun.vz],
          galacticSpeedKmS: galacticSpeedKmS(galacticOrigin),
          horizonsSource: result.source,
        });
      }
      if (hideWhenDone) hideLoading();
      return true;
    } catch (err) {
      console.error("Horizons fetch failed:", err);
      hud.epochMs = dateStrToMs(dateStr);
      galacticOrigin = createGalacticOriginState(hud.epochMs);
      simYears = 0;
      renderer.resetTrailSlots();
      seedStartupTrails(trails, bodies, galacticOrigin);
      uploadBodiesForSimulation();
      sourceEl.textContent = `J2000.0 preset (offline)`;
      if (hideWhenDone) hideLoading();
      return false;
    }
  }

  // Initial load — today's date
  const todayStr = utcDateStr(new Date());
  await trackStartupAsset("planetary ephemeris and starter trails", async () => {
    await loadEphemeris(todayStr, "Fetching real-time planetary positions from NASA JPL Horizons…", false);
  });
  setStartupStatus("Waiting for remaining startup assets...");
  await Promise.allSettled(startupAssetPromises);
  startupAssetsReady = STARTUP_ASSET_TOTAL;
  setLoadProg(STARTUP_ASSET_TOTAL, STARTUP_ASSET_TOTAL, "assets");
  loadTextEl.textContent = "Rendering first frame...";

  // ── Nav panel ──────────────────────────────────────────────────────────────
  function clearSelectedConstellation(): void {
    if (!selectedConstellation) return;
    selectedConstellation = null;
    if (constellationLineData.length > 0) renderer.uploadConstellations(constellationLineData);
  }

  function findConstellationFigure(id: string): ConstellationFigure | null {
    const figureId = id.startsWith("constellation:")
      ? id.slice("constellation:".length)
      : id;
    return constellationFigures.find(figure => figure.id === figureId) ?? null;
  }

  function constellationEarthFocus(figure: ConstellationFigure): {
    eye: [number, number, number];
    lookTarget: [number, number, number];
    surfaceTarget: [number, number, number];
    direction: [number, number, number];
    surfaceRadius: number;
    earthRadius: number;
  } | null {
    const earth = bodies.find(body => body.name === "Earth");
    if (!earth) return null;

    const constellationPoint: [number, number, number] = [
      figure.label.x,
      figure.label.y,
      figure.label.z,
    ];
    let dx = constellationPoint[0] - earth.x;
    let dy = constellationPoint[1] - earth.y;
    let dz = constellationPoint[2] - earth.z;
    let len = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(len) || len <= 0) {
      dx = 1;
      dy = 0;
      dz = 0;
      len = 1;
    }

    const ux = dx / len;
    const uy = dy / len;
    const uz = dz / len;
    const surfaceRadius = Math.max(earth.radius * 1.04, earth.radius + 1e-7);
    const cameraRadius = Math.max(earth.radius * 1.14, earth.radius + 5e-7);
    const surfaceTarget: [number, number, number] = [
      earth.x + ux * surfaceRadius,
      earth.y + uy * surfaceRadius,
      earth.z + uz * surfaceRadius,
    ];
    const eye: [number, number, number] = [
      earth.x + ux * cameraRadius,
      earth.y + uy * cameraRadius,
      earth.z + uz * cameraRadius,
    ];
    return {
      eye,
      lookTarget: constellationPoint,
      surfaceTarget,
      direction: [ux, uy, uz],
      surfaceRadius,
      earthRadius: earth.radius,
    };
  }

  function focusConstellationFromEarth(figure: ConstellationFigure): void {
    const focus = constellationEarthFocus(figure);
    if (!focus) return;

    camera.lookFromEyeToTarget(focus.eye, focus.lookTarget);
    camera.lockTarget = false;
  }

  function updateConstellationEarthFocus(): void {
    if (!selectedConstellation) return;
    const focus = constellationEarthFocus(selectedConstellation);
    if (!focus) return;
    const snapshot = camera.snapshot();
    const dx = focus.eye[0] - snapshot.eye[0];
    const dy = focus.eye[1] - snapshot.eye[1];
    const dz = focus.eye[2] - snapshot.eye[2];
    camera.lookFromEyeToTarget(focus.eye, [
      camera.target[0] + dx,
      camera.target[1] + dy,
      camera.target[2] + dz,
    ]);
    camera.lockTarget = false;
  }

  function selectConstellation(id: string): void {
    const figure = findConstellationFigure(id);
    if (!figure) return;
    selectedConstellation = figure;
    renderer.uploadConstellations(figure.data);
    renderer.uploadSelectedStar(null);
    focusConstellationFromEarth(figure);
    enableConstellationLayerForFocus();
  }

  function loadPreset(name: string) {
    if (name === "solar-system") {
      nav.clearFocusedBody();
      simYears = 0;
      bodies = solarSystem();
      camera.travelTo(0, 0, 0, 55);
      void loadEphemeris(utcDateStr(new Date()), "Fetching current planetary positions...");
      return;
    } else if (name === "binary-stars") {
      bodies = binaryStars();
      galacticOrigin = createGalacticOriginState(Date.now());
      camera.travelTo(0, 0, 0, 5);
      hud.epochMs = Date.now();
      sourceEl.textContent = "binary preset";
    }
    simYears = 0;
    trails.clear();
    renderer.resetTrailSlots();
    uploadBodiesForSimulation();
    trails.record(bodies);
  }

  let autoSnapSuppressedBodyName: string | null = null;

  const nav = new NavPanel(camera, () => bodies, loadPreset, {
    // Combine host-star search with individual exoplanet search
    searchCatalog: (query) => {
      const q = query.trim().toLowerCase();
      const blackHoleHits = q.length >= 2 && (
        "sagittarius a*".includes(q) ||
        "sgr a*".includes(q) ||
        "sgr a".includes(q) ||
        "black hole".includes(q) ||
        "galactic center".includes(q) ||
        "milky way center".includes(q)
      ) ? [SGR_A_SEARCH_RESULT] : [];
      const bodyHits = searchVisibleBodies(query, 8);
      const starHits = searchCatalogStars(exoplanetHosts, query, 5);
      const nearbyStarHits = searchNearbyStarLabels(query, 8);
      const nebulaHits = searchNebulas(query, 8);
      const modelHits = searchMilkyWayModels(query, 5);
      const constellationHits = searchConstellations(constellationLabels, query, 5);
      const galaxyHits = mergeGalaxySearchHits(
        searchKnownGalaxies(query, 6),
        searchGalaxies(galaxyNames, galaxyBuffer, query, 5).map(catalogGalaxyResult),
      );
      const exoHits  = searchExoplanets(query, getStarWorldPos, simYears, 5);
      return dedupeSearchResults([
        ...blackHoleHits,
        ...bodyHits,
        ...galaxyHits,
        ...constellationHits,
        ...nearbyStarHits,
        ...nebulaHits,
        ...modelHits,
        ...starHits,
        // Map exoplanet results to StarSearchResult shape
        ...exoHits.map(r => ({
          id:            `exo:${r.planet.hostName}:${r.planet.name}`,
          label:         r.label,
          subtitle:      r.subtitle,
          x: r.x, y: r.y, z: r.z,
          focusDistance: r.focusDistance,
          color:         exoplanetColor(r.planet.radiusEarth),
          objectType:    "exoplanet",
        })),
      ]);
    },
    getCatalogStatus: () => catalogStatus,
    constellationObjects: constellationsToSearchResults(constellationFigures),
    modelObjects: milkyWayModelSearchResults(),
    // Called whenever a catalog search result is clicked.
    // If the id encodes an exoplanet, load that star's planet bodies.
    onCatalogItemClick: (id: string) => {
      if (!id.startsWith("constellation:")) clearSelectedConstellation();
      renderer.setActiveMilkyWayModel(id.startsWith("mwmodel:") ? id : null);
      if (id === "blackhole:sgr-a") {
        setExoplanetBodies(null);
        renderer.uploadSelectedStar(null);
      } else if (id.startsWith("body:")) {
        const body = bodies.find(item => mapObjectSearchId("body", item.name) === id);
        if (body?.type !== BodyType.Exoplanet) setExoplanetBodies(null);
        renderer.uploadSelectedStar(null);
        if (body) nav.travelToClose(body.name);
      } else if (id.startsWith("galaxy:")) {
        setExoplanetBodies(null);
        renderer.uploadSelectedStar(null);
      } else if (id.startsWith("constellation:")) {
        setExoplanetBodies(null);
        renderer.uploadSelectedStar(null);
        selectConstellation(id);
      } else if (id.startsWith("mwmodel:")) {
        setExoplanetBodies(null);
        renderer.uploadSelectedStar(null);
        const model = milkyWayModelById(id);
        if (model) void renderer.ensureMilkyWayModelLoaded(model);
      } else if (id.startsWith("nearby:")) {
        const star = NEARBY_STAR_LABELS.find(item => nearbyStarId(item) === id);
        if (star) {
          setExoplanetBodies(star.name, [star.x, star.y, star.z]);
          renderer.uploadSelectedStar([star.x, star.y, star.z]);
        } else {
          setExoplanetBodies(null);
          renderer.uploadSelectedStar(null);
        }
      } else if (id.startsWith("nebula:")) {
        setExoplanetBodies(null);
        renderer.uploadSelectedStar(null);
      } else if (id.startsWith("exo:")) {
        const [, hostName = null, ...planetNameParts] = id.split(":");
        const planetName = planetNameParts.join(":");
        const hostPos = hostName ? getStarWorldPos(hostName) : null;
        setExoplanetBodies(hostName, hostPos ?? undefined);
        const planetBody = planetName ? bodies.find(b => b.name === planetName) : null;
        if (planetBody) nav.travelToClose(planetBody.name);
      } else {
        // Clicked a host star → load its exoplanets too
        const star = exoplanetHosts.find(s => s.id === id);
        setExoplanetBodies(star?.name ?? null, star ? [star.x, star.y, star.z] : undefined);
        renderer.uploadSelectedStar(star ? [star.x, star.y, star.z] : null);
      }
      uploadBodiesForSimulation();
    },
    onFocusTitleChange: (title, subtitle, objectType) => {
      if (objectType !== "constellation") clearSelectedConstellation();
      setFocusTitle(title, subtitle, objectType);
    },
  });

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || event.repeat) return;

    const hadOpenModal =
      settingsModal.classList.contains("open") ||
      infoModal.classList.contains("open") ||
      objectInfoModal.classList.contains("open");
    closeSettings();
    closeInfo();
    closeObjectInfo();
    if (hadOpenModal) {
      event.preventDefault();
      return;
    }

    const focusedBodyNameBeforeUnlock = nav.focusedBodyName;
    const unlockedTarget = nav.unlockTarget();
    clearSelectedConstellation();
    if (!unlockedTarget) return;

    autoSnapSuppressedBodyName = focusedBodyNameBeforeUnlock;
    renderer.uploadSelectedStar(null);
    uploadBodiesForSimulation();
    event.preventDefault();
  });

  const VIEW_CONTROL_POLE_MARGIN = 0.02;
  const VIEW_CONTROL_TRAVEL_SECONDS = 0.25;

  function setViewAxis(axis: ViewAxis): void {
    camera.clearWheelZoomGoal();
    switch (axis) {
      case "pos-x":
        camera.azimuth = 0;
        camera.elevation = 0;
        break;
      case "neg-x":
        camera.azimuth = Math.PI;
        camera.elevation = 0;
        break;
      case "pos-y":
        camera.azimuth = Math.PI / 2;
        camera.elevation = 0;
        break;
      case "neg-y":
        camera.azimuth = -Math.PI / 2;
        camera.elevation = 0;
        break;
      case "pos-z":
        camera.elevation = Math.PI / 2 - VIEW_CONTROL_POLE_MARGIN;
        break;
      case "neg-z":
        camera.elevation = -Math.PI / 2 + VIEW_CONTROL_POLE_MARGIN;
        break;
    }
  }

  function zoomViewport(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    camera.clearWheelZoomGoal();
    camera.travelTo(
      camera.target[0],
      camera.target[1],
      camera.target[2],
      camera.distance * factor,
      VIEW_CONTROL_TRAVEL_SECONDS,
    );
  }

  function frameCurrentView(): void {
    const focusedName = nav.focusedBodyName;
    if (focusedName) {
      nav.travelToSystem(focusedName);
      return;
    }

    const selected = nav.selectedCatalogStar;
    if (selected) {
      nav.selectCatalogStar(selected, VIEW_CONTROL_TRAVEL_SECONDS);
      return;
    }

    camera.travelTo(
      camera.target[0],
      camera.target[1],
      camera.target[2],
      camera.distance,
      VIEW_CONTROL_TRAVEL_SECONDS,
    );
  }

  function homeViewport(): void {
    clearSelectedConstellation();
    renderer.setActiveMilkyWayModel(null);
    nav.clearFocusedBody();
    camera.travelTo(0, 0, 0, 55, VIEW_CONTROL_TRAVEL_SECONDS);
  }

  new ViewControls({
    onAxis: setViewAxis,
    onZoom: zoomViewport,
    onFrame: frameCurrentView,
    onHome: homeViewport,
  });

  function shouldIgnoreLockedObjectEnter(event: KeyboardEvent): boolean {
    if (
      settingsModal.classList.contains("open") ||
      infoModal.classList.contains("open") ||
      objectInfoModal.classList.contains("open")
    ) {
      return true;
    }

    const activeTarget =
      event.target instanceof HTMLElement
        ? event.target
        : document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    if (!activeTarget) return false;
    if (activeTarget.isContentEditable) return true;
    return !!activeTarget.closest("input, textarea, select, button, a, [role='button']");
  }

  document.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.repeat) return;
    if (shouldIgnoreLockedObjectEnter(event)) return;
    if (!nav.handleLockedObjectEnter()) return;
    event.preventDefault();
    event.stopPropagation();
  });

  function nearbyStarId(star: NearbyStarLabel): string {
    return `nearby:${star.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }

  function starFocusDistance(radiusAU?: number): number {
    const aspect = Math.max(0.2, window.innerWidth / Math.max(1, window.innerHeight));
    return focusDistanceForStarRadiusAU(
      radiusAU ?? SOLAR_RADIUS_AU,
      aspect,
      SELECTED_NEARBY_STAR_SCREEN_WIDTH_FRACTION,
      CAMERA_FOV_Y,
    );
  }

  function focusNearbyStar(star: NearbyStarLabel): void {
    renderer.setActiveMilkyWayModel(null);
    setExoplanetBodies(star.name, [star.x, star.y, star.z]);
    nav.selectCatalogStar(nearbyStarSearchResult(star));
    uploadBodiesForSimulation();
    renderer.uploadSelectedStar([star.x, star.y, star.z]);
  }

  function focusMilkyWay(): void {
    renderer.setActiveMilkyWayModel(null);
    setExoplanetBodies(null);
    renderer.uploadSelectedStar(null);
    nav.selectCatalogStar({
      id: "galaxy:milky-way",
      label: "Milky Way",
      subtitle: "home galaxy · center at Sagittarius A*",
      x: SGR_A_STAR_POS[0],
      y: SGR_A_STAR_POS[1],
      z: SGR_A_STAR_POS[2],
      focusDistance: camera.distanceForViewRadius(MILKY_WAY_RADIUS_AU * 1.18, 0.70),
      color: [0.82, 0.88, 1.00],
      objectType: "galaxy",
    });
    uploadBodiesForSimulation();
  }

  function focusGalaxyLabel(galaxy: GalaxyNameLabel): void {
    renderer.setActiveMilkyWayModel(null);
    setExoplanetBodies(null);
    renderer.uploadSelectedStar(null);
    nav.selectCatalogStar({
      id: `galaxy:${galaxy.id}`,
      label: galaxy.name,
      subtitle: galaxyFocusSubtitle(galaxy.dist),
      x: galaxy.x,
      y: galaxy.y,
      z: galaxy.z,
      focusDistance: galaxySelectionFocusDistance(galaxy.id),
      color: [0.82, 0.88, 1.00],
      objectType: "galaxy",
    });
    uploadBodiesForSimulation();
  }

  // Last computed viewProj matrix - used by pointer hit tests outside the render loop.
  let lastViewProj: Float32Array | null = null;
  let lastCameraEye: [number, number, number] | null = null;
  let lastCameraUniforms: CameraUniforms | null = null;

  type MapObjectClickMode = "single" | "double";

  interface ProjectedMapPoint {
    x: number;
    y: number;
    w: number;
  }

  interface MapObjectHit {
    screenDistance: number;
    cameraDistance: number;
    apparentRadiusPx: number;
    edgeDistancePx: number;
    select: (mode: MapObjectClickMode) => void;
  }

  function projectMapPoint(x: number, y: number, z: number): ProjectedMapPoint | null {
    if (!lastViewProj) return null;
    const projected = projectStableNdc(x, y, z, lastViewProj, lastCameraUniforms);
    if (!projected) return null;
    const { nx, ny, nz, w } = projected;
    if (nz < 0 || nz > 1.02 || Math.abs(nx) > 1.08 || Math.abs(ny) > 1.08) return null;
    return {
      x: (nx + 1) * 0.5 * window.innerWidth,
      y: (1 - ny) * 0.5 * window.innerHeight,
      w,
    };
  }

  function screenDistance(cx: number, cy: number, point: ProjectedMapPoint): number {
    return Math.hypot(cx - point.x, cy - point.y);
  }

  function cameraDistanceTo(x: number, y: number, z: number): number {
    const eye = lastCameraEye;
    if (!eye) return Number.POSITIVE_INFINITY;
    return Math.hypot(x - eye[0], y - eye[1], z - eye[2]);
  }

  function isCameraInsideMilkyWay(): boolean {
    const eye = lastCameraEye;
    if (!eye) return false;
    return Math.hypot(
      eye[0] - SGR_A_STAR_POS[0],
      eye[1] - SGR_A_STAR_POS[1],
      eye[2] - SGR_A_STAR_POS[2],
    ) <= MILKY_WAY_RADIUS_AU;
  }

  function projectedRadiusPx(radiusAU: number, projected: ProjectedMapPoint): number {
    const focalY = 1 / Math.tan(CAMERA_FOV_Y / 2);
    return Math.max(0, radiusAU) * focalY / Math.max(projected.w, 1e-9) * window.innerHeight * 0.5;
  }

  function bodyApparentRadiusPx(body: Body, projected: ProjectedMapPoint): number {
    return Math.max(projectedRadiusPx(body.radius, projected), MAP_TARGET_LOCK_MIN_RADIUS_PX);
  }

  function starApparentRadiusPx(radiusAU: number | undefined, projected: ProjectedMapPoint, display = 0.20): number {
    const physical = projectedRadiusPx(radiusAU ?? SOLAR_RADIUS_AU, projected);
    const marker = clamp(display * 10 + 4, MAP_TARGET_LOCK_MIN_RADIUS_PX, 16);
    return Math.max(physical, marker);
  }

  function galaxyApparentRadiusPx(sizeMult: number, alpha: number, cameraDistance: number): number {
    const catalogRadius = MAP_TARGET_LOCK_MIN_RADIUS_PX * Math.max(sizeMult * 2.5, 0.8);
    const t = clamp((900 - cameraDistance) / (900 - GENERIC_GALAXY_CLOSE_FOCUS_AU), 0, 1);
    const closeFocus = t * t * (3 - 2 * t);
    const closeRadius = closeFocus * window.innerHeight * 0.25;
    const alphaLift = clamp(alpha * 6, 0, 8);
    return Math.max(catalogRadius + alphaLift, closeRadius, MAP_TARGET_LOCK_MIN_RADIUS_PX);
  }

  function hitAreaEdgeDistancePx(cx: number, cy: number, projected: ProjectedMapPoint, radiusPx: number): number {
    const dx = Math.max(Math.abs(cx - projected.x) - MAP_TARGET_LOCK_HALF_PX, 0);
    const dy = Math.max(Math.abs(cy - projected.y) - MAP_TARGET_LOCK_HALF_PX, 0);
    return Math.max(0, Math.hypot(dx, dy) - Math.max(radiusPx, 0));
  }

  function targetLockAreaTouches(cx: number, cy: number, projected: ProjectedMapPoint, radiusPx: number): boolean {
    return hitAreaEdgeDistancePx(cx, cy, projected, radiusPx) <= 0;
  }

  function mapObjectHitRank(hit: MapObjectHit): number {
    const distanceScore = Math.log10(Math.max(hit.cameraDistance, CAMERA_NEAR_AU));
    const sizeScore = Math.log2(clamp(hit.apparentRadiusPx, 1, MAP_TARGET_LOCK_MAX_RANK_RADIUS_PX) + 1);
    const centerPenalty = Math.min(
      hit.screenDistance / Math.max(hit.apparentRadiusPx + MAP_TARGET_LOCK_HALF_PX, 1),
      2,
    ) * 0.18;
    return distanceScore - sizeScore * 0.78 + hit.edgeDistancePx * 0.05 + centerPenalty;
  }

  function compareMapObjectHits(a: MapObjectHit, b: MapObjectHit): number {
    const rankDelta = mapObjectHitRank(a) - mapObjectHitRank(b);
    if (Math.abs(rankDelta) > 0.01) return rankDelta;
    return (b.apparentRadiusPx - a.apparentRadiusPx) ||
      (a.cameraDistance - b.cameraDistance) ||
      (a.screenDistance - b.screenDistance);
  }

  function closestMapObjectHit(hits: Array<MapObjectHit | null>): MapObjectHit | null {
    const candidates = hits.filter((hit): hit is MapObjectHit => hit !== null);
    candidates.sort(compareMapObjectHits);
    return candidates[0] ?? null;
  }

  function catalogHitFromStar(star: CatalogStar): StarSearchResult {
    const distanceLabel = star.distancePc === null
      ? "distance unknown"
      : `${star.distancePc.toFixed(star.distancePc < 20 ? 1 : 0)} pc`;
    const planetLabel = `${star.planetCount} confirmed planet${star.planetCount === 1 ? "" : "s"}`;
    const magnitudeLabel = star.magnitude === null ? "" : ` · mag ${star.magnitude.toFixed(1)}`;
    return {
      id: star.id,
      label: star.name,
      subtitle: `${planetLabel} · ${distanceLabel}${magnitudeLabel}`,
      x: star.x,
      y: star.y,
      z: star.z,
      focusDistance: starFocusDistance(star.size),
      color: star.color,
      objectType: "star",
      radiusAU: star.size,
      radiusSolar: star.radiusSolar,
      spectralType: star.spectralType,
      temperatureK: star.temperatureK,
      starType: star.starType,
    };
  }

  function nebulaFocusDistance(neb: { radiusAU: number }): number {
    return Math.max(
      camera.distanceForViewRadius(neb.radiusAU, 0.55),
      neb.radiusAU * 1.35,
    );
  }

  function shouldHighlightCatalogStar(hit: StarSearchResult | null): hit is StarSearchResult {
    return !!hit &&
      !hit.id.startsWith("exo:") &&
      !hit.id.startsWith("galaxy:") &&
      !hit.id.startsWith("constellation:") &&
      !hit.id.startsWith("mwmodel:") &&
      !hit.id.startsWith("nebula:") &&
      !hit.id.startsWith("blackhole:") &&
      !hit.id.startsWith("body:");
  }

  function selectedStarModelFromHit(hit: StarSearchResult | null): SelectedStarModel | null {
    if (!hit) return null;
    const model: SelectedStarModel = {
      position: [hit.x, hit.y, hit.z],
      radiusAU: hit.radiusAU ?? SOLAR_RADIUS_AU,
      color: hit.color,
      alpha: 1,
    };
    if (hit.starType) model.starType = hit.starType;
    return model;
  }

  function selectMapCatalogObject(
    hit: StarSearchResult,
    mode: MapObjectClickMode,
    sideEffect: (() => void) | null = null,
  ): void {
    renderer.setActiveMilkyWayModel(hit.id.startsWith("mwmodel:") ? hit.id : null);
    sideEffect?.();
    if (mode === "double") {
      nav.selectCatalogStar(hit, MAP_DOUBLE_CLICK_TRAVEL_SECONDS);
    } else {
      nav.selectCatalogStarForWheelZoom(hit, MAP_WHEEL_ZOOM_STEPS);
    }
    uploadBodiesForSimulation();
    renderer.uploadSelectedStar(
      shouldHighlightCatalogStar(hit)
        ? [hit.x, hit.y, hit.z]
        : null,
    );
  }

  function findMapObjectAtScreen(cx: number, cy: number): MapObjectHit | null {
    const candidates: MapObjectHit[] = [];
    const addCandidate = (candidate: MapObjectHit | null): void => {
      if (candidate) candidates.push(candidate);
    };

    for (const body of bodies) {
      const projected = projectMapPoint(body.x, body.y, body.z);
      if (!projected) continue;
      const dist = screenDistance(cx, cy, projected);
      const apparentRadiusPx = bodyApparentRadiusPx(body, projected);
      const edgeDistancePx = hitAreaEdgeDistancePx(cx, cy, projected, apparentRadiusPx);
      if (!targetLockAreaTouches(cx, cy, projected, apparentRadiusPx)) continue;
      addCandidate({
        screenDistance: dist,
        cameraDistance: cameraDistanceTo(body.x, body.y, body.z),
        apparentRadiusPx,
        edgeDistancePx,
        select: (mode) => {
          if (mode === "double") nav.travelToClose(body.name);
          else nav.focusBodyForWheelZoom(body.name, MAP_WHEEL_ZOOM_STEPS);
        },
      });
    }

    for (const star of NEARBY_STAR_LABELS) {
      const projected = projectMapPoint(star.x, star.y, star.z);
      if (!projected) continue;
      const dist = screenDistance(cx, cy, projected);
      const apparentRadiusPx = starApparentRadiusPx(
        star.radiusAU,
        projected,
        starDisplayFromMagnitude(star.magnitude ?? null, 0.20),
      );
      const edgeDistancePx = hitAreaEdgeDistancePx(cx, cy, projected, apparentRadiusPx);
      if (!targetLockAreaTouches(cx, cy, projected, apparentRadiusPx)) continue;
      const hit = nearbyStarSearchResult(star);
      addCandidate({
        screenDistance: dist,
        cameraDistance: cameraDistanceTo(star.x, star.y, star.z),
        apparentRadiusPx,
        edgeDistancePx,
        select: (mode) => selectMapCatalogObject(hit, mode, () => {
          setExoplanetBodies(star.name, [star.x, star.y, star.z]);
        }),
      });
    }

    for (const star of exoplanetHosts) {
      const projected = projectMapPoint(star.x, star.y, star.z);
      if (!projected) continue;
      const dist = screenDistance(cx, cy, projected);
      const apparentRadiusPx = starApparentRadiusPx(star.size, projected, star.alpha);
      const edgeDistancePx = hitAreaEdgeDistancePx(cx, cy, projected, apparentRadiusPx);
      if (!targetLockAreaTouches(cx, cy, projected, apparentRadiusPx)) continue;
      const hit = catalogHitFromStar(star);
      addCandidate({
        screenDistance: dist,
        cameraDistance: cameraDistanceTo(star.x, star.y, star.z),
        apparentRadiusPx,
        edgeDistancePx,
        select: (mode) => selectMapCatalogObject(hit, mode, () => {
          setExoplanetBodies(star.name, [star.x, star.y, star.z]);
        }),
      });
    }

    let bestVisibleStar: MapObjectHit | null = null;
    for (let o = 0, i = 0; o < visibleStarBuffer.length; o += STAR_FLOATS, i++) {
      const x = visibleStarBuffer[o]!;
      const y = visibleStarBuffer[o + 1]!;
      const z = visibleStarBuffer[o + 2]!;
      const projected = projectMapPoint(x, y, z);
      if (!projected) continue;
      const dist = screenDistance(cx, cy, projected);
      const apparentRadiusPx = starApparentRadiusPx(visibleStarBuffer[o + 3]!, projected, visibleStarBuffer[o + 7]!);
      const edgeDistancePx = hitAreaEdgeDistancePx(cx, cy, projected, apparentRadiusPx);
      if (!targetLockAreaTouches(cx, cy, projected, apparentRadiusPx)) continue;
      const distancePc = Math.hypot(x, y, z) / AU_PER_PARSEC;
      const distanceLy = distancePc * LIGHT_YEARS_PER_PARSEC;
      const hit: StarSearchResult = {
        id: `visible-star:${i}`,
        label: "Mapped star",
        subtitle: `${distancePc.toFixed(distancePc < 20 ? 1 : 0)} pc · ${distanceLy.toFixed(distanceLy < 50 ? 1 : 0)} ly`,
        x, y, z,
        focusDistance: starFocusDistance(visibleStarBuffer[o + 3]!),
        color: [
          visibleStarBuffer[o + 4]!,
          visibleStarBuffer[o + 5]!,
          visibleStarBuffer[o + 6]!,
        ],
      };
      hit.radiusAU = visibleStarBuffer[o + 3]!;
      hit.radiusSolar = hit.radiusAU / SOLAR_RADIUS_AU;
      hit.starType = classifyStarModelType({
        radiusSolar: hit.radiusSolar,
        color: hit.color,
      });
      const candidate: MapObjectHit = {
        screenDistance: dist,
        cameraDistance: cameraDistanceTo(x, y, z),
        apparentRadiusPx,
        edgeDistancePx,
        select: (mode) => selectMapCatalogObject(hit, mode, () => setExoplanetBodies(null)),
      };
      if (!bestVisibleStar || compareMapObjectHits(candidate, bestVisibleStar) < 0) {
        bestVisibleStar = candidate;
      }
    }
    addCandidate(bestVisibleStar);

    if (showGalaxies && !isCameraInsideMilkyWay()) {
      let bestGalaxy: MapObjectHit | null = null;
      for (let o = 0, i = 0; o < galaxyBuffer.length; o += GALAXY_FLOATS, i++) {
        const x = galaxyBuffer[o]!;
        const y = galaxyBuffer[o + 1]!;
        const z = galaxyBuffer[o + 2]!;
        const projected = projectMapPoint(x, y, z);
        if (!projected) continue;
        const dist = screenDistance(cx, cy, projected);
        const cameraDistance = cameraDistanceTo(x, y, z);
        const apparentRadiusPx = galaxyApparentRadiusPx(galaxyBuffer[o + 3]!, galaxyBuffer[o + 7]!, cameraDistance);
        const edgeDistancePx = hitAreaEdgeDistancePx(cx, cy, projected, apparentRadiusPx);
        if (!targetLockAreaTouches(cx, cy, projected, apparentRadiusPx)) continue;
        const named = galaxyNames.find(g => g.index === i);
        const label = LOCAL_GROUP_GALAXY_LABELS.find(item => item.name === named?.name);
        const hit: StarSearchResult = {
          id: label ? `galaxy:${label.id}` : galaxySearchId(named?.name ?? `galaxy-${i}`),
          label: named?.name ?? "Galaxy",
          subtitle: galaxyFocusSubtitle(named?.dist ?? 0),
          x, y, z,
          focusDistance: label ? galaxySelectionFocusDistance(label.id) : GENERIC_GALAXY_CLOSE_FOCUS_AU,
          color: [0.82, 0.88, 1.00],
          objectType: "galaxy",
        };
        const candidate: MapObjectHit = {
          screenDistance: dist,
          cameraDistance,
          apparentRadiusPx,
          edgeDistancePx,
          select: (mode) => selectMapCatalogObject(hit, mode, () => setExoplanetBodies(null)),
        };
        if (!bestGalaxy || compareMapObjectHits(candidate, bestGalaxy) < 0) {
          bestGalaxy = candidate;
        }
      }
      addCandidate(bestGalaxy);
    }

    let bestNebula: MapObjectHit | null = null;
    for (const neb of nebulaDets) {
      const projected = projectMapPoint(neb.x, neb.y, neb.z);
      if (!projected) continue;
      const dist = screenDistance(cx, cy, projected);
      const apparentRadiusPx = Math.max(projectedRadiusPx(neb.radiusAU, projected), 8);
      const edgeDistancePx = hitAreaEdgeDistancePx(cx, cy, projected, apparentRadiusPx);
      if (!targetLockAreaTouches(cx, cy, projected, apparentRadiusPx)) continue;
      const hit = nebulaSearchResult(neb);
      const candidate: MapObjectHit = {
        screenDistance: dist,
        cameraDistance: cameraDistanceTo(neb.x, neb.y, neb.z),
        apparentRadiusPx,
        edgeDistancePx,
        select: (mode) => selectMapCatalogObject(hit, mode, () => setExoplanetBodies(null)),
      };
      if (!bestNebula || compareMapObjectHits(candidate, bestNebula) < 0) {
        bestNebula = candidate;
      }
    }
    addCandidate(bestNebula);

    candidates.sort(compareMapObjectHits);
    return candidates[0] ?? null;
  }

  // ── Canvas click → select body ────────────────────────────────────────────
  const contextMenu = new ContextMenu();

  // ── Left-click: direct selection ──────────────────────────────────────────
  // Single click locks the next wheel zoom to the object; double-click travels close.
  let pointerDownAt    = { x: 0, y: 0 };
  let rightDownAt      = { x: 0, y: 0 };
  let lastClickMs      = 0;
  let lastClickAt      = { x: 0, y: 0 };
  // Flag set during mousemove while right button is held; cleared on next
  // right-mousedown. Used to suppress the context menu after a drag.
  let rightDragHappened = false;

  canvas.addEventListener("mousedown", e => {
    if (e.button === 0) pointerDownAt = { x: e.clientX, y: e.clientY };
    if (e.button === 2) {
      rightDownAt     = { x: e.clientX, y: e.clientY };
      rightDragHappened = false;
    }
  });

  window.addEventListener("mousemove", e => {
    if (rightDragHappened || !(e.buttons & 2)) return;
    const dx = e.clientX - rightDownAt.x;
    const dy = e.clientY - rightDownAt.y;
    if (dx * dx + dy * dy > 25) rightDragHappened = true; // > 5 px
  });

  canvas.addEventListener("mouseup", e => {
    if (e.button !== 0) return;
    const dx = e.clientX - pointerDownAt.x;
    const dy = e.clientY - pointerDownAt.y;
    if (Math.sqrt(dx*dx + dy*dy) > 5) return;

    contextMenu.hide();

    const now = Date.now();
    const clickGap = Math.hypot(e.clientX - lastClickAt.x, e.clientY - lastClickAt.y);
    const isDbl = now - lastClickMs < 300 && clickGap < 12;

    const labelBody = labels.findBodyAtScreen(e.clientX, e.clientY, MAP_TARGET_LOCK_HALF_PX);
    const labelProjected = labelBody ? projectMapPoint(labelBody.x, labelBody.y, labelBody.z) : null;
    const labelApparentRadiusPx = labelBody && labelProjected ? bodyApparentRadiusPx(labelBody, labelProjected) : 0;
    const labelHit = labelBody
      && labelProjected
      && targetLockAreaTouches(e.clientX, e.clientY, labelProjected, labelApparentRadiusPx)
      ? {
          screenDistance: screenDistance(e.clientX, e.clientY, labelProjected),
          cameraDistance: cameraDistanceTo(labelBody.x, labelBody.y, labelBody.z),
          apparentRadiusPx: labelApparentRadiusPx,
          edgeDistancePx: hitAreaEdgeDistancePx(e.clientX, e.clientY, labelProjected, labelApparentRadiusPx),
          select: (mode: MapObjectClickMode) => {
            if (mode === "double") nav.travelToClose(labelBody.name);
            else nav.focusBodyForWheelZoom(labelBody.name, MAP_WHEEL_ZOOM_STEPS);
          },
        } satisfies MapObjectHit
      : null;
    const mapHit = findMapObjectAtScreen(e.clientX, e.clientY);
    const hit = closestMapObjectHit([mapHit, labelHit]);
    lastClickMs = now;
    lastClickAt = { x: e.clientX, y: e.clientY };
    if (!hit) {
      autoSnapSuppressedBodyName = nav.focusedBodyName;
      nav.clearFocusedBody();
      return;
    }

    autoSnapSuppressedBodyName = null;
    hit.select(isDbl ? "double" : "single");
  });

  // ── Right-click: context menu ─────────────────────────────────────────────
  // Always suppress the native browser menu.
  canvas.addEventListener("contextmenu", e => e.preventDefault());

  // Show our custom menu on right-button RELEASE — but only when no drag
  // occurred.  mouseup fires after all mousemove events, so rightDragHappened
  // is already authoritative by the time this runs.  This is cross-platform
  // reliable; using the 'contextmenu' event is not (macOS fires it at mousedown).
  function openContextMenuAt(cx: number, cy: number): void {
    const half = 20; // 40×40 px detection box

    // ── Simulation bodies ──────────────────────────────────────────────────
    const nearby = labels.findBodiesAtScreen(cx, cy, half);

    // ── Catalog stars (exoplanet hosts) ───────────────────────────────────
    const nearbyStars: CatalogStar[] = [];
    if (lastViewProj && exoplanetHosts.length > 0) {
      for (const star of exoplanetHosts) {
        const projected = projectMapPoint(star.x, star.y, star.z);
        if (!projected) continue;
        if (Math.abs(cx - projected.x) <= half && Math.abs(cy - projected.y) <= half) nearbyStars.push(star);
      }
    }

    // ── Galaxies ──────────────────────────────────────────────────────────
    interface GalaxyHit { name: string; dist: number; x: number; y: number; z: number }
    const nearbyGalaxies: GalaxyHit[] = [];
    if (showGalaxies && lastViewProj && galaxyBuffer.length > 0) {
      const n    = galaxyBuffer.length / GALAXY_FLOATS;
      for (let i = 0; i < n; i++) {
        const o  = i * GALAXY_FLOATS;
        const gx = galaxyBuffer[o]!, gy = galaxyBuffer[o+1]!, gz = galaxyBuffer[o+2]!;
        const projected = projectMapPoint(gx, gy, gz);
        if (!projected) continue;
        if (Math.abs(cx - projected.x) <= half && Math.abs(cy - projected.y) <= half) {
          const named = galaxyNames.find(g => g.index === i);
          nearbyGalaxies.push({ name: named?.name ?? "Galaxy", dist: named?.dist ?? 0, x: gx, y: gy, z: gz });
        }
      }
    }

    // ── Nebulas ───────────────────────────────────────────────────────────
    interface NebHit { name: string; type: number; x: number; y: number; z: number; radiusAU: number }
    const nearbyNebulas: NebHit[] = [];
    if (lastViewProj) {
      for (const neb of nebulaDets) {
        const projected = projectMapPoint(neb.x, neb.y, neb.z);
        if (!projected) continue;
        if (Math.abs(cx - projected.x) <= half && Math.abs(cy - projected.y) <= half) {
          nearbyNebulas.push({ name: neb.name, type: neb.type, x: neb.x, y: neb.y, z: neb.z, radiusAU: neb.radiusAU });
        }
      }
    }

    if (nearby.length === 0 && nearbyStars.length === 0 && nearbyGalaxies.length === 0 && nearbyNebulas.length === 0) {
      contextMenu.hide();
      return;
    }

    contextMenu.show(
      cx, cy,
      nearby,
      (body) => nav.travelToSystem(body.name),
      nearbyStars,
      (star) => {
        renderer.setActiveMilkyWayModel(null);
        nav.selectCatalogStar(catalogHitFromStar(star));
        setExoplanetBodies(star.name, [star.x, star.y, star.z]);
        renderer.uploadSelectedStar([star.x, star.y, star.z]);
      },
      nearbyGalaxies,
      (gal) => {
        renderer.setActiveMilkyWayModel(null);
        const label = LOCAL_GROUP_GALAXY_LABELS.find(item => item.name === gal.name);
        nav.selectCatalogStar({
          id: label ? `galaxy:${label.id}` : galaxySearchId(gal.name),
          label: gal.name,
          subtitle: galaxyFocusSubtitle(gal.dist),
          x: gal.x,
          y: gal.y,
          z: gal.z,
          focusDistance: label ? galaxySelectionFocusDistance(label.id) : GENERIC_GALAXY_CLOSE_FOCUS_AU,
          color: [0.82, 0.88, 1.00],
          objectType: "galaxy",
        });
      },
      nearbyNebulas,
      (neb) => {
        renderer.setActiveMilkyWayModel(null);
        nav.selectCatalogStar(nebulaSearchResult(neb));
      },
    );
  }

  canvas.addEventListener("mouseup", e => {
    if (e.button !== 2) return;
    if (rightDragHappened) { rightDragHappened = false; return; }
    openContextMenuAt(e.clientX, e.clientY);
  });

  // ── Time control ──────────────────────────────────────────────────────────
  const sliderTW  = document.getElementById("timescale") as HTMLInputElement;
  const twDisplay = document.getElementById("timescale-display")!;
  const btnPause  = document.getElementById("btn-pause")!;
  const btnReset  = document.getElementById("btn-reset")!;
  const btnJump   = document.getElementById("btn-jump")!;

  function sliderToTW(v: number): number {
    return Math.sign(v || 1) * Math.pow(10, Math.abs(v));
  }
  function rateLabel(yrPerSec: number): string {
    const sec = Math.abs(yrPerSec) * SECONDS_PER_YEAR;
    if (sec < 1.5)     return 'real-time';
    if (sec < 90)      return `${sec.toFixed(0)} s/s`;
    if (sec < 5_400)   return `${(sec/60).toFixed(0)} min/s`;
    if (sec < 129_600) return `${(sec/3_600).toFixed(0)} hr/s`;
    if (sec < SECONDS_PER_YEAR) return `${(sec/86_400).toFixed(1)} day/s`;
    return `${(sec/SECONDS_PER_YEAR).toFixed(2)} yr/s`;
  }

  function formatTW(tw: number): string {
    if (paused) return "⏸ paused";
    const dir     = tw < 0 ? "◀ " : "▶ ";
    const reqRate = Math.abs(tw) / SECONDS_PER_YEAR;  // yr/s requested
    // If actual rate is significantly below requested, show actual + ⚡ cap marker
    if (actualSimRate > 0.001 && reqRate > 0.001 && actualSimRate < reqRate * 0.90) {
      return `${dir}${rateLabel(actualSimRate)} ⚡`;
    }
    const abs = Math.abs(tw);
    if (abs < 1.5)              return `${dir}real-time`;
    if (abs < 90)               return `${dir}${abs.toFixed(0)} s/s`;
    if (abs < 5_400)            return `${dir}${(abs/60).toFixed(0)} min/s`;
    if (abs < 129_600)          return `${dir}${(abs/3_600).toFixed(0)} hr/s`;
    if (abs < SECONDS_PER_YEAR) return `${dir}${(abs/86_400).toFixed(1)} day/s`;
    return `${dir}${(abs/SECONDS_PER_YEAR).toFixed(2)} yr/s`;
  }

  sliderTW.value = "0";
  twDisplay.textContent = formatTW(timewarp);

  sliderTW.addEventListener("input", () => {
    const tw = sliderToTW(parseFloat(sliderTW.value));
    if (paused) { pausedTW = tw; return; }
    timewarp = tw;
    twDisplay.textContent = formatTW(timewarp);
  });

  // Clicking the timewarp label snaps back to 1× real-time
  twDisplay.addEventListener("click", () => {
    sliderTW.value = "0";
    if (paused) {
      pausedTW = 1;
    } else {
      timewarp = 1;
    }
    physicsAccumYr = 0;
    twDisplay.textContent = formatTW(paused ? pausedTW : timewarp);
  });

  btnPause.addEventListener("click", () => {
    paused = !paused;
    if (paused) {
      pausedTW = timewarp; timewarp = 0;
      physicsAccumYr = 0;   // discard any buffered fast-path debt
      btnPause.textContent = "▶"; btnPause.classList.add("paused");
    } else {
      timewarp = pausedTW;
      btnPause.textContent = "⏸"; btnPause.classList.remove("paused");
    }
    twDisplay.textContent = formatTW(timewarp);
  });

  // Reset = re-fetch live data for right now
  btnReset.addEventListener("click", async () => {
    (btnReset as HTMLButtonElement).disabled = true;
    btnReset.textContent = "⟳ …";
    nav.clearFocusedBody();
    bodies = solarSystem(); // reset physical properties
    camera.travelTo(0, 0, 0, 55);
    await loadEphemeris(utcDateStr(new Date()), "Fetching current planetary positions…");
    (btnReset as HTMLButtonElement).disabled = false;
    btnReset.textContent = "↺ Reset";
  });

  // ── Jump to date modal ────────────────────────────────────────────────────
  const dateModal    = document.getElementById("date-modal")!;
  const jumpDateEl   = document.getElementById("jump-date") as HTMLInputElement;
  const modalStatus  = document.getElementById("modal-status")!;
  const modalCancel  = document.getElementById("modal-cancel")!;
  const modalConfirm = document.getElementById("modal-confirm") as HTMLButtonElement;

  function openJumpModal() {
    // Pre-fill with current simulation date
    const simDate = new Date(hud.epochMs + simYears * SECONDS_PER_YEAR * 1000);
    jumpDateEl.value = utcDateStr(simDate);
    modalStatus.textContent = "";
    modalStatus.className = "";
    modalConfirm.disabled = false;
    modalConfirm.textContent = "Fetch & Jump ▶";
    dateModal.classList.add("open");
  }

  function closeJumpModal() { dateModal.classList.remove("open"); }

  btnJump.addEventListener("click", openJumpModal);
  modalCancel.addEventListener("click", closeJumpModal);
  dateModal.addEventListener("click", (e) => {
    if (e.target === dateModal) closeJumpModal();
  });

  modalConfirm.addEventListener("click", async () => {
    const dateStr = jumpDateEl.value;
    if (!dateStr) {
      modalStatus.textContent = "Please enter a date.";
      modalStatus.className = "error";
      return;
    }
    modalConfirm.disabled = true;
    modalConfirm.textContent = "Fetching…";
    modalStatus.textContent = "Contacting NASA JPL Horizons…";
    modalStatus.className = "";

    bodies = solarSystem();
    nav.clearFocusedBody();
    camera.travelTo(0, 0, 0, 55);
    closeJumpModal();
    await loadEphemeris(dateStr, `Fetching positions for ${dateStr}…`);
  });

  // ── Render loop ───────────────────────────────────────────────────────────
  let lastTime = performance.now();

  function frame(now: number): void {
    const wallDt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    hud.recordFrame(wallDt);

    if (!paused && timewarp !== 0) {
      // ── Hybrid integration ────────────────────────────────────────────────
      //
      // SLOW path  (|simDt| ≤ MAX_SUBSTEP_YR, i.e. timewarp < ~14 hr/s):
      //   One proportional step per frame.  Covers real-time (1 s = 1 s) up to
      //   ~half-a-day/s.  At 1× real-time this advances ~17 ms of simulated time
      //   per frame — exactly correct.  Variable wallDt causes negligible error
      //   at these speeds (round-trip drift invisible even after years).
      //
      // FAST path  (|simDt| > MAX_SUBSTEP_YR, i.e. timewarp ≥ ~14 hr/s):
      //   Fixed MAX_SUBSTEP_YR (15 min) steps for accuracy and time-reversibility.
      //   An accumulator carries over "owed" time so the average rate matches the
      //   slider even though we advance in discrete 15-min chunks.
      //   At extreme timewarp (>3.4 yr/s) MAX_STEPS caps the per-frame budget;
      //   the accumulator drains over subsequent frames.
      const dir        = timewarp > 0 ? 1 : -1;
      const absSimDtYr = Math.abs(wallDt * timewarp) / SECONDS_PER_YEAR;

      // Reset accumulator when direction changes
      if (dir !== lastTwSign) { physicsAccumYr = 0; lastTwSign = dir; }

      const simYearsBefore = simYears;

      if (absSimDtYr <= simSubstepYr) {
        // ── Slow / real-time path ─────────────────────────────────────────
        physicsAccumYr = 0;
        const subDt = dir * absSimDtYr;
        stepSimulationState(bodies, galacticOrigin, subDt);
        simYears += subDt;
        trails.record(bodies);
      } else {
        // ── Fast path: fixed simSubstepYr steps with accumulator ──────────
        physicsAccumYr += absSimDtYr;
        physicsAccumYr = Math.min(physicsAccumYr, (MAX_STEPS + 1) * simSubstepYr);
        let stepped = 0;
        const subDt = dir * simSubstepYr;
        while (physicsAccumYr >= simSubstepYr && stepped < MAX_STEPS) {
          stepSimulationState(bodies, galacticOrigin, subDt);
          simYears += subDt;
          trails.record(bodies);
          physicsAccumYr -= simSubstepYr;
          stepped++;
        }
      }

      // ── Measure actual simulation rate for display ─────────────────────
      const simAdvanced = Math.abs(simYears - simYearsBefore);
      const rawRate     = wallDt > 0 ? simAdvanced / wallDt : 0;
      actualSimRate     = actualSimRate * 0.92 + rawRate * 0.08; // smoothed EMA
      twDisplay.textContent = formatTW(timewarp);

      uploadBodiesForSimulation();
    }

    // Update exoplanet orbital positions each frame (driven by simYears, not physics)
    if (exoplanetBodyIds.size > 0) {
      let needsUpload = false;
      for (const id of exoplanetBodyIds) {
        const b = bodies.find(b2 => b2.id === id);
        if (!b) continue;
        const pData = planetByName(b.name);
        if (!pData) continue;
        const sp = activeHostWorldPos(pData.hostName);
        if (!sp) continue;
        const [nx, ny, nz] = planetWorldPos(sp[0], sp[1], sp[2], pData, simYears);
        b.x = nx; b.y = ny; b.z = nz;
        needsUpload = true;
      }
      if (needsUpload && (paused || timewarp === 0)) {
        uploadBodiesForSimulation(); // ensure GPU sees updated positions even when paused
      }
    }

    const aspect = canvas.width / canvas.height;

    // ── Auto-snap / auto-release ──────────────────────────────────────────
    // AUTO-RELEASE: user scrolled out far beyond the system view → release focus
    // so cursor-zoom is re-enabled for free exploration.
    // Uses camera.distance (NOT target-to-body distance, which is always ~0
    // because updateFocusedBody() keeps target pinned to the body every frame).
    const currentFocus = nav.focusedBodyName;
    if (currentFocus) {
      const systemDist = SYSTEM_VIEW[currentFocus] ?? 0.05;
      if (camera.distance > systemDist * 10) {
        nav.clearFocusedBody(); // releases lockTarget, re-enables cursor-zoom
      }
    }

    // AUTO-SNAP: when cursor-zoom brings camera target near a planet AND
    // the camera distance is already close enough to that planet's vicinity
    // (prevents false snap when traversing through a planet's zone en-route elsewhere).
    if (!camera.lockTarget) {
      for (const b of bodies) {
        if (b.type !== BodyType.Planet && b.type !== BodyType.DwarfPlanet) continue;
        const systemDist  = SYSTEM_VIEW[b.name] ?? 0.05;
        const snapTargetD = systemDist * 2;           // target within 2× system view
        const snapCameraD = systemDist * 10;          // camera closer than 10× system view
        const distToBody  = Math.hypot(b.x - camera.target[0], b.y - camera.target[1], b.z - camera.target[2]);
        if (autoSnapSuppressedBodyName === b.name) {
          if (distToBody < snapTargetD) continue;
          autoSnapSuppressedBodyName = null;
        }
        if (distToBody < snapTargetD && camera.distance < snapCameraD) {
          nav.travelToSystem(b.name); // snaps to correct orbit showing all moons
          break;
        }
      }
    }

    nav.updateFocusedBody();

    // Lock camera on selected catalog star.
    // Without this, any scroll event (lockTarget=false) would shift camera.target
    // away from the star via zoom-to-cursor, breaking centering.
    // Catalog stars have no simulation body, so updateFocusedBody doesn't help them.
    {
      const selStar = nav.selectedCatalogStar;
      if (selStar && !nav.focusedBodyName && nav.shouldTrackSelectedCatalogStar) {
        camera.target[0] = selStar.x;
        camera.target[1] = selStar.y;
        camera.target[2] = selStar.z;
        camera.lockTarget = true; // scroll only changes orbit radius, not target
      }
    }

    updateConstellationEarthFocus();

    const camUniforms = camera.update(aspect);
    lastViewProj = camUniforms.viewProj;
    lastCameraEye = [camUniforms.eye[0], camUniforms.eye[1], camUniforms.eye[2]];
    lastCameraUniforms = camUniforms;
    renderer.updateCamera(camUniforms, canvas.width, canvas.height);
    renderer.updateBlackHoleVisual(
      SGR_A_STAR_POS,
      0,
      now / 1000,
      canvas.width,
      canvas.height,
      0,
    );

    // Catalog frustum culling happens in the WGSL shaders per instance.
    // Whole-origin-octant CPU culling can falsely remove visible galaxy regions.

    const sunBody = bodies.find(b => b.name === "Sun");
    const sunWorldPos: [number, number, number] = sunBody ? [sunBody.x, sunBody.y, sunBody.z] : [0, 0, 0];
    const eyeDistFromSun = Math.hypot(
      camUniforms.eye[0] - sunWorldPos[0],
      camUniforms.eye[1] - sunWorldPos[1],
      camUniforms.eye[2] - sunWorldPos[2],
    );
    const targetDistFromSun = Math.hypot(
      camera.target[0] - sunWorldPos[0],
      camera.target[1] - sunWorldPos[1],
      camera.target[2] - sunWorldPos[2],
    );
    const auPerCssPixel = (camera.distance * 2 / camUniforms.focalY) / Math.max(1, window.innerHeight);
    scaleBar.update(auPerCssPixel, Math.max(eyeDistFromSun, targetDistFromSun));
    renderer.updateLOD(eyeDistFromSun);
    renderer.ensureVisibleMilkyWayModels(MILKY_WAY_MODEL_OBJECTS, camUniforms.eye);

    const sel = nav.selectedCatalogStar;
    const highlightedStar = shouldHighlightCatalogStar(sel) ? sel : null;
    renderer.uploadSelectedStar(
      highlightedStar
        ? [highlightedStar.x, highlightedStar.y, highlightedStar.z]
        : null,
    );
    renderer.uploadSelectedStarModel(selectedStarModelFromHit(highlightedStar));
    const focusedMembers = nav.focusedSystemMembers();
    const bodyVisibility = buildBodyRenderVisibility(bodies, camUniforms.viewProj, focusedMembers, camUniforms);
    uploadBodiesForSimulation(bodyVisibility);
    renderer.draw(trails);

    labels.update(bodies, camUniforms.viewProj, focusedMembers, camUniforms.eye, bodyVisibility, (body) => {
      if (body.type === BodyType.Exoplanet) nav.travelToClose(body.name);
      else nav.travelToSystem(body.name);
    }, camUniforms);
    const selectedNearbyStarName = nav.selectedCatalogStar?.id.startsWith("nearby:")
      ? nav.selectedCatalogStar.label
      : null;
    labels.updateNearbyStarLabels(
      NEARBY_STAR_LABELS,
      camUniforms.viewProj,
      camUniforms.eye,
      sunWorldPos,
      focusNearbyStar,
      selectedNearbyStarName,
      camUniforms,
    );
    labels.updateConstellationLabels(
      selectedConstellation ? [selectedConstellation.label] : constellationLabels,
      camUniforms.viewProj,
      showConstellations,
      selectedConstellation?.starLabels ?? [],
    );
    const selectedGalaxyId = sel?.id.startsWith("galaxy:")
      ? sel.id.slice("galaxy:".length)
      : null;
    const milkyWayLabelOpacity = labels.updateMilkyWayLabel(
      SGR_A_STAR_POS,
      camUniforms.viewProj,
      camUniforms.eye,
      MILKY_WAY_RADIUS_AU,
      showGalaxies,
      focusMilkyWay,
      selectedGalaxyId === "milky-way",
      camUniforms,
    );
    labels.updateGalaxyNameLabels(
      LOCAL_GROUP_GALAXY_LABELS,
      camUniforms.viewProj,
      camUniforms.eye,
      SGR_A_STAR_POS,
      showGalaxies,
      focusGalaxyLabel,
      selectedGalaxyId,
      camUniforms,
    );
    const sgrASelected = nav.selectedCatalogStar?.id === "blackhole:sgr-a";
    labels.updateGalacticCenterLabel(SGR_A_STAR_POS, camUniforms.viewProj, () => {
      renderer.setActiveMilkyWayModel(null);
      setExoplanetBodies(null);
      nav.selectCatalogStar(SGR_A_SEARCH_RESULT);
      uploadBodiesForSimulation();
    }, !sgrASelected, 1 - milkyWayLabelOpacity, camUniforms);
    const selectedCatalogLabel =
      sgrASelected
        ? null
        : shouldHighlightCatalogStar(nav.selectedCatalogStar)
          ? nav.selectedCatalogStar
          : null;
    labels.updateCatalogStarLabel(selectedCatalogLabel, camUniforms.viewProj, camUniforms);
    const focusedBodyName = nav.focusedBodyName;
    const lockedBody = focusedBodyName ? bodies.find(b => b.name === focusedBodyName) : null;
    const lockTarget: LockTargetInfo | null = lockedBody
      ? { x: lockedBody.x, y: lockedBody.y, z: lockedBody.z }
      : sel
        ? { x: sel.x, y: sel.y, z: sel.z }
        : null;
    labels.updateLockTargetReticle(lockTarget, camUniforms.viewProj, camUniforms);
    hud.galacticSpeedKms = galacticSpeedKmS(galacticOrigin);
    hud.update(bodies.length, simYears);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
  if (startupLoading) {
    requestAnimationFrame(() => {
      startupLoading = false;
      hideLoading();
    });
  }
}

main().catch(console.error);

import { initGPU } from "./gpu/device";
import { Renderer } from "./gpu/renderer";
import { Camera } from "./scene/camera";
import { HUD } from "./ui/hud";
import { ScaleBar } from "./ui/scale-bar";
import { NavPanel } from "./ui/nav";
import { LabelManager, type GalaxyNameLabel } from "./ui/labels";
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
  STAR_FLOATS,
  catalogStarsToRenderBuffer,
  combineStarBuffers,
  loadExoplanetHostStars,
  loadVisibleStarField,
  searchCatalogStars,
  type CatalogStar,
  type StarBuffer,
  type StarSearchResult,
} from "./catalog/stars";
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
import {
  MILKY_WAY_MODEL_OBJECTS,
  milkyWayModelById,
  milkyWayModelNebulaExclusionSlugs,
  milkyWayModelSearchResults,
  searchMilkyWayModels,
} from "./catalog/milkyway-models";
import { loadMilkywayStars } from "./catalog/milkyway";
import { DUST_VOLUME_SOURCE } from "./catalog/dust";
import { NEARBY_STAR_LABELS, SGR_A_STAR_POS, type NearbyStarLabel } from "./catalog/nearby-stars";
import { sortIntoOctants } from "./gpu/sky-cull";
import { loadConstellationLines, type ConstellationLabel } from "./catalog/constellations";
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
const SGR_A_SEARCH_RESULT: StarSearchResult = {
  id: "blackhole:sgr-a",
  label: "Sagittarius A*",
  subtitle: "Milky Way central black hole; event horizon diameter ~0.17 AU",
  x: SGR_A_STAR_POS[0],
  y: SGR_A_STAR_POS[1],
  z: SGR_A_STAR_POS[2],
  focusDistance: SGR_A_BLACK_HOLE_FOCUS_AU,
  color: [1.0, 0.52, 0.18],
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
const LIGHT_YEARS_PER_PARSEC = 3.26156;
const SELECTED_NEARBY_STAR_RENDER_RADIUS_AU = 0.005; // keep in sync with src/gpu/star.wgsl
const SELECTED_NEARBY_STAR_SCREEN_WIDTH_FRACTION = 0.50;
const CAMERA_FOV_Y = Math.PI / 4; // keep in sync with src/scene/camera.ts
// Active substep size (yr) — changed via Settings panel.
// Larger steps = faster simulation but reduced moon accuracy.
let simSubstepYr = MAX_SUBSTEP_YR; // default: 15 min (precise)
// With angle-based trail recording, startup years determines arc coverage for outer planets.
// 50 yr: Saturn ~1.7 orbits, Uranus ~0.6 orbit, Neptune ~0.3 orbit; adds ~0.6s to load.
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

function nearbyStarLabelsToRenderBuffer(stars: readonly NearbyStarLabel[]): StarBuffer {
  const data = new Float32Array(stars.length * STAR_FLOATS);

  for (let i = 0; i < stars.length; i++) {
    const star = stars[i]!;
    const tierFade = Math.max(0, Math.min(1, 1 - star.tier * 0.08));
    const o = i * STAR_FLOATS;

    data[o + 0] = star.x;
    data[o + 1] = star.y;
    data[o + 2] = star.z;
    data[o + 3] = 1.05 * tierFade;
    data[o + 4] = 0.70;
    data[o + 5] = 0.84;
    data[o + 6] = 1.00;
    data[o + 7] = 0.82 * tierFade;
  }

  return data;
}

function isMajorRenderBody(body: Body): boolean {
  return body.type === BodyType.Star ||
    body.type === BodyType.Planet ||
    body.type === BodyType.DwarfPlanet ||
    body.type === BodyType.Exoplanet;
}

function buildBodyRenderVisibility(
  bodies: Body[],
  viewProj: Mat4,
  focusedSystemMembers: ReadonlySet<string>,
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
    /* eslint-disable @typescript-eslint/no-non-null-assertion */
    const cx = viewProj[0]!*body.x + viewProj[4]!*body.y + viewProj[8]! *body.z + viewProj[12]!;
    const cy = viewProj[1]!*body.x + viewProj[5]!*body.y + viewProj[9]! *body.z + viewProj[13]!;
    const cz = viewProj[2]!*body.x + viewProj[6]!*body.y + viewProj[10]!*body.z + viewProj[14]!;
    const cw = viewProj[3]!*body.x + viewProj[7]!*body.y + viewProj[11]!*body.z + viewProj[15]!;
    /* eslint-enable */
    if (cw <= 0) continue;

    const nx = cx / cw;
    const ny = cy / cw;
    const nz = cz / cw;
    if (nz < 0 || nz > 1.02 || Math.abs(nx) > 1.04 || Math.abs(ny) > 1.04) continue;

    const screenX = (nx + 1) * 0.5 * cssW;
    const screenY = (1 - ny) * 0.5 * cssH;
    const cellX = Math.round(screenX / DENSE_CLUSTER_CELL_PX);
    const cellY = Math.round(screenY / DENSE_CLUSTER_CELL_PX);
    const apparentRadiusPx = Math.max(0, body.radius / cw) * cssH;
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

function showLoading(msg: string) {
  loadTextEl.textContent = msg;
  loadProgEl.textContent = `0 / ${TOTAL_BODIES} bodies`;
  loadingEl.classList.remove("hidden", "gone");
}
function setLoadProg(n: number, t: number) {
  loadProgEl.textContent = `${n} / ${t}`;
}
function hideLoading() {
  loadingEl.classList.add("hidden");
  setTimeout(() => loadingEl.classList.add("gone"), 450);
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
      focusDistance: galaxyModelFocusDistance(galaxy.id) ?? galaxy.focusDistance,
      color: [galaxy.color[0], galaxy.color[1], galaxy.color[2]],
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
      ? galaxyModelFocusDistance(label.id) ?? label.focusDistance
      : Math.min(10_000, Math.max(500, Math.hypot(r.x, r.y, r.z) * 0.02));
    return {
      id: label ? `galaxy:${label.id}` : galaxySearchId(r.name),
      label: r.name,
      subtitle: galaxyFocusSubtitle(r.dist),
      x: r.x, y: r.y, z: r.z,
      focusDistance,
      color: [0.82, 0.88, 1.00],
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
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    closeSettings();
    closeInfo();
    closeObjectInfo();
  });

  let showGalaxies = true;
  let showConstellations = false;

  function applySettings(): void {
    const showLabels = (document.getElementById("set-labels") as HTMLInputElement).checked;
    const showTrails = (document.getElementById("set-trails") as HTMLInputElement).checked;
    showConstellations = (document.getElementById("set-constellations") as HTMLInputElement).checked;
    const showDust = (document.getElementById("set-dust-clouds") as HTMLInputElement).checked;
    const showBlackHole = (document.getElementById("set-black-hole") as HTMLInputElement).checked;
    const actualBodyBrightness = (document.getElementById("set-body-brightness") as HTMLInputElement).checked;
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
      showBlackHole,
      showTrails,
      mwStarLimit:  mwVal,
      starLimit:    nearbyVal,
      galaxyLimit:  galVal,
      actualBodyBrightness,
    });
  }

  // Apply on any change inside the modal
  settingsModal.addEventListener("change", applySettings);

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
  // Start with empty buffers — real data loads from binary within milliseconds.
  // Avoid the 100k-star placeholder allocation that can fail on low-memory devices.
  let visibleStarBuffer: StarBuffer = new Float32Array(0);
  let exoplanetHostBuffer: StarBuffer = new Float32Array(0);
  const nearbyStarLabelBuffer = nearbyStarLabelsToRenderBuffer(NEARBY_STAR_LABELS);
  let exoplanetHosts: CatalogStar[] = [];
  let catalogStatus = "Loading exoplanet host catalog...";

  // Single shared function that builds the combined buffer ONCE per update and
  // uploads + sorts in one pass.  Avoids creating multiple large allocations.
  function refreshStarCatalog(): void {
    try {
      const combined = combineStarBuffers(nearbyStarLabelBuffer, visibleStarBuffer, exoplanetHostBuffer);
      renderer.setStarOctants(sortIntoOctants(combined));
      renderer.uploadStars(combined);
    } catch (e) {
      console.warn("Star catalog upload failed (low memory?):", e);
    }
  }

  // Upload the tiny named-star anchor buffer immediately. The larger catalogs
  // stream in shortly after without allocating a synthetic 100k-star fallback.
  refreshStarCatalog();

  void loadVisibleStarField().then(({ data, source }) => {
    visibleStarBuffer = data;
    refreshStarCatalog();
    console.info(`Loaded ${data.length / STAR_FLOATS} visible stars from ${source}.`);
  }).catch(err => {
    console.warn("Visible star catalog failed:", err);
  });

  void loadExoplanetHostStars().then(({ stars, source }) => {
    exoplanetHosts = stars;
    catalogStatus = `${stars.length.toLocaleString()} host stars loaded`;
    exoplanetHostBuffer = catalogStarsToRenderBuffer(stars);
    refreshStarCatalog();
    console.info(`Loaded ${stars.length} exoplanet host stars from ${source}.`);
  }).catch(err => {
    catalogStatus = "Star catalog unavailable";
    console.warn("Exoplanet host catalog failed:", err);
  });

  // ── Galaxy catalog ─────────────────────────────────────────────────────────
  let galaxyBuffer: GalaxyBuffer = new Float32Array(0);
  let galaxyNames:  NamedGalaxy[] = [];

  void loadGalaxyCatalog().then(({ data, names, source }) => {
    galaxyBuffer = data;
    galaxyNames  = names;
    renderer.setGalaxyOctants(sortIntoOctants(data));
    renderer.uploadGalaxies(data);
    console.info(`Loaded ${data.length / GALAXY_FLOATS} galaxies from ${source}`);
  }).catch(err => {
    console.warn("Galaxy catalog failed:", err);
  });
  void renderer.loadGalaxyTextureModels(galaxyTextureModels());

  // ── Milky Way background star catalog (galaxy-scale LOD layer) ───────────
  void loadMilkywayStars().then(({ data, source }) => {
    renderer.setMwOctants(sortIntoOctants(data));
    renderer.uploadMilkywayStars(data);
    console.info(`Loaded ${data.length / 8} Milky Way background stars from ${source}`);
  }).catch(err => {
    console.warn("Milky Way star catalog failed:", err);
  });

  // ── Procedural Milky Way dust volume (render-only galaxy layer) ──────────
  console.info(`Loaded Milky Way dust from ${DUST_VOLUME_SOURCE}`);

  // ── Nebula catalog (Milky Way gas clouds) ─────────────────────────────────
  const modelNebulaExclusions = milkyWayModelNebulaExclusionSlugs();
  const nebulaBuf = buildNebulaBuffer(modelNebulaExclusions);
  renderer.uploadNebulas(nebulaBuf);
  const nebulaDets: NebulaDet[] = nebulaPositions(modelNebulaExclusions);
  console.info(`Loaded ${nebulaDets.length} Milky Way nebulas`);

  // ── Constellation lines snapped to real visible-star positions ───────────
  let constellationLabels: ConstellationLabel[] = [];
  void loadConstellationLines().then(({ data, labels: loadedLabels, source, featureCount, segmentCount, snappedEndpointCount, looseEndpointCount }) => {
    constellationLabels = loadedLabels;
    renderer.uploadConstellations(data);
    console.info(
      `Loaded ${segmentCount} constellation star-to-star segments across ${featureCount} figures ` +
      `(${snappedEndpointCount} snapped endpoints, ${looseEndpointCount} loose) from ${source}.`,
    );
  }).catch(err => {
    console.warn("Constellation line catalog failed:", err);
  });

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

  void loadExoplanetCatalog().then(({ planets, source }) => {
    console.info(`Loaded ${planets.length} exoplanets from ${source}.`);
    if (activeExoplanetHostName) {
      setExoplanetBodies(activeExoplanetHostName, activeExoplanetHostPos ?? undefined);
      renderer.uploadBodies(bodies);
    }
  }).catch(err => {
    console.warn("Exoplanet planet catalog failed:", err);
  });

  // ── Simulation state ──────────────────────────────────────────────────────
  let bodies: Body[] = solarSystem();
  let simYears = 0;
  let timewarp = 1.0;
  let paused   = false;
  let pausedTW = timewarp;
  let galacticOrigin = createGalacticOriginState();

  // Accumulates "owed" simulation time when at fast timewarp and using fixed
  // 15-min steps (so the average rate matches the slider even though we advance
  // in discrete chunks).  Reset on direction change or pause.
  let physicsAccumYr = 0;
  let lastTwSign     = 1;
  let actualSimRate  = 0; // smoothed actual simulation rate in yr/s

  // ── Load ephemeris from Horizons (or fall back to J2000.0) ────────────────
  async function loadEphemeris(dateStr: string, msg: string): Promise<boolean> {
    showLoading(msg);
    try {
      const result = await fetchStatesForDate(dateStr, (n, t) => setLoadProg(n, t));
      applyHorizons(bodies, result);
      hud.epochMs = result.epochMs;
      galacticOrigin = createGalacticOriginState(result.epochMs);
      simYears = 0;
      loadTextEl.textContent = `Calculating ${STARTUP_TRAIL_YEARS} years of starter trails...`;
      loadProgEl.textContent = `${STARTUP_TRAIL_BODIES.size} tracked bodies`;
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

      renderer.uploadBodies(bodies);

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
      hideLoading();
      return true;
    } catch (err) {
      console.error("Horizons fetch failed:", err);
      hud.epochMs = dateStrToMs(dateStr);
      galacticOrigin = createGalacticOriginState(hud.epochMs);
      simYears = 0;
      renderer.resetTrailSlots();
      seedStartupTrails(trails, bodies, galacticOrigin);
      renderer.uploadBodies(bodies);
      sourceEl.textContent = `J2000.0 preset (offline)`;
      hideLoading();
      return false;
    }
  }

  // Initial load — today's date
  const todayStr = utcDateStr(new Date());
  await loadEphemeris(todayStr, "Fetching real-time planetary positions from NASA JPL Horizons…");

  // ── Nav panel ──────────────────────────────────────────────────────────────
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
    renderer.uploadBodies(bodies);
    trails.record(bodies);
  }

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
      const starHits = searchCatalogStars(exoplanetHosts, query, 5);
      const modelHits = searchMilkyWayModels(query, 5);
      const galaxyHits = mergeGalaxySearchHits(
        searchKnownGalaxies(query, 6),
        searchGalaxies(galaxyNames, galaxyBuffer, query, 5).map(catalogGalaxyResult),
      );
      const exoHits  = searchExoplanets(query, getStarWorldPos, simYears, 5);
      return [
        ...blackHoleHits,
        ...galaxyHits,
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
        })),
      ];
    },
    getCatalogStatus: () => catalogStatus,
    modelObjects: milkyWayModelSearchResults(),
    // Called whenever a catalog search result is clicked.
    // If the id encodes an exoplanet, load that star's planet bodies.
    onCatalogItemClick: (id: string) => {
      renderer.setActiveMilkyWayModel(id.startsWith("mwmodel:") ? id : null);
      if (id === "blackhole:sgr-a") {
        setExoplanetBodies(null);
      } else if (id.startsWith("galaxy:")) {
        setExoplanetBodies(null);
      } else if (id.startsWith("mwmodel:")) {
        setExoplanetBodies(null);
        const model = milkyWayModelById(id);
        if (model) void renderer.ensureMilkyWayModelLoaded(model);
      } else if (id.startsWith("exo:")) {
        const hostName = id.split(":")[1] ?? null;
        const hostPos = hostName ? getStarWorldPos(hostName) : null;
        setExoplanetBodies(hostName, hostPos ?? undefined);
      } else {
        // Clicked a host star → load its exoplanets too
        const star = exoplanetHosts.find(s => s.id === id);
        setExoplanetBodies(star?.name ?? null, star ? [star.x, star.y, star.z] : undefined);
      }
      renderer.uploadBodies(bodies);
    },
    onFocusTitleChange: setFocusTitle,
  });

  function nearbyStarId(star: NearbyStarLabel): string {
    return `nearby:${star.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }

  function nearbyStarFocusDistance(): number {
    const aspect = Math.max(0.2, window.innerWidth / Math.max(1, window.innerHeight));
    const focalY = 1 / Math.tan(CAMERA_FOV_Y / 2);
    const distance = SELECTED_NEARBY_STAR_RENDER_RADIUS_AU * focalY /
      (aspect * SELECTED_NEARBY_STAR_SCREEN_WIDTH_FRACTION);
    return Math.max(SELECTED_NEARBY_STAR_RENDER_RADIUS_AU * 1.6, distance);
  }

  function focusNearbyStar(star: NearbyStarLabel): void {
    const distanceLy = star.distPc * LIGHT_YEARS_PER_PARSEC;
    renderer.setActiveMilkyWayModel(null);
    setExoplanetBodies(star.name, [star.x, star.y, star.z]);
    nav.selectCatalogStar({
      id: nearbyStarId(star),
      label: star.name,
      subtitle: `${star.distPc.toFixed(star.distPc < 10 ? 2 : 1)} pc · ${distanceLy.toFixed(distanceLy < 20 ? 1 : 0)} ly`,
      x: star.x,
      y: star.y,
      z: star.z,
      focusDistance: nearbyStarFocusDistance(),
      color: [0.70, 0.84, 1.00],
    });
    renderer.uploadBodies(bodies);
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
    });
    renderer.uploadBodies(bodies);
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
      focusDistance: galaxyModelFocusDistance(galaxy.id) ?? galaxy.focusDistance,
      color: [0.82, 0.88, 1.00],
    });
    renderer.uploadBodies(bodies);
  }

  // ── Canvas click → select body ────────────────────────────────────────────
  const contextMenu = new ContextMenu();

  // ── Left-click: direct navigation ─────────────────────────────────────────
  // Single click → system view; double-click → close-up zoom.
  let pointerDownAt    = { x: 0, y: 0 };
  let rightDownAt      = { x: 0, y: 0 };
  let lastClickMs      = 0;
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
    const isDbl = now - lastClickMs < 300;
    lastClickMs = now;

    const body = labels.findBodyAtScreen(e.clientX, e.clientY);
    if (!body) { nav.clearFocusedBody(); return; }

    if (isDbl) nav.travelToClose(body.name);
    else       nav.travelToSystem(body.name);
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
      const vp   = lastViewProj;
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      for (const star of exoplanetHosts) {
        const sx_ = vp[0]!*star.x + vp[4]!*star.y + vp[8]! *star.z + vp[12]!;
        const sy_ = vp[1]!*star.x + vp[5]!*star.y + vp[9]! *star.z + vp[13]!;
        const sw  = vp[3]!*star.x + vp[7]!*star.y + vp[11]!*star.z + vp[15]!;
        if (sw <= 0) continue;
        const sx = (sx_ / sw + 1) * 0.5 * cssW;
        const sy = (1 - sy_ / sw) * 0.5 * cssH;
        if (Math.abs(cx - sx) <= half && Math.abs(cy - sy) <= half) nearbyStars.push(star);
      }
    }

    // ── Galaxies ──────────────────────────────────────────────────────────
    interface GalaxyHit { name: string; dist: number; x: number; y: number; z: number }
    const nearbyGalaxies: GalaxyHit[] = [];
    if (showGalaxies && lastViewProj && galaxyBuffer.length > 0) {
      const vp   = lastViewProj;
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      const n    = galaxyBuffer.length / GALAXY_FLOATS;
      for (let i = 0; i < n; i++) {
        const o  = i * GALAXY_FLOATS;
        const gx = galaxyBuffer[o]!, gy = galaxyBuffer[o+1]!, gz = galaxyBuffer[o+2]!;
        const sx_ = vp[0]!*gx + vp[4]!*gy + vp[8]! *gz + vp[12]!;
        const sy_ = vp[1]!*gx + vp[5]!*gy + vp[9]! *gz + vp[13]!;
        const sw  = vp[3]!*gx + vp[7]!*gy + vp[11]!*gz + vp[15]!;
        if (sw <= 0) continue;
        const sx = (sx_ / sw + 1) * 0.5 * cssW;
        const sy = (1 - sy_ / sw) * 0.5 * cssH;
        if (Math.abs(cx - sx) <= half && Math.abs(cy - sy) <= half) {
          const named = galaxyNames.find(g => g.index === i);
          nearbyGalaxies.push({ name: named?.name ?? "Galaxy", dist: named?.dist ?? 0, x: gx, y: gy, z: gz });
        }
      }
    }

    // ── Nebulas ───────────────────────────────────────────────────────────
    interface NebHit { name: string; type: number; x: number; y: number; z: number }
    const nearbyNebulas: NebHit[] = [];
    if (lastViewProj) {
      const vp   = lastViewProj;
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      for (const neb of nebulaDets) {
        const sx_ = vp[0]!*neb.x + vp[4]!*neb.y + vp[8]! *neb.z + vp[12]!;
        const sy_ = vp[1]!*neb.x + vp[5]!*neb.y + vp[9]! *neb.z + vp[13]!;
        const sw  = vp[3]!*neb.x + vp[7]!*neb.y + vp[11]!*neb.z + vp[15]!;
        if (sw <= 0) continue;
        const sx = (sx_ / sw + 1) * 0.5 * cssW;
        const sy = (1 - sy_ / sw) * 0.5 * cssH;
        if (Math.abs(cx - sx) <= half && Math.abs(cy - sy) <= half) {
          nearbyNebulas.push({ name: neb.name, type: neb.type, x: neb.x, y: neb.y, z: neb.z });
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
        const distAu    = Math.sqrt(star.x**2 + star.y**2 + star.z**2);
        const focusDist = Math.min(5, Math.max(0.5, distAu * 5e-4));
        const distLabel = star.distancePc != null
          ? `${star.distancePc < 100 ? star.distancePc.toFixed(1) : Math.round(star.distancePc)} pc`
          : "distance unknown";
        nav.selectCatalogStar({
          id: star.id, label: star.name,
          subtitle: `${star.planetCount} planet${star.planetCount===1?'':'s'} · ${distLabel}`,
          x: star.x, y: star.y, z: star.z,
          focusDistance: focusDist, color: star.color,
        });
        renderer.uploadSelectedStar([star.x, star.y, star.z]);
      },
      nearbyGalaxies,
      (gal) => {
        renderer.setActiveMilkyWayModel(null);
        const r = Math.sqrt(gal.x**2 + gal.y**2 + gal.z**2);
        const label = LOCAL_GROUP_GALAXY_LABELS.find(item => item.name === gal.name);
        nav.selectCatalogStar({
          id: label ? `galaxy:${label.id}` : galaxySearchId(gal.name),
          label: gal.name,
          subtitle: galaxyFocusSubtitle(gal.dist),
          x: gal.x,
          y: gal.y,
          z: gal.z,
          focusDistance: label ? galaxyModelFocusDistance(label.id) ?? label.focusDistance : Math.min(10_000, Math.max(500, r * 0.02)),
          color: [0.82, 0.88, 1.00],
        });
      },
      nearbyNebulas,
      (neb) => {
        renderer.setActiveMilkyWayModel(null);
        const r = Math.sqrt(neb.x**2 + neb.y**2 + neb.z**2);
        const color = NEB_COLOR[neb.type] ?? [0.88, 0.35, 0.55];
        nav.selectCatalogStar({
          id: mapObjectSearchId("nebula", neb.name),
          label: neb.name,
          subtitle: "nebula",
          x: neb.x,
          y: neb.y,
          z: neb.z,
          focusDistance: Math.max(200, r * 0.005),
          color,
        });
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
  // Last computed viewProj matrix — used by the contextmenu handler to project
  // catalog stars on right-click without needing to run inside the render loop.
  let lastViewProj: Float32Array | null = null;

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

      renderer.uploadBodies(bodies);
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
        renderer.uploadBodies(bodies); // ensure GPU sees updated positions even when paused
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
      if (selStar && !nav.focusedBodyName) {
        camera.target[0] = selStar.x;
        camera.target[1] = selStar.y;
        camera.target[2] = selStar.z;
        camera.lockTarget = true; // scroll only changes orbit radius, not target
      }
    }

    const camUniforms = camera.update(aspect);
    lastViewProj = camUniforms.viewProj;
    renderer.updateCamera(camUniforms, canvas.width, canvas.height);
    renderer.updateBlackHoleVisual(
      SGR_A_STAR_POS,
      SGR_A_EVENT_HORIZON_RADIUS_AU,
      now / 1000,
      canvas.width,
      canvas.height,
      1,
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
    renderer.uploadSelectedStar(
      sel &&
        !sel.id.startsWith("galaxy:") &&
        !sel.id.startsWith("mwmodel:") &&
        !sel.id.startsWith("nebula:") &&
        !sel.id.startsWith("blackhole:")
        ? [sel.x, sel.y, sel.z]
        : null,
    );
    const focusedMembers = nav.focusedSystemMembers();
    const bodyVisibility = buildBodyRenderVisibility(bodies, camUniforms.viewProj, focusedMembers);
    renderer.uploadBodies(bodies, bodyVisibility);
    renderer.draw(trails);

    labels.update(bodies, camUniforms.viewProj, focusedMembers, camUniforms.eye, bodyVisibility, (body) => {
      if (body.type === BodyType.Exoplanet) nav.travelToClose(body.name);
      else nav.travelToSystem(body.name);
    });
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
    );
    labels.updateConstellationLabels(constellationLabels, camUniforms.viewProj, showConstellations);
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
    );
    labels.updateGalaxyNameLabels(
      LOCAL_GROUP_GALAXY_LABELS,
      camUniforms.viewProj,
      camUniforms.eye,
      SGR_A_STAR_POS,
      showGalaxies,
      focusGalaxyLabel,
      selectedGalaxyId,
    );
    const sgrASelected = nav.selectedCatalogStar?.id === "blackhole:sgr-a";
    labels.updateGalacticCenterLabel(SGR_A_STAR_POS, camUniforms.viewProj, () => {
      renderer.setActiveMilkyWayModel(null);
      setExoplanetBodies(null);
      nav.selectCatalogStar(SGR_A_SEARCH_RESULT);
      renderer.uploadBodies(bodies);
    }, !sgrASelected, 1 - milkyWayLabelOpacity);
    const selectedCatalogLabel =
      sgrASelected
        ? null
        : nav.selectedCatalogStar;
    labels.updateCatalogStarLabel(selectedCatalogLabel, camUniforms.viewProj);
    hud.galacticSpeedKms = galacticSpeedKmS(galacticOrigin);
    hud.update(bodies.length, simYears);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);

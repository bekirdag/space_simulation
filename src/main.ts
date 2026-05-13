import { initGPU } from "./gpu/device";
import { Renderer } from "./gpu/renderer";
import { Camera } from "./scene/camera";
import { HUD, simToCalendar } from "./ui/hud";
import { NavPanel } from "./ui/nav";
import { LabelManager } from "./ui/labels";
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
import { createSecondaryBody } from "./physics/moons";
import { fetchStatesForDate, utcDateStr, dateStrToMs, TOTAL_BODIES } from "./services/horizons";
import { type Body } from "./physics/body";
import { type HorizonsResult } from "./services/horizons";
import { SECONDS_PER_YEAR, MAX_SUBSTEP_YR } from "./physics/constants";
import {
  DEFAULT_VISIBLE_STAR_COUNT,
  STAR_FLOATS,
  catalogStarsToRenderBuffer,
  combineStarBuffers,
  createVisibleStarField,
  loadExoplanetHostStars,
  loadVisibleStarField,
  searchCatalogStars,
  type CatalogStar,
  type StarBuffer,
} from "./catalog/stars";

const MAX_BODIES = 1024;
const MAX_CATALOG_STARS = DEFAULT_VISIBLE_STAR_COUNT + 8_000;
// 1-hour sub-steps + 27 bodies: at 10 yr/s → simDt≈61 days → 61×24=1464 steps.
// Cap at 2000 so extreme timewarps stay responsive (capped subDt ≈ 44 min).
const MAX_STEPS  = 2000;
const STARTUP_TRAIL_YEARS = 4;
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
]);

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
    ? "NASA JPL"
    : result.source === "file-cache"
      ? "NASA JPL file cache"
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
  trails.record(historyBodies, historyTime);

  for (let i = 1; i < STARTUP_TRAIL_STEPS; i++) {
    stepSimulationState(historyBodies, historyOrigin, STARTUP_TRAIL_STEP_YR);
    historyTime += STARTUP_TRAIL_STEP_YR;
    trails.record(historyBodies, historyTime);
  }

  // End on the exact loaded state rather than the numerically round-tripped clone.
  trails.record(recordedCurrentBodies, 0);
}

async function main(): Promise<void> {
  const canvas       = document.getElementById("canvas") as HTMLCanvasElement;
  const errorOverlay = document.getElementById("error-overlay")!;
  const sourceEl     = document.getElementById("hud-source")!;

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = Math.floor(window.innerWidth  * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
  }
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

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
  renderer.init(MAX_BODIES, MAX_CATALOG_STARS);

  const camera = new Camera();
  camera.attach(canvas);

  const trails = new TrailSystem();
  const hud    = new HUD();
  const labels = new LabelManager();
  let visibleStarBuffer: StarBuffer = createVisibleStarField();
  let exoplanetHostBuffer: StarBuffer = new Float32Array(0);
  let exoplanetHosts: CatalogStar[] = [];
  let catalogStatus = "Loading exoplanet host catalog...";

  function uploadCatalogStars(): void {
    renderer.uploadStars(combineStarBuffers(visibleStarBuffer, exoplanetHostBuffer));
  }

  uploadCatalogStars();

  void loadVisibleStarField().then(({ data, source }) => {
    visibleStarBuffer = data;
    uploadCatalogStars();
    console.info(`Loaded ${data.length / STAR_FLOATS} visible stars from ${source}.`);
  }).catch(err => {
    console.warn("Visible star catalog failed:", err);
  });

  void loadExoplanetHostStars().then(({ stars, source }) => {
    exoplanetHosts = stars;
    catalogStatus = `${stars.length.toLocaleString()} host stars loaded`;
    exoplanetHostBuffer = catalogStarsToRenderBuffer(stars);
    uploadCatalogStars();
    console.info(`Loaded ${stars.length} exoplanet host stars from ${source}.`);
  }).catch(err => {
    catalogStatus = "Star catalog unavailable";
    console.warn("Exoplanet host catalog failed:", err);
  });

  // ── Simulation state ──────────────────────────────────────────────────────
  let bodies: Body[] = solarSystem();
  let simYears = 0;
  let timewarp = 1.0;
  let paused   = false;
  let pausedTW = timewarp;
  let galacticOrigin = createGalacticOriginState();

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
      seedStartupTrails(trails, bodies, galacticOrigin);
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
    renderer.uploadBodies(bodies);
    trails.record(bodies, simYears - 1);
  }

  const nav = new NavPanel(camera, () => bodies, loadPreset, {
    searchCatalog: (query) => searchCatalogStars(exoplanetHosts, query, 8),
    getCatalogStatus: () => catalogStatus,
  });

  // ── Canvas click → select body ────────────────────────────────────────────
  // Distinguishes a click (< 5px movement) from a drag.
  let pointerDownAt = { x: 0, y: 0 };
  canvas.addEventListener("mousedown", e => {
    pointerDownAt = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("mouseup", e => {
    if (e.button !== 0) return; // left button only
    const dx = e.clientX - pointerDownAt.x;
    const dy = e.clientY - pointerDownAt.y;
    if (Math.sqrt(dx*dx + dy*dy) > 5) {
      nav.clearFocusedBody();
      return; // was a drag — ignore
    }

    const body = labels.findBodyAtScreen(e.clientX, e.clientY);
    if (!body) return;

    // Navigation chooses a system-scale view for planets and moons.
    nav.travelToSystem(body.name);
  });

  canvas.addEventListener("dblclick", e => {
    const body = labels.findBodyAtScreen(e.clientX, e.clientY);
    if (!body) return;
    nav.travelToClose(body.name);
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
  function formatTW(tw: number): string {
    if (paused) return "⏸ paused";
    const abs = Math.abs(tw);
    const dir = tw < 0 ? "◀ " : "▶ ";
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

  btnPause.addEventListener("click", () => {
    paused = !paused;
    if (paused) {
      pausedTW = timewarp; timewarp = 0;
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
      const simDt = (wallDt * timewarp) / SECONDS_PER_YEAR;
      const steps = Math.max(1, Math.min(MAX_STEPS, Math.ceil(Math.abs(simDt) / MAX_SUBSTEP_YR)));
      const subDt = simDt / steps;
      for (let s = 0; s < steps; s++) {
        stepSimulationState(bodies, galacticOrigin, subDt);
      }
      simYears += simDt;
      renderer.uploadBodies(bodies);
      trails.record(bodies, simYears);
    }

    const aspect      = canvas.width / canvas.height;
    nav.updateFocusedBody();
    const camUniforms = camera.update(aspect);
    renderer.updateCamera(camUniforms, canvas.height);
    renderer.draw(trails);

    labels.update(bodies, camUniforms.viewProj);
    hud.update(bodies.length, simYears);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch(console.error);

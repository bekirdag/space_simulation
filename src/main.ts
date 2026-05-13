import { initGPU } from "./gpu/device";
import { Renderer } from "./gpu/renderer";
import { Camera } from "./scene/camera";
import { HUD, simToCalendar } from "./ui/hud";
import { NavPanel } from "./ui/nav";
import { LabelManager } from "./ui/labels";
import { TrailSystem } from "./scene/trail-system";
import { stepLeapfrog } from "./physics/integrator";
import { solarSystem, binaryStars } from "./physics/presets";
import { createSecondaryBody, SYSTEM_VIEW } from "./physics/moons";
import { BodyType } from "./physics/constants";
import { fetchStatesForDate, utcDateStr, dateStrToMs, TOTAL_BODIES } from "./services/horizons";
import { type Body } from "./physics/body";
import { type HorizonsResult } from "./services/horizons";
import { SECONDS_PER_YEAR, MAX_SUBSTEP_YR } from "./physics/constants";

const MAX_BODIES = 1024;
// 1-hour sub-steps + 27 bodies: at 10 yr/s → simDt≈61 days → 61×24=1464 steps.
// Cap at 2000 so extreme timewarps stay responsive (capped subDt ≈ 44 min).
const MAX_STEPS  = 2000;

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
  renderer.init(MAX_BODIES);

  const camera = new Camera();
  camera.attach(canvas);

  const trails = new TrailSystem();
  const hud    = new HUD();
  const labels = new LabelManager();

  // ── Simulation state ──────────────────────────────────────────────────────
  let bodies: Body[] = solarSystem();
  let simYears = 0;
  let timewarp = 1.0;
  let paused   = false;
  let pausedTW = timewarp;

  // ── Load ephemeris from Horizons (or fall back to J2000.0) ────────────────
  async function loadEphemeris(dateStr: string, msg: string): Promise<boolean> {
    showLoading(msg);
    try {
      const result = await fetchStatesForDate(dateStr, (n, t) => setLoadProg(n, t));
      applyHorizons(bodies, result);
      hud.epochMs = result.epochMs;
      simYears = 0;
      trails.clear();
      renderer.uploadBodies(bodies);
      trails.record(bodies, simYears - 1);

      const src = result.warnings.length === 0
        ? `NASA JPL · ${dateStr}`
        : `JPL (${result.warnings.length} fallback) · ${dateStr}`;
      sourceEl.textContent = src;
      if (result.warnings.length) console.warn("Horizons fallbacks:", result.warnings);
      hideLoading();
      return true;
    } catch (err) {
      console.error("Horizons fetch failed:", err);
      hud.epochMs = dateStrToMs(dateStr);
      simYears = 0;
      trails.clear();
      renderer.uploadBodies(bodies);
      trails.record(bodies, simYears - 1);
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
      hud.epochMs = new Date("2000-01-01T12:00:00Z").getTime();
      sourceEl.textContent = "J2000.0 preset";
    } else if (name === "binary-stars") {
      bodies = binaryStars();
      camera.travelTo(0, 0, 0, 5);
      hud.epochMs = Date.now();
      sourceEl.textContent = "binary preset";
    }
    simYears = 0;
    trails.clear();
    renderer.uploadBodies(bodies);
    trails.record(bodies, simYears - 1);
  }

  const nav = new NavPanel(camera, () => bodies, loadPreset);

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
    if (Math.sqrt(dx*dx + dy*dy) > 5) return; // was a drag — ignore

    const body = labels.findBodyAtScreen(e.clientX, e.clientY);
    if (!body) return;

    // Planets/Sun/DwarfPlanets → system view (shows moons); Moons → direct zoom
    if (body.type === BodyType.Moon) {
      nav.travelTo(body.name);
    } else {
      nav.travelToSystem(body.name);
    }
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
      for (let s = 0; s < steps; s++) stepLeapfrog(bodies, subDt);
      simYears += simDt;
      renderer.uploadBodies(bodies);
      trails.record(bodies, simYears);
    }

    const aspect      = canvas.width / canvas.height;
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

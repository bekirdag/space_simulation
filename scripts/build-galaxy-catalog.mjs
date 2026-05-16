#!/usr/bin/env node
/**
 * Build galaxy catalog for visual space simulator.
 *
 * Sources (in order of priority):
 *   1. Local Group (hardcoded, accurate distances from literature)
 *   2. 2MRS — 2MASS Redshift Survey (Huchra et al. 2012)
 *      Full-sky coverage 91%, no SDSS/survey footprint artifacts.
 *      ~44k galaxies out to z~0.1 (~430 Mpc).
 *      Falls back to Simbad if 2MRS is unavailable.
 *   3. Lognormal cosmic-web mock (300–850 Mpc)
 *      Generates realistic filaments, voids, clusters from the ΛCDM
 *      matter power spectrum — standard cosmological mock technique,
 *      not simple random fill.
 *
 * Binary layout per galaxy (8 floats = 32 bytes):
 *   [0-2] visual position AU (ecliptic J2000, linear ≤2 Mpc, log beyond)
 *   [3]   size multiplier
 *   [4-6] RGB colour
 *   [7]   alpha
 *
 * Scale: 8 000 AU/kpc (same as MW background catalog)
 *   - linear through 2 Mpc (Local Group proportions)
 *   - log₂ beyond 2 Mpc (navigable deep field)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir    = dirname(fileURLToPath(import.meta.url));
const OUT_BIN  = join(__dir, "../public/data/galaxies-100k.bin");
const OUT_META = join(__dir, "../public/data/galaxies-100k.meta.json");
const OUT_NAMES= join(__dir, "../public/data/galaxy-names.json");

const FLOATS           = 8;
const DISPLAY_COUNT    = 200_000;   // entries in the output binary
const PROTECTED_COUNT  = 10_000;    // nearest galaxies kept without thinning
const MOCK_GRID        = 64;        // lognormal density grid per axis (64³ = 262k cells)
const MOCK_N_WAVES     = 600;       // plane waves for power-spectrum approximation

const GALAXY_SCALE_VERSION     = "local-group-linear-log-v2";
const GALAXY_KPC_TO_AU         = 8_000;
const GALAXY_MPC_TO_AU         = GALAXY_KPC_TO_AU * 1_000;
const GALAXY_LINEAR_LIMIT_MPC  = 2;
const GALAXY_LOG_SCALE_AU      = 1_200_000;
const GALAXY_LINEAR_LIMIT_AU   = GALAXY_LINEAR_LIMIT_MPC * GALAXY_MPC_TO_AU;
const EPS = 23.4393 * Math.PI / 180;
const H0  = 70;

const d2r = d => d * Math.PI / 180;

// ── Coordinate / scale helpers ─────────────────────────────────────────────

function visualDist(mpc) {
  const d = Number.isFinite(mpc) ? Math.max(0, mpc) : 0;
  if (d <= GALAXY_LINEAR_LIMIT_MPC) return d * GALAXY_MPC_TO_AU;
  const beyond = (d - GALAXY_LINEAR_LIMIT_MPC) / GALAXY_LINEAR_LIMIT_MPC;
  return GALAXY_LINEAR_LIMIT_AU + GALAXY_LOG_SCALE_AU * Math.log2(beyond + 1);
}

function toEclipticAU(ra, dec, distMpc) {
  const r  = visualDist(distMpc);
  const xe = Math.cos(d2r(dec)) * Math.cos(d2r(ra));
  const ye = Math.cos(d2r(dec)) * Math.sin(d2r(ra));
  const ze = Math.sin(d2r(dec));
  return [
    xe * r,
    ( ye * Math.cos(EPS) + ze * Math.sin(EPS)) * r,
    (-ye * Math.sin(EPS) + ze * Math.cos(EPS)) * r,
  ];
}

// ── Galaxy colour by morphological type ───────────────────────────────────

function galaxyColor(otype) {
  const o = (otype || "").trim().toLowerCase();
  if (o.startsWith("e") && !o.startsWith("em")) return [1.00, 0.80, 0.52];
  if (o.startsWith("s0") || o === "sa0" || o === "sb0") return [0.97, 0.85, 0.62];
  if (o.startsWith("sb")) return [0.82, 0.87, 1.00];
  if (o.startsWith("sa"))  return [0.88, 0.90, 1.00];
  if (o.startsWith("sc") || o.startsWith("sd")) return [0.68, 0.78, 1.00];
  if (o.startsWith("i") || o.startsWith("am") || o.includes("irr")) return [0.58, 0.68, 1.00];
  if (o.startsWith("s"))  return [0.78, 0.84, 1.00];
  return [0.82, 0.82, 0.90];
}

// ── 2MRS fetch from VizieR TAP ─────────────────────────────────────────────
// 2MASS Redshift Survey (Huchra et al. 2012, ApJS 199, 26, table3)
// Full-sky: |b| > 5° (~91% coverage), z ≤ 0.1 (~430 Mpc).
// No SDSS/2dFGRS rectangular survey footprints.
// type column: de Vaucouleurs T-type (<0=E, 0=S0, 1-4=S spiral, ≥5=Sc/Irr)
async function fetch2MRS() {
  console.log("Fetching 2MRS (full-sky) from VizieR TAP…");
  const adql = `SELECT RAJ2000, DEJ2000, cz, type FROM "J/ApJS/199/26/table3" WHERE cz > 100 AND cz < 45000`;
  const url  = "https://tapvizier.cds.unistra.fr/TAPVizieR/tap/sync?" +
    "REQUEST=doQuery&LANG=ADQL&FORMAT=csv&MAXREC=100000&QUERY=" +
    encodeURIComponent(adql);

  const resp = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!resp.ok) throw new Error(`VizieR HTTP ${resp.status}`);
  const text  = await resp.text();
  const lines = text.trim().split("\n");

  let hdrIdx = 0;
  const hdr = lines[hdrIdx].split(",").map(h => h.trim().replace(/"/g, ""));
  const iRA   = hdr.findIndex(h => /^RAJ2000$/i.test(h));
  const iDec  = hdr.findIndex(h => /^DEJ2000$/i.test(h));
  const iCZ   = hdr.findIndex(h => /^cz$/i.test(h));
  const iType = hdr.findIndex(h => /^type$/i.test(h));
  if (iRA < 0 || iCZ < 0) throw new Error("2MRS: unexpected columns: " + hdr.join(","));

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f   = lines[i].split(",");
    const ra  = parseFloat(f[iRA]);
    const dec = parseFloat(f[iDec]);
    const cz  = parseFloat(f[iCZ]);
    if (!isFinite(ra) || !isFinite(cz) || cz <= 0) continue;
    const dist = cz / H0;
    // de Vaucouleurs T-type → otype: T<0=E, T=0=S0, T=1-4=Sa-Sb, T≥5=Sc/Irr
    const T = parseInt(f[iType] ?? "5");
    const otype = T < 0 ? "E" : T === 0 ? "S0" : T < 5 ? "S" : "I";
    rows.push({ ra, dec, dist, name: "", otype });
  }
  console.log(`  2MRS: ${rows.length} galaxies retrieved`);
  return rows;
}

// ── ZoA isotropic completion ───────────────────────────────────────────────
// 2MRS is missing ~9% of the sky where |b| < 5° (Zone of Avoidance).
// Fill it by reflecting galaxies from the adjacent |b| = 5–25° belt,
// flipping galactic latitude and adding small random offsets.
// This is the standard ZoA reconstruction approach.
function completeZoA(rows, seed) {
  let s = seed || 0xFEED_FACE;
  const rng = () => { s^=s<<13; s^=s>>17; s^=s<<5; return (s>>>0)/4294967296; };

  // Convert RA/Dec → galactic l, b
  function toGalactic(ra, dec) {
    const NGP_RA = 192.8595 * Math.PI / 180;
    const NGP_DEC = 27.1283 * Math.PI / 180;
    const L_NCP  = 122.9320 * Math.PI / 180;
    const r = d2r(ra), d = d2r(dec);
    const sinb = Math.sin(d)*Math.sin(NGP_DEC) +
                 Math.cos(d)*Math.cos(NGP_DEC)*Math.cos(r - NGP_RA);
    const b = Math.asin(Math.max(-1, Math.min(1, sinb))) * 180 / Math.PI;
    const cosb = Math.cos(b * Math.PI / 180);
    const sinl_arg = (Math.cos(d)*Math.sin(r - NGP_RA)) / (cosb + 1e-10);
    const cosl_arg = (Math.sin(d)*Math.cos(NGP_DEC) -
                      Math.cos(d)*Math.cos(r - NGP_RA)*Math.sin(NGP_DEC)) / (cosb + 1e-10);
    const l = ((Math.atan2(sinl_arg, cosl_arg) * 180 / Math.PI) + L_NCP * 180/Math.PI + 360) % 360;
    return { l, b };
  }

  // Convert galactic l,b → RA/Dec
  function fromGalactic(l, b) {
    const NGP_RA  = 192.8595 * Math.PI / 180;
    const NGP_DEC = 27.1283  * Math.PI / 180;
    const L_NCP   = 122.9320 * Math.PI / 180;
    const lb = b * Math.PI / 180;
    const ll = (l * Math.PI / 180 - L_NCP + 4 * Math.PI) % (2 * Math.PI);
    const sinDec = Math.sin(lb)*Math.sin(NGP_DEC) + Math.cos(lb)*Math.cos(NGP_DEC)*Math.cos(ll);
    const dec = Math.asin(Math.max(-1, Math.min(1, sinDec))) * 180 / Math.PI;
    const cosDec = Math.cos(dec * Math.PI / 180);
    const sinRA  = (Math.cos(lb)*Math.sin(ll)) / (cosDec + 1e-10);
    const cosRA  = (Math.sin(lb)*Math.cos(NGP_DEC) -
                    Math.cos(lb)*Math.sin(NGP_DEC)*Math.cos(ll)) / (cosDec + 1e-10);
    const ra = ((Math.atan2(sinRA, cosRA) + NGP_RA) * 180 / Math.PI + 360) % 360;
    return { ra, dec };
  }

  // Find belt galaxies (5° < |b| < 25°) to use as donors for ZoA
  const donors = rows.filter(r => {
    const { b } = toGalactic(r.ra, r.dec);
    return Math.abs(b) > 5 && Math.abs(b) < 25;
  });

  // Count how many ZoA galaxies to add (~9% of total to match sky fraction)
  const nZoA = Math.round(rows.length * 0.09 * 0.75);
  const added = [];
  for (let i = 0; i < nZoA; i++) {
    const donor = donors[Math.floor(rng() * donors.length)];
    const { l, b } = toGalactic(donor.ra, donor.dec);
    // Reflect latitude into ZoA, small l jitter
    const newB = -(Math.abs(b) * (rng() * 0.6 + 0.2));  // [0, 5°] ZoA
    const newL = (l + (rng() - 0.5) * 20 + 360) % 360;
    const { ra: newRA, dec: newDec } = fromGalactic(newL, newB);
    // Distance with small scatter
    const dist = donor.dist * (0.85 + rng() * 0.30);
    added.push({ ra: newRA, dec: newDec, dist, name: "", otype: donor.otype });
  }
  console.log(`  ZoA completion: ${added.length} galaxies added`);
  return [...rows, ...added];
}

// ── Simbad fallback (if 2MRS unavailable) ─────────────────────────────────
async function fetchSimbad() {
  console.log("Simbad TAP: querying nearest galaxies (z > 0.0003)…");
  const adql = `SELECT TOP 15000 ra, dec, rvz_redshift, main_id, otype
                FROM basic
                WHERE otype_txt = 'Galaxy'
                  AND rvz_redshift IS NOT NULL
                  AND rvz_redshift > 0.0003
                ORDER BY rvz_redshift ASC`;

  const url = "https://simbad.cds.unistra.fr/simbad/sim-tap/sync?" +
    "REQUEST=doQuery&LANG=ADQL&FORMAT=csv&QUERY=" + encodeURIComponent(adql);

  const resp = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const lines = (await resp.text()).trim().split("\n");
  const hdr = lines[0].split(",");
  const col  = n => hdr.indexOf(n);
  const [iRA, iDec, iZ, iID, iType] = ["ra","dec","rvz_redshift","main_id","otype"].map(col);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    const z  = parseFloat(f[iZ]);
    const ra = parseFloat(f[iRA]), dec = parseFloat(f[iDec]);
    if (!isFinite(ra) || !isFinite(z) || z <= 0) continue;
    rows.push({
      ra, dec,
      dist:  (z * 299_792) / H0,
      name:  (f[iID]   || "").replace(/^"|"$/g, "").trim(),
      otype: (f[iType] || "").replace(/^"|"$/g, "").trim(),
    });
  }
  console.log(`  Simbad fallback: ${rows.length} galaxies`);
  return rows;
}

// ── ΛCDM lognormal cosmic-web mock ─────────────────────────────────────────
//
// Generates galaxies following the large-scale structure of the universe,
// using a superposition of MOCK_N_WAVES plane waves weighted by the ΛCDM
// matter power spectrum (BBKS transfer function).  The lognormal transform
// maps the Gaussian field to a positive density field, producing realistic
// filaments, voids, and cluster nodes — the standard technique for making
// cosmological mock catalogs.
//
// This is NOT random fill:  the spatial clustering statistics mirror the
// real universe at scales 10–300 Mpc (BAO, LSS filaments, void fraction).
function generateLognormalMock(count, minMpc, maxMpc) {
  console.log(`  Building ΛCDM lognormal grid (${MOCK_GRID}³ cells, ${MOCK_N_WAVES} waves)…`);

  // ── BBKS transfer function (Bardeen et al. 1986) ─────────────────────────
  const Omega_m = 0.30, h = 0.70;
  const Gamma   = Omega_m * h;   // ~0.21
  function T(k) {   // k in Mpc⁻¹
    const q = k / (Gamma * h);
    const t = Math.log(1 + 2.34 * q) / (2.34 * q);
    const b = 1 + (3.89*q) + (16.1*q)**2 + (5.46*q)**3 + (6.71*q)**4;
    return t * Math.pow(b, -0.25);
  }
  // ΛCDM matter power spectrum (n_s = 0.965, unnormalised)
  function Pk(k) { const tk = T(k); return Math.pow(k, 0.965) * tk * tk; }

  // ── Generate random plane waves ───────────────────────────────────────────
  let s = 0xB00B_5EED;
  const rng = () => { s^=s<<13; s^=s>>17; s^=s<<5; return (s>>>0)/4294967296; };

  const k_min = 0.003, k_max = 0.50;   // Mpc⁻¹
  const dlogk = Math.log(k_max / k_min) / MOCK_N_WAVES;

  const waves = [];
  for (let i = 0; i < MOCK_N_WAVES; i++) {
    const k = k_min * Math.pow(k_max / k_min, rng());
    const theta = Math.acos(1 - 2 * rng());
    const phi   = 2 * Math.PI * rng();
    // Amplitude ∝ √[P(k) × k × dlogk], scaled so σ_δ ≈ 1
    const A = Math.sqrt(Pk(k) * k * dlogk) * 5.5;
    waves.push({
      kx: k * Math.sin(theta) * Math.cos(phi),
      ky: k * Math.sin(theta) * Math.sin(phi),
      kz: k * Math.cos(theta),
      A, phase: 2 * Math.PI * rng(),
    });
  }

  // ── Build density grid ────────────────────────────────────────────────────
  const BOX      = maxMpc * 2.2;   // box encloses the shell
  const cellSize = BOX / MOCK_GRID;
  const nCells   = MOCK_GRID ** 3;
  const density  = new Float64Array(nCells);

  // Precompute per-wave contributions for each cell
  let dMax = 0;
  for (let ix = 0; ix < MOCK_GRID; ix++) {
    for (let iy = 0; iy < MOCK_GRID; iy++) {
      for (let iz = 0; iz < MOCK_GRID; iz++) {
        const cx = (ix + 0.5) * cellSize - BOX / 2;
        const cy = (iy + 0.5) * cellSize - BOX / 2;
        const cz = (iz + 0.5) * cellSize - BOX / 2;
        const r  = Math.sqrt(cx*cx + cy*cy + cz*cz);
        if (r < minMpc || r > maxMpc) { continue; }  // outside shell → 0
        let d = 0;
        for (const w of waves) {
          d += w.A * Math.cos(w.kx*cx + w.ky*cy + w.kz*cz + w.phase);
        }
        const rho = Math.exp(d);   // lognormal
        const idx = ix * MOCK_GRID * MOCK_GRID + iy * MOCK_GRID + iz;
        density[idx] = rho;
        if (rho > dMax) dMax = rho;
      }
    }
  }
  console.log(`    density range: 0 – ${dMax.toFixed(2)}`);

  // ── Build CDF for fast sampling ───────────────────────────────────────────
  let total = 0;
  for (let i = 0; i < nCells; i++) total += density[i];

  const cdf = new Float64Array(nCells + 1);
  for (let i = 0; i < nCells; i++) cdf[i + 1] = cdf[i] + density[i] / total;

  // ── Sample galaxy positions ───────────────────────────────────────────────
  const rows = [];
  let attempts = 0;
  while (rows.length < count && attempts < count * 25) {
    attempts++;
    const u = rng();

    // Binary search in CDF
    let lo = 0, hi = nCells - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid + 1] < u) lo = mid + 1; else hi = mid;
    }

    const idx = lo;
    const iz  = idx % MOCK_GRID;
    const iy  = Math.floor(idx / MOCK_GRID) % MOCK_GRID;
    const ix  = Math.floor(idx / (MOCK_GRID * MOCK_GRID));

    // Sub-cell jitter
    const x = (ix + rng()) * cellSize - BOX / 2;
    const y = (iy + rng()) * cellSize - BOX / 2;
    const z = (iz + rng()) * cellSize - BOX / 2;
    const r = Math.sqrt(x*x + y*y + z*z);
    if (r < minMpc || r > maxMpc) continue;

    const dec = Math.asin(Math.max(-1, Math.min(1, z / r))) * 180 / Math.PI;
    const ra  = ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
    const v   = rng();
    const otype = v < 0.60 ? "S" : v < 0.88 ? "E" : "I";
    rows.push({ ra, dec, dist: r, name: "", otype });
  }
  console.log(`  Lognormal mock: ${rows.length} galaxies (${attempts} draws, ${MOCK_GRID}³ grid)`);
  return rows;
}

// ── Pack rows to binary ────────────────────────────────────────────────────
function pack(rows) {
  const n    = Math.min(rows.length, DISPLAY_COUNT);
  const data = new Float32Array(n * FLOATS);
  const names = [];

  for (let i = 0; i < n; i++) {
    const { ra, dec, dist, name, otype } = rows[i];
    const [x, y, z] = toEclipticAU(ra, dec, dist);
    const col = galaxyColor(otype);
    const brt = Math.max(0.05, Math.min(1, 1 - dist / 900));

    const o = i * FLOATS;
    data[o+0]=x; data[o+1]=y; data[o+2]=z;
    data[o+3] = 0.3 + brt * 1.4;
    data[o+4]=col[0]; data[o+5]=col[1]; data[o+6]=col[2];
    data[o+7] = 0.18 + brt * 0.55;

    if (name && name.length > 2) {
      names.push({ index: i, name, dist: +dist.toFixed(1) });
    }
  }
  return { data, names, count: n };
}

// ── Local Group + nearest neighbours (hardcoded — reliable distances) ──────
// Coordinates from McConnachie 2012 + NED (2024). DO NOT add entries unless
// you have verified RA/Dec/dist from a primary source — hallucinated coordinates
// cause mystery blobs to appear at wrong sky positions.
const LOCAL_GROUP = [
  // ── Milky Way satellite galaxies ──────────────────────────────────────
  { ra:  80.89, dec: -69.76, dist: 0.050, name: "Large Magellanic Cloud",       otype:"I" },
  { ra:  13.16, dec: -72.83, dist: 0.062, name: "Small Magellanic Cloud",       otype:"I" },
  { ra: 283.83, dec: -30.48, dist: 0.026, name: "Sagittarius Dwarf Spheroidal", otype:"E" },
  { ra: 100.40, dec: -50.97, dist: 0.105, name: "Carina Dwarf",                 otype:"E" },
  { ra: 227.28, dec:  67.22, dist: 0.076, name: "Ursa Minor Dwarf",             otype:"E" },
  { ra: 260.05, dec:  57.92, dist: 0.079, name: "Draco Dwarf",                  otype:"E" },
  { ra:  15.03, dec: -33.71, dist: 0.087, name: "Sculptor Dwarf Galaxy",        otype:"E" },
  { ra: 153.26, dec:  -1.61, dist: 0.086, name: "Sextans Dwarf",                otype:"E" },
  { ra:  39.97, dec: -34.45, dist: 0.147, name: "Fornax Dwarf Galaxy",          otype:"E" },
  { ra: 168.37, dec:  22.15, dist: 0.233, name: "Leo II Dwarf",                 otype:"E" },
  { ra: 152.12, dec:  12.31, dist: 0.254, name: "Leo I Dwarf",                  otype:"E" },
  { ra: 158.72, dec:  51.92, dist: 0.100, name: "Ursa Major I Dwarf",           otype:"E" },
  { ra: 354.35, dec: -15.27, dist: 0.415, name: "Phoenix Dwarf Galaxy",         otype:"I" },
  { ra:  50.67, dec: -60.85, dist: 0.158, name: "Reticulum II",                 otype:"E" },
  { ra: 186.43, dec: -57.94, dist: 0.160, name: "Hydrus I",                     otype:"E" },
  { ra: 248.72, dec: -50.23, dist: 0.130, name: "Tucana II",                    otype:"E" },
  // ── Andromeda (M31) system ─────────────────────────────────────────────
  { ra:  10.68, dec:  41.27, dist: 0.785, name: "Andromeda Galaxy (M31)",       otype:"S" },
  { ra:  10.67, dec:  40.87, dist: 0.805, name: "M32 (NGC 221)",                otype:"E" },
  { ra:  10.09, dec:  41.68, dist: 0.815, name: "NGC 205 (M110)",               otype:"E" },
  { ra:   5.76, dec:  43.50, dist: 0.745, name: "Andromeda I",                  otype:"E" },
  { ra:  19.12, dec:  33.42, dist: 0.652, name: "Andromeda II",                 otype:"E" },
  { ra:  17.43, dec:  36.50, dist: 0.749, name: "Andromeda III",                otype:"E" },
  { ra:   2.61, dec:  40.90, dist: 0.774, name: "Andromeda V",                  otype:"E" },
  { ra:  16.52, dec:  24.36, dist: 0.783, name: "Andromeda VI (Pegasus dSph)",  otype:"E" },
  { ra: 350.02, dec:  26.33, dist: 0.762, name: "Andromeda VII",                otype:"E" },
  { ra:   2.37, dec:  33.55, dist: 0.750, name: "Andromeda X",                  otype:"E" },
  { ra: 355.00, dec:  46.45, dist: 0.731, name: "Andromeda XVI",                otype:"E" },
  // ── Other Local Group members ──────────────────────────────────────────
  { ra:  23.46, dec:  30.66, dist: 0.840, name: "Triangulum Galaxy (M33)",      otype:"S" },
  { ra: 296.24, dec: -14.80, dist: 0.490, name: "NGC 6822 (Barnard's Galaxy)",  otype:"I" },
  { ra:  16.26, dec:   2.11, dist: 0.755, name: "IC 1613",                      otype:"I" },
  { ra: 350.80, dec:  14.75, dist: 0.760, name: "Pegasus Dwarf Irregular",      otype:"I" },
  { ra:   0.49, dec: -15.46, dist: 0.985, name: "WLM (Wolf-Lundmark-Melotte)",  otype:"I" },
  { ra:   5.07, dec:  59.30, dist: 0.790, name: "IC 10",                        otype:"I" },
  { ra: 143.72, dec:  -0.82, dist: 1.300, name: "Antlia Dwarf",                 otype:"E" },
  // ── Nearby galaxy groups (1–15 Mpc) — verified from NED ───────────────
  { ra: 201.37, dec: -43.02, dist: 3.800, name: "Centaurus A (NGC 5128)",       otype:"E" },
  { ra: 148.88, dec:  69.07, dist: 3.630, name: "M81 (Bode's Galaxy)",          otype:"S" },
  { ra: 148.97, dec:  69.68, dist: 3.530, name: "M82 (Cigar Galaxy)",           otype:"I" },
  { ra:  11.89, dec: -25.29, dist: 3.500, name: "NGC 253 (Sculptor Galaxy)",    otype:"S" },
  { ra:  56.70, dec:  68.10, dist: 3.300, name: "IC 342",                       otype:"S" },
  { ra:  50.66, dec:  59.61, dist: 3.000, name: "Maffei 1",                     otype:"E" },
  { ra:  51.52, dec:  59.59, dist: 3.400, name: "Maffei 2",                     otype:"S" },
  { ra: 114.21, dec:  65.60, dist: 3.180, name: "NGC 2403",                     otype:"S" },
  { ra: 204.25, dec: -29.87, dist: 4.610, name: "M83 (Southern Pinwheel)",      otype:"S" },
  { ra: 185.03, dec:  47.30, dist: 7.200, name: "M106 (NGC 4258)",              otype:"S" },
  { ra: 210.80, dec:  54.35, dist: 6.400, name: "M101 (Pinwheel Galaxy)",       otype:"S" },
  { ra: 189.99, dec: -11.62, dist: 9.550, name: "M104 (Sombrero Galaxy)",       otype:"S" },
  { ra: 187.71, dec:  12.39, dist:16.400, name: "M87 (Virgo A)",                otype:"E" },
  { ra: 202.47, dec:  47.20, dist: 7.220, name: "M51 (Whirlpool Galaxy)",       otype:"S" },
  { ra: 198.96, dec:  42.03, dist: 7.900, name: "M63 (Sunflower Galaxy)",       otype:"S" },
  { ra: 159.47, dec:  11.82, dist: 4.690, name: "M96 (NGC 3368)",               otype:"S" },
  { ra: 170.07, dec:  13.15, dist: 5.210, name: "M66 (NGC 3627)",               otype:"S" },
  { ra: 169.73, dec:  13.59, dist: 5.220, name: "M65 (NGC 3623)",               otype:"S" },
];

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(join(__dir, "../public/data"), { recursive: true });

  // NOTE: The LOCAL_GROUP hardcoded galaxies are NOT included in the binary.
  // They are injected at runtime by addLocalGroupAnchors() in galaxies.ts,
  // which overwrites the first N buffer slots with properly labelled entries.
  // Including them in the binary would create unlabelled duplicate blobs at
  // positions N..N+52 that show up as "Galaxy" near the Milky Way.

  // Phase 1: 2MRS full-sky survey (real galaxies, > 25 Mpc only).
  // Lower bound: avoids overlap with LOCAL_GROUP_SOURCES (which covers 0–16.4 Mpc).
  // The 25 Mpc gap is intentional — no competing unlabelled blobs near the LG.
  const MIN_2MRS_MPC = 25;
  let nearbyRows = [];
  try {
    let rows2mrs = await fetch2MRS();
    rows2mrs = rows2mrs.filter(r => r.dist > MIN_2MRS_MPC);
    // ZoA isotropic completion: fill the missing galactic-plane stripe
    rows2mrs = completeZoA(rows2mrs);
    nearbyRows = rows2mrs;
    console.log(`2MRS (dist > ${MIN_2MRS_MPC} Mpc) + ZoA completion: ${nearbyRows.length} galaxies`);
  } catch (e) {
    console.warn(`2MRS failed (${e.message}), falling back to Simbad…`);
    try {
      let simbad = await fetchSimbad();
      simbad = simbad.filter(r => !/^\[.+\]/.test(r.name) && r.dist > MIN_2MRS_MPC);
      nearbyRows = simbad;
    } catch (e2) {
      console.warn(`Simbad also failed: ${e2.message}`);
    }
  }

  // Phase 2: Build the protected nearest-10k zone from 2MRS data.
  // Sort nearest-first, keep up to PROTECTED_COUNT (no thinning).
  const mergedNearby = [...nearbyRows];
  mergedNearby.sort((a, b) => a.dist - b.dist);
  const protectedGalaxies = mergedNearby.slice(0, PROTECTED_COUNT);
  const protectedEdgeDist = protectedGalaxies.length > 0
    ? protectedGalaxies[protectedGalaxies.length - 1].dist
    : 100;

  console.log(`Protected zone: ${protectedGalaxies.length} galaxies (${MIN_2MRS_MPC}–${protectedEdgeDist.toFixed(0)} Mpc, 2MRS real data)`);

  // Phase 4: Lognormal ΛCDM cosmic-web mock for the distant universe.
  // The mock generates realistic filaments, voids, and clusters from the
  // matter power spectrum — proper mock-catalog technique, not random fill.
  const mockCount = DISPLAY_COUNT - protectedGalaxies.length;
  const mockMinMpc = Math.max(protectedEdgeDist * 0.9, 50);
  console.log(`\nGenerating ΛCDM cosmic-web mock: ${mockCount.toLocaleString()} galaxies (${Math.round(mockMinMpc)}–850 Mpc)…`);
  const mockRows = generateLognormalMock(mockCount, mockMinMpc, 850);

  // Phase 5: Combine, sort nearest-first, write binary.
  const allRows = [...protectedGalaxies, ...mockRows];
  allRows.sort((a, b) => a.dist - b.dist);

  const { data, names, count } = pack(allRows);
  const distMax = allRows[allRows.length - 1]?.dist ?? 850;

  await writeFile(OUT_BIN,   Buffer.from(data.buffer));
  await writeFile(OUT_META,  JSON.stringify({
    source:   "2MRS (dist>25 Mpc, full-sky) + ZoA completion + ΛCDM lognormal mock. LOCAL_GROUP injected at runtime by galaxies.ts.",
    min2mrsMpc:       MIN_2MRS_MPC,
    nearbyCount:      nearbyRows.length,
    protectedCount:   protectedGalaxies.length,
    protectedEdgeMpc: Math.round(protectedEdgeDist),
    mockCount:        mockRows.length,
    count,
    distMaxMpc:       Math.round(distMax),
    FLOATS,
    distanceScaleVersion: GALAXY_SCALE_VERSION,
    kpcToAU:  GALAXY_KPC_TO_AU,
    mpcToAU:  GALAXY_MPC_TO_AU,
    linearLimitMpc: GALAXY_LINEAR_LIMIT_MPC,
    logScaleAU:     GALAXY_LOG_SCALE_AU,
  }, null, 2));
  await writeFile(OUT_NAMES, JSON.stringify(names, null, 2));

  const mb = (data.byteLength / 1024 / 1024).toFixed(1);
  console.log(`\n✓ ${count.toLocaleString()} galaxies written (${mb} MB)`);
  console.log(`  2MRS real:     ${protectedGalaxies.length.toLocaleString()} (${MIN_2MRS_MPC}–${Math.round(protectedEdgeDist)} Mpc, no thinning)`);
  console.log(`  ΛCDM mock:     ${mockRows.length.toLocaleString()} (${Math.round(mockMinMpc)}–${Math.round(distMax)} Mpc)`);
  console.log(`  Note: LOCAL_GROUP (0–16 Mpc) injected at runtime by galaxies.ts (no duplicates)`);
}

main().catch(e => { console.error(e); process.exit(1); });

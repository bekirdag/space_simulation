#!/usr/bin/env node
/**
 * Build: 100k nearest galaxies → public/data/galaxies-100k.bin  (3.2 MB)
 *
 * Strategy:
 *   • Simbad TAP   → ~50k real galaxies with spectroscopic redshifts (z < 0.03)
 *   • Procedural   → 50k additional at larger distances for visual completeness
 *
 * Binary layout per galaxy (8 floats = 32 bytes, same as HYG star binary):
 *   [0-2] visual position AU (ecliptic J2000, Local Group linear + deep-field log)
 *   [3]   size multiplier
 *   [4-6] RGB colour
 *   [7]   alpha
 *
 * Scale:
 *   - 8 000 AU/kpc, matching the Milky Way background catalog
 *   - linear through 2 Mpc so the Local Group has realistic proportions
 *   - logarithmic beyond 2 Mpc so the deep galaxy catalog stays navigable
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT_BIN   = join(__dir, "../public/data/galaxies-100k.bin");
const OUT_META  = join(__dir, "../public/data/galaxies-100k.meta.json");
const OUT_NAMES = join(__dir, "../public/data/galaxy-names.json");

const FLOATS = 8;
const COUNT  = 100_000;
const GALAXY_SCALE_VERSION = "local-group-linear-log-v2";
const GALAXY_KPC_TO_AU = 8_000;
const GALAXY_MPC_TO_AU = GALAXY_KPC_TO_AU * 1_000;
const GALAXY_LINEAR_LIMIT_MPC = 2;
const GALAXY_LOG_INTERVAL_MPC = 2;
const GALAXY_LOG_SCALE_AU = 1_200_000;
const GALAXY_LINEAR_LIMIT_AU = GALAXY_LINEAR_LIMIT_MPC * GALAXY_MPC_TO_AU;
const MILKY_WAY_DIAMETER_KPC_APPROX = 30.7; // ~100,000 light-years
const EPS = 23.4393 * Math.PI / 180;
const H0  = 70;

const d2r = d => d * Math.PI / 180;

function visualDist(mpc) {
  const d = Number.isFinite(mpc) ? Math.max(0, mpc) : 0;
  if (d <= GALAXY_LINEAR_LIMIT_MPC) return d * GALAXY_MPC_TO_AU;

  const beyond = (d - GALAXY_LINEAR_LIMIT_MPC) / GALAXY_LOG_INTERVAL_MPC;
  return GALAXY_LINEAR_LIMIT_AU + GALAXY_LOG_SCALE_AU * Math.log2(beyond + 1);
}

function toEclipticAU(ra, dec, distMpc) {
  const r = visualDist(distMpc);
  const xe = Math.cos(d2r(dec)) * Math.cos(d2r(ra));
  const ye = Math.cos(d2r(dec)) * Math.sin(d2r(ra));
  const ze = Math.sin(d2r(dec));
  return [
    xe * r,
    ( ye * Math.cos(EPS) + ze * Math.sin(EPS)) * r,
    (-ye * Math.sin(EPS) + ze * Math.cos(EPS)) * r,
  ];
}

/**
 * Galaxy type (Simbad otype string) → approximate integrated sRGB colour.
 * Calibrated to observed galaxy photometry (Fukugita et al. 1995, SDSS photometry).
 *
 * Ellipticals:  dominated by old K/M stars → warm orange-yellow
 * Lenticulars:  similar, slightly bluer bulge
 * Spirals:      mixture of old bulge + young blue disk stars
 * Late spirals: mostly young blue stars, ongoing star formation
 * Irregulars:   intense starburst, blue-violet
 */
function galaxyColor(otype) {
  const o = (otype || "").trim().toLowerCase();
  // Elliptical (E0–E7) — old stellar population, very red
  if (o.startsWith("e") && !o.startsWith("em"))
    return [1.00, 0.80, 0.52];
  // Lenticular (S0, SA0, SB0)
  if (o.startsWith("s0") || o === "sa0" || o === "sb0")
    return [0.97, 0.85, 0.62];
  // Barred spirals (SBa, SBb, SBc)
  if (o.startsWith("sb"))
    return [0.82, 0.87, 1.00];
  // Early spirals (Sa, Sb) — yellow disk with blue star-forming regions
  if (o.startsWith("sa") || o.startsWith("sb"))
    return [0.88, 0.90, 1.00];
  // Late spirals (Sc, Sd) — blue, lots of OB stars
  if (o.startsWith("sc") || o.startsWith("sd"))
    return [0.68, 0.78, 1.00];
  // Irregular / starburst — intense blue star formation
  if (o.startsWith("i") || o.startsWith("am") || o.includes("irr"))
    return [0.58, 0.68, 1.00];
  // Generic spiral
  if (o.startsWith("s"))
    return [0.78, 0.84, 1.00];
  // Unknown / other
  return [0.82, 0.82, 0.90];
}

// ── Real galaxies from Simbad ─────────────────────────────────────────────
async function fetchSimbad() {
  console.log("Simbad TAP: querying nearest galaxies (z > 0.0003)…");
  const adql = `SELECT TOP 50000 ra, dec, rvz_redshift, main_id, otype
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
  const col = n => hdr.indexOf(n);
  const [iRA, iDec, iZ, iID, iType] = ["ra","dec","rvz_redshift","main_id","otype"].map(col);
  if (iRA < 0 || iZ < 0) throw new Error("Unexpected columns: " + hdr);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(",");
    const z = parseFloat(f[iZ]);
    const ra = parseFloat(f[iRA]), dec = parseFloat(f[iDec]);
    if (!isFinite(ra) || !isFinite(z) || z <= 0) continue;
    rows.push({
      ra, dec,
      dist:  (z * 299_792) / H0,
      name:  (f[iID]   || "").replace(/^"|"$/g, "").trim(),
      otype: (f[iType] || "").replace(/^"|"$/g, "").trim(),
    });
  }
  console.log(`  Retrieved ${rows.length} real galaxies`);
  return rows;
}

// ── Procedural fill for distances beyond Simbad coverage ─────────────────
function generateProcedural(count, minMpc, maxMpc) {
  let s = 0xC0DE_CAFE;
  const rng = () => { s^=s<<13; s^=s>>17; s^=s<<5; return (s>>>0)/4294967296; };

  const rows = [];
  while (rows.length < count) {
    const ra  = rng() * 360;
    const dec = Math.asin(rng() * 2 - 1) * 180 / Math.PI;
    // Volume-weighted distance in [minMpc, maxMpc]
    const u   = rng();
    const dist = Math.cbrt(u * (maxMpc**3 - minMpc**3) + minMpc**3);
    const r   = rng();
    const otype = r < 0.60 ? "S" : r < 0.88 ? "E" : "I";
    rows.push({ ra, dec, dist, name: "", otype });
  }
  return rows;
}

// ── Pack rows to binary ────────────────────────────────────────────────────
function pack(rows) {
  const n    = Math.min(rows.length, COUNT);
  const data = new Float32Array(n * FLOATS);
  const names = [];

  for (let i = 0; i < n; i++) {
    const { ra, dec, dist, name, otype } = rows[i];
    const [x, y, z] = toEclipticAU(ra, dec, dist);
    const col = galaxyColor(otype);
    const brt = Math.max(0.05, Math.min(1, 1 - dist / 900));

    const o = i * FLOATS;
    data[o+0]=x; data[o+1]=y; data[o+2]=z;
    data[o+3] = 0.3 + brt * 1.4;           // size
    data[o+4]=col[0]; data[o+5]=col[1]; data[o+6]=col[2];
    data[o+7] = 0.18 + brt * 0.55;          // alpha

    if (name && name.length > 2) {
      names.push({ index: i, name, dist: +dist.toFixed(1) });
    }
  }
  return { data, names, count: n };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  await mkdir(join(__dir, "../public/data"), { recursive: true });

  // Phase 1: real galaxies from Simbad
  let realRows = [];
  try {
    realRows = await fetchSimbad();
  } catch (e) {
    console.warn("Simbad failed:", e.message);
  }

  realRows.sort((a, b) => a.dist - b.dist);

  // Phase 2: fill up to 100k with procedural galaxies at larger distances
  const realMax = realRows.length > 0 ? realRows[realRows.length - 1].dist : 0;
  const procCount = COUNT - realRows.length;
  console.log(`Adding ${procCount.toLocaleString()} procedural galaxies (${Math.round(realMax)}–850 Mpc)…`);
  const procRows = generateProcedural(procCount, Math.max(realMax, 1), 850);

  const allRows = [...realRows, ...procRows];  // real first (nearest)

  const { data, names, count } = pack(allRows);
  const distMax = allRows[allRows.length - 1]?.dist ?? 850;

  await writeFile(OUT_BIN,   Buffer.from(data.buffer));
  await writeFile(OUT_META,  JSON.stringify({
    source:   "Simbad TAP (real) + procedural",
    realCount: realRows.length,
    procCount,
    count,
    distMaxMpc: Math.round(distMax),
    FLOATS,
    distanceScaleVersion: GALAXY_SCALE_VERSION,
    kpcToAU: GALAXY_KPC_TO_AU,
    mpcToAU: GALAXY_MPC_TO_AU,
    linearLimitMpc: GALAXY_LINEAR_LIMIT_MPC,
    logIntervalMpc: GALAXY_LOG_INTERVAL_MPC,
    logScaleAU: GALAXY_LOG_SCALE_AU,
    milkyWayDiameterAUApprox: Math.round(MILKY_WAY_DIAMETER_KPC_APPROX * GALAXY_KPC_TO_AU),
  }, null, 2));
  await writeFile(OUT_NAMES, JSON.stringify(names, null, 2));

  const mb = (data.byteLength / 1024 / 1024).toFixed(1);
  console.log(`\n✓ ${count.toLocaleString()} galaxies written (${mb} MB)`);
  console.log(`  Real:        ${realRows.length.toLocaleString()} (Simbad, < ${Math.round(realMax)} Mpc)`);
  console.log(`  Procedural:  ${procCount.toLocaleString()} (${Math.round(realMax)}–850 Mpc)`);
  console.log(`  Named:       ${names.length.toLocaleString()}`);
}

main().catch(e => { console.error(e); process.exit(1); });

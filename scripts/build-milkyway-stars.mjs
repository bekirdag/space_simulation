#!/usr/bin/env node
// Generates 100k Milky Way background stars for the galaxy-scale LOD layer.
// Positions are distributed with a realistic density model (disk + bulge + spiral arms),
// converted from galactocentric galactic → heliocentric ecliptic J2000 at 8000 AU/kpc.
//
// Output: public/data/milkyway-stars.bin
//         100 000 × 8 floats × 4 bytes = 3.2 MB
//         Layout per star: [x, y, z, size, r, g, b, alpha]
//         (same as the STAR_FLOATS=8 layout used by star.wgsl)

import { writeFileSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT   = path.join(__dir, "../public/data/milkyway-stars.bin");
mkdirSync(path.dirname(OUT), { recursive: true });

const N_STARS    = 200_000;
const KPC_TO_AU  = 8_000;   // 8 000 AU per kpc → galaxy diameter 30 kpc = 240 000 AU
const R_SUN      = 8.5;     // kpc, Sun's galactocentric radius

// ── Galactic → Ecliptic J2000 rotation matrix ───────────────────────────────
// Computed from the Hipparcos/ICRS galactic→equatorial matrix (R^T) composed
// with the equatorial→ecliptic rotation (ε = 23.4393°).
// Verified: galactic center (1,0,0)_gal → (λ=266.8°, β=-5.5°)_ecl  ✓
//           N galactic pole  (0,0,1)_gal → β=+29.8°  ✓
const R = [
  [-0.054876,  0.494109, -0.867666],
  [-0.993911, -0.111106, -0.000312],
  [-0.096390,  0.862326,  0.497159],
];

function galToEcl(xg, yg, zg) {
  return [
    R[0][0]*xg + R[0][1]*yg + R[0][2]*zg,
    R[1][0]*xg + R[1][1]*yg + R[1][2]*zg,
    R[2][0]*xg + R[2][1]*yg + R[2][2]*zg,
  ];
}

// ── LCG random number generator (fast, deterministic) ───────────────────────
let seed = 0xdeadbeef;
function rand() {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return seed / 0xffffffff;
}
function randn() {
  // Box–Muller
  const u1 = Math.max(1e-9, rand());
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Milky Way density model ──────────────────────────────────────────────────
// Thin disk:  70% of stars, hR=3.0 kpc, hz=0.30 kpc
// Thick disk: 15% of stars, hR=3.5 kpc, hz=1.0  kpc
// Bulge:      15% of stars, r_scale=1.0 kpc, elliptical

function sampleR(hR, Rmax) {
  // Inverse CDF of exponential over [0, Rmax]
  const u = rand();
  const c = 1 - Math.exp(-Rmax / hR);
  return -hR * Math.log(1 - u * c);
}

// ── Spiral arm model ─────────────────────────────────────────────────────────
// 4 logarithmic arms + local arm.  Each arm: theta_arm(R) = theta0 + ln(R/R0)/tan(p)
// Density boost: exp(-d_arm² / width²) applied to azimuthal angle sampling.
const ARMS = [
  { theta0: Math.PI * 0.0,  R0: 6.0, tanp: Math.tan(0.21),  width: 0.45, name: "Sagittarius"  },
  { theta0: Math.PI * 0.5,  R0: 5.5, tanp: Math.tan(0.21),  width: 0.45, name: "Norma"        },
  { theta0: Math.PI * 1.0,  R0: 6.0, tanp: Math.tan(0.21),  width: 0.45, name: "Perseus"      },
  { theta0: Math.PI * 1.5,  R0: 5.5, tanp: Math.tan(0.21),  width: 0.45, name: "Scutum"       },
  { theta0: Math.PI * 0.35, R0: 8.5, tanp: Math.tan(0.19),  width: 0.35, name: "Local/Orion"  },
];

function armBoost(R, theta) {
  if (R < 2) return 1;
  let boost = 1;
  for (const arm of ARMS) {
    // Arm center angle at this R (can be multivalued for full winding)
    for (let wind = -1; wind <= 1; wind++) {
      const thetaArm = arm.theta0 + Math.log(R / arm.R0) / arm.tanp + wind * 2 * Math.PI;
      // Angular distance (kpc-like via arc length)
      const dAng = Math.abs(theta - thetaArm) % (2 * Math.PI);
      const dArc = Math.min(dAng, 2 * Math.PI - dAng) * R; // arc length in kpc
      boost = Math.max(boost, 1 + 3.5 * Math.exp(-dArc * dArc / (arm.width * arm.width)));
    }
  }
  return boost;
}

// ── Stellar color by type ─────────────────────────────────────────────────────
// OB: 5%, A: 12%, FG: 30%, KM: 53%
function starColor() {
  const u = rand();
  if (u < 0.05) return { r: 0.65, g: 0.75, b: 1.00, luminosityBias: 5.0 }; // O/B
  if (u < 0.17) return { r: 0.90, g: 0.95, b: 1.00, luminosityBias: 2.1 }; // A/F
  if (u < 0.47) return { r: 1.00, g: 0.92, b: 0.75, luminosityBias: 0.9 }; // G
  if (u < 0.72) return { r: 1.00, g: 0.65, b: 0.35, luminosityBias: 0.55 }; // K
  return         { r: 1.00, g: 0.35, b: 0.20, luminosityBias: 0.28 };        // M
}

function displayBrightness(luminosityBias) {
  // Skybox-like apparent distribution: many dim points and a few bright anchors.
  const flux = Math.min(1, Math.pow(rand(), 8.0) * luminosityBias);
  return Math.max(0.035, Math.pow(Math.max(flux, 1e-8), 0.18));
}

// ── Sampling ─────────────────────────────────────────────────────────────────
const out = new Float32Array(N_STARS * 8);

let i = 0;
const Rmax = 16; // kpc — truncate disk

while (i < N_STARS) {
  const kind = rand();
  let xgc, ygc, zgc; // galactocentric kpc

  if (kind < 0.70) {
    // ── Thin disk ──────────────────────────────────────────────────────────
    const R  = sampleR(3.0, Rmax);
    const hz = 0.30;

    // Sample theta with arm-density weighting (rejection sampling)
    let theta;
    let accepted = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const t = rand() * 2 * Math.PI;
      const b = armBoost(R, t);
      if (rand() < b / 5.5) { theta = t; accepted = true; break; }
    }
    if (!accepted) theta = rand() * 2 * Math.PI;

    xgc = R * Math.cos(theta);
    ygc = R * Math.sin(theta);
    zgc = randn() * hz;

  } else if (kind < 0.85) {
    // ── Thick disk ────────────────────────────────────────────────────────
    const R     = sampleR(3.5, Rmax);
    const theta = rand() * 2 * Math.PI;
    xgc = R * Math.cos(theta);
    ygc = R * Math.sin(theta);
    zgc = randn() * 1.0;

  } else {
    // ── Bulge (bar-like, ellipsoidal) ─────────────────────────────────────
    // Bartlett: sample inside exponential sphere with q=0.5 flattening
    const r = -1.0 * Math.log(Math.max(1e-9, rand()));
    const ct = 2 * rand() - 1;
    const st = Math.sqrt(1 - ct * ct);
    const ph = rand() * 2 * Math.PI;
    xgc = r * st * Math.cos(ph) * 1.5; // slightly elongated along x (bar)
    ygc = r * st * Math.sin(ph) * 0.8;
    zgc = r * ct * 0.5;                 // flattened

    // Bulge limited to central 5 kpc
    const rbulge = Math.sqrt(xgc*xgc + ygc*ygc + zgc*zgc);
    if (rbulge > 4.0) continue;
  }

  // Heliocentric galactic (Sun at (-8.5, 0, 0) galactocentric):
  const xh = xgc - (-R_SUN); // = xgc + R_SUN
  const yh = ygc;
  const zh = zgc;

  // Ecliptic J2000 in AU
  const [xe, ye, ze] = galToEcl(xh, yh, zh);
  const x_au = xe * KPC_TO_AU;
  const y_au = ye * KPC_TO_AU;
  const z_au = ze * KPC_TO_AU;

  // Skip stars that are unreasonably close (< 0.1 kpc) to avoid overlapping
  // with the nearby HYG catalog which already handles the local neighbourhood.
  const distKpc = Math.sqrt(xh*xh + yh*yh + zh*zh);
  if (distKpc < 0.1) continue;

  const { r, g, b, luminosityBias } = starColor();
  const brightness = displayBrightness(luminosityBias);
  const size  = 0.32 + Math.pow(brightness, 1.25) * 1.35;
  const alpha = 0.055 + Math.pow(brightness, 0.90) * 0.54;

  const o = i * 8;
  out[o+0] = x_au;
  out[o+1] = y_au;
  out[o+2] = z_au;
  out[o+3] = size;
  out[o+4] = r;
  out[o+5] = g;
  out[o+6] = b;
  out[o+7] = alpha;

  i++;
}

writeFileSync(OUT, Buffer.from(out.buffer));

console.log(`Written ${N_STARS} Milky Way stars → ${OUT}`);
console.log(`File size: ${(N_STARS * 8 * 4 / 1e6).toFixed(2)} MB`);

// Sanity check: count stars near galactic plane vs poles
let nearPlane = 0, nearBulge = 0;
for (let j = 0; j < N_STARS; j++) {
  const o = j * 8;
  const x = out[o], y = out[o+1], z = out[o+2];
  const d = Math.sqrt(x*x + y*y + z*z);
  if (d < 1) { nearBulge++; continue; }
  // Galactic Z: project back with the transpose of the galactic -> ecliptic matrix.
  const zg = R[0][2]*x/KPC_TO_AU + R[1][2]*y/KPC_TO_AU + R[2][2]*z/KPC_TO_AU;
  if (Math.abs(zg) < 0.5) nearPlane++;
}
console.log(`Stars within b<~3° of galactic plane: ${Math.round(nearPlane/N_STARS*100)}% (expect ~75–85%)`);
console.log(`Stars in bulge region (< 1 AU from origin): ${nearBulge}`);

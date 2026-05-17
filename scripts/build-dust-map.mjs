#!/usr/bin/env node
// Downsamples the NASA/GSFC LAMBDA Meisner & Finkbeiner 2015 E(B-V) dust map
// into the compact 8-float line-of-sight format used by src/catalog/dust.ts.
//
// Raw FITS input is cached locally under public/cache/nasa and ignored by git.
// Generated outputs:
//   public/data/dust-map-mf2015.bin
//   public/data/dust-map-mf2015.meta.json
//   public/cache/nasa/dust-map-mf2015.meta.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");
const DATA_DIR = join(ROOT, "public", "data");
const NASA_CACHE_DIR = join(ROOT, "public", "cache", "nasa");
const RAW_FITS = join(NASA_CACHE_DIR, "lambda_mollweide_mf2015_dust_map_v2.fits");
const OUT_BIN = join(DATA_DIR, "dust-map-mf2015.bin");
const OUT_META = join(DATA_DIR, "dust-map-mf2015.meta.json");
const OUT_CACHE_META = join(NASA_CACHE_DIR, "dust-map-mf2015.meta.json");

const FITS_URL = "https://lambda.gsfc.nasa.gov/data/foregrounds/EBV/lambda_mollweide_mf2015_dust_map_v2.fits";
const INFO_URL = "https://lambda.gsfc.nasa.gov/product/foreground/fg_meisner_finkbeiner_2015_info.html";
const DOWNLOAD_URL = "https://lambda.gsfc.nasa.gov/product/foreground/fg_meisner_finkbeiner_2015_get.html";
const IPAC_DUST_URL = "https://irsa.ipac.caltech.edu/applications/DUST/";

const BASE_OUT_W = 256;
const BASE_OUT_H = 128;
const DEFAULT_GRID_SCALE = 2;
const MAX_GRID_SCALE = 4;
const GRID_SCALE = readGridScale();
const OUT_W = BASE_OUT_W * GRID_SCALE;
const OUT_H = BASE_OUT_H * GRID_SCALE;
const DUST_FLOATS = 8;
const MW_KPC_AU = 8_000;
const SUN_GALACTIC_RADIUS_KPC = 8.5;
const SHELL_RADIUS_AU = MW_KPC_AU * SUN_GALACTIC_RADIUS_KPC;
const SQRT2 = Math.SQRT2;

const GAL_TO_ECL = [
  [-0.054876,  0.494109, -0.867666],
  [-0.993911, -0.111106, -0.000312],
  [-0.096390,  0.862326,  0.497159],
];

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(NASA_CACHE_DIR, { recursive: true });

function readGridScale() {
  const raw = process.env.DUST_GRID_SCALE;
  if (!raw) return DEFAULT_GRID_SCALE;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`DUST_GRID_SCALE must be a positive integer, got "${raw}".`);
  }
  if (parsed > MAX_GRID_SCALE) {
    console.warn(`DUST_GRID_SCALE=${parsed} is above ${MAX_GRID_SCALE}; using ${MAX_GRID_SCALE}.`);
    return MAX_GRID_SCALE;
  }
  return parsed;
}

async function ensureRawFits() {
  if (existsSync(RAW_FITS)) {
    console.log(`Using cached FITS: ${RAW_FITS}`);
    return;
  }

  console.log(`Downloading ${FITS_URL}`);
  const res = await fetch(FITS_URL);
  if (!res.ok) throw new Error(`FITS download failed: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeFileSync(RAW_FITS, bytes);
  console.log(`Cached ${(bytes.byteLength / 1e6).toFixed(1)} MB -> ${RAW_FITS}`);
}

function fitsValue(card) {
  const raw = card.slice(10, 80).split("/")[0]?.trim() ?? "";
  if (raw.startsWith("'")) return raw.slice(1, raw.indexOf("'", 1)).trim();
  if (raw === "T") return true;
  if (raw === "F") return false;
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

function readFitsHeader(buf, offset) {
  const cards = {};
  let p = offset;
  while (p + 80 <= buf.length) {
    const card = buf.toString("ascii", p, p + 80);
    p += 80;
    const key = card.slice(0, 8).trim();
    if (key === "END") break;
    if (key && card[8] === "=") cards[key] = fitsValue(card);
  }
  const headerBytes = Math.ceil((p - offset) / 2880) * 2880;
  return { cards, nextOffset: offset + headerBytes, headerBytes };
}

function dataByteLength(cards) {
  const naxis = Number(cards.NAXIS ?? 0);
  if (!naxis) return 0;
  let pixels = 1;
  for (let i = 1; i <= naxis; i++) pixels *= Number(cards[`NAXIS${i}`] ?? 0);
  return pixels * Math.abs(Number(cards.BITPIX ?? 0)) / 8;
}

function findFirstImageExtension(buf) {
  let header = readFitsHeader(buf, 0);
  let offset = header.nextOffset + dataByteLength(header.cards);
  offset = Math.ceil(offset / 2880) * 2880;

  while (offset < buf.length) {
    header = readFitsHeader(buf, offset);
    const cards = header.cards;
    const bitpix = Number(cards.BITPIX);
    const w = Number(cards.NAXIS1);
    const h = Number(cards.NAXIS2);
    const extName = String(cards.EXTNAME ?? "");
    const dataStart = header.nextOffset;
    const byteLen = dataByteLength(cards);
    if (cards.XTENSION === "IMAGE" && bitpix === -32 && w > 0 && h > 0 && extName.includes("E(B-V)")) {
      return { cards, width: w, height: h, dataStart };
    }
    offset = Math.ceil((dataStart + byteLen) / 2880) * 2880;
  }

  throw new Error("No E(B-V) float image extension found in FITS.");
}

function readFloatBE(buf, byteOffset) {
  return buf.readFloatBE(byteOffset);
}

function mollweidePixelToGalactic(x, y, width, height) {
  // Values from the LAMBDA FITS header. Pixel coordinates here are 0-based;
  // FITS CRPIX values are 1-based pixel centers.
  const cdelt1 = -0.0791293637247;
  const cdelt2 =  0.0791293637247;
  const crpix1 = width / 2 + 0.5;
  const crpix2 = height / 2 + 0.5;
  const xDeg = ((x + 1) - crpix1) * cdelt1;
  const yDeg = ((y + 1) - crpix2) * cdelt2;
  const xr = xDeg * Math.PI / 180;
  const yr = yDeg * Math.PI / 180;

  if (Math.abs(yr) > SQRT2) return null;
  const theta = Math.asin(Math.max(-1, Math.min(1, yr / SQRT2)));
  const cosTheta = Math.cos(theta);
  if (Math.abs(cosTheta) < 1e-6) return null;
  const lon = Math.PI * xr / (2 * SQRT2 * cosTheta);
  if (!Number.isFinite(lon) || Math.abs(lon) > Math.PI * 1.001) return null;
  const lat = Math.asin(Math.max(-1, Math.min(1, (2 * theta + Math.sin(2 * theta)) / Math.PI)));
  return { lon, lat };
}

function galacticDirectionToEcliptic(lon, lat) {
  const cb = Math.cos(lat);
  const xg = cb * Math.cos(lon);
  const yg = cb * Math.sin(lon);
  const zg = Math.sin(lat);
  return [
    (GAL_TO_ECL[0][0] * xg + GAL_TO_ECL[0][1] * yg + GAL_TO_ECL[0][2] * zg) * SHELL_RADIUS_AU,
    (GAL_TO_ECL[1][0] * xg + GAL_TO_ECL[1][1] * yg + GAL_TO_ECL[1][2] * zg) * SHELL_RADIUS_AU,
    (GAL_TO_ECL[2][0] * xg + GAL_TO_ECL[2][1] * yg + GAL_TO_ECL[2][2] * zg) * SHELL_RADIUS_AU,
  ];
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))] ?? 1;
}

await ensureRawFits();
const fits = readFileSync(RAW_FITS);
const image = findFirstImageExtension(fits);
console.log(`Reading ${image.width}x${image.height} ${image.cards.EXTNAME} image.`);
console.log(`Building ${OUT_W}x${OUT_H} dust grid (DUST_GRID_SCALE=${GRID_SCALE}).`);

const candidates = [];
const blockW = image.width / OUT_W;
const blockH = image.height / OUT_H;

for (let oy = 0; oy < OUT_H; oy++) {
  for (let ox = 0; ox < OUT_W; ox++) {
    const x0 = Math.floor(ox * blockW);
    const x1 = Math.floor((ox + 1) * blockW);
    const y0 = Math.floor(oy * blockH);
    const y1 = Math.floor((oy + 1) * blockH);
    let sum = 0;
    let count = 0;
    for (let y = y0; y < y1; y++) {
      const row = image.dataStart + y * image.width * 4;
      for (let x = x0; x < x1; x++) {
        const v = readFloatBE(fits, row + x * 4);
        if (Number.isFinite(v) && v > 0 && v < 50) {
          sum += v;
          count++;
        }
      }
    }
    if (count === 0) continue;
    const ebv = sum / count;
    const cx = x0 + (x1 - x0) * 0.5;
    const cy = y0 + (y1 - y0) * 0.5;
    const gal = mollweidePixelToGalactic(cx, cy, image.width, image.height);
    if (!gal) continue;
    candidates.push({ ebv, lon: gal.lon, lat: gal.lat });
  }
}

const p95 = percentile(candidates.map(c => c.ebv), 0.95);
const p99 = percentile(candidates.map(c => c.ebv), 0.99);
const cells = [];
const cellRadius = SHELL_RADIUS_AU * Math.max(Math.PI / OUT_H, (2 * Math.PI) / OUT_W) * 1.10;

for (const c of candidates) {
  const density = Math.min(1, Math.log1p(c.ebv * 5.0) / Math.log1p(p95 * 5.0));
  if (density < 0.055) continue;
  const [x, y, z] = galacticDirectionToEcliptic(c.lon, c.lat);
  const hot = Math.min(1, c.ebv / p99);
  const alpha = 0.006 + density * 0.080;
  cells.push(
    x, y, z, cellRadius * (0.85 + density * 0.75),
    0.58 + hot * 0.24,
    0.28 + hot * 0.16,
    0.12 + hot * 0.08,
    alpha,
  );
}

const out = new Float32Array(cells);
writeFileSync(OUT_BIN, Buffer.from(out.buffer));
const galacticCenterWorldAU = galacticDirectionToEcliptic(0, 0);

const meta = {
  schema: "physics_sim.dust-map.v1",
  sourceName: "NASA/GSFC LAMBDA Meisner-Finkbeiner 2015 E(B-V) dust map",
  sourceUrl: INFO_URL,
  downloadUrl: DOWNLOAD_URL,
  fitsUrl: FITS_URL,
  ipacDustServiceUrl: IPAC_DUST_URL,
  generatedAt: new Date().toISOString(),
  projection: "Mollweide all-sky source, converted to reddening-weighted Galactic line-of-sight cells",
  anchoring: {
    type: "sun-observed all-sky directions projected through the Milky Way disk at runtime",
    note: "Cells store measured reddening directions and weights; runtime samples cloud locations through a Milky Way disk/spiral density model instead of rendering a Sun-centered shell.",
    milkyWayScaleAUPerKpc: MW_KPC_AU,
    sunGalacticRadiusKpc: SUN_GALACTIC_RADIUS_KPC,
    galacticCenterWorldAU: {
      x: galacticCenterWorldAU[0],
      y: galacticCenterWorldAU[1],
      z: galacticCenterWorldAU[2],
    },
  },
  sourceGrid: { width: image.width, height: image.height },
  downsampleGrid: {
    width: OUT_W,
    height: OUT_H,
    baseWidth: BASE_OUT_W,
    baseHeight: BASE_OUT_H,
    scale: GRID_SCALE,
  },
  sourcePixelsPerDustCell: { width: blockW, height: blockH },
  strideFloat32: DUST_FLOATS,
  legacyDirectionVectorScaleAU: SHELL_RADIUS_AU,
  cellCount: out.length / DUST_FLOATS,
  ebvPercentiles: { p95, p99 },
  notes: [
    "This is a 2D total line-of-sight Galactic reddening source, not a distance-resolved 3D dust cube.",
    "The runtime layer projects the public reddening directions into galaxy-scale disk cloud positions, so the visible layer is not a dust shell around the Sun.",
    "Raw FITS is cached locally under public/cache/nasa and ignored by git; generated binary is the runtime asset.",
  ],
};
writeFileSync(OUT_META, `${JSON.stringify(meta, null, 2)}\n`);
writeFileSync(OUT_CACHE_META, `${JSON.stringify(meta, null, 2)}\n`);

console.log(`Written ${out.length / DUST_FLOATS} dust cells -> ${OUT_BIN}`);
console.log(`Runtime dust layer size: ${(out.byteLength / 1024).toFixed(1)} KiB`);

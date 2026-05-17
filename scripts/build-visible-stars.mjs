import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const STAR_FLOATS = 8;
const AU_PER_PARSEC = 80;
const SOLAR_RADIUS_AU = 0.00465047;
const SUN_ABSOLUTE_V_MAG = 4.83;
const SUN_TEMPERATURE_K = 5778;
const MAX_STARS = 100_000;
const STAR_DEDUPE_POSITION_TOLERANCE_PC = 0.05 / AU_PER_PARSEC;
const HYG_URL = "https://astronexus.com/downloads/catalogs/hygdata_v42.csv.gz";
const OUT_BIN = new URL("../public/data/visible-stars-100k.bin", import.meta.url);
const OUT_META = new URL("../public/data/visible-stars-100k.meta.json", import.meta.url);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "\"") {
      if (quoted && next === "\"") {
        cell += "\"";
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some(value => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function numberOrNull(value) {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeName(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function equatorialPositionPc(ra, dec, distancePc) {
  const r = ra * Math.PI / 180;
  const dc = dec * Math.PI / 180;
  return {
    x: distancePc * Math.cos(dc) * Math.cos(r),
    y: distancePc * Math.cos(dc) * Math.sin(r),
    z: distancePc * Math.sin(dc),
  };
}

async function nearbyAnchorReference() {
  const source = await readFile(new URL("../src/catalog/nearby-stars.ts", import.meta.url), "utf8");
  const keys = new Set();
  const positions = [];
  for (const match of source.matchAll(/s\("([^"]+)",\s*([-0-9.]+),\s*([-0-9.]+),\s*([-0-9.]+),/g)) {
    const [, name, ra, dec, distancePc] = match;
    const full = normalizeName(name);
    if (full) keys.add(full);
    const withoutParenthetical = normalizeName(name.replace(/\([^)]*\)/g, " "));
    if (withoutParenthetical) keys.add(withoutParenthetical);
    for (const match of name.matchAll(/\(([^)]+)\)/g)) {
      const parenthetical = normalizeName(match[1]);
      if (parenthetical) keys.add(parenthetical);
    }
    positions.push(equatorialPositionPc(Number(ra), Number(dec), Number(distancePc)));
  }
  return { keys, positions };
}

function rowNameKeys(row, col) {
  return [
    row[col.proper],
    row[col.bayer],
    row[col.flam],
    row[col.bf],
    row[col.gl],
  ]
    .filter(value => typeof value === "string" && value.trim().length > 0)
    .flatMap(value => {
      const normalized = normalizeName(value);
      const withoutLeadingNumber = normalizeName(value.replace(/^\d+/, ""));
      return normalized === withoutLeadingNumber
        ? [normalized]
        : [normalized, withoutLeadingNumber];
    });
}

function apparentFluxFromMagnitude(mag) {
  // Relative visual flux with mag 6.0 as the naked-eye threshold reference.
  return Math.pow(10, -0.4 * (mag - 6.0));
}

function starDisplayFromMagnitude(mag) {
  const normalized = apparentFluxFromMagnitude(mag) / 260;
  return clamp(Math.pow(Math.max(normalized, 1e-8), 0.18), 0.035, 1);
}

function stellarTemperatureFromBv(ci) {
  const bv = clamp(ci ?? 0.65, -0.33, 2.0);
  return clamp(
    4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)),
    2400,
    42000,
  );
}

function luminosityFromAbsoluteMagnitude(absMag) {
  return Math.pow(10, -0.4 * (absMag - SUN_ABSOLUTE_V_MAG));
}

function stellarRadiusSolar({ mag, dist, ci, absmag, lum }) {
  const absoluteMag = Number.isFinite(absmag)
    ? absmag
    : mag - 5 * Math.log10(dist / 10);
  const luminosity = Number.isFinite(lum) && lum > 0
    ? lum
    : luminosityFromAbsoluteMagnitude(absoluteMag);
  const temperature = stellarTemperatureFromBv(ci);
  const radius = Math.sqrt(Math.max(luminosity, 1e-8)) / Math.pow(temperature / SUN_TEMPERATURE_K, 2);
  return clamp(radius, 0.01, 1800);
}

function positionCell(value) {
  return Math.floor(value / STAR_DEDUPE_POSITION_TOLERANCE_PC);
}

function positionCellKey(ix, iy, iz) {
  return `${ix},${iy},${iz}`;
}

function addPosition(index, positions, star) {
  const key = positionCellKey(positionCell(star.x), positionCell(star.y), positionCell(star.z));
  const offset = positions.length;
  positions.push(star.x, star.y, star.z);
  const bucket = index.get(key);
  if (bucket) bucket.push(offset);
  else index.set(key, [offset]);
}

function hasDuplicatePosition(index, positions, star) {
  const ix = positionCell(star.x);
  const iy = positionCell(star.y);
  const iz = positionCell(star.z);
  const toleranceSq = STAR_DEDUPE_POSITION_TOLERANCE_PC * STAR_DEDUPE_POSITION_TOLERANCE_PC;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dz = -1; dz <= 1; dz++) {
        const bucket = index.get(positionCellKey(ix + dx, iy + dy, iz + dz));
        if (!bucket) continue;
        for (const offset of bucket) {
          const x = positions[offset];
          const y = positions[offset + 1];
          const z = positions[offset + 2];
          const distSq = (star.x - x) ** 2 + (star.y - y) ** 2 + (star.z - z) ** 2;
          if (distSq <= toleranceSq) return true;
        }
      }
    }
  }

  return false;
}

/**
 * B-V Johnson color index → linear sRGB.
 * Uses subtle O/B, A/F, G, K, and M anchors. Input `ci` is the B-V color
 * index from the HYG catalog.
 */
function starColor(ci) {
  const keys = [
    [-0.33, [0.65, 0.75, 1.00]], // O/B — hot blue-white
    [ 0.00, [0.90, 0.95, 1.00]], // A   — blue-white
    [ 0.30, [0.94, 0.96, 1.00]], // F   — near-white, cool cast
    [ 0.65, [1.00, 0.92, 0.75]], // G   — white-yellow
    [ 1.00, [1.00, 0.65, 0.35]], // K   — orange
    [ 1.60, [1.00, 0.35, 0.20]], // M   — red-orange
  ];
  const bv = Math.max(-0.33, Math.min(1.60, ci ?? 0.65));
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, c0] = keys[i];
    const [t1, c1] = keys[i + 1];
    if (bv <= t1) {
      const k = (bv - t0) / (t1 - t0);
      return [c0[0]+(c1[0]-c0[0])*k, c0[1]+(c1[1]-c0[1])*k, c0[2]+(c1[2]-c0[2])*k];
    }
  }
  return [1.00, 0.35, 0.20];
}

const response = await fetch(HYG_URL);
if (!response.ok) throw new Error(`HYG download returned HTTP ${response.status}`);

const gz = Buffer.from(await response.arrayBuffer());
const csv = gunzipSync(gz).toString("utf8");
const rows = parseCsv(csv);
const header = rows.shift();
if (!header) throw new Error("HYG CSV is empty.");

const col = Object.fromEntries(header.map((name, index) => [name.replaceAll("\"", ""), index]));
const nearbyAnchors = await nearbyAnchorReference();
const nearbyAnchorKeys = nearbyAnchors.keys;
let excludedNearbyAnchorRows = 0;
const excludedNearbyAnchorPositions = [...nearbyAnchors.positions];
const stars = rows.map(row => {
  const isNearbyAnchor = rowNameKeys(row, col).some(key => nearbyAnchorKeys.has(key));
  if (isNearbyAnchor) {
    const x = numberOrNull(row[col.x]);
    const y = numberOrNull(row[col.y]);
    const z = numberOrNull(row[col.z]);
    if (x !== null && y !== null && z !== null) {
      excludedNearbyAnchorPositions.push({ x, y, z });
    }
    excludedNearbyAnchorRows++;
    return null;
  }
  const x = numberOrNull(row[col.x]);
  const y = numberOrNull(row[col.y]);
  const z = numberOrNull(row[col.z]);
  const dist = numberOrNull(row[col.dist]);
  const mag = numberOrNull(row[col.mag]);
  const ci = numberOrNull(row[col.ci]);
  const absmag = numberOrNull(row[col.absmag]);
  const lum = numberOrNull(row[col.lum]);
  if (x === null || y === null || z === null || dist === null || mag === null) return null;
  if (dist <= 0 || dist >= 1000) return null;
  return { x, y, z, dist, mag, ci, absmag, lum };
}).filter(Boolean);

stars.sort((a, b) => (a.dist - b.dist) || (a.mag - b.mag));
const selected = [];
const positionIndex = new Map();
const positions = [];
for (const anchor of excludedNearbyAnchorPositions) {
  addPosition(positionIndex, positions, anchor);
}
let duplicatePositionRows = 0;
for (const star of stars) {
  if (hasDuplicatePosition(positionIndex, positions, star)) {
    duplicatePositionRows++;
    continue;
  }
  addPosition(positionIndex, positions, star);
  selected.push(star);
  if (selected.length >= MAX_STARS) break;
}
const data = new Float32Array(selected.length * STAR_FLOATS);

for (let i = 0; i < selected.length; i++) {
  const star = selected[i];
  const brightness = starDisplayFromMagnitude(star.mag);
  const color = starColor(star.ci);
  const radiusSolar = stellarRadiusSolar(star);
  const o = i * STAR_FLOATS;
  data[o + 0] = star.x * AU_PER_PARSEC;
  data[o + 1] = star.y * AU_PER_PARSEC;
  data[o + 2] = star.z * AU_PER_PARSEC;
  data[o + 3] = radiusSolar * SOLAR_RADIUS_AU;
  data[o + 4] = color[0];
  data[o + 5] = color[1];
  data[o + 6] = color[2];
  data[o + 7] = 0.08 + Math.pow(brightness, 0.92) * 0.82;
}

await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(OUT_BIN, Buffer.from(data.buffer), "binary");
await writeFile(OUT_META, `${JSON.stringify({
  source: "HYG 4.2",
  sourceUrl: HYG_URL,
  license: "CC BY-SA 4.0",
  selectedStars: selected.length,
  inputStars: stars.length,
  excludedNearbyAnchorRows,
  duplicatePositionRows,
  dedupeTolerancePc: STAR_DEDUPE_POSITION_TOLERANCE_PC,
  strideFloat32: STAR_FLOATS,
  coordinateScale: `${AU_PER_PARSEC} visual AU per parsec`,
  selectionEncoding: "Nearest HYG stars after named-anchor and position de-duplication; apparent V magnitude used only as a tie-breaker",
  brightnessEncoding: "Johnson V apparent magnitude flux, relative to mag 6, compressed for display",
  radiusEncoding: "Solar radii inferred from HYG luminosity/absolute magnitude and B-V temperature, stored as AU",
}, null, 2)}\n`, "utf8");

console.log(`Wrote ${selected.length} visible stars to ${OUT_BIN.pathname}`);

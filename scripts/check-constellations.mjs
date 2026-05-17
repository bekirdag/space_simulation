import { readFileSync } from "node:fs";

const STAR_FLOATS = 8;
const STAR_CACHE_FLOATS = 6;
const MAX_SNAP_ERROR_DEG = 0.75;
const EXPECTED_IAU_IDS = [
  "And", "Ant", "Aps", "Aqr", "Aql", "Ara", "Ari", "Aur",
  "Boo", "Cae", "Cam", "Cnc", "CVn", "CMa", "CMi", "Cap",
  "Car", "Cas", "Cen", "Cep", "Cet", "Cha", "Cir", "Col",
  "Com", "CrA", "CrB", "Crv", "Crt", "Cru", "Cyg", "Del",
  "Dor", "Dra", "Equ", "Eri", "For", "Gem", "Gru", "Her",
  "Hor", "Hya", "Hyi", "Ind", "Lac", "Leo", "LMi", "Lep",
  "Lib", "Lup", "Lyn", "Lyr", "Men", "Mic", "Mon", "Mus",
  "Nor", "Oct", "Oph", "Ori", "Pav", "Peg", "Per", "Phe",
  "Pic", "Psc", "PsA", "Pup", "Pyx", "Ret", "Sge", "Sgr",
  "Sco", "Scl", "Sct", "Ser", "Sex", "Tau", "Tel", "Tri",
  "TrA", "Tuc", "UMa", "UMi", "Vel", "Vir", "Vol", "Vul",
];

function fail(message) {
  console.error(`Constellation check failed: ${message}`);
  process.exitCode = 1;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadFloat32(path) {
  const buffer = readFileSync(path);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

function directionFromLonLat(lonDeg, latDeg) {
  const lon = lonDeg * Math.PI / 180;
  const lat = latDeg * Math.PI / 180;
  const cosLat = Math.cos(lat);
  return [
    cosLat * Math.cos(lon),
    cosLat * Math.sin(lon),
    Math.sin(lat),
  ];
}

function buildStarCache(stars) {
  const out = [];
  for (let offset = 0; offset < stars.length; offset += STAR_FLOATS) {
    const x = stars[offset + 0];
    const y = stars[offset + 1];
    const z = stars[offset + 2];
    const distance = Math.hypot(x, y, z);
    if (!Number.isFinite(distance) || distance <= 0) continue;
    out.push(x, y, z, x / distance, y / distance, z / distance);
  }
  return new Float32Array(out);
}

function closestSnapErrorDeg(coord, starCache) {
  const [tx, ty, tz] = directionFromLonLat(coord[0], coord[1]);
  let bestDot = -2;
  for (let offset = 0; offset < starCache.length; offset += STAR_CACHE_FLOATS) {
    const dot =
      starCache[offset + 3] * tx +
      starCache[offset + 4] * ty +
      starCache[offset + 5] * tz;
    if (dot > bestDot) bestDot = dot;
  }
  const clampedDot = Math.max(-1, Math.min(1, bestDot));
  return Math.acos(clampedDot) * 180 / Math.PI;
}

function isLonLat(value) {
  return Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]);
}

function unique(values) {
  return [...new Set(values)];
}

const lines = loadJson("public/cache/nasa/constellations-lines.geojson");
const names = loadJson("public/cache/nasa/constellations-names.geojson");
const starNames = loadJson("public/cache/nasa/constellation-stars.json");
const stars = loadFloat32("public/data/visible-stars-100k.bin");
const starCache = buildStarCache(stars);

const lineIds = unique((lines.features ?? []).map(feature => feature.id).filter(Boolean)).sort();
const nameIds = unique((names.features ?? []).map(feature => feature.id).filter(Boolean)).sort();
const expectedIds = [...EXPECTED_IAU_IDS].sort();

const missingLines = expectedIds.filter(id => !lineIds.includes(id));
const missingNames = expectedIds.filter(id => !nameIds.includes(id));
const extraLines = lineIds.filter(id => !expectedIds.includes(id));
const extraNames = nameIds.filter(id => !expectedIds.includes(id));
if (missingLines.length) fail(`missing line IDs: ${missingLines.join(", ")}`);
if (missingNames.length) fail(`missing name IDs: ${missingNames.join(", ")}`);
if (extraLines.length) fail(`unexpected line IDs: ${extraLines.join(", ")}`);
if (extraNames.length) fail(`unexpected name IDs: ${extraNames.join(", ")}`);

const orionName = (names.features ?? []).find(feature => feature.id === "Ori")?.properties?.name;
if (orionName !== "Orion") fail(`Ori label resolved to ${JSON.stringify(orionName)}, expected "Orion"`);
if (starNames.stars?.["88.7929,7.4071"]?.name !== "Betelgeuse") {
  fail("Orion endpoint 88.7929,7.4071 should resolve to Betelgeuse in constellation-stars.json");
}
if (starNames.stars?.["78.6345,-8.2016"]?.name !== "Rigel") {
  fail("Orion endpoint 78.6345,-8.2016 should resolve to Rigel in constellation-stars.json");
}

let featureCount = 0;
let segmentCount = 0;
let endpointCount = 0;
let maxSnapError = 0;
const looseEndpoints = [];
const missingStarNames = [];

for (const feature of lines.features ?? []) {
  if (feature.geometry?.type !== "MultiLineString") continue;
  if (!Array.isArray(feature.geometry.coordinates)) continue;
  featureCount++;

  for (const stroke of feature.geometry.coordinates) {
    if (!Array.isArray(stroke)) continue;
    for (let index = 0; index < stroke.length - 1; index++) {
      const a = stroke[index];
      const b = stroke[index + 1];
      if (!isLonLat(a) || !isLonLat(b)) continue;
      segmentCount++;
      for (const coord of [a, b]) {
        endpointCount++;
        const key = `${coord[0].toFixed(4)},${coord[1].toFixed(4)}`;
        if (!starNames.stars?.[key]?.name) missingStarNames.push({ id: feature.id, key });
        const error = closestSnapErrorDeg(coord, starCache);
        maxSnapError = Math.max(maxSnapError, error);
        if (error > MAX_SNAP_ERROR_DEG) {
          looseEndpoints.push({
            id: feature.id,
            lon: coord[0],
            lat: coord[1],
            error,
          });
        }
      }
    }
  }
}

if (featureCount !== 89) fail(`expected 89 constellation figures including Serpens halves, got ${featureCount}`);
if (segmentCount <= 0) fail("no constellation line segments found");
if (missingStarNames.length) {
  fail(`${missingStarNames.length} constellation endpoints have no star-label cache entry`);
  console.table(missingStarNames.slice(0, 12));
}
if (looseEndpoints.length) {
  fail(`${looseEndpoints.length} endpoints exceed ${MAX_SNAP_ERROR_DEG} deg snap tolerance`);
  console.table(looseEndpoints.slice(0, 12));
}

if (process.exitCode) process.exit(process.exitCode);

console.log(
  `Constellations OK: ${lineIds.length} IAU IDs, ${featureCount} figures, ` +
  `${segmentCount} segments, ${endpointCount} snapped endpoints, max snap error ${maxSnapError.toFixed(3)} deg.`,
);
console.log("Orion OK: present as Ori / Orion with validated line endpoints.");

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const MAX_STARS = 100_000;
const HYG_URL = "https://astronexus.com/downloads/catalogs/hygdata_v42.csv.gz";
const LINES_URL = new URL("../public/cache/nasa/constellations-lines.geojson", import.meta.url);
const OUT_JSON = new URL("../public/cache/nasa/constellation-stars.json", import.meta.url);

const GREEK = new Map(Object.entries({
  Alp: "Alpha",
  Bet: "Beta",
  Gam: "Gamma",
  Del: "Delta",
  Eps: "Epsilon",
  Zet: "Zeta",
  Eta: "Eta",
  The: "Theta",
  Iot: "Iota",
  Kap: "Kappa",
  Lam: "Lambda",
  Mu: "Mu",
  Nu: "Nu",
  Xi: "Xi",
  Omi: "Omicron",
  Pi: "Pi",
  Rho: "Rho",
  Sig: "Sigma",
  Tau: "Tau",
  Ups: "Upsilon",
  Phi: "Phi",
  Chi: "Chi",
  Psi: "Psi",
  Ome: "Omega",
}));

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

function coordKey(coord) {
  return `${coord[0].toFixed(4)},${coord[1].toFixed(4)}`;
}

function isLonLat(value) {
  return Array.isArray(value)
    && value.length >= 2
    && Number.isFinite(value[0])
    && Number.isFinite(value[1]);
}

function normalizeBayer(value) {
  if (!value) return "";
  const [prefix, suffix = ""] = value.split("-", 2);
  const greek = GREEK.get(prefix) ?? prefix;
  return suffix ? `${greek}-${suffix}` : greek;
}

function starName(star) {
  if (star.proper) return star.proper;

  const bayer = normalizeBayer(star.bayer);
  if (star.flam && bayer && star.con) return `${star.flam} ${bayer} ${star.con}`;
  if (bayer && star.con) return `${bayer} ${star.con}`;
  if (star.flam && star.con) return `${star.flam} ${star.con}`;
  if (star.hr) return `HR ${star.hr}`;
  if (star.hd) return `HD ${star.hd}`;
  if (star.hip) return `HIP ${star.hip}`;
  return "Constellation star";
}

function catalogIds(star) {
  return [
    star.hip ? `HIP ${star.hip}` : "",
    star.hd ? `HD ${star.hd}` : "",
    star.hr ? `HR ${star.hr}` : "",
  ].filter(Boolean).join(" · ");
}

function closestCatalogStar(coord, stars) {
  const [tx, ty, tz] = directionFromLonLat(coord[0], coord[1]);
  let best = stars[0];
  let bestDot = -2;

  for (const star of stars) {
    const dot = star.ux * tx + star.uy * ty + star.uz * tz;
    if (dot > bestDot) {
      bestDot = dot;
      best = star;
    }
  }

  return best;
}

async function loadHygStars() {
  const response = await fetch(HYG_URL);
  if (!response.ok) throw new Error(`HYG download returned HTTP ${response.status}`);

  const csv = gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8");
  const rows = parseCsv(csv);
  const header = rows.shift();
  if (!header) throw new Error("HYG CSV is empty.");

  const col = Object.fromEntries(header.map((name, index) => [name.replaceAll("\"", ""), index]));
  const stars = rows.map(row => {
    const x = numberOrNull(row[col.x]);
    const y = numberOrNull(row[col.y]);
    const z = numberOrNull(row[col.z]);
    const dist = numberOrNull(row[col.dist]);
    const mag = numberOrNull(row[col.mag]);
    if (x === null || y === null || z === null || dist === null || mag === null) return null;
    if (dist <= 0 || dist >= 1000) return null;
    const distance = Math.hypot(x, y, z);
    if (!Number.isFinite(distance) || distance <= 0) return null;
    return {
      x,
      y,
      z,
      ux: x / distance,
      uy: y / distance,
      uz: z / distance,
      dist,
      mag,
      proper: row[col.proper] ?? "",
      bayer: row[col.bayer] ?? "",
      flam: row[col.flam] ?? "",
      con: row[col.con] ?? "",
      hip: row[col.hip] ?? "",
      hd: row[col.hd] ?? "",
      hr: row[col.hr] ?? "",
      score: mag + Math.log10(dist + 1) * 1.15,
    };
  }).filter(Boolean);

  stars.sort((a, b) => a.score - b.score);
  return stars.slice(0, MAX_STARS);
}

const [lineText, stars] = await Promise.all([
  readFile(LINES_URL, "utf8"),
  loadHygStars(),
]);
const lines = JSON.parse(lineText);
const uniqueCoords = new Map();

for (const feature of lines.features ?? []) {
  if (feature.geometry?.type !== "MultiLineString") continue;
  if (!Array.isArray(feature.geometry.coordinates)) continue;
  for (const stroke of feature.geometry.coordinates) {
    if (!Array.isArray(stroke)) continue;
    for (const coord of stroke) {
      if (!isLonLat(coord)) continue;
      uniqueCoords.set(coordKey(coord), coord);
    }
  }
}

const starNames = {};
for (const [key, coord] of uniqueCoords) {
  const star = closestCatalogStar(coord, stars);
  starNames[key] = {
    name: starName(star),
    catalog: catalogIds(star),
    magnitude: star.mag,
  };
}

await mkdir(new URL("../public/cache/nasa/", import.meta.url), { recursive: true });
await writeFile(OUT_JSON, `${JSON.stringify({
  schema: "cosmosmap.constellation-stars.v1",
  source: "HYG 4.2 visible-star names snapped to d3-celestial constellation endpoints",
  sourceUrl: HYG_URL,
  license: "CC BY-SA 4.0",
  coordinateKey: "raDeg.toFixed(4),decDeg.toFixed(4)",
  selectedStars: stars.length,
  endpointStars: Object.keys(starNames).length,
  stars: starNames,
}, null, 2)}\n`, "utf8");

console.log(`Wrote ${Object.keys(starNames).length} constellation star labels to ${OUT_JSON.pathname}`);

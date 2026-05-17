import { mkdir, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

const STAR_FLOATS = 8;
const AU_PER_PARSEC = 80;
const MAX_STARS = 100_000;
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
const stars = rows.map(row => {
  const x = numberOrNull(row[col.x]);
  const y = numberOrNull(row[col.y]);
  const z = numberOrNull(row[col.z]);
  const dist = numberOrNull(row[col.dist]);
  const mag = numberOrNull(row[col.mag]);
  const ci = numberOrNull(row[col.ci]);
  if (x === null || y === null || z === null || dist === null || mag === null) return null;
  if (dist <= 0 || dist >= 1000) return null;
  return {
    x, y, z, dist, mag, ci,
    score: mag + Math.log10(dist + 1) * 1.15,
  };
}).filter(Boolean);

stars.sort((a, b) => a.score - b.score);
const selected = stars.slice(0, MAX_STARS);
const data = new Float32Array(selected.length * STAR_FLOATS);

for (let i = 0; i < selected.length; i++) {
  const star = selected[i];
  const brightness = clamp((12 - star.mag) / 10, 0.05, 1);
  const color = starColor(star.ci);
  const o = i * STAR_FLOATS;
  data[o + 0] = star.x * AU_PER_PARSEC;
  data[o + 1] = star.y * AU_PER_PARSEC;
  data[o + 2] = star.z * AU_PER_PARSEC;
  data[o + 3] = 0.1 + brightness * brightness * 0.8;
  data[o + 4] = color[0];
  data[o + 5] = color[1];
  data[o + 6] = color[2];
  data[o + 7] = 0.12 + brightness * 0.68;
}

await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(OUT_BIN, Buffer.from(data.buffer), "binary");
await writeFile(OUT_META, `${JSON.stringify({
  source: "HYG 4.2",
  sourceUrl: HYG_URL,
  license: "CC BY-SA 4.0",
  selectedStars: selected.length,
  inputStars: stars.length,
  strideFloat32: STAR_FLOATS,
  coordinateScale: `${AU_PER_PARSEC} visual AU per parsec`,
}, null, 2)}\n`, "utf8");

console.log(`Wrote ${selected.length} visible stars to ${OUT_BIN.pathname}`);

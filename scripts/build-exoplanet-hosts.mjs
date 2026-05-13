import { mkdir, writeFile } from "node:fs/promises";

const OUT_PATH = new URL("../public/data/exoplanet-hosts.json", import.meta.url);
const ARCHIVE_URL = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";

const query = `
select
  hostname,
  min(ra) as ra,
  min(dec) as dec,
  min(sy_dist) as sy_dist,
  min(sy_vmag) as sy_vmag,
  count(pl_name) as planet_count
from pscomppars
where ra is not null and dec is not null
group by hostname
order by hostname
`.trim().replace(/\s+/g, " ");

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

const params = new URLSearchParams({ query, format: "csv" });
const response = await fetch(`${ARCHIVE_URL}?${params.toString()}`);
if (!response.ok) throw new Error(`NASA Exoplanet Archive returned HTTP ${response.status}`);

const csv = await response.text();
const rows = parseCsv(csv);
const header = rows.shift();
if (!header) throw new Error("Exoplanet Archive returned an empty CSV.");

const col = Object.fromEntries(header.map((name, index) => [name, index]));
const records = rows.map(row => ({
  name: row[col.hostname] ?? "",
  ra: numberOrNull(row[col.ra]),
  dec: numberOrNull(row[col.dec]),
  distancePc: numberOrNull(row[col.sy_dist]),
  magnitude: numberOrNull(row[col.sy_vmag]),
  planetCount: numberOrNull(row[col.planet_count]),
})).filter(record => record.name && record.ra !== null && record.dec !== null);

await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(OUT_PATH, `${JSON.stringify(records, null, 2)}\n`, "utf8");
console.log(`Wrote ${records.length} exoplanet host stars to ${OUT_PATH.pathname}`);

import { mkdir, writeFile } from "node:fs/promises";
import { canonicalHostKey } from "./exoplanet-host-key.mjs";

const HOST_OUT_PATH = new URL("../public/data/exoplanet-hosts.json", import.meta.url);
const PLANET_OUT_PATH = new URL("../public/data/exoplanets.json", import.meta.url);
const ARCHIVE_URL = "https://exoplanetarchive.ipac.caltech.edu/TAP/sync";

const hostQuery = `
select
  hostname,
  min(ra) as ra,
  min(dec) as dec,
  min(sy_dist) as sy_dist,
  min(sy_vmag) as sy_vmag,
  min(st_teff) as st_teff,
  min(st_spectype) as st_spectype,
  min(st_rad) as st_rad,
  min(st_lum) as st_lum,
  count(pl_name) as planet_count
from pscomppars
where ra is not null and dec is not null
group by hostname
order by hostname
`.trim().replace(/\s+/g, " ");

const planetQuery = `
select
  hostname,
  pl_name,
  pl_orbsmax,
  pl_orbper,
  pl_rade,
  pl_bmasse
from pscomppars
where hostname is not null and pl_name is not null and ra is not null and dec is not null
order by hostname, pl_orbsmax, pl_orbper, pl_name
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

async function archiveCsv(query) {
  const params = new URLSearchParams({ query, format: "csv" });
  const response = await fetch(`${ARCHIVE_URL}?${params.toString()}`);
  if (!response.ok) throw new Error(`NASA Exoplanet Archive returned HTTP ${response.status}`);

  const rows = parseCsv(await response.text());
  const header = rows.shift();
  if (!header) throw new Error("Exoplanet Archive returned an empty CSV.");
  return {
    col: Object.fromEntries(header.map((name, index) => [name, index])),
    rows,
  };
}

const hostCsv = await archiveCsv(hostQuery);
const hostRecords = hostCsv.rows.map(row => ({
  name: row[hostCsv.col.hostname] ?? "",
  ra: numberOrNull(row[hostCsv.col.ra]),
  dec: numberOrNull(row[hostCsv.col.dec]),
  distancePc: numberOrNull(row[hostCsv.col.sy_dist]),
  magnitude: numberOrNull(row[hostCsv.col.sy_vmag]),
  temperatureK: numberOrNull(row[hostCsv.col.st_teff]),
  spectralType: row[hostCsv.col.st_spectype] || null,
  radiusSolar: numberOrNull(row[hostCsv.col.st_rad]),
  luminosityLogSolar: numberOrNull(row[hostCsv.col.st_lum]),
  planetCount: numberOrNull(row[hostCsv.col.planet_count]),
})).filter(record => record.name && record.ra !== null && record.dec !== null);

const mappedHostKeys = new Set(hostRecords.map(record => canonicalHostKey(record.name)));

const planetCsv = await archiveCsv(planetQuery);
const rawPlanetRecords = planetCsv.rows.map(row => ({
  name: row[planetCsv.col.pl_name] ?? "",
  hostName: row[planetCsv.col.hostname] ?? "",
  semiMajorAU: numberOrNull(row[planetCsv.col.pl_orbsmax]),
  periodDays: numberOrNull(row[planetCsv.col.pl_orbper]),
  radiusEarth: numberOrNull(row[planetCsv.col.pl_rade]),
  massEarth: numberOrNull(row[planetCsv.col.pl_bmasse]),
})).filter(record => record.name && record.hostName);
const planetRecords = rawPlanetRecords.filter(record => mappedHostKeys.has(canonicalHostKey(record.hostName)));
const skippedPlanetCount = rawPlanetRecords.length - planetRecords.length;
if (skippedPlanetCount > 0) {
  console.warn(`Skipped ${skippedPlanetCount} exoplanet rows whose host stars do not have mappable RA/Dec coordinates.`);
}

const missingHostNames = [...new Set(planetRecords.map(record => record.hostName))]
  .filter(hostName => !mappedHostKeys.has(canonicalHostKey(hostName)));
if (missingHostNames.length > 0) {
  throw new Error(`Exoplanet host coverage check failed for: ${missingHostNames.slice(0, 20).join(", ")}`);
}

await mkdir(new URL("../public/data/", import.meta.url), { recursive: true });
await writeFile(HOST_OUT_PATH, `${JSON.stringify(hostRecords, null, 2)}\n`, "utf8");
await writeFile(PLANET_OUT_PATH, `${JSON.stringify(planetRecords, null, 2)}\n`, "utf8");
console.log(`Wrote ${hostRecords.length} exoplanet host stars to ${HOST_OUT_PATH.pathname}`);
console.log(`Wrote ${planetRecords.length} exoplanets to ${PLANET_OUT_PATH.pathname}`);

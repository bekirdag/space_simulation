#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api";
const CACHE_SCHEMA = "celestia.horizons.v1";
const OUT_DIR = join(process.cwd(), "public", "cache", "horizons");
const D2Y = 365.25;

const TARGETS = [
  ["Sun", "10"],
  ["Mercury", "199"],
  ["Venus", "299"],
  ["Earth", "399"],
  ["Mars", "499"],
  ["Jupiter", "599"],
  ["Saturn", "699"],
  ["Uranus", "799"],
  ["Neptune", "899"],
  ["Moon", "301"],
  ["Io", "501"],
  ["Europa", "502"],
  ["Ganymede", "503"],
  ["Callisto", "504"],
  ["Mimas", "601"],
  ["Enceladus", "602"],
  ["Tethys", "603"],
  ["Dione", "604"],
  ["Rhea", "605"],
  ["Titan", "606"],
  ["Iapetus", "608"],
  ["Miranda", "705"],
  ["Ariel", "701"],
  ["Umbriel", "702"],
  ["Titania", "703"],
  ["Oberon", "704"],
  ["Triton", "801"],
  ["Pluto", "999"],
  ["Charon", "901"],
  ["Ceres", "1;"],
  ["Eris", "136199;"],
  ["Haumea", "136108;"],
  ["Makemake", "136472;"],
];

function utcDateStr(date) {
  return date.toISOString().slice(0, 10);
}

function normalizeDate(input) {
  if (!input) return utcDateStr(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error(`Expected date as YYYY-MM-DD, got "${input}".`);
  }
  return input;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextUtcDate(dateStr) {
  const next = new Date(`${dateStr}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return utcDateStr(next);
}

function parseVector(name, text) {
  const i0 = text.indexOf("$$SOE");
  const i1 = text.indexOf("$$EOE");
  if (i0 === -1 || i1 === -1) throw new Error(`No ephemeris for ${name}`);

  const lines = text.slice(i0 + 5, i1).split("\n").filter(line => line.trim());
  const posLine = lines.find(line => /\bX\s*=/.test(line) && /\bY\s*=/.test(line) && /\bZ\s*=/.test(line) && !/\bVX\s*=/.test(line));
  const velLine = lines.find(line => /\bVX\s*=/.test(line) && /\bVY\s*=/.test(line) && /\bVZ\s*=/.test(line));
  if (!posLine || !velLine) throw new Error(`No vectors for ${name}`);

  const nums = line => [...line.matchAll(/([-+]?\d+\.\d+[Ee][+-]\d+)/g)].map(match => Number.parseFloat(match[1]));
  const p = nums(posLine);
  const v = nums(velLine);
  if (p.length < 3 || v.length < 3) throw new Error(`Incomplete data for ${name}`);

  return {
    name,
    x: p[0], y: p[1], z: p[2],
    vx: v[0] * D2Y, vy: v[1] * D2Y, vz: v[2] * D2Y,
  };
}

async function fetchTarget([name, command], dateStr) {
  const params = new URLSearchParams({
    format: "json",
    COMMAND: command,
    OBJ_DATA: "NO",
    MAKE_EPHEM: "YES",
    EPHEM_TYPE: "VECTORS",
    CENTER: "500@0",
    START_TIME: dateStr,
    STOP_TIME: nextUtcDate(dateStr),
    STEP_SIZE: "1d",
    OUT_UNITS: "AU-D",
    TIME_TYPE: "UT",
    TIME_DIGITS: "SECONDS",
    REF_PLANE: "ECLIPTIC",
    REF_SYSTEM: "ICRF",
    VEC_TABLE: "2",
    VEC_LABELS: "YES",
  });

  const url = `${HORIZONS}?${params}`;
  let response = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    response = await fetch(url);
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) break;
    await delay(650 * 2 ** attempt);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json.code && json.code !== "200") throw new Error(json.message ?? `API ${json.code}`);
  if (!json.result) throw new Error("Empty response");
  return parseVector(name, json.result);
}

async function mapLimit(items, limit, task) {
  const out = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      out[current] = await task(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function cacheDate(dateStr) {
  let loaded = 0;
  const vectors = [];
  const warnings = [];

  await mapLimit(TARGETS, 2, async (target) => {
    try {
      const vector = await fetchTarget(target, dateStr);
      vectors.push(vector);
    } catch (error) {
      warnings.push(`${target[0]}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      loaded++;
      process.stdout.write(`\r${dateStr}: ${loaded}/${TARGETS.length}`);
    }
  });
  process.stdout.write("\n");

  vectors.sort((a, b) => TARGETS.findIndex(target => target[0] === a.name) - TARGETS.findIndex(target => target[0] === b.name));

  const snapshot = {
    schema: CACHE_SCHEMA,
    date: dateStr,
    fetchedAt: new Date().toISOString(),
    source: "NASA/JPL Horizons API",
    frame: {
      center: "500@0",
      centerName: "Solar System Barycenter",
      refPlane: "ECLIPTIC",
      refSystem: "ICRF",
      units: "AU, AU/yr",
    },
    vectors,
    warnings,
    targetCount: TARGETS.length,
  };

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `${dateStr}.json`);
  await writeFile(outFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`Wrote ${outFile} (${vectors.length}/${TARGETS.length} vectors, ${warnings.length} warnings).`);

  if (warnings.length > 0 || vectors.length !== TARGETS.length) {
    process.exitCode = 1;
  }
}

const dates = process.argv.slice(2).map(normalizeDate);
if (dates.length === 0) dates.push(normalizeDate());

for (const dateStr of dates) {
  await cacheDate(dateStr);
}

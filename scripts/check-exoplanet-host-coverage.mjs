import { readFile } from "node:fs/promises";
import { canonicalHostKey } from "./exoplanet-host-key.mjs";

const HOST_IN_PATH = new URL("../public/data/exoplanet-hosts.json", import.meta.url);
const PLANET_IN_PATH = new URL("../public/data/exoplanets.json", import.meta.url);

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

const [hostRecords, planetRecords] = await Promise.all([
  readFile(HOST_IN_PATH, "utf8").then(JSON.parse),
  readFile(PLANET_IN_PATH, "utf8").then(JSON.parse),
]);

const mappedHosts = new Map();
const invalidHosts = [];
for (const host of hostRecords) {
  const key = canonicalHostKey(host.name);
  if (!key || !isFiniteNumber(host.ra) || !isFiniteNumber(host.dec)) {
    invalidHosts.push(host.name || "(unnamed host)");
    continue;
  }
  mappedHosts.set(key, host.name);
}

const missingHosts = new Map();
let missingPlanetCount = 0;
for (const planet of planetRecords) {
  const key = canonicalHostKey(planet.hostName);
  if (!key || !mappedHosts.has(key)) {
    missingHosts.set(key || "(missing host name)", planet.hostName || "(missing host name)");
    missingPlanetCount += 1;
  }
}

if (invalidHosts.length > 0 || missingHosts.size > 0) {
  if (invalidHosts.length > 0) {
    console.error(`Found ${invalidHosts.length} host records without mappable RA/Dec coordinates.`);
    console.error(invalidHosts.slice(0, 20).join("\n"));
  }
  if (missingHosts.size > 0) {
    console.error(`Found ${missingPlanetCount} exoplanets across ${missingHosts.size} hosts without mapped host stars.`);
    console.error([...missingHosts.values()].slice(0, 20).join("\n"));
  }
  process.exit(1);
}

const uniquePlanetHosts = new Set(planetRecords.map(planet => canonicalHostKey(planet.hostName)));
console.log(
  `All ${planetRecords.length} exoplanets are covered by ${mappedHosts.size} mapped host stars ` +
  `(${uniquePlanetHosts.size} unique planet hosts).`
);

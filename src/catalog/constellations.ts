export const CONSTELLATION_FLOATS = 4; // pos xyz + alpha

const CONSTELLATION_LINES_URL = "/cache/nasa/constellations-lines.geojson";
const CONSTELLATION_SKY_RADIUS_AU = 76_000; // outer edge of the 100k visible-star shell

type LonLat = [number, number];

interface ConstellationFeature {
  id?: string;
  properties?: { rank?: string | number };
  geometry?: {
    type?: string;
    coordinates?: unknown;
  };
}

interface ConstellationGeoJSON {
  features?: ConstellationFeature[];
}

export interface ConstellationLineLoad {
  data: Float32Array;
  source: string;
  featureCount: number;
  segmentCount: number;
}

function isLonLat(value: unknown): value is LonLat {
  return Array.isArray(value)
    && value.length >= 2
    && Number.isFinite(value[0])
    && Number.isFinite(value[1]);
}

function alphaForRank(rank: string | number | undefined): number {
  const n = Number(rank);
  if (n <= 1) return 0.54;
  if (n === 2) return 0.45;
  return 0.36;
}

function skyPos(lonDeg: number, latDeg: number): [number, number, number] {
  const lon = lonDeg * Math.PI / 180;
  const lat = latDeg * Math.PI / 180;
  const cosLat = Math.cos(lat);
  return [
    CONSTELLATION_SKY_RADIUS_AU * cosLat * Math.cos(lon),
    CONSTELLATION_SKY_RADIUS_AU * cosLat * Math.sin(lon),
    CONSTELLATION_SKY_RADIUS_AU * Math.sin(lat),
  ];
}

function pushVertex(out: number[], coord: LonLat, alpha: number): void {
  const [x, y, z] = skyPos(coord[0], coord[1]);
  out.push(x, y, z, alpha);
}

export async function loadConstellationLines(): Promise<ConstellationLineLoad> {
  const resp = await fetch(CONSTELLATION_LINES_URL, { cache: "force-cache" });
  if (!resp.ok) throw new Error(`Constellation cache returned HTTP ${resp.status}`);

  const json = await resp.json() as ConstellationGeoJSON;
  const vertices: number[] = [];
  let featureCount = 0;
  let segmentCount = 0;

  for (const feature of json.features ?? []) {
    if (feature.geometry?.type !== "MultiLineString") continue;
    if (!Array.isArray(feature.geometry.coordinates)) continue;
    featureCount++;

    const alpha = alphaForRank(feature.properties?.rank);
    for (const stroke of feature.geometry.coordinates) {
      if (!Array.isArray(stroke)) continue;
      for (let i = 0; i < stroke.length - 1; i++) {
        const a = stroke[i];
        const b = stroke[i + 1];
        if (!isLonLat(a) || !isLonLat(b)) continue;
        pushVertex(vertices, a, alpha);
        pushVertex(vertices, b, alpha);
        segmentCount++;
      }
    }
  }

  return {
    data: new Float32Array(vertices),
    source: "NASA SVS Deep Star Maps 2020 + cached J2000 constellation-line GeoJSON",
    featureCount,
    segmentCount,
  };
}

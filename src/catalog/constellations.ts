import { STAR_FLOATS, type StarSearchResult } from "./stars";

export const CONSTELLATION_FLOATS = 4; // pos xyz + alpha

const CONSTELLATION_LINES_URL = "/cache/nasa/constellations-lines.geojson";
const CONSTELLATION_NAMES_URL = "/cache/nasa/constellations-names.geojson";
const CONSTELLATION_STAR_NAMES_URL = "/cache/nasa/constellation-stars.json";
const VISIBLE_STAR_DATA_URL = "/data/visible-stars-100k.bin";
const STAR_CACHE_FLOATS = 6; // pos xyz + unit direction xyz
const LABEL_DISTANCE_SCALE = 1.035;
const LOOSE_SNAP_DEGREES = 0.75;
const CONSTELLATION_FOCUS_DISTANCE_FACTOR = 3.6;

type LonLat = [number, number];

interface ConstellationFeature {
  id?: string;
  properties?: {
    rank?: string | number;
    name?: string;
    en?: string;
    desig?: string;
  };
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
  figures: ConstellationFigure[];
  labels: ConstellationLabel[];
  source: string;
  featureCount: number;
  segmentCount: number;
  snappedEndpointCount: number;
  looseEndpointCount: number;
}

export interface ConstellationLabel {
  id: string;
  abbreviation: string;
  name: string;
  x: number;
  y: number;
  z: number;
  radius: number;
  rank: number;
  alpha: number;
}

export interface ConstellationStarLabel {
  id: string;
  name: string;
  x: number;
  y: number;
  z: number;
  alpha: number;
  magnitude?: number;
  catalog?: string;
}

export interface ConstellationFigure {
  id: string;
  abbreviation: string;
  name: string;
  data: Float32Array;
  label: ConstellationLabel;
  starLabels: ConstellationStarLabel[];
}

interface SnappedStar {
  key: string;
  x: number;
  y: number;
  z: number;
  distance: number;
  angularErrorDeg: number;
}

interface ConstellationStarName {
  name: string;
  catalog?: string;
  magnitude?: number;
}

interface ConstellationStarNameCache {
  stars?: Record<string, ConstellationStarName>;
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

function directionFromLonLat(lonDeg: number, latDeg: number): [number, number, number] {
  const lon = lonDeg * Math.PI / 180;
  const lat = latDeg * Math.PI / 180;
  const cosLat = Math.cos(lat);
  return [
    cosLat * Math.cos(lon),
    cosLat * Math.sin(lon),
    Math.sin(lat),
  ];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function coordKey(coord: LonLat): string {
  return `${coord[0].toFixed(4)},${coord[1].toFixed(4)}`;
}

function buildStarCache(stars: Float32Array): Float32Array {
  const count = Math.floor(stars.length / STAR_FLOATS);
  const cache = new Float32Array(count * STAR_CACHE_FLOATS);
  let written = 0;

  for (let i = 0; i < count; i++) {
    const src = i * STAR_FLOATS;
    const x = stars[src + 0]!;
    const y = stars[src + 1]!;
    const z = stars[src + 2]!;
    const distance = Math.hypot(x, y, z);
    if (!Number.isFinite(distance) || distance <= 0) continue;

    const dst = written * STAR_CACHE_FLOATS;
    cache[dst + 0] = x;
    cache[dst + 1] = y;
    cache[dst + 2] = z;
    cache[dst + 3] = x / distance;
    cache[dst + 4] = y / distance;
    cache[dst + 5] = z / distance;
    written++;
  }

  return written === count ? cache : cache.slice(0, written * STAR_CACHE_FLOATS);
}

function closestCatalogStar(coord: LonLat, starCache: Float32Array): SnappedStar {
  const [tx, ty, tz] = directionFromLonLat(coord[0], coord[1]);
  let bestOffset = 0;
  let bestDot = -2;

  for (let o = 0; o < starCache.length; o += STAR_CACHE_FLOATS) {
    const dot = starCache[o + 3]! * tx + starCache[o + 4]! * ty + starCache[o + 5]! * tz;
    if (dot > bestDot) {
      bestDot = dot;
      bestOffset = o;
    }
  }

  const x = starCache[bestOffset + 0]!;
  const y = starCache[bestOffset + 1]!;
  const z = starCache[bestOffset + 2]!;
  return {
    key: coordKey(coord),
    x, y, z,
    distance: Math.hypot(x, y, z),
    angularErrorDeg: Math.acos(clamp(bestDot, -1, 1)) * 180 / Math.PI,
  };
}

function snapCatalogStar(
  coord: LonLat,
  starCache: Float32Array,
  cache: Map<string, SnappedStar>,
): SnappedStar {
  const key = coordKey(coord);
  let star = cache.get(key);
  if (!star) {
    star = closestCatalogStar(coord, starCache);
    cache.set(key, star);
  }
  return star;
}

function pushVertex(out: number[], star: SnappedStar, alpha: number): void {
  out.push(star.x, star.y, star.z, alpha);
}

function median(values: number[]): number {
  if (values.length === 0) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) * 0.5;
}

function centroidDirection(stars: SnappedStar[]): [number, number, number] {
  let x = 0, y = 0, z = 0;
  for (const star of stars) {
    if (star.distance <= 0) continue;
    x += star.x / star.distance;
    y += star.y / star.distance;
    z += star.z / star.distance;
  }
  const len = Math.hypot(x, y, z);
  if (len <= 0) return [1, 0, 0];
  return [x / len, y / len, z / len];
}

function indexNameFeatures(json: ConstellationGeoJSON): Map<string, ConstellationFeature[]> {
  const byId = new Map<string, ConstellationFeature[]>();
  for (const feature of json.features ?? []) {
    if (!feature.id) continue;
    const list = byId.get(feature.id) ?? [];
    list.push(feature);
    byId.set(feature.id, list);
  }
  return byId;
}

function nextNameFeature(
  id: string,
  namesById: Map<string, ConstellationFeature[]>,
  counters: Map<string, number>,
): ConstellationFeature | undefined {
  const names = namesById.get(id);
  if (!names || names.length === 0) return undefined;
  const index = counters.get(id) ?? 0;
  counters.set(id, index + 1);
  return names[Math.min(index, names.length - 1)];
}

function pointCoordinates(feature: ConstellationFeature | undefined): LonLat | null {
  if (feature?.geometry?.type !== "Point") return null;
  return isLonLat(feature.geometry.coordinates) ? feature.geometry.coordinates : null;
}

function labelName(lineFeature: ConstellationFeature, nameFeature: ConstellationFeature | undefined): string {
  return nameFeature?.properties?.name
    ?? nameFeature?.properties?.en
    ?? lineFeature.id
    ?? "Constellation";
}

function labelRank(lineFeature: ConstellationFeature, nameFeature: ConstellationFeature | undefined): number {
  const rank = Number(nameFeature?.properties?.rank ?? lineFeature.properties?.rank);
  return Number.isFinite(rank) ? rank : 3;
}

function labelPosition(
  labelCoord: LonLat | null,
  featureStars: SnappedStar[],
): [number, number, number] {
  const direction = labelCoord
    ? directionFromLonLat(labelCoord[0], labelCoord[1])
    : centroidDirection(featureStars);
  const radius = median(featureStars.map(star => star.distance)) * LABEL_DISTANCE_SCALE;
  return [direction[0] * radius, direction[1] * radius, direction[2] * radius];
}

function labelRadius(center: [number, number, number], featureStars: SnappedStar[]): number {
  let radius = 1;
  for (const star of featureStars) {
    radius = Math.max(
      radius,
      Math.hypot(star.x - center[0], star.y - center[1], star.z - center[2]),
    );
  }
  return radius;
}

async function loadJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { cache: "force-cache" });
  if (!resp.ok) throw new Error(`${url} returned HTTP ${resp.status}`);
  return await resp.json() as T;
}

async function loadConstellationStarNameCache(): Promise<Map<string, ConstellationStarName>> {
  try {
    const json = await loadJson<ConstellationStarNameCache>(CONSTELLATION_STAR_NAMES_URL);
    return new Map(Object.entries(json.stars ?? {}));
  } catch (err) {
    console.warn("Constellation star-name cache unavailable:", err);
    return new Map();
  }
}

async function loadVisibleStarSnapshot(): Promise<Float32Array> {
  const resp = await fetch(VISIBLE_STAR_DATA_URL, { cache: "force-cache" });
  if (!resp.ok) throw new Error(`${VISIBLE_STAR_DATA_URL} returned HTTP ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength % (STAR_FLOATS * 4) !== 0) {
    throw new Error("Visible star binary has an invalid stride.");
  }
  return new Float32Array(buffer);
}

function fallbackStarName(abbreviation: string, index: number): string {
  return `${abbreviation} star ${index + 1}`;
}

function constellationStarLabel(
  abbreviation: string,
  featureId: string,
  star: SnappedStar,
  nameCache: Map<string, ConstellationStarName>,
  index: number,
  alpha: number,
): ConstellationStarLabel {
  const cached = nameCache.get(star.key);
  return {
    id: `${featureId}:star:${star.key}`,
    name: cached?.name ?? fallbackStarName(abbreviation, index),
    x: star.x,
    y: star.y,
    z: star.z,
    alpha: Math.min(alpha + 0.34, 0.92),
    ...(cached?.magnitude !== undefined ? { magnitude: cached.magnitude } : {}),
    ...(cached?.catalog ? { catalog: cached.catalog } : {}),
  };
}

export async function loadConstellationLines(): Promise<ConstellationLineLoad> {
  const [lineJson, nameJson, starNameCache, visibleStars] = await Promise.all([
    loadJson<ConstellationGeoJSON>(CONSTELLATION_LINES_URL),
    loadJson<ConstellationGeoJSON>(CONSTELLATION_NAMES_URL),
    loadConstellationStarNameCache(),
    loadVisibleStarSnapshot(),
  ]);

  const starCache = buildStarCache(visibleStars);
  if (starCache.length === 0) throw new Error("Visible star binary contains no usable positions.");

  const namesById = indexNameFeatures(nameJson);
  const nameCounters = new Map<string, number>();
  const featureCounters = new Map<string, number>();
  const snapCache = new Map<string, SnappedStar>();
  const vertices: number[] = [];
  const figures: ConstellationFigure[] = [];
  const labels: ConstellationLabel[] = [];
  let featureCount = 0;
  let segmentCount = 0;

  for (const feature of lineJson.features ?? []) {
    if (feature.geometry?.type !== "MultiLineString") continue;
    if (!Array.isArray(feature.geometry.coordinates)) continue;
    const id = feature.id ?? `constellation-${featureCount + 1}`;
    const featureIndex = featureCounters.get(id) ?? 0;
    featureCounters.set(id, featureIndex + 1);
    const labelFeature = nextNameFeature(id, namesById, nameCounters);
    const featureStars: SnappedStar[] = [];
    const featureStarLabels = new Map<string, ConstellationStarLabel>();
    const featureVertices: number[] = [];
    featureCount++;

    const alpha = alphaForRank(feature.properties?.rank);
    const featureId = `${id}-${featureIndex}`;
    for (const stroke of feature.geometry.coordinates) {
      if (!Array.isArray(stroke)) continue;
      for (let i = 0; i < stroke.length - 1; i++) {
        const a = stroke[i];
        const b = stroke[i + 1];
        if (!isLonLat(a) || !isLonLat(b)) continue;
        const starA = snapCatalogStar(a, starCache, snapCache);
        const starB = snapCatalogStar(b, starCache, snapCache);
        pushVertex(featureVertices, starA, alpha);
        pushVertex(featureVertices, starB, alpha);
        featureStars.push(starA, starB);
        if (!featureStarLabels.has(starA.key)) {
          featureStarLabels.set(starA.key, constellationStarLabel(
            id,
            featureId,
            starA,
            starNameCache,
            featureStarLabels.size,
            alpha,
          ));
        }
        if (!featureStarLabels.has(starB.key)) {
          featureStarLabels.set(starB.key, constellationStarLabel(
            id,
            featureId,
            starB,
            starNameCache,
            featureStarLabels.size,
            alpha,
          ));
        }
        segmentCount++;
      }
    }

    if (featureStars.length > 0) {
      const center = labelPosition(pointCoordinates(labelFeature), featureStars);
      const [x, y, z] = center;
      const label = {
        id: featureId,
        abbreviation: id,
        name: labelName(feature, labelFeature),
        x, y, z,
        radius: labelRadius(center, featureStars),
        rank: labelRank(feature, labelFeature),
        alpha: Math.min(alpha + 0.22, 0.72),
      };
      labels.push(label);
      vertices.push(...featureVertices);
      figures.push({
        id: featureId,
        abbreviation: id,
        name: label.name,
        data: new Float32Array(featureVertices),
        label,
        starLabels: [...featureStarLabels.values()].sort((a, b) => (
          (a.magnitude ?? 99) - (b.magnitude ?? 99) || a.name.localeCompare(b.name)
        )),
      });
    }
  }

  let looseEndpointCount = 0;
  for (const star of snapCache.values()) {
    if (star.angularErrorDeg > LOOSE_SNAP_DEGREES) looseEndpointCount++;
  }

  return {
    data: new Float32Array(vertices),
    figures,
    labels,
    source: "J2000 constellation endpoints snapped to HYG 4.2 visible-star 3D positions",
    featureCount,
    segmentCount,
    snappedEndpointCount: snapCache.size,
    looseEndpointCount,
  };
}

function normalizeConstellationSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function constellationSearchRank(label: ConstellationLabel, query: string): number | null {
  const normalizedName = normalizeConstellationSearchText(label.name);
  const normalizedId = normalizeConstellationSearchText(label.abbreviation);
  const haystack = [normalizedName, normalizedId].join(" ");
  const index = haystack.indexOf(query);
  if (index < 0) return null;

  const exact = normalizedName === query || normalizedId === query;
  const starts = normalizedName.startsWith(query) || normalizedId.startsWith(query);
  return (exact ? -100 : starts ? 0 : 1000) + index + label.rank * 2;
}

export function constellationToSearchResult(label: ConstellationLabel): StarSearchResult {
  return {
    id: `constellation:${label.id}`,
    label: label.name,
    subtitle: `constellation · ${label.abbreviation}`,
    x: label.x,
    y: label.y,
    z: label.z,
    focusDistance: Math.max(25, label.radius * CONSTELLATION_FOCUS_DISTANCE_FACTOR),
    color: [0.46, 0.70, 1.00],
  };
}

export function constellationFigureToSearchResult(figure: ConstellationFigure): StarSearchResult {
  return constellationToSearchResult(figure.label);
}

export function constellationsToSearchResults(
  figures: readonly ConstellationFigure[],
): StarSearchResult[] {
  return figures
    .map(constellationFigureToSearchResult)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function searchConstellations(
  labels: readonly ConstellationLabel[],
  query: string,
  limit = 6,
): StarSearchResult[] {
  const q = normalizeConstellationSearchText(query);
  if (q.length < 2) return [];

  return labels
    .map(label => {
      const rank = constellationSearchRank(label, q);
      return rank === null ? null : { rank, label };
    })
    .filter((item): item is { rank: number; label: ConstellationLabel } => item !== null)
    .sort((a, b) => a.rank - b.rank || a.label.name.localeCompare(b.label.name))
    .slice(0, limit)
    .map(item => constellationToSearchResult(item.label));
}

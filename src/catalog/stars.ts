export const STAR_FLOATS = 8;
export const DEFAULT_VISIBLE_STAR_COUNT = 100_000;
export const AU_PER_PARSEC = 80;

const EXOPLANET_HOST_DATA_URL = "/data/exoplanet-hosts.json";
const VISIBLE_STAR_DATA_URL = "/data/visible-stars-100k.bin";

export type StarBuffer = Float32Array<ArrayBufferLike>;

export interface CatalogStar {
  id: string;
  name: string;
  catalog: string;
  x: number;
  y: number;
  z: number;
  distancePc: number | null;
  magnitude: number | null;
  planetCount: number;
  color: [number, number, number];
  size: number;
  alpha: number;
  aliases?: string[];
}

export interface StarCatalogLoad {
  stars: CatalogStar[];
  source: string;
}

export interface VisibleStarLoad {
  data: StarBuffer;
  source: string;
}

export interface StarSearchResult {
  id: string;
  label: string;
  subtitle: string;
  x: number;
  y: number;
  z: number;
  focusDistance: number;
  color: [number, number, number];
}

interface ExoplanetHostRecord {
  name: string;
  ra: number;
  dec: number;
  distancePc?: number | null;
  magnitude?: number | null;
  planetCount?: number | null;
}

const FALLBACK_EXOPLANET_HOSTS: ExoplanetHostRecord[] = [
  { name: "Proxima Centauri", ra: 217.4292, dec: -62.6795, distancePc: 1.301, magnitude: 11.13, planetCount: 1 },
  { name: "TRAPPIST-1", ra: 346.6224, dec: -5.0413, distancePc: 12.43, magnitude: 18.8, planetCount: 7 },
  { name: "51 Peg", ra: 344.3666, dec: 20.7688, distancePc: 15.6, magnitude: 5.49, planetCount: 1 },
  { name: "HD 209458", ra: 330.7949, dec: 18.8843, distancePc: 48.3, magnitude: 7.65, planetCount: 1 },
  { name: "Kepler-22", ra: 285.6794, dec: 47.8863, distancePc: 190, magnitude: 11.66, planetCount: 1 },
  { name: "55 Cnc", ra: 133.1492, dec: 28.3308, distancePc: 12.59, magnitude: 5.95, planetCount: 5 },
  { name: "Tau Ceti", ra: 26.0093, dec: -15.9338, distancePc: 3.65, magnitude: 3.5, planetCount: 4 },
  { name: "WASP-12", ra: 97.6366, dec: 29.6723, distancePc: 427, magnitude: 11.69, planetCount: 1 },
  { name: "Kepler-452", ra: 287.5623, dec: 44.2776, distancePc: 550, magnitude: 13.43, planetCount: 1 },
  { name: "LHS 1140", ra: 4.7359, dec: -15.2711, distancePc: 14.99, magnitude: 14.15, planetCount: 2 },
];

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function starColor(bpRp: number): [number, number, number] {
  const t = clamp((bpRp + 0.4) / 2.8, 0, 1);
  const blue: [number, number, number] = [0.62, 0.74, 1.0];
  const white: [number, number, number] = [1.0, 0.96, 0.84];
  const orange: [number, number, number] = [1.0, 0.58, 0.34];

  if (t < 0.5) {
    const k = t / 0.5;
    return [
      blue[0] + (white[0] - blue[0]) * k,
      blue[1] + (white[1] - blue[1]) * k,
      blue[2] + (white[2] - blue[2]) * k,
    ];
  }

  const k = (t - 0.5) / 0.5;
  return [
    white[0] + (orange[0] - white[0]) * k,
    white[1] + (orange[1] - white[1]) * k,
    white[2] + (orange[2] - white[2]) * k,
  ];
}

function catalogPosition(raDeg: number, decDeg: number, distancePc: number | null): [number, number, number] {
  const ra = raDeg * Math.PI / 180;
  const dec = decDeg * Math.PI / 180;
  const visualPc = clamp(distancePc ?? 850, 1.2, 1_500);
  const r = visualPc * AU_PER_PARSEC;
  const cosDec = Math.cos(dec);
  return [
    r * cosDec * Math.cos(ra),
    r * cosDec * Math.sin(ra),
    r * Math.sin(dec),
  ];
}

function hostToCatalogStar(record: ExoplanetHostRecord, index: number): CatalogStar {
  const distancePc = Number.isFinite(record.distancePc) ? Number(record.distancePc) : null;
  const magnitude = Number.isFinite(record.magnitude) ? Number(record.magnitude) : null;
  const planetCount = Math.max(1, Math.round(record.planetCount ?? 1));
  const [x, y, z] = catalogPosition(record.ra, record.dec, distancePc);
  const magFactor = magnitude === null ? 0.35 : clamp((18 - magnitude) / 14, 0.08, 1);
  const color = starColor(magnitude === null ? 1.1 : clamp((magnitude - 4) / 5, -0.3, 2.4));

  return {
    id: `exo-${index}-${record.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: record.name,
    catalog: "NASA Exoplanet Archive",
    x, y, z,
    distancePc,
    magnitude,
    planetCount,
    color,
    size: 0.28 + magFactor * 0.75,
    alpha: 0.35 + magFactor * 0.5,
  };
}

export function createVisibleStarField(count = DEFAULT_VISIBLE_STAR_COUNT): StarBuffer {
  const rng = mulberry32(0xC0FFEE);
  const data = new Float32Array(count * STAR_FLOATS);

  for (let i = 0; i < count; i++) {
    const u = rng();
    const v = rng();
    const ra = u * Math.PI * 2;
    const dec = Math.asin(v * 2 - 1);
    const distancePc = 4 + Math.pow(rng(), 1.7) * 950;
    const r = distancePc * AU_PER_PARSEC;
    const cosDec = Math.cos(dec);
    const brightness = Math.pow(1 - rng(), 2.3);
    const color = starColor(rng() * 2.4 - 0.2);
    const o = i * STAR_FLOATS;

    data[o + 0] = r * cosDec * Math.cos(ra);
    data[o + 1] = r * cosDec * Math.sin(ra);
    data[o + 2] = r * Math.sin(dec);
    data[o + 3] = 0.12 + brightness * 0.75;
    data[o + 4] = color[0];
    data[o + 5] = color[1];
    data[o + 6] = color[2];
    data[o + 7] = 0.16 + brightness * 0.72;
  }

  return data;
}

export async function loadVisibleStarField(): Promise<VisibleStarLoad> {
  try {
    const response = await fetch(VISIBLE_STAR_DATA_URL, { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength % (STAR_FLOATS * 4) !== 0) {
      throw new Error("Visible star binary has an invalid stride.");
    }
    return {
      data: new Float32Array(buffer),
      source: "HYG 4.2 local binary snapshot",
    };
  } catch (error) {
    console.warn("Using generated visible star field:", error);
    return {
      data: createVisibleStarField(),
      source: "generated visible star fallback",
    };
  }
}

export function catalogStarsToRenderBuffer(stars: CatalogStar[]): StarBuffer {
  const data = new Float32Array(stars.length * STAR_FLOATS);

  for (let i = 0; i < stars.length; i++) {
    const star = stars[i]!;
    const o = i * STAR_FLOATS;
    data[o + 0] = star.x;
    data[o + 1] = star.y;
    data[o + 2] = star.z;
    data[o + 3] = star.size;
    data[o + 4] = star.color[0];
    data[o + 5] = star.color[1];
    data[o + 6] = star.color[2];
    data[o + 7] = star.alpha;
  }

  return data;
}

export function combineStarBuffers(...buffers: StarBuffer[]): StarBuffer {
  const total = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const combined = new Float32Array(total);
  let offset = 0;

  for (const buffer of buffers) {
    combined.set(buffer, offset);
    offset += buffer.length;
  }

  return combined;
}

export async function loadExoplanetHostStars(): Promise<StarCatalogLoad> {
  try {
    const response = await fetch(EXOPLANET_HOST_DATA_URL, { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const records = await response.json() as ExoplanetHostRecord[];
    const stars = records
      .filter(record => Number.isFinite(record.ra) && Number.isFinite(record.dec))
      .map(hostToCatalogStar);
    return { stars, source: "NASA Exoplanet Archive local snapshot" };
  } catch (error) {
    console.warn("Using fallback exoplanet host catalog:", error);
    return {
      stars: FALLBACK_EXOPLANET_HOSTS.map(hostToCatalogStar),
      source: "fallback exoplanet host sample",
    };
  }
}

export function searchCatalogStars(stars: CatalogStar[], query: string, limit = 8): StarSearchResult[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];

  return stars
    .map(star => {
      const name = star.name.toLowerCase();
      const aliasMatch = star.aliases?.some(alias => alias.toLowerCase().includes(q)) ?? false;
      let score = 0;
      if (name === q) score += 100;
      if (name.startsWith(q)) score += 65;
      if (name.includes(q)) score += 35;
      if (aliasMatch) score += 20;
      if (score === 0) return null;
      if (star.distancePc !== null) score += Math.max(0, 20 - star.distancePc * 0.15);
      score += Math.min(star.planetCount, 8);
      return { star, score };
    })
    .filter((item): item is { star: CatalogStar; score: number } => item !== null)
    .sort((a, b) => b.score - a.score || a.star.name.localeCompare(b.star.name))
    .slice(0, limit)
    .map(({ star }) => {
      const distanceLabel = star.distancePc === null ? "distance unknown" : `${star.distancePc.toFixed(star.distancePc < 20 ? 1 : 0)} pc`;
      const planetLabel = `${star.planetCount} confirmed planet${star.planetCount === 1 ? "" : "s"}`;
      const magnitudeLabel = star.magnitude === null ? "" : ` · mag ${star.magnitude.toFixed(1)}`;
      const distanceAu = Math.sqrt(star.x * star.x + star.y * star.y + star.z * star.z);
      return {
        id: star.id,
        label: star.name,
        subtitle: `${planetLabel} · ${distanceLabel}${magnitudeLabel}`,
        x: star.x,
        y: star.y,
        z: star.z,
        focusDistance: clamp(distanceAu * 0.015, 12, 180),
        color: star.color,
      };
    });
}

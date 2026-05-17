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
  temperatureK?: number | null;
  spectralType?: string | null;
  radiusSolar?: number | null;
  luminosityLogSolar?: number | null;
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

const HOST_ALIASES_BY_KEY: Record<string, string[]> = {
  "proxima cen": ["Proxima Centauri"],
  "tau cet": ["Tau Ceti"],
  "eps eri": ["Epsilon Eridani"],
  "eps ind a": ["Epsilon Indi"],
  "yz cet": ["YZ Ceti"],
  "gj 273": ["Luyten's Star"],
  "gj 411": ["Lalande 21185"],
  "gj 229": ["Gliese 229"],
  "gj 667 c": ["Gliese 667"],
};

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

function apparentFluxFromMagnitude(magnitude: number): number {
  // Relative visual flux with mag 6.0 as the naked-eye threshold reference.
  return Math.pow(10, -0.4 * (magnitude - 6.0));
}

function starDisplayFromMagnitude(magnitude: number | null, fallbackDisplay = 0.20): number {
  if (magnitude === null || !Number.isFinite(magnitude)) return fallbackDisplay;
  const normalized = apparentFluxFromMagnitude(magnitude) / 260;
  return clamp(Math.pow(Math.max(normalized, 1e-8), 0.18), 0.035, 1);
}

function hostAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ");
}

/**
 * Convert B-V Johnson color index → linear sRGB [0,1].
 * Anchored to subtle O/B, A/F, G, K, and M visual classes.
 */
export function starColorFromBv(bv: number): [number, number, number] {
  const keys: [number, [number,number,number]][] = [
    [-0.33, [0.65, 0.75, 1.00]], // O/B: hot blue-white
    [ 0.00, [0.90, 0.95, 1.00]], // A: blue-white
    [ 0.30, [0.94, 0.96, 1.00]], // F: near-white with a cool cast
    [ 0.65, [1.00, 0.92, 0.75]], // G: Sun-like white-yellow
    [ 1.00, [1.00, 0.65, 0.35]], // K: orange
    [ 1.60, [1.00, 0.35, 0.20]], // M: red-orange
  ];
  const bvC = clamp(bv, -0.33, 1.60);
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, c0] = keys[i]!;
    const [t1, c1] = keys[i + 1]!;
    if (bvC <= t1) {
      const k = (bvC - t0) / (t1 - t0);
      return [c0[0]+(c1[0]-c0[0])*k, c0[1]+(c1[1]-c0[1])*k, c0[2]+(c1[2]-c0[2])*k];
    }
  }
  return keys[keys.length - 1]![1];
}

export function colorFromTemperature(temperatureK: number): [number, number, number] {
  const keys: [number, [number,number,number]][] = [
    [30_000, [0.65, 0.75, 1.00]], // O/B
    [10_000, [0.90, 0.95, 1.00]], // A
    [ 7_500, [0.94, 0.96, 1.00]], // F
    [ 5_778, [1.00, 0.92, 0.75]], // G
    [ 4_400, [1.00, 0.65, 0.35]], // K
    [ 2_600, [1.00, 0.35, 0.20]], // M
  ];
  const t = clamp(temperatureK, 2_600, 30_000);
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, c0] = keys[i]!;
    const [t1, c1] = keys[i + 1]!;
    if (t >= t1) {
      const k = (t - t1) / (t0 - t1);
      return [c1[0]+(c0[0]-c1[0])*k, c1[1]+(c0[1]-c1[1])*k, c1[2]+(c0[2]-c1[2])*k];
    }
  }
  return keys[keys.length - 1]![1];
}

export function colorFromSpectralType(spectralType: string): [number, number, number] | null {
  const letter = spectralType.trim().toUpperCase().match(/[OBAFGKM]/)?.[0];
  switch (letter) {
    case "O":
    case "B": return [0.65, 0.75, 1.00];
    case "A": return [0.90, 0.95, 1.00];
    case "F": return [0.94, 0.96, 1.00];
    case "G": return [1.00, 0.92, 0.75];
    case "K": return [1.00, 0.65, 0.35];
    case "M": return [1.00, 0.35, 0.20];
    default: return null;
  }
}

function hostColor(record: ExoplanetHostRecord, magnitude: number | null): [number, number, number] {
  const temperatureK = Number.isFinite(record.temperatureK) ? Number(record.temperatureK) : null;
  if (temperatureK !== null && temperatureK > 0) return colorFromTemperature(temperatureK);

  if (record.spectralType) {
    const spectralColor = colorFromSpectralType(record.spectralType);
    if (spectralColor) return spectralColor;
  }

  // Fallback for older local cache files: most confirmed hosts are FGK dwarfs,
  // while very faint hosts are often cooler K/M dwarfs.
  const bvProxy = magnitude === null
    ? 0.65
    : clamp((magnitude - 3.0) / 9.0 * 1.4 + 0.20, -0.10, 1.55);
  return starColorFromBv(bvProxy);
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
  const apparentDisplay = starDisplayFromMagnitude(magnitude, 0.22);
  const color = hostColor(record, magnitude);
  const radiusSolar = Number.isFinite(record.radiusSolar) ? Number(record.radiusSolar) : null;
  const luminositySolar = Number.isFinite(record.luminosityLogSolar)
    ? Math.pow(10, Number(record.luminosityLogSolar))
    : null;
  const radiusScale = radiusSolar === null ? 1 : clamp(Math.sqrt(Math.max(radiusSolar, 0.05)), 0.45, 3.0);
  const luminosityScale = luminositySolar === null ? 1 : clamp(Math.pow(Math.max(luminositySolar, 0.0001), 0.16), 0.45, 2.4);

  const star: CatalogStar = {
    id: `exo-${index}-${record.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: record.name,
    catalog: "NASA Exoplanet Archive",
    x, y, z,
    distancePc,
    magnitude,
    planetCount,
    color,
    size: clamp((0.10 + Math.pow(apparentDisplay, 1.25) * 0.90) * (0.74 + radiusScale * 0.26), 0.08, 1.60),
    alpha: clamp((0.10 + Math.pow(apparentDisplay, 0.90) * 0.82) * luminosityScale, 0.10, 0.98),
  };
  const aliases = HOST_ALIASES_BY_KEY[hostAliasKey(record.name)];
  if (aliases) star.aliases = aliases;
  return star;
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
    const flux = Math.pow(rng(), 8.0);
    const brightness = clamp(Math.pow(Math.max(flux, 1e-8), 0.18), 0.035, 1);
    const color = starColorFromBv(rng() * 2.4 - 0.2);
    const o = i * STAR_FLOATS;

    data[o + 0] = r * cosDec * Math.cos(ra);
    data[o + 1] = r * cosDec * Math.sin(ra);
    data[o + 2] = r * Math.sin(dec);
    data[o + 3] = 0.09 + Math.pow(brightness, 1.35) * 0.95;
    data[o + 4] = color[0];
    data[o + 5] = color[1];
    data[o + 6] = color[2];
    data[o + 7] = 0.08 + Math.pow(brightness, 0.92) * 0.82;
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
        // Zoom to 0.5–5 AU from the star's visual position so it fills the view.
        // (Stars are rendered as fixed-NDC billboards; getting close + a size boost
        // via the shader makes them prominently visible.)
        focusDistance: clamp(distanceAu * 0.0005, 0.5, 5),
        color: star.color,
      };
    });
}

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Object info box backend.
//
// Resolution order (every step validates before accepting a page):
//   1. Generic hits ("Mapped star", "Milky Way star", "Galaxy", ...) never query
//      Wikipedia: they get a local, catalog-only record.
//   2. Curated page titles (WIKIPEDIA_OBJECT_PAGES) for names that are ambiguous
//      or do not match their article title (moons, 3D-model variants, Sgr A*...).
//   3. A client-supplied page hint (derived from the catalog, e.g. a 3D model's
//      base object) and deterministic title variants of the name / aliases /
//      catalog designations ("X (moon)", "X (star)", "M42" -> "Messier 42", ...).
//      These must resolve to a non-disambiguation page about an astronomical
//      object (short description or Wikidata instance-of check).
//   4. Wikipedia full-text search, accepting a hit only when its title (or the
//      redirect it matched) equals the object name / an alias / a designation,
//      and the page is an astronomical object. Word overlap is never enough.
//   5. Otherwise a local description with no external summary.
// Images come only from the validated article's own lead image (or a curated
// NASA facts page for solar-system bodies), never from free-text image search.

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE_ROOT = process.env.COSMOSMAP_OBJECT_INFO_CACHE_DIR
  ? path.resolve(process.env.COSMOSMAP_OBJECT_INFO_CACHE_DIR)
  : path.join(REPO_ROOT, "cache", "wikimedia", "object-info");
const IMAGE_CACHE_DIR = path.join(CACHE_ROOT, "images");
const WIKIPEDIA_SUMMARY_API = "https://en.wikipedia.org/api/rest_v1/page/summary";
const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_WEB = "https://en.wikipedia.org/wiki";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const WIKIMEDIA_COMMONS_WEB = "https://commons.wikimedia.org/wiki";
// v10: deterministic/validated resolution; drops every record produced by the
// old word-overlap search + free-text Commons image search (e.g. "Cassiopeia A
// Green Monster" -> "Milky Way" with a Stargate screenshot).
const OBJECT_INFO_CACHE_VERSION = 10;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_CACHE_TTL_DAYS = 30;
const GENERAL_DESCRIPTION_MAX_LENGTH = 1400;
const JSON_FETCH_TIMEOUT_MS = 10_000;
const HTML_FETCH_TIMEOUT_MS = 10_000;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const MAX_TITLE_CANDIDATES = 10;
const MAX_ALIASES = 8;
const USER_AGENT = "CosmosMap object-info cache (https://github.com/bekirdag/space_simulation)";

const NASA_SCIENCE_OBJECT_PAGES = new Map([
  ["sun", "https://science.nasa.gov/sun/facts/"],
  ["mercury", "https://science.nasa.gov/mercury/facts/"],
  ["venus", "https://science.nasa.gov/venus/venus-facts/"],
  ["earth", "https://science.nasa.gov/earth/facts/"],
  ["moon", "https://science.nasa.gov/moon/facts/"],
  ["mars", "https://science.nasa.gov/mars/facts/"],
  ["jupiter", "https://science.nasa.gov/jupiter/facts/"],
  ["saturn", "https://science.nasa.gov/saturn/facts/"],
  ["titan", "https://science.nasa.gov/saturn/moons/titan/facts/"],
  ["uranus", "https://science.nasa.gov/uranus/facts/"],
  ["neptune", "https://science.nasa.gov/neptune/facts/"],
  ["pluto", "https://science.nasa.gov/dwarf-planets/pluto/facts/"],
  ["ceres", "https://science.nasa.gov/dwarf-planets/ceres/facts/"],
]);

// Curated titles. Keys are normalizeForMatch() of an object name or alias.
// Moons with mythological / literary namesakes always use their "(moon)" page.
const MOON_PAGE_NAMES = [
  "Io", "Europa", "Ganymede", "Callisto", "Amalthea", "Himalia", "Thebe", "Metis", "Adrastea",
  "Mimas", "Enceladus", "Tethys", "Dione", "Rhea", "Titan", "Hyperion", "Iapetus", "Phoebe",
  "Janus", "Epimetheus", "Pandora", "Prometheus", "Atlas", "Pan", "Helene", "Calypso", "Telesto",
  "Miranda", "Ariel", "Umbriel", "Titania", "Oberon", "Puck", "Caliban", "Sycorax",
  "Triton", "Nereid", "Proteus", "Larissa", "Galatea", "Despina", "Thalassa", "Naiad",
  "Charon", "Nix", "Hydra", "Kerberos", "Styx", "Phobos", "Deimos", "Dysnomia", "Hiʻiaka", "Namaka",
];
const WIKIPEDIA_OBJECT_PAGES = new Map([
  ["sun", "Sun"],
  ["mercury", "Mercury (planet)"],
  ["venus", "Venus"],
  ["earth", "Earth"],
  ["moon", "Moon"],
  ["luna", "Moon"],
  ["mars", "Mars"],
  ["jupiter", "Jupiter"],
  ["saturn", "Saturn"],
  ["uranus", "Uranus"],
  ["neptune", "Neptune"],
  ["pluto", "Pluto"],
  ["ceres", "Ceres (dwarf planet)"],
  ["eris", "Eris (dwarf planet)"],
  ["haumea", "Haumea"],
  ["makemake", "Makemake"],
  ["sedna", "Sedna (dwarf planet)"],
  ["quaoar", "Quaoar"],
  ["gonggong", "Gonggong (dwarf planet)"],
  ["orcus", "Orcus (dwarf planet)"],
  ["vesta", "4 Vesta"],
  ["pallas", "2 Pallas"],
  ["milky way", "Milky Way"],
  ["milky way galaxy", "Milky Way"],
  ["andromeda galaxy", "Andromeda Galaxy"],
  ["m31", "Andromeda Galaxy"],
  ["triangulum galaxy", "Triangulum Galaxy"],
  ["large magellanic cloud", "Large Magellanic Cloud"],
  ["lmc", "Large Magellanic Cloud"],
  ["small magellanic cloud", "Small Magellanic Cloud"],
  ["smc", "Small Magellanic Cloud"],
  ["sgr a", "Sagittarius A*"],
  ["sagittarius a", "Sagittarius A*"],
  ["proxima centauri", "Proxima Centauri"],
  ["alpha centauri", "Alpha Centauri"],
  ["alpha centauri a", "Alpha Centauri"],
  ["alpha centauri b", "Alpha Centauri"],
  ["rigil kentaurus", "Alpha Centauri"],
  ["toliman", "Alpha Centauri"],
  ["barnard s star", "Barnard's Star"],
  ["sirius", "Sirius"],
  ["sirius a", "Sirius"],
  ["sirius b", "Sirius"],
  ["castor", "Castor (star)"],
  ["pollux", "Pollux (star)"],
  ["vega", "Vega"],
  ["polaris", "Polaris"],
  ["mira", "Mira"],
  ["sh2 298", "NGC 2359"],
  ["sh 2 298", "NGC 2359"],
  ["sharpless 2 298", "NGC 2359"],
  ["thor s helmet", "NGC 2359"],
  // 3D structure models (src/catalog/milkyway-models.ts): every variant maps to
  // the article about the physical object. The client also sends the base
  // model name as a `page` hint derived from the catalog's modelGroup.
  ["crab nebula", "Crab Nebula"],
  ["m1", "Crab Nebula"],
  ["taurus a", "Crab Nebula"],
  ["cassiopeia a", "Cassiopeia A"],
  ["cas a", "Cassiopeia A"],
  ["cassiopeia a green monster", "Cassiopeia A"],
  ["cas a 2023", "Cassiopeia A"],
  ["green monster", "Cassiopeia A"],
  ["cassiopeia a iron", "Cassiopeia A"],
  ["cassiopeia a iron 2025", "Cassiopeia A"],
  ["cas a 2025", "Cassiopeia A"],
  ["cas a iron", "Cassiopeia A"],
  ["cygnus loop", "Cygnus Loop"],
  ["veil nebula", "Veil Nebula"],
  ["bp tauri", "BP Tauri"],
  ["bp tau", "BP Tauri"],
]);

// Curated titles that only apply to one object kind (a constellation called
// "Hydra" or "Andromeda" must not resolve to a moon or a galaxy).
const WIKIPEDIA_OBJECT_PAGES_BY_KIND = {
  moon: new Map(MOON_PAGE_NAMES.map(name => [normalizeForMatch(name), `${name} (moon)`])),
  galaxy: new Map([
    ["andromeda", "Andromeda Galaxy"],
    ["triangulum", "Triangulum Galaxy"],
  ]),
};

// Labels the app uses for unnamed catalog entries. These are never looked up.
const GENERIC_OBJECT_NAMES = new Set([
  "mapped star",
  "milky way star",
  "visible star",
  "catalog star",
  "unnamed star",
  "star",
  "stars",
  "star a",
  "star b",
  "galaxy",
  "unnamed galaxy",
  "nebula",
  "object",
  "exoplanet host star",
  "exoplanet",
  "planet",
  "3d model",
]);

// Wikidata classes that count as "astronomical object" roots. The instance-of
// (P31) classes of a page's item are walked up subclass-of (P279) a few levels.
const ASTRONOMICAL_ROOT_CLASSES = new Set([
  "Q6999", // astronomical object
  "Q523", // star
  "Q318", // galaxy
  "Q42372", // nebula
  "Q207436", // supernova remnant
  "Q634", // planet
  "Q44559", // exoplanet
  "Q2199", // dwarf planet
  "Q2537", // natural satellite
  "Q8928", // constellation
  "Q589", // black hole
  "Q40392", // supermassive black hole
  "Q3863", // asteroid
  "Q168845", // star cluster
  "Q204107", // galaxy cluster
  "Q3937", // supernova
  "Q11282", // H II region
  "Q1931185", // astronomical radio source
  "Q83373", // quasar
  "Q5871", // white dwarf
  "Q13890", // double star
  "Q595871", // multiple star / star system
  "Q1457376", // eclipsing binary
  "Q206717", // planetary system
  "Q1054444", // interstellar cloud
]);
const WIKIDATA_WALK_DEPTH = 3;
const WIKIDATA_MAX_FRONTIER = 16;

const ASTRO_DESCRIPTION_RE = /\b(?:stars?|stellar|galaxy|galaxies|galactic|nebulae?|planets?|planetary|exoplanets?|moons?|natural satellites?|satellite (?:galaxy|of)|constellations?|supernovae?|remnant|clusters? of (?:stars|galaxies)|star cluster|globular|black holes?|pulsar|magnetar|quasar|neutron star|dwarf|asteroids?|comets?|kuiper|trans-neptunian|h ii region|molecular cloud|interstellar|protostar|protoplanetary|asterism|binary system|variable star|astronomical)\b/i;
const NON_ASTRO_DESCRIPTION_RE = /\b(?:film|movie|album|song|single|band|musician|singer|rapper|actor|actress|video game|board game|game|novel|book|comic|manga|anime|character|fictional|mythology|mythological|goddess|god|deity|opera|ballet|play by|television|tv series|episode|ship|vessel|company|brand|software|footballer|politician|village|town|city|river|mountain|genus|species|plant|moth|beetle|racehorse|automobile|car model|locomotive|aircraft|missile|rocket|spacecraft|space probe|mission|given name|surname|disambiguation|artificial satellite|communications satellite)\b/i;
const REJECTED_IMAGE_RE = /\b(?:stargate|video games?|computer games?|game screenshots?|screenshots?|second life|minecraft|star trek|star wars|fan ?art|fictional|fiction|cosplay|lego|toys?|album covers?|posters?|logos?|insignias?|mission patch|mytholog(?:y|ical)|temple of|paintings?|statues?|sculptures?|frescos?|tarot|astrolog(?:y|ical)|coats? of arms|flags?)\b/i;

function cacheTtlMs() {
  const raw = Number.parseFloat(process.env.COSMOSMAP_OBJECT_INFO_CACHE_TTL_DAYS ?? "");
  const days = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function cleanText(value, maxLength = 240) {
  return decodeHtmlEntities(String(value ?? "").replace(/<[^>]*>/g, " "))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;/gi, "'")
    .replace(/&#039;/gi, "'")
    .replace(/&rsquo;/gi, "'")
    .replace(/&lsquo;/gi, "'")
    .replace(/&rdquo;/gi, "\"")
    .replace(/&ldquo;/gi, "\"")
    .replace(/&hellip;/gi, "...")
    .replace(/&mdash;/gi, " - ")
    .replace(/&ndash;/gi, " - ");
}

function cleanExcerpt(value, maxLength = GENERAL_DESCRIPTION_MAX_LENGTH) {
  return cleanText(value, maxLength)
    .replace(/\s*\[\s*(?:\.{3}|…)\s*\]\s*$/u, "")
    .replace(/\s*(?:\.{3}|…)\s*$/u, "")
    .trim();
}

function normalizeForMatch(value) {
  return cleanText(value, 240)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function objectLookupKey(value) {
  return normalizeForMatch(value).slice(0, 120);
}

function stripParenthetical(value) {
  return cleanText(String(value ?? "").replace(/\s*\([^)]*\)\s*$/, ""), 180);
}

export function isGenericObjectName(title) {
  const key = normalizeForMatch(title);
  if (!key) return true;
  if (GENERIC_OBJECT_NAMES.has(key)) return true;
  return /^(?:galaxy|star|nebula|object|mapped star|milky way star)\s*\d+$/.test(key);
}

function slugify(value, fallback = "object") {
  const slug = cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function cacheFileFor(title, objectType, pageHint = "") {
  const base = slugify(`${objectType}-${title}`);
  const hash = createHash("sha256")
    .update(`${OBJECT_INFO_CACHE_VERSION}\n${objectType}\n${title}\n${pageHint}`)
    .digest("hex")
    .slice(0, 14);
  return path.join(CACHE_ROOT, `${base}-${hash}.json`);
}

function imageRouteFor(filename) {
  return `/api/object-info/image/${encodeURIComponent(filename)}`;
}

function mimeFromExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function extFromMime(contentType, fallbackUrl = "") {
  const type = contentType.toLowerCase();
  if (type.includes("image/jpeg")) return ".jpg";
  if (type.includes("image/png")) return ".png";
  if (type.includes("image/gif")) return ".gif";
  if (type.includes("image/webp")) return ".webp";
  const ext = path.extname(new URL(fallbackUrl).pathname).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return ext;
  return ".jpg";
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res) {
  res.writeHead(405, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Allow": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify({ error: "method_not_allowed" }));
}

async function readCache(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err instanceof SyntaxError)) return null;
    throw err;
  }
}

async function writeCache(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

function cacheVersionIsCurrent(payload) {
  return payload?.cacheVersion === OBJECT_INFO_CACHE_VERSION;
}

function cacheIsFresh(payload) {
  if (!cacheVersionIsCurrent(payload)) return false;
  if (!payload?.cachedAt) return false;
  const ttl = cacheTtlMs();
  if (ttl === 0) return false;
  const cachedMs = Date.parse(payload.cachedAt);
  return Number.isFinite(cachedMs) && Date.now() - cachedMs <= ttl;
}

// ---------------------------------------------------------------------------
// Fetch helpers: the timeout covers headers *and* body reading.

class RemoteHttpError extends Error {
  constructor(status, statusText, url) {
    super(`Remote request failed: ${status} ${statusText} (${url})`);
    this.status = status;
  }
}

async function fetchWithTimeout(url, { accept, timeoutMs, read, maxBytes = Infinity }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "Accept": accept, "User-Agent": USER_AGENT },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RemoteHttpError(response.status, response.statusText, String(url));
    }
    return await read(response, maxBytes);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  return fetchWithTimeout(url, {
    accept: "application/json",
    timeoutMs: JSON_FETCH_TIMEOUT_MS,
    read: response => response.json(),
  });
}

async function fetchText(url) {
  return fetchWithTimeout(url, {
    accept: "text/html,application/xhtml+xml",
    timeoutMs: HTML_FETCH_TIMEOUT_MS,
    read: async response => ({ html: await response.text(), url: response.url }),
  });
}

async function readLimitedBody(response, maxBytes) {
  const length = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Remote image is too large to cache (${length} bytes)`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Remote image body unavailable");
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Remote image is too large to cache (>${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total);
}

function isNetworkFailure(err) {
  if (err instanceof RemoteHttpError) return err.status === 429 || err.status >= 500;
  return true; // abort / DNS / socket errors
}

// ---------------------------------------------------------------------------
// Image cache

async function cachedRemoteImage(imageUrl, title, objectType, sourceId) {
  if (!imageUrl) return null;
  await mkdir(IMAGE_CACHE_DIR, { recursive: true });

  const { buffer, contentType } = await fetchWithTimeout(imageUrl, {
    accept: "image/*",
    timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
    maxBytes: MAX_IMAGE_BYTES,
    read: async (response, maxBytes) => {
      const type = response.headers.get("content-type") ?? "";
      if (!type.toLowerCase().startsWith("image/")) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`Remote image response is not an image (${type || "unknown content type"})`);
      }
      return { buffer: await readLimitedBody(response, maxBytes), contentType: type };
    },
  });

  const hash = createHash("sha256").update(`${sourceId ?? ""}\n${imageUrl}`).digest("hex").slice(0, 14);
  const filename = `${slugify(`${objectType}-${title}`)}-${hash}${extFromMime(contentType, imageUrl)}`;
  await writeFile(path.join(IMAGE_CACHE_DIR, filename), buffer);
  return { filename, url: imageRouteFor(filename) };
}

// ---------------------------------------------------------------------------
// NASA Science curated facts pages (image fallback for solar-system bodies)

function htmlAttr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = tag.match(new RegExp(`\\b${escaped}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? "";
}

function metaContent(html, names, maxLength = 1800) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const key = (htmlAttr(tag, "name") || htmlAttr(tag, "property")).toLowerCase();
    if (!wanted.has(key)) continue;
    const content = htmlAttr(tag, "content");
    if (content) return cleanText(content, maxLength);
  }
  return "";
}

async function curatedNasaImage({ title, objectType, resolvedPage }) {
  const sourcePage = NASA_SCIENCE_OBJECT_PAGES.get(objectLookupKey(title)) ||
    NASA_SCIENCE_OBJECT_PAGES.get(objectLookupKey(stripParenthetical(resolvedPage)));
  if (!sourcePage) return null;
  const { html, url } = await fetchText(sourcePage);
  const remoteImageUrl = decodeHtmlEntities(metaContent(html, ["og:image"], 1000));
  if (!remoteImageUrl) return null;
  const image = await cachedRemoteImage(remoteImageUrl, title, objectType, url);
  if (!image) return null;
  return {
    imageUrl: image.url,
    cachedImage: image.filename,
    remoteImageUrl,
    imageProvider: "NASA Science",
    imageSourceTitle: "NASA Science",
    imageSourceUrl: url,
    imageCredit: "NASA",
    imageLicense: null,
    imageLicenseUrl: null,
  };
}

// ---------------------------------------------------------------------------
// Wikipedia / Wikidata resolution

function wikipediaPageUrl(title) {
  return `${WIKIPEDIA_WEB}/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
}

function commonsFilePageUrl(title) {
  return `${WIKIMEDIA_COMMONS_WEB}/${encodeURIComponent(String(title ?? "").replace(/\s+/g, "_"))}`;
}

function curatedPageFor(name, kind) {
  const keys = [objectLookupKey(name), objectLookupKey(stripParenthetical(name))];
  const byKind = WIKIPEDIA_OBJECT_PAGES_BY_KIND[kind || "moon"];
  for (const key of keys) {
    const page = byKind?.get(key);
    if (page) return page;
  }
  // Constellation names collide with other objects (Hydra, Andromeda, ...):
  // they only use the "(constellation)" rule below.
  if (kind === "constellation") return "";
  for (const key of keys) {
    const page = WIKIPEDIA_OBJECT_PAGES.get(key);
    if (page) return page;
  }
  return "";
}

function typeKind(objectType) {
  const type = normalizeForMatch(objectType);
  if (/\bblack hole\b/.test(type)) return "black hole";
  if (/\bconstellation\b/.test(type)) return "constellation";
  if (/\bdwarf planet\b/.test(type)) return "dwarf planet";
  if (/\bexoplanet\b/.test(type) && !/\bhost\b/.test(type)) return "exoplanet";
  if (/\bmoon\b|\bsatellite\b/.test(type)) return "moon";
  if (/\bplanet\b/.test(type) && !/\bnebula\b/.test(type)) return "planet";
  if (/\bgalax/.test(type)) return "galaxy";
  if (/\bnebula\b|\bremnant\b|\bh ii\b/.test(type)) return "nebula";
  if (/\bstar\b/.test(type)) return "star";
  if (/\basteroid\b/.test(type)) return "asteroid";
  return "";
}

const TYPE_DISAMBIGUATORS = {
  "moon": ["moon"],
  "planet": ["planet"],
  "dwarf planet": ["dwarf planet"],
  "star": ["star"],
  "constellation": ["constellation"],
  "galaxy": ["galaxy", "dwarf galaxy"],
  "nebula": ["nebula"],
  "asteroid": ["asteroid"],
};

const DESIGNATION_RE = /^(?:m|messier|ngc|ic|ugc|pgc|abell|barnard|gum|ldn|lbn|vdb|rcw|sh\s*2|sh2|sharpless\s*2|hd|hip|hr|gj|gliese|wolf|ross|lhs|lp|kepler|k2|koi|toi|tic|kic|wasp|hat-p|hats|xo|tres|corot|ogle|2mass|wise|g\d)\s*-?\s*\d/i;

function isDesignation(value) {
  return DESIGNATION_RE.test(cleanText(value, 180));
}

function designationVariants(name) {
  const text = cleanText(name, 180);
  const variants = [];
  const messier = text.match(/^(?:m|messier)\s*-?\s*(\d{1,3})$/i);
  if (messier) variants.push(`Messier ${messier[1]}`);
  const catalog = text.match(/^(ngc|ic|ugc|pgc|abell|barnard|gum|ldn|lbn|vdb|rcw|sh\s*2|sh2|sharpless\s*2)\s*-?\s*(\d{1,6}[a-z]?)$/i);
  if (catalog) {
    const prefix = catalog[1].toLowerCase().replace(/\s+/g, "");
    const number = catalog[2];
    if (prefix === "sh2" || prefix === "sharpless2") variants.push(`Sh2-${number}`, `Sharpless 2-${number}`);
    else if (prefix === "vdb") variants.push(`vdB ${number}`);
    else if (prefix === "barnard") variants.push(`Barnard ${number}`);
    else if (prefix === "abell") variants.push(`Abell ${number}`);
    else variants.push(`${prefix.toUpperCase()} ${number}`);
  }
  const westerhout = text.match(/^w\s*(\d{1,2})(?:\s+complex)?$/i);
  if (westerhout) variants.push(`Westerhout ${westerhout[1]}`);
  // Exoplanets: "Kepler-22 b" -> "Kepler-22b".
  const planet = text.match(/^(.+?\d)\s+([b-i])$/);
  if (planet) variants.push(`${planet[1]}${planet[2]}`);
  return variants;
}

// Every name the object is known by: title, "Name (Designation)" parts,
// "Designation (Name)" parts, aliases, and designation spellings.
function objectNameVariants(title, aliases = []) {
  const names = [];
  const push = value => {
    const text = cleanText(value, 180);
    if (text && !isGenericObjectName(text)) names.push(text);
  };
  const pushWithVariants = value => {
    push(value);
    for (const variant of designationVariants(value)) push(variant);
  };
  for (const value of [title, ...aliases]) {
    pushWithVariants(value);
    const paren = String(value ?? "").match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (paren) {
      // "Orion (M43)": the catalog designation is less ambiguous than a
      // one-word common name, so try it first.
      const parts = isDesignation(paren[2]) && !isDesignation(paren[1]) ? [paren[2], paren[1]] : [paren[1], paren[2]];
      for (const part of parts) pushWithVariants(part);
    }
  }
  const seen = new Set();
  return names.filter(name => {
    const key = normalizeForMatch(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function directTitleCandidates({ title, objectType, pageHint, aliases }) {
  const candidates = [];
  const add = (pageTitle, kind) => {
    const clean = cleanText(pageTitle, 180);
    if (!clean) return;
    const key = normalizeForMatch(clean);
    if (candidates.some(candidate => normalizeForMatch(candidate.pageTitle) === key)) return;
    candidates.push({ pageTitle: clean, kind });
  };

  const kind = typeKind(objectType);
  const names = objectNameVariants(title, aliases);
  for (const name of [title, pageHint, ...names]) {
    const curated = name ? curatedPageFor(name, kind) : "";
    if (curated) add(curated, "curated");
  }
  if (pageHint) add(pageHint, "hint");

  const disambiguators = TYPE_DISAMBIGUATORS[kind] ?? [];
  for (const name of names) {
    // Catalog designations are unique; only common names need "(moon)" etc.
    if (!isDesignation(name) && !/\)\s*$/.test(name)) {
      for (const label of disambiguators) add(`${name} (${label})`, "title");
    }
    add(name, "title");
  }
  return candidates.slice(0, MAX_TITLE_CANDIDATES);
}

async function wikipediaSummary(pageTitle) {
  const url = new URL(`${WIKIPEDIA_SUMMARY_API}/${encodeURIComponent(pageTitle.replace(/\s+/g, "_"))}`);
  url.searchParams.set("redirect", "true");
  try {
    return await fetchJson(url);
  } catch (err) {
    if (err instanceof RemoteHttpError && err.status === 404) return null;
    throw err;
  }
}

function summaryIsArticle(summary) {
  if (!summary || summary.type === "disambiguation" || summary.type === "no-extract") return false;
  if (summary.namespace && summary.namespace.id !== 0) return false;
  if (/\(disambiguation\)$/i.test(summary.title ?? "")) return false;
  return cleanText(summary.extract, GENERAL_DESCRIPTION_MAX_LENGTH).length >= 60;
}

const wikidataParentMemo = new Map();

async function wikidataClaims(qid, property) {
  const memoKey = `${qid}:${property}`;
  if (wikidataParentMemo.has(memoKey)) return wikidataParentMemo.get(memoKey);
  const url = new URL(WIKIDATA_API);
  url.searchParams.set("action", "wbgetclaims");
  url.searchParams.set("format", "json");
  url.searchParams.set("entity", qid);
  url.searchParams.set("property", property);
  const json = await fetchJson(url);
  const values = (json?.claims?.[property] ?? [])
    .map(claim => claim?.mainsnak?.datavalue?.value?.id)
    .filter(id => typeof id === "string" && /^Q\d+$/.test(id));
  wikidataParentMemo.set(memoKey, values);
  return values;
}

// True when the item's instance-of classes reach an astronomical root class.
async function wikidataIsAstronomical(qid) {
  if (!qid || !/^Q\d+$/.test(qid)) return false;
  let frontier = await wikidataClaims(qid, "P31");
  const visited = new Set(frontier);
  for (let depth = 0; depth <= WIKIDATA_WALK_DEPTH && frontier.length > 0; depth++) {
    if (frontier.some(cls => ASTRONOMICAL_ROOT_CLASSES.has(cls))) return true;
    if (depth === WIKIDATA_WALK_DEPTH) break;
    const parents = await Promise.all(frontier.slice(0, WIKIDATA_MAX_FRONTIER).map(cls => wikidataClaims(cls, "P279")));
    frontier = parents.flat().filter(cls => {
      if (visited.has(cls)) return false;
      visited.add(cls);
      return true;
    });
  }
  return false;
}

async function summaryIsAstronomical(summary) {
  const description = cleanText(summary?.description, 300);
  if (description && ASTRO_DESCRIPTION_RE.test(description) && !NON_ASTRO_DESCRIPTION_RE.test(description)) {
    return { ok: true, via: "description" };
  }
  try {
    if (await wikidataIsAstronomical(summary?.wikibase_item)) return { ok: true, via: "wikidata" };
  } catch (err) {
    console.warn(`CosmosMap Wikidata class check failed for ${summary?.wikibase_item}:`, err?.message ?? err);
    throw err;
  }
  return { ok: false, via: "" };
}

async function validatedSummary(pageTitle, { requireAstronomy }) {
  const summary = await wikipediaSummary(pageTitle);
  if (!summaryIsArticle(summary)) return null;
  if (!requireAstronomy) return { summary, via: "curated" };
  const check = await summaryIsAstronomical(summary);
  return check.ok ? { summary, via: check.via } : null;
}

async function searchWikipediaTitles(query) {
  const url = new URL(WIKIPEDIA_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("list", "search");
  url.searchParams.set("srsearch", query);
  url.searchParams.set("srlimit", "10");
  url.searchParams.set("srprop", "redirecttitle");
  const json = await fetchJson(url);
  return Array.isArray(json?.query?.search) ? json.query.search : [];
}

function searchLabelFor(objectType) {
  const kind = typeKind(objectType);
  if (kind === "moon") return "moon";
  if (kind === "exoplanet") return "exoplanet";
  if (kind === "planet" || kind === "dwarf planet") return "planet";
  return kind || "astronomy";
}

async function resolveWikipediaPage(params) {
  const { title, objectType, pageHint, aliases } = params;
  const state = { networkError: false, tried: [] };

  const attempt = async (pageTitle, kind) => {
    state.tried.push(pageTitle);
    try {
      const result = await validatedSummary(pageTitle, { requireAstronomy: kind !== "curated" });
      return result ? { ...result, kind } : null;
    } catch (err) {
      if (isNetworkFailure(err)) state.networkError = true;
      console.warn(`CosmosMap Wikipedia lookup failed for ${pageTitle}:`, err?.message ?? err);
      return null;
    }
  };

  for (const candidate of directTitleCandidates({ title, objectType, pageHint, aliases })) {
    const result = await attempt(candidate.pageTitle, candidate.kind);
    if (result) return { ...result, state };
  }

  // Search fallback: only an exact title / redirect match to a known name.
  const names = objectNameVariants(title, aliases);
  const nameKeys = new Set(names.map(normalizeForMatch).filter(key => key.length >= 2));
  const kind = typeKind(objectType);
  const allowedQualifiers = new Set(
    (kind ? TYPE_DISAMBIGUATORS[kind] ?? [] : Object.values(TYPE_DISAMBIGUATORS).flat()).map(normalizeForMatch),
  );
  // "Titania (moon)" only matches "Titania" when the object is a moon.
  const qualifiedTitleMatches = hitTitle => {
    const qualifier = hitTitle.match(/\(([^)]+)\)\s*$/)?.[1];
    return Boolean(qualifier) &&
      allowedQualifiers.has(normalizeForMatch(qualifier)) &&
      nameKeys.has(normalizeForMatch(stripParenthetical(hitTitle)));
  };
  const tried = new Set(state.tried.map(normalizeForMatch));
  for (const name of names.slice(0, 2)) {
    let hits = [];
    try {
      hits = await searchWikipediaTitles(`${name} ${searchLabelFor(objectType)}`);
    } catch (err) {
      if (isNetworkFailure(err)) state.networkError = true;
      console.warn("CosmosMap Wikipedia search failed:", err?.message ?? err);
      continue;
    }
    for (const hit of hits) {
      const hitTitle = cleanText(hit?.title, 180);
      if (!hitTitle || tried.has(normalizeForMatch(hitTitle))) continue;
      const titleMatches = nameKeys.has(normalizeForMatch(hitTitle)) ||
        qualifiedTitleMatches(hitTitle) ||
        (hit?.redirecttitle && nameKeys.has(normalizeForMatch(hit.redirecttitle)));
      if (!titleMatches) continue;
      tried.add(normalizeForMatch(hitTitle));
      const result = await attempt(hitTitle, "search");
      if (result) return { ...result, state };
    }
  }

  return { summary: null, kind: "none", state };
}

async function leadImageFileFor(pageTitle) {
  const url = new URL(WIKIPEDIA_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("prop", "pageimages");
  url.searchParams.set("piprop", "name|thumbnail|original");
  url.searchParams.set("pithumbsize", "1200");
  url.searchParams.set("titles", pageTitle);
  const json = await fetchJson(url);
  const page = Object.values(json?.query?.pages ?? {})[0];
  if (!page?.pageimage) return null;
  return {
    fileName: page.pageimage,
    thumbUrl: page.thumbnail?.source || page.original?.source || null,
  };
}

function extMetadataValue(metadata, key, maxLength = 240) {
  return cleanText(metadata?.[key]?.value ?? "", maxLength);
}

function cleanMetadataUrl(value) {
  const text = cleanText(value, 1000);
  if (text.startsWith("//")) return `https:${text}`;
  return /^https?:\/\//i.test(text) ? text : "";
}

async function imageFileMetadata(fileName) {
  const url = new URL(WIKIPEDIA_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("titles", `File:${fileName}`);
  url.searchParams.set("iiprop", "url|mime|size|extmetadata");
  url.searchParams.set("iiextmetadatalanguage", "en");
  url.searchParams.set(
    "iiextmetadatafilter",
    "ObjectName|ImageDescription|Artist|Credit|LicenseShortName|LicenseUrl|UsageTerms|Categories",
  );
  const json = await fetchJson(url);
  const page = Object.values(json?.query?.pages ?? {})[0];
  const info = Array.isArray(page?.imageinfo) ? page.imageinfo[0] : null;
  return info ? { page, info, metadata: info.extmetadata ?? {} } : null;
}

function imageIsRejected(fileName, metadata) {
  const blob = [
    fileName,
    extMetadataValue(metadata, "ObjectName", 300),
    extMetadataValue(metadata, "ImageDescription", 800),
    extMetadataValue(metadata, "Categories", 800),
  ].join(" ").replace(/[_|]+/g, " ");
  return REJECTED_IMAGE_RE.test(blob);
}

function imageCredit(fileName, metadata) {
  const artist = extMetadataValue(metadata, "Artist", 260);
  const credit = extMetadataValue(metadata, "Credit", 260);
  const objectName = extMetadataValue(metadata, "ObjectName", 180) ||
    cleanText(String(fileName ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " "), 180);
  const license = extMetadataValue(metadata, "LicenseShortName", 120) ||
    extMetadataValue(metadata, "UsageTerms", 120);
  const author = artist || credit;
  return {
    imageCredit: cleanText(author ? `${objectName ? `${objectName} - ` : ""}${author}` : objectName, 360) || null,
    imageLicense: license || null,
    imageLicenseUrl: cleanMetadataUrl(metadata?.LicenseUrl?.value) || null,
  };
}

// The validated article's own lead image, with its Commons/enwiki credit.
async function articleLeadImage({ title, objectType, pageTitle }) {
  const lead = await leadImageFileFor(pageTitle);
  if (!lead?.fileName) return null;
  const meta = await imageFileMetadata(lead.fileName);
  const mime = String(meta?.info?.mime ?? "").toLowerCase();
  // SVG / TIFF lead images (constellation charts, EHT images) are fine when
  // Wikimedia gives us a rasterised thumbnail.
  const rasterThumb = /\.(?:jpe?g|png|webp|gif)(?:\?|$)/i.test(lead.thumbUrl ?? "");
  if (!meta || !(/^image\/(?:jpeg|png|webp|gif)$/.test(mime) || (mime.startsWith("image/") && rasterThumb))) return null;
  if (imageIsRejected(lead.fileName, meta.metadata)) {
    console.warn(`CosmosMap rejected lead image ${lead.fileName} for ${pageTitle}`);
    return null;
  }
  const remoteImageUrl = rasterThumb ? lead.thumbUrl : (/^image\/(?:jpeg|png|webp|gif)$/.test(mime) ? meta.info.url : null);
  if (!remoteImageUrl) return null;
  const image = await cachedRemoteImage(remoteImageUrl, title, objectType, `File:${lead.fileName}`);
  if (!image) return null;
  return {
    imageUrl: image.url,
    cachedImage: image.filename,
    remoteImageUrl,
    imageProvider: "Wikimedia Commons",
    imageSourceTitle: cleanText(lead.fileName.replace(/_/g, " "), 240),
    imageSourceUrl: meta.info.descriptionurl || commonsFilePageUrl(`File:${lead.fileName}`),
    ...imageCredit(lead.fileName, meta.metadata),
  };
}

function localDescription(title, objectType, subtitle) {
  const type = cleanText(objectType || "object", 60);
  const facts = cleanText(subtitle, 180);
  const article = /^[aeiou]/i.test(type) ? "an" : "a";
  return `${title} is shown in CosmosMap as ${article} ${type}${facts ? ` (${facts})` : ""}. ` +
    "No encyclopedia article could be verified for this object, so only local catalog data is shown.";
}

function localInfo({ title, objectType, subtitle }, reason) {
  return {
    cacheVersion: OBJECT_INFO_CACHE_VERSION,
    title,
    objectType,
    description: localDescription(title, objectType, subtitle),
    resolved: false,
    resolveReason: reason,
    resolvedPage: null,
    wikidataId: null,
    imageUrl: null,
    nasaId: null,
    sourceTitle: "CosmosMap catalog",
    sourceUrl: null,
    wikipediaUrl: null,
    cachedImage: null,
    remoteImageUrl: null,
    imageCredit: null,
    imageLicense: null,
    imageLicenseUrl: null,
    imageProvider: null,
    imageSourceTitle: null,
    imageSourceUrl: null,
    provider: "CosmosMap",
    cachedAt: new Date().toISOString(),
  };
}

async function objectInfo(params) {
  const { title, objectType } = params;
  if (isGenericObjectName(title)) return { info: localInfo(params, "generic"), cacheable: false };

  const resolved = await resolveWikipediaPage(params);
  if (!resolved.summary) {
    // Don't persist "not found" when the lookup was cut short by the network.
    return { info: localInfo(params, "unverified"), cacheable: !resolved.state.networkError };
  }

  const summary = resolved.summary;
  const resolvedPage = cleanText(summary.titles?.normalized || summary.title, 180);
  let image = null;
  try {
    image = await articleLeadImage({ title, objectType, pageTitle: resolvedPage });
  } catch (err) {
    console.warn(`CosmosMap lead image lookup failed for ${resolvedPage}:`, err?.message ?? err);
  }
  if (!image) {
    try {
      image = await curatedNasaImage({ title, objectType, resolvedPage });
    } catch (err) {
      console.warn(`CosmosMap NASA image lookup failed for ${title}:`, err?.message ?? err);
    }
  }

  const sourceUrl = summary?.content_urls?.desktop?.page || wikipediaPageUrl(resolvedPage);
  return {
    cacheable: true,
    info: {
      cacheVersion: OBJECT_INFO_CACHE_VERSION,
      title,
      objectType,
      description: cleanExcerpt(summary.extract),
      resolved: true,
      resolvedPage,
      wikidataId: summary.wikibase_item ?? null,
      wikipediaMatchKind: resolved.kind,
      validatedVia: resolved.via,
      imageUrl: image?.imageUrl ?? null,
      nasaId: null,
      sourceTitle: resolvedPage,
      sourceUrl,
      wikipediaUrl: sourceUrl,
      cachedImage: image?.cachedImage ?? null,
      remoteImageUrl: image?.remoteImageUrl ?? null,
      imageCredit: image?.imageCredit ?? null,
      imageLicense: image?.imageLicense ?? null,
      imageLicenseUrl: image?.imageLicenseUrl ?? null,
      imageProvider: image?.imageProvider ?? null,
      imageSourceTitle: image?.imageSourceTitle ?? null,
      imageSourceUrl: image?.imageSourceUrl ?? null,
      provider: "Wikipedia",
      cachedAt: new Date().toISOString(),
    },
  };
}

const inflightLookups = new Map();

async function objectInfoResponse(params) {
  const cacheFile = cacheFileFor(params.title, params.objectType, params.pageHint);
  const cached = await readCache(cacheFile);
  if (cached && !params.refresh && cacheIsFresh(cached)) {
    return { ...cached, cacheHit: true };
  }

  const inflightKey = `${cacheFile}\n${params.aliases.join("|")}`;
  const existing = inflightLookups.get(inflightKey);
  if (existing) return existing;

  const lookup = (async () => {
    try {
      const { info, cacheable } = await objectInfo(params);
      if (cacheable) await writeCache(cacheFile, info);
      else if (!info.resolved && cacheVersionIsCurrent(cached) && cached.resolved) {
        return { ...cached, cacheHit: true, stale: true, warning: "Returned stale cache after object lookup failed." };
      }
      return { ...info, cacheHit: false };
    } catch (err) {
      if (cacheVersionIsCurrent(cached)) {
        return { ...cached, cacheHit: true, stale: true, warning: "Returned stale cache after object lookup failed." };
      }
      throw err;
    }
  })();
  inflightLookups.set(inflightKey, lookup);
  try {
    return await lookup;
  } finally {
    inflightLookups.delete(inflightKey);
  }
}

async function serveCachedImage(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Allow": "GET, OPTIONS",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res);
    return true;
  }

  let filename;
  try {
    filename = decodeURIComponent(url.pathname.replace(/^\/api\/object-info\/image\//, ""));
  } catch {
    sendJson(res, 400, { error: "invalid_image_name" });
    return true;
  }
  if (!filename || filename !== path.basename(filename)) {
    sendJson(res, 400, { error: "invalid_image_name" });
    return true;
  }

  const imagePath = path.join(IMAGE_CACHE_DIR, filename);
  try {
    const info = await stat(imagePath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    sendJson(res, 404, { error: "image_not_found" });
    return true;
  }

  // Filenames are content-addressed (hash of source file + URL), so a given
  // name always maps to the same bytes and may be cached aggressively.
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Accept, Content-Type",
    "Content-Type": mimeFromExt(imagePath),
    "Cache-Control": "public, max-age=604800, immutable",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  const stream = createReadStream(imagePath);
  stream.on("error", err => res.destroy(err));
  stream.pipe(res);
  return true;
}

export async function handleObjectInfoRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/api/object-info/image/")) {
    return serveCachedImage(req, res, url);
  }

  if (url.pathname !== "/api/object-info") return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Accept, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Allow": "GET, OPTIONS",
    });
    res.end();
    return true;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res);
    return true;
  }

  const title = cleanText(url.searchParams.get("title"), 120);
  if (!title) {
    sendJson(res, 400, { error: "missing_title" });
    return true;
  }

  const objectType = cleanText(url.searchParams.get("type") || "object", 60);
  const subtitle = cleanText(url.searchParams.get("subtitle") || "", 180);
  // Optional catalog-derived hints: `page` is a Wikipedia title for the
  // physical object (e.g. a 3D model variant's base object); `aliases` is a
  // "|"-separated list of alternative names / designations.
  const pageHint = cleanText(url.searchParams.get("page") || "", 180);
  const aliases = String(url.searchParams.get("aliases") || "")
    .split("|")
    .map(alias => cleanText(alias, 80))
    .filter(Boolean)
    .slice(0, MAX_ALIASES);
  const refresh = url.searchParams.get("refresh") === "1";

  try {
    const payload = await objectInfoResponse({ title, objectType, subtitle, pageHint, aliases, refresh });
    sendJson(res, 200, payload);
  } catch (err) {
    console.error("CosmosMap object-info lookup failed:", err);
    sendJson(res, 502, {
      ...localInfo({ title, objectType, subtitle }, "lookup_failed"),
      error: "object_lookup_failed",
    });
  }

  return true;
}

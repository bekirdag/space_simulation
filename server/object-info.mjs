import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const CACHE_ROOT = process.env.COSMOSMAP_OBJECT_INFO_CACHE_DIR
  ? path.resolve(process.env.COSMOSMAP_OBJECT_INFO_CACHE_DIR)
  : path.join(REPO_ROOT, "cache", "nasa", "object-info");
const IMAGE_CACHE_DIR = path.join(CACHE_ROOT, "images");
const NASA_IMAGES_API = "https://images-api.nasa.gov";
const NASA_IMAGES_WEB = "https://images.nasa.gov";
const NASA_SCIENCE_WEB = "https://science.nasa.gov";
const NASA_SCIENCE_SEARCH_API = `${NASA_SCIENCE_WEB}/wp-json/wp/v2/search`;
const WIKIPEDIA_SUMMARY_API = "https://en.wikipedia.org/api/rest_v1/page/summary";
const WIKIPEDIA_WEB = "https://en.wikipedia.org/wiki";
const OBJECT_INFO_CACHE_VERSION = 4;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_CACHE_TTL_DAYS = 30;
const GENERAL_DESCRIPTION_MAX_LENGTH = 1400;
const JSON_FETCH_TIMEOUT_MS = 10_000;
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
const WIKIPEDIA_OBJECT_PAGES = new Map([
  ["sun", "Sun"],
  ["mercury", "Mercury (planet)"],
  ["venus", "Venus"],
  ["earth", "Earth"],
  ["moon", "Moon"],
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
  ["io", "Io (moon)"],
  ["europa", "Europa (moon)"],
  ["ganymede", "Ganymede (moon)"],
  ["callisto", "Callisto (moon)"],
  ["titan", "Titan (moon)"],
  ["enceladus", "Enceladus"],
  ["triton", "Triton (moon)"],
  ["charon", "Charon (moon)"],
  ["milky way", "Milky Way"],
  ["andromeda galaxy", "Andromeda Galaxy"],
  ["large magellanic cloud", "Large Magellanic Cloud"],
  ["small magellanic cloud", "Small Magellanic Cloud"],
  ["sgr a", "Sagittarius A*"],
  ["sagittarius a", "Sagittarius A*"],
  ["proxima centauri", "Proxima Centauri"],
  ["alpha centauri", "Alpha Centauri"],
  ["barnard s star", "Barnard's Star"],
]);
const HTML_FETCH_TIMEOUT_MS = 10_000;

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
    .replace(/\s*\[\s*(?:\.{3}|\u2026)\s*\]\s*$/u, "")
    .replace(/\s*(?:\.{3}|\u2026)\s*$/u, "")
    .trim();
}

function objectLookupKey(value) {
  return normalizeForMatch(value)
    .slice(0, 120);
}

function normalizeForMatch(value) {
  return cleanText(value, 240)
    .toLowerCase()
    .replace(/\*/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugify(value, fallback = "object") {
  const slug = cleanText(value, 120)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || fallback;
}

function cacheFileFor(title, objectType) {
  const base = slugify(`${objectType}-${title}`);
  const hash = createHash("sha256").update(`${objectType}\n${title}`).digest("hex").slice(0, 14);
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
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeCache(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempFile = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(tempFile, filePath);
}

function cacheIsFresh(payload) {
  if (!cacheVersionIsCurrent(payload)) return false;
  if (!payload?.cachedAt) return false;
  const ttl = cacheTtlMs();
  if (ttl === 0) return false;
  const cachedMs = Date.parse(payload.cachedAt);
  return Number.isFinite(cachedMs) && Date.now() - cachedMs <= ttl;
}

function cacheVersionIsCurrent(payload) {
  return payload?.cacheVersion === OBJECT_INFO_CACHE_VERSION;
}

function sourceDetailsUrl(nasaId) {
  return nasaId ? `${NASA_IMAGES_WEB}/details/${encodeURIComponent(nasaId)}` : NASA_IMAGES_WEB;
}

function fallbackDescription(title, objectType) {
  return `No encyclopedic object record was returned for ${title}. The object is still selectable in CosmosMap as a ${objectType}.`;
}

function cleanMediaDescription(value, title, objectType) {
  const text = cleanText(value, GENERAL_DESCRIPTION_MAX_LENGTH)
    .replace(/^NASA image release\s+[A-Za-z]+ \d{1,2}, \d{4}\s*/i, "")
    .replace(/\s*NASA image use policy\..*$/i, "")
    .replace(/\s*To read more go to:.*$/i, "")
    .trim();
  return text || fallbackDescription(title, objectType);
}

async function tryInfoSource(label, producer) {
  try {
    return await producer();
  } catch (err) {
    console.warn(`CosmosMap ${label} lookup failed:`, err);
    return null;
  }
}

function normalizedSearchTerms(title, objectType, subtitle) {
  const lowerTitle = title.toLowerCase();
  const lowerType = objectType.toLowerCase();
  const queries = [];

  if (lowerTitle === "sgr a*" || lowerTitle.includes("sagittarius a")) {
    queries.push("Sagittarius A* black hole", "Milky Way center black hole", "galactic center black hole");
  } else if (lowerTitle === "milky way") {
    queries.push("Milky Way galaxy", "Milky Way center");
  } else if (lowerTitle === "sun") {
    queries.push("Sun star", "Solar Dynamics Observatory Sun");
  } else if (lowerTitle === "moon") {
    queries.push("Moon lunar surface", "Moon");
  } else if (lowerType.includes("black hole")) {
    queries.push(`${title} black hole`, title);
  } else if (lowerType.includes("galaxy")) {
    queries.push(`${title} galaxy`, title);
  } else if (lowerType.includes("nebula")) {
    queries.push(`${title} nebula`, title);
  } else if (lowerType.includes("moon")) {
    queries.push(`${title} moon`, title);
  } else if (lowerType.includes("planet") || lowerType.includes("dwarf")) {
    queries.push(`${title} planet`, title);
  } else if (lowerType.includes("star")) {
    queries.push(`${title} star`, title);
  } else {
    queries.push(`${title} ${objectType}`.trim(), title);
  }

  if (subtitle) queries.push(`${title} ${subtitle}`.replace(/[\u00b7;:,()[\]]+/g, " "));
  return [...new Set(queries.map(q => cleanText(q, 120)).filter(Boolean))];
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JSON_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Accept": "application/json",
        "User-Agent": "CosmosMap object-info cache (https://github.com/bekirdag/space_simulation)",
      },
    });
    if (!response.ok) throw new Error(`NASA request failed: ${response.status} ${response.statusText}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTML_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "CosmosMap object-info cache (https://github.com/bekirdag/space_simulation)",
      },
    });
    if (!response.ok) throw new Error(`NASA Science request failed: ${response.status} ${response.statusText}`);
    return { html: await response.text(), url: response.url };
  } finally {
    clearTimeout(timeout);
  }
}

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

function pageTitle(html, fallback) {
  const title = cleanText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "", 240)
    .replace(/\s*-\s*NASA Science$/i, "")
    .replace(/\s*\|\s*NASA$/i, "");
  return title || fallback;
}

function articleHtml(html) {
  return html.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ??
    html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] ??
    html;
}

function removeNonContentHtml(html) {
  return String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav\b[\s\S]*?<\/nav>/gi, " ")
    .replace(/<button\b[\s\S]*?<\/button>/gi, " ")
    .replace(/<form\b[\s\S]*?<\/form>/gi, " ")
    .replace(/<figure\b[\s\S]*?<\/figure>/gi, " ")
    .replace(/<figcaption\b[\s\S]*?<\/figcaption>/gi, " ");
}

function htmlSectionByHeadingId(html, headingId) {
  const escapedId = headingId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp(`<h[1-6]\\b[^>]*\\bid\\s*=\\s*["']${escapedId}["'][^>]*>[\\s\\S]*?<\\/h[1-6]>`, "i").exec(html);
  if (!heading) return "";

  const start = heading.index + heading[0].length;
  const rest = html.slice(start);
  const nextHeading = /<h[1-6]\b/i.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function isUsefulInfoParagraph(text) {
  if (text.length < 45) return false;
  if (/^(?:explore this section|facts|resources|related|credits?)\b/i.test(text)) return false;
  if (/\b(?:subscribe|newsletter|cookie|privacy policy|terms of use)\b/i.test(text)) return false;
  if (/^(?:NASA|ESA|JPL|Caltech|STScI)(?:[\/\-\s]|$)/i.test(text) && text.length < 120) return false;
  return true;
}

function paragraphTextsFromHtml(html) {
  const cleanedHtml = removeNonContentHtml(html);
  return [...cleanedHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(match => cleanText(match[1], 1000))
    .filter(isUsefulInfoParagraph);
}

function joinDescriptionParagraphs(paragraphs, maxLength = GENERAL_DESCRIPTION_MAX_LENGTH) {
  const selected = [];
  const seen = new Set();
  let length = 0;

  for (const paragraph of paragraphs) {
    const key = normalizeForMatch(paragraph);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const separatorLength = selected.length > 0 ? 2 : 0;
    if (length + separatorLength + paragraph.length > maxLength) {
      if (selected.length === 0) selected.push(paragraph.slice(0, maxLength).replace(/\s+\S*$/, "").trim());
      break;
    }
    selected.push(paragraph);
    length += separatorLength + paragraph.length;
    if (selected.length >= 3) break;
  }

  return selected.join("\n\n").trim();
}

function scienceDescriptionFromHtml(html, fallback = "") {
  const sourceHtml = articleHtml(html);
  const sectionIds = ["h-introduction", "h-overview", "h-about", "h-in-depth"];
  for (const sectionId of sectionIds) {
    const sectionHtml = htmlSectionByHeadingId(sourceHtml, sectionId);
    const description = joinDescriptionParagraphs(paragraphTextsFromHtml(sectionHtml));
    if (description) return description;
  }

  const articleDescription = joinDescriptionParagraphs(paragraphTextsFromHtml(sourceHtml));
  return articleDescription || cleanExcerpt(fallback);
}

function firstImageFromHtml(html) {
  const tag = String(html ?? "").match(/<img\b[^>]*>/i)?.[0];
  const src = tag ? htmlAttr(tag, "src") : "";
  return src ? decodeHtmlEntities(src) : "";
}

function dataForItem(item) {
  return Array.isArray(item?.data) ? item.data[0] ?? {} : {};
}

function previewImageForItem(item) {
  const links = Array.isArray(item?.links) ? item.links : [];
  const imageLink = links.find(link => link?.render === "image" && typeof link?.href === "string");
  return imageLink?.href ?? null;
}

function itemSearchBlob(item) {
  const data = dataForItem(item);
  return [
    data.title,
    data.description,
    Array.isArray(data.keywords) ? data.keywords.join(" ") : "",
  ].join(" ").toLowerCase();
}

function scoreItem(item, title, objectType) {
  const data = dataForItem(item);
  if (data.media_type !== "image") return -1000;
  const blob = itemSearchBlob(item);
  const itemTitle = String(data.title ?? "");
  const normalizedTitle = title.toLowerCase().replace(/\*/g, "").trim();
  const words = normalizedTitle.split(/[^a-z0-9]+/).filter(w => w.length > 1);
  let score = previewImageForItem(item) ? 10 : 0;

  if (blob.includes(normalizedTitle)) score += 60;
  for (const word of words) {
    if (blob.includes(word)) score += 12;
  }
  for (const word of objectType.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    if (blob.includes(word)) score += 8;
  }
  if (cleanText(data.description, 500).length > 80) score += 8;
  if (/\b(logo|insignia|patch|poster)\b/i.test(itemTitle)) score -= 18;
  if (/\blaunch vehicles?\b/i.test(itemTitle)) score -= 90;
  if (/\b(?:launch|spacecraft|mission|probe|rover|astronaut)\b/i.test(blob)) {
    if (/\b(?:planet|dwarf|moon)\b/i.test(objectType)) score -= 35;
    else score -= 12;
  }
  return score;
}

function chooseSearchItem(items, title, objectType) {
  const imageItems = (Array.isArray(items) ? items : []).filter(item => dataForItem(item).media_type === "image");
  if (imageItems.length === 0) return null;
  return imageItems
    .map(item => ({ item, score: scoreItem(item, title, objectType) }))
    .sort((a, b) => b.score - a.score)[0]?.item ?? null;
}

function selectAssetImage(assetJson, fallbackUrl) {
  const items = Array.isArray(assetJson?.collection?.items) ? assetJson.collection.items : [];
  const hrefs = items
    .map(item => typeof item?.href === "string" ? item.href : "")
    .filter(href => /^https?:\/\//.test(href))
    .filter(href => /\.(jpe?g|png|webp|gif)(\?|$)/i.test(new URL(href).pathname));

  if (hrefs.length === 0) return fallbackUrl;
  return hrefs
    .map(href => {
      const lower = href.toLowerCase();
      let rank = 30;
      if (lower.includes("~medium")) rank = 90;
      else if (lower.includes("~small")) rank = 80;
      else if (lower.includes("~large")) rank = 70;
      else if (lower.includes("~orig")) rank = 55;
      else if (lower.includes("~thumb")) rank = 20;
      return { href, rank };
    })
    .sort((a, b) => b.rank - a.rank)[0]?.href ?? fallbackUrl;
}

async function cachedRemoteImage(imageUrl, title, objectType, sourceId) {
  if (!imageUrl) return null;
  await mkdir(IMAGE_CACHE_DIR, { recursive: true });

  const probe = await fetch(imageUrl, {
    headers: { "User-Agent": "CosmosMap object-info cache" },
  });
  if (!probe.ok) throw new Error(`Remote image request failed: ${probe.status} ${probe.statusText}`);

  const length = Number.parseInt(probe.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
    throw new Error(`Remote image is too large to cache (${length} bytes)`);
  }

  const contentType = probe.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`NASA image response is not an image (${contentType || "unknown content type"})`);
  }

  const buffer = Buffer.from(await probe.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Remote image is too large to cache (${buffer.byteLength} bytes)`);
  }

  const hash = createHash("sha256").update(`${sourceId ?? ""}\n${imageUrl}`).digest("hex").slice(0, 14);
  const filename = `${slugify(`${objectType}-${title}`)}-${hash}${extFromMime(contentType, imageUrl)}`;
  await writeFile(path.join(IMAGE_CACHE_DIR, filename), buffer);
  return { filename, url: imageRouteFor(filename) };
}

function scienceSearchTerms(title, objectType, subtitle) {
  const lowerTitle = title.toLowerCase();
  const baseTitle = cleanText(title.replace(/\*/g, " "), 100);
  const queries = [];

  if (lowerTitle === "sgr a*" || lowerTitle.includes("sagittarius a")) {
    queries.push("Sagittarius A black hole");
  } else {
    queries.push(baseTitle);
  }

  return [...new Set(queries
    .map(query => cleanText(query, 120).replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim())
    .filter(query => query.length >= 2))];
}

function scienceSearchHref(item) {
  return item?._links?.self?.find(link => typeof link?.href === "string")?.href ?? "";
}

function scienceSearchItemScore(item, title, objectType) {
  const href = scienceSearchHref(item);
  if (!href) return -1000;

  const normalizedTitle = normalizeForMatch(title);
  const titleWords = normalizedTitle.split(" ").filter(word => word.length > 1);
  const objectWords = normalizeForMatch(objectType).split(" ").filter(word => word.length > 2);
  const itemTitle = normalizeForMatch(item?.title ?? "");
  const itemUrl = String(item?.url ?? "").toLowerCase();
  const blob = normalizeForMatch(`${item?.title ?? ""} ${item?.url ?? ""} ${item?.subtype ?? ""}`);
  let score = 0;

  if (item?.subtype === "topic") score += 35;
  else if (item?.subtype === "page") score += 22;
  else if (item?.subtype === "post") score += 12;
  else if (["stma", "attachment", "page-ext"].includes(item?.subtype)) score -= 45;

  if (itemTitle === normalizedTitle || itemTitle === `${normalizedTitle} facts`) score += 70;
  if (normalizedTitle && blob.includes(normalizedTitle)) score += 45;
  for (const word of titleWords) {
    if (blob.includes(word)) score += 10;
  }
  for (const word of objectWords) {
    if (blob.includes(word)) score += 5;
  }
  if (/\bfacts?\b/.test(itemTitle)) score += 12;
  if (/\/(?:photojournal|asset)\//.test(itemUrl) || /\b(?:image|imaged|photo|gallery)\b/.test(itemTitle)) score -= 28;
  return score;
}

function chooseScienceSearchItem(items, title, objectType) {
  const ranked = (Array.isArray(items) ? items : [])
    .map(item => ({ item, score: scienceSearchItemScore(item, title, objectType) }))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return best && best.score >= 20 ? best.item : null;
}

function scienceRecordImageUrl(record, contentHtml) {
  return record?.featured_image?.file ||
    record?.parsely?.meta?.image?.url ||
    record?.parsely?.meta?.thumbnailUrl ||
    firstImageFromHtml(contentHtml) ||
    null;
}

function wikipediaPageTitle(title) {
  return WIKIPEDIA_OBJECT_PAGES.get(objectLookupKey(title)) || cleanText(title, 120);
}

function wikipediaPageUrl(title) {
  return `${WIKIPEDIA_WEB}/${encodeURIComponent(title.replace(/\s+/g, "_"))}`;
}

function isUsableWikipediaSummary(summary) {
  const extract = cleanText(summary?.extract, GENERAL_DESCRIPTION_MAX_LENGTH);
  if (summary?.type === "disambiguation") return false;
  if (summary?.type === "no-extract") return false;
  if (extract.length < 80) return false;
  return true;
}

async function wikipediaObjectInfo({ title, objectType }) {
  const pageTitle = wikipediaPageTitle(title);
  if (!pageTitle) return null;

  const url = new URL(`${WIKIPEDIA_SUMMARY_API}/${encodeURIComponent(pageTitle)}`);
  url.searchParams.set("redirect", "true");

  const summary = await fetchJson(url);
  if (!isUsableWikipediaSummary(summary)) return null;

  const description = cleanText(summary.extract, GENERAL_DESCRIPTION_MAX_LENGTH);
  const remoteImageUrl = summary?.thumbnail?.source || summary?.originalimage?.source || null;
  let image = null;
  try {
    image = await cachedRemoteImage(remoteImageUrl, title, objectType, summary?.pageid ?? pageTitle);
  } catch (err) {
    console.warn("CosmosMap Wikipedia image cache failed:", err);
  }

  return {
    cacheVersion: OBJECT_INFO_CACHE_VERSION,
    title,
    objectType,
    description,
    imageUrl: image?.url ?? null,
    nasaId: null,
    sourceTitle: `Wikipedia: ${cleanText(summary.title || pageTitle, 180)}`,
    sourceUrl: summary?.content_urls?.desktop?.page || wikipediaPageUrl(pageTitle),
    query: pageTitle,
    cachedImage: image?.filename ?? null,
    remoteImageUrl,
    provider: "Wikipedia",
    cachedAt: new Date().toISOString(),
  };
}

async function nasaScienceRecordInfo({ record, searchItem, title, objectType }) {
  const contentHtml = record?.content?.rendered ?? "";
  const fallback = record?.excerpt?.rendered || record?.parsely?.meta?.description || "";
  const description = scienceDescriptionFromHtml(contentHtml, fallback);
  if (!description) return null;

  const remoteImageUrl = scienceRecordImageUrl(record, contentHtml);
  let image = null;
  try {
    image = await cachedRemoteImage(remoteImageUrl, title, objectType, record?.id ?? record?.link ?? searchItem?.url);
  } catch (err) {
    console.warn("CosmosMap NASA Science image cache failed:", err);
  }

  return {
    cacheVersion: OBJECT_INFO_CACHE_VERSION,
    title,
    objectType,
    description,
    imageUrl: image?.url ?? null,
    nasaId: null,
    sourceTitle: cleanText(record?.title?.rendered || searchItem?.title || `${title}: NASA Science`, 240),
    sourceUrl: record?.link || searchItem?.url || NASA_SCIENCE_WEB,
    query: searchItem?.url || "",
    cachedImage: image?.filename ?? null,
    remoteImageUrl,
    provider: "NASA Science",
    cachedAt: new Date().toISOString(),
  };
}

async function nasaScienceObjectInfo({ title, objectType }) {
  const sourcePage = NASA_SCIENCE_OBJECT_PAGES.get(objectLookupKey(title));
  if (!sourcePage) return null;

  const { html, url } = await fetchText(sourcePage);
  const metaDescription = metaContent(html, ["description", "og:description"], GENERAL_DESCRIPTION_MAX_LENGTH);
  const description = scienceDescriptionFromHtml(html, metaDescription);
  if (!description) return null;

  const remoteImageUrl = metaContent(html, ["og:image"], 1000) || firstImageFromHtml(html) || null;
  let image = null;
  try {
    image = await cachedRemoteImage(remoteImageUrl, title, objectType, url);
  } catch (err) {
    console.warn("CosmosMap NASA Science image cache failed:", err);
  }

  return {
    cacheVersion: OBJECT_INFO_CACHE_VERSION,
    title,
    objectType,
    description,
    imageUrl: image?.url ?? null,
    nasaId: null,
    sourceTitle: pageTitle(html, `${title}: Facts`),
    sourceUrl: url,
    query: sourcePage,
    cachedImage: image?.filename ?? null,
    remoteImageUrl,
    provider: "NASA Science",
    cachedAt: new Date().toISOString(),
  };
}

async function nasaScienceSearchInfo({ title, objectType, subtitle }) {
  for (const query of scienceSearchTerms(title, objectType, subtitle)) {
    try {
      const url = new URL(NASA_SCIENCE_SEARCH_API);
      url.searchParams.set("search", query);
      url.searchParams.set("per_page", "8");

      const searchJson = await fetchJson(url);
      const item = chooseScienceSearchItem(searchJson, title, objectType);
      const href = scienceSearchHref(item);
      if (!href) continue;

      const record = await fetchJson(href);
      const info = await nasaScienceRecordInfo({ record, searchItem: item, title, objectType });
      if (info) return info;
    } catch (err) {
      console.warn("CosmosMap NASA Science search failed:", err);
    }
  }
  return null;
}

async function nasaImagesObjectInfo({ title, objectType, subtitle }) {
  const queries = normalizedSearchTerms(title, objectType, subtitle);

  for (const query of queries) {
    const url = new URL("/search", NASA_IMAGES_API);
    url.searchParams.set("q", query);
    url.searchParams.set("media_type", "image");
    url.searchParams.set("page_size", "12");

    const searchJson = await fetchJson(url);
    const item = chooseSearchItem(searchJson?.collection?.items, title, objectType);
    if (!item) continue;

    const data = dataForItem(item);
    const nasaId = cleanText(data.nasa_id, 120);
    let remoteImageUrl = previewImageForItem(item);
    if (nasaId) {
      try {
        const assetJson = await fetchJson(`${NASA_IMAGES_API}/asset/${encodeURIComponent(nasaId)}`);
        remoteImageUrl = selectAssetImage(assetJson, remoteImageUrl);
      } catch {
        // The search result preview is good enough if the manifest endpoint is unavailable.
      }
    }

    let image = null;
    try {
      image = await cachedRemoteImage(remoteImageUrl, title, objectType, nasaId);
    } catch (err) {
      console.warn("CosmosMap object-info image cache failed:", err);
    }

    return {
      cacheVersion: OBJECT_INFO_CACHE_VERSION,
      title,
      objectType,
      description: cleanMediaDescription(data.description || data.description_508, title, objectType),
      imageUrl: image?.url ?? null,
      nasaId: nasaId || null,
      sourceTitle: cleanText(data.title || title, 240),
      sourceUrl: sourceDetailsUrl(nasaId),
      query,
      cachedImage: image?.filename ?? null,
      remoteImageUrl: remoteImageUrl ?? null,
      provider: "NASA Image and Video Library",
      cachedAt: new Date().toISOString(),
    };
  }

  return {
    cacheVersion: OBJECT_INFO_CACHE_VERSION,
    title,
    objectType,
    description: fallbackDescription(title, objectType),
    imageUrl: null,
    nasaId: null,
    sourceTitle: "NASA Image and Video Library",
    sourceUrl: NASA_IMAGES_WEB,
    query: queries[0] ?? title,
    cachedImage: null,
    remoteImageUrl: null,
    provider: "NASA Image and Video Library",
    cachedAt: new Date().toISOString(),
  };
}

async function withFallbackImage(info, params) {
  if (info.imageUrl) return info;

  try {
    const imageInfo = await nasaImagesObjectInfo(params);
    if (!imageInfo.imageUrl) return info;
    return {
      ...info,
      imageUrl: imageInfo.imageUrl,
      cachedImage: imageInfo.cachedImage,
      remoteImageUrl: imageInfo.remoteImageUrl,
      imageProvider: imageInfo.provider,
      imageSourceTitle: imageInfo.sourceTitle,
      imageSourceUrl: imageInfo.sourceUrl,
    };
  } catch (err) {
    console.warn("CosmosMap NASA fallback image lookup failed:", err);
    return info;
  }
}

async function nasaObjectInfo({ title, objectType, subtitle }) {
  const params = { title, objectType, subtitle };
  const directScienceInfo = await tryInfoSource("NASA Science facts", () => nasaScienceObjectInfo({ title, objectType }));
  if (directScienceInfo) return withFallbackImage(directScienceInfo, params);

  const wikipediaInfo = await tryInfoSource("Wikipedia summary", () => wikipediaObjectInfo(params));
  if (wikipediaInfo) return withFallbackImage(wikipediaInfo, params);

  const searchedScienceInfo = await tryInfoSource("NASA Science search", () => nasaScienceSearchInfo(params));
  if (searchedScienceInfo) return withFallbackImage(searchedScienceInfo, params);

  return withFallbackImage({
    cacheVersion: OBJECT_INFO_CACHE_VERSION,
    title,
    objectType,
    description: fallbackDescription(title, objectType),
    imageUrl: null,
    nasaId: null,
    sourceTitle: "No encyclopedic source matched",
    sourceUrl: NASA_SCIENCE_WEB,
    query: title,
    cachedImage: null,
    remoteImageUrl: null,
    provider: "CosmosMap",
    cachedAt: new Date().toISOString(),
  }, params);
}

async function objectInfoResponse(params) {
  const cacheFile = cacheFileFor(params.title, params.objectType);
  const cached = await readCache(cacheFile);
  if (cached && !params.refresh && cacheIsFresh(cached)) {
    return { ...cached, cacheHit: true };
  }

  try {
    const fresh = await nasaObjectInfo(params);
    await writeCache(cacheFile, fresh);
    return { ...fresh, cacheHit: false };
  } catch (err) {
    if (cacheVersionIsCurrent(cached)) {
      return { ...cached, cacheHit: true, stale: true, warning: "Returned stale cache after NASA lookup failed." };
    }
    throw err;
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
  createReadStream(imagePath).pipe(res);
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
  const refresh = url.searchParams.get("refresh") === "1";

  try {
    const payload = await objectInfoResponse({ title, objectType, subtitle, refresh });
    sendJson(res, 200, payload);
  } catch (err) {
    console.error("CosmosMap object-info lookup failed:", err);
    sendJson(res, 502, {
      error: "nasa_lookup_failed",
      title,
      objectType,
      description: fallbackDescription(title, objectType),
    });
  }

  return true;
}

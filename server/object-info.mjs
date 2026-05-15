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
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const DEFAULT_CACHE_TTL_DAYS = 30;

function cacheTtlMs() {
  const raw = Number.parseFloat(process.env.COSMOSMAP_OBJECT_INFO_CACHE_TTL_DAYS ?? "");
  const days = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_CACHE_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function cleanText(value, maxLength = 240) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
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
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res) {
  res.writeHead(405, {
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
  if (!payload?.cachedAt) return false;
  const ttl = cacheTtlMs();
  if (ttl === 0) return false;
  const cachedMs = Date.parse(payload.cachedAt);
  return Number.isFinite(cachedMs) && Date.now() - cachedMs <= ttl;
}

function sourceDetailsUrl(nasaId) {
  return nasaId ? `${NASA_IMAGES_WEB}/details/${encodeURIComponent(nasaId)}` : NASA_IMAGES_WEB;
}

function fallbackDescription(title, objectType) {
  return `NASA Images did not return a matching image record for ${title}. The object is still selectable in CosmosMap as a ${objectType}.`;
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

  if (subtitle) queries.push(`${title} ${subtitle}`.replace(/[·;:,()[\]]+/g, " "));
  return [...new Set(queries.map(q => cleanText(q, 120)).filter(Boolean))];
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "CosmosMap object-info cache (https://github.com/bekirdag/space_simulation)",
    },
  });
  if (!response.ok) throw new Error(`NASA request failed: ${response.status} ${response.statusText}`);
  return response.json();
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
  if (/\b(logo|insignia|patch|poster)\b/i.test(String(data.title ?? ""))) score -= 18;
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

async function cachedImageFromNasa(imageUrl, title, objectType, nasaId) {
  if (!imageUrl) return null;
  await mkdir(IMAGE_CACHE_DIR, { recursive: true });

  const probe = await fetch(imageUrl, {
    headers: { "User-Agent": "CosmosMap object-info cache" },
  });
  if (!probe.ok) throw new Error(`NASA image request failed: ${probe.status} ${probe.statusText}`);

  const length = Number.parseInt(probe.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
    throw new Error(`NASA image is too large to cache (${length} bytes)`);
  }

  const contentType = probe.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error(`NASA image response is not an image (${contentType || "unknown content type"})`);
  }

  const buffer = Buffer.from(await probe.arrayBuffer());
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`NASA image is too large to cache (${buffer.byteLength} bytes)`);
  }

  const hash = createHash("sha256").update(`${nasaId ?? ""}\n${imageUrl}`).digest("hex").slice(0, 14);
  const filename = `${slugify(`${objectType}-${title}`)}-${hash}${extFromMime(contentType, imageUrl)}`;
  await writeFile(path.join(IMAGE_CACHE_DIR, filename), buffer);
  return { filename, url: imageRouteFor(filename) };
}

async function nasaObjectInfo({ title, objectType, subtitle }) {
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
      image = await cachedImageFromNasa(remoteImageUrl, title, objectType, nasaId);
    } catch (err) {
      console.warn("CosmosMap object-info image cache failed:", err);
    }

    return {
      title,
      objectType,
      description: cleanText(data.description || data.description_508 || fallbackDescription(title, objectType), 1800),
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
    if (cached) return { ...cached, cacheHit: true, stale: true, warning: "Returned stale cache after NASA lookup failed." };
    throw err;
  }
}

async function serveCachedImage(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Allow": "GET, OPTIONS" });
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
    "Content-Type": mimeFromExt(imagePath),
    "Cache-Control": "public, max-age=604800, immutable",
    "Cross-Origin-Resource-Policy": "same-origin",
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
    res.writeHead(204, { "Allow": "GET, OPTIONS" });
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

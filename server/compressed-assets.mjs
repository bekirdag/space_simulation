import { createReadStream } from "node:fs";
import path from "node:path";
import {
  constants as zlibConstants,
  createBrotliCompress,
  createGzip,
} from "node:zlib";

const MIN_COMPRESS_BYTES = 2048;
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".bin",
  ".css",
  ".geojson",
  ".glb",
  ".html",
  ".js",
  ".json",
  ".stl",
  ".svg",
  ".wasm",
  ".wgsl",
]);
const ALREADY_COMPRESSED_EXTENSIONS = new Set([
  ".7z",
  ".br",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp4",
  ".png",
  ".webp",
  ".zip",
]);

function appendVary(value, token) {
  if (!value) return token;
  const parts = String(value).split(",").map(part => part.trim().toLowerCase());
  return parts.includes(token.toLowerCase()) ? value : `${value}, ${token}`;
}

function acceptEncoding(req) {
  const raw = req.headers["accept-encoding"];
  return Array.isArray(raw) ? raw.join(",") : raw ?? "";
}

function acceptsToken(header, token) {
  return header
    .split(",")
    .map(part => part.trim().toLowerCase())
    .some(part => part === token || part.startsWith(`${token};`));
}

function shouldCompressAsset(filePath, contentType, size) {
  if (size < MIN_COMPRESS_BYTES) return false;
  const ext = path.extname(filePath).toLowerCase();
  if (ALREADY_COMPRESSED_EXTENSIONS.has(ext)) return false;
  if (COMPRESSIBLE_EXTENSIONS.has(ext)) return true;
  return /^(application\/json|text\/|image\/svg\+xml)\b/i.test(contentType);
}

function compressionEncoding(req, filePath, contentType, size) {
  if (!shouldCompressAsset(filePath, contentType, size)) return null;
  const accepted = acceptEncoding(req);
  if (acceptsToken(accepted, "br")) return "br";
  if (acceptsToken(accepted, "gzip")) return "gzip";
  return null;
}

function compressionStream(encoding) {
  if (encoding === "br") {
    return createBrotliCompress({
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
      },
    });
  }
  return createGzip({ level: 6 });
}

// Unhashed assets (/data, /textures, /cache, model downloads...) are served
// with `Cache-Control: no-cache` plus these validators, so browsers revalidate
// every use and get a cheap 304 until the file actually changes.
function assetEtag(size, mtimeMs) {
  // Weak: the same validator covers the identity, gzip and br representations.
  return `W/"${Number(size).toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

function requestHeader(req, name) {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw.join(",") : raw ?? "";
}

function isNotModified(req, etag, mtimeMs) {
  const ifNoneMatch = requestHeader(req, "if-none-match");
  if (ifNoneMatch) {
    const opaque = etag.replace(/^W\//, "");
    return ifNoneMatch
      .split(",")
      .map(tag => tag.trim())
      .some(tag => tag === "*" || tag.replace(/^W\//, "") === opaque);
  }
  const since = Date.parse(requestHeader(req, "if-modified-since"));
  return Number.isFinite(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

export function sendAssetFile(req, res, {
  filePath,
  size,
  contentType,
  headers = {},
  statusCode = 200,
  mtimeMs,
}) {
  const encoding = compressionEncoding(req, filePath, contentType, size);
  const responseHeaders = {
    ...headers,
    "Content-Type": contentType,
    "Vary": appendVary(headers["Vary"], "Accept-Encoding"),
  };

  if (Number.isFinite(mtimeMs)) {
    const etag = assetEtag(size, mtimeMs);
    responseHeaders["ETag"] = etag;
    responseHeaders["Last-Modified"] = new Date(mtimeMs).toUTCString();
    if (statusCode === 200 && (req.method === "GET" || req.method === "HEAD") && isNotModified(req, etag, mtimeMs)) {
      delete responseHeaders["Content-Type"];
      res.writeHead(304, responseHeaders);
      res.end();
      return;
    }
  }

  if (encoding) {
    responseHeaders["Content-Encoding"] = encoding;
  } else {
    responseHeaders["Content-Length"] = String(size);
  }

  res.writeHead(statusCode, responseHeaders);
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const source = createReadStream(filePath);
  source.on("error", err => res.destroy(err));

  if (!encoding) {
    source.pipe(res);
    return;
  }

  const compressed = compressionStream(encoding);
  compressed.on("error", err => res.destroy(err));
  source.pipe(compressed).pipe(res);
}

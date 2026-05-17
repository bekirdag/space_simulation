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

export function sendAssetFile(req, res, {
  filePath,
  size,
  contentType,
  headers = {},
  statusCode = 200,
}) {
  const encoding = compressionEncoding(req, filePath, contentType, size);
  const responseHeaders = {
    ...headers,
    "Content-Type": contentType,
    "Vary": appendVary(headers["Vary"], "Accept-Encoding"),
  };

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

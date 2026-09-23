// POST /api/client-diagnostics — compact WebGPU diagnostics reports from the
// web app (src/gpu/gpu-diagnostics.ts) and the iPad app's /api proxy.
//
// Each accepted report is appended as one JSON line to
// cache/diagnostics/client-diagnostics.log (rotated to .1 at ~20 MB).
// Requests are limited to 64 KB of application/json and 20 per IP per hour.

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const LOG_DIR = process.env.COSMOSMAP_DIAGNOSTICS_DIR
  ? path.resolve(process.env.COSMOSMAP_DIAGNOSTICS_DIR)
  : path.join(REPO_ROOT, "cache", "diagnostics");
const LOG_FILE = path.join(LOG_DIR, "client-diagnostics.log");
const ENDPOINT = "/api/client-diagnostics";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_BYTES = 20 * 1024 * 1024;
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_TRACKED_IPS = 10_000;

const ALLOWED_ORIGINS = new Set(["https://cosmosmap.org", "https://www.cosmosmap.org"]);
const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/;

/** ip -> timestamps (ms) of accepted requests inside the window */
const hits = new Map();
let writeChain = Promise.resolve();

function corsHeaders(req) {
  const origin = req.headers.origin;
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
  };
  if (typeof origin === "string" && (ALLOWED_ORIGINS.has(origin) || LOOPBACK_ORIGIN.test(origin))) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function sendStatus(req, res, status, error) {
  const headers = corsHeaders(req);
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  res.writeHead(status, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error }));
}

/**
 * The servers listen on loopback behind a reverse proxy (Cloudflare / nginx on
 * the production box), so the proxy's client-IP headers are trusted.
 */
export function clientIp(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.trim()) return real.trim();
  return req.socket?.remoteAddress ?? "unknown";
}

/** Coarse IP for the log (IPv4 /24, IPv6 /48): enough to spot abuse, not a user id. */
function coarseIp(ip) {
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return v4.replace(/\.\d{1,3}$/, ".0/24");
  if (ip.includes(":")) return `${ip.split(":").slice(0, 3).join(":")}::/48`;
  return "unknown";
}

function allowRequest(ip, now = Date.now()) {
  const recent = (hits.get(ip) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    hits.set(ip, recent);
    return false;
  }
  recent.push(now);
  hits.delete(ip);
  hits.set(ip, recent);
  if (hits.size > MAX_TRACKED_IPS) {
    // Drop the least recently active IPs (Map keeps insertion order).
    for (const key of hits.keys()) {
      hits.delete(key);
      if (hits.size <= MAX_TRACKED_IPS * 0.9) break;
    }
  }
  return true;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      if (err) reject(err); else resolve(value);
    };
    req.on("data", chunk => {
      size += chunk.length;
      if (size > limit) {
        finish(Object.assign(new Error("body too large"), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish(null, Buffer.concat(chunks)));
    req.on("error", err => finish(err));
    req.on("aborted", () => finish(Object.assign(new Error("aborted"), { status: 400 })));
  });
}

async function appendLogLine(line) {
  await mkdir(LOG_DIR, { recursive: true });
  try {
    const info = await stat(LOG_FILE);
    if (info.size + line.length > MAX_LOG_BYTES) {
      await rename(LOG_FILE, `${LOG_FILE}.1`);
    }
  } catch {
    // No log yet.
  }
  await appendFile(LOG_FILE, line, "utf8");
}

function queueLogLine(line) {
  writeChain = writeChain.then(() => appendLogLine(line)).catch(err => {
    console.error("client-diagnostics: failed to write log:", err);
  });
  return writeChain;
}

export async function handleClientDiagnosticsRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== ENDPOINT) return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...corsHeaders(req), "Allow": "POST, OPTIONS" });
    res.end();
    return true;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { ...corsHeaders(req), "Allow": "POST, OPTIONS", "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    sendStatus(req, res, 415, "unsupported_media_type");
    req.resume();
    return true;
  }
  const declared = Number.parseInt(String(req.headers["content-length"] ?? ""), 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    sendStatus(req, res, 413, "too_large");
    req.resume();
    return true;
  }

  const ip = clientIp(req);
  if (!allowRequest(ip)) {
    res.setHeader("Retry-After", "3600");
    sendStatus(req, res, 429, "rate_limited");
    req.resume();
    return true;
  }

  let body;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    sendStatus(req, res, err?.status ?? 400, err?.status === 413 ? "too_large" : "bad_request");
    return true;
  }

  let report;
  try {
    report = JSON.parse(body.toString("utf8"));
  } catch {
    sendStatus(req, res, 400, "invalid_json");
    return true;
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    sendStatus(req, res, 400, "invalid_report");
    return true;
  }

  const line = `${JSON.stringify({
    receivedAt: new Date().toISOString(),
    ip: coarseIp(ip),
    ua: String(req.headers["user-agent"] ?? "").slice(0, 300),
    origin: typeof req.headers.origin === "string" ? req.headers.origin.slice(0, 200) : null,
    report,
  })}\n`;
  await queueLogLine(line);
  sendStatus(req, res, 204);
  return true;
}

/** For tests. */
export function resetClientDiagnosticsRateLimit() {
  hits.clear();
}

export const CLIENT_DIAGNOSTICS_LOG_FILE = LOG_FILE;

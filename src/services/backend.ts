const BACKEND_HEALTH_PATH = "/api/health";
const BACKEND_SERVICE_NAME = "cosmosmap-backend";
// The first request through the iPad app's native /api proxy includes a TLS
// handshake to cosmosmap.org; 900 ms was too short there and the app fell back
// to the offline J2000 preset although /api/health answered 200.
const BACKEND_PROBE_TIMEOUT_MS = 4000;
/** Delays before the 2nd and 3rd health-probe attempts (per origin). */
const BACKEND_PROBE_RETRY_DELAYS_MS = [400, 1500];
const BACKEND_ORIGIN_STORAGE_KEY = "cosmosmap.backendOrigin";

let backendOriginPromise: Promise<string> | null = null;

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

function localBackendOrigins(): string[] {
  const origins = new Set<string>([window.location.origin]);
  try {
    const stored = window.localStorage.getItem(BACKEND_ORIGIN_STORAGE_KEY);
    if (stored) {
      origins.add(new URL(stored).origin);
    }
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  return [...origins];
}

function rememberBackendOrigin(origin: string): void {
  try {
    window.localStorage.setItem(BACKEND_ORIGIN_STORAGE_KEY, origin);
  } catch {
    // Best-effort cache only.
  }
}

function forgetBackendOrigin(): void {
  try {
    window.localStorage.removeItem(BACKEND_ORIGIN_STORAGE_KEY);
  } catch {
    // Best-effort cache only.
  }
}

type ProbeOutcome = "ok" | "not-backend" | "unreachable";

function delay(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

async function probeBackendOnce(origin: string): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), BACKEND_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(BACKEND_HEALTH_PATH, origin), {
      cache: "no-store",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    // 5xx (e.g. the iPad proxy's 503 {"error":"offline"}) is transient; a
    // non-JSON 2xx/4xx means this origin simply has no backend (static host).
    if (response.status >= 500) return "unreachable";
    if (!response.ok || !contentType.toLowerCase().includes("application/json")) return "not-backend";
    const payload = await response.json() as { service?: unknown; ok?: unknown };
    return payload.ok === true && payload.service === BACKEND_SERVICE_NAME ? "ok" : "not-backend";
  } catch {
    return "unreachable";
  } finally {
    window.clearTimeout(timeout);
  }
}

/** Health probe with a generous timeout and a short backoff retry for transient failures. */
async function probeBackend(origin: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await probeBackendOnce(origin);
    if (outcome === "ok") return true;
    if (outcome === "not-backend") return false;
    const wait = BACKEND_PROBE_RETRY_DELAYS_MS[attempt];
    if (wait === undefined || (typeof navigator !== "undefined" && navigator.onLine === false)) return false;
    await delay(wait);
  }
}

async function resolveBackendOrigin(): Promise<string> {
  for (const origin of localBackendOrigins()) {
    if (await probeBackend(origin)) {
      rememberBackendOrigin(origin);
      return origin;
    }
  }

  forgetBackendOrigin();
  throw new BackendUnavailableError("No healthy CosmosMap backend was found.");
}

export async function backendOrigin(): Promise<string> {
  backendOriginPromise ??= resolveBackendOrigin();
  try {
    return await backendOriginPromise;
  } catch (error) {
    backendOriginPromise = null;
    throw error;
  }
}

export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const origin = await backendOrigin();
  try {
    return await fetch(new URL(path, origin), init);
  } catch {
    backendOriginPromise = null;
    throw new BackendUnavailableError(`The CosmosMap backend request failed at ${origin}.`);
  }
}

export async function readBackendJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new BackendUnavailableError("The CosmosMap backend returned a non-JSON response.");
  }
  return await response.json() as T;
}

export function backendAssetUrl(pathOrUrl: string | null | undefined, responseUrl: string): string | null {
  if (!pathOrUrl) return null;
  return new URL(pathOrUrl, responseUrl).toString();
}

const BACKEND_HEALTH_PATH = "/api/health";
const BACKEND_SERVICE_NAME = "cosmosmap-backend";
const LOCAL_BACKEND_PORTS = [
  5173, 5174, 5175, 5176, 5177,
  5178, 5179, 5180, 5181, 5182,
  5183, 5184, 5185, 5186, 5187,
  5188, 5189, 5190, 5191, 5192,
];
const BACKEND_PROBE_TIMEOUT_MS = 900;

let backendOriginPromise: Promise<string> | null = null;

export class BackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackendUnavailableError";
  }
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]";
}

function hostForUrl(hostname: string): string {
  return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function localBackendOrigins(): string[] {
  const origins = new Set<string>([window.location.origin]);
  if (!isLocalHostname(window.location.hostname) || window.location.protocol !== "http:") {
    return [...origins];
  }

  const hostnames = new Set<string>([window.location.hostname]);
  if (window.location.hostname === "localhost") hostnames.add("127.0.0.1");
  if (window.location.hostname === "127.0.0.1" || window.location.hostname === "::1" || window.location.hostname === "[::1]") {
    hostnames.add("localhost");
  }

  for (const hostname of hostnames) {
    for (const port of LOCAL_BACKEND_PORTS) {
      origins.add(`http://${hostForUrl(hostname)}:${port}`);
    }
  }
  return [...origins];
}

async function probeBackend(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), BACKEND_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(BACKEND_HEALTH_PATH, origin), {
      cache: "no-store",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.toLowerCase().includes("application/json")) return false;
    const payload = await response.json() as { service?: unknown; ok?: unknown };
    return payload.ok === true && payload.service === BACKEND_SERVICE_NAME;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function firstHealthyFallback(origins: string[]): Promise<string | null> {
  if (origins.length === 0) return null;

  return await new Promise(resolve => {
    let settled = false;
    let pending = origins.length;

    for (const origin of origins) {
      void probeBackend(origin).then(ok => {
        if (settled) return;
        if (ok) {
          settled = true;
          resolve(origin);
          return;
        }
        pending -= 1;
        if (pending === 0) resolve(null);
      });
    }
  });
}

export async function backendOrigin(): Promise<string> {
  backendOriginPromise ??= (async () => {
    const origins = localBackendOrigins();
    const sameOrigin = origins[0] ?? window.location.origin;
    if (await probeBackend(sameOrigin)) return sameOrigin;
    return await firstHealthyFallback(origins.slice(1)) ?? window.location.origin;
  })();
  return backendOriginPromise;
}

export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const origin = await backendOrigin();
  return fetch(new URL(path, origin), init);
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

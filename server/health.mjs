const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
  "Access-Control-Max-Age": "86400",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

export function handleHealthRequest(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/health") return false;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      ...CORS_HEADERS,
      "Allow": "GET, HEAD, OPTIONS",
    });
    res.end();
    return true;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, {
      ...CORS_HEADERS,
      "Allow": "GET, HEAD, OPTIONS",
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return true;
  }

  const body = JSON.stringify({
    ok: true,
    service: "cosmosmap-backend",
    name: "CosmosMap",
  });
  res.writeHead(200, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
  });
  res.end(req.method === "HEAD" ? undefined : body);
  return true;
}

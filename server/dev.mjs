import { createServer as createHttpServer } from "node:http";
import { createServer as createViteServer } from "vite";
import { handleHealthRequest } from "./health.mjs";
import { handleHorizonsRequest } from "./horizons.mjs";
import { handleModelAssetRequest } from "./model-assets.mjs";
import { handleObjectInfoRequest } from "./object-info.mjs";

const DEFAULT_PORT = 5173;
const HOST = process.env.HOST || "127.0.0.1";

function setIsolationHeaders(res) {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function listenOnAvailablePort(makeServer, preferredPort, host) {
  const firstPort = Number.parseInt(process.env.PORT || "", 10) || preferredPort;
  for (let port = firstPort; port < firstPort + 20; port++) {
    const server = makeServer();
    try {
      await listen(server, port, host);
      return { server, port };
    } catch (err) {
      if (err?.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`No available port found from ${firstPort} to ${firstPort + 19}`);
}

const vite = await createViteServer({
  appType: "spa",
  server: {
    middlewareMode: true,
  },
});

function makeServer() {
  return createHttpServer(async (req, res) => {
    setIsolationHeaders(res);
    if (handleHealthRequest(req, res)) return;
    if (await handleHorizonsRequest(req, res)) return;
    if (await handleModelAssetRequest(req, res)) return;
    if (await handleObjectInfoRequest(req, res)) return;
    vite.middlewares(req, res, () => {
      res.statusCode = 404;
      res.end("Not found");
    });
  });
}

const { server, port } = await listenOnAvailablePort(makeServer, DEFAULT_PORT, HOST);
const publicHost = HOST === "0.0.0.0" ? "localhost" : HOST;
console.log(`CosmosMap dev server: http://${publicHost}:${port}/`);

async function shutdown() {
  server.close();
  await vite.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

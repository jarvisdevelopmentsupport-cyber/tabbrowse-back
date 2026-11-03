/**
 * TaskFlow Relay — custom Scramjet backend (current package set)
 * ==================================================================
 * A Node.js server for the Render free tier. Built on the official
 * MercuryWorkshop packages (no proxy-browser repository was cloned):
 *
 *   - @mercuryworkshop/scramjet@2.0.67-alpha.2
 *       -> dist/scramjet.js (client runtime, sets globalThis.$scramjet)
 *       -> dist/scramjet.wasm (HTML rewriter wasm)
 *   - @mercuryworkshop/scramjet-controller@0.0.14
 *       -> dist/controller.api.js   (page-side Controller/Frame API)
 *       -> dist/controller.sw.js    (service-worker router)
 *       -> dist/controller.inject.js (proxied-page bootstrap)
 *   - @mercuryworkshop/libcurl-transport@2.0.6
 *       -> dist/index.mjs (LibcurlClient transport, embedded wasm)
 *   - @mercuryworkshop/wisp-js (Wisp WebSocket transport server)
 *
 * The server:
 *   1. Serves those static bundles with CORS so the Wasmer-hosted
 *      frontend (index.html / relay.html / sw.js) can load them
 *      cross-origin.
 *   2. Runs the Wisp WebSocket endpoint (wss://<host>/) that the
 *      libcurl transport uses as the actual proxy transport.
 *   3. Exposes GET /health for the frontend wake-up experience and
 *      Render's health checks.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { server as wispServer } from "@mercuryworkshop/wisp-js/server";

/* ------------------------------------------------------------------ */
/* Configuration (environment variables)                              */
/* ------------------------------------------------------------------ */

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

// Comma-separated list of origins allowed to load the bundles via CORS
// (e.g. "https://taskflow.wasmer.app"). "*" (default) allows all.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const REQUEST_LOG_ENABLED = process.env.REQUEST_LOG !== "0";

const STARTED_AT = Date.now();
const SERVICE_VERSION = "1.0.0";
const SCRAMJET_VERSION = "2.0.67-alpha.2";
const CONTROLLER_VERSION = "0.0.14";

/* ------------------------------------------------------------------ */
/* Static mounts — map URL prefixes to package dist directories        */
/* ------------------------------------------------------------------ */

const require = createRequire(import.meta.url);

const mounts = [];

// /scram/ -> @mercuryworkshop/scramjet dist
// (resolve the "./path" export -> lib/index.cjs, dist is its sibling)
try {
  const libEntry = require.resolve("@mercuryworkshop/scramjet/path");
  const dist = path.resolve(path.dirname(libEntry), "..", "dist");
  if (!fs.existsSync(dist)) throw new Error(`dist not found at ${dist}`);
  mounts.push({ prefix: "/scram/", dir: dist });
} catch (err) {
  console.error(`[fatal] Could not locate @mercuryworkshop/scramjet dist: ${err.message}`);
  process.exit(1);
}

// /controller/ -> @mercuryworkshop/scramjet-controller dist
try {
  const entry = require.resolve("@mercuryworkshop/scramjet-controller");
  const dist = path.dirname(entry);
  if (!fs.existsSync(path.join(dist, "controller.sw.js"))) {
    throw new Error("controller.sw.js missing");
  }
  mounts.push({ prefix: "/controller/", dir: dist });
} catch (err) {
  console.error(`[fatal] Could not locate @mercuryworkshop/scramjet-controller dist: ${err.message}`);
  process.exit(1);
}

// /libcurl/ -> @mercuryworkshop/libcurl-transport dist
try {
  const entry = require.resolve("@mercuryworkshop/libcurl-transport");
  const dist = path.dirname(entry);
  if (!fs.existsSync(path.join(dist, "index.mjs"))) throw new Error("index.mjs missing");
  mounts.push({ prefix: "/libcurl/", dir: dist });
} catch (err) {
  console.error(`[fatal] Could not locate @mercuryworkshop/libcurl-transport dist: ${err.message}`);
  process.exit(1);
}

for (const mount of mounts) {
  console.log(`[init] ${mount.prefix} -> ${mount.dir}`);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const MIME_TYPES = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function log(level, message) {
  const stamp = new Date().toISOString();
  console.log(JSON.stringify({ t: stamp, level, msg: message }));
}

function corsHeadersFor(req) {
  const origin = req.headers.origin;
  // "null" arrives from opaque contexts (about:blank / sandboxed iframes)
  if (origin === "null") {
    return {
      "Access-Control-Allow-Origin": "null",
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };
  }
  if (ALLOWED_ORIGINS.includes("*")) {
    return {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };
  }
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    return {
      "Access-Control-Allow-Origin": origin,
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };
  }
  return null; // no CORS headers -> browser blocks the cross-origin read
}

function sendJSON(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function serveFile(req, res, mountDir, urlPath) {
  const root = path.resolve(mountDir);
  const resolved = path.resolve(root, urlPath);

  if (!resolved.startsWith(root + path.sep)) {
    return sendJSON(res, 403, { ok: false, error: "Forbidden" });
  }

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return sendJSON(res, 404, { ok: false, error: "Not found", file: urlPath });
  }
  if (!stat.isFile()) {
    return sendJSON(res, 404, { ok: false, error: "Not found", file: urlPath });
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  // Hash-named wasm files are content-addressed -> cache forever.
  const isHashed = /^[0-9a-f]{16}\.wasm$/.test(path.basename(resolved));
  const cacheControl = isHashed
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300";

  const headers = {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": cacheControl,
  };
  const cors = corsHeadersFor(req);
  if (cors) Object.assign(headers, cors);

  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    return res.end();
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(resolved);
  stream.on("error", (err) => {
    log("error", `stream error for ${urlPath}: ${err.message}`);
    res.destroy();
  });
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                         */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    // CORS preflight for any route
    if (req.method === "OPTIONS") {
      const cors = corsHeadersFor(req);
      res.writeHead(204, cors || {});
      return res.end();
    }

    if (req.method === "GET" || req.method === "HEAD") {
      // Health check — used by the TaskFlow frontend and Render.
      if (pathname === "/health") {
        log("info", `health check from origin: ${req.headers.origin || "(none)"}`);
        return sendJSON(res, 200, {
          ok: true,
          service: "taskflow-relay-backend",
          version: SERVICE_VERSION,
          scramjet: SCRAMJET_VERSION,
          controller: CONTROLLER_VERSION,
          transport: "wisp",
          uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
        }, corsHeadersFor(req) || {});
      }

      // Human-friendly index.
      if (pathname === "/" || pathname === "/index.json") {
        return sendJSON(res, 200, {
          ok: true,
          service: "taskflow-relay-backend",
          version: SERVICE_VERSION,
          scramjet: SCRAMJET_VERSION,
          controller: CONTROLLER_VERSION,
          endpoints: {
            health: "/health",
            scramjetClient: "/scram/scramjet.js",
            scramjetWasm: "/scram/scramjet.wasm",
            controllerApi: "/controller/controller.api.js",
            serviceWorker: "/controller/controller.sw.js",
            inject: "/controller/controller.inject.js",
            libcurlTransport: "/libcurl/index.mjs",
            wispWebSocket: "wss://<this-host>/",
          },
        }, corsHeadersFor(req) || {});
      }

      // Static bundles
      for (const mount of mounts) {
        if (pathname === mount.prefix || pathname.startsWith(mount.prefix)) {
          const relative = pathname.slice(mount.prefix.length);
          if (!relative) {
            return sendJSON(res, 200, {
              ok: true,
              mount: mount.prefix,
              files: fs.readdirSync(mount.dir).filter((f) => !f.startsWith(".")),
            }, corsHeadersFor(req) || {});
          }
          return serveFile(req, res, mount.dir, relative);
        }
      }
    }

    return sendJSON(res, 404, { ok: false, error: "Not found", path: pathname }, corsHeadersFor(req) || {});
  } catch (err) {
    log("error", `unhandled error for ${pathname}: ${err.stack || err}`);
    if (!res.headersSent) {
      return sendJSON(res, 500, { ok: false, error: "Internal server error" });
    }
    res.destroy();
  } finally {
    if (REQUEST_LOG_ENABLED) {
      log("info", `${req.method} ${pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Wisp WebSocket transport                                            */
/* ------------------------------------------------------------------ */

server.on("upgrade", (req, socket, head) => {
  try {
    // The official wisp-js server speaks the wisp protocol on any path
    // ending in "/". The libcurl transport connects to wss://<host>/.
    wispServer.routeRequest(req, socket, head);
    if (REQUEST_LOG_ENABLED) {
      log("info", `wisp connection from ${req.socket.remoteAddress || "unknown"} (${req.url})`);
    }
  } catch (err) {
    log("error", `wisp upgrade failed: ${err.stack || err}`);
    try {
      socket.destroy();
    } catch {
      /* socket already gone */
    }
  }
});

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

server.on("error", (err) => {
  log("error", `server error: ${err.stack || err}`);
});

process.on("uncaughtException", (err) => {
  log("error", `uncaught exception: ${err.stack || err}`);
});

process.on("unhandledRejection", (reason) => {
  log("error", `unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

server.listen(PORT, HOST, () => {
  log("info", `TaskFlow Relay backend listening on http://${HOST}:${PORT}`);
  log("info", `CORS allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  log("info", `Wisp transport endpoint: wss://<host>/`);
});

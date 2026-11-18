// ============================================================================
// place-front.js — isolated placement front for px-rfq (2026-11-19)
//
// A small separate Node PROCESS, forked by index.js when PLACE_FRONT=1, that
// owns the public PORT. It serves
//     POST /admin/offers/place     (services/manual-offers.js, own px-single)
//     POST /admin/offers/cancel    (services/manual-offers.js, own px-single)
//     GET  /admin/offers/front-stats   (read-only latency / uptime)
// itself, and streams EVERY other request (any method/path, /health included,
// websocket upgrades included) to the main app on 127.0.0.1:PLACE_FRONT_MAIN_PORT.
//
// Why: PX accepts order placement only from px-rfq's allowlisted egress IP, so
// placement must stay in this container; but the main process's event loop is
// periodically blocked for seconds by the parlay quoter's background jobs, and
// every Order Book poster's placement queued behind it. This process does no
// other work, so a placement is never stuck behind a parlay job.
//
// If the main app is not listening (boot, crash), proxied paths get 503 and
// placement keeps working. Auth on /admin/offers/* is the same Basic-auth
// logic and env vars as index.js (services/manual-offers.js makeAdminAuth).
// ============================================================================

'use strict';

require('./services/httpClient');
const http = require('http');
const net = require('net');
const express = require('express');

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade']);

/**
 * @param {object} o
 * @param {object} o.manual   createManualOffers() instance
 * @param {object} o.auth     makeAdminAuth() instance
 * @param {number} o.mainPort internal port of the main app
 * @param {string} [o.mainHost] default 127.0.0.1
 * @param {object} o.log
 * @param {Function} [o.now]
 * @param {object} [o.info]   extra fields for front-stats
 */
function createFront(o) {
  const log = o.log;
  const now = o.now || Date.now;
  const mainHost = o.mainHost || '127.0.0.1';
  const mainPort = o.mainPort;
  const manual = o.manual;
  const auth = o.auth;
  const startedAt = now();
  const proxy = { requests: 0, errors: 0, unavailable503: 0, lastError: null };
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });

  const app = express();
  const json = express.json();   // same parser + default limit as index.js's global express.json()

  // Same order as index.js: body parser, then auth, then the handler.
  app.post('/admin/offers/place', json, auth.middleware, (req, res) => manual.place(req, res));
  app.post('/admin/offers/cancel', json, auth.middleware, (req, res) => manual.cancel(req, res));
  app.get('/admin/offers/front-stats', auth.middleware, (req, res) => {
    res.json({ ok: true, front: true, pid: process.pid, uptime_s: Math.round((now() - startedAt) / 1000),
      started_at: new Date(startedAt).toISOString(), main: { host: mainHost, port: mainPort, ...proxy },
      ...(o.info || {}), placement: manual.stats() });
  });

  // Everything else streams to the main app, untouched.
  app.use((req, res) => proxyHttp(req, res));

  function proxyHttp(req, res) {
    proxy.requests++;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
    const up = http.request({ host: mainHost, port: mainPort, method: req.method,
      path: req.originalUrl || req.url, headers, agent }, (ur) => {
      const h = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) h[k] = v;
      res.writeHead(ur.statusCode, ur.statusMessage, h);
      ur.pipe(res);
      ur.on('error', () => { try { res.destroy(); } catch (_) { /* gone */ } });
    });
    up.on('error', (e) => {
      proxy.errors++;
      proxy.lastError = { at: new Date(now()).toISOString(), code: e.code || null, message: e.message };
      if (res.headersSent) { try { res.destroy(); } catch (_) { /* gone */ } return; }
      if (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'EPIPE') {
        proxy.unavailable503++;
        res.status(503).json({ ok: false, error: 'main app not available (placement front is up; /admin/offers/place still works)', code: e.code });
      } else {
        res.status(502).json({ ok: false, error: 'proxy error: ' + e.message, code: e.code || null });
      }
    });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
  }

  // Websocket / any Upgrade: raw TCP tunnel to the main app.
  function proxyUpgrade(req, socket, head) {
    let connected = false;
    const upstream = net.connect(mainPort, mainHost, () => {
      connected = true;
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      upstream.write(raw + '\r\n');
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const end = () => { try { socket.destroy(); } catch (_) {} try { upstream.destroy(); } catch (_) {} };
    upstream.on('error', (e) => {
      proxy.lastError = { at: new Date(now()).toISOString(), code: e.code || null, message: e.message };
      if (!connected && !socket.destroyed && socket.writable) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
        return;
      }
      end();
    });
    socket.on('error', end);
  }

  const server = http.createServer(app);
  server.on('upgrade', proxyUpgrade);
  return { app, server, agent, proxyStats: proxy };
}

// ---------------------------------------------------------------------------
// Process entry (forked by services/place-front-supervisor.js)
// ---------------------------------------------------------------------------
function main() {
  const log = require('./services/logger');
  const { config } = require('./config');
  try { log.setLevel(config.logLevel); } catch (_) { /* default level */ }
  const { createManualOffers, makeAdminAuth } = require('./services/manual-offers');
  const port = parseInt(process.env.PORT, 10) || (config.server && config.server.port) || 3001;
  const mainPort = parseInt(process.env.PLACE_FRONT_MAIN_PORT, 10) || 8099;
  const manual = createManualOffers({ log });
  const auth = makeAdminAuth(process.env, log);
  const front = createFront({ manual, auth, mainPort, log,
    info: { start_n: Number(process.env.PLACE_FRONT_START_N) || 1 } });

  front.server.on('error', (e) => {
    log.error('PlaceFront', `listen on ${port} failed: ${e.message} — exiting`);
    setTimeout(() => process.exit(1), 50);
  });
  front.server.listen(port, () => {
    log.info('PlaceFront', `front listening on ${port}; proxying non-placement traffic to 127.0.0.1:${mainPort}`);
    if (process.send) { try { process.send({ type: 'ready', port }); } catch (_) { /* parent gone */ } }
  });

  // Graceful stop: no new connections, let in-flight placements/cancels finish
  // (bounded), then exit. A placement killed mid-write is an UNKNOWN outcome.
  let stopping = false;
  function stop(why) {
    if (stopping) return; stopping = true;
    log.info('PlaceFront', `stopping (${why}); in-flight placement requests: ${manual.inflight()}`);
    try { front.server.close(); } catch (_) { /* already closed */ }
    const deadline = now0() + (parseInt(process.env.PLACE_FRONT_DRAIN_MS, 10) || 15000);
    const tick = () => {
      if (manual.inflight() === 0 || now0() > deadline) { setTimeout(() => process.exit(0), 50); return; }
      setTimeout(tick, 100);
    };
    tick();
  }
  function now0() { return Date.now(); }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  // Parent (index.js) gone → nothing left to front for.
  process.on('disconnect', () => stop('parent disconnected'));
  process.on('uncaughtException', (e) => {
    log.error('PlaceFront', `uncaught exception: ${e.message} ${e.stack || ''}`);
    setTimeout(() => process.exit(1), 50);
  });
  process.on('unhandledRejection', (r) => log.error('PlaceFront', `unhandled rejection: ${r}`));
}

if (require.main === module) main();

module.exports = { createFront };

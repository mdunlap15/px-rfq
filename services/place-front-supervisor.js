// ============================================================================
// place-front-supervisor.js — runs place-front.js as a child process of
// index.js when PLACE_FRONT=1 (2026-11-19).
//
//   PLACE_FRONT=1            enable (anything else: off, startup exactly as before)
//   PLACE_FRONT_MAIN_PORT    internal port index.js listens on, 127.0.0.1 (default 8099)
//   PLACE_FRONT_MAX_CRASHES  crashes inside the window that trigger FALLBACK (default 3)
//   PLACE_FRONT_CRASH_WINDOW_MS                                    (default 60000)
//   PLACE_FRONT_RESTART_MS   delay before restarting a crashed front (default 1000)
//
// The front owns the public PORT. If it exits it is restarted. If it exits
// PLACE_FRONT_MAX_CRASHES times within the window, the supervisor gives up on
// it and calls onFallback(), which makes index.js listen on the public PORT
// itself (the pre-2026-11-19 shape), so the service never stays dark.
// Once in fallback the front is never restarted (a restart needs a deploy).
// During shutdown (SIGTERM/SIGINT on the parent) nothing is restarted, and the
// child is killed when the parent exits.
// ============================================================================

'use strict';

const path = require('path');
const childProcess = require('child_process');

function createSupervisor(opts) {
  const log = opts.log;
  const fork = opts.fork || childProcess.fork;
  const now = opts.now || Date.now;
  const script = opts.script || path.join(__dirname, '..', 'place-front.js');
  const port = opts.port;
  const mainPort = opts.mainPort;
  const maxCrashes = opts.maxCrashes || 3;
  const windowMs = opts.windowMs || 60000;
  const restartMs = opts.restartMs != null ? opts.restartMs : 1000;
  const onFallback = opts.onFallback || (() => {});
  const baseEnv = opts.env || process.env;

  let child = null;
  let mode = 'front';          // 'front' | 'fallback'
  let stopping = false;
  let starts = 0;
  let crashes = [];
  let restartTimer = null;

  function spawn() {
    if (stopping || mode !== 'front') return;
    starts++;
    const env = { ...baseEnv, PLACE_FRONT_CHILD: '1', PORT: String(port),
      PLACE_FRONT_MAIN_PORT: String(mainPort), PLACE_FRONT_START_N: String(starts) };
    let c;
    try {
      c = fork(script, [], { env, stdio: 'inherit' });
    } catch (e) {
      log.error('PlaceFront', `fork failed: ${e.message}`);
      return onExit(null, 1, null);
    }
    child = c;
    let exited = false;
    const done = (code, signal) => { if (exited) return; exited = true; onExit(c, code, signal); };
    c.on('exit', done);
    c.on('error', (e) => { log.error('PlaceFront', `front process error: ${e.message}`); done(1, null); });
    c.on('message', (m) => {
      if (m && m.type === 'ready') log.info('PlaceFront', `front #${starts} listening on public port ${port} (pid ${c.pid}); main on 127.0.0.1:${mainPort}`);
    });
  }

  function onExit(c, code, signal) {
    if (c && child === c) child = null;
    if (stopping) return;
    const t = now();
    crashes = crashes.filter(x => t - x < windowMs);
    crashes.push(t);
    log.error('PlaceFront', `front exited (code=${code}, signal=${signal}) — ${crashes.length} exit(s) in the last ${Math.round(windowMs / 1000)}s`);
    if (crashes.length >= maxCrashes) {
      mode = 'fallback';
      log.error('PlaceFront', `front exited ${crashes.length}x within ${Math.round(windowMs / 1000)}s — FALLBACK: index.js takes the public port ${port} itself; placement runs in the main process (as before 2026-11-19) until the next deploy`);
      try { onFallback(); } catch (e) { log.error('PlaceFront', `fallback failed: ${e.message}`); }
      return;
    }
    restartTimer = setTimeout(() => { restartTimer = null; spawn(); }, restartMs);
    if (restartTimer.unref) restartTimer.unref();
  }

  function stop() {
    stopping = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (child) { try { child.kill('SIGTERM'); } catch (_) { /* gone */ } }
  }

  return {
    start: spawn,
    stop,
    markStopping: () => { stopping = true; if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; } },
    killChild: () => { if (child) { try { child.kill('SIGTERM'); } catch (_) { /* gone */ } } },
    active: () => mode === 'front',
    mode: () => mode,
    mainPort,
    port,
    state: () => ({ mode, starts, crashesInWindow: crashes.filter(x => now() - x < windowMs).length,
      childPid: child ? child.pid : null, stopping }),
  };
}

/**
 * Called once from index.js before startup(). Returns null (feature off) unless
 * PLACE_FRONT=1, this is not the front child itself, and the ports are usable.
 */
function maybeStart({ port, log, onFallback, env = process.env }) {
  if (String(env.PLACE_FRONT || '') !== '1') return null;
  if (env.PLACE_FRONT_CHILD === '1') return null;
  const mainPort = parseInt(env.PLACE_FRONT_MAIN_PORT, 10) || 8099;
  if (!port || Number(mainPort) === Number(port)) {
    log.error('PlaceFront', `PLACE_FRONT=1 but PORT (${port}) == PLACE_FRONT_MAIN_PORT (${mainPort}) — front NOT started, running as before`);
    return null;
  }
  const sup = createSupervisor({
    port, mainPort, log, onFallback, env,
    maxCrashes: parseInt(env.PLACE_FRONT_MAX_CRASHES, 10) || 3,
    windowMs: parseInt(env.PLACE_FRONT_CRASH_WINDOW_MS, 10) || 60000,
    restartMs: env.PLACE_FRONT_RESTART_MS != null ? (parseInt(env.PLACE_FRONT_RESTART_MS, 10) || 0) : 1000,
  });
  // No restarts once the parent is shutting down; kill the child when the
  // parent exits (process.exit in index.js's shutdown, or a crash).
  process.on('SIGTERM', () => sup.markStopping());
  process.on('SIGINT', () => sup.markStopping());
  process.on('exit', () => sup.killChild());
  sup.start();
  log.info('PlaceFront', `PLACE_FRONT=1 — placement front owns public port ${port}; index.js on 127.0.0.1:${mainPort}`);
  return sup;
}

module.exports = { createSupervisor, maybeStart };

#!/usr/bin/env node
/**
 * awaykit control CLI — start · stop · restart · status.
 *
 * One friendly front door for the daemon's lifecycle, so you never hit a raw
 * EADDRINUSE stack trace again. It talks to a running daemon over loopback
 * (/health and /shutdown), so there are no PID files and it behaves the same on
 * every OS.
 *
 *   npm start          → start it (or tell you it's already running)
 *   npm run status     → is it up? how many phones are connected?
 *   npm run stop       → ask the running daemon to exit cleanly
 *   npm run restart    → stop the old one, then start a fresh one
 *
 * Anything after the command is forwarded to the daemon, e.g.
 *   npm start -- --pair       (re-pair: mint a new key + QR)
 */
import process from "node:process";
import { daemonEndpoint, daemonRequest } from "./endpoint.js";

const PORT = Number(process.env.AWAYKIT_PORT || 4517);
// The running daemon advertises its scheme (http, or https under AWAYKIT_TLS);
// fall back to plain HTTP on the default port when nothing's advertised.
const { base: BASE, tls: TLS } = daemonEndpoint(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET /health, or null if nothing answers on the port. */
async function health() {
  try {
    const r = await daemonRequest(BASE, "/health", { timeoutMs: 1200, tls: TLS });
    return r.status === 200 ? JSON.parse(r.body) : null;
  } catch { return null; }
}

const fmtDur = (s) =>
  s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;

function describeHealth(h) {
  const phones = h.clients || 0;
  const lines = [
    `  ● awaykit is running on port ${h.port || PORT}` + (h.uptimeSec != null ? `  (up ${fmtDur(h.uptimeSec)})` : ""),
    phones
      ? `    ${phones} phone${phones === 1 ? "" : "s"} connected`
      : `    no phone connected yet — open the paired URL / scan the QR on your phone`,
  ];
  if (h.pending) lines.push(`    ${h.pending} approval${h.pending === 1 ? "" : "s"} waiting for you`);
  return lines.join("\n");
}

async function cmdStatus() {
  const h = await health();
  console.log(h ? describeHealth(h) : `  ○ awaykit is not running (nothing on port ${PORT}).`);
}

async function cmdStop({ quiet = false } = {}) {
  const h = await health();
  if (!h) { if (!quiet) console.log(`  ○ awaykit wasn't running.`); return true; }
  try { await daemonRequest(BASE, "/shutdown", { method: "POST", timeoutMs: 1200, tls: TLS }); }
  catch { /* the daemon may drop the socket as it exits — that's fine */ }
  for (let i = 0; i < 50; i++) {
    if (!(await health())) { if (!quiet) console.log(`  ✓ awaykit stopped.`); return true; }
    await sleep(100);
  }
  console.log(`  ✗ awaykit didn't stop in time. If it's stuck, end the 'node' process holding port ${PORT}.`);
  return false;
}

/**
 * Run the daemon in THIS process (not a child): importing it binds the port,
 * prints the QR, and keeps the event loop alive. `--pair` and friends flow
 * through unchanged because the daemon reads process.argv itself.
 */
async function startInProcess() {
  await import("./daemon.js");
}

async function cmdStart() {
  const h = await health();
  if (h) {
    console.log(describeHealth(h));
    console.log(`\n  It's already up — just reconnect your phone. To restart it:  npm run restart`);
    return;
  }
  await startInProcess();
}

async function cmdRestart() {
  const stopped = await cmdStop();
  if (!stopped) { console.log(`  Not restarting — the old daemon is still holding the port.`); process.exit(1); }
  await sleep(150); // let the listener fully release before we rebind
  console.log(`  ↻ starting a fresh daemon…\n`);
  await startInProcess();
}

const USAGE =
  `awaykit control — usage:\n` +
  `  npm start            start it (or report that it's already running)\n` +
  `  npm run status       show connection status\n` +
  `  npm run stop         stop the daemon\n` +
  `  npm run restart      restart the daemon\n\n` +
  `  add  -- --pair  to start/restart to mint a new pairing key + QR`;

const cmd = (process.argv[2] || "start").toLowerCase();
switch (cmd) {
  case "start": await cmdStart(); break;
  case "stop": await cmdStop(); break;
  case "restart": await cmdRestart(); break;
  case "status": await cmdStatus(); break;
  default: console.log(USAGE); process.exit(1);
}

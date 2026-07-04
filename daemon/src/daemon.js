/**
 * awaykit daemon — v0.3 (paired + encrypted + forward secrecy + remote-ready).
 *
 *   Claude Code PreToolUse hook ──POST /hook (loopback only)──▶ daemon
 *                                                                 │ holds agent blocked
 *                          sealed SSE  event: m / data: <cipher>  ▼
 *                                                          paired phone
 *                                                          (has key K from QR)
 *                          POST /respond {c:<cipher>} ◀── Approve / Deny
 *                                                                 │
 *                             decision ◀────────────────────────┘
 *
 * Security model (v0.1):
 *  - One shared key K, created on first run, delivered to the phone via the QR
 *    code's URL *fragment* (never sent to the server). See crypto.js.
 *  - Every phone⇄daemon message is sealed with NaCl secretbox under K, so a
 *    passive Wi-Fi sniffer sees only ciphertext and a device without K can
 *    neither read events nor forge an approval.
 *  - /events + /respond require a session cookie, issued only after the phone
 *    proves it holds K (POST /session with a sealed proof).
 *  - /hook accepts loopback connections only (it's called by the local hook).
 *
 * Residual risk (documented in docs/SECURITY.md): the app shell (HTML + JS) is
 * still served over plain HTTP, so an *active* on-path attacker could tamper
 * with it. Full end-to-end integrity needs HTTPS/pinning or the native app —
 * a later milestone. v0.1 defeats passive sniffing and unauthorized devices.
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { loadOrCreateKey, regenerateKey, keyPath, seal, open, openProof, newEphemeralKeyPair, deriveSessionKey, b64urlEncode } from "./crypto.js";
import { pickPairingHost, candidateHosts } from "./net.js";
import { appendAudit, readAudit } from "./audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.AWAYKIT_PORT || 4517);
const HOST = process.env.AWAYKIT_HOST || "0.0.0.0";
const REPAIR = process.argv.includes("--pair") || process.env.AWAYKIT_REPAIR === "1";
const PUBLIC_HOST = process.env.AWAYKIT_PUBLIC_HOST || "";

const KEY = REPAIR ? regenerateKey() : loadOrCreateKey();
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** promptId -> { prompt, decide(choice) } */
const pending = new Map();
/** authenticated phone SSE responses */
const clients = new Set();
/** sessionId -> expiry epoch ms */
const sessions = new Map();

// ---- helpers ---------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function isLoopback(req) {
  const a = req.socket.remoteAddress || "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function newSession(sk) {
  const sid = b64urlEncode(randomBytes(24));
  sessions.set(sid, { exp: Date.now() + SESSION_TTL_MS, sk });
  return sid;
}

function sessionOf(req) {
  const sid = parseCookies(req)["awaykit_session"];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.exp) { sessions.delete(sid); return null; }
  return s;
}

/** Send one sealed SSE message, using this client's ephemeral session key. */
function sseSealed(res, payload) {
  res.write(`event: m\ndata: ${seal(res.awaykitSK, payload)}\n\n`);
}

function broadcast(payload) {
  for (const c of clients) {
    try { sseSealed(c, payload); } catch { /* dropped on next tick */ }
  }
}

function publicPrompt(p) {
  return { promptId: p.promptId, tool: p.tool, summary: p.summary, detail: p.detail, sessionId: p.sessionId, cwd: p.cwd, ts: p.ts };
}

// ---- request routing -------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;

  try {
    // --- app shell (no auth; the key arrives via the URL fragment, not here) ---
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await readFile(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (req.method === "GET" && pathname === "/vendor/nacl.min.js") {
      const js = await readFile(join(PUBLIC_DIR, "vendor", "nacl.min.js"));
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=86400" });
      res.end(js);
      return;
    }

    // --- local-only endpoints ---
    if (req.method === "GET" && pathname === "/health") {
      if (!isLoopback(req)) { json(res, 403, { ok: false }); return; }
      json(res, 200, { ok: true, pending: pending.size, clients: clients.size, sessions: sessions.size, port: PORT, uptimeSec: Math.round(process.uptime()) });
      return;
    }

    // --- audit log: the record of what was approved/denied (loopback only) ---
    if (req.method === "GET" && pathname === "/audit") {
      if (!isLoopback(req)) { json(res, 403, { ok: false }); return; }
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 1000);
      json(res, 200, { ok: true, entries: readAudit(limit) });
      return;
    }

    // --- graceful shutdown, driven by the control CLI (loopback only) ---
    if (req.method === "POST" && pathname === "/shutdown") {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      json(res, 200, { ok: true, bye: true });
      console.log("\n[awaykit] shutdown requested — closing. (paired phones will auto-reconnect if you start again)");
      // Flush the response first, then exit; dropping the SSE sockets tells each
      // phone to fall back to its reconnect loop.
      setTimeout(() => process.exit(0), 30).unref?.();
      return;
    }

    // --- pairing handshake: phone proves it holds K, gets a session cookie ---
    if (req.method === "POST" && pathname === "/session") {
      const { proof } = await readBody(req);
      const claim = proof ? openProof(KEY, proof) : null;
      if (!claim || !claim.epk) { json(res, 401, { ok: false, error: "bad pairing proof" }); return; }
      // Ephemeral X25519 exchange, authenticated by K, gives per-session forward
      // secrecy: the channel uses `sk`, never K. The ephemeral secret is dropped
      // when this scope returns.
      const eph = newEphemeralKeyPair();
      const sk = deriveSessionKey(claim.epk, eph.secretKey);
      const sid = newSession(sk);
      json(res, 200, { ok: true, edk: seal(KEY, { dpk: b64urlEncode(eph.publicKey) }) }, {
        "set-cookie": `awaykit_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
      });
      return;
    }

    // --- encrypted event stream to the paired phone ---
    if (req.method === "GET" && pathname === "/events") {
      const sess = sessionOf(req);
      if (!sess) { json(res, 401, { ok: false, error: "pair first" }); return; }
      res.awaykitSK = sess.sk;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      res.write(": awaykit stream open\n\n");
      sseSealed(res, { type: "snapshot", pending: [...pending.values()].map(publicPrompt) });
      clients.add(res);
      const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
      req.on("close", () => { clearInterval(keepAlive); clients.delete(res); });
      return;
    }

    // --- phone answers a prompt (sealed body) ---
    if (req.method === "POST" && pathname === "/respond") {
      const sess = sessionOf(req);
      if (!sess) { json(res, 401, { ok: false, error: "pair first" }); return; }
      const body = await readBody(req);
      const msg = body && body.c ? open(sess.sk, body.c) : null;
      if (!msg) { json(res, 400, { ok: false, error: "undecipherable" }); return; }
      const { promptId, choice } = msg;
      const entry = pending.get(promptId);
      if (!entry) { json(res, 404, { ok: false, error: "unknown or already-resolved prompt" }); return; }
      if (choice !== "approve" && choice !== "deny") { json(res, 400, { ok: false, error: "choice must be approve|deny" }); return; }
      entry.decide(choice);
      json(res, 200, { ok: true });
      return;
    }

    // --- the local Claude Code hook (loopback only) ---
    if (req.method === "POST" && pathname === "/hook") {
      if (!isLoopback(req)) { res.writeHead(403); res.end(); return; }
      const ev = await readBody(req);

      if (ev.kind === "notify" || ev.kind === "stop") {
        broadcast({ type: "notify", icon: ev.icon || (ev.kind === "stop" ? "🏁" : "🔔"), text: ev.text || ev.summary || "agent event" });
        json(res, 200, { ok: true });
        return;
      }

      // No paired phone connected => behave like plain Claude Code (no interception).
      if (clients.size === 0) { json(res, 200, { ok: true, choice: null, reason: "no phone connected" }); return; }

      const prompt = {
        promptId: randomUUID(),
        tool: ev.tool || "permission",
        summary: ev.summary || "Agent needs your approval",
        detail: ev.detail || "",
        sessionId: ev.sessionId || "",
        cwd: ev.cwd || "",
        ts: Date.now(),
      };

      let settled = false;
      const finish = (choice) => {
        if (settled) return;
        settled = true;
        pending.delete(prompt.promptId);
        appendAudit({ tool: prompt.tool, summary: prompt.summary, cwd: prompt.cwd, sessionId: prompt.sessionId, decision: choice });
        broadcast({ type: "resolved", promptId: prompt.promptId, choice });
        json(res, 200, { ok: true, choice });
      };
      prompt.decide = finish;
      pending.set(prompt.promptId, { ...prompt, decide: finish });

      req.on("close", () => {
        if (settled) return;
        settled = true;
        pending.delete(prompt.promptId);
        appendAudit({ tool: prompt.tool, summary: prompt.summary, cwd: prompt.cwd, sessionId: prompt.sessionId, decision: "aborted" });
        broadcast({ type: "resolved", promptId: prompt.promptId, choice: "aborted" });
      });

      broadcast({ type: "prompt", ...publicPrompt(prompt) });
      console.log(`[awaykit] → phone: ${prompt.tool} — ${prompt.summary}`);
      return; // response sent later by finish()
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    json(res, 400, { ok: false, error: String((err && err.message) || err) });
  }
});

async function printPairing() {
  const ifaces = networkInterfaces();
  const host = pickPairingHost(ifaces, PUBLIC_HOST);
  const pairURL = `http://${host.ip}:${PORT}/#k=${b64urlEncode(KEY)}`;

  console.log(`\n  awaykit daemon — v0.3 (paired · encrypted · forward-secret)`);
  console.log(`  ──────────────────────────────────────────────────────────`);
  console.log(`  local:   http://127.0.0.1:${PORT}`);
  for (const c of candidateHosts(ifaces)) {
    const label = c.kind === "vpn" ? "remote" : "phone ";
    const reach = c.kind === "vpn" ? "any network via VPN" : "same Wi-Fi only";
    console.log(`  ${label}:  http://${c.ip}:${PORT}   (${reach} — ${c.iface})`);
  }

  const note = host.kind === "public" ? "AWAYKIT_PUBLIC_HOST"
    : host.kind === "vpn" ? "VPN — reachable from anywhere"
    : "LAN only — for remote access see docs/REMOTE.md";
  console.log(`\n  Pairing host: ${host.ip}  (${note})`);
  console.log(`  Scan to pair your phone (this QR contains your secret key):\n`);
  try {
    console.log(await QRCode.toString(pairURL, { type: "terminal", small: true }));
  } catch {
    console.log(`  (QR render failed — open the URL below on your phone instead)`);
  }
  console.log(`  If the QR won't scan, open this exact URL on your phone:`);
  console.log(`  ${pairURL}\n`);
  console.log(`  Key stored at: ${keyPath()}   (re-pair anytime with:  npm start -- --pair)`);
  console.log(`\n  Waiting for hook events on POST /hook …\n`);
}

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(
      `\n  ✗ Port ${PORT} is already in use — awaykit is probably already running.\n` +
      `\n    • Check it:    npm run status` +
      `\n    • Restart it:  npm run restart` +
      `\n    • Stop it:     npm run stop` +
      `\n    • Or pick another port:  AWAYKIT_PORT=4600 npm start\n`);
    process.exit(1);
  }
  console.error(`\n  ✗ awaykit server error: ${(err && err.message) || err}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => { printPairing(); });

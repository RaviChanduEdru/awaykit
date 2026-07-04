/**
 * awaykit relay — a zero-knowledge ciphertext shuttle.
 *
 * Lets the phone reach the laptop from ANY network without a VPN and without
 * opening any inbound port on the laptop:
 *
 *   laptop daemon ──outbound /pull (SSE)──▶ ┌────────┐ ◀── /pull (SSE) ── phone
 *                 ──POST /push ───────────▶ │ relay  │ ◀── POST /push ──
 *                                           └────────┘
 *
 * Zero knowledge, by construction:
 *  - Rooms are identified by hash(K) — derived independently by both devices;
 *    the relay cannot recover K from it.
 *  - Every payload is an opaque sealed blob (NaCl secretbox under K or a
 *    per-session ephemeral key). The relay stores/forwards strings it cannot
 *    read, and learns only timing, direction, and size.
 *  - No accounts, no state on disk. Restarting the relay loses nothing but
 *    briefly-queued blobs.
 *
 * It also serves the phone client (the same public/index.html as the daemon),
 * so a remote phone has something to load. Host it behind HTTPS in production —
 * that also gives the app shell integrity (see docs/SECURITY.md).
 *
 * Zero dependencies. Run:  node relay/server.js   (PORT env to change port)
 */

import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || process.env.AWAYKIT_RELAY_PORT || 4600);
const HOST = process.env.HOST || "0.0.0.0";

const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BLOB = 64 * 1024;      // one sealed message
const QUEUE_CAP = 200;           // per room per direction
const BLOB_TTL_MS = 5 * 60_000;  // queued blobs expire
const ROOM_TTL_MS = 15 * 60_000; // idle rooms are forgotten

/** roomId -> { listeners: {phone:Set,daemon:Set}, queue: {phone:[],daemon:[]}, touched } */
const rooms = new Map();

function roomOf(id) {
  let r = rooms.get(id);
  if (!r) {
    r = { listeners: { phone: new Set(), daemon: new Set() }, queue: { phone: [], daemon: [] }, touched: 0 };
    rooms.set(id, r);
  }
  r.touched = Date.now();
  return r;
}

// periodic cleanup: expired queued blobs + idle rooms
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [id, r] of rooms) {
    for (const side of ["phone", "daemon"]) {
      r.queue[side] = r.queue[side].filter((q) => now - q.ts < BLOB_TTL_MS);
    }
    const idle = !r.listeners.phone.size && !r.listeners.daemon.size &&
      !r.queue.phone.length && !r.queue.daemon.length && now - r.touched > ROOM_TTL_MS;
    if (idle) rooms.delete(id);
  }
}, 60_000);
sweep.unref?.();

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BLOB + 1024) { reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

let publicDirCache;
async function publicDir() {
  if (publicDirCache !== undefined) return publicDirCache;
  for (const p of [join(__dirname, "public"), join(__dirname, "..", "daemon", "public")]) {
    try { await access(join(p, "index.html")); publicDirCache = p; return p; } catch { /* try next */ }
  }
  publicDirCache = null;
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;

  try {
    // --- phone client (a remote phone loads the app shell from here) ---
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const dir = await publicDir();
      if (!dir) { res.writeHead(500); res.end("phone client not bundled"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(await readFile(join(dir, "index.html")));
      return;
    }
    if (req.method === "GET" && pathname === "/vendor/nacl.min.js") {
      const dir = await publicDir();
      if (!dir) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=86400" });
      res.end(await readFile(join(dir, "vendor", "nacl.min.js")));
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      json(res, 200, { ok: true, rooms: rooms.size }); // a count only — no room ids
      return;
    }

    // --- send one opaque blob to the other side of a room ---
    if (req.method === "POST" && pathname === "/push") {
      const { room, to, blob } = await readBody(req);
      if (!ROOM_RE.test(String(room)) || (to !== "phone" && to !== "daemon") ||
          typeof blob !== "string" || !blob || blob.length > MAX_BLOB) {
        json(res, 400, { ok: false, error: "bad push" });
        return;
      }
      const r = roomOf(room);
      const live = r.listeners[to];
      if (live.size) {
        for (const l of live) { try { l.write(`event: m\ndata: ${blob}\n\n`); } catch { /* dropped */ } }
      } else {
        r.queue[to].push({ blob, ts: Date.now() });
        if (r.queue[to].length > QUEUE_CAP) r.queue[to].shift();
      }
      json(res, 200, { ok: true });
      return;
    }

    // --- subscribe to blobs addressed to me ---
    if (req.method === "GET" && pathname === "/pull") {
      const room = url.searchParams.get("room") || "";
      const as = url.searchParams.get("as") || "";
      if (!ROOM_RE.test(room) || (as !== "phone" && as !== "daemon")) {
        json(res, 400, { ok: false, error: "bad pull" });
        return;
      }
      const r = roomOf(room);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
      res.write(": awaykit relay stream open\n\n");
      // flush anything queued while this side was away
      const now = Date.now();
      for (const q of r.queue[as]) if (now - q.ts < BLOB_TTL_MS) res.write(`event: m\ndata: ${q.blob}\n\n`);
      r.queue[as] = [];
      r.listeners[as].add(res);
      const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
      req.on("close", () => { clearInterval(keepAlive); r.listeners[as].delete(res); });
      return;
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    try { json(res, 400, { ok: false, error: String((err && err.message) || err) }); } catch { /* socket gone */ }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  awaykit relay — zero-knowledge ciphertext shuttle`);
  console.log(`  ────────────────────────────────────────────────`);
  console.log(`  listening on http://${HOST}:${PORT}`);
  console.log(`  It forwards sealed blobs it cannot read. No accounts, no disk state.`);
  console.log(`\n  Laptop side:  AWAYKIT_RELAY=<this url> npm start`);
  console.log(`  Phone side:   scan the QR the daemon prints (it points here)\n`);
});

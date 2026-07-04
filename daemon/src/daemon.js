/**
 * awaykit daemon — Milestone 0.
 *
 * A dependency-free Node HTTP server that bridges a coding agent on this
 * laptop to your phone on the same Wi-Fi:
 *
 *   Claude Code PreToolUse hook ──POST /hook──▶ daemon
 *                                                 │  (holds the agent blocked)
 *                                    SSE /events  ▼
 *                                             phone browser  ──▶ Approve / Deny
 *                                    POST /respond ─────────────┘
 *                                                 │
 *                        decision ◀───────────────┘ (unblocks the hook → the agent)
 *
 * No third-party deps, no crypto yet, no relay — just the loop working on your LAN.
 * Harden outward from here (see docs/SECURITY.md).
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.AWAYKIT_PORT || 4517);
const HOST = process.env.AWAYKIT_HOST || "0.0.0.0";

/** promptId -> { prompt, decide(choice), req } */
const pending = new Map();
/** connected phone SSE responses */
const clients = new Set();

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

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const c of clients) {
    try { sse(c, event, data); } catch { /* dropped on next tick */ }
  }
}

function publicPrompt(p) {
  // What the phone sees (no internal resolver / socket).
  return {
    promptId: p.promptId, tool: p.tool, summary: p.summary,
    detail: p.detail, sessionId: p.sessionId, cwd: p.cwd, ts: p.ts,
  };
}

// ---- request routing -------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;

  try {
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await readFile(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      json(res, 200, { ok: true, pending: pending.size, clients: clients.size });
      return;
    }

    // Phone subscribes to the live event stream.
    if (req.method === "GET" && pathname === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      res.write(": awaykit stream open\n\n");
      sse(res, "snapshot", { pending: [...pending.values()].map(publicPrompt) });
      clients.add(res);
      const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
      req.on("close", () => { clearInterval(keepAlive); clients.delete(res); });
      return;
    }

    // Phone answers a prompt.
    if (req.method === "POST" && pathname === "/respond") {
      const { promptId, choice } = await readBody(req);
      const entry = pending.get(promptId);
      if (!entry) { json(res, 404, { ok: false, error: "unknown or already-resolved prompt" }); return; }
      if (choice !== "approve" && choice !== "deny") { json(res, 400, { ok: false, error: "choice must be approve|deny" }); return; }
      entry.decide(choice);
      json(res, 200, { ok: true });
      return;
    }

    // The Claude Code hook shim calls this. For a permission request the daemon
    // holds the response open until the phone answers (or the hook gives up and
    // the socket closes — then Claude Code falls back to its normal prompt).
    if (req.method === "POST" && pathname === "/hook") {
      const ev = await readBody(req);

      if (ev.kind === "notify" || ev.kind === "stop") {
        broadcast("notify", { icon: ev.icon || (ev.kind === "stop" ? "🏁" : "🔔"), text: ev.text || ev.summary || "agent event" });
        json(res, 200, { ok: true });
        return;
      }

      // kind === "permission"
      // No phone connected = you're at the laptop. Don't intercept — let Claude
      // Code use its normal on-machine permission flow. Opening the phone client
      // is the signal "I'm away, route approvals to me."
      if (clients.size === 0) {
        json(res, 200, { ok: true, choice: null, reason: "no phone connected" });
        return;
      }

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
        broadcast("resolved", { promptId: prompt.promptId, choice });
        json(res, 200, { ok: true, choice });
      };

      prompt.decide = finish; // resolver used by /respond
      pending.set(prompt.promptId, { ...prompt, decide: finish });

      // If the hook aborts (its own timeout / agent killed), drop the prompt so
      // the phone card disappears and we don't leak state.
      req.on("close", () => {
        if (settled) return;
        settled = true;
        pending.delete(prompt.promptId);
        broadcast("resolved", { promptId: prompt.promptId, choice: "aborted" });
      });

      broadcast("prompt", publicPrompt(prompt));
      console.log(`[awaykit] → phone: ${prompt.tool} — ${prompt.summary}`);
      return; // response is sent later by finish()
    }

    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (err) {
    json(res, 400, { ok: false, error: String(err && err.message || err) });
  }
});

function lanURLs() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(`http://${net.address}:${PORT}`);
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log(`\n  awaykit daemon — Milestone 0`);
  console.log(`  ───────────────────────────`);
  console.log(`  local:   http://127.0.0.1:${PORT}`);
  for (const u of lanURLs()) console.log(`  phone:   ${u}   ← open this on your phone (same Wi-Fi)`);
  console.log(`\n  Waiting for hook events on POST /hook …\n`);
});

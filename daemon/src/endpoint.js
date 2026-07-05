/**
 * awaykit endpoint discovery — how loopback callers reach the daemon.
 *
 * The daemon may serve plain HTTP or (with AWAYKIT_TLS) self-signed HTTPS. So the
 * hook shim and the control CLI can't assume a scheme. On startup the daemon
 * writes ~/.awaykit/endpoint.json = { url, tls, port }; these helpers read it so
 * hook.js / ctl.js talk to the right scheme and trust the daemon's own
 * self-signed cert on loopback (verification there adds nothing — it's the same
 * machine — and would otherwise reject the cert).
 *
 * Precedence: explicit AWAYKIT_URL env > advertised endpoint.json > default HTTP.
 */

import http from "node:http";
import https from "node:https";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.AWAYKIT_HOME || join(homedir(), ".awaykit");
const ENDPOINT_PATH = join(CONFIG_DIR, "endpoint.json");

export function writeEndpoint(info) {
  try { mkdirSync(CONFIG_DIR, { recursive: true }); writeFileSync(ENDPOINT_PATH, JSON.stringify(info)); } catch { /* best effort */ }
}
export function clearEndpoint() { try { rmSync(ENDPOINT_PATH); } catch { /* ignore */ } }

function readEndpoint() {
  try { if (existsSync(ENDPOINT_PATH)) return JSON.parse(readFileSync(ENDPOINT_PATH, "utf8")); } catch { /* ignore */ }
  return null;
}

/** Resolve the daemon's loopback base URL and whether it's TLS. */
export function daemonEndpoint(port) {
  const env = process.env.AWAYKIT_URL;
  if (env) return { base: env.replace(/\/+$/, ""), tls: env.startsWith("https") };
  const ep = readEndpoint();
  if (ep && ep.url) return { base: String(ep.url).replace(/\/+$/, ""), tls: !!ep.tls };
  const p = port || Number(process.env.AWAYKIT_PORT || 4517);
  return { base: `http://127.0.0.1:${p}`, tls: false };
}

/**
 * Request the daemon over loopback. Uses http or https by `tls`, and for https
 * trusts the self-signed cert (rejectUnauthorized:false) — safe because this only
 * ever targets our own daemon on the same machine. timeoutMs=0 waits forever
 * (the hook's permission POST blocks until you answer on your phone).
 * @returns {Promise<{status:number, body:string}>}
 */
export function daemonRequest(base, path, { method = "GET", body = null, headers = {}, timeoutMs = 0, tls = false } = {}) {
  return new Promise((resolve, reject) => {
    const mod = tls ? https : http;
    const data = body != null ? (typeof body === "string" ? body : JSON.stringify(body)) : null;
    const h = { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers };
    const opts = { method, headers: h };
    if (tls) opts.rejectUnauthorized = false;
    const req = mod.request(base + path, opts, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on("error", reject);
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    if (data) req.write(data);
    req.end();
  });
}

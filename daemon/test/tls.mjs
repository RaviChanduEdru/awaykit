/**
 * awaykit v0.7 TLS test — the self-signed HTTPS LAN mode, end to end.
 *
 * Boots the daemon with AWAYKIT_TLS=1, then drives the full encrypted flow over
 * HTTPS the way a paired phone would (accepting the self-signed cert on
 * loopback), and confirms the real hook.js discovers the https endpoint via
 * endpoint.json and gets a decision. Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import https from "node:https";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { X509Certificate } from "node:crypto";
import nacl from "tweetnacl";
import { daemonRequest } from "../src/endpoint.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(__dirname, "..", "src", "daemon.js");
const HOOK = join(__dirname, "..", "src", "hook.js");
const HOME = mkdtempSync(join(tmpdir(), "awaykit-tls-"));
const PORT = 4594;
const BASE = `https://127.0.0.1:${PORT}`;

const b64e = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const seal = (k, o) => { const n = nacl.randomBytes(24); const c = nacl.secretbox(new TextEncoder().encode(JSON.stringify(o)), n, k); const out = new Uint8Array(24 + c.length); out.set(n); out.set(c, 24); return b64e(out); };
const openS = (k, s) => { const d = b64d(s); const m = nacl.secretbox.open(d.slice(24), d.slice(0, 24), k); return m ? JSON.parse(new TextDecoder().decode(m)) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c, l) => { if (!c) throw new Error("FAIL: " + l); passed++; console.log("  ✓ " + l); };
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(30); } return false; }
const req = (method, path, opts = {}) => daemonRequest(BASE, path, { method, tls: true, ...opts });

// SSE over https, accepting the self-signed cert
function sse(path, headers, onMsg) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + path);
    const r = https.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers, rejectUnauthorized: false }, (res) => {
      if (res.statusCode !== 200) { reject(new Error("sse " + res.statusCode)); return; }
      let buf = "";
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const bl = buf.slice(0, i); buf = buf.slice(i + 2); if (bl.startsWith("event: m")) { const l = bl.split("\n").find((x) => x.startsWith("data: ")); if (l) onMsg(l.slice(6)); } } });
      resolve({ close: () => r.destroy() });
    });
    r.on("error", reject); r.end();
  });
}
function runHook(input) {
  return new Promise((resolve) => {
    // No AWAYKIT_URL: hook.js must discover the https endpoint from endpoint.json.
    const h = spawn(process.execPath, [HOOK], { env: { ...process.env, AWAYKIT_HOME: HOME } });
    let out = ""; h.stdout.on("data", (c) => (out += c));
    h.on("exit", (code) => resolve({ out, code }));
    h.stdin.write(JSON.stringify(input)); h.stdin.end();
  });
}

const child = spawn(process.execPath, [DAEMON], { env: { ...process.env, AWAYKIT_HOME: HOME, AWAYKIT_PORT: String(PORT), AWAYKIT_HOST: "127.0.0.1", AWAYKIT_TLS: "1" }, stdio: "ignore" });
const done = (c) => { try { child.kill(); } catch {} process.exit(c); };
child.on("exit", (c) => { if (c) { console.error("daemon exited early: " + c); process.exit(1); } });

try {
  const up = await until(async () => { try { return (await req("GET", "/health")).status === 200; } catch { return false; } }, 6000);
  ok(up, "daemon boots over HTTPS and /health responds (self-signed cert accepted on loopback)");

  ok(existsSync(join(HOME, "tls-cert.pem")) && existsSync(join(HOME, "tls-key.pem")), "self-signed cert + key persisted to ~/.awaykit");
  const fp = new X509Certificate(readFileSync(join(HOME, "tls-cert.pem"), "utf8")).fingerprint256;
  ok(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(fp), "cert exposes a SHA-256 fingerprint to verify");

  const ep = JSON.parse(readFileSync(join(HOME, "endpoint.json"), "utf8"));
  ok(ep.tls === true && ep.url.startsWith("https://"), "daemon advertises its https endpoint for hook.js / ctl.js");

  const shell = await req("GET", "/");
  ok(shell.status === 200 && /awaykit/.test(shell.body), "app shell is served over HTTPS");

  const key = b64d(readFileSync(join(HOME, "key"), "utf8").trim());
  const eph = nacl.box.keyPair();
  const sess = await req("POST", "/session", { body: { proof: seal(key, { p: "awaykit-session", t: Date.now(), epk: b64e(eph.publicKey) }) } });
  ok(sess.status === 200 && sess.headers["set-cookie"], "pairing handshake completes over HTTPS");
  const cookie = sess.headers["set-cookie"][0].split(";")[0];
  const sk = nacl.box.before(b64d(openS(key, JSON.parse(sess.body).edk).dpk), eph.secretKey);

  const got = [];
  const stream = await sse("/events", { cookie }, (d) => { const p = openS(sk, d); if (p) got.push(p); });
  ok(await until(() => got.some((p) => p.type === "snapshot"), 1500), "encrypted SSE stream opens over HTTPS and sends a snapshot");

  // the REAL hook.js binary must find the https endpoint on its own and get a decision
  const hookRun = runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo tls" }, session_id: "s", cwd: "/tmp" });
  ok(await until(() => got.some((p) => p.type === "prompt" && p.summary === "Run: echo tls"), 4000), "hook.js (via endpoint.json) delivers a card over HTTPS");
  const p = got.find((x) => x.type === "prompt" && x.summary === "Run: echo tls");
  await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: p.promptId, choice: "approve" }) } });
  const hout = JSON.parse((await hookRun).out);
  ok(hout.hookSpecificOutput.permissionDecision === "allow", "hook.js gets the approve decision back over the HTTPS loopback");

  stream.close();
  console.log(`\nALL ${passed} TLS CHECKS PASSED ✅`);
  done(0);
} catch (e) {
  console.error("\n" + (e && e.message || e));
  done(1);
}

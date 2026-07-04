/**
 * awaykit v0.1 end-to-end test — no external test runner.
 *
 * Spawns the daemon with a throwaway key dir, then drives the full encrypted
 * flow the way a paired phone would: prove-key handshake → session cookie →
 * sealed SSE stream → fire a hook → decrypt the prompt → sealed approve →
 * assert the hook receives the decision. Also checks the negative paths
 * (no auth, bad key). Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";
import { pickPairingHost, candidateHosts } from "../src/net.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(__dirname, "..", "src", "daemon.js");
const HOME = mkdtempSync(join(tmpdir(), "awaykit-test-"));
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;

// crypto — must match daemon/src/crypto.js and public/index.html
const b64e = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const seal = (key, obj) => {
  const n = nacl.randomBytes(24);
  const box = nacl.secretbox(new TextEncoder().encode(JSON.stringify(obj)), n, key);
  const o = new Uint8Array(24 + box.length); o.set(n); o.set(box, 24); return b64e(o);
};
const openS = (key, s) => {
  const d = b64d(s); const m = nacl.secretbox.open(d.slice(24), d.slice(0, 24), key);
  return m ? JSON.parse(new TextDecoder().decode(m)) : null;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, label) { if (!cond) throw new Error("FAIL: " + label); passed++; console.log("  ✓ " + label); }
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request(BASE + path, { method, headers: h }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
function sseConnect(cookie, onMsg) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + "/events", { headers: { cookie } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error("events status " + res.statusCode)); return; }
      let buf = "";
      res.on("data", (c) => {
        buf += c; let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith("event: m")) {
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) onMsg(line.slice(6));
          }
        }
      });
      resolve({ close: () => r.destroy() });
    });
    r.on("error", reject); r.end();
  });
}

const child = spawn(process.execPath, [DAEMON], {
  env: { ...process.env, AWAYKIT_HOME: HOME, AWAYKIT_PORT: String(PORT), AWAYKIT_HOST: "127.0.0.1" },
  stdio: "ignore",
});
function done(code) { try { child.kill(); } catch {} process.exit(code); }
child.on("exit", (c) => { if (c) { console.error("daemon exited early: " + c); process.exit(1); } });

try {
  // address selection (pure, no daemon needed)
  const fakeIfaces = {
    "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.5" }],
    "tailscale0": [{ family: "IPv4", internal: false, address: "100.101.102.103" }],
    "lo": [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
  };
  ok(pickPairingHost(fakeIfaces).ip === "100.101.102.103" && pickPairingHost(fakeIfaces).kind === "vpn", "pairing prefers the VPN (Tailscale) address over LAN");
  ok(pickPairingHost({ "eth0": [{ family: "IPv4", internal: false, address: "100.64.0.9" }] }).kind === "vpn", "CGNAT 100.64/10 detected as VPN even without a VPN iface name");
  ok(pickPairingHost({ "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.1.5" }] }).ip === "192.168.1.5", "falls back to LAN when no VPN present");
  ok(pickPairingHost(fakeIfaces, "away.example.com").ip === "away.example.com", "AWAYKIT_PUBLIC_HOST overrides everything");
  ok(pickPairingHost({}).ip === "127.0.0.1", "empty interfaces -> loopback");
  ok(candidateHosts(fakeIfaces).filter((c) => c.kind === "vpn").length === 1, "candidateHosts classifies the VPN interface");

  // wait for daemon
  const up = await until(async () => { try { return (await req("GET", "/health")).status === 200; } catch { return false; } }, 5000);
  ok(up, "daemon boots and /health responds");

  const key = b64d(readFileSync(join(HOME, "key"), "utf8").trim());
  ok(key.length === 32, "pairing key persisted (32 bytes)");

  ok((await req("GET", "/events")).status === 401, "/events without a session is rejected (401)");
  ok((await req("POST", "/respond", { body: { c: seal(key, { promptId: "x", choice: "approve" }) } })).status === 401, "/respond without a session is rejected (401)");

  const badKey = nacl.randomBytes(32);
  ok((await req("POST", "/session", { body: { proof: seal(badKey, { p: "awaykit-session", t: Date.now() }) } })).status === 401, "wrong key => pairing proof rejected (401)");

  // authenticated ephemeral X25519 handshake -> per-session forward secrecy
  const eph = nacl.box.keyPair();
  const sess = await req("POST", "/session", { body: { proof: seal(key, { p: "awaykit-session", t: Date.now(), epk: b64e(eph.publicKey) }) } });
  ok(sess.status === 200 && sess.headers["set-cookie"], "correct key + ephemeral pubkey => session established");
  const cookie = sess.headers["set-cookie"][0].split(";")[0];
  const edk = openS(key, JSON.parse(sess.body).edk);
  ok(edk && edk.dpk, "daemon returns its ephemeral pubkey, sealed under K");
  const sk = nacl.box.before(b64d(edk.dpk), eph.secretKey);

  const eph2 = nacl.box.keyPair();
  const sess2 = await req("POST", "/session", { body: { proof: seal(key, { p: "awaykit-session", t: Date.now(), epk: b64e(eph2.publicKey) }) } });
  const sk2 = nacl.box.before(b64d(openS(key, JSON.parse(sess2.body).edk).dpk), eph2.secretKey);
  ok(b64e(sk) !== b64e(sk2), "each session derives a distinct ephemeral key");

  const got = [], raw = [];
  const stream = await sseConnect(cookie, (data) => { raw.push(data); const p = openS(sk, data); if (p) got.push(p); });
  ok(await until(() => got.some((p) => p.type === "snapshot"), 1000), "SSE opens and sends a snapshot sealed with the session key");
  ok(raw.length > 0 && openS(key, raw[0]) === null && openS(sk, raw[0]) !== null, "channel uses the ephemeral session key, NOT the long-term key K (forward secrecy)");
  ok(await until(async () => (await req("GET", "/health")).body.includes('"clients":1'), 1000), "daemon counts the paired client");

  const hookP = req("POST", "/hook", { body: { kind: "permission", tool: "Bash", summary: "Run: npm test", detail: "npm test", sessionId: "sess1" } });
  ok(await until(() => got.some((p) => p.type === "prompt"), 2000), "hook prompt is delivered over the encrypted stream");
  const prompt = got.find((p) => p.type === "prompt");
  ok(prompt.summary === "Run: npm test", "decrypted prompt content matches what the hook sent");

  const resp = await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: prompt.promptId, choice: "approve" }) } });
  ok(resp.status === 200, "sealed approve accepted");
  const hookRes = JSON.parse((await hookP).body);
  ok(hookRes.choice === "approve", "hook (the agent) receives the approve decision");
  ok(await until(() => got.some((p) => p.type === "resolved" && p.promptId === prompt.promptId), 1000), "resolved event broadcast to the stream");

  // tamper check: flipping a ciphertext byte must not decrypt
  const sealed = seal(key, { hi: 1 });
  const tampered = sealed.slice(0, -2) + (sealed.slice(-2) === "AA" ? "AB" : "AA");
  ok(openS(key, tampered) === null, "tampered ciphertext fails to open (auth tag holds)");

  stream.close();
  console.log(`\nALL ${passed} CHECKS PASSED ✅`);
  done(0);
} catch (e) {
  console.error("\n" + (e && e.message || e));
  done(1);
}

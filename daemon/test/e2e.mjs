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
import { describe } from "../src/describe.js";
import { roomIdFromKey } from "../src/crypto.js";

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

function reqTo(base, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request(base + path, { method, headers: h }, (res) => {
      let buf = ""; res.on("data", (c) => (buf += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
const req = (method, path, opts) => reqTo(BASE, method, path, opts);

/** Subscribe to any awaykit SSE stream (daemon /events or relay /pull). */
function sseRaw(fullUrl, headers, onMsg) {
  return new Promise((resolve, reject) => {
    const r = http.request(fullUrl, { headers }, (res) => {
      if (res.statusCode !== 200) { reject(new Error("sse status " + res.statusCode)); return; }
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

/** Run the real hook.js as Claude Code would: JSON event on stdin, decision JSON on stdout. */
function runHook(input) {
  return new Promise((resolve) => {
    const h = spawn(process.execPath, [join(__dirname, "..", "src", "hook.js")], {
      env: { ...process.env, AWAYKIT_URL: BASE },
    });
    let out = ""; h.stdout.on("data", (c) => (out += c));
    h.on("exit", (code) => resolve({ out, code }));
    h.stdin.write(JSON.stringify(input)); h.stdin.end();
  });
}

const child = spawn(process.execPath, [DAEMON], {
  env: { ...process.env, AWAYKIT_HOME: HOME, AWAYKIT_PORT: String(PORT), AWAYKIT_HOST: "127.0.0.1", AWAYKIT_STOP_WAIT_MS: "1500" },
  stdio: "ignore",
});
let relayProc = null, relayedDaemon = null;
function done(code) {
  for (const p of [child, relayProc, relayedDaemon]) { try { p && p.kill(); } catch {} }
  process.exit(code);
}
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

  // rich approval cards (describe) — pure
  const wCard = describe("Write", { file_path: "/a/b.js", content: "line1\nline2\nline3" });
  ok(wCard.summary.includes("3 lines") && wCard.detail.includes("line2"), "Write card shows line count + the file contents");
  const eCard = describe("Edit", { file_path: "/a/b.js", old_string: "foo", new_string: "bar" });
  ok(eCard.detail.includes("- foo") && eCard.detail.includes("+ bar"), "Edit card shows a -/+ diff");
  ok(describe("Bash", { command: "npm test" }).detail === "npm test", "Bash card shows the exact command");
  ok(describe("Write", { file_path: "x", content: "z".repeat(5000) }).detail.includes("more chars"), "oversized content is clipped");

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

  // with no phone connected, a turn-end question passes straight through
  const idleStop = JSON.parse((await req("POST", "/hook", { body: { kind: "stop" } })).body);
  ok(idleStop.choice === null, "turn-end with no phone connected passes through instantly (agent stops normally)");

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

  // audit log — every decision is recorded, append-only
  const auditLines = readFileSync(join(HOME, "audit.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lastAudit = auditLines[auditLines.length - 1];
  ok(lastAudit.decision === "approve" && lastAudit.summary === "Run: npm test" && typeof lastAudit.ts === "number", "the decision is recorded in the append-only audit log");
  const auditResp = await req("GET", "/audit");
  ok(auditResp.status === 200 && JSON.parse(auditResp.body).entries.some((e) => e.decision === "approve"), "GET /audit returns the log over loopback");

  // ---- chat steering (v0.4) -------------------------------------------------

  // deny + typed note → the note rides back to the hook (Claude reads it as feedback)
  const hookP2 = req("POST", "/hook", { body: { kind: "permission", tool: "Bash", summary: "Run: npm publish", detail: "npm publish", sessionId: "sess1" } });
  ok(await until(() => got.some((p) => p.type === "prompt" && p.summary === "Run: npm publish"), 2000), "second permission prompt delivered");
  const p2 = got.find((p) => p.type === "prompt" && p.summary === "Run: npm publish");
  await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: p2.promptId, choice: "deny", note: "use npm pack first, don't publish yet" }) } });
  const hookRes2 = JSON.parse((await hookP2).body);
  ok(hookRes2.choice === "deny" && hookRes2.note === "use npm pack first, don't publish yet", "deny carries your typed note back to the hook");

  // turn-end card → "continue + instruction" flows back to the Stop hook
  const stopP = req("POST", "/hook", { body: { kind: "stop", sessionId: "sess1" } });
  ok(await until(() => got.some((p) => p.type === "prompt" && p.kind === "stop"), 2000), "turn-end question reaches the phone as a card");
  const sp = got.find((p) => p.type === "prompt" && p.kind === "stop");
  ok(typeof sp.expiresAt === "number" && sp.expiresAt > Date.now(), "turn-end card carries its answer deadline");
  ok((await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: sp.promptId, choice: "approve" }) } })).status === 400, "approve is rejected on a turn-end card (must be continue|stop)");
  await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: sp.promptId, choice: "continue", note: "now add tests for the audit log" }) } });
  const stopRes = JSON.parse((await stopP).body);
  ok(stopRes.choice === "continue" && stopRes.note === "now add tests for the audit log", "'continue + instruction' flows back to the Stop hook");
  const audit2 = JSON.parse((await req("GET", "/audit")).body).entries;
  ok(audit2.some((e) => e.decision === "continue" && (e.note || "").includes("audit log")), "your continue instruction lands in the audit log");

  // unanswered turn-end question expires (AWAYKIT_STOP_WAIT_MS=1500 in this test)
  const t0 = Date.now();
  const stopRes2 = JSON.parse((await req("POST", "/hook", { body: { kind: "stop" } })).body);
  ok(stopRes2.choice === null && Date.now() - t0 >= 1200, "unanswered turn-end question expires and lets the agent stop");
  ok(await until(() => got.some((p) => p.type === "resolved" && p.choice === "expired"), 1000), "expiry is broadcast so the card disappears");

  // ---- the real hook.js binary, end to end ----------------------------------

  // PreToolUse: deny + note becomes a permissionDecision Claude Code understands
  const hookRun = runHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" }, session_id: "sessH", cwd: "/tmp" });
  ok(await until(() => got.some((p) => p.type === "prompt" && p.summary === "Run: rm -rf build"), 3000), "real hook.js delivers a PreToolUse card");
  const hp = got.find((p) => p.type === "prompt" && p.summary === "Run: rm -rf build");
  await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: hp.promptId, choice: "deny", note: "clean with git clean instead" }) } });
  const hout = JSON.parse((await hookRun).out);
  ok(hout.hookSpecificOutput.permissionDecision === "deny" && hout.hookSpecificOutput.permissionDecisionReason.includes("git clean instead"), "hook.js emits deny + your note for Claude to read");

  // Stop: continue + text becomes {decision:block, reason} — the agent keeps going
  const stopRun = runHook({ hook_event_name: "Stop", session_id: "sessH" });
  ok(await until(() => got.filter((p) => p.type === "prompt" && p.kind === "stop").length >= 3, 3000), "real hook.js delivers the turn-end card");
  const sp2 = got.filter((p) => p.type === "prompt" && p.kind === "stop").pop();
  await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: sp2.promptId, choice: "continue", note: "continue: wire the next feature" }) } });
  const sout = JSON.parse((await stopRun).out);
  ok(sout.decision === "block" && sout.reason.includes("wire the next feature"), "hook.js emits {decision:block, reason} so the agent continues with your text");

  // SubagentStop stays a lightweight notification
  const subRun = runHook({ hook_event_name: "SubagentStop", session_id: "sessH" });
  ok(await until(() => got.some((p) => p.type === "notify" && /subagent/i.test(p.text || "")), 3000), "SubagentStop arrives as a feed notification, not a card");
  ok((await subRun).code === 0, "SubagentStop hook exits cleanly");

  // ---- zero-knowledge relay (v0.5): remote phone, no VPN ---------------------

  const RELAY_PORT = 4598, RD_PORT = 4597;
  const RELAY_BASE = `http://127.0.0.1:${RELAY_PORT}`, RD_BASE = `http://127.0.0.1:${RD_PORT}`;
  relayProc = spawn(process.execPath, [join(__dirname, "..", "..", "relay", "server.js")], {
    env: { ...process.env, PORT: String(RELAY_PORT), HOST: "127.0.0.1" }, stdio: "ignore",
  });
  ok(await until(async () => { try { return (await reqTo(RELAY_BASE, "GET", "/health")).status === 200; } catch { return false; } }, 5000), "relay server boots");

  // a second daemon, same key (same HOME), linked outbound to the relay
  relayedDaemon = spawn(process.execPath, [DAEMON], {
    env: { ...process.env, AWAYKIT_HOME: HOME, AWAYKIT_PORT: String(RD_PORT), AWAYKIT_HOST: "127.0.0.1", AWAYKIT_RELAY: RELAY_BASE }, stdio: "ignore",
  });
  ok(await until(async () => { try { return (await reqTo(RD_BASE, "GET", "/health")).status === 200; } catch { return false; } }, 5000), "relay-linked daemon boots");

  const room = roomIdFromKey(key);
  ok(/^[A-Za-z0-9_-]{8,64}$/.test(room), "room id derives from K and is relay-safe (reveals nothing)");

  // the "remote phone": talks ONLY to the relay
  const rRaw = [];
  const rStream = await sseRaw(`${RELAY_BASE}/pull?room=${room}&as=phone`, {}, (d) => rRaw.push(d));
  const ephR = nacl.box.keyPair();
  await reqTo(RELAY_BASE, "POST", "/push", { body: { room, to: "daemon", blob: seal(key, { p: "awaykit-session", t: Date.now(), epk: b64e(ephR.publicKey) }) } });
  ok(await until(() => rRaw.some((b) => openS(key, b)?.dpk), 5000), "relay handshake: daemon answers with its ephemeral pubkey (sealed under K)");
  const rsk = nacl.box.before(b64d(openS(key, rRaw.find((b) => openS(key, b)?.dpk)).dpk), ephR.secretKey);
  ok(await until(() => rRaw.some((b) => openS(rsk, b)?.type === "snapshot"), 3000), "snapshot arrives through the relay, sealed with the session key");
  ok(await until(async () => (await reqTo(RD_BASE, "GET", "/health")).body.includes('"clients":1'), 3000), "remote phone counts as a connected client (connection-is-the-switch works remotely)");

  // real permission flow: hook on the laptop -> card on the remote phone -> approve back
  const rHookP = reqTo(RD_BASE, "POST", "/hook", { body: { kind: "permission", tool: "Bash", summary: "Run: relay e2e", sessionId: "rsess" } });
  ok(await until(() => rRaw.some((b) => openS(rsk, b)?.type === "prompt"), 4000), "hook prompt reaches the remote phone through the relay");
  const rPrompt = rRaw.map((b) => openS(rsk, b)).find((p) => p && p.type === "prompt");
  await reqTo(RELAY_BASE, "POST", "/push", { body: { room, to: "daemon", blob: seal(rsk, { promptId: rPrompt.promptId, choice: "approve", note: "from far away" }) } });
  const rHookRes = JSON.parse((await rHookP).body);
  ok(rHookRes.choice === "approve" && rHookRes.note === "from far away", "approval (with note) flows back through the relay and unblocks the hook");

  // the zero-knowledge property, asserted: nothing on the relay wire was plaintext
  ok(rRaw.length > 0 && rRaw.every((b) => { try { JSON.parse(b); return false; } catch { return true; } }), "relay carried only opaque ciphertext blobs");
  rStream.close();

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

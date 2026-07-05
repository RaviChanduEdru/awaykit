/**
 * awaykit live-chat end-to-end test (v0.9) — hermetic, no real model.
 *
 * Spawns the daemon with chat ON and a FAKE agent (test/fake-agent.mjs) wired in
 * via AWAYKIT_AGENT_CMD, then drives the whole loop the way a paired phone would:
 * pair → snapshot advertises chat + projects → start a session → stream a reply
 * → tool chip → interrupt → kill → and the allow-list / auth guards. Also checks
 * hook.js's managed-session behavior directly. Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(__dirname, "..", "src", "daemon.js");
const HOOK = join(__dirname, "..", "src", "hook.js");
const FAKE = join(__dirname, "fake-agent.mjs");
const HOME = mkdtempSync(join(tmpdir(), "awaykit-chat-"));
const PROJECT = join(HOME, "proj"); mkdirSync(PROJECT, { recursive: true });
const PORT = 4602;
const BASE = `http://127.0.0.1:${PORT}`;

const b64e = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const seal = (key, obj) => { const n = nacl.randomBytes(24); const box = nacl.secretbox(new TextEncoder().encode(JSON.stringify(obj)), n, key); const o = new Uint8Array(24 + box.length); o.set(n); o.set(box, 24); return b64e(o); };
const openS = (key, s) => { const d = b64d(s); const m = nacl.secretbox.open(d.slice(24), d.slice(0, 24), key); return m ? JSON.parse(new TextDecoder().decode(m)) : null; };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (c, l) => { if (!c) throw new Error("FAIL: " + l); passed++; console.log("  ✓ " + l); };
async function until(fn, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const h = { ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers };
    const r = http.request(BASE + path, { method, headers: h }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on("error", reject); if (data) r.write(data); r.end();
  });
}
function sseConnect(cookie, onMsg) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + "/events", { headers: { cookie } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error("events " + res.statusCode));
      let buf = "";
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const block = buf.slice(0, i); buf = buf.slice(i + 2); if (block.startsWith("event: m")) { const line = block.split("\n").find((l) => l.startsWith("data: ")); if (line) onMsg(line.slice(6)); } } });
      resolve({ close: () => r.destroy() });
    });
    r.on("error", reject); r.end();
  });
}
function runHook(input, env = {}) {
  return new Promise((resolve) => {
    const h = spawn(process.execPath, [HOOK], { env: { ...process.env, AWAYKIT_URL: BASE, ...env } });
    let out = ""; h.stdout.on("data", (c) => (out += c));
    h.on("exit", (code) => resolve({ out, code }));
    h.stdin.write(JSON.stringify(input)); h.stdin.end();
  });
}

const child = spawn(process.execPath, [DAEMON], {
  env: {
    ...process.env, AWAYKIT_HOME: HOME, AWAYKIT_PORT: String(PORT), AWAYKIT_HOST: "127.0.0.1",
    AWAYKIT_CHAT: "1", AWAYKIT_PROJECTS: PROJECT, AWAYKIT_STOP_WAIT_MS: "1200",
    AWAYKIT_AGENT_CMD: JSON.stringify(["node", FAKE]),
  },
  stdio: "ignore",
});
function done(code) { try { child.kill(); } catch {} process.exit(code); }
child.on("exit", (c) => { if (c) { console.error("daemon exited early: " + c); process.exit(1); } });

try {
  ok(await until(async () => { try { return (await req("GET", "/health")).status === 200; } catch { return false; } }, 5000), "daemon boots with chat enabled");
  const key = b64d(readFileSync(join(HOME, "key"), "utf8").trim());

  // /chat requires a session cookie
  ok((await req("POST", "/chat", { body: { c: "x" } })).status === 401, "/chat without a session is rejected (401)");

  // handshake
  const eph = nacl.box.keyPair();
  const sess = await req("POST", "/session", { body: { proof: seal(key, { p: "awaykit-session", t: Date.now(), epk: b64e(eph.publicKey) }) } });
  const cookie = sess.headers["set-cookie"][0].split(";")[0];
  const sk = nacl.box.before(b64d(openS(key, JSON.parse(sess.body).edk).dpk), eph.secretKey);

  const events = [];
  const stream = await sseConnect(cookie, (data) => { const p = openS(sk, data); if (p) events.push(p); });
  const snap = await until(() => events.find((e) => e.type === "snapshot"), 1500) && events.find((e) => e.type === "snapshot");
  ok(snap && snap.chat === true, "snapshot advertises chat is ON");
  ok(snap.projects && snap.projects.includes(PROJECT), "snapshot lists the allow-listed project dir");

  const chat = (op, extra) => req("POST", "/chat", { headers: { cookie }, body: { c: seal(sk, { t: "chat", op, ...extra }) } });

  // start rejects a non-allow-listed dir
  const bad = JSON.parse((await chat("start", { projectDir: HOME })).body);
  ok(bad.ok === false && /allow-list/.test(bad.error), "start in a non-allow-listed dir is rejected");

  // start a real (fake-agent) session
  const started = JSON.parse((await chat("start", { projectDir: PROJECT })).body);
  ok(started.ok && started.sid, "start in an allow-listed dir returns a session id");
  const sid = started.sid;
  ok(await until(() => events.some((e) => e.type === "session.state" && e.sid === sid), 3000), "session.state broadcast for the new session");
  ok(await until(() => events.some((e) => e.type === "session.state" && e.sid === sid && e.agentSid), 4000), "agent session_id (from init) reaches the phone for card-mapping");

  // send a turn → streamed reply
  const n0 = events.length;
  await chat("send", { sid, text: "hello there" });
  ok(await until(() => events.some((e, i) => i >= n0 && e.type === "chat.msg" && e.role === "user" && e.text === "hello there"), 3000), "your message echoes back as a user bubble");
  ok(await until(() => events.some((e, i) => i >= n0 && e.type === "chat.delta" && e.sid === sid), 3000), "assistant reply streams as chat.delta");
  ok(await until(() => events.some((e, i) => i >= n0 && e.type === "chat.turn" && e.sid === sid), 4000), "chat.turn marks the turn finished (with cost/ms)");
  const assembled = events.filter((e, i) => i >= n0 && e.type === "chat.delta" && e.sid === sid).map((e) => e.text).join("");
  ok(assembled.includes("echo: hello there"), "streamed deltas assemble into the full reply");

  // a turn that uses a tool → surfaces a tool chip
  const n1 = events.length;
  await chat("send", { sid, text: "please run the build" });
  ok(await until(() => events.some((e, i) => i >= n1 && e.type === "chat.tool" && e.name === "Bash"), 3000), "tool use surfaces as a chat.tool chip");

  // interrupt
  const n2 = events.length;
  await chat("send", { sid, text: "write a long thing" });
  await sleep(30);
  await chat("interrupt", { sid });
  ok(await until(() => events.some((e, i) => i >= n2 && e.type === "chat.msg" && e.role === "system" && /interrupt/i.test(e.text)), 3000), "interrupt is reflected in the conversation");

  // audit trail
  const audit = JSON.parse((await req("GET", "/audit")).body).entries;
  ok(audit.some((e) => e.decision === "chat-start") && audit.some((e) => e.decision === "chat-send") && audit.some((e) => e.decision === "chat-interrupt"), "chat start/send/interrupt are all audited");

  // kill
  await chat("kill", { sid });
  ok(await until(() => events.some((e) => e.type === "session.gone" && e.sid === sid), 3000), "kill ends the session (session.gone)");

  // hook.js managed-session behavior: a Stop in a managed session emits nothing
  const managedStop = await runHook({ hook_event_name: "Stop", session_id: "x" }, { AWAYKIT_MANAGED: "1" });
  ok(managedStop.out.trim() === "" && managedStop.code === 0, "managed Stop hook stays silent (composer replaces the turn-end card)");

  // ---- ↩ Continue (adopt): a turn finished elsewhere becomes a phone session ----

  // an external (e.g. VS Code) session finishes a turn in an allow-listed dir …
  const extStop = req("POST", "/hook", { body: { kind: "stop", sessionId: "vscode-sess-1", cwd: PROJECT, lastResponse: "Finished wiring feature X — tests green." } });
  ok(await until(() => events.some((e) => e.type === "agent.msg" && e.text.includes("feature X")), 2000), "the external session's final response reaches the phone");
  const extCard = events.filter((e) => e.type === "prompt" && e.kind === "stop").pop();
  ok(extCard && (extCard.detail || "").includes("feature X"), "its turn-end card shows what was done");
  await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: extCard.promptId, choice: "stop" }) } });
  await extStop;

  // … a fresh phone (new snapshot) sees it as continuable …
  const eph2 = nacl.box.keyPair();
  const sess2 = await req("POST", "/session", { body: { proof: seal(key, { p: "awaykit-session", t: Date.now(), epk: b64e(eph2.publicKey) }) } });
  const cookie2 = sess2.headers["set-cookie"][0].split(";")[0];
  const sk2 = nacl.box.before(b64d(openS(key, JSON.parse(sess2.body).edk).dpk), eph2.secretKey);
  const events2 = [];
  const stream2 = await sseConnect(cookie2, (d) => { const p = openS(sk2, d); if (p) events2.push(p); });
  await until(() => events2.some((e) => e.type === "snapshot"), 2000);
  const snap2 = events2.find((e) => e.type === "snapshot");
  ok((snap2.recentTurns || []).some((t) => t.agentSid === "vscode-sess-1" && t.snippet.includes("feature X")), "snapshot lists the finished turn as ↩ continuable");

  // … and adopting it starts a session that resumes that conversation
  const adopted = JSON.parse((await chat("start", { projectDir: PROJECT, resumeId: "vscode-sess-1", label: "↩ proj" })).body);
  ok(adopted.ok, "adopt (start with resumeId) is accepted");
  ok(await until(() => events.some((e) => e.type === "session.state" && e.sid === adopted.sid && e.label === "↩ proj" && e.agentSid === "vscode-sess-1"), 4000), "adopted session carries the original conversation id (--resume) and ↩ label");
  await chat("kill", { sid: adopted.sid });
  const audit3 = JSON.parse((await req("GET", "/audit")).body).entries;
  ok(audit3.some((e) => e.decision === "chat-start" && /adopt/.test(e.summary)), "adoption is audited as an adopt");
  stream2.close();

  stream.close();
  console.log(`\nALL ${passed} CHAT CHECKS PASSED ✅`);
  done(0);
} catch (e) {
  console.error("\n" + ((e && e.message) || e));
  done(1);
}

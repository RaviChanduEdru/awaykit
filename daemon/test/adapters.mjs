/**
 * awaykit v0.8 adapters test — every agent adapter, end to end.
 *
 * Boots the daemon + a paired phone, then drives each adapter the way its agent
 * would (JSON event on stdin for the CLI shims; the plugin factory in-process for
 * OpenCode) and asserts the phone's decision comes back in that agent's exact
 * output format. Exits non-zero on any failure.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import nacl from "tweetnacl";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(__dirname, "..", "src", "daemon.js");
const ADAPTERS = join(__dirname, "..", "src", "adapters");
const HOME = mkdtempSync(join(tmpdir(), "awaykit-adapters-"));
const PORT = 4588;
const BASE = `http://127.0.0.1:${PORT}`;

const b64e = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64d = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const seal = (k, o) => { const n = nacl.randomBytes(24); const c = nacl.secretbox(new TextEncoder().encode(JSON.stringify(o)), n, k); const out = new Uint8Array(24 + c.length); out.set(n); out.set(c, 24); return b64e(out); };
const openS = (k, s) => { const d = b64d(s); const m = nacl.secretbox.open(d.slice(24), d.slice(0, 24), k); return m ? JSON.parse(new TextDecoder().decode(m)) : null; };
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
function sse(cookie, onMsg) {
  return new Promise((resolve, reject) => {
    const r = http.request(BASE + "/events", { headers: { cookie } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error("events " + res.statusCode)); return; }
      let buf = "";
      res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const bl = buf.slice(0, i); buf = buf.slice(i + 2); if (bl.startsWith("event: m")) { const l = bl.split("\n").find((x) => x.startsWith("data: ")); if (l) onMsg(l.slice(6)); } } });
      resolve({ close: () => r.destroy() });
    });
    r.on("error", reject); r.end();
  });
}
function runAdapter(script, input, args = []) {
  return new Promise((resolve) => {
    const h = spawn(process.execPath, [join(ADAPTERS, script), ...args], { env: { ...process.env, AWAYKIT_HOME: HOME } });
    let out = "", err = ""; h.stdout.on("data", (c) => (out += c)); h.stderr.on("data", (c) => (err += c));
    h.on("exit", (code) => resolve({ out, err, code }));
    if (input !== undefined) h.stdin.write(typeof input === "string" ? input : JSON.stringify(input));
    h.stdin.end();
  });
}

const child = spawn(process.execPath, [DAEMON], { env: { ...process.env, AWAYKIT_HOME: HOME, AWAYKIT_PORT: String(PORT), AWAYKIT_HOST: "127.0.0.1" }, stdio: "ignore" });
const done = (c) => { try { child.kill(); } catch {} process.exit(c); };
child.on("exit", (c) => { if (c) { console.error("daemon exited early: " + c); process.exit(1); } });

let got = [], cookie, sk;
/** Wait for a prompt card with the given summary, then answer it. */
async function cardThen(summary, choice, note) {
  ok(await until(() => got.some((p) => p.type === "prompt" && p.summary === summary), 4000), `card delivered: "${summary}"`);
  const p = got.find((x) => x.type === "prompt" && x.summary === summary);
  await req("POST", "/respond", { headers: { cookie }, body: { c: seal(sk, { promptId: p.promptId, choice, ...(note ? { note } : {}) }) } });
  return p;
}

try {
  ok(await until(async () => { try { return (await req("GET", "/health")).status === 200; } catch { return false; } }, 5000), "daemon boots");
  const key = b64d(readFileSync(join(HOME, "key"), "utf8").trim());
  const eph = nacl.box.keyPair();
  const sess = await req("POST", "/session", { body: { proof: seal(key, { p: "awaykit-session", t: Date.now(), epk: b64e(eph.publicKey) }) } });
  cookie = sess.headers["set-cookie"][0].split(";")[0];
  sk = nacl.box.before(b64d(openS(key, JSON.parse(sess.body).edk).dpk), eph.secretKey);
  const stream = await sse(cookie, (d) => { const p = openS(sk, d); if (p) got.push(p); });
  ok(await until(() => got.some((p) => p.type === "snapshot"), 1500), "phone paired + streaming");

  // ---- Codex (Claude-Code-style hookSpecificOutput) ----
  const codex = runAdapter("codex.js", { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf build" }, session_id: "s", cwd: "/r" });
  await cardThen("Run: rm -rf build", "approve");
  ok(JSON.parse((await codex).out).hookSpecificOutput.permissionDecision === "allow", "codex.js emits hookSpecificOutput.permissionDecision=allow on approve");

  // ---- Cursor ({ permission } + agent_message with your note) ----
  const cursor = runAdapter("cursor.js", { hook_event_name: "beforeShellExecution", command: "npm publish", cwd: "/r", conversation_id: "c1" });
  await cardThen("Run: npm publish", "deny", "run the tests first");
  const cout = JSON.parse((await cursor).out);
  ok(cout.permission === "deny" && /run the tests first/.test(cout.agent_message), "cursor.js emits permission=deny + your note in agent_message");

  // ---- Gemini ({ decision, reason }) ----
  const gemini = runAdapter("gemini.js", { hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "git push --force" }, session_id: "s", cwd: "/r" });
  await cardThen("Run: git push --force", "approve");
  ok(JSON.parse((await gemini).out).decision === "allow", "gemini.js emits decision=allow on approve");

  // ---- awaykit-ask (generic gate: exit 0 approve / 1 deny) ----
  const askYes = runAdapter("ask.js", undefined, ["Deploy to prod?", "kubectl apply -f prod.yaml"]);
  await cardThen("Deploy to prod?", "approve");
  ok((await askYes).code === 0, "awaykit-ask exits 0 on approve");
  const askNo = runAdapter("ask.js", undefined, ["Wipe the database?"]);
  const denied = await cardThen("Wipe the database?", "deny", "absolutely not");
  const askNoRes = await askNo;
  ok(askNoRes.code === 1 && /absolutely not/.test(askNoRes.err), "awaykit-ask exits 1 on deny and prints your note");

  // ---- OpenCode plugin (throws to deny; resolves to allow) ----
  process.env.AWAYKIT_HOME = HOME;
  const { awaykit } = await import("../src/adapters/opencode.js");
  const hooks = await awaykit({ directory: "/r" });
  let threw = false;
  const ocDeny = hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "rm -rf /" } }).catch(() => { threw = true; });
  await cardThen("Run: rm -rf /", "deny", "no way");
  await ocDeny;
  ok(threw, "opencode plugin THROWS (denies the tool) on a phone deny");
  const ocAllow = hooks["tool.execute.before"]({ tool: "bash" }, { args: { command: "ls -la" } });
  await cardThen("Run: ls -la", "approve");
  await ocAllow; // must not throw
  ok(true, "opencode plugin allows the tool on a phone approve");

  // ---- Aider (notify-only) ----
  const before = got.filter((p) => p.type === "notify").length;
  await runAdapter("aider-notify.js");
  ok(await until(() => got.filter((p) => p.type === "notify").length > before && /Aider is ready/.test(got.filter((p) => p.type === "notify").pop().text), 2000), "aider-notify.js buzzes the phone (notify only)");

  stream.close();
  console.log(`\nALL ${passed} ADAPTER CHECKS PASSED ✅`);
  done(0);
} catch (e) {
  console.error("\n" + (e && e.message || e));
  done(1);
}

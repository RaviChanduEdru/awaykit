/**
 * Phase-0 spike for docs/LIVE-CHAT.md — empirically probe Claude Code's
 * headless stream-json interface. Run by hand (never in CI; it spends a few
 * real model calls on the cheapest model):
 *
 *   node daemon/test/spike-stream.mjs
 *
 * Answers, with evidence printed as it goes:
 *   1. stdin shape for a user turn; does a SECOND turn on the same stdin work?
 *   2. does a control_request {subtype:"interrupt"} work mid-turn?
 *   3. which stdout event types do we see (init/assistant/stream_event/result)?
 *   4. do PreToolUse hooks fire from the spawned child (mock daemon approves)?
 *   5. does --resume <sid> in a fresh process keep the conversation context?
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRATCH = mkdtempSync(join(tmpdir(), "awaykit-spike-"));
const MODEL = process.env.SPIKE_MODEL || "haiku";
const findings = [];
const note = (s) => { findings.push(s); console.log("  ▸ " + s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 4. mock awaykit daemon: records /hook calls, auto-approves ------------
let hookCalls = [];
const mock = createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  let ev = {}; try { ev = JSON.parse(body || "{}"); } catch {}
  hookCalls.push(ev);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(ev.kind === "permission" ? { ok: true, choice: "approve", note: "" } : { ok: true, choice: null }));
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));
const MOCK_URL = `http://127.0.0.1:${mock.address().port}`;

// ---- child harness ----------------------------------------------------------
function startClaude(extraArgs = []) {
  const args = [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json",
    "--include-partial-messages", "--verbose", "--model", MODEL,
    "--permission-mode", "default", "--max-turns", "8", ...extraArgs,
  ];
  const child = spawn("claude", args, {
    cwd: SCRATCH,
    shell: process.platform === "win32", // claude is claude.cmd on Windows
    env: { ...process.env, AWAYKIT_URL: MOCK_URL }, // hooks hit the mock, not the live daemon
    stdio: ["pipe", "pipe", "pipe"],
  });
  const events = [];
  let buf = "";
  child.stdout.on("data", (c) => {
    buf += c.toString("utf8");
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { const ev = JSON.parse(line); events.push(ev); console.log("    « " + line.slice(0, 160)); }
      catch { console.log("    « (non-JSON) " + line.slice(0, 160)); }
    }
  });
  let err = "";
  child.stderr.on("data", (c) => { err += c; });
  const sendUser = (text) => {
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
    child.stdin.write(JSON.stringify(msg) + "\n");
    console.log("    » user: " + text);
  };
  const sendControl = (request) => {
    const msg = { type: "control_request", request_id: "spike-" + Math.random().toString(36).slice(2), request };
    child.stdin.write(JSON.stringify(msg) + "\n");
    console.log("    » control: " + JSON.stringify(request));
  };
  const waitFor = async (pred, ms) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const hit = events.find(pred); if (hit) return hit; await sleep(100); }
    return null;
  };
  return { child, events, sendUser, sendControl, waitFor, stderr: () => err };
}

try {
  console.log(`\nspike: scratch=${SCRATCH} model=${MODEL} mock=${MOCK_URL}\n`);
  writeFileSync(join(SCRATCH, "README.md"), "# spike scratch\n");

  // ---- 1+3: first turn over stdin, catalogue events -------------------------
  console.log("— turn 1: user message over stdin —");
  const a = startClaude();
  a.sendUser('Reply with exactly the single word: PONG1');
  const init = await a.waitFor((e) => e.type === "system" && e.subtype === "init", 30_000);
  note(init ? `init event arrives; session_id=${init.session_id}` : "NO init event within 30s ← stdin shape may be wrong");
  const res1 = await a.waitFor((e) => e.type === "result", 60_000);
  note(res1 ? `turn 1 completes over stdin (result: ${JSON.stringify(res1.result || "").slice(0, 60)}, cost=$${res1.total_cost_usd ?? "?"})` : "turn 1 NEVER completed ← " + a.stderr().slice(0, 300));
  const sawDelta = a.events.some((e) => e.type === "stream_event" && e.event?.delta?.type === "text_delta");
  note(sawDelta ? "token-level text_delta stream events confirmed" : "no text_delta events seen (partial streaming NOT confirmed)");
  note("event types seen: " + [...new Set(a.events.map((e) => e.type + (e.subtype ? "/" + e.subtype : "")))].join(", "));

  // ---- 2: second turn on the SAME stdin (persistent multi-turn) -------------
  console.log("\n— turn 2: second user message, same process —");
  const before = a.events.length;
  a.sendUser('Reply with exactly the single word: PONG2');
  const res2 = await a.waitFor((e) => e.type === "result" && a.events.indexOf(e) > before, 60_000);
  const alive = a.child.exitCode === null;
  note(res2 ? "PERSISTENT MULTI-TURN WORKS: second stdin turn completed in the same process" : `second turn did NOT complete (process ${alive ? "alive" : "exited " + a.child.exitCode}) ← use resume-per-turn fallback`);
  const sid = init?.session_id;

  // ---- 4: hooks — did the child call our mock daemon? ------------------------
  console.log("\n— turn 3: tool use → PreToolUse hook →  mock approval —");
  const beforeHook = hookCalls.length;
  a.sendUser("Run this exact bash command and tell me its output: echo spike-ok");
  await a.waitFor((e) => e.type === "result" && a.events.indexOf(e) > a.events.length - 1, 1); // nudge
  const res3 = await a.waitFor((e) => e.type === "result" && a.events.filter((x) => x.type === "result").length >= (res2 ? 3 : 2), 90_000);
  const permCalls = hookCalls.slice(beforeHook).filter((h) => h.kind === "permission");
  note(permCalls.length ? `PreToolUse hook FIRED from the spawned child (${permCalls.length}× — tool=${permCalls[0].tool}); mock approval unblocked it` : "hook did NOT fire (check ~/.claude settings hooks / matcher)");
  note(res3 ? "tool turn completed after approval" : "tool turn did not complete");
  const stopCalls = hookCalls.filter((h) => h.kind === "stop").length;
  note(`stop-hook calls seen by mock: ${stopCalls} (managed sessions will skip these)`);

  // ---- 2b: interrupt control message ----------------------------------------
  console.log("\n— interrupt: long turn, then control_request {subtype:interrupt} —");
  const beforeInt = a.events.filter((e) => e.type === "result").length;
  a.sendUser("Write a 2000-word essay about oceans. Do not use any tools.");
  await sleep(4000); // let it start generating
  a.sendControl({ subtype: "interrupt" });
  const ctrlResp = await a.waitFor((e) => e.type === "control_response", 15_000);
  const resInt = await a.waitFor((e) => e.type === "result" && a.events.filter((x) => x.type === "result").length > beforeInt, 20_000);
  note(ctrlResp ? `INTERRUPT WORKS: control_response received (${JSON.stringify(ctrlResp).slice(0, 120)})` : "no control_response ← fall back to kill+resume for interrupt");
  note(resInt ? `post-interrupt result subtype: ${resInt.subtype || "?"}` : "no result after interrupt");

  try { a.child.kill(); } catch {}

  // ---- 5: --resume in a fresh process keeps context ---------------------------
  if (sid) {
    console.log(`\n— resume: fresh process with --resume ${sid.slice(0, 8)}… —`);
    const b = startClaude(["--resume", sid]);
    b.sendUser("Without using tools: what exact word did I ask you to reply with in my very first message?");
    const resR = await b.waitFor((e) => e.type === "result", 60_000);
    const remembered = JSON.stringify(resR?.result || "").includes("PONG1");
    note(resR ? (remembered ? "RESUME KEEPS CONTEXT: recalled PONG1 in a fresh process" : `resume answered but didn't recall PONG1: ${JSON.stringify(resR.result || "").slice(0, 80)}`) : "resume turn did not complete");
    try { b.child.kill(); } catch {}
  } else {
    note("skipped --resume test (no session_id captured)");
  }

  console.log("\n========== FINDINGS ==========");
  findings.forEach((f) => console.log("  • " + f));
} finally {
  mock.close();
}
process.exit(0);

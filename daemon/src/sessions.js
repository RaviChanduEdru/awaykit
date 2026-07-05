/**
 * awaykit session manager — the live-chat engine (v0.9).
 *
 * Runs coding-agent sessions as child processes of the daemon and speaks the
 * agent's headless streaming protocol, so the phone can chat with the agent in
 * real time: start a session in an allow-listed project, stream the reply token
 * by token, send follow-ups, interrupt, kill — all over the same E2E-encrypted
 * channel, and all while the laptop keeps working.
 *
 * "Modes coexist." This is Chat mode. Gate mode (approval cards only) is
 * unaffected: a chat session's tool calls still fire the PreToolUse hook, so
 * the *existing* card flow gates them — chat and approvals compose. Managed
 * children get AWAYKIT_MANAGED=1 so hook.js skips the turn-end card (in a live
 * chat the composer IS "what next?").
 *
 * Protocol facts are from the Phase-0 spike (see docs/LIVE-CHAT.md):
 *  - stdin turn:   {type:"user", message:{role:"user", content:[{type:"text", text}]}}
 *  - interrupt:    {type:"control_request", request_id, request:{subtype:"interrupt"}}
 *  - stdout (NDJSON): system/init (session_id), stream_event (text_delta),
 *                     assistant (may hold tool_use), result (cost/duration).
 *
 * No HTTP or crypto here — state flows in/out via callbacks — so it stays
 * independently testable and transport-agnostic (local SSE + relay alike).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, basename } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "hook.js");
const CONFIG_DIR = process.env.AWAYKIT_HOME || join(homedir(), ".awaykit");

const TRANSCRIPT_CAP = 200;     // messages kept per session (memory only)
const SNAPSHOT_MSGS = 60;       // how many we replay to a reconnecting phone
const MAX_SESSIONS = 6;         // concurrent live sessions
const TEXT_CAP = 8000;          // clamp a single outbound user turn

/**
 * Build the argv for the coding agent. Overridable via AWAYKIT_AGENT_CMD (a JSON
 * array, e.g. ["node","/path/fake-agent.mjs"]) so tests inject a fake agent and
 * so a future adapter can point at a different CLI. Default: Claude Code.
 */
function agentCommand({ model, resumeId, settingsPath }) {
  const override = process.env.AWAYKIT_AGENT_CMD;
  const streamFlags = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode", "default",
  ];
  if (override) {
    // Fake/alt agent: give it the same stream flags (it may ignore them) + cwd.
    const base = JSON.parse(override);
    return { cmd: base[0], args: [...base.slice(1), ...streamFlags], shell: false };
  }
  // On Windows `claude` is a .cmd shim → needs shell:true to be spawnable. With
  // shell:true Node concatenates args unquoted, so we pass --settings as a FILE
  // path (never inline JSON, whose spaces/quotes would split into bogus argv)
  // and quote it in case a home dir contains spaces.
  const shell = process.platform === "win32";
  const q = (s) => (shell && /\s/.test(s) ? `"${s}"` : s);
  const args = [...streamFlags, "--model", model, "--settings", q(settingsPath)];
  if (resumeId) args.push("--resume", resumeId);
  return { cmd: "claude", args, shell };
}

/**
 * Write (once) the hook settings every managed Claude session loads via
 * --settings, so its tool calls are gated by the phone with zero user setup.
 * Points PreToolUse/Notification at our hook.js; the child env carries
 * AWAYKIT_MANAGED + AWAYKIT_URL. Returns the file path.
 */
let cachedSettingsPath = null;
function hookSettingsPath() {
  if (cachedSettingsPath) return cachedSettingsPath;
  const cmd = `node "${HOOK.replace(/\\/g, "/")}"`;
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch", hooks: [{ type: "command", command: cmd, timeout: 3600 }] }],
      Notification: [{ matcher: ".*", hooks: [{ type: "command", command: cmd }] }],
    },
  };
  const p = join(CONFIG_DIR, "chat-hook-settings.json");
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(settings, null, 2));
  cachedSettingsPath = p;
  return p;
}

/**
 * @param {object} opts
 * @param {(payload:object)=>void} opts.broadcast   push a sealed event to every phone
 * @param {(entry:object)=>void}   opts.audit       append to the audit log
 * @param {string[]}               opts.projects    absolute allow-listed project dirs
 * @param {string}                 [opts.model]     model alias for spawned sessions
 * @param {string}                 [opts.daemonUrl] AWAYKIT_URL for the child's hook
 * @param {(m:string)=>void}       [opts.log]
 */
export function createSessionManager({ broadcast, audit, projects, model = "sonnet", daemonUrl = "", log = console.log }) {
  /** sid -> session */
  const live = new Map();
  const allow = (projects || []).map((p) => resolve(p));

  const publicState = (s) => ({ sid: s.sid, label: s.label, cwd: s.cwd, state: s.state, model: s.model, ts: s.ts, agentSid: s.agentSid || "" });

  /** A reconnecting phone gets the full session list + recent transcript. */
  function snapshot() {
    return [...live.values()].map((s) => ({ ...publicState(s), transcript: s.transcript.slice(-SNAPSHOT_MSGS) }));
  }

  function pushMsg(s, role, text) {
    const m = { role, text, ts: Date.now() };
    s.transcript.push(m);
    if (s.transcript.length > TRANSCRIPT_CAP) s.transcript.shift();
    broadcast({ type: "chat.msg", sid: s.sid, role, text: m.text, ts: m.ts });
    return m;
  }

  function setState(s, state) {
    if (s.state === state) return;
    s.state = state;
    broadcast({ type: "session.state", ...publicState(s) });
  }

  /** Parse one NDJSON event from the agent's stdout. Unknown events are ignored. */
  function onEvent(s, ev) {
    switch (ev.type) {
      case "system":
        if (ev.subtype === "init" && ev.session_id && s.agentSid !== ev.session_id) {
          s.agentSid = ev.session_id; // for --resume, and so the phone can map tool-approval cards to this chat
          broadcast({ type: "session.state", ...publicState(s) });
        }
        break;
      case "stream_event": {
        const d = ev.event && ev.event.delta;
        if (d && d.type === "text_delta" && d.text) {
          s.cur += d.text;
          broadcast({ type: "chat.delta", sid: s.sid, text: d.text });
        }
        break;
      }
      case "assistant": {
        // Surface tool use as a chip; the actual gating happens over the hook path.
        const content = (ev.message && ev.message.content) || [];
        for (const b of content) {
          if (b.type === "tool_use") broadcast({ type: "chat.tool", sid: s.sid, name: b.name || "tool" });
        }
        break;
      }
      case "result": {
        // Turn finished: commit the streamed assistant text to the transcript.
        const text = s.cur.trim();
        s.cur = "";
        if (text) {
          s.transcript.push({ role: "assistant", text, ts: Date.now() });
          if (s.transcript.length > TRANSCRIPT_CAP) s.transcript.shift();
        }
        setState(s, "idle");
        broadcast({ type: "chat.turn", sid: s.sid, costUsd: ev.total_cost_usd || 0, ms: ev.duration_ms || 0, error: !!ev.is_error });
        break;
      }
    }
  }

  function wire(s) {
    let buf = "";
    s.proc.stdout.on("data", (c) => {
      buf += c.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        try { onEvent(s, ev); } catch (e) { log(`[awaykit] chat parse error: ${(e && e.message) || e}`); }
      }
    });
    s.proc.stderr.on("data", (c) => { s.err = (s.err + c.toString("utf8")).slice(-4000); });
    s.proc.on("exit", (code) => {
      setState(s, "dead");
      if (s.cur.trim()) pushMsg(s, "assistant", s.cur.trim()), (s.cur = "");
      if (code) pushMsg(s, "system", `Session ended (exit ${code}).${s.err ? " " + s.err.split("\n")[0] : ""}`);
      live.delete(s.sid);
      broadcast({ type: "session.gone", sid: s.sid });
      log(`[awaykit] chat session ${s.sid.slice(0, 8)} ended (exit ${code})`);
    });
    s.proc.on("error", (e) => { pushMsg(s, "system", `Failed to launch agent: ${(e && e.message) || e}`); setState(s, "dead"); live.delete(s.sid); });
  }

  // ---- public ops -----------------------------------------------------------

  function start({ projectDir, label } = {}) {
    if (live.size >= MAX_SESSIONS) return { ok: false, error: `too many sessions (max ${MAX_SESSIONS})` };
    const dir = resolve(projectDir || "");
    if (!allow.includes(dir)) return { ok: false, error: "project not in AWAYKIT_PROJECTS allow-list" };

    const sid = randomUUID();
    const { cmd, args, shell } = agentCommand({ model, settingsPath: hookSettingsPath() });
    let proc;
    try {
      proc = spawn(cmd, args, {
        cwd: dir, shell,
        env: { ...process.env, AWAYKIT_MANAGED: "1", ...(daemonUrl ? { AWAYKIT_URL: daemonUrl } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return { ok: false, error: `spawn failed: ${(e && e.message) || e}` };
    }
    const s = { sid, proc, cwd: dir, label: label || basename(dir), state: "running", model, ts: Date.now(), transcript: [], cur: "", err: "", agentSid: "" };
    live.set(sid, s);
    wire(s);
    audit({ tool: "chat", summary: `start session in ${basename(dir)}`, cwd: dir, sessionId: sid, decision: "chat-start" });
    broadcast({ type: "session.state", ...publicState(s) });
    log(`[awaykit] chat session ${sid.slice(0, 8)} started in ${dir}`);
    return { ok: true, sid };
  }

  function send({ sid, text } = {}) {
    const s = live.get(sid);
    if (!s) return { ok: false, error: "no such session" };
    if (s.state === "dead") return { ok: false, error: "session ended" };
    const t = String(text || "").slice(0, TEXT_CAP).trim();
    if (!t) return { ok: false, error: "empty message" };
    pushMsg(s, "user", t);
    setState(s, "running");
    const msg = { type: "user", message: { role: "user", content: [{ type: "text", text: t }] } };
    try { s.proc.stdin.write(JSON.stringify(msg) + "\n"); } catch (e) { return { ok: false, error: `write failed: ${(e && e.message) || e}` }; }
    audit({ tool: "chat", summary: t.slice(0, 120), cwd: s.cwd, sessionId: sid, decision: "chat-send" });
    return { ok: true };
  }

  function interrupt({ sid } = {}) {
    const s = live.get(sid);
    if (!s) return { ok: false, error: "no such session" };
    const msg = { type: "control_request", request_id: "awk-" + randomUUID(), request: { subtype: "interrupt" } };
    try { s.proc.stdin.write(JSON.stringify(msg) + "\n"); } catch { /* dead pipe */ }
    pushMsg(s, "system", "⏹ interrupted");
    audit({ tool: "chat", summary: "interrupt", cwd: s.cwd, sessionId: sid, decision: "chat-interrupt" });
    return { ok: true };
  }

  function kill({ sid } = {}) {
    const s = live.get(sid);
    if (!s) return { ok: false, error: "no such session" };
    try { s.proc.kill(); } catch { /* already gone */ }
    audit({ tool: "chat", summary: "kill session", cwd: s.cwd, sessionId: sid, decision: "chat-kill" });
    return { ok: true };
  }

  /** Route a sealed {t:"chat", op, …} message from any phone (local or relay). */
  function handle(msg) {
    switch (msg && msg.op) {
      case "start": return start({ projectDir: msg.projectDir, label: msg.label });
      case "send": return send({ sid: msg.sid, text: msg.text });
      case "interrupt": return interrupt({ sid: msg.sid });
      case "kill": return kill({ sid: msg.sid });
      default: return { ok: false, error: "unknown chat op" };
    }
  }

  function shutdown() { for (const s of live.values()) { try { s.proc.kill(); } catch {} } live.clear(); }

  return { start, send, interrupt, kill, handle, snapshot, list: () => [...live.values()].map(publicState), projects: () => allow, shutdown };
}

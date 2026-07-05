#!/usr/bin/env node
/**
 * awaykit adapter — Claude Code.
 *
 * Wire this as a PreToolUse / Notification / Stop hook (see docs/QUICKSTART.md).
 * It reads the hook event on stdin, forwards it to the local awaykit daemon via
 * the shared agent-core, and — for a permission request — waits for your phone's
 * decision, then prints the matching decision back to Claude Code on stdout. A
 * Deny can carry a typed note, which Claude reads as feedback and adapts to. When
 * the agent finishes a turn (Stop), your phone gets a "what next?" card —
 * answering with instructions holds the turn open and the agent keeps going.
 *
 * Fail-safe: if the daemon is unreachable, this exits 0 with no decision, so
 * Claude Code just falls back to its normal on-laptop prompt. awaykit being down
 * never breaks your agent.
 *
 * (Kept at src/hook.js for backward compatibility with existing hook configs;
 *  new agents live in src/adapters/. Shared logic is in agent-core.js.)
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { describe } from "./describe.js";
import { readStdinJSON, requestPermission, requestStop, notify, activity } from "./agent-core.js";

/**
 * Pull the agent's FINAL message out of the session transcript (JSONL). Reads
 * only the tail of the file, walks backwards to the last assistant text. This
 * is what makes the phone's turn-end card readable: you see what Claude said,
 * not just "turn finished". Fail-safe: any problem → "".
 */
function lastAssistantText(path, cap = 1500) {
  try {
    const size = statSync(path).size;
    const take = Math.min(size, 262_144);
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(take);
    readSync(fd, buf, 0, take, size - take);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let j; try { j = JSON.parse(lines[i]); } catch { continue; } // first tail line may be a partial record
      if (j.type !== "assistant" || !j.message) continue;
      const txt = (j.message.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (txt) return txt.length > cap ? txt.slice(0, cap) + "…" : txt;
    }
  } catch { /* fail-safe */ }
  return "";
}

/** One compact "what the tool DID" line for the phone's activity/chat log. */
function outcomeLine(ev) {
  const tool = ev.tool_name || "tool";
  const icon = tool === "Bash" ? "▶" : /Write|Edit|Notebook/.test(tool) ? "✏️" : tool === "WebFetch" ? "🌐" : "🔧";
  const { summary } = describe(tool, ev.tool_input);
  const r = ev.tool_response;
  let out = "";
  if (typeof r === "string") out = r;
  else if (r && typeof r === "object") out = r.stdout || r.output || r.stderr || (r.success === false ? "failed" : "");
  out = String(out).trim().replace(/\s+/g, " ").slice(0, 160);
  return { icon, text: summary + (out ? " → " + out : " → done") };
}

async function main() {
  const ev = await readStdinJSON();
  if (!ev) process.exit(0);
  const event = ev.hook_event_name || "";
  // A session the awaykit daemon spawned itself (live chat) sets this. In chat
  // mode the phone's composer IS "what next?", so we skip the turn-end card —
  // but tool-call gating (PreToolUse) and notifications still flow.
  const managed = process.env.AWAYKIT_MANAGED === "1";

  try {
    if (event === "Notification") {
      await notify({ icon: "🔔", text: ev.message || "Claude Code needs your attention" });
      process.exit(0);
    }

    if (event === "SubagentStop") {
      await notify({ icon: "🏁", text: "A subagent finished" });
      process.exit(0);
    }

    if (event === "PostToolUse") {
      // Report what the tool DID (not just that it ran) — a permanent line on
      // the phone: "▶ Run: npm test → 5 passing". Both modes, both sessions.
      const { icon, text } = outcomeLine(ev);
      await activity({ icon, text, sessionId: ev.session_id || "" });
      process.exit(0);
    }

    if (event === "Stop") {
      if (managed) process.exit(0); // chat mode: composer replaces the turn-end card
      // Ask the phone "what next?" — and include the agent's FINAL RESPONSE so
      // the question is answerable: you read what it said/did, then reply. If
      // the phone answers with an instruction, hold the turn open (decision:
      // "block"). No phone / no answer / "let it stop" → agent stops normally.
      const lastResponse = ev.transcript_path ? lastAssistantText(ev.transcript_path) : "";
      const result = await requestStop({ sessionId: ev.session_id, cwd: ev.cwd, stopActive: !!ev.stop_hook_active, lastResponse });
      if (result && result.choice === "continue") {
        process.stdout.write(JSON.stringify({
          decision: "block",
          reason: (result.note || "Continue with the next logical step.") + " (sent from your phone via awaykit)",
        }));
      }
      process.exit(0);
    }

    if (event === "PreToolUse") {
      const { summary, detail } = describe(ev.tool_name, ev.tool_input);
      const result = await requestPermission({ tool: ev.tool_name, summary, detail, sessionId: ev.session_id, cwd: ev.cwd });
      const choice = result && result.choice;
      const note = (result && result.note) || "";
      if (choice === "approve" || choice === "deny") {
        // Current Claude Code PreToolUse decision format. On a deny, the reason is
        // shown to Claude as feedback — so a typed note becomes a steering message
        // ("don't run that, do X instead") the agent acts on.
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: choice === "approve" ? "allow" : "deny",
            permissionDecisionReason: choice === "approve"
              ? "Approved from phone via awaykit"
              : "Denied from phone via awaykit" + (note ? ` — the user says: ${note}` : ""),
          },
        }));
      }
      // Any other outcome (aborted / no client) → no output → Claude Code prompts normally.
      process.exit(0);
    }

    process.exit(0); // unknown event: don't interfere
  } catch {
    process.exit(0); // daemon down / network error → let Claude Code handle it normally
  }
}

main();

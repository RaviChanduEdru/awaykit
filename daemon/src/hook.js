#!/usr/bin/env node
/**
 * awaykit hook shim for Claude Code.
 *
 * Wire this as a PreToolUse / Notification / Stop hook (see docs/QUICKSTART.md).
 * It reads the hook event on stdin, forwards it to the local awaykit daemon,
 * and — for a permission request — waits for your phone's decision, then prints
 * the matching permission decision back to Claude Code on stdout. A Deny can
 * carry a typed note, which Claude reads as feedback and adapts to. When the
 * agent finishes a turn (Stop), your phone gets a "what next?" card — answering
 * with instructions holds the turn open and the agent keeps going with them.
 *
 * Fail-safe: if the daemon is unreachable, this exits 0 with no decision, so
 * Claude Code just falls back to its normal on-laptop permission prompt. Your
 * agent is never broken by awaykit being down.
 */

import { describe } from "./describe.js";

const DAEMON = process.env.AWAYKIT_URL || "http://127.0.0.1:4517";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // If nothing is piped (e.g. run by hand), don't hang forever.
    setTimeout(() => resolve(data), 500).unref?.();
  });
}

async function postDaemon(payload) {
  const res = await fetch(`${DAEMON}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function main() {
  const raw = await readStdin();
  let ev = {};
  try { ev = JSON.parse(raw || "{}"); } catch { process.exit(0); }

  const event = ev.hook_event_name || "";

  try {
    if (event === "Notification") {
      await postDaemon({ kind: "notify", icon: "🔔", text: ev.message || "Claude Code needs your attention" });
      process.exit(0);
    }

    if (event === "SubagentStop") {
      await postDaemon({ kind: "notify", icon: "🏁", text: "A subagent finished" });
      process.exit(0);
    }

    if (event === "Stop") {
      // Ask the phone "what next?". If it answers with an instruction, hold the
      // turn open (decision: "block") — Claude Code treats the reason as the
      // user's next marching orders. No phone / no answer / "let it stop" →
      // exit silently and the agent stops normally.
      const result = await postDaemon({
        kind: "stop",
        sessionId: ev.session_id || "",
        cwd: ev.cwd || "",
        stopActive: !!ev.stop_hook_active,
      });
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
      const result = await postDaemon({
        kind: "permission",
        tool: ev.tool_name || "permission",
        summary, detail,
        sessionId: ev.session_id || "",
        cwd: ev.cwd || "",
      });

      const choice = result && result.choice;
      const note = (result && result.note) || "";
      if (choice === "approve" || choice === "deny") {
        // Current Claude Code PreToolUse decision format. On a deny, the reason
        // is shown to Claude as feedback — so a typed note becomes a steering
        // message ("don't run that, do X instead") the agent acts on.
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

    // Unknown event: do nothing, don't interfere.
    process.exit(0);
  } catch {
    // Daemon down / network error → let Claude Code handle it normally.
    process.exit(0);
  }
}

main();

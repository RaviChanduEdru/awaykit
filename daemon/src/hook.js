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

import { describe } from "./describe.js";
import { readStdinJSON, requestPermission, requestStop, notify } from "./agent-core.js";

async function main() {
  const ev = await readStdinJSON();
  if (!ev) process.exit(0);
  const event = ev.hook_event_name || "";

  try {
    if (event === "Notification") {
      await notify({ icon: "🔔", text: ev.message || "Claude Code needs your attention" });
      process.exit(0);
    }

    if (event === "SubagentStop") {
      await notify({ icon: "🏁", text: "A subagent finished" });
      process.exit(0);
    }

    if (event === "Stop") {
      // Ask the phone "what next?". If it answers with an instruction, hold the
      // turn open (decision: "block") — Claude Code treats the reason as the
      // user's next marching orders. No phone / no answer / "let it stop" →
      // exit silently and the agent stops normally.
      const result = await requestStop({ sessionId: ev.session_id, cwd: ev.cwd, stopActive: !!ev.stop_hook_active });
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

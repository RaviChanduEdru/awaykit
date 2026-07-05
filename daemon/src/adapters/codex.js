#!/usr/bin/env node
/**
 * awaykit adapter — OpenAI Codex CLI.
 *
 * Codex's hooks mirror Claude Code's: a command hook receives a JSON event on
 * stdin and returns a permission decision on stdout under `hookSpecificOutput`.
 * So this adapter is a near-twin of the Claude Code one — awaykit's daemon
 * doesn't care which agent is asking.
 *
 * Install (~/.codex/hooks.json or [[hooks.PreToolUse]] in config.toml):
 *   { "hooks": { "PreToolUse": [{ "command": "node /path/to/awaykit/daemon/src/adapters/codex.js" }] } }
 * See adapters/README.md. Fail-safe: daemon down → exit 0, no output → Codex
 * uses its normal approval flow.
 */
import { describe } from "../describe.js";
import { readStdinJSON, requestPermission, notify } from "../agent-core.js";

async function main() {
  const ev = await readStdinJSON();
  if (!ev) process.exit(0);
  const event = ev.hook_event_name || "";
  try {
    if (event === "Notification") { await notify({ icon: "🔔", text: ev.message || "Codex needs your attention" }); process.exit(0); }
    if (event === "Stop") { await notify({ icon: "🏁", text: "Codex finished a turn" }); process.exit(0); }

    if (event === "PreToolUse" || event === "PermissionRequest") {
      const { summary, detail } = describe(ev.tool_name, ev.tool_input);
      const r = await requestPermission({ tool: ev.tool_name, summary, detail, sessionId: ev.session_id, cwd: ev.cwd });
      const choice = r && r.choice, note = (r && r.note) || "";
      if (choice === "approve" || choice === "deny") {
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
      process.exit(0);
    }
    process.exit(0);
  } catch { process.exit(0); }
}
main();

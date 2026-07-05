#!/usr/bin/env node
/**
 * awaykit adapter — Cursor CLI (cursor-agent).
 *
 * Cursor hooks (Cursor 1.7+): a command in .cursor/hooks.json (or
 * ~/.cursor/hooks.json) gets a JSON event on stdin and returns
 * { "permission": "allow" | "deny" | "ask" } on stdout. We gate
 * `beforeShellExecution` (and MCP calls) through your phone and buzz it on
 * `stop`. See adapters/README.md.
 *
 * Install:
 *   { "version": 1, "hooks": { "beforeShellExecution":
 *     [{ "command": "node /path/to/awaykit/daemon/src/adapters/cursor.js" }] } }
 *
 * Fail-safe: no decision / daemon down → no output → Cursor prompts you normally.
 */
import { readStdinJSON, requestPermission, notify } from "../agent-core.js";

async function main() {
  const ev = await readStdinJSON();
  if (!ev) process.exit(0);
  const event = ev.hook_event_name || "";
  try {
    if (event === "stop") { await notify({ icon: "🏁", text: "Cursor finished a turn" }); process.exit(0); }

    if (event === "beforeShellExecution" || event === "beforeMCPExecution") {
      const cmd = ev.command || (ev.tool_input && ev.tool_input.command) || "";
      const summary = cmd ? "Run: " + cmd : (event === "beforeMCPExecution" ? "MCP tool call" : "Shell command");
      const r = await requestPermission({ tool: "command", summary, detail: cmd, sessionId: ev.conversation_id, cwd: ev.cwd });
      const choice = r && r.choice, note = (r && r.note) || "";
      if (choice === "approve") {
        process.stdout.write(JSON.stringify({ permission: "allow" }));
      } else if (choice === "deny") {
        process.stdout.write(JSON.stringify({
          permission: "deny",
          agent_message: "Denied from phone via awaykit" + (note ? ` — the user says: ${note}` : ""),
          user_message: "Denied from your phone",
        }));
      }
      // no decision → emit nothing → Cursor falls back to its own prompt
      process.exit(0);
    }
    process.exit(0);
  } catch { process.exit(0); }
}
main();

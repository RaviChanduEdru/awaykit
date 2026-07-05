#!/usr/bin/env node
/**
 * awaykit adapter — Gemini CLI.
 *
 * Gemini hooks: a command under the "hooks" key in ~/.gemini/settings.json
 * (BeforeTool) gets a JSON event on stdin and returns
 * { "decision": "allow" | "deny", "reason": "..." } on stdout. We gate
 * `BeforeTool` through your phone and buzz it on `Notification`. See README.
 *
 * Install (~/.gemini/settings.json):
 *   { "hooks": { "BeforeTool": [{ "hooks":
 *     [{ "type": "command", "command": "node /path/to/awaykit/daemon/src/adapters/gemini.js" }] }] } }
 *
 * Fail-safe: no decision / daemon down → no output → Gemini prompts you normally.
 */
import { describe } from "../describe.js";
import { readStdinJSON, requestPermission, notify } from "../agent-core.js";

async function main() {
  const ev = await readStdinJSON();
  if (!ev) process.exit(0);
  const event = ev.hook_event_name || "";
  try {
    if (event === "Notification") { await notify({ icon: "🔔", text: ev.message || "Gemini needs your attention" }); process.exit(0); }

    if (event === "BeforeTool") {
      const cmd = ev.tool_input && ev.tool_input.command;
      const d = cmd ? { summary: "Run: " + cmd, detail: cmd } : describe(ev.tool_name, ev.tool_input);
      const r = await requestPermission({ tool: ev.tool_name || "tool", summary: d.summary, detail: d.detail, sessionId: ev.session_id, cwd: ev.cwd });
      const choice = r && r.choice, note = (r && r.note) || "";
      if (choice === "approve") {
        process.stdout.write(JSON.stringify({ decision: "allow" }));
      } else if (choice === "deny") {
        process.stdout.write(JSON.stringify({
          decision: "deny",
          reason: "Denied from phone via awaykit" + (note ? ` — the user says: ${note}` : ""),
        }));
      }
      process.exit(0);
    }
    process.exit(0);
  } catch { process.exit(0); }
}
main();

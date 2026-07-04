#!/usr/bin/env node
/**
 * awaykit hook shim for Claude Code.
 *
 * Wire this as a PreToolUse / Notification / Stop hook (see docs/QUICKSTART.md).
 * It reads the hook event on stdin, forwards it to the local awaykit daemon,
 * and — for a permission request — waits for your phone's decision, then prints
 * the matching permission decision back to Claude Code on stdout.
 *
 * Fail-safe: if the daemon is unreachable, this exits 0 with no decision, so
 * Claude Code just falls back to its normal on-laptop permission prompt. Your
 * agent is never broken by awaykit being down.
 */

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

/** Turn a tool call into a short, human summary + detail for the phone card. */
function describe(toolName, input) {
  input = input || {};
  switch (toolName) {
    case "Bash":
      return { summary: input.command ? `Run: ${input.command}` : "Run a shell command", detail: input.command || "" };
    case "Write":
      return { summary: `Write ${input.file_path || "a file"}`, detail: input.file_path || "" };
    case "Edit":
    case "MultiEdit":
      return { summary: `Edit ${input.file_path || "a file"}`, detail: input.file_path || "" };
    case "Read":
      return { summary: `Read ${input.file_path || "a file"}`, detail: input.file_path || "" };
    case "WebFetch":
      return { summary: `Fetch ${input.url || "a URL"}`, detail: input.url || "" };
    default: {
      let detail = "";
      try { detail = JSON.stringify(input, null, 2); } catch {}
      if (detail.length > 2000) detail = detail.slice(0, 2000) + "\n…(truncated)";
      return { summary: `${toolName}`, detail };
    }
  }
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

    if (event === "Stop" || event === "SubagentStop") {
      await postDaemon({ kind: "stop", text: "Agent finished a turn" });
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
      if (choice === "approve" || choice === "deny") {
        // Current Claude Code PreToolUse decision format.
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: choice === "approve" ? "allow" : "deny",
            permissionDecisionReason: `${choice === "approve" ? "Approved" : "Denied"} from phone via awaykit`,
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

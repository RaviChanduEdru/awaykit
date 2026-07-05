/**
 * awaykit plugin — OpenCode.
 *
 * OpenCode integrates via a JS/TS plugin (not a stdin/stdout command hook). This
 * one gates every tool execution through your phone: `tool.execute.before` asks
 * the awaykit daemon and THROWS to deny (OpenCode surfaces the message to the
 * model), and `session.idle` buzzes your phone.
 *
 * Install: copy this file into your project's `.opencode/plugin/` (or the global
 * OpenCode plugin dir), or add its path to the `plugin` array in opencode.json.
 * It's self-contained — no awaykit install needed in your OpenCode project; it
 * just talks to the local daemon over loopback. Fail-safe: daemon down → the
 * tool is allowed (awaykit never breaks your agent by being offline).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";

function endpoint() {
  try {
    const ep = JSON.parse(readFileSync(join(process.env.AWAYKIT_HOME || join(homedir(), ".awaykit"), "endpoint.json"), "utf8"));
    return { base: String(ep.url).replace(/\/+$/, ""), tls: !!ep.tls };
  } catch { return { base: "http://127.0.0.1:4517", tls: false }; }
}

function ask(payload) {
  const { base, tls } = endpoint();
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const mod = tls ? https : http;
    const opts = { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } };
    if (tls) opts.rejectUnauthorized = false; // self-signed cert on loopback — same machine
    const req = mod.request(base + "/hook", opts, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

export const awaykit = async ({ directory } = {}) => ({
  "tool.execute.before": async (input, output) => {
    const tool = (input && input.tool) || "tool";
    const cmd = output && output.args && output.args.command;
    const summary = cmd ? "Run: " + cmd : `${tool} tool call`;
    let detail = cmd || "";
    if (!detail) { try { detail = JSON.stringify((output && output.args) || {}, null, 2).slice(0, 2000); } catch { /* ignore */ } }
    let r;
    try { r = await ask({ kind: "permission", tool, summary, detail, cwd: directory || "" }); }
    catch { return; } // daemon unreachable → let OpenCode proceed normally
    if (r && r.choice === "deny") {
      throw new Error("Denied from phone via awaykit" + (r.note ? ` — ${r.note}` : ""));
    }
    // approve / no-decision → allow the tool to run
  },
  event: async ({ event } = {}) => {
    if (event && event.type === "session.idle") {
      try { await ask({ kind: "notify", icon: "🏁", text: "OpenCode is idle — your turn" }); } catch { /* best effort */ }
    }
  },
});

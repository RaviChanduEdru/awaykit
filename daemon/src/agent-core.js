/**
 * awaykit agent-core — the shared adapter runtime.
 *
 * awaykit's daemon speaks a neutral protocol (permission / stop / notify → a
 * phone decision), so supporting a new coding agent is just a small *adapter*
 * that (1) reads that agent's event, (2) calls the daemon here, and (3) renders
 * the phone's decision back into whatever the agent expects. This module is the
 * neutral middle — adapters stay tiny and share one, tested daemon client.
 *
 * Fail-safe by construction: the daemon calls reject if the daemon is down;
 * adapters catch that and let their agent proceed normally, so awaykit being
 * offline never breaks the agent.
 */

import { daemonEndpoint, daemonRequest } from "./endpoint.js";

const { base: DAEMON, tls: DAEMON_TLS } = daemonEndpoint();

/** Read all of stdin as text (resolves after 500ms if nothing is piped). */
export function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 500).unref?.();
  });
}

/** Read stdin and parse it as JSON, or null if empty/invalid. */
export async function readStdinJSON() {
  try { return JSON.parse((await readStdin()) || "{}"); } catch { return null; }
}

/** POST a neutral event to the daemon's /hook; returns the parsed reply ({} on empty). */
export async function callDaemon(payload) {
  const res = await daemonRequest(DAEMON, "/hook", { method: "POST", body: payload, tls: DAEMON_TLS });
  return JSON.parse(res.body || "{}");
}

/** Ask the phone to approve/deny a tool or command. Returns { choice, note }. */
export function requestPermission({ tool, summary, detail = "", sessionId = "", cwd = "" }) {
  return callDaemon({ kind: "permission", tool: tool || "permission", summary, detail, sessionId, cwd });
}

/** Ask the phone "what next?" at the end of a turn. Returns { choice, note }.
 *  `lastResponse` (the agent's final message) is shown on the phone so the
 *  answer is informed — you read what it said, then say what's next. */
export function requestStop({ sessionId = "", cwd = "", stopActive = false, lastResponse = "" }) {
  return callDaemon({ kind: "stop", sessionId, cwd, stopActive, lastResponse });
}

/** Fire a one-off note into the phone's Activity feed (no decision expected). */
export function notify({ icon = "🔔", text = "agent event" }) {
  return callDaemon({ kind: "notify", icon, text });
}

/** Report what a tool actually DID (a PostToolUse result line): "▶ npm test →
 *  5 passing". Lands as a permanent action line on the phone. Fire-and-forget. */
export function activity({ icon = "🔧", text = "", sessionId = "" }) {
  return callDaemon({ kind: "activity", icon, text, sessionId });
}

/**
 * A fake coding agent that speaks Claude Code's headless stream-json protocol,
 * for hermetic chat tests (no real model, no API cost, no network).
 *
 * sessions.js spawns this instead of `claude` when AWAYKIT_AGENT_CMD points here.
 * It mimics exactly the event shapes the Phase-0 spike observed:
 *   - on start: system/init with a session_id
 *   - per user turn (one JSON line on stdin): stream a few text_delta events,
 *     then a `result`. If the user text contains "run", it first emits an
 *     `assistant` message with a tool_use block (so the manager surfaces a chip).
 *   - on {type:"control_request",request:{subtype:"interrupt"}}: reply with a
 *     control_response and a result(error_during_execution).
 */
const SID = "fake-" + Math.random().toString(36).slice(2, 10);
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

emit({ type: "system", subtype: "init", session_id: SID, cwd: process.cwd(), tools: [] });

let busy = false;
async function runTurn(text) {
  busy = true;
  if (/\brun\b/i.test(text)) {
    emit({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }] } });
    await sleep(20);
  }
  const reply = `echo: ${text}`;
  for (const chunk of reply.match(/.{1,6}/g) || [reply]) {
    if (!busy) return; // interrupted mid-stream
    emit({ type: "stream_event", event: { delta: { type: "text_delta", text: chunk } } });
    await sleep(15);
  }
  emit({ type: "result", subtype: "success", is_error: false, total_cost_usd: 0.0001, duration_ms: 120, num_turns: 1, session_id: SID });
  busy = false;
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === "control_request" && msg.request && msg.request.subtype === "interrupt") {
      busy = false;
      emit({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
      emit({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 5, num_turns: 1, session_id: SID });
      continue;
    }
    if (msg.type === "user") {
      const parts = (msg.message && msg.message.content) || [];
      const text = parts.map((p) => p.text || "").join("");
      runTurn(text);
    }
  }
});
process.stdin.on("end", () => process.exit(0));

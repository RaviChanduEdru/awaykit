# Live chat — design & plan (v0.9 milestone)

**Goal:** turn awaykit from a *gate* into a *cockpit*. Today the phone reacts —
approve/deny cards, a 45-second "what next?" window. After this milestone the
phone **drives**: start a session, chat with the agent in real time, watch its
replies stream in, approve its tool calls inline, interrupt it, kill it — from
anywhere, over the same E2E-encrypted channel.

This is the last big item on the original vision list ("send follow-up prompts
to steer the agent") and the foundation for v1.0.

---

## 1. What "live chat" means, concretely

From the phone, per session:

| You can | Today (v0.8) | After v0.9 |
|---|---|---|
| Approve / deny a tool call | ✅ card | ✅ same card, now inline in the chat |
| Steer with text | only via Deny-note / 45s stop-window | ✅ type anything, anytime |
| See the agent's replies | ❌ (only tool summaries) | ✅ streamed, token by token |
| Start a new session | ❌ | ✅ in an allow-listed project dir |
| Send the next prompt when a turn ends | 45s window, then gone | ✅ composer is always there |
| Interrupt a running turn | ❌ | ✅ |
| Kill a session | ❌ | ✅ |

**Non-goals (for v0.9):** a raw terminal on the phone (explicitly *against* the
product pitch — "no tiny terminal"; a PTY *attach* mode is a separate opt-in,
§7); answering Claude's native multiple-choice menus (AskUserQuestion doesn't
work headlessly — the model falls back to asking in prose, which chat handles
naturally); multi-user; session branching.

---

## 2. The architecture decision: structured driver, not PTY

Two ways to get a live conversation with a CLI agent:

**A. PTY wrap** — spawn the agent's interactive TUI inside a pseudo-terminal,
mirror the screen to the phone, inject keystrokes.
Universal, full fidelity — but: `node-pty` is a native dependency (we have 4
deps, all pure-JS — this matters to the security story), the phone needs a
~300 KB terminal emulator (xterm.js), ANSI screen-scraping is fragile across
agent versions, and a raw terminal from the phone is a *massive* trust-surface
jump the README explicitly promises is "opt-in, off by default".

**B. Structured driver** — run the agent in its **headless streaming mode** as
a child process of the daemon and speak JSON with it. For Claude Code:

```
claude -p --output-format stream-json --include-partial-messages \
       --input-format stream-json --permission-mode default
```

- stdout: newline-delimited JSON events — `system/init` (carries the
  `session_id`), `assistant` messages, `stream_event` deltas
  (`event.delta.type === "text_delta"`) for token-level streaming, tool-use
  blocks, `result` at turn end.
- stdin: user turns as stream-json (shape verified in Phase 0, §5).
- **Hooks still fire in `-p` mode** (verified against current docs) — so the
  *existing* PreToolUse → phone-card machinery keeps gating every tool call,
  unchanged. Chat and approvals compose instead of colliding.

**Decision: B is the core.** It keeps the phone UI purpose-built (bubbles and
cards, not a terminal), adds zero native dependencies, and reuses everything
we've built. A is deferred to an explicitly-opt-in "attach" mode later (§7).

### The fallback that de-risks everything

The one under-documented piece of B is *persistent* stdin multi-turn (keep one
process alive, feed it turn after turn). If Phase 0 finds it unreliable, the
driver degrades to **one process per turn, chained with `--resume
<session_id>`** — fully documented, same session context, same UX; the only
cost is ~1–2 s of process start per turn. The session manager API (§4) is
identical either way, so this is an internal implementation detail, not an
architectural fork.

Interrupt has the same shape: stream-json control message if the spike confirms
one; otherwise kill the child (session state persists in Claude's own session
files) and the next message resumes it. Brutal, but correct — and invisible at
the API boundary.

---

## 3. How it fits the current daemon

Nothing about the trust model changes: every new message type rides the same
sealed channel (NaCl secretbox under the per-connection ephemeral key), local
SSE and relay clients stay interchangeable (`client.sendSealed()`), and every
chat action is audited.

```
                 ┌────────────────────────── daemon ──────────────────────────┐
 phone ◀─sealed──┤ broadcast()                                                │
   │             │    ▲                                                       │
   │ sealed ops  │    │ chat.delta / chat.msg / session.state                 │
   ▼             │ ┌──┴───────────┐   spawn/stdin/stdout   ┌────────────────┐ │
 POST /chat ─────┼▶│ sessions.js  │◀──────────────────────▶│ claude -p       │ │
 (or relay msg)  │ │ session mgr  │                        │ stream-json     │ │
                 │ └──────────────┘                        └───────┬────────┘ │
                 │        ▲                                        │ PreToolUse│
                 │        │ approval cards (existing /hook path)   │ hook.js   │
                 │        └────────────────────────────────────────┘          │
                 └─────────────────────────────────────────────────────────────┘
```

New module: **`daemon/src/sessions.js`** — the session manager. Owns child
processes, parses their NDJSON, keeps a bounded transcript ring per session
(~200 messages, memory only), and emits neutral events the daemon broadcasts.
No HTTP in it; like `relay-client.js`, state flows in via callbacks, so it's
independently testable.

`hook.js` gets one addition: daemon-spawned children run with
`AWAYKIT_MANAGED=1` in their env; the hook then **skips the turn-end
("what next?") card** for those sessions — in a live chat, the composer *is*
the "what next?", and the turn-end is just the reply finishing. Permission
events still flow (now tagged with the session id, so the phone renders the
card inside the right conversation).

### Protocol additions (all sealed)

Phone → daemon — new authed endpoint `POST /chat` (cookie session, sealed body),
and the same ops accepted from relay phones via the existing `onPhoneMessage`
extension point:

```jsonc
{ "t": "chat", "op": "start",     "projectDir": "<from the allow-list>" }
{ "t": "chat", "op": "send",      "sid": "…", "text": "now add tests" }
{ "t": "chat", "op": "interrupt", "sid": "…" }
{ "t": "chat", "op": "kill",      "sid": "…" }
```

Daemon → phone (broadcast; snapshot gains `sessions: [...]` + recent
transcript so a reconnecting phone catches up):

```jsonc
{ "type": "session.state", "sid": "…", "state": "running|idle|dead", "cwd": "…", "label": "…" }
{ "type": "chat.msg",   "sid": "…", "role": "user|assistant|system", "text": "…", "ts": 0 }
{ "type": "chat.delta", "sid": "…", "text": "…" }              // token streaming
{ "type": "prompt", …, "sessionId": "…" }                      // existing cards, session-tagged
```

### Phone UI

The client stays one vanilla file. The header grows a **Sessions** row (chips:
one per live session + "＋ New"); tapping one switches the main view to that
conversation: assistant bubbles (deltas append live), your messages, tool-use
chips, and the *existing approval/turn cards inline in the timeline*. A sticky
composer at the bottom sends (`op:"send"`), long-press for interrupt/kill. The
current "pending + activity" view remains as the home screen — chat is
additive, not a rewrite.

---

## 4. Security (this is the feature where it matters most)

Honest statement of what changes: **a paired phone can already make the agent
run anything** — it approves Bash. Chat doesn't grant a new *capability*; it
removes friction from an existing one. Still, three new hardenings ship with
it:

1. **Off by default.** Chat requires `AWAYKIT_CHAT=1` on the daemon. Without
   it, `/chat` returns 403 and no session manager exists.
2. **Project allow-list.** Sessions can only start in directories listed in
   `AWAYKIT_PROJECTS` (path-separator-delimited). The phone picks from the
   list; arbitrary paths are rejected server-side. No allow-list → chat stays
   off even with `AWAYKIT_CHAT=1`.
3. **Everything audited.** Every `start/send/interrupt/kill` (with text) goes
   to the append-only audit log, same as decisions today.

Also: chat ops are rate-limited (a stolen-cookie attacker shouldn't be able to
drive sessions at machine speed), transcripts live in memory only (the repo's
files and Claude's own session files are the durable record), and
`--dangerously-skip-permissions` is never used — spawned sessions run
`--permission-mode default` so every tool call still crosses the phone.
SECURITY.md gets a new section spelling all this out.

---

## 5. Phases

### Phase 0 — protocol spike ✅ DONE
`test/spike-stream.mjs` (committed) spawned the real `claude -p` and settled the
open questions empirically. **Findings (run 2026-07-05, model haiku):**

1. **Persistent multi-turn over stdin WORKS.** One long-lived process; each turn
   is one line on stdin:
   `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}`.
   A second and third turn completed in the same process. → **We keep one
   process per session.** Resume-per-turn stays as the crash-recovery path only.
2. **Interrupt WORKS.** `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}`
   on stdin → a `control_response {subtype:"success"}`, and the turn ends with
   `result {subtype:"error_during_execution"}`. No process kill needed.
3. **Event catalogue** (stdout, newline-delimited JSON): `system/init` (carries
   `session_id`), `system/status`, `system/thinking_tokens`, `stream_event`
   (with `event.delta.type` ∈ {`text_delta`, `thinking_delta`, `signature_delta`}),
   `assistant` (full message, may contain `tool_use` blocks), `result`
   (`subtype`, `total_cost_usd`, `duration_ms`, `num_turns`), `rate_limit_event`,
   `control_response`. Token-level `text_delta` streaming confirmed.
4. **Hooks in headless mode:** the spike ran in a bare scratch dir with no hook
   config, so none fired — as expected. **Better design than first assumed:**
   managed sessions **inject their own hook config** via `--settings '<json>'`
   (the flag takes an inline JSON string), wiring `PreToolUse`/`Notification` to
   `hook.js` with `AWAYKIT_MANAGED=1` + `AWAYKIT_URL` in the child env. Result:
   **chat-mode approval cards work with zero user setup** — you don't need hooks
   wired globally for chat sessions to be gated. `AWAYKIT_MANAGED=1` also tells
   `hook.js` to drop the turn-end card (the composer replaces it).
5. **`--resume <session_id>` in a fresh process keeps full context** (recalled a
   word from the first message). This is the reattach-after-restart path.

**Gate: PASSED, best case** — persistent stdin + real interrupt both work.

### Phase 1 — the loop, minimal but real (v0.9.0)
- `sessions.js`: start (allow-listed dir) / send / kill; NDJSON parsing;
  transcript ring; `AWAYKIT_MANAGED=1` env for children.
- Daemon: `/chat` endpoint + relay op routing + broadcast types + snapshot
  sessions; `AWAYKIT_CHAT` / `AWAYKIT_PROJECTS` gating; audit entries.
- `hook.js`: skip stop-cards for managed sessions; tag cards with session id.
- Phone: sessions row, conversation view, composer, inline cards.
- Tests: a **fake `claude`** (`test/fake-agent.mjs` — scripted stream-json on
  stdout, echoes stdin turns, requests a tool mid-turn) so e2e drives the whole
  loop hermetically in CI: start → send → deltas → inline approval → result →
  kill. Zero real-API cost.
- Docs: QUICKSTART section, SECURITY section, README status/roadmap.

**Acceptance:** from the phone — start a session in an allow-listed repo, send
"create FEATURE.md with three ideas", watch the reply stream, approve the Write
card inline, send a follow-up, kill the session. All while the laptop lid
never opens.

### Phase 2 — polish that makes it daily-drivable (v0.9.x / v0.10)
- ✅ Interrupt (control_request — shipped in v0.9).
- ✅ **Mission control (v0.10):** turn-end cards carry the agent's **final
  response** (Stop hook reads the transcript tail); **PostToolUse** result lines
  ("▶ npm test → 5 passing") land as permanent `agent.act` entries in the feed
  and chat; a model·project·state header tops every conversation.
- ✅ **↩ Continue / adopt (v0.10):** a turn that finishes in an EXTERNAL session
  (e.g. VS Code) in an allow-listed dir is recorded (`recentTurns`, last 5) and
  offered in the phone's ＋New picker — adopting spawns `--resume <id>`, so the
  phone picks up the laptop conversation with full context. Caveat: resuming
  **forks** — phone turns don't flow back into the still-open laptop pane.
- Remaining: per-session unread badges; push on "reply finished" for chat
  sessions; quick-replies; resend-on-reconnect.

### Phase 3 — beyond Claude (v1.0 track)
- Second structured driver to prove the abstraction. **OpenCode first** (it has
  a real server API), then Codex (`proto` mode). Drivers slot into
  `sessions.js` the way adapters slot into `agent-core.js`.
- Optional **PTY attach** for everything else: `node-pty` as an *optional*
  dependency, xterm.js vendored, triple-gated (env flag + per-session phone
  confirm + prominent SECURITY.md warning). This is the "full terminal is an
  explicit opt-in" promise from the README, kept precisely.

---

## 6. Risks & open questions

| Risk | Mitigation |
|---|---|
| Persistent stdin multi-turn is flaky/undocumented | Resume-per-turn fallback is fully documented and UX-equivalent (§2) |
| stream-json event shapes drift across Claude Code versions | Parser is defensive (unknown events → ignored); fake-agent tests pin *our* contract, spike script re-runs in minutes to re-verify theirs |
| AskUserQuestion menus can't be answered headlessly | Accepted non-goal; headless Claude asks in prose instead, which chat handles. Revisit if a programmatic answer path ships |
| Phone-driven sessions = scarier story | Off by default, allow-listed dirs, full audit, permission cards still gate every tool (§4) |
| Two phones chatting in one session | Broadcast keeps them in sync by construction; last-writer-wins is acceptable for v0.9 |
| Long transcripts vs. tiny client | Ring buffer (~200 msgs) + snapshot truncation; full history stays in Claude's own session files |

## 7. Explicitly deferred

- PTY attach mode (Phase 3, opt-in) — see §2/§5.
- Native mobile app — the PWA carries chat fine; revisit post-v1.0.
- Browsing/resuming *historic* sessions from the phone (undocumented session
  listing; only daemon-started sessions are tracked in v0.9).
- Voice input, image attachments — composer is text-only for now.

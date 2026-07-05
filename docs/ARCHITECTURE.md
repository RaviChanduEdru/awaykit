# awaykit architecture

How awaykit is *actually* built as of **v0.10**. (Earlier drafts of this file
described an aspirational TypeScript/React-Native/WebRTC design; the shipped
system is simpler and is what's documented here.)

**One line:** a zero-framework Node.js daemon on your laptop holds an
end-to-end-encrypted channel to a phone web client, gates your coding agent's
tool calls through it, and — opt-in — lets the phone start and drive whole agent
sessions. Four runtime dependencies (`tweetnacl`, `qrcode`, `web-push`,
`selfsigned`); everything else is the Node standard library.

## Components

### 1. Daemon (`daemon/`) — Node.js (ESM), no web framework

Runs on the laptop; a bare `node:http`/`https` server. Modules:

| File | Responsibility |
|---|---|
| `src/daemon.js` | HTTP(S) server + all routes; owns the pending-prompt map, the connected-client set, and session cookies; wires the pieces together. |
| `src/crypto.js` | NaCl secretbox seal/open, the pairing proof, and the ephemeral X25519 key agreement (per-session forward secrecy). Also `roomIdFromKey` for the relay. |
| `src/sessions.js` | **Live-chat engine** — spawns coding-agent processes, speaks their headless `stream-json` protocol, keeps a bounded transcript ring, emits neutral events. No HTTP/crypto (callbacks in, events out) → independently testable. |
| `src/agent-core.js` | Shared adapter runtime: read a hook event, call the daemon, return the phone's decision. Used by all agent adapters. |
| `src/hook.js` | The Claude Code adapter (also `src/adapters/*` for Codex/Cursor/Gemini/OpenCode). Maps hook events ⇄ awaykit and prints the agent's expected decision. |
| `src/describe.js` | Turns a tool call into a human summary + detail (the Bash command, a Write's contents, an Edit's ± diff). |
| `src/relay-client.js` | Outbound link to a zero-knowledge relay so remote phones reach the daemon with no inbound ports. |
| `src/push.js` | VAPID keys + Web Push (RFC 8291) so the phone is woken with the app closed. |
| `src/tls.js` | Optional self-signed HTTPS on the LAN (`AWAYKIT_TLS`). |
| `src/endpoint.js` | Advertises the daemon's loopback URL/scheme so `hook.js`/`ctl.js` reach it. |
| `src/ctl.js` | Lifecycle CLI: `start` / `stop` / `restart` / `status` over loopback. |
| `src/audit.js` | Append-only local log of every decision and chat action. |

### 2. Phone client (`daemon/public/`) — vanilla HTML/JS PWA

One framework-free `index.html` (+ `sw.js`, manifest, icons). Does the NaCl
crypto in-browser, consumes the sealed SSE stream, and renders two coexisting
modes the user switches between:

- **🛡️ Approvals (Gate mode)** — approval cards (Approve / Deny+note), the
  turn-end "what next?" card (now carrying the agent's final response), and the
  Activity feed of what tools did.
- **💬 Chat mode** — sessions row, streaming conversation, composer, inline
  approval cards, and the ↩ Continue picker.

The native `app/` is still a placeholder; the PWA carries everything today.

### 3. Relay (`relay/`) — optional, self-hostable, zero-knowledge

A tiny dependency-free Node server. Rooms are keyed by `hash(K)`; it forwards
sealed blobs it cannot read (queue + TTL for offline phones) and serves the app
shell. See [relay/README.md](../relay/README.md).

## Two ways the phone interacts (they coexist)

### Gate mode — intercept an agent you started yourself
```
Claude Code (your VS Code session)          awaykit daemon                 phone
──────────────────────────────────          ──────────────                 ─────
PreToolUse hook ──POST /hook (loopback)──▶  hold request open
  (hook.js)                                 broadcast ──sealed SSE──▶  approval card
                                                                       tap Approve/Deny(+note)
                ◀── allow/deny decision ──  resolve  ◀──POST /respond (sealed)──┘
PostToolUse ────POST /hook──▶ "▶ Run: … → output"  ──▶ Activity feed (agent.act)
Stop ───────────POST /hook──▶ final response + "what next?" card ──▶ (agent.msg)
```

### Chat mode — the phone starts & drives the session (opt-in)
```
phone ──sealed {t:"chat", op:"start|send|interrupt|kill"}──▶ /chat (or relay)
                                                              │
                                    sessions.js spawns:  claude -p --input-format
                                    stream-json --output-format stream-json …
                                    (with --settings injecting awaykit's own hooks,
                                     AWAYKIT_MANAGED=1 in the child env)
     ◀── chat.delta (token stream) / chat.tool / chat.turn / session.state ──┘
     inline approval cards still gate every tool call via the same hook path
```
`--resume <id>` powers **↩ Continue**: adopt a conversation that finished
elsewhere (e.g. your VS Code session) with its full context. Off unless
`AWAYKIT_CHAT=1` **and** an `AWAYKIT_PROJECTS` allow-list; sessions run
`--permission-mode default` (never skip permissions).

## Security model (summary)

- **Pairing:** one key `K`, created on first run, delivered to the phone only via
  the QR's URL *fragment* (never sent to a server).
- **Channel:** every phone⇄daemon message is NaCl-secretbox sealed. `K` only
  *authenticates* the handshake; traffic uses a per-session ephemeral X25519 key
  → **forward secrecy** (leaking `K` can't decrypt past sessions).
- **Auth:** `/events`, `/respond`, `/chat`, `/push-sub` require a session cookie
  issued only after the phone proves it holds `K`. `/hook`, `/health`,
  `/shutdown`, `/audit` are loopback-only.
- **Integrity:** plain-HTTP LAN doesn't stop an active on-path attacker; a VPN,
  the relay (HTTPS), or `AWAYKIT_TLS` closes that gap.
- **Everything is audited** to an append-only local log.

Full threat model + the live-chat specifics: [SECURITY.md](SECURITY.md).

## Wire protocol (representative)

All frames are sealed; these are the plaintext shapes.

```jsonc
// daemon → phone (sealed SSE `event: m`)
{ "type": "snapshot", "pending": [...], "chat": true, "projects": [...],
  "sessions": [...], "recentTurns": [...], "vapid": "..." }
{ "type": "prompt", "promptId": "...", "kind": "permission|stop",
  "tool": "Bash", "summary": "Run: npm test", "detail": "...", "sessionId": "..." }
{ "type": "resolved",     "promptId": "...", "choice": "approve|deny|continue|stop|expired" }
{ "type": "chat.delta",   "sid": "...", "text": "…" }         // token stream
{ "type": "chat.turn",    "sid": "...", "costUsd": 0, "ms": 0 }
{ "type": "session.state","sid": "...", "state": "running|idle|dead",
  "model": "sonnet", "cwd": "...", "agentSid": "..." }
{ "type": "agent.msg",    "sessionId": "...", "text": "final response…" }
{ "type": "agent.act",    "sessionId": "...", "icon": "▶", "text": "Run: … → output" }

// phone → daemon (sealed)
{ "c": "<sealed { promptId, choice, note }>" }                    // POST /respond
{ "c": "<sealed { t:'chat', op:'start', projectDir, resumeId? }>" } // POST /chat
```

## Repo layout

```
awaykit/
├── daemon/
│   ├── src/            # daemon.js, sessions.js, agent-core.js, hook.js,
│   │   ├── adapters/   #   crypto.js, relay-client.js, push.js, tls.js, ctl.js …
│   │   └── …           # per-agent adapters (codex/cursor/gemini/opencode/ask)
│   ├── public/         # index.html (phone PWA) + sw.js, manifest, icons
│   └── test/           # e2e.mjs, chat.mjs, tls.mjs, adapters.mjs, fake-agent.mjs
├── relay/              # zero-knowledge ciphertext relay (server.js)
├── app/                # native app placeholder (PWA carries it today)
├── examples/           # ready-to-paste Claude Code hook config
├── docs/               # this file, SECURITY, QUICKSTART, LIVE-CHAT, REMOTE
└── .github/            # CI (runs the full test suite)
```

## Testing

`npm test` runs four hermetic suites (**123 checks**, no network, no API cost):
`e2e.mjs` (crypto, pairing, gate loop, steering, push, mission-control lines),
`chat.mjs` (live-chat loop + adopt, via a scripted `fake-agent.mjs` speaking
stream-json), `tls.mjs`, and `adapters.mjs`. The manual `spike-stream.mjs`
probes the real `claude` CLI and is **not** in CI (it spends real API calls).
```

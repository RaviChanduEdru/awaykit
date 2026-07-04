# awaykit architecture

## Components

### 1. Daemon (`daemon/`) — TypeScript / Node.js

Runs on the laptop. Responsibilities:

- **Agent adapters** — pluggable integrations per coding agent:
  - `claude-code`: uses Claude Code hooks (`PreToolUse`, `Notification`, `Stop`)
    to detect permission prompts and session state — structured, reliable.
  - `pty` (fallback): wraps any CLI agent in a pseudo-terminal and streams
    raw output; prompt detection via patterns.
- **Session manager** — tracks running sessions, buffers output, exposes
  the control protocol.
- **Crypto layer** — key storage, pairing, secretstream encryption.
- **Transport** — direct (VPN/LAN) WebSocket server + optional relay client.

### 2. Mobile app (`app/`) — React Native (Expo)

- Session list & live output stream (virtualized log view)
- **Approval cards**: agent prompt rendered as a structured card with
  Approve / Deny / Reply actions
- Push notifications (FCM/APNs) triggered by relay wake-ups — payload is
  ciphertext; decrypted on-device before display
- QR scanner for pairing

### 3. Relay (`relay/`) — optional, self-hostable

- WebRTC signaling + message queue for offline phones
- Push notification fan-out
- Zero knowledge: stores/forwards ciphertext blobs only

## Wire protocol (draft)

All messages are encrypted envelopes. Plaintext schema (JSON, versioned):

```jsonc
{ "v": 1, "type": "prompt.request",   // daemon → phone
  "sessionId": "s_abc", "promptId": "p_1",
  "kind": "tool_permission",
  "summary": "Run: npm install express",
  "detail": "...", "options": ["approve", "deny"] }

{ "v": 1, "type": "prompt.response",  // phone → daemon
  "sessionId": "s_abc", "promptId": "p_1",
  "choice": "approve" }

{ "v": 1, "type": "session.output",   // daemon → phone (streamed, chunked)
  "sessionId": "s_abc", "seq": 4821, "data": "..." }

{ "v": 1, "type": "session.kill",     // phone → daemon
  "sessionId": "s_abc" }
```

## Repo layout

```
awaykit/
├── daemon/            # laptop-side daemon (Node)
│   ├── src/
│   │   ├── daemon.js  # HTTP server: /hook, /events (SSE), /respond
│   │   └── hook.js    # Claude Code hook shim (PreToolUse/Notification/Stop)
│   └── public/
│       └── index.html # mobile web client (M0 stand-in for the app)
├── app/               # native mobile app (React Native / Expo) — later
├── relay/             # optional ciphertext relay — later
├── examples/          # ready-to-paste config (Claude Code hooks)
├── docs/              # architecture, security, quickstart
└── .github/           # CI
```

## Milestone 0 (✅ built)

The smallest thing that proves the idea end-to-end — implemented in
[`daemon/`](../daemon/) with **zero dependencies** (pure Node). See
[QUICKSTART.md](QUICKSTART.md) to run it.

```
Claude Code                 awaykit daemon (Node)              phone browser
───────────                 ─────────────────────              ─────────────
PreToolUse hook  ──POST /hook──▶  hold request open
(hook.js shim)                    broadcast ──SSE /events──▶  approval card
                                                              tap Approve/Deny
                 ◀── permission ── resolve  ◀──POST /respond──┘
                    decision (allow/deny)
```

What each piece does:

1. **`hook.js`** — a Claude Code `PreToolUse`/`Notification`/`Stop` hook shim. On a
   `PreToolUse` event it `POST`s a plain-English summary of the tool call to the
   daemon and blocks, then prints the phone's decision back as
   `hookSpecificOutput.permissionDecision` (`allow`/`deny`). Fail-safe: if the
   daemon is down it exits 0 with no output, so Claude Code just prompts normally.
2. **`daemon.js`** — HTTP server. `POST /hook` holds the agent blocked; `GET
   /events` is a Server-Sent-Events stream to the phone; `POST /respond` carries
   the tap back and unblocks the hook. Serves the web client at `/`.
3. **Web client** (`public/index.html`) — mobile page: live approval cards +
   activity feed. Stands in for the native app until later milestones.

**Design note — connection is the switch.** If no phone is subscribed to
`/events`, `POST /hook` returns "no decision" immediately, so Claude Code uses its
normal on-laptop permission flow. Opening the phone page is the signal *"I'm away,
route approvals to me."* The `PreToolUse` matcher is scoped to mutating/executing
tools (`Bash|Write|Edit|…`) so reads and greps are never intercepted.

**Not yet (next milestones):** no crypto, no auth, no pairing, no relay/push,
LAN only. The internal daemon↔phone protocol above is deliberately simple so the
transport can be swapped for the encrypted envelope schema without touching the
hook logic. Harden outward from here.

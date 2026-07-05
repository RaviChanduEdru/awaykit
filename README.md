# awaykit

[![CI](https://github.com/RaviChanduEdru/awaykit/actions/workflows/ci.yml/badge.svg)](https://github.com/RaviChanduEdru/awaykit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Encrypted](https://img.shields.io/badge/channel-E2E%20encrypted-8a2be2)

**Control your laptop's AI coding sessions from your phone — securely, self-hosted, end-to-end encrypted.**

You kicked off a long agentic coding session (Claude Code, Codex, Cursor CLI…) and stepped out.
The agent hits a permission prompt and sits there, blocked, until you get back.

awaykit fixes that. Your laptop keeps working while you're away:

- 📱 **See the live session stream** on your phone
- 🔔 **Get a push notification** the moment the agent needs input
- ✅ **Tap to approve/deny** permission prompts as structured cards — no tiny terminal
- 💬 **Send follow-up prompts** to steer the agent
- 🛑 **Kill a runaway session** with one tap

## Why not just SSH / remote desktop?

| | SSH + tmux | Remote desktop | **awaykit** |
|---|---|---|---|
| Mobile UX | ❌ tiny terminal | ❌ heavyweight | ✅ purpose-built cards |
| Push on agent prompts | ❌ | ❌ | ✅ |
| Attack surface | ⚠️ full shell | ⚠️ full machine | ✅ agent session only |
| Self-hosted / no vendor cloud | ✅ | depends | ✅ |
| E2E encrypted | ✅ | depends | ✅ |

## Security model (the whole point)

1. **Self-hosted.** No accounts, no vendor cloud holding your code.
2. **End-to-end encrypted.** Pairing via QR-code key exchange (like WhatsApp Web).
   If a relay is used for push notifications, it only ever sees ciphertext.
3. **Scoped by design.** The phone can interact with the *agent session* — not an
   arbitrary shell. Approve, deny, prompt, kill. That's it (full terminal is an
   explicit opt-in, off by default).

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model.

## Architecture

```
┌─────────────┐   E2E-encrypted channel   ┌──────────────┐
│  Phone app   │◄────────────────────────►│ Laptop daemon │
│  (app/)      │   (WireGuard/Tailscale   │  (daemon/)    │
│              │    or WebRTC + optional  │      │        │
│  approval    │    ciphertext-only       │      ▼        │
│  cards,      │    relay for push)       │  agent session│
│  live stream │                          │  (Claude Code,│
└─────────────┘        ┌────────┐         │  Codex, …)    │
                       │ relay/ │         └──────────────┘
                       │ (opt.) │
                       └────────┘
```

- **`daemon/`** — runs on your laptop; attaches to the agent session (hooks/PTY),
  exposes an encrypted control channel.
- **`app/`** — mobile client; session stream, approval cards, quick prompts.
- **`relay/`** — optional, self-hostable; forwards ciphertext + wakes your phone
  with push notifications. Never sees plaintext.

## Try it now (v0.6 — paired · encrypted · steering · push · works anywhere)

**Approve — and steer — your Claude Code sessions from your phone** on an
end-to-end encrypted channel that only *your* paired phone can use — on your
Wi-Fi, over a VPN, or from **anywhere via the zero-knowledge relay**.

```bash
npm install && npm start        # prints a pairing QR
```

Scan the QR with your phone, wire up the hook, and every `Bash`/`Write`/`Edit`
the agent tries pops up as a tap-to-approve card — decrypted on your device.
It's a conversation, not just a gate: **Deny with a typed note** and Claude
reads it as feedback ("don't run that — do X instead"); when the agent finishes
a turn, a **"what next?"** card lets you send the next instruction so it keeps
going while you're out.
Full walkthrough: **[docs/QUICKSTART.md](docs/QUICKSTART.md)**.

Away from home? Two paths — a VPN, or the **zero-knowledge relay** (no VPN, no
open ports; it forwards sealed blobs it cannot read): **[docs/REMOTE.md](docs/REMOTE.md)**.
Deploy the relay free in one click:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/RaviChanduEdru/awaykit)

> 🔒 The channel is encrypted + authenticated (NaCl secretbox) with **per-session
> forward secrecy** (X25519 ephemeral keys) — only your paired phone can connect,
> and leaking the long-term key can't decrypt past sessions. On plain-HTTP LAN it
> doesn't stop an *active* on-path attacker; running over a VPN (Tailscale/
> WireGuard) closes that gap. Honest threat model: [SECURITY.md](docs/SECURITY.md).

**🔔 Push notifications.** Over an HTTPS connection (the relay or a tunnel), open
the app, tap the status pill → **Enable notifications**, and your phone buzzes the
moment the agent needs you — even with the app closed. The daemon sends the push
outbound itself; the payload is end-to-end encrypted to your device (RFC 8291), so
the relay and the push service only ever forward ciphertext.

## Managing the daemon

The daemon has a small lifecycle CLI so you never have to hunt for a stray
process or hit an `EADDRINUSE` crash. Run these from the repo root:

| Command | What it does |
|---|---|
| `npm start` | Start the daemon (prints the pairing QR). If one is already running, it just reports the status instead of crashing. |
| `npm run status` | Is it up? How many phones are connected? Any approvals waiting? |
| `npm run stop` | Cleanly shut it down. |
| `npm run restart` | Stop the running daemon and start a fresh one — handy after pulling code. |

- Re-pair (mint a new key + QR) with `npm start -- --pair`.
- Run a second instance on another port with `AWAYKIT_PORT=4600 npm start`.
- The controls talk to the daemon over loopback (`/health`, `/shutdown`), so
  there are no PID files and it works the same on macOS, Linux, and Windows.

**On the phone**, tap the status pill (top-right) for connection controls:
**Reconnect now**, **Disconnect**, and **Unpair this device**. The stream also
auto-reconnects on its own — so a laptop-side `npm run restart` reconnects your
phone automatically, no re-scan needed (the pairing key persists).

## Status

🚧 **Early development.**
- ✅ **Milestone 0** — hook → daemon → phone approval card → approve/deny unblocks the agent (LAN).
- ✅ **v0.1** — QR pairing + end-to-end encrypted, authenticated channel (only your paired phone connects).
- ✅ **v0.2** — forward secrecy: per-session X25519 ephemeral keys, so leaking the long-term key can't decrypt past sessions.
- ✅ **v0.3** — remote access: use it from any network over a VPN; auto-detects the VPN address for pairing.
- ✅ **v0.4** — chat steering: Deny carries your typed note to Claude as feedback; "turn finished — what next?" cards keep the agent going with your instructions.
- ✅ **v0.5** — zero-knowledge relay: remote access from anywhere with **no VPN and no open ports** — a self-hostable relay forwards sealed blobs it cannot read.
- ✅ **v0.6** — push notifications: your phone buzzes even when the app is closed. Works over HTTPS (relay/tunnel); the payload is E2E-encrypted (RFC 8291), so the relay and push service see only ciphertext.
- ⏭️ Next: integrity vs an active on-path attacker (HTTPS app shell); agent-agnostic adapters.

Star/watch the repo to follow along.

## Roadmap

- [x] Milestone 0 — end-to-end approve/deny loop over LAN (hook + daemon + web client)
- [x] v0.1 — QR pairing + encrypted, authenticated channel (NaCl secretbox)
- [x] v0.2 — forward secrecy (per-session X25519 ephemeral keys)
- [x] v0.3 — remote access from any network over a VPN (Tailscale/WireGuard)
- [x] v0.4 — chat steering (deny with instructions; continue-on-stop with your next prompt)
- [x] v0.5 — zero-knowledge relay (remote without a VPN, ciphertext only)
- [x] v0.6 — push notifications (wake the phone even with the app closed, over HTTPS)
- [ ] v0.7 — integrity vs an active on-path attacker (HTTPS app shell / native app)
- [ ] v0.8 — agent-agnostic adapters (Codex, Cursor CLI, OpenCode)
- [ ] v1.0 — audited security model, reproducible builds

## Contributing

PRs and issues welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

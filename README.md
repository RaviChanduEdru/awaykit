# awaykit

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

## Try it now (Milestone 0)

The first working loop is here: **approve your Claude Code tool calls from your
phone**, over your own Wi-Fi, with zero dependencies (just Node).

```bash
cd daemon && npm start          # prints a phone: URL
```

Open that URL on your phone, wire up the hook, and every `Bash`/`Write`/`Edit`
the agent tries pops up as a tap-to-approve card. Full walkthrough:
**[docs/QUICKSTART.md](docs/QUICKSTART.md)**.

> ⚠️ Milestone 0 is LAN-only and **not encrypted or authenticated yet** — a demo
> of the loop, not a secure product. Encryption & pairing are the next milestones.

## Status

🚧 **Early development.**
- ✅ **Milestone 0** — Claude Code hook → laptop daemon → phone approval card →
  approve/deny unblocks the agent. Works over LAN today.
- ⏭️ Next: QR pairing + end-to-end encryption, then push notifications.

Star/watch the repo to follow along.

## Roadmap

- [x] Milestone 0 — end-to-end approve/deny loop over LAN (hook + daemon + web client)
- [ ] v0.1 — QR pairing + X25519 key exchange; end-to-end encrypted channel
- [ ] v0.2 — push notifications via optional relay (ciphertext only)
- [ ] v0.3 — agent-agnostic adapters (Codex, Cursor CLI, OpenCode)
- [ ] v0.4 — multi-session dashboard, session history
- [ ] v1.0 — audited security model, reproducible builds

## Contributing

PRs and issues welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

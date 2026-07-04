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

## Try it now (v0.3 — paired · encrypted · forward-secret · works anywhere)

**Approve your Claude Code tool calls from your phone** on an end-to-end
encrypted channel that only *your* paired phone can use — on your Wi-Fi, or from
any network over a VPN.

```bash
npm install && npm start        # prints a pairing QR
```

Scan the QR with your phone, wire up the hook, and every `Bash`/`Write`/`Edit`
the agent tries pops up as a tap-to-approve card — decrypted on your device.
Full walkthrough: **[docs/QUICKSTART.md](docs/QUICKSTART.md)**. Away from home?
Put both devices on a VPN and it works from anywhere — **[docs/REMOTE.md](docs/REMOTE.md)**.

> 🔒 The channel is encrypted + authenticated (NaCl secretbox) with **per-session
> forward secrecy** (X25519 ephemeral keys) — only your paired phone can connect,
> and leaking the long-term key can't decrypt past sessions. On plain-HTTP LAN it
> doesn't stop an *active* on-path attacker; running over a VPN (Tailscale/
> WireGuard) closes that gap. Honest threat model: [SECURITY.md](docs/SECURITY.md).

## Status

🚧 **Early development.**
- ✅ **Milestone 0** — hook → daemon → phone approval card → approve/deny unblocks the agent (LAN).
- ✅ **v0.1** — QR pairing + end-to-end encrypted, authenticated channel (only your paired phone connects).
- ✅ **v0.2** — forward secrecy: per-session X25519 ephemeral keys, so leaking the long-term key can't decrypt past sessions.
- ✅ **v0.3** — remote access: use it from any network over a VPN; auto-detects the VPN address for pairing.
- ⏭️ Next: zero-knowledge relay (remote without a VPN); push notifications; integrity vs active MITM.

Star/watch the repo to follow along.

## Roadmap

- [x] Milestone 0 — end-to-end approve/deny loop over LAN (hook + daemon + web client)
- [x] v0.1 — QR pairing + encrypted, authenticated channel (NaCl secretbox)
- [x] v0.2 — forward secrecy (per-session X25519 ephemeral keys)
- [x] v0.3 — remote access from any network over a VPN (Tailscale/WireGuard)
- [ ] v0.4 — zero-knowledge relay (remote without a VPN, ciphertext only)
- [ ] v0.5 — push notifications; integrity vs active MITM (HTTPS / native app)
- [ ] v0.6 — agent-agnostic adapters (Codex, Cursor CLI, OpenCode)
- [ ] v1.0 — audited security model, reproducible builds

## Contributing

PRs and issues welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)

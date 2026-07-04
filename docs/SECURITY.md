# awaykit security model

Security is the reason awaykit exists. This document is the living threat model.
If a design decision here is wrong, please open an issue.

## Goals

1. An attacker who compromises the relay learns **nothing** (ciphertext only).
2. An attacker who steals the phone cannot escalate to full laptop access
   (session-scoped permissions, optional biometric gate for approvals).
3. An attacker on the network cannot read or inject messages
   (E2E encryption with mutual authentication).
4. No third party — including us — ever holds keys or plaintext.

## Pairing

- First-run: daemon displays a QR code containing its public key + one-time token.
- Phone scans it, sends its public key back over the ephemeral channel.
- Both sides derive a shared secret (X25519), verified with a short auth string
  shown on both screens.
- Result: mutual TOFU key pinning. No passwords, no accounts.

## Transport

Two supported modes:

| Mode | How | Trade-off |
|---|---|---|
| VPN | WireGuard / Tailscale between phone & laptop | simplest, no relay needed |
| Relay | WebRTC data channel; self-hostable relay for signaling + push wake-ups | works anywhere, relay sees ciphertext only |

All payloads are additionally encrypted at the application layer
(libsodium `crypto_secretstream`) — the transport is not trusted.

## Authorization scopes

The phone client is scoped to the **agent session protocol**, not a shell:

- `session.read` — view output stream
- `session.respond` — answer agent prompts (approve/deny/text)
- `session.prompt` — send new instructions
- `session.kill` — terminate the session
- `shell.full` — ❌ off by default; explicit opt-in with a warning, per-device

Every action is logged locally to an append-only audit file.

## Out of scope (for now)

- Protecting against a fully compromised laptop or phone OS
- Multi-user / team access control (single-owner assumption)

## Reporting a vulnerability

Please open a private security advisory on GitHub rather than a public issue.

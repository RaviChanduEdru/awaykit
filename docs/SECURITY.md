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

## Implemented today (v0.2)

The sections below (`Pairing`, `Transport`, `Authorization scopes`) describe the
**target** design. Here is what the code actually does **right now**, and its
honest limits.

**What's built:**

- **Shared-key pairing via QR.** On first run the daemon mints a random 256-bit
  key `K`, persisted at `~/.awaykit/key` (mode `600`). The pairing QR encodes
  `http://<lan-ip>:<port>/#k=<key>` — the key rides in the URL **fragment**,
  which browsers never send to the server, so `K` is not transmitted over the
  (plain-HTTP) network during pairing. Re-pair anytime with `npm start -- --pair`.
- **Forward secrecy via per-session ephemeral keys.** `K` only *authenticates*
  the handshake; it never encrypts channel data. On each connection, phone and
  daemon run an X25519 exchange (each side's ephemeral public key is sealed under
  `K`, so an attacker without `K` can't inject their own) and derive a throwaway
  session key. Recording ciphertext and *later* stealing `K` does **not** decrypt
  past sessions — the ephemeral secrets are already gone.
- **Authenticated encryption on every message.** Each phone⇄daemon message is
  sealed with NaCl `secretbox` (XSalsa20-Poly1305) under the **session key**,
  with a random nonce. The SSE stream uses a single opaque event type, so even
  the *kind* of message is hidden. The same primitives run in the browser via a
  vendored `tweetnacl` (WebCrypto's `subtle` is unavailable over plain HTTP, so
  we bundle a pure-JS lib; only `crypto.getRandomValues`, which works on HTTP, is
  used).
- **Session gate.** `/events` and `/respond` require a session cookie that is
  only issued after the phone proves it holds `K` (a sealed, time-fresh proof
  carrying its ephemeral public key, to `POST /session`).
- **Loopback-only `/hook`.** The hook endpoint rejects non-loopback connections,
  so a device on the LAN cannot inject fake tool prompts.
- **Connection is the switch.** With no paired phone connected, the daemon does
  not intercept — Claude Code uses its normal on-laptop permission flow.
- **Append-only audit log.** Every decision (approve / deny / aborted) is
  recorded as a JSON line at `~/.awaykit/audit.log` — a local record of what you
  approved while away. Read recent entries over loopback via `GET /audit`.
- **Zero-knowledge relay (optional, `AWAYKIT_RELAY`).** For remote access with
  no VPN: the daemon holds an *outbound* connection to a self-hosted relay (no
  inbound ports), and the phone reaches the relay from anywhere. Rooms are keyed
  by an irreversible hash of `K`; every payload is an opaque sealed blob using
  the same forward-secret handshake as LAN mode. The relay learns timing,
  direction, and size — never keys, never plaintext. Remote sessions ping every
  25 s and expire after 90 s of silence, so "connection is the switch" stays
  truthful remotely.

**What v0.1 defends against:** a passive Wi-Fi sniffer (sees only ciphertext);
an unauthorized device on the same network (no `K` ⇒ can't read events, can't
forge an approval, can't pass the session gate); tampered ciphertext (Poly1305
auth tag rejects it).

**Residual risks — NOT yet covered (tracked for later milestones):**

- **App shell served over plain HTTP.** The HTML/JS is delivered unencrypted, so
  an *active* on-path attacker (ARP spoof / rogue AP) could tamper with the
  client code before any key is used. Full integrity needs HTTPS with a pinned
  cert, or the native app. Today's crypto stops passive attackers, not active MITM.
- **Key at rest on the phone** lives in `localStorage`. A device-scoped biometric
  gate is future work.
- **Relay app-shell trust.** In relay mode the phone loads the app shell from
  the relay host — host the relay behind HTTPS and treat that host as part of
  your trust base (it can serve code, but it still never sees keys or plaintext
  messages, which live in the URL fragment / on-device).

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

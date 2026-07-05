# Quickstart — v0.6 (paired · encrypted · forward-secret · push · remote-ready)

Approve your Claude Code tool calls from your phone —
**end-to-end encrypted**, only *your* paired phone can connect, and (over a VPN)
from any network. Self-hosted, no accounts, no cloud.

> **What this is:** the loop from Milestone 0, now with QR pairing, an encrypted +
> authenticated channel with **forward secrecy** (per-session X25519 keys), and
> optional **remote access** over a VPN. On plain-HTTP LAN it still doesn't stop
> an *active* on-path attacker — a VPN ([REMOTE.md](REMOTE.md)) covers that. Full
> threat model: [SECURITY.md](SECURITY.md).

## Prerequisites

- **Node.js 18+** on your laptop (`node --version`)
- **Claude Code** installed
- Your **phone on the same Wi-Fi** as the laptop

## 1. Install & start the daemon

```bash
npm install      # first time only — installs daemon deps (tweetnacl, qrcode)
npm start        # starts the daemon and prints a pairing QR
```

You'll see a banner with a **QR code**:

```
  awaykit daemon — v0.1 (paired + encrypted)
  ─────────────────────────────────────────
  local:   http://127.0.0.1:4517
  phone:   http://192.168.1.23:4517   (same Wi-Fi)

  Scan to pair your phone (this QR contains your secret key):

     █▀▀▀▀▀█ ▄▀ ▄ █▀▀▀▀▀█
     █ ███ █ ▀█▄▀ █ ███ █      ← scan this with your phone camera
     █ ▀▀▀ █ █ ▄  █ ▀▀▀ █
     ▀▀▀▀▀▀▀ █▄▀▄ ▀▀▀▀▀▀▀
     ...

  Key stored at: ~/.awaykit/key   (re-pair anytime with:  npm start -- --pair)
```

## 2. Pair your phone

Point your phone camera (or any QR scanner) at the QR code and open the link.
The awaykit screen loads and shows a green **connected** dot with a 🔒 — you're
paired and the channel is encrypted. The key is stored on your phone; you won't
need to scan again.

> **Firewall (Windows):** if the page won't load, your firewall is blocking the
> port. Double-click [`scripts/allow-lan-windows.bat`](../scripts/allow-lan-windows.bat)
> and approve the UAC prompt (opens TCP 4517 to your local subnet only). Undo
> with `scripts/deny-lan-windows.bat`.

> **The connection is the switch.** While your paired phone is connected, tool
> calls route to it. While it's not, awaykit stays out of the way and Claude Code
> prompts you normally on the laptop. Open the page when you leave; close it when
> you're back.

> **Use it from anywhere.** Two options: a VPN (Tailscale — awaykit auto-detects
> the address for the QR), or the **zero-knowledge relay** (`AWAYKIT_RELAY=…`) —
> no VPN, no open ports, and the relay only ever sees ciphertext. See
> **[REMOTE.md](REMOTE.md)**.

> **🔔 Get notified with the app closed.** Over an **HTTPS** connection (the relay
> or an HTTPS tunnel — not plain-HTTP LAN), tap the status pill → **Enable
> notifications**. Your phone then buzzes the moment the agent needs you, even when
> awaykit isn't open. On iPhone, first add awaykit to your Home Screen (Share → Add
> to Home Screen) and launch it from there, then enable notifications. The push
> payload is end-to-end encrypted to your device — the relay and push service only
> forward ciphertext.

## 3. Wire the hook into Claude Code

Add awaykit as a hook in your Claude Code settings — **user settings**
(`~/.claude/settings.json`) for every project, or a project's
`.claude/settings.json` for one repo.

Copy the block from [`examples/claude-code-settings.json`](../examples/claude-code-settings.json),
changing the `hook.js` path to wherever you cloned awaykit. On Windows, use
forward slashes to avoid JSON escaping pain:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        // Only route tools that DO something. Reads/greps are never intercepted.
        "matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/path/to/awaykit/daemon/src/hook.js\"",
            "timeout": 3600
          }
        ]
      }
    ],
    "Notification": [
      { "matcher": ".*", "hooks": [
        { "type": "command", "command": "node \"C:/path/to/awaykit/daemon/src/hook.js\"" } ] }
    ],
    "Stop": [
      { "hooks": [
        { "type": "command", "command": "node \"C:/path/to/awaykit/daemon/src/hook.js\"", "timeout": 120 } ] }
    ]
  }
}
```

- **`timeout: 3600`** — a `PreToolUse` hook blocks while it waits for your tap.
  The default cap is 600s (10 min); bump it to an hour so you have time to answer
  from your phone while you're out. If it times out, Claude Code falls back to its
  normal prompt.
- **`Stop`** is where the chat steering lives: when the agent finishes a turn,
  your phone gets a **"what next?"** card for 45 s. Type an instruction and tap
  **Continue ▶** — the agent keeps going with it. Ignore it (or tap **Let it
  stop**) and the turn ends normally. The `timeout: 120` gives the hook room to
  wait out the card.
- **`Notification`** is optional — it feeds the phone's *Activity* log.

Restart Claude Code (or run `/hooks`) so it picks up the new hooks.

## 4. Try it

1. Keep the daemon running and the phone paired/connected.
2. In Claude Code, ask it to run a command or edit a file — e.g. *"run `npm install express`"*.
3. Your phone buzzes and shows an **approval card** (decrypted on-device): the
   tool and the exact command. Tap **Approve** → Claude Code unblocks. Tap
   **Deny** → the tool call is refused and Claude sees why.
4. **Steer with text**: type a note on the card before tapping **Deny** — e.g.
   *"don't publish, run the tests first"* — and Claude reads it as feedback and
   adapts. It's a chat, not just a gate.
5. **Keep it going**: when the agent finishes its turn, the phone shows a
   **"turn finished — what next?"** card. Type *"continue with the next
   feature"* and tap **Continue ▶** (or just press Enter) — the agent picks it
   up as its next instruction. Unanswered, the card expires and the agent stops
   normally.

That's the loop: laptop agent → encrypted channel → your phone → your decision (or instructions) → laptop agent.

## 5. Live chat — drive a session from your phone (v0.9, opt-in)

Approvals (above) are awaykit's default *Gate mode*. **Chat mode** lets you start
and steer a Claude Code session from the phone. It's **off by default**; enable it
on the laptop with a project allow-list — sessions may only start in these dirs:

```bash
AWAYKIT_CHAT=1 AWAYKIT_PROJECTS="/path/to/repoA:/path/to/repoB" npm start
```

(Use `;` between paths on Windows.) Then on the phone:

1. Tap the **💬 Chat** tab (it appears only when chat is enabled).
2. Tap **＋ New** and pick a project → a live session starts.
3. Type in the composer and send. The agent's reply **streams in live**; send
   follow-ups any time.
4. When the agent uses a tool, its **approval card appears inline in the chat** —
   approve/deny right there (chat sessions are gated with **no extra hook setup**;
   the daemon injects its own). Tap the session chip for **Interrupt** / **End**.

Nothing about the trust model relaxes: chat sessions run with normal permissions
(every tool still crosses your phone), only start in allow-listed dirs, and every
message is audited. Full design + threat model: **[LIVE-CHAT.md](LIVE-CHAT.md)**.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AWAYKIT_PORT` | `4517` | Port the daemon listens on |
| `AWAYKIT_HOST` | `0.0.0.0` | Bind address (all interfaces so the phone can reach it) |
| `AWAYKIT_URL`  | `http://127.0.0.1:4517` | Where the **hook** finds the daemon |
| `AWAYKIT_HOME` | `~/.awaykit` | Where the pairing key is stored |
| `AWAYKIT_STOP_WAIT_MS` | `45000` | How long the "turn finished — what next?" card waits for an answer before the agent stops normally. Keep it below the `Stop` hook's `timeout` |
| `AWAYKIT_PUBLIC_HOST` | _(auto-detect)_ | Host/IP to encode in the pairing QR — set to your VPN address for remote access ([REMOTE.md](REMOTE.md)) |
| `AWAYKIT_TLS` | _(off)_ | Set to `1` to serve the LAN over **self-signed HTTPS** (app-shell + channel integrity vs an active on-path attacker; also unlocks LAN push if you trust the cert). The banner prints a SHA-256 fingerprint — verify it the first time your phone warns. Relay/VPN remain the zero-friction strong paths. See [SECURITY.md](SECURITY.md). |
| `AWAYKIT_CHAT` | _(off)_ | Set to `1` to enable **live chat** (drive sessions from the phone). Requires `AWAYKIT_PROJECTS`; off without it. See [LIVE-CHAT.md](LIVE-CHAT.md). |
| `AWAYKIT_PROJECTS` | _(none)_ | Allow-list of project dirs a chat session may start in (`:`-separated on macOS/Linux, `;` on Windows). |
| `AWAYKIT_CHAT_MODEL` | `sonnet` | Model alias for phone-started chat sessions. |

Re-pair all devices (rotate the key): `npm start -- --pair`.

## Troubleshooting

- **Phone can't load the page** — different network, or the firewall is blocking
  the port. On Windows run `scripts/allow-lan-windows.bat` (see above).
- **"Pairing expired / key changed"** — you rotated the key (`--pair`) or moved
  the key file. Re-scan the QR from the terminal.
- **Nothing shows on the phone when the agent runs a command** — check the daemon
  terminal for a `→ phone:` line. No line means the hook didn't fire: confirm the
  `command` path in settings.json and run `/hooks`.
- **Every tool asks, even reads** — your `matcher` is too broad. Keep it to
  `Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch`.
- **It asks even when I'm at the laptop** — close the phone page. With no paired
  phone connected, Claude Code prompts locally as normal.

## Security reality check ⚠️

v0.1 **encrypts and authenticates** the phone⇄laptop channel (NaCl secretbox;
only a device with your paired key can connect, read events, or approve). That
defeats passive Wi-Fi snooping and random devices on your network.

It does **not** yet defend against an **active** on-path attacker, because the app
shell is still served over plain HTTP — so stick to networks you trust for now.
HTTPS/pinning and a native app are the next milestones. Full threat model:
[SECURITY.md](SECURITY.md).

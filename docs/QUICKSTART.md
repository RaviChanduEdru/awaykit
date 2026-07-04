# Quickstart — v0.3 (paired · encrypted · forward-secret · remote-ready)

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

> **Use it from anywhere.** To approve commands off your home Wi-Fi, put both
> devices on a VPN (Tailscale is easiest) — awaykit auto-detects the VPN address
> for the QR. See **[REMOTE.md](REMOTE.md)**.

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
        { "type": "command", "command": "node \"C:/path/to/awaykit/daemon/src/hook.js\"" } ] }
    ]
  }
}
```

- **`timeout: 3600`** — a `PreToolUse` hook blocks while it waits for your tap.
  The default cap is 600s (10 min); bump it to an hour so you have time to answer
  from your phone while you're out. If it times out, Claude Code falls back to its
  normal prompt.
- **`Notification`** and **`Stop`** are optional — they feed the phone's
  *Activity* log ("agent needs input", "agent finished a turn").

Restart Claude Code (or run `/hooks`) so it picks up the new hooks.

## 4. Try it

1. Keep the daemon running and the phone paired/connected.
2. In Claude Code, ask it to run a command or edit a file — e.g. *"run `npm install express`"*.
3. Your phone buzzes and shows an **approval card** (decrypted on-device): the
   tool and the exact command. Tap **Approve** → Claude Code unblocks. Tap
   **Deny** → the tool call is refused and Claude sees why.

That's the loop: laptop agent → encrypted channel → your phone → your decision → laptop agent.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AWAYKIT_PORT` | `4517` | Port the daemon listens on |
| `AWAYKIT_HOST` | `0.0.0.0` | Bind address (all interfaces so the phone can reach it) |
| `AWAYKIT_URL`  | `http://127.0.0.1:4517` | Where the **hook** finds the daemon |
| `AWAYKIT_HOME` | `~/.awaykit` | Where the pairing key is stored |
| `AWAYKIT_PUBLIC_HOST` | _(auto-detect)_ | Host/IP to encode in the pairing QR — set to your VPN address for remote access ([REMOTE.md](REMOTE.md)) |

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

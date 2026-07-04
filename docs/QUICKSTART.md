# Quickstart — Milestone 0

Approve your Claude Code tool calls from your phone, over your own Wi-Fi.
No accounts, no cloud, no npm install — just Node.

> **What this milestone is:** the smallest end-to-end loop that proves the idea.
> LAN only, no encryption yet, phone client is a web page (not the native app yet).
> Everything hardens outward from here — see [SECURITY.md](SECURITY.md) and the
> [roadmap](../README.md#roadmap).

## Prerequisites

- **Node.js 18+** on your laptop (`node --version`)
- **Claude Code** installed
- Your **phone on the same Wi-Fi** as the laptop

## 1. Start the daemon

```bash
cd daemon
npm start        # or: node src/daemon.js
```

You'll see:

```
  awaykit daemon — Milestone 0
  ───────────────────────────
  local:   http://127.0.0.1:4517
  phone:   http://192.168.1.23:4517   ← open this on your phone (same Wi-Fi)
```

## 2. Open the phone client

On your phone's browser, open the `phone:` URL printed above
(e.g. `http://192.168.1.23:4517`). You should see the awaykit screen with a
green **connected** dot.

> **The connection is the switch.** While a phone is connected, tool calls route
> to it. While no phone is connected, awaykit stays out of the way and Claude
> Code prompts you normally on the laptop. Open the page when you leave; close it
> when you're back.

## 3. Wire the hook into Claude Code

Add awaykit as a hook in your Claude Code settings. Use **user settings**
(`~/.claude/settings.json`) to have it work across every project, or a project's
`.claude/settings.json` for just that repo.

Copy the block from [`examples/claude-code-settings.json`](../examples/claude-code-settings.json),
adjusting the path to `hook.js` to wherever you cloned awaykit. On Windows, use
forward slashes in the path (Node accepts them) to avoid JSON escaping pain:

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
  from your phone while you're out. If it ever times out, Claude Code falls back
  to its normal prompt.
- The **`Notification`** and **`Stop`** hooks are optional — they feed the
  phone's *Activity* log ("agent needs input", "agent finished a turn").

Restart Claude Code (or run `/hooks` to confirm they're registered).

## 4. Try it

1. Keep the daemon running and the phone page open.
2. In Claude Code, ask it to do something that runs a command or edits a file —
   e.g. *"run `npm install express`"*.
3. Your phone buzzes and shows an **approval card**: the tool and the exact
   command. Tap **Approve** → Claude Code unblocks and proceeds. Tap **Deny** →
   the tool call is refused and Claude sees why.

That's the whole loop: laptop agent → phone → your decision → laptop agent.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AWAYKIT_PORT` | `4517` | Port the daemon listens on |
| `AWAYKIT_HOST` | `0.0.0.0` | Bind address (all interfaces so the phone can reach it) |
| `AWAYKIT_URL`  | `http://127.0.0.1:4517` | Where the **hook** finds the daemon |

## Troubleshooting

- **Phone can't load the page** — you're on a different network, or the laptop
  firewall is blocking the port. On Windows, allow Node through the firewall for
  private networks, or run:
  `New-NetFirewallRule -DisplayName "awaykit" -Direction Inbound -LocalPort 4517 -Protocol TCP -Action Allow`
- **Nothing shows on the phone when the agent runs a command** — check the daemon
  terminal for a `→ phone:` line. No line means the hook didn't fire: confirm the
  `command` path in settings.json is correct and run `/hooks` in Claude Code.
- **Every tool asks, even reads** — your `matcher` is too broad. Keep it to
  `Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch`.
- **It asks even when I'm at the laptop** — close the phone page. With no phone
  connected the daemon returns instantly and Claude Code prompts locally.

## Security reality check ⚠️

Milestone 0 is a **LAN-only, unencrypted, unauthenticated** demo. Anyone on your
Wi-Fi who opens the URL can approve/deny your tool calls. Do **not** use it on
untrusted networks. Pairing, end-to-end encryption, and auth are the very next
milestones — see [SECURITY.md](SECURITY.md).

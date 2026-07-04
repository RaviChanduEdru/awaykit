# Remote access — use awaykit from any network

Milestones 0–0.2 are **same-Wi-Fi only**. To approve commands when you're
actually out (different Wi-Fi, mobile data), put your phone and laptop on the
same **private network** with a VPN. awaykit auto-detects the VPN address and
puts it in the pairing QR.

> **Never port-forward `4517` to the public internet.** The app shell is served
> over plain HTTP; exposing it publicly is unsafe. A VPN keeps the daemon private
> *and* gives you an encrypted, authenticated tunnel.

## Recommended: Tailscale (easiest)

[Tailscale](https://tailscale.com) puts your devices on a private WireGuard
network with zero config — no port-forwarding, works behind NAT.

1. **Install Tailscale** on your laptop **and** your phone, and sign in to the
   **same account** on both.
2. On the laptop, find your Tailscale IP:
   ```bash
   tailscale ip -4        # e.g. 100.101.102.103
   ```
3. **Start awaykit** normally:
   ```bash
   npm start
   ```
   It auto-detects the Tailscale address (CGNAT range `100.64.0.0/10`) and marks
   it in the banner as `remote: … (any network via VPN)`, then encodes it in the
   pairing QR. To force a specific host:
   ```bash
   AWAYKIT_PUBLIC_HOST=100.101.102.103 npm start
   ```
4. On your **phone with Tailscale connected** (from anywhere), scan the QR. You're
   paired and reachable from any network.

### Windows firewall for Tailscale

The `scripts/allow-lan-windows.bat` rule only opens the port to your *local*
subnet. To also allow your tailnet, run this once in an **Administrator**
PowerShell:

```powershell
New-NetFirewallRule -DisplayName "awaykit tailscale" -Direction Inbound `
  -LocalPort 4517 -Protocol TCP -Action Allow -RemoteAddress 100.64.0.0/10
```

## Alternative: WireGuard / ZeroTier

Any VPN that gives both devices an address on a shared private network works.
awaykit recognizes interfaces named `tailscale*`, `wireguard*`, `wg*`,
`zerotier*`, `tun*`, `utun*`, `tap*`, and any `100.64.0.0/10` address as
"reachable anywhere". If yours isn't detected, just set it explicitly:

```bash
AWAYKIT_PUBLIC_HOST=<your-vpn-ip-or-hostname> npm start
```

## Security notes

- **The VPN closes the active-MITM gap.** awaykit's own layer already encrypts +
  authenticates every message (see [SECURITY.md](SECURITY.md)), but the app shell
  is served over plain HTTP — so on a hostile LAN an active attacker could tamper
  with it. Over Tailscale/WireGuard the transport is itself WireGuard-encrypted
  and authenticated, so that gap is covered. Defense in depth.
- **Still private.** The daemon is only reachable on your tailnet, not the public
  internet. No third party sees your traffic.
- **Not a relay.** This uses a VPN. A self-hosted, zero-knowledge relay (no VPN
  needed, ciphertext-only) is the next milestone — see the roadmap.

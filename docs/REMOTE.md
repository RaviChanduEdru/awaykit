# Remote access — use awaykit from any network

Out of the box awaykit is **same-Wi-Fi only**. To approve commands when you're
actually out (different Wi-Fi, mobile data), pick one of two paths:

| | **Zero-knowledge relay** | **VPN (Tailscale/WireGuard)** |
|---|---|---|
| Setup | host one tiny Node server | install VPN on both devices |
| Laptop inbound ports | none (outbound only) | VPN handles it |
| Third party sees | ciphertext, timing, size | nothing (your tailnet) |
| Works behind strict NAT | ✅ | ✅ |

> **Never port-forward `4517` to the public internet.** The daemon is not meant
> to be publicly exposed. Use the relay or a VPN.

## Option A: zero-knowledge relay (no VPN)

Host [`relay/server.js`](../relay/README.md) anywhere — a $3 VPS, a free-tier
container, a Raspberry Pi. Zero dependencies. **Put it behind HTTPS** (that also
protects the app shell it serves to your phone).

```bash
# on the relay host
node relay/server.js                    # listens on :4600 (PORT to change)

# on the laptop
AWAYKIT_RELAY=https://relay.example.com npm start
```

The daemon connects **outbound** to the relay (no inbound ports, no firewall
rules on the laptop) and the pairing QR now points at the relay — scan it from
your phone **anywhere**.

What the relay can and cannot see: rooms are identified by a hash of your
pairing key (irreversible), and every message is an opaque sealed blob — the
same forward-secret protocol as LAN mode. The relay learns timing, direction,
and size. Never keys, never plaintext. Details: [relay/README.md](../relay/README.md).

## Option B: Tailscale (VPN)

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

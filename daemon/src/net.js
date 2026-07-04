/**
 * awaykit network helpers — choose the address to put in the pairing QR.
 *
 * For LAN-only use, any private IPv4 works. For remote access (v0.3), the phone
 * reaches the laptop over a VPN (Tailscale / WireGuard / ZeroTier), so the QR
 * must advertise that reachable address, not the local Wi-Fi one. These are pure
 * functions (no I/O) so they're unit-testable.
 */

/** Tailscale hands out CGNAT-range addresses: 100.64.0.0/10. */
export function isCGNAT(ip) {
  const p = String(ip).split(".").map(Number);
  return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}

const VPN_IFACE = /tailscale|wireguard|\bwg\d|zerotier|utun|tun\d|tap\d/i;

/**
 * Flatten os.networkInterfaces() into candidate hosts, classified by how far
 * they reach: "vpn" (works from anywhere) vs "lan" (same network only).
 */
export function candidateHosts(ifaces) {
  const out = [];
  for (const name of Object.keys(ifaces || {})) {
    for (const net of ifaces[name] || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      const kind = isCGNAT(net.address) || VPN_IFACE.test(name) ? "vpn" : "lan";
      out.push({ ip: net.address, iface: name, kind });
    }
  }
  // VPN addresses first (reachable remotely), then LAN.
  return out.sort((a, b) => (a.kind === "vpn" ? -1 : 1) - (b.kind === "vpn" ? -1 : 1));
}

/**
 * Pick the single host to encode in the pairing QR:
 *  1. AWAYKIT_PUBLIC_HOST if set (a domain / public IP you control),
 *  2. else a VPN address (reachable from anywhere),
 *  3. else the first LAN address,
 *  4. else loopback.
 */
export function pickPairingHost(ifaces, publicHost) {
  if (publicHost) return { ip: publicHost, iface: "AWAYKIT_PUBLIC_HOST", kind: "public" };
  const cands = candidateHosts(ifaces);
  return cands.find((c) => c.kind === "vpn") || cands[0] || { ip: "127.0.0.1", iface: "loopback", kind: "local" };
}

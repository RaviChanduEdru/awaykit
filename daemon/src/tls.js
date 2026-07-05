/**
 * awaykit TLS — optional self-signed HTTPS for LAN (v0.7).
 *
 * By default the daemon serves plain HTTP on the LAN, which an *active* on-path
 * attacker could tamper with (the app shell rides in the clear). Set
 * `AWAYKIT_TLS=1` and the daemon generates a self-signed certificate (persisted
 * in ~/.awaykit) and serves HTTPS instead.
 *
 * Honest limits (see docs/SECURITY.md): a browser can't *pin* a self-signed cert,
 * so you'll get a one-time warning to accept — verify the SHA-256 fingerprint the
 * daemon prints matches the browser's before trusting it. That gives you TLS
 * encryption + tamper-evidence on the LAN, and (if you install the cert as
 * trusted) a secure context that unlocks LAN push without the relay. For
 * zero-friction strong assurance, the relay or a VPN remain the recommended
 * paths — they're real TLS / WireGuard.
 */

import selfsigned from "selfsigned";
import { X509Certificate } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.AWAYKIT_HOME || join(homedir(), ".awaykit");
const CERT_PATH = join(CONFIG_DIR, "tls-cert.pem");
const KEY_PATH = join(CONFIG_DIR, "tls-key.pem");

function fingerprintOf(certPem) {
  try { return new X509Certificate(certPem).fingerprint256; } catch { return ""; }
}
function subjectAltName(certPem) {
  try { return new X509Certificate(certPem).subjectAltName || ""; } catch { return ""; }
}
function notExpired(certPem) {
  try { return new Date(new X509Certificate(certPem).validTo).getTime() > Date.now() + 86_400_000; } catch { return false; }
}

/**
 * Load a persisted cert, or mint a fresh one if it's missing, expired, or no
 * longer covers the addresses the phone will use (e.g. the LAN IP changed).
 * @param {string[]} ips  addresses to include as SANs (LAN/VPN IPs)
 * @returns {Promise<{key:string, cert:string, fingerprint:string, reused:boolean}>}
 */
export async function loadOrCreateCert(ips = []) {
  const need = ["127.0.0.1", "::1", ...ips].filter((v, i, a) => v && a.indexOf(v) === i);
  // Coverage is checked only for IPv4 SANs: X509 expands IPv6 (e.g. ::1 ->
  // 0:0:0:0:0:0:0:1), which wouldn't substring-match and would force needless
  // regeneration on every start.
  const mustCover = need.filter((ip) => !ip.includes(":"));
  if (existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    try {
      const cert = readFileSync(CERT_PATH, "utf8");
      const key = readFileSync(KEY_PATH, "utf8");
      const san = subjectAltName(cert);
      if (notExpired(cert) && mustCover.every((ip) => san.includes(ip))) {
        return { key, cert, fingerprint: fingerprintOf(cert), reused: true };
      }
    } catch { /* fall through and regenerate */ }
  }
  return regenerateCert(need);
}

/** Throw away any existing cert and mint a fresh self-signed one for `ips`. */
export async function regenerateCert(ips = ["127.0.0.1", "::1"]) {
  const altNames = [{ type: 2, value: "localhost" }];
  for (const ip of ips) altNames.push({ type: 7, ip });
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "awaykit" }],
    { days: 825, keySize: 2048, algorithm: "sha256", extensions: [{ name: "subjectAltName", altNames }] },
  );
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(KEY_PATH, pems.private, { mode: 0o600 });
  writeFileSync(CERT_PATH, pems.cert, { mode: 0o644 });
  return { key: pems.private, cert: pems.cert, fingerprint: fingerprintOf(pems.cert), reused: false };
}

export function certPaths() { return { cert: CERT_PATH, key: KEY_PATH }; }

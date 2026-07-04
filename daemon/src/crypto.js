/**
 * awaykit crypto — v0.1 pairing + channel encryption.
 *
 * One shared 32-byte key K is created on first run and persisted to
 * ~/.awaykit/key. Pairing delivers K to the phone inside the QR code's URL
 * *fragment* (after '#') — fragments are never sent to the server, so K is not
 * transmitted over the (plain-HTTP) network during pairing.
 *
 * Every app message on the wire is sealed with NaCl secretbox
 * (XSalsa20-Poly1305) under K, so a passive Wi-Fi sniffer sees only ciphertext,
 * and a device without K can neither read events nor forge an approval.
 *
 * The same primitives run in the browser via the vendored tweetnacl
 * (public/vendor/nacl.min.js), so daemon and phone speak an identical format.
 */

import nacl from "tweetnacl";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.AWAYKIT_HOME || join(homedir(), ".awaykit");
const KEY_PATH = join(CONFIG_DIR, "key");

const NONCE_LEN = nacl.secretbox.nonceLength; // 24
const KEY_LEN = nacl.secretbox.keyLength;     // 32
const SESSION_PURPOSE = "awaykit-session";

// ---- base64url --------------------------------------------------------------

export function b64urlEncode(bytes) {
  return Buffer.from(bytes).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(str) {
  return new Uint8Array(Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

// ---- key management ---------------------------------------------------------

/** Load the persisted pairing key, or create + persist a new one. */
export function loadOrCreateKey() {
  if (existsSync(KEY_PATH)) {
    try {
      const key = b64urlDecode(readFileSync(KEY_PATH, "utf8").trim());
      if (key.length === KEY_LEN) return key;
    } catch { /* fall through and regenerate */ }
  }
  return regenerateKey();
}

/** Throw away any existing key and mint a fresh one (re-pair everything). */
export function regenerateKey() {
  const key = nacl.randomBytes(KEY_LEN);
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(KEY_PATH, b64urlEncode(key), { mode: 0o600 });
  try { chmodSync(KEY_PATH, 0o600); } catch { /* best effort on Windows */ }
  return key;
}

export function keyPath() { return KEY_PATH; }
export function forgetKey() { try { rmSync(KEY_PATH); } catch {} }

// ---- authenticated encryption ----------------------------------------------

/** Seal a JSON-able value under `key`; returns base64url(nonce || ciphertext). */
export function seal(key, obj) {
  const nonce = nacl.randomBytes(NONCE_LEN);
  const msg = new TextEncoder().encode(JSON.stringify(obj));
  const box = nacl.secretbox(msg, nonce, key);
  const out = new Uint8Array(NONCE_LEN + box.length);
  out.set(nonce, 0);
  out.set(box, NONCE_LEN);
  return b64urlEncode(out);
}

/** Open a sealed blob; returns the parsed value, or null if auth/parse fails. */
export function open(key, sealed) {
  try {
    const data = b64urlDecode(sealed);
    if (data.length <= NONCE_LEN) return null;
    const nonce = data.slice(0, NONCE_LEN);
    const box = data.slice(NONCE_LEN);
    const msg = nacl.secretbox.open(box, nonce, key);
    if (!msg) return null;
    return JSON.parse(new TextDecoder().decode(msg));
  } catch {
    return null;
  }
}

// ---- pairing proof ----------------------------------------------------------

/** What the phone seals to prove it holds K when opening a session. */
export function makeProof(key) {
  return seal(key, { p: SESSION_PURPOSE, t: Date.now() });
}

/** Verify a session proof: decrypts under K and is time-fresh. */
export function verifyProof(key, sealed, maxAgeMs = 120_000) {
  const obj = open(key, sealed);
  if (!obj || obj.p !== SESSION_PURPOSE || typeof obj.t !== "number") return false;
  const age = Date.now() - obj.t;
  return age >= -maxAgeMs && age <= maxAgeMs;
}

/**
 * awaykit push — Web Push wake-ups (v0.6).
 *
 * Lets the daemon buzz a paired phone even when the awaykit page is closed or
 * backgrounded — the missing piece for "step out and let it code".
 *
 * How it stays zero-knowledge:
 *  - The daemon owns a VAPID keypair (created on first run, stored in
 *    ~/.awaykit/vapid.json) and sends each push *directly outbound* to the
 *    browser's push endpoint (fcm/mozilla/apple). Behind NAT this just works —
 *    it's an outbound HTTPS POST, no inbound port.
 *  - The payload is encrypted per RFC 8291 (aes128gcm) to the subscription's own
 *    keys, so the push service — and any relay — only ever forward ciphertext.
 *    Only the device's service worker can read it.
 *
 * Subscriptions arrive over the already-encrypted phone⇄daemon channel and are
 * persisted to ~/.awaykit/push-subs.json. Push only works from a secure context
 * (HTTPS), so in practice this rides the relay / VPN-tunnel path.
 */

import webpush from "web-push";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = process.env.AWAYKIT_HOME || join(homedir(), ".awaykit");
const VAPID_PATH = join(CONFIG_DIR, "vapid.json");
const SUBS_PATH = join(CONFIG_DIR, "push-subs.json");
// VAPID requires a contact "subject" (mailto:/https:). It's sent to the push
// service, not to any awaykit server; a non-personal default keeps it private.
const SUBJECT = process.env.AWAYKIT_VAPID_SUBJECT || "mailto:awaykit@localhost";
const MAX_SUBS = 20;
const PUSH_TTL_SEC = 300; // a stale approval wake-up shouldn't linger for hours

let vapid = null;
let subs = []; // [{ endpoint, keys:{p256dh,auth}, ua, addedAt }]
let ready = false;

function ensureDir() { mkdirSync(CONFIG_DIR, { recursive: true }); }

function validSub(s) {
  return !!s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) &&
    s.keys && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string";
}

function persist() {
  try { ensureDir(); writeFileSync(SUBS_PATH, JSON.stringify(subs), { mode: 0o600 }); } catch { /* best effort */ }
}

/** Load or create VAPID keys + load persisted subscriptions. Idempotent. */
export function initPush() {
  if (existsSync(VAPID_PATH)) {
    try {
      const v = JSON.parse(readFileSync(VAPID_PATH, "utf8"));
      if (v && v.publicKey && v.privateKey) vapid = v;
    } catch { vapid = null; }
  }
  if (!vapid) {
    vapid = webpush.generateVAPIDKeys();
    ensureDir();
    writeFileSync(VAPID_PATH, JSON.stringify(vapid), { mode: 0o600 });
  }
  webpush.setVapidDetails(SUBJECT, vapid.publicKey, vapid.privateKey);

  if (existsSync(SUBS_PATH)) {
    try {
      const arr = JSON.parse(readFileSync(SUBS_PATH, "utf8"));
      if (Array.isArray(arr)) subs = arr.filter(validSub);
    } catch { subs = []; }
  }
  ready = true;
  return { publicKey: vapid.publicKey, subs: subs.length };
}

export function vapidPublicKey() { return vapid ? vapid.publicKey : ""; }
export function subCount() { return subs.length; }

/** Register (or refresh) a subscription. Deduped by endpoint. Returns true if valid. */
export function addSub(sub, ua = "") {
  if (!validSub(sub)) return false;
  const rec = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ua: String(ua || "").slice(0, 120),
    addedAt: Date.now(),
  };
  const i = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (i >= 0) subs[i] = rec; else subs.push(rec);
  if (subs.length > MAX_SUBS) subs = subs.slice(-MAX_SUBS); // keep newest
  persist();
  return true;
}

export function removeSub(endpoint) {
  const before = subs.length;
  subs = subs.filter((s) => s.endpoint !== endpoint);
  if (subs.length !== before) persist();
}

export function clearSubs() { subs = []; persist(); }

/**
 * Send a wake-up to every subscription. Payload is a small JSON object
 * ({ title, body, tag, url }) — encrypted end-to-end to each device's SW.
 * Dead subscriptions (404/410 Gone) are pruned automatically.
 * @returns {Promise<{sent:number, pruned:number}>}
 */
export async function sendPush(payload) {
  if (!ready || !subs.length) return { sent: 0, pruned: 0 };
  const body = JSON.stringify(payload);
  let sent = 0, pruned = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, { TTL: PUSH_TTL_SEC, urgency: "high" });
      sent++;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) { removeSub(s.endpoint); pruned++; }
    }
  }));
  return { sent, pruned };
}

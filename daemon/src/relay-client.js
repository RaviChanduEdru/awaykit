/**
 * awaykit relay client — the daemon's outbound link to a zero-knowledge relay.
 *
 * When AWAYKIT_RELAY is set, the daemon holds an outbound SSE connection to the
 * relay (no inbound ports, works behind any NAT) and speaks the exact same
 * sealed protocol as the local HTTP endpoints:
 *
 *   phone ──sealed proof (under K, + ephemeral pubkey)──▶ relay ──▶ here
 *   here  ──sealed {dpk} (under K)─────────────────────▶ relay ──▶ phone
 *   both sides derive the per-session key; everything after is sealed under it.
 *
 * Each remote phone becomes a client object with sendSealed(payload), so the
 * daemon's broadcast()/"connection is the switch" logic treats local and remote
 * phones identically. The relay itself never sees a key or a plaintext byte.
 *
 * No daemon imports here — state comes in via callbacks — so this module stays
 * independently testable and conflict-free.
 */

import { seal, open, openProof, newEphemeralKeyPair, deriveSessionKey, roomIdFromKey, b64urlEncode } from "./crypto.js";

const PING_STALE_MS = 90_000;  // drop a remote session not heard from in this long
const MAX_SESSIONS = 8;        // sanity cap on concurrent remote phones

/**
 * Start the relay link.
 * @param {object} opts
 * @param {string}   opts.relayURL          e.g. "https://relay.example.com"
 * @param {Uint8Array} opts.key             long-term pairing key K
 * @param {(c:object)=>void} opts.registerClient    add a phone to the daemon's client set
 * @param {(c:object)=>void} opts.unregisterClient  remove it
 * @param {(promptId:string, choice:string, note:string)=>void} opts.resolvePrompt
 * @param {()=>Array} opts.snapshot         current pending prompts (public shape)
 * @param {(msg:string)=>void} [opts.log]
 */
export function startRelayClient({ relayURL, key, registerClient, unregisterClient, resolvePrompt, snapshot, fullSnapshot = null, vapidKey = "", onPhoneMessage = () => {}, log = console.log }) {
  const base = relayURL.replace(/\/+$/, "");
  const room = roomIdFromKey(key);
  const sessions = new Set(); // { sk, lastSeen, sendSealed }
  let stopped = false;

  async function push(blob) {
    try {
      await fetch(`${base}/push`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room, to: "phone", blob }),
      });
    } catch { /* relay briefly unreachable — the pull loop's reconnect covers us */ }
  }

  function drop(client) {
    if (!sessions.has(client)) return;
    sessions.delete(client);
    unregisterClient(client);
  }

  async function onBlob(blob) {
    // 1) A pairing proof sealed under K? → new remote session (forward-secret).
    const claim = openProof(key, blob);
    if (claim && claim.epk) {
      const eph = newEphemeralKeyPair();
      const sk = deriveSessionKey(claim.epk, eph.secretKey);
      await push(seal(key, { dpk: b64urlEncode(eph.publicKey) })); // reply first, so the phone can decrypt what follows
      const client = { sk, lastSeen: Date.now(), sendSealed: (payload) => { push(seal(sk, payload)); } };
      sessions.add(client);
      registerClient(client);
      if (sessions.size > MAX_SESSIONS) {
        const oldest = [...sessions].sort((a, b) => a.lastSeen - b.lastSeen)[0];
        drop(oldest);
      }
      client.sendSealed(fullSnapshot ? fullSnapshot() : { type: "snapshot", pending: snapshot(), vapid: vapidKey });
      log(`[awaykit] remote phone connected via relay (${sessions.size} remote session${sessions.size === 1 ? "" : "s"})`);
      return;
    }

    // 2) Otherwise: a message from one of the live sessions, sealed under its key.
    for (const c of sessions) {
      const msg = open(c.sk, blob);
      if (!msg) continue;
      c.lastSeen = Date.now();
      if (msg.promptId && typeof msg.choice === "string") {
        resolvePrompt(msg.promptId, msg.choice, typeof msg.note === "string" ? msg.note : "");
      } else {
        onPhoneMessage(msg); // push-sub registration, etc. (ping just refreshed lastSeen)
      }
      return;
    }
    // Undecipherable: someone else's blob or a stale session — ignore silently.
  }

  // Expire remote sessions that stopped pinging (phone left / lost signal), so
  // "connection is the switch" stays truthful for remote phones too.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const c of [...sessions]) {
      if (now - c.lastSeen > PING_STALE_MS) {
        drop(c);
        log(`[awaykit] remote phone timed out (relay)`);
      }
    }
  }, 30_000);
  sweeper.unref?.();

  // The pull loop: one long-lived SSE subscription, reconnect with backoff.
  (async function pullLoop() {
    let backoff = 1000;
    let announced = false;
    while (!stopped) {
      try {
        const res = await fetch(`${base}/pull?room=${encodeURIComponent(room)}&as=daemon`, {
          headers: { accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`relay pull: HTTP ${res.status}`);
        if (!announced) { log(`[awaykit] relay connected: ${base} (zero-knowledge — remote access without VPN)`); announced = true; }
        backoff = 1000;
        let buf = "";
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString("utf8");
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (!block.startsWith("event: m")) continue;
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) await onBlob(line.slice(6));
          }
        }
        throw new Error("relay stream ended");
      } catch (err) {
        if (stopped) break;
        if (announced) { log(`[awaykit] relay disconnected (${(err && err.message) || err}) — retrying…`); announced = false; }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  })();

  return {
    room,
    stop() {
      stopped = true;
      clearInterval(sweeper);
      for (const c of [...sessions]) drop(c);
    },
  };
}

# awaykit relay — zero-knowledge ciphertext shuttle

Remote access **without a VPN** and **without opening any port on your laptop**:
the daemon connects *outbound* to this relay; your phone connects to it from
anywhere; the relay pairs them up and forwards **sealed blobs it cannot read**.

```
laptop daemon ──outbound SSE──▶ ┌────────┐ ◀──HTTPS── phone (anywhere)
    POST /push (ciphertext)     │ relay  │    POST /push (ciphertext)
                                └────────┘
```

## Zero-knowledge, by construction

- **Rooms** are identified by a purpose-tagged **hash of your pairing key `K`** —
  both devices derive it independently; the relay can't recover `K` from it.
- **Every payload is an opaque NaCl-sealed blob** (handshake under `K`, traffic
  under per-session ephemeral keys — same forward-secret protocol as LAN mode).
  The relay learns only timing, direction, and size.
- **No accounts, no disk state.** Restarting the relay loses nothing but
  briefly-queued messages (5-minute TTL, for phones that reconnect).

## Run it

```bash
node server.js            # listens on :4600 (PORT env to change)
```

Zero dependencies. Host it anywhere — a $3 VPS, a free-tier container, a
Raspberry Pi. **Put it behind HTTPS in production** (Caddy/nginx/a platform
that terminates TLS): the relay also serves the phone's app shell, and HTTPS
gives that shell integrity in transit.

Then on the laptop:

```bash
AWAYKIT_RELAY=https://your-relay.example.com npm start
```

The daemon's pairing QR now points at the relay — scan it from your phone
**anywhere**, and approvals flow end-to-end encrypted through it.

## Abuse resistance

Blobs are capped at 64 KB, queues at 200 messages/room, queued blobs expire in
5 minutes, idle rooms are forgotten in 15. Knowing a room id lets someone at
most enqueue garbage the devices will discard as undecipherable.

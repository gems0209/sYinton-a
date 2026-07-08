# sYntonia

Turn a group of smartphones into one distributed sound system: a **lead** device uploads tracks into a queue, the others join with a 4-char code (or the shared session URL) and every speaker plays them in tight sync — auto-advancing through the playlist with repeat and shuffle.

Node + Express + `ws` on the server, vanilla ES modules + Web Audio API on the client. No database, no build step, no frameworks. UI in Italian (EN switch in the header).

## Quickstart

```bash
npm install
npm start          # → http://localhost:3000 (or PORT env)
```

The server prints its **LAN address** on startup — open it on every phone on the same Wi-Fi. One phone taps **CREA SESSIONE** and uploads one or more audio files (MP3/WAV/OGG/M4A/FLAC, ≤60 MB each); the others type the code or open the shared URL. When all devices show READY, the lead presses PLAY. Two browser tabs on one machine work too. A `/debug` page shows clock offset, RTT, uncertainty, drift and output latency.

If a device sounds early/late (typical with Bluetooth), use its **calibration slider** — the lead can start the CLICK TRACK and you align by ear; the value persists per device.

## How the sync works

1. **Clock sync** — each client runs NTP-like ping bursts over WebSocket (20 at connect, 5 every 30 s): discard samples above median RTT, take the median offset, smooth updates exponentially. See `public/js/clocksync.js`.
2. **Scheduled playback** — on PLAY the server fixes a start instant 1.5 s in the future and broadcasts it; every client converts it into its own `AudioContext` timeline and calls `source.start(when, offset)`, compensating output latency and user calibration. Late joiners start mid-track from the same math. See `public/js/player.js`.
3. **Drift correction** — every 5 s the server broadcasts the authoritative position; clients re-seek with short crossfades when they drift beyond 15 ms (inaudible on music). The math is documented in the code comments.

## Queue

The lead manages an ordered queue (add anytime — even while playing — reorder,
remove, repeat off/all/one, shuffle); satellites see it read-only. Key design
points:

- **Server-authoritative track change.** Local `onended` is never trusted (each
  device would advance on its own clock). A 250 ms server ticker watches the
  authoritative position; when the current track enters its final
  `leadTime + 300 ms` window it resolves the next track (repeat/shuffle
  included) and broadcasts a `track-change` scheduled to start **exactly when
  the current track ends** — clients get ≥1.2 s of notice and the transition is
  gapless (the outgoing source is cut at the handover instant, not before).
- **Prefetch, not preload.** Decoded AudioBuffers are heavy (~10 MB/min), so
  each client keeps at most the **current and next** track in memory (the
  server tells it which via `prefetch` in every `queue-update`) and frees the
  rest. If some client hasn't decoded the next track at the handover, the
  server holds (synchronized "buffering") and starts 1.5 s after readiness — or
  after 8 s with whoever is ready.
- **Stable shuffle.** Turning shuffle on generates one permutation (current
  track untouched); "next" follows it until shuffle is turned off. Repeat-one
  repeats on auto-advance; a manual skip still moves on.
- The playing track is referenced **by id, not index**: removing or reordering
  rows can never shift playback. Removing the playing track skips to its
  successor (or stops at the end of the queue with repeat off).

## WebSocket protocol

All session messages carry `sessionCode`; transport messages from satellites are ignored; malformed JSON never crashes the server.

| Type | Dir | Payload |
|---|---|---|
| `create` / `created` | C→S / S→C | `clientId` ⇄ `sessionCode` |
| `join` / `joined` | C→S / S→C | code+id ⇄ role, track, playback snapshot, peers |
| `error` | S→C | `code`, `text` |
| `peer-update` | S→C | count + `{id, role, ready, connected}` list |
| `queue-update` | S→C | full queue + `currentTrackId`, `nextTrackId`, `repeatMode`, `shuffle`, `order`, `prefetch` |
| `track-change` | S→C | `trackId`, `startAtServerTime`, `trackOffset` (play, seek, skip, auto-advance) |
| `client-ready` | C→S | `trackId` + decoded `duration` (per prefetched track) |
| `play` / `pause` / `stop` / `seek` | C→S | lead transport (server re-emits `track-change` / `pause` / `stop`) |
| `skip-next` / `skip-prev` | C→S | prev restarts the track when >3 s in |
| `queue-remove` / `queue-reorder` | C→S | `trackId` / `from`,`to` |
| `set-repeat` / `set-shuffle` | C→S | `mode: off\|all\|one` / `on: bool` |
| `click-start` / `click-stop` | C→S | calibration click track |
| `position-heartbeat` | S→C | `serverTime`, `trackPosition` (5 s) |
| `position-request` | C→S | immediate heartbeat (after foregrounding) |
| `timesync` | C↔S | `t0` ⇄ `t0`, `tServer` |
| `session-ended` / `leave` | S→C / C→S | — |

## Known limits

- **Bluetooth speakers** add 100–300 ms the API cannot see — that's what the calibration slider is for.
- **Speed of sound**: ~3 ms per metre between phones is physics, not fixable in software.
- iOS Safari suspends audio in background tabs — keep the screen on (Wake Lock is requested when available).
- State is in-memory and uploads live on local disk: single instance only, sessions die on restart.

## Deploy (Render)

GitHub Pages can't host this (it needs a Node server with WebSocket). `render.yaml` is included; the server honours `process.env.PORT` and the client builds its WS URL from `window.location` (`wss:` under HTTPS automatically).

1. Push this repo to GitHub.
2. On [render.com](https://render.com): **New → Web Service → Connect repository** and pick this repo — Render reads `render.yaml` (or set Build `npm install`, Start `npm start` manually).
3. Choose the **Free** plan and deploy; the app is live at `https://<name>.onrender.com`.
4. Note: the free tier sleeps after ~15 min idle — the first visit after that takes ~30–60 s to wake.

## License

MIT — see [LICENSE](LICENSE).

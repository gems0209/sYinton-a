# sYntonia

Turn a group of smartphones into one distributed sound system: a **lead** device uploads a track, the others join with a 4-char code and every speaker plays it in tight sync.

Node + Express + `ws` on the server, vanilla ES modules + Web Audio API on the client. No database, no build step, no frameworks. UI in Italian (EN switch in the header).

## Quickstart

```bash
npm install
npm start          # → http://localhost:3000 (or PORT env)
```

The server prints its **LAN address** on startup — open it on every phone on the same Wi-Fi. One phone taps **CREA SESSIONE** and uploads an audio file (MP3/WAV/OGG/M4A/FLAC, ≤60 MB); the others type the code. When all devices show READY, the lead presses PLAY. Two browser tabs on one machine work too. A `/debug` page shows clock offset, RTT, uncertainty, drift and output latency.

If a device sounds early/late (typical with Bluetooth), use its **calibration slider** — the lead can start the CLICK TRACK and you align by ear; the value persists per device.

## How the sync works

1. **Clock sync** — each client runs NTP-like ping bursts over WebSocket (20 at connect, 5 every 30 s): discard samples above median RTT, take the median offset, smooth updates exponentially. See `public/js/clocksync.js`.
2. **Scheduled playback** — on PLAY the server fixes a start instant 1.5 s in the future and broadcasts it; every client converts it into its own `AudioContext` timeline and calls `source.start(when, offset)`, compensating output latency and user calibration. Late joiners start mid-track from the same math. See `public/js/player.js`.
3. **Drift correction** — every 5 s the server broadcasts the authoritative position; clients re-seek with short crossfades when they drift beyond 15 ms (inaudible on music). The math is documented in the code comments.

## WebSocket protocol

All session messages carry `sessionCode`; transport messages from satellites are ignored; malformed JSON never crashes the server.

| Type | Dir | Payload |
|---|---|---|
| `create` / `created` | C→S / S→C | `clientId` ⇄ `sessionCode` |
| `join` / `joined` | C→S / S→C | code+id ⇄ role, track, playback snapshot, peers |
| `error` | S→C | `code`, `text` |
| `peer-update` | S→C | count + `{id, role, ready, connected}` list |
| `track-loaded` | S→C | `trackName`, `url` |
| `client-ready` | C→S | decoded `duration` |
| `play` / `pause` / `stop` / `seek` | C→S, S→C | `startAtServerTime`+`trackOffset` / authoritative `position` |
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

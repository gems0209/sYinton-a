# sYntonia

Turn a group of smartphones into one distributed sound system: a **lead** device uploads tracks into a queue, the others join with a 4-char code (or the shared session URL) and every speaker plays them in tight sync — auto-advancing through the playlist with repeat, shuffle and DJ-style **MIX MODE** transitions (BPM analysis, beatmatched crossfades, live EQ/filter/tempo), plus a manual **DUAL DECK** mode (two simultaneous timelines, crossfader, per-deck pitch and one-tap **SYNC & PLAY** beatmatch). On top of the music sits a **participatory layer**: a synchronized **light show** that turns every screen into one light in time with the beat, and a **jukebox** where the crowd proposes tracks and the lead approves them into the queue. Every section in the lead view carries an inline **?** explainer, and tapping any queue row plays that track.

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
- **Tap a row to play it** (`queue-jump`, lead only). Like a manual skip, it
  honours the active transition (a hard cut in CUT mode, otherwise the fade /
  beatmatch starts now); tapping the live track is a no-op. In DECKS mode a row
  loads a deck instead, so the tap-to-jump is disabled there.

## MIX MODE (lead-only DJ tools)

A collapsible **MIX** panel in the lead view, inspired by djay's Automix and
rekordbox's BPM readout, kept inside the app's core contract: **everything
audible is a server-scheduled event** rendered identically by every device.
Controls needing zero latency (scratching, jog wheels, headphone cueing) are
deliberately out of scope. The whole module (`public/js/dj.js`) is loaded with
a dynamic import **on the lead only** — satellites never download it, they just
render the effects that arrive over the protocol.

- **Track analysis.** After upload the lead decodes each track in the
  background and estimates **BPM** (low-passed onset envelope →
  autocorrelation with harmonic support → fine comb search with joint phase
  estimation, 70–180 BPM), the **beat phase**, a waveform overview and a
  loudness-normalization suggestion. No libraries, chunked on the main thread.
  Results go to the server as `track-meta`: the queue shows BPM per track and
  reconnecting clients get them back. Low-confidence results are marked (`~`)
  and excluded from beatmatching.
- **Deck.** Waveform of the current track with the beat grid overlaid,
  brighter played portion, tap-to-seek, and **4 hot cues** per track (tap =
  set/jump, hold = clear; stored server-side for the session).
- **Transitions** between queue tracks: `CUT` (default, the classic gapless
  handover), `2S/4S/8S` equal-power crossfades, or `BEAT`. Auto-advance places
  the incoming start **fade seconds before the outgoing end**; a manual skip
  starts the same transition immediately, djay-style. **Beatmatch**: if both
  BPMs are confident and within ±8 % after octave folding, the incoming track
  starts **on its first beat, snapped onto the outgoing beat grid, at the
  outgoing tempo** (with a low-shelf EQ swap during the overlap), then glides
  back to the master tempo over 4 s. Anything less certain degrades to a plain
  4 s crossfade.
- **Live controls**, all applied ~0.3 s in the future at a server-fixed
  instant so every speaker changes together (declared in the UI): 3-band EQ
  with per-band **KILL**, a bipolar one-knob **filter** (LP ← center → HP),
  and **master tempo ±8 %** (timeline re-anchored server-side, clients glide
  `playbackRate` — no restart).
- **Sync math.** The playback rate is part of the server's authoritative
  state; position is the exact integral of the (piecewise linear) rate, on
  both server and clients. Drift correction pauses during rate glides and
  resumes on the next constant-rate heartbeat.

## DUAL DECK (lead-only, in the MIX panel)

Virtual-DJ-style manual mixing under the same sync contract: **two independent
server timelines (deck A and deck B), both playing at once on every device**,
mixed by an equal-power crossfader. DECKS is a mode: while it's on, the queue
transport and auto-advance are suspended (the queue itself is untouched and
resumes, stopped, when you switch back). The automix transition engine is not
involved at all.

- **Load from the queue.** In DECKS mode every queue row grows `A`/`B`
  buttons; a deck can be (re)loaded any time it isn't playing. Removing the
  row unloads the deck. Both deck tracks join the prefetch set, so every
  client keeps them decoded; per-deck PLAY is gated on readiness like the
  queue's PLAY. Entering DECKS while the queue plays **adopts** the playing
  track as deck A with the exact same timeline — zero glitch, since clients
  already render the queue on channel A.
- **Per-deck controls**: PLAY/PAUSE, tap-to-seek on the strip waveform, the
  track's 4 hot cues, **pitch −50…+50 %** (a real DJ range, wider than the ±8 %
  master-tempo trim; server re-anchors, clients glide `playbackRate` — no
  restart) and **SYNC**: the server sets this deck's rate so the effective BPMs
  match and phase-aligns the beat grids with a nearest-beat micro-seek (≤ half a
  beat, rendered as a 60 ms crossfade). The ratio is folded to the **nearest
  octave** (minimal pitch shift, ≤ ±√2), so two arbitrary songs lock instead of
  being refused for being more than 8 % apart.
- **SYNC & PLAY** (`deck-beatmatch`): one tap does the whole beatmatch — picks
  a master (a deck already playing, else A), matches the other deck's BPM,
  phase-locks it, **starts whatever isn't playing** and centres the crossfader
  so both are audible. A stopped follower is brought in fresh on the master's
  beat from its own downbeat; a playing one is micro-seeked into phase. It's the
  "put both at the same BPM and play them together" button; the per-deck SYNC
  above stays for hands-on control. Works on **any two tracks** (nearest-octave
  fold keeps the pitch shift small); it only ever declines when a BPM is still
  analysing or genuinely unreadable, and says exactly which in the user's
  language.
- **Crossfader**: −1 = only A, +1 = only B, cos/sin equal-power law, streamed
  like the fx (throttled, applied everywhere at a server-fixed instant ~0.3 s
  ahead; double-tap recenters). The global EQ/filter sits after the mix and
  stays live; the calibration click is refused in DECKS mode (calibrate in
  queue mode).
- **One reconciler.** Every deck mutation is answered with a single
  `decks-update` snapshot (plus a `glide` hint for pitch-only changes);
  clients reconcile their two channels against it — the same code path serves
  live updates, late join and self-heal. Heartbeats carry both timelines and
  drift is corrected per channel.

## Light show (every device)

The lead picks a **look**; every screen — lead and satellites — becomes one
light, and they pulse **together** because the timing is a purely *local*
function of the already-synchronized playback timeline. The server never
streams "flash" events: it only broadcasts the look (`lightshow-update`). Each
client computes the beat locally from the current track's grid (or the
analyser level), so the pulses land on the beat on every phone within the same
tolerance as the audio itself, at zero extra protocol cost. Rendering is a
single full-screen element whose colour is rewritten each frame — no canvas,
no per-pixel work — so phones stay cool.

- **Sources.** `beat` (the playing track's BPM grid — follows tempo and rate
  glides automatically), `level` (the shared analyser's RMS — works with no
  BPM and in DECKS mode), or `auto` (beat when a confident grid exists, else
  level).
- **Patterns.** `pulse` (all together), `colorbeat` (hue steps each beat),
  `wave` (a colour sweep phased across devices by their join index), `breathe`
  (ambient, no beat needed) and a gated `strobe`.
- **Palette / intensity / base glow**, and a beat division (bar · beat · ½ · ¼).
- **Safety.** The flash rate is capped (kept beat-aligned) so full-screen
  flashing never exceeds ~3 Hz; `prefers-reduced-motion` softens it; a strobe
  warning shows on first use. Satellites run full-screen and can **tap to
  reveal a local EXIT** (it only affects that device); the lead keeps its
  controls and watches a small preview swatch. A fresh OFF→ON re-includes
  anyone who exited.

## Jukebox (crowd requests, the lead curates)

Zero audio-path changes — only protocol + UI. The lead **opens requests**;
satellites then **propose a track** (an upload parked in a separate pool, not
the queue) with an optional note and nickname, and everyone **upvotes**. The
lead sees the list ranked by votes and **approves** a proposal into the queue
(at the end, or **next**) or **dismisses** it (which deletes the file).

- **Proposing** reuses the normal upload path with a `proposal` flag; it is
  gated on an open jukebox and on quotas (**3 pending per device**, **20
  total**). Approving turns the file into a first-class queue track — the
  lead's BPM analysis picks it up like any other.
- **Attribution.** Every device carries a stable join-order `deviceIndex` (used
  by the light show's spatial patterns) and an optional **nickname**; proposer
  names resolve live, so changing your nickname updates your requests.
- **One reconciler.** Every change (open/close, propose, vote, approve,
  dismiss) is answered with a single `jukebox-update` snapshot; late joiners
  get the pool (and the light-show look) in their `joined` message.

## Multi-zone (optional spatial mode)

Turn the phones into a real rig: the lead assigns each device a **zone** that
shapes only *its own output* — a stereo **channel** (full / left / right), a
frequency **band** (full / low / mid / high) and a gain trim. Put the phones on
the left on the L channel and the right ones on R, or dedicate a group to the
bass and another to the highs. Only makes sense because the app is distributed.

It's an **optional mode, off by default**: with multi-zone off every device
outputs full-range, centred, unity gain — bit-identical to normal playback. And
it's **orthogonal** — it layers under the queue, MIX and DUAL DECK without
touching the sync timeline (a zone is a per-device output stage, not a scheduled
event, so it's applied locally with a short anti-click ramp — no `applyAt`).

- **The output stage.** After the mix bus the signal fans out to a pure
  analyser **tap** (so every device's WaveField + light-show level still see the
  full mix) and to the zone stage: a channel selector (`ChannelSplitter` + three
  gains — on a mono phone speaker "left" means "emit the track's LEFT channel",
  so a room of phones splits the stereo image in space), an HP+LP band pair, and
  a gain trim, then the master volume. The calibration click sits after the zone
  so it stays full-range and volume-controlled on any band assignment.
- **Assigning.** The lead's device list grows per-device controls (channel /
  band / gain) plus **STEREO** (auto L/R by join index) and **RESET** presets.
  Satellites just show a read-only badge of their zone. Assignments persist
  across an off/on toggle and ride the `joined` snapshot for late joiners; a
  gone device's zone is pruned.

## WebSocket protocol

All session messages carry `sessionCode`; transport messages from satellites are ignored; malformed JSON never crashes the server.

| Type | Dir | Payload |
|---|---|---|
| `create` / `created` | C→S / S→C | `clientId` ⇄ `sessionCode` |
| `join` / `joined` | C→S / S→C | code+id ⇄ role, `deviceIndex`, snapshots (queue, playback, peers, `lightshow`, `jukebox`, `multizone`) |
| `error` | S→C | `code`, `text` |
| `peer-update` | S→C | count + `{id, role, deviceIndex, name, ready, connected}` list |
| `queue-update` | S→C | full queue (with `meta`, `cues`) + `currentTrackId`, `nextTrackId`, `repeatMode`, `shuffle`, `order`, `prefetch`, `transitionMode`, `tempo`, `fx` |
| `track-change` | S→C | `trackId`, `startAtServerTime`, `trackOffset`, `rate`, `rateRamp`, `transition` (play, seek, skip, auto-advance) |
| `client-ready` | C→S | `trackId` + decoded `duration` (per prefetched track) |
| `play` / `pause` / `stop` / `seek` | C→S | lead transport (server re-emits `track-change` / `pause` / `stop`) |
| `skip-next` / `skip-prev` | C→S | prev restarts the track when >3 s in |
| `queue-jump` | C→S | tap a row to play `trackId` now (honours the transition; no-op on the live track) |
| `queue-remove` / `queue-reorder` | C→S | `trackId` / `from`,`to` |
| `set-repeat` / `set-shuffle` | C→S | `mode: off\|all\|one` / `on: bool` |
| `track-meta` | C→S | lead analysis: `trackId`, `bpm`, `confidence`, `beatPhase`, `gainDb` |
| `set-transition` | C→S | `mode: cut\|fade2\|fade4\|fade8\|beatmatch` |
| `set-tempo` / `rate-change` | C→S / S→C | `tempo` ⇄ `rate`, `trackOffset`, `applyAtServerTime` |
| `fx-set` / `fx-update` | C→S / S→C | EQ dB + kills + `filter` ⇄ same + `applyAtServerTime` |
| `cue-set` | C→S | `trackId`, `slot` 0-3, `position` (null clears) |
| `decks-mode` | C→S | `on: bool` (on adopts a playing queue track as deck A) |
| `deck-load` / `deck-play` / `deck-pause` / `deck-seek` | C→S | `deck: A\|B` + `trackId` / `position` / `force` |
| `deck-rate` / `deck-sync` | C→S | per-deck pitch 0.5–1.5 / BPM+phase match onto the other deck (nearest-octave fold) |
| `deck-beatmatch` | C→S | one-tap: match BPM, phase-lock, start both decks, centre the crossfader |
| `xfader` / `xfader-update` | C→S / S→C | `x: −1..1` ⇄ same + `applyAtServerTime` |
| `decks-update` | S→C | full decks snapshot (+ `glide` hint on pitch-only changes) |
| `set-nickname` | C→S | optional display name (any role), sanitized + capped |
| `lightshow-set` / `lightshow-update` | C→S / S→C | lead sets `{on, pattern, palette, source, beatDiv, intensity, floor}` ⇄ same to all |
| `jukebox-set` | C→S | lead opens/closes the request pool (`open`) |
| *(propose)* | C→S | HTTP `POST /upload/:code` with `proposal=1`, `clientId`, `note` |
| `vote-proposal` | C→S | toggle this device's vote on `proposalId` (any role) |
| `approve-proposal` / `dismiss-proposal` | C→S | lead: `proposalId` (+ `mode: end\|next`) → queue / delete |
| `jukebox-update` | S→C | `{open, proposals:[{id, name, note, byName, votes, voterIds}]}` |
| `multizone-set` | C→S | lead toggles the spatial mode (`on`) |
| `zone-assign` | C→S | lead: `clientId` + `{channel, band, gain}` (neutral clears it) |
| `multizone-update` | S→C | `{on, zones:{clientId → {channel, band, gain}}}` |
| `click-start` / `click-stop` | C→S | calibration click track (refused in DECKS mode) |
| `position-heartbeat` | S→C | `serverTime`, `trackPosition`, `rate`, `rampActive`, `decks{A,B}` (5 s) |
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

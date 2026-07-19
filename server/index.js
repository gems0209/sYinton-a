'use strict';
// sYntonia server — Express (static + upload) + ws (session protocol + clock sync).
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const S = require('./sessions');
const { now, handleTimesync } = require('./timesync');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const MAX_UPLOAD = 60 * 1024 * 1024; // 60 MB per file

fs.mkdirSync(S.UPLOAD_ROOT, { recursive: true });
// Orphaned files/dirs from a previous run (state is in-memory, all stale).
for (const f of fs.readdirSync(S.UPLOAD_ROOT)) {
  if (!f.startsWith('.')) fs.rm(path.join(S.UPLOAD_ROOT, f), { recursive: true, force: true }, () => {}); // keep .gitkeep
}

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
// /debug is a client-side view of the same SPA.
app.get('/debug', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
// Shareable session URLs (/5CEG): same SPA, the client auto-joins as satellite.
app.get('/:code([A-Za-z0-9]{4})', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------------------------------------------------------------- upload ----
const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const session = S.get((req.params.sessionCode || '').toUpperCase());
      if (!session) return cb(new Error('SESSION NOT FOUND'));
      const dir = S.uploadDir(session);
      fs.mkdir(dir, { recursive: true }, (err) => cb(err, dir));
    },
    filename: (_req, file, cb) => {
      const id = crypto.randomBytes(6).toString('hex');
      cb(null, id + path.extname(file.originalname || '').toLowerCase());
    },
  }),
  limits: { fileSize: MAX_UPLOAD },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    cb(null, ALLOWED_EXT.has(ext));
  },
});

// Magic-byte sniffing — extensions lie, headers don't.
function sniffAudio(buf) {
  if (buf.length < 12) return null;
  const ascii = (o, n) => buf.toString('ascii', o, o + n);
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3'; // raw MPEG frame sync
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(4, 4) === 'ftyp') return 'm4a'; // ISO-BMFF container
  return null;
}

// One file per request; the client loops for multi-select. Each valid file is
// APPENDED to the queue — adding never interrupts playback.
app.post('/upload/:sessionCode', upload.single('audio'), (req, res) => {
  const session = S.get((req.params.sessionCode || '').toUpperCase());
  const file = req.file;
  if (!session) {
    if (file) fs.unlink(file.path, () => {});
    return res.status(404).json({ error: 'SESSION NOT FOUND' });
  }
  if (!file) return res.status(400).json({ error: 'BAD FILE TYPE' });

  const head = Buffer.alloc(12);
  try {
    const fd = fs.openSync(file.path, 'r');
    fs.readSync(fd, head, 0, 12, 0);
    fs.closeSync(fd);
  } catch {
    fs.unlink(file.path, () => {});
    return res.status(500).json({ error: 'READ FAILED' });
  }
  if (!sniffAudio(head)) {
    fs.unlink(file.path, () => {});
    return res.status(400).json({ error: 'NOT AN AUDIO FILE' });
  }

  const track = {
    id: path.basename(file.path, path.extname(file.path)),
    filePath: file.path,
    originalName: file.originalname,
    size: file.size,
    duration: null, // clients report it after decoding
    meta: null,     // {bpm, confidence, beatPhase, gainDb} — reported by the lead's analysis
    cues: [null, null, null, null], // hot cue positions (seconds)
    addedAt: Date.now(),
  };
  session.queue.push(track);
  if (session.shuffle) {
    // Insert the new id at a random spot in the not-yet-played tail of the
    // permutation so shuffle stays "fair" without re-rolling the whole order.
    const order = session.shuffleOrder;
    const cur = order.indexOf(session.currentTrackId);
    const from = cur + 1;
    const at = from + Math.floor(Math.random() * (order.length - from + 1));
    order.splice(at, 0, track.id);
  }
  S.touch(session);
  S.broadcastQueue(session);
  S.broadcastPeers(session); // gate track may have changed from null
  res.json({ ok: true, trackId: track.id, trackName: track.originalName });
});

// Multer errors (file too large etc.) must not crash the server.
app.use((err, _req, res, _next) => {
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message || 'UPLOAD ERROR' });
});

app.get('/audio/:sessionCode/:trackId', (req, res) => {
  const session = S.get((req.params.sessionCode || '').toUpperCase());
  const track = session && S.getTrack(session, req.params.trackId);
  if (!track) return res.status(404).end();
  res.sendFile(track.filePath); // express handles Range requests
});

// ------------------------------------------------------------- websocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}
function sendError(ws, code, text) {
  send(ws, { type: 'error', code, text });
}

// Scheduled start of a track: fix an instant far enough in the future that
// every client can schedule the exact same sample. Options:
//   from       start position in the track (s)
//   leadMs     schedule this far ahead (default 1.5 s) — ignored if startAt set
//   startAt    absolute server time of the start (transitions compute this)
//   click      calibration click track (queue untouched)
//   rate       playback rate of the new track (default: session master tempo)
//   ramp       {to, startAt, dur} — rate glide after a beatmatch overlap
//   transition {type:'fade'|'beatmatch', dur} — how the OUTGOING source exits:
//              clients overlap it for `dur` seconds with an equal-power fade
//              (beatmatch adds an EQ swap) instead of cutting it at the handover.
function startTrack(session, trackId, opts = {}) {
  const {
    from = 0, leadMs = S.PLAY_LEAD_TIME_MS, startAt = null,
    click = false, rate = null, ramp = null, transition = null,
  } = opts;
  session.currentTrackId = click ? session.currentTrackId : trackId;
  session.advanceWaitSince = null;
  session.playback = {
    status: 'playing',
    trackOffset: from,
    startAtServerTime: startAt !== null ? startAt : now() + leadMs,
    pausedPosition: 0,
    click,
    rate: click ? 1 : (rate !== null ? rate : session.tempo),
    rateRamp: click ? null : ramp,
  };
  S.broadcast(session, {
    type: 'track-change',
    trackId: click ? null : trackId,
    startAtServerTime: session.playback.startAtServerTime,
    trackOffset: from,
    click,
    rate: session.playback.rate,
    rateRamp: session.playback.rateRamp,
    transition,
  });
  if (!click) {
    S.broadcastQueue(session); // current/next moved
    S.broadcastPeers(session); // ready is relative to the (new) gate track
  }
}

// ---------------------------------------------------------- transitions ----
// Decide how the next track enters, honoring the session transition mode and
// degrading gracefully: beatmatch needs confident BPM on both sides, a ratio
// within ±8% after octave folding, and no rate glide already in progress —
// anything else becomes a plain 4 s crossfade.
function planTransitionType(session, outTrack, nextTrack) {
  const mode = session.transitionMode;
  if (mode !== 'beatmatch') {
    const fade = S.TRANSITION_FADE_S[mode] || 0;
    return { type: fade > 0 ? 'fade' : 'cut', fade };
  }
  const mOut = outTrack && outTrack.meta;
  const mIn = nextTrack && nextTrack.meta;
  if (!mOut || !mIn || !mOut.bpm || !mIn.bpm
    || mOut.confidence < 0.2 || mIn.confidence < 0.2 || session.playback.rateRamp) {
    return { type: 'fade', fade: 4 };
  }
  let ratio = mOut.bpm / mIn.bpm;
  while (ratio > 1.5) ratio /= 2;      // 140 vs 70: treat as half/double time
  while (ratio < 1 / 1.5) ratio *= 2;
  if (Math.abs(ratio - 1) > S.BEATMATCH_MAX_DEV) return { type: 'fade', fade: 4 };
  const rateOut = S.currentRate(session);
  // 16 beats of the outgoing track (wall clock), clamped to a sane 4–10 s.
  const fade = Math.min(10, Math.max(4, (16 * 60 / mOut.bpm) / rateOut));
  return {
    type: 'beatmatch', fade, ratio,
    bpmOut: mOut.bpm, phaseOut: mOut.beatPhase || 0, phaseIn: mIn.beatPhase || 0,
  };
}

// Start `nextId` OVER the tail of the current track. Auto (queue advance): the
// incoming start is placed fade seconds before the outgoing track's end, so the
// crossfade finishes exactly as the old track runs out. Manual (skip): the fade
// starts ~1.5 s from now, djay-style. Beatmatch also (a) snaps the start onto
// the outgoing beat grid, (b) starts the incoming track ON its first detected
// beat at a rate that matches the outgoing tempo, and (c) glides that rate back
// to the master tempo once the overlap is done.
function startTransition(session, nextId, { manual = false } = {}) {
  const outTrack = S.currentTrack(session);
  const nextTrack = S.getTrack(session, nextId);
  const rateOut = S.currentRate(session);
  const plan = planTransitionType(session, outTrack, nextTrack);
  const tEnd = outTrack && outTrack.duration
    ? now() + Math.max(0, (outTrack.duration - S.position(session)) / rateOut) * 1000
    : null;

  let startAt;
  if (manual || tEnd === null) {
    startAt = now() + S.PLAY_LEAD_TIME_MS;
  } else {
    startAt = tEnd - plan.fade * 1000;
    const minAt = now() + 250;
    if (startAt < minAt) startAt = minAt; // triggered late: shrink the overlap
  }

  if (plan.type === 'beatmatch') {
    const beatLen = 60 / plan.bpmOut;
    const posC = S.positionAt(session, startAt);
    let k = Math.ceil((posC - plan.phaseOut) / beatLen - 1e-6);
    let posBeat = plan.phaseOut + k * beatLen;
    if (outTrack.duration && posBeat > outTrack.duration - 0.05 && k > 0) posBeat -= beatLen;
    if (posBeat > posC) startAt += ((posBeat - posC) / rateOut) * 1000;
    let from = plan.phaseIn;
    if (nextTrack && nextTrack.duration && from >= nextTrack.duration) from = 0;
    const rate = rateOut * plan.ratio;
    const dur = manual || tEnd === null
      ? plan.fade
      : Math.max(0.5, (tEnd - startAt) / 1000);
    const ramp = Math.abs(rate - session.tempo) > 0.0005
      ? { to: session.tempo, startAt: startAt + dur * 1000, dur: S.BEATMATCH_RAMP_MS }
      : null;
    startTrack(session, nextId, { from, startAt, rate, ramp, transition: { type: 'beatmatch', dur } });
    return;
  }

  const dur = manual || tEnd === null ? plan.fade : Math.max(0, (tEnd - startAt) / 1000);
  startTrack(session, nextId, {
    startAt,
    transition: plan.type === 'fade' && dur > 0.05 ? { type: 'fade', dur } : null,
  });
}

function stopPlayback(session, ended = false) {
  session.playback = {
    status: 'idle', trackOffset: 0, startAtServerTime: 0, pausedPosition: 0, click: false,
    rate: 1, rateRamp: null,
  };
  session.advanceWaitSince = null;
  S.broadcast(session, { type: 'stop', ended });
}

function allConnectedReadyFor(session, trackId) {
  for (const c of session.clients.values()) {
    if (c.connected && !c.readyFor.has(trackId)) return false;
  }
  return true;
}

function attachClient(session, clientId, role, ws) {
  const existing = session.clients.get(clientId);
  if (existing) {
    // Reconnect within grace: same slot, same role → late join handles resync.
    clearTimeout(existing.removeTimer);
    existing.ws = ws;
    existing.connected = true;
    existing.disconnectedAt = null;
    return existing;
  }
  const client = {
    id: clientId, role, ws, readyFor: new Set(), connected: true, disconnectedAt: null, removeTimer: null,
  };
  session.clients.set(clientId, client);
  return client;
}

function handleDisconnect(ws) {
  const { sessionCode, clientId } = ws.meta || {};
  if (!sessionCode || !clientId) return;
  const session = S.get(sessionCode);
  if (!session) return;
  const client = session.clients.get(clientId);
  if (!client || client.ws !== ws) return; // a newer socket already took over

  client.connected = false;
  client.disconnectedAt = Date.now();

  if (clientId === session.leadId) {
    // Orphaned session: playback AND queue auto-advance keep going (the server
    // is the authority); only the controls are missing. 60 s to come back.
    clearTimeout(session.orphanTimer);
    session.orphanTimer = setTimeout(() => {
      const c = session.clients.get(clientId);
      if (!c || !c.connected) S.destroy(session); // notifies "session-ended"
    }, S.ORPHAN_GRACE_MS);
  } else {
    client.removeTimer = setTimeout(() => {
      const c = session.clients.get(clientId);
      if (c && !c.connected) {
        session.clients.delete(clientId);
        S.broadcastPeers(session);
      }
    }, S.RECONNECT_GRACE_MS);
  }
  S.broadcastPeers(session);
}

const HANDLERS = {
  timesync(ws, msg) {
    handleTimesync(ws, msg);
  },

  create(ws, msg) {
    if (typeof msg.clientId !== 'string' || !msg.clientId) return sendError(ws, 'BAD_REQUEST', 'MISSING CLIENT ID');
    const session = S.create(msg.clientId);
    attachClient(session, msg.clientId, 'lead', ws);
    ws.meta = { sessionCode: session.code, clientId: msg.clientId };
    send(ws, { type: 'created', sessionCode: session.code, clientId: msg.clientId });
    S.broadcastPeers(session);
  },

  join(ws, msg) {
    const code = String(msg.sessionCode || '').toUpperCase();
    const session = S.get(code);
    if (!session) return sendError(ws, 'SESSION_NOT_FOUND', 'SESSION NOT FOUND');
    if (typeof msg.clientId !== 'string' || !msg.clientId) return sendError(ws, 'BAD_REQUEST', 'MISSING CLIENT ID');

    const isLead = msg.clientId === session.leadId;
    if (isLead) clearTimeout(session.orphanTimer);
    attachClient(session, msg.clientId, isLead ? 'lead' : 'satellite', ws);
    ws.meta = { sessionCode: session.code, clientId: msg.clientId };
    S.touch(session);
    send(ws, {
      type: 'joined',
      sessionCode: session.code,
      clientId: msg.clientId,
      role: isLead ? 'lead' : 'satellite',
      queue: S.queueSnapshot(session),
      playback: S.playbackSnapshot(session),
      peers: S.peerList(session),
    });
    S.broadcastPeers(session);
  },

  'client-ready'(ws, msg, session, client) {
    const track = S.getTrack(session, msg.trackId);
    if (!track) return;
    client.readyFor.add(track.id);
    let queueChanged = false;
    if (!track.duration && typeof msg.duration === 'number' && msg.duration > 0) {
      track.duration = msg.duration;
      queueChanged = true;
    }
    S.broadcastPeers(session);
    if (queueChanged) S.broadcastQueue(session);
  },

  // ---- transport: lead only. A satellite sending these is silently ignored.
  play(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    const target = S.gateTrackId(session);
    if (!target) return sendError(ws, 'NO_TRACK', 'QUEUE IS EMPTY');
    if (!allConnectedReadyFor(session, target) && msg.force !== true) {
      return sendError(ws, 'NOT_READY', 'CLIENTS STILL LOADING');
    }
    const track = S.getTrack(session, target);
    let from = typeof msg.position === 'number' ? Math.max(0, msg.position) : S.position(session);
    if (track.duration && from >= track.duration) from = 0; // resume past end → restart
    startTrack(session, target, { from });
  },

  pause(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (session.playback.status !== 'playing' || session.playback.click) return;
    let pos = S.position(session);
    const track = S.currentTrack(session);
    if (track && track.duration) pos = Math.min(pos, track.duration);
    // Any beatmatch glide dies with the pause; resume restarts at master tempo.
    session.playback = {
      status: 'paused', trackOffset: 0, startAtServerTime: 0, pausedPosition: pos, click: false,
      rate: session.tempo, rateRamp: null,
    };
    session.advanceWaitSince = null;
    S.broadcast(session, { type: 'pause', position: pos });
  },

  stop(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    stopPlayback(session);
  },

  seek(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (typeof msg.position !== 'number') return;
    const track = S.currentTrack(session);
    if (!track) return;
    let pos = Math.max(0, msg.position);
    if (track.duration) pos = Math.min(pos, track.duration - 0.05);
    if (session.playback.status === 'playing' && !session.playback.click) {
      startTrack(session, track.id, { from: pos }); // seek = stop + new scheduled play
    } else if (session.playback.status !== 'idle') {
      session.playback.pausedPosition = pos;
      session.playback.status = 'paused';
      S.broadcast(session, { type: 'pause', position: pos });
    }
  },

  'skip-next'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    const next = S.resolveNextId(session, { manual: true });
    if (!next) return stopPlayback(session);
    // A manual skip honors the active transition (djay-style: the fade starts
    // now instead of at the track's end). CUT keeps the classic jump.
    const playing = session.playback.status === 'playing' && !session.playback.click;
    if (playing && session.transitionMode !== 'cut') {
      startTransition(session, next, { manual: true });
    } else {
      startTrack(session, next);
    }
  },

  // Standard player convention: >3 s into the track, "prev" restarts it;
  // otherwise it goes to the previous track.
  'skip-prev'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (session.playback.status === 'playing' && S.position(session) > 3) {
      return startTrack(session, session.currentTrackId);
    }
    const prev = S.resolvePrevId(session);
    if (prev) startTrack(session, prev);
  },

  'queue-remove'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    const track = S.getTrack(session, msg.trackId);
    if (!track) return;
    const wasCurrent = track.id === session.currentTrackId;
    const wasPlaying = session.playback.status === 'playing' && !session.playback.click;
    // Resolve the successor BEFORE removal so repeat/shuffle order still sees
    // the current position.
    const next = wasCurrent ? S.resolveNextId(session, { manual: true }) : null;
    session.queue = session.queue.filter((t) => t.id !== track.id);
    session.shuffleOrder = session.shuffleOrder.filter((id) => id !== track.id);
    S.deleteTrackFile(track);
    if (wasCurrent) {
      session.currentTrackId = null;
      if (next && next !== track.id && wasPlaying) {
        startTrack(session, next); // removing the playing track skips ahead
        return;
      }
      if (wasPlaying || session.playback.status === 'paused') stopPlayback(session);
    }
    S.broadcastQueue(session);
    S.broadcastPeers(session);
  },

  // Reorder never touches playback: the current track is referenced by id.
  'queue-reorder'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    const { from, to } = msg;
    const len = session.queue.length;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return;
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) return;
    const [moved] = session.queue.splice(from, 1);
    session.queue.splice(to, 0, moved);
    S.broadcastQueue(session);
  },

  'set-repeat'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (!['off', 'all', 'one'].includes(msg.mode)) return;
    session.repeatMode = msg.mode; // takes effect at the NEXT track change
    S.broadcastQueue(session);
  },

  'set-shuffle'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    session.shuffle = !!msg.on;
    if (session.shuffle) S.regenShuffle(session); // stable until toggled again
    else session.shuffleOrder = [];
    S.broadcastQueue(session); // current track is untouched, only "next" moves
  },

  // ---- MIX MODE: lead-only, like the transport. --------------------------
  // BPM/beatgrid analysis result from the lead's DJ module.
  'track-meta'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    const track = S.getTrack(session, msg.trackId);
    if (!track) return;
    const num = (v, min, max) => (typeof v === 'number' && isFinite(v) && v >= min && v <= max ? v : null);
    track.meta = {
      bpm: num(msg.bpm, 40, 250),
      confidence: num(msg.confidence, 0, 1) ?? 0,
      beatPhase: num(msg.beatPhase, 0, 60) ?? 0,
      gainDb: num(msg.gainDb, -60, 24),
    };
    S.broadcastQueue(session);
  },

  'set-transition'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (!S.TRANSITION_MODES.includes(msg.mode)) return;
    session.transitionMode = msg.mode; // takes effect at the next track change
    S.broadcastQueue(session);
  },

  // Master tempo: re-anchor the timeline at a shared future instant and let
  // every client glide playbackRate locally (~0.15 s) — no restart, no click.
  // During a beatmatch glide the live change is skipped (the ramp's integral
  // would diverge between server and clients); the stored tempo still applies
  // from the next track on.
  'set-tempo'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (typeof msg.tempo !== 'number' || !isFinite(msg.tempo)) return;
    const tempo = Math.min(S.TEMPO_MAX, Math.max(S.TEMPO_MIN, msg.tempo));
    session.tempo = tempo;
    const p = session.playback;
    if (p.status === 'playing' && !p.click && !p.rateRamp && p.rate !== tempo) {
      const applyAt = now() + S.FX_APPLY_LEAD_MS;
      p.trackOffset = S.positionAt(session, applyAt);
      p.startAtServerTime = applyAt;
      p.rate = tempo;
      S.broadcast(session, {
        type: 'rate-change', rate: tempo, trackOffset: p.trackOffset, applyAtServerTime: applyAt,
      });
    }
    S.broadcastQueue(session); // tempo rides in the snapshot
  },

  // Live EQ/filter state. Stored (late joiners pick it up from the queue
  // snapshot) and broadcast with a shared future apply instant so every device
  // changes sound at the same moment.
  'fx-set'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    const f = msg.fx || {};
    const num = (v, min, max, dflt) => (typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt);
    session.fx = {
      low: num(f.low, -40, 6, 0),
      mid: num(f.mid, -40, 6, 0),
      high: num(f.high, -40, 6, 0),
      killLow: !!f.killLow,
      killMid: !!f.killMid,
      killHigh: !!f.killHigh,
      filter: num(f.filter, -100, 100, 0),
    };
    S.broadcast(session, { type: 'fx-update', fx: session.fx, applyAtServerTime: now() + S.FX_APPLY_LEAD_MS });
  },

  // Hot cues: per-track, session-lived. position:null clears the slot.
  'cue-set'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    const track = S.getTrack(session, msg.trackId);
    if (!track) return;
    if (!Number.isInteger(msg.slot) || msg.slot < 0 || msg.slot > 3) return;
    if (!track.cues) track.cues = [null, null, null, null];
    if (msg.position === null) {
      track.cues[msg.slot] = null;
    } else {
      if (typeof msg.position !== 'number' || !isFinite(msg.position)) return;
      let pos = Math.max(0, msg.position);
      if (track.duration) pos = Math.min(pos, Math.max(0, track.duration - 0.1));
      track.cues[msg.slot] = pos;
    }
    S.broadcastQueue(session);
  },

  // Calibration click track — generated locally by every client, scheduled
  // like a normal track; the queue is untouched.
  'click-start'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    startTrack(session, null, { click: true });
  },

  'click-stop'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    stopPlayback(session);
  },

  // A client back from background asks where we are (faster than waiting for
  // the next 5 s heartbeat).
  'position-request'(ws, msg, session) {
    send(ws, {
      type: 'position-heartbeat',
      sessionCode: session.code,
      serverTime: now(),
      trackPosition: S.position(session),
      status: session.playback.status,
      rate: S.currentRate(session),
      rampActive: !!session.playback.rateRamp,
    });
  },

  leave(ws, msg, session, client) {
    session.clients.delete(client.id);
    ws.meta = {};
    if (client.id === session.leadId) {
      S.destroy(session);
    } else {
      S.broadcastPeers(session);
    }
  },
};

// Messages that only make sense inside a session.
const SESSION_SCOPED = new Set([
  'client-ready', 'play', 'pause', 'stop', 'seek',
  'skip-next', 'skip-prev', 'queue-remove', 'queue-reorder', 'set-repeat', 'set-shuffle',
  'track-meta', 'set-transition', 'set-tempo', 'fx-set', 'cue-set',
  'click-start', 'click-stop', 'position-request', 'leave',
]);

wss.on('connection', (ws) => {
  ws.meta = {};
  ws.on('message', (data) => {
    // Malformed messages must never crash the server.
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    const handler = HANDLERS[msg.type];
    if (!handler) return;
    try {
      if (SESSION_SCOPED.has(msg.type)) {
        const session = S.get(ws.meta.sessionCode);
        if (!session) return sendError(ws, 'NO_SESSION', 'NOT IN A SESSION');
        if (msg.sessionCode && String(msg.sessionCode).toUpperCase() !== session.code) return;
        const client = session.clients.get(ws.meta.clientId);
        if (!client) return;
        S.touch(session);
        handler(ws, msg, session, client);
      } else {
        handler(ws, msg);
      }
    } catch (err) {
      console.error('handler error:', msg.type, err.message);
    }
  });
  ws.on('close', () => handleDisconnect(ws));
  ws.on('error', () => { /* close event follows */ });
});

// ------------------------------------------------- auto-advance (250 ms) ----
// The SERVER is the authority on track changes: relying on each client's local
// `onended` would make every device advance on its own clock. When the current
// track is inside its final (leadTime + 300 ms) window, we schedule the next
// track to start EXACTLY when this one ends — clients get ≥1.2 s of notice, so
// the sample-accurate scheduling machinery covers the gap and the transition
// is seamless. If some client hasn't finished decoding the next track yet, we
// hold (brief synchronized "buffering") and start 1.5 s after readiness — or
// after ADVANCE_WAIT_MS with whoever is ready.
setInterval(() => {
  for (const session of S.sessions.values()) {
    S.commitRateRamp(session); // fold finished beatmatch glides back to constant rate
    const p = session.playback;
    if (p.status !== 'playing' || p.click) continue;
    const track = S.currentTrack(session);
    if (!track || !track.duration) continue;
    // Remaining WALL-CLOCK time: at rate r the track burns r seconds of audio
    // per second. Crossfades widen the trigger window by the fade length so the
    // incoming track can start fade seconds BEFORE the outgoing one ends.
    const rate = S.currentRate(session);
    const remainingMs = ((track.duration - S.position(session)) / rate) * 1000;
    const nextId = S.resolveNextId(session);
    const plan = planTransitionType(session, track, nextId ? S.getTrack(session, nextId) : null);
    if (remainingMs > plan.fade * 1000 + S.PLAY_LEAD_TIME_MS + 300) continue;

    if (!nextId) {
      // End of the queue: let it run out, then stop cleanly.
      if (remainingMs <= -750) stopPlayback(session, true);
      continue;
    }
    const everyoneReady = allConnectedReadyFor(session, nextId);
    if (!everyoneReady) {
      if (!session.advanceWaitSince) session.advanceWaitSince = Date.now();
      if (Date.now() - session.advanceWaitSince < S.ADVANCE_WAIT_MS) continue; // hold
    }
    if (remainingMs <= 300) {
      // Ran out (buffering hold, or cut mode at the wire): classic gapless jump.
      startTrack(session, nextId, { leadMs: Math.max(remainingMs, everyoneReady ? 250 : S.PLAY_LEAD_TIME_MS) });
    } else {
      startTransition(session, nextId); // cut → fade 0 → same instant as before
    }
  }
}, 250);

// ------------------------------------------------------------ heartbeats ----
// Every 5 s: authoritative position broadcast → clients measure their drift.
setInterval(() => {
  for (const session of S.sessions.values()) {
    if (session.playback.status !== 'playing') continue;
    S.broadcast(session, {
      type: 'position-heartbeat',
      serverTime: now(),
      trackPosition: S.position(session),
      status: 'playing',
      rate: S.currentRate(session),
      rampActive: !!session.playback.rateRamp,
    });
  }
}, 5000);

// Cleanup job: destroy sessions inactive for 30+ minutes, delete their files.
setInterval(() => S.cleanupStale(), 5 * 60 * 1000);

// ----------------------------------------------------------------- start ----
function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  console.log('sYntonia up.');
  console.log(`  local:   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  LAN:     http://${ip}:${PORT}   <- share this with the other phones`);
  }
  console.log('  NOTE: production needs HTTPS/WSS (mobile browsers gate some APIs to secure contexts). See README.');
});

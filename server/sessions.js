'use strict';
// Session store — everything lives in memory (Map), files on disk in
// ./uploads/<sessionCode>/. Each session owns an ordered queue of tracks.
const fs = require('fs');
const path = require('path');
const { now } = require('./timesync');

// No ambiguous characters: O/0 and I/1 excluded.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

const SESSION_TTL_MS = 30 * 60 * 1000;   // inactive sessions are destroyed after 30 min
const ORPHAN_GRACE_MS = 60 * 1000;       // lead has 60 s to come back
const RECONNECT_GRACE_MS = 60 * 1000;    // satellites keep their slot for 60 s
const PLAY_LEAD_TIME_MS = 1500;          // scheduled-play lead time to absorb network jitter
const ADVANCE_WAIT_MS = 8000;            // max wait for slow clients before advancing anyway

// ---- MIX MODE constants -----------------------------------------------------
const TEMPO_MIN = 0.92;                  // master tempo ±8%
const TEMPO_MAX = 1.08;
const BEATMATCH_MAX_DEV = 0.08;          // BPM ratio must land within ±8% (after octave folding)
const BEATMATCH_RAMP_MS = 4000;          // post-fade glide of the incoming track back to master tempo
const FX_APPLY_LEAD_MS = 300;            // live EQ/filter changes apply this far in the future
const TRANSITION_MODES = ['cut', 'fade2', 'fade4', 'fade8', 'beatmatch'];
const TRANSITION_FADE_S = { cut: 0, fade2: 2, fade4: 4, fade8: 8 };
const NEUTRAL_FX = () => ({ low: 0, mid: 0, high: 0, killLow: false, killMid: false, killHigh: false, filter: 0 });

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');

const sessions = new Map(); // code -> session

function generateCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    if (!sessions.has(code)) return code; // regenerate on collision
  }
}

function create(leadClientId) {
  const session = {
    code: generateCode(),
    leadId: leadClientId,
    // clientId -> { id, role, ws, readyFor:Set<trackId>, connected, disconnectedAt, removeTimer }
    clients: new Map(),
    // Ordered queue. The PLAYING track is referenced by id (currentTrackId),
    // never by index: remove/reorder can then never "shift" playback around.
    queue: [],            // [{ id, filePath, originalName, size, duration|null, addedAt }]
    currentTrackId: null, // null = nothing selected yet
    repeatMode: 'off',    // 'off' | 'all' | 'one'
    shuffle: false,
    shuffleOrder: [],     // stable permutation of track ids while shuffle is on
    // ---- MIX MODE session settings (lead-controlled, rendered by everyone) --
    transitionMode: 'cut', // 'cut' | 'fade2' | 'fade4' | 'fade8' | 'beatmatch'
    tempo: 1,              // master tempo multiplier (0.92..1.08)
    fx: NEUTRAL_FX(),      // 3-band EQ (dB) + kills + bipolar filter (-100..100)
    playback: {
      status: 'idle',     // 'idle' | 'playing' | 'paused'
      trackOffset: 0,
      startAtServerTime: 0,
      pausedPosition: 0,
      click: false,
      // Constant playback rate of the CURRENT track (tempo × beatmatch ratio).
      // While rateRamp is set, `rate` is the ramp's FROM value; position() is
      // piecewise-exact and the 250 ms ticker commits the ramp when it ends.
      rate: 1,
      rateRamp: null,     // { to, startAt (serverTime ms), dur (ms) }
    },
    advanceWaitSince: null, // set while waiting for clients to buffer the next track
    orphanTimer: null,
    lastActivity: Date.now(),
  };
  sessions.set(session.code, session);
  return session;
}

function get(code) {
  return sessions.get(code);
}

function touch(session) {
  session.lastActivity = Date.now();
}

function uploadDir(session) {
  return path.join(UPLOAD_ROOT, session.code);
}

function currentTrack(session) {
  return session.queue.find((t) => t.id === session.currentTrackId) || null;
}

function getTrack(session, trackId) {
  return session.queue.find((t) => t.id === trackId) || null;
}

// The order playback actually follows: queue order, or the stable shuffle
// permutation. The permutation is generated ONCE when shuffle turns on, so
// "next" never re-rolls on every skip; turning shuffle off returns to queue
// order. The current track is never changed by the toggle itself.
function effectiveOrder(session) {
  if (!session.shuffle) return session.queue.map((t) => t.id);
  const alive = new Set(session.queue.map((t) => t.id));
  return session.shuffleOrder.filter((id) => alive.has(id));
}

function regenShuffle(session) {
  // Fisher–Yates over the track ids.
  const ids = session.queue.map((t) => t.id);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  session.shuffleOrder = ids;
}

// Pure next/prev resolution over the effective order.
// Cases covered: empty queue (null), no current yet (first of order),
// repeat-one (same track on AUTO advance; a MANUAL skip moves on — standard
// player convention), repeat-all (wrap around), off (null after the last),
// single-track queue (repeat-all/one => itself, off => null).
function successorOf(session, fromId, { manual = false } = {}) {
  const order = effectiveOrder(session);
  if (order.length === 0 || !fromId) return null;
  if (session.repeatMode === 'one' && !manual) return fromId;
  const idx = order.indexOf(fromId);
  if (idx === -1) return order[0]; // track was removed
  if (idx + 1 < order.length) return order[idx + 1];
  return session.repeatMode === 'all' ? order[0] : null;
}

function resolveNextId(session, opts = {}) {
  if (!session.currentTrackId) return effectiveOrder(session)[0] || null;
  return successorOf(session, session.currentTrackId, opts);
}

function resolvePrevId(session) {
  const order = effectiveOrder(session);
  if (order.length === 0) return null;
  if (!session.currentTrackId) return order[0];
  const idx = order.indexOf(session.currentTrackId);
  if (idx > 0) return order[idx - 1];
  // At the first track: wrap with repeat-all, otherwise restart the current.
  return session.repeatMode === 'all' ? order[order.length - 1] : session.currentTrackId;
}

// The track that PLAY would start (and that clients must have decoded before
// the lead can press it): the current one, or the first of the order.
function gateTrackId(session) {
  return session.currentTrackId || effectiveOrder(session)[0] || null;
}

// Authoritative track position in seconds, derived from the server clock.
// With a playback rate r, position advances at r seconds of audio per second
// of wall clock; during a linear rate ramp the advance is the integral of the
// ramp (quadratic segment) — exact, so heartbeats stay truthful mid-ramp.
function positionAt(session, serverTimeMs) {
  const p = session.playback;
  if (p.status === 'paused') return p.pausedPosition;
  if (p.status !== 'playing') return 0;
  const t = Math.max(0, (serverTimeMs - p.startAtServerTime) / 1000); // wall seconds since anchor
  const r = p.rateRamp;
  if (!r) return p.trackOffset + t * p.rate;
  const t0 = Math.max(0, (r.startAt - p.startAtServerTime) / 1000);   // ramp start, anchor-relative
  const dur = r.dur / 1000;
  let pos = p.trackOffset + Math.min(t, t0) * p.rate;                 // constant before the ramp
  if (t > t0) {
    const u = Math.min(t - t0, dur);
    pos += p.rate * u + (r.to - p.rate) * u * u / (2 * dur);          // integral of the linear ramp
    if (t - t0 > dur) pos += (t - t0 - dur) * r.to;                   // constant after the ramp
  }
  return pos;
}

function position(session) {
  return positionAt(session, now());
}

// The instantaneous rate right now (mid-ramp included) — used by the ticker to
// convert "seconds of track left" into wall-clock time.
function currentRate(session) {
  const p = session.playback;
  const r = p.rateRamp;
  if (!r) return p.rate;
  const t = now();
  if (t <= r.startAt) return p.rate;
  if (t >= r.startAt + r.dur) return r.to;
  return p.rate + (r.to - p.rate) * (t - r.startAt) / r.dur;
}

// Fold a finished ramp into the anchor so the state goes back to the simple
// constant-rate form. Called by the 250 ms ticker.
function commitRateRamp(session) {
  const p = session.playback;
  const r = p.rateRamp;
  if (!r || p.status !== 'playing') return;
  const end = r.startAt + r.dur;
  if (now() < end) return;
  p.trackOffset = positionAt(session, end);
  p.startAtServerTime = end;
  p.rate = r.to;
  p.rateRamp = null;
}

function playbackSnapshot(session) {
  const p = session.playback;
  return {
    status: p.status,
    trackOffset: p.trackOffset,
    startAtServerTime: p.startAtServerTime,
    position: position(session),
    serverTime: now(),
    click: p.click,
    trackId: session.currentTrackId,
    rate: p.rate,
    rateRamp: p.rateRamp, // {to, startAt, dur} | null — late joiners resume mid-glide
  };
}

// Full queue state, broadcast on every mutation. `prefetch` tells clients
// exactly which tracks to keep decoded (current-or-gate + next): they never
// re-implement shuffle/repeat logic.
function queueSnapshot(session) {
  const order = effectiveOrder(session);
  const gate = gateTrackId(session);
  // "next" for prefetch purposes: the successor of whatever plays (or would
  // play) — when idle with no current yet, that's the track AFTER the gate.
  const next = successorOf(session, gate);
  return {
    queue: session.queue.map((t) => ({
      id: t.id,
      name: t.originalName,
      duration: t.duration,
      size: t.size,
      meta: t.meta || null,   // {bpm, confidence, beatPhase, gainDb} from the lead's analysis
      cues: t.cues || [null, null, null, null],
    })),
    currentTrackId: session.currentTrackId,
    currentIndex: session.queue.findIndex((t) => t.id === session.currentTrackId),
    nextTrackId: next,
    repeatMode: session.repeatMode,
    shuffle: session.shuffle,
    order,
    prefetch: [...new Set([gate, next].filter(Boolean))],
    // MIX session settings ride along: late joiners (and a reloading lead)
    // restore transition mode, tempo and the live FX state from here.
    transitionMode: session.transitionMode,
    tempo: session.tempo,
    fx: session.fx,
  };
}

function peerList(session) {
  const gate = gateTrackId(session);
  return [...session.clients.values()].map((c) => ({
    id: c.id,
    role: c.role,
    // "ready" is relative to the track PLAY would start right now.
    ready: gate ? c.readyFor.has(gate) : false,
    connected: c.connected,
  }));
}

function broadcast(session, obj, exceptId = null) {
  const raw = JSON.stringify({ sessionCode: session.code, ...obj });
  for (const c of session.clients.values()) {
    if (!c.connected || c.id === exceptId) continue;
    try { c.ws.send(raw); } catch { /* dead socket, close handler cleans up */ }
  }
}

function broadcastPeers(session) {
  const peers = peerList(session);
  broadcast(session, {
    type: 'peer-update',
    count: peers.filter((p) => p.connected).length,
    peers,
  });
}

function broadcastQueue(session) {
  broadcast(session, { type: 'queue-update', ...queueSnapshot(session) });
}

function deleteTrackFile(track) {
  if (track) fs.unlink(track.filePath, () => {});
}

function destroy(session, notify = true) {
  if (!sessions.has(session.code)) return;
  if (notify) broadcast(session, { type: 'session-ended' });
  clearTimeout(session.orphanTimer);
  for (const c of session.clients.values()) clearTimeout(c.removeTimer);
  fs.rm(uploadDir(session), { recursive: true, force: true }, () => {});
  sessions.delete(session.code);
}

function cleanupStale() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const s of [...sessions.values()]) {
    if (s.lastActivity < cutoff) destroy(s);
  }
}

module.exports = {
  sessions,
  create,
  get,
  touch,
  uploadDir,
  currentTrack,
  getTrack,
  effectiveOrder,
  regenShuffle,
  resolveNextId,
  resolvePrevId,
  gateTrackId,
  position,
  positionAt,
  currentRate,
  commitRateRamp,
  playbackSnapshot,
  queueSnapshot,
  peerList,
  broadcast,
  broadcastPeers,
  broadcastQueue,
  deleteTrackFile,
  destroy,
  cleanupStale,
  UPLOAD_ROOT,
  ORPHAN_GRACE_MS,
  RECONNECT_GRACE_MS,
  PLAY_LEAD_TIME_MS,
  ADVANCE_WAIT_MS,
  TEMPO_MIN,
  TEMPO_MAX,
  BEATMATCH_MAX_DEV,
  BEATMATCH_RAMP_MS,
  FX_APPLY_LEAD_MS,
  TRANSITION_MODES,
  TRANSITION_FADE_S,
};

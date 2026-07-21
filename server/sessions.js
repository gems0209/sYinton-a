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

// ---- DUAL DECK constants ----------------------------------------------------
const DECK_IDS = ['A', 'B'];
const DECK_PLAY_LEAD_MS = 900;           // deck actions feel snappier than queue PLAY, still sync-safe
const newDeck = () => ({
  trackId: null,
  status: 'empty',      // 'empty' | 'loaded' | 'playing' | 'paused' | 'ended'
  trackOffset: 0,
  startAtServerTime: 0,
  pausedPosition: 0,
  rate: 1,              // per-deck pitch (0.92..1.08); no ramps on decks (v1)
  rateRamp: null,       // kept for shape-compatibility with the timeline math
});

// ---- LIGHT SHOW constants ---------------------------------------------------
// The lead picks a "look"; every device renders it locally, its TIMING derived
// from the already-synchronized playback timeline (beat grid) or the analyser
// level — the server never streams "flash" events.
const LIGHTSHOW_PATTERNS = ['pulse', 'colorbeat', 'wave', 'breathe', 'strobe'];
const LIGHTSHOW_PALETTES = ['spectrum', 'mono', 'warm', 'cool'];
const LIGHTSHOW_SOURCES = ['auto', 'beat', 'level'];
const LIGHTSHOW_DIVS = ['bar', 'beat', 'half', 'quarter'];
const newLightshow = () => ({
  on: false,
  pattern: 'pulse',
  palette: 'spectrum',
  source: 'auto',
  beatDiv: 'beat',
  intensity: 1,      // 0..1 brightness of the pulse over the floor
  floor: 0.12,       // 0..1 base brightness between pulses (never full black)
});

// ---- JUKEBOX constants ------------------------------------------------------
const JUKEBOX_MAX_PER_DEVICE = 3;   // pending proposals a single device may hold
const JUKEBOX_MAX_TOTAL = 20;       // pending proposals across the whole session

// ---- MULTI-ZONE constants ---------------------------------------------------
// Optional spatial mode: each device shapes only its OWN output (stereo channel
// + frequency band + gain trim). The sync timeline is untouched.
const ZONE_CHANNELS = ['full', 'left', 'right'];
const ZONE_BANDS = ['full', 'low', 'mid', 'high'];

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
    // DUAL DECK mode: two independent timelines mixed by a crossfader. While
    // decks.on the queue transport and auto-advance are suspended (the queue
    // itself stays intact and resumes, stopped, when decks are turned off).
    decks: { on: false, xfader: 0, A: newDeck(), B: newDeck() },
    // ---- participatory layer (Light Show + Jukebox) ------------------------
    // Stable per-device index (join order), used by the light show's spatial
    // patterns and as a name fallback. Not recycled — monotonic per session.
    nextDeviceIndex: 0,
    // Lead-controlled "look"; rendered by every device off the shared clock.
    lightshow: newLightshow(),
    // Crowd requests: satellites upload tracks into a separate pool, the lead
    // approves them into the queue. proposals: [{ id, filePath, name, note,
    // byId, byIndex, size, votes:Set<clientId>, createdAt }].
    jukebox: { open: false, proposals: [] },
    // Optional spatial mode: per-device output shaping, keyed by clientId.
    // Off by default and fully additive — the sync timeline is untouched.
    multizone: { on: false, zones: {} }, // zones[clientId] = {channel, band, gain}
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

// Authoritative position in seconds of ANY timeline (queue playback or a
// deck), derived from the server clock. With a playback rate r, position
// advances at r seconds of audio per second of wall clock; during a linear
// rate ramp the advance is the integral of the ramp (quadratic segment) —
// exact, so heartbeats stay truthful mid-ramp. Decks never carry ramps but
// share the same shape (rateRamp: null).
function timelinePositionAt(p, serverTimeMs) {
  if (p.status === 'paused') return p.pausedPosition;
  if (p.status !== 'playing') return p.pausedPosition || 0;
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

function positionAt(session, serverTimeMs) {
  return timelinePositionAt(session.playback, serverTimeMs);
}

function position(session) {
  return positionAt(session, now());
}

function deckPosition(session, deckId, serverTimeMs = now()) {
  return timelinePositionAt(session.decks[deckId], serverTimeMs);
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

// Full decks state, broadcast on every deck mutation and included in the
// queue snapshot for late joiners.
function decksSnapshot(session) {
  const d = session.decks;
  const one = (id) => {
    const deck = d[id];
    return {
      trackId: deck.trackId,
      status: deck.status,
      trackOffset: deck.trackOffset,
      startAtServerTime: deck.startAtServerTime,
      pausedPosition: deck.pausedPosition,
      rate: deck.rate,
      position: deckPosition(session, id),
    };
  };
  return { on: d.on, xfader: d.xfader, A: one('A'), B: one('B'), serverTime: now() };
}

function broadcastDecks(session) {
  broadcast(session, { type: 'decks-update', decks: decksSnapshot(session) });
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
    // Clients keep decoded exactly what this lists: queue gate + next, plus
    // any track sitting on a deck (both decks must be playable at any time).
    prefetch: [...new Set([
      gate, next,
      session.decks.A.trackId, session.decks.B.trackId,
    ].filter(Boolean))],
    // MIX session settings ride along: late joiners (and a reloading lead)
    // restore transition mode, tempo and the live FX state from here.
    transitionMode: session.transitionMode,
    tempo: session.tempo,
    fx: session.fx,
    decks: decksSnapshot(session),
  };
}

function peerList(session) {
  const gate = gateTrackId(session);
  return [...session.clients.values()].map((c) => ({
    id: c.id,
    role: c.role,
    deviceIndex: c.deviceIndex ?? 0, // stable join-order index (light show / name fallback)
    name: c.name || '',              // optional nickname (jukebox attribution)
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

// ---- JUKEBOX ----------------------------------------------------------------
// Public view of the request pool: names resolved live from the client records
// (so a nickname change updates every proposal), ranked votes-desc then oldest.
// `voterIds` lets each recipient tell whether IT already voted, without the
// server tailoring the payload per client.
function jukeboxSnapshot(session) {
  const j = session.jukebox;
  const proposals = j.proposals.map((p) => {
    const c = session.clients.get(p.byId);
    const byName = (c && c.name) || `OSPITE ${(p.byIndex ?? 0) + 1}`;
    const voterIds = [...p.votes];
    return { id: p.id, name: p.name, note: p.note, byName, votes: voterIds.length, voterIds };
  });
  proposals.sort((a, b) => b.votes - a.votes); // stable → ties stay in arrival order
  return { open: j.open, proposals };
}

function broadcastJukebox(session) {
  broadcast(session, { type: 'jukebox-update', jukebox: jukeboxSnapshot(session) });
}

// ---- MULTI-ZONE -------------------------------------------------------------
// The whole zone map is broadcast: the lead needs every device's assignment for
// its UI, each satellite just applies zones[its own clientId] (or neutral).
function multizoneSnapshot(session) {
  return { on: session.multizone.on, zones: session.multizone.zones };
}
function broadcastMultizone(session) {
  broadcast(session, { type: 'multizone-update', multizone: multizoneSnapshot(session) });
}

// Insert an approved proposal into the live queue as a first-class track:
// 'end' appends (shuffle: fair random spot in the unplayed tail, like upload),
// 'next' drops it right after the current track (and after it in the shuffle
// permutation). The playing track is referenced by id, so this never disturbs
// what's currently playing.
function insertTrack(session, track, mode = 'end') {
  const curIdx = session.queue.findIndex((t) => t.id === session.currentTrackId);
  if (mode === 'next' && curIdx >= 0) session.queue.splice(curIdx + 1, 0, track);
  else session.queue.push(track);
  if (session.shuffle) {
    const order = session.shuffleOrder;
    const cur = order.indexOf(session.currentTrackId);
    if (mode === 'next' && cur >= 0) {
      order.splice(cur + 1, 0, track.id);
    } else {
      const from = cur + 1;
      const at = from + Math.floor(Math.random() * (order.length - from + 1));
      order.splice(at, 0, track.id);
    }
  }
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
  timelinePositionAt,
  deckPosition,
  decksSnapshot,
  broadcastDecks,
  currentRate,
  commitRateRamp,
  playbackSnapshot,
  queueSnapshot,
  peerList,
  broadcast,
  broadcastPeers,
  broadcastQueue,
  jukeboxSnapshot,
  broadcastJukebox,
  insertTrack,
  multizoneSnapshot,
  broadcastMultizone,
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
  DECK_IDS,
  DECK_PLAY_LEAD_MS,
  newDeck,
  LIGHTSHOW_PATTERNS,
  LIGHTSHOW_PALETTES,
  LIGHTSHOW_SOURCES,
  LIGHTSHOW_DIVS,
  newLightshow,
  JUKEBOX_MAX_PER_DEVICE,
  JUKEBOX_MAX_TOTAL,
  ZONE_CHANNELS,
  ZONE_BANDS,
};

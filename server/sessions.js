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
    playback: {
      status: 'idle',     // 'idle' | 'playing' | 'paused'
      trackOffset: 0,
      startAtServerTime: 0,
      pausedPosition: 0,
      click: false,
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
function position(session) {
  const p = session.playback;
  if (p.status === 'playing') {
    return p.trackOffset + Math.max(0, (now() - p.startAtServerTime) / 1000);
  }
  if (p.status === 'paused') return p.pausedPosition;
  return 0;
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
    })),
    currentTrackId: session.currentTrackId,
    currentIndex: session.queue.findIndex((t) => t.id === session.currentTrackId),
    nextTrackId: next,
    repeatMode: session.repeatMode,
    shuffle: session.shuffle,
    order,
    prefetch: [...new Set([gate, next].filter(Boolean))],
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
};

'use strict';
// Session store — everything lives in memory (Map), files on disk in ./uploads.
const fs = require('fs');
const { now } = require('./timesync');

// No ambiguous characters: O/0 and I/1 excluded.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 4;

const SESSION_TTL_MS = 30 * 60 * 1000;   // inactive sessions are destroyed after 30 min
const ORPHAN_GRACE_MS = 60 * 1000;       // lead has 60 s to come back
const RECONNECT_GRACE_MS = 60 * 1000;    // satellites keep their slot for 60 s
const PLAY_LEAD_TIME_MS = 1500;          // scheduled-play lead time to absorb network jitter

const sessions = new Map(); // code -> session

function generateCode() {
  // Regenerate on collision until free (space = 32^4 ≈ 1M, collisions are rare).
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LEN; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    if (!sessions.has(code)) return code;
  }
}

function create(leadClientId) {
  const session = {
    code: generateCode(),
    leadId: leadClientId,
    clients: new Map(), // clientId -> { id, role, ws, ready, connected, disconnectedAt, removeTimer }
    track: null,        // { filePath, originalName, size, duration|null }
    playback: {
      status: 'idle',   // 'idle' | 'playing' | 'paused'
      trackOffset: 0,   // track position (s) at startAtServerTime
      startAtServerTime: 0,
      pausedPosition: 0,
      click: false,     // calibration click-track mode
    },
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

// Authoritative track position in seconds, derived from the server clock.
function position(session) {
  const p = session.playback;
  if (p.status === 'playing') {
    return p.trackOffset + Math.max(0, (now() - p.startAtServerTime) / 1000);
  }
  if (p.status === 'paused') return p.pausedPosition;
  return 0;
}

// Snapshot sent on join so late joiners can compute where to start.
function playbackSnapshot(session) {
  const p = session.playback;
  return {
    status: p.status,
    trackOffset: p.trackOffset,
    startAtServerTime: p.startAtServerTime,
    position: position(session),
    serverTime: now(),
    click: p.click,
  };
}

function peerList(session) {
  return [...session.clients.values()].map((c) => ({
    id: c.id,
    role: c.role,
    ready: c.ready,
    connected: c.connected,
  }));
}

function broadcast(session, obj, exceptId = null) {
  const raw = JSON.stringify({ sessionCode: session.code, ...obj });
  for (const c of session.clients.values()) {
    if (!c.connected || c.id === exceptId) continue;
    try { c.ws.send(raw); } catch { /* dead socket, close handler will clean up */ }
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

function deleteTrackFile(session) {
  if (session.track) {
    fs.unlink(session.track.filePath, () => {});
    session.track = null;
  }
}

function destroy(session, notify = true) {
  if (!sessions.has(session.code)) return;
  if (notify) broadcast(session, { type: 'session-ended' });
  clearTimeout(session.orphanTimer);
  for (const c of session.clients.values()) clearTimeout(c.removeTimer);
  deleteTrackFile(session);
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
  position,
  playbackSnapshot,
  peerList,
  broadcast,
  broadcastPeers,
  deleteTrackFile,
  destroy,
  cleanupStale,
  ORPHAN_GRACE_MS,
  RECONNECT_GRACE_MS,
  PLAY_LEAD_TIME_MS,
};

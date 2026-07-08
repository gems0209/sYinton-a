'use strict';
// sYintonia server — Express (static + upload) + ws (session protocol + clock sync).
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
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const MAX_UPLOAD = 60 * 1024 * 1024; // 60 MB

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Orphaned files from a previous run (state is in-memory, so they're all stale).
for (const f of fs.readdirSync(UPLOAD_DIR)) {
  if (!f.startsWith('.')) fs.unlink(path.join(UPLOAD_DIR, f), () => {}); // keep .gitkeep
}

const app = express();
app.use(express.static(path.join(ROOT, 'public')));
// /debug is a client-side view of the same SPA.
app.get('/debug', (_req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));

// ---------------------------------------------------------------- upload ----
const ALLOWED_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac']);

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(12).toString('hex')),
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

  // New file during playback → global stop, then a fresh load/ready cycle.
  if (session.playback.status !== 'idle') {
    session.playback = { status: 'idle', trackOffset: 0, startAtServerTime: 0, pausedPosition: 0, click: false };
    S.broadcast(session, { type: 'stop' });
  }
  S.deleteTrackFile(session);
  session.track = {
    filePath: file.path,
    originalName: file.originalname,
    size: file.size,
    duration: null, // clients report it after decoding
  };
  for (const c of session.clients.values()) c.ready = false;
  S.touch(session);
  S.broadcast(session, {
    type: 'track-loaded',
    trackName: session.track.originalName,
    url: `/audio/${session.code}`,
  });
  S.broadcastPeers(session);
  res.json({ ok: true, trackName: session.track.originalName });
});

// Multer errors (file too large etc.) must not crash the server.
app.use((err, _req, res, _next) => {
  res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message || 'UPLOAD ERROR' });
});

app.get('/audio/:sessionCode', (req, res) => {
  const session = S.get((req.params.sessionCode || '').toUpperCase());
  if (!session || !session.track) return res.status(404).end();
  res.sendFile(session.track.filePath); // express handles Range requests
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

// Scheduled play: fix a start instant far enough in the future that every
// client has received the message and can schedule the exact same sample.
function scheduledPlay(session, fromPosition, click = false) {
  session.playback = {
    status: 'playing',
    trackOffset: fromPosition,
    startAtServerTime: now() + S.PLAY_LEAD_TIME_MS,
    pausedPosition: 0,
    click,
  };
  S.broadcast(session, {
    type: 'play',
    startAtServerTime: session.playback.startAtServerTime,
    trackOffset: fromPosition,
    click,
  });
}

function allConnectedReady(session) {
  for (const c of session.clients.values()) {
    if (c.connected && !c.ready) return false;
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
  const client = { id: clientId, role, ws, ready: false, connected: true, disconnectedAt: null, removeTimer: null };
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
  client.ready = false;
  client.disconnectedAt = Date.now();

  if (clientId === session.leadId) {
    // Orphaned session: satellites keep playing; the lead has 60 s to return.
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
      track: session.track
        ? { name: session.track.originalName, duration: session.track.duration, url: `/audio/${session.code}` }
        : null,
      playback: S.playbackSnapshot(session),
      peers: S.peerList(session),
    });
    S.broadcastPeers(session);
  },

  'client-ready'(ws, msg, session, client) {
    client.ready = true;
    if (session.track && !session.track.duration && typeof msg.duration === 'number' && msg.duration > 0) {
      session.track.duration = msg.duration;
    }
    S.broadcastPeers(session);
  },

  // ---- transport: lead only. A satellite sending these is silently ignored.
  play(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (!session.track) return sendError(ws, 'NO_TRACK', 'NO TRACK LOADED');
    if (!allConnectedReady(session) && msg.force !== true) {
      return sendError(ws, 'NOT_READY', 'CLIENTS STILL LOADING');
    }
    let from = typeof msg.position === 'number' ? Math.max(0, msg.position) : S.position(session);
    // Resuming past the end of the track (paused after natural end): restart.
    if (session.track.duration && from >= session.track.duration) from = 0;
    scheduledPlay(session, from, false);
  },

  pause(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (session.playback.status !== 'playing') return;
    let pos = S.position(session);
    if (!session.playback.click && session.track && session.track.duration) {
      pos = Math.min(pos, session.track.duration);
    }
    session.playback = { status: 'paused', trackOffset: 0, startAtServerTime: 0, pausedPosition: pos, click: false };
    S.broadcast(session, { type: 'pause', position: pos });
  },

  stop(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    session.playback = { status: 'idle', trackOffset: 0, startAtServerTime: 0, pausedPosition: 0, click: false };
    S.broadcast(session, { type: 'stop' });
  },

  seek(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    if (typeof msg.position !== 'number') return;
    let pos = Math.max(0, msg.position);
    if (session.track && session.track.duration) pos = Math.min(pos, session.track.duration - 0.05);
    if (session.playback.status === 'playing' && !session.playback.click) {
      // Seek = stop + new scheduled play from the target position.
      scheduledPlay(session, pos, false);
    } else if (session.playback.status !== 'idle') {
      session.playback.pausedPosition = pos;
      session.playback.status = 'paused';
      S.broadcast(session, { type: 'pause', position: pos });
    }
  },

  // Calibration click track — scheduled exactly like a normal track, but every
  // client generates the click buffer locally (nothing to download).
  'click-start'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    scheduledPlay(session, 0, true);
  },

  'click-stop'(ws, msg, session, client) {
    if (client.role !== 'lead') return;
    session.playback = { status: 'idle', trackOffset: 0, startAtServerTime: 0, pausedPosition: 0, click: false };
    S.broadcast(session, { type: 'stop' });
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
  'client-ready', 'play', 'pause', 'stop', 'seek', 'click-start', 'click-stop', 'position-request', 'leave',
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
        // Every session message carries sessionCode; reject mismatches.
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

// ------------------------------------------------------------ heartbeats ----
// Every 5 s: authoritative position broadcast → clients measure their drift.
setInterval(() => {
  for (const session of S.sessions.values()) {
    if (session.playback.status !== 'playing') continue;
    const pos = S.position(session);
    // Auto-stop when a (non-click) track runs past its end.
    if (!session.playback.click && session.track && session.track.duration && pos > session.track.duration + 0.75) {
      session.playback = { status: 'idle', trackOffset: 0, startAtServerTime: 0, pausedPosition: 0, click: false };
      S.broadcast(session, { type: 'stop', ended: true });
      continue;
    }
    S.broadcast(session, {
      type: 'position-heartbeat',
      serverTime: now(),
      trackPosition: pos,
      status: 'playing',
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
  console.log('sYintonia up.');
  console.log(`  local:   http://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  LAN:     http://${ip}:${PORT}   <- share this with the other phones`);
  }
  console.log('  NOTE: production needs HTTPS/WSS (mobile browsers gate some APIs to secure contexts). See README.');
});

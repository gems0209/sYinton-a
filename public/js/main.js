// UI state machine + view routing. All sync logic lives in player/clocksync.
import { WPSocket } from './ws.js';
import { ClockSync } from './clocksync.js';
import { SyncPlayer } from './player.js';
import { createField } from './wavefield.js';
import { loadCalibration, saveCalibration } from './calibration.js';
import { t, apply as applyI18n, setLang, onLangChange } from './i18n.js';
import * as lightshow from './lightshow.js';
import * as jukebox from './jukebox.js';
import * as multizone from './multizone.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ state --
// Storage can THROW (Safari private browsing) — never let it kill the app.
export function safeGet(store, key) {
  try { return store.getItem(key); } catch { return null; }
}
export function safeSet(store, key, value) {
  try { store.setItem(key, value); } catch { /* private mode: no persistence */ }
}
function safeRemove(store, key) {
  try { store.removeItem(key); } catch { /* ignore */ }
}

function getClientId() {
  let id = safeGet(sessionStorage, 'wavepool-client-id');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    safeSet(sessionStorage, 'wavepool-client-id', id);
  }
  return id;
}

const S = {
  clientId: getClientId(),
  role: null,          // 'lead' | 'satellite'
  code: null,
  queue: [],           // [{id, name, duration, size, meta, cues}]
  currentTrackId: null,
  nextTrackId: null,
  prefetch: [],        // track ids the server wants decoded on this device
  repeatMode: 'off',
  shuffle: false,
  transitionMode: 'cut', // MIX: how the queue moves from track to track
  tempo: 1,              // MIX: master tempo (0.92..1.08)
  fx: null,              // MIX: live EQ/filter state (server-owned)
  decks: null,           // DUAL DECK snapshot {on, xfader, A, B} (server-owned)
  jukebox: null,         // JUKEBOX snapshot {open, proposals} (server-owned)
  multizone: null,       // MULTI-ZONE snapshot {on, zones} (server-owned)
  deviceIndex: 0,        // this device's stable index (light show / attribution)
  playback: { status: 'idle' },
  peers: [],
  wakeLock: null,
  forceTimer: null,
};

// MIX MODE module (analysis, deck, mix panel) — lazily imported on the LEAD
// only; satellites never download it, they just render the received effects.
let dj = null;

// Shareable session URL: /5CEG → prefill the code and auto-join as satellite.
function urlSessionCode() {
  const m = location.pathname.match(/^\/([A-Za-z0-9]{4})$/);
  return m ? m[1].toUpperCase() : null;
}

const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WPSocket(`${wsProto}//${location.host}`);
const clock = new ClockSync(ws);
const player = new SyncPlayer(clock);

// exposed for the /debug page and console inspection
window.__wp = { S, ws, clock, player };

// ------------------------------------------------------------------ waves --
const waves = {
  top: createField($('wave-top'), { layers: 3, amplitude: 0.5, opacity: [0.05, 0.14] }),
  home: createField($('wave-home'), { layers: 4, amplitude: 0.6, opacity: [0.06, 0.2] }),
  bottom: createField($('wave-bottom'), { layers: 3, amplitude: 0.5, opacity: [0.05, 0.12] }),
  sat: createField($('wave-sat'), { layers: 4, amplitude: 0.7, opacity: [0.08, 0.2] }),
  arm: createField($('wave-arm'), { layers: 2, amplitude: 0.5, opacity: [0.08, 0.16] }),
};
waves.top.start();
waves.bottom.start();

// ------------------------------------------------------------------ views --
const VIEWS = ['home', 'lead', 'sat', 'debug'];
function showView(name) {
  for (const v of VIEWS) {
    $(`view-${v}`).hidden = v !== name;
  }
  waves.home[name === 'home' ? 'start' : 'stop']();
  waves.sat[name === 'sat' ? 'start' : 'stop']();
  if (name === 'home') {
    S.role = null;
    S.code = null;
    S.decks = null;
    S.jukebox = null;
    S.multizone = null;
    lightshow.hide();              // stop painting + drop the full-screen overlay
    player.setMultizoneActive(false); // back to neutral output
    bufferCache.clear();
    safeRemove(sessionStorage, 'wavepool-session');
    if (location.pathname !== '/debug') history.replaceState(null, '', '/');
  }
}

let msgTimer = null;
function flash(text, sticky = false) {
  const band = $('msgband');
  band.textContent = text;
  band.hidden = false;
  clearTimeout(msgTimer);
  if (!sticky) msgTimer = setTimeout(() => { band.hidden = true; }, 4000);
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function fmtMs(ms) {
  const sign = ms >= 0 ? '+' : '−';
  return `${sign}${String(Math.round(Math.abs(ms))).padStart(3, '0')}MS`;
}

function currentTrack() {
  return S.queue.find((q) => q.id === S.currentTrackId) || null;
}

// ------------------------------------------------------------- arm overlay --
// AudioContext starts suspended (autoplay policy). We arm inside the CREATE /
// JOIN tap when possible; the overlay covers flows with no usable gesture
// (auto-join from a shared URL, reload) and iOS edge cases.
let armPending = null;
$('arm-overlay').addEventListener('click', async () => {
  const armed = await player.arm();
  if (!armed) return; // keep overlay until the context is really running
  $('arm-overlay').hidden = true;
  waves.arm.stop();
  const fn = armPending;
  armPending = null;
  if (fn) fn();
});

function armThen(fn) {
  player.init();
  // Some browsers leave resume() pending until a "better" gesture: don't hang
  // silently, fall through to the overlay after 1.5 s.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 1500));
  Promise.race([player.arm(), timeout]).then((ok) => {
    if (ok) { fn(); return; }
    armPending = fn; // replaces any stale pending action
    $('arm-overlay').hidden = false;
    waves.arm.start();
  });
}

// Self-heal: the session says "playing" but this device is silent (context was
// suspended when the play broadcast arrived, tab was backgrounded, schedule
// failed…). Called on every heartbeat and on foregrounding — re-arms (overlay
// if a gesture is needed) and re-schedules from the authoritative timeline.
function ensurePlaying() {
  if (!S.code || S.playback.status !== 'playing' || S.playback.click) return;
  if (S.decks && S.decks.on) return; // queue rendering is suspended in DECKS mode
  if (player.playing) return;
  const buf = bufferCache.get(S.currentTrackId);
  if (!buf) return; // still downloading/decoding — retried after decode
  armThen(() => {
    if (S.playback.status === 'playing' && !player.playing) {
      player.setBuffer(buf);
      // Clean re-entry onto the authoritative timeline (no transition: the
      // outgoing source this device might have missed is gone anyway).
      schedulePlayback(S.playback.startAtServerTime, S.playback.trackOffset, false, {
        rate: S.playback.rate ?? 1,
        ramp: S.playback.rateRamp || null,
      });
    }
  });
}

async function requestWakeLock() {
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    $('keep-screen').hidden = true;
  } catch {
    $('keep-screen').hidden = false; // fallback: keep the screen on manually
  }
}

// ---------------------------------------------- participatory layer setup ---
// Light show + jukebox run on EVERY role (unlike dj.js): the lead drives them,
// satellites render. Both are small and imported statically.
lightshow.init({ S, ws, player, t, flash });
jukebox.init({ S, ws, player, t, flash });
multizone.init({ S, ws, player, t });

// ------------------------------------------------------------------ i18n ---
applyI18n();
for (const btn of document.querySelectorAll('[data-lang]')) {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
}
onLangChange(() => {
  renderPeers();
  renderStatus();
  renderTrack();
  renderQueue();
  $('btn-cal-lock').textContent = t($('cal').disabled ? 'cal_unlock' : 'cal_lock');
  $('net-status').textContent = ws.open ? t('connected') : t('reconnecting');
  if (dj) dj.onQueue(); // MIX labels re-render
  lightshow.refresh();  // toggle/pattern labels
  jukebox.render();     // jukebox labels
  multizone.render();   // zone labels
});

// ------------------------------------------------------------------ home ---
// First ever visit: the explainer starts open, then stays collapsed.
if (!safeGet(localStorage, 'wavepool-seen')) {
  $('help').open = true;
  safeSet(localStorage, 'wavepool-seen', '1');
}

$('btn-create').addEventListener('click', () => {
  if (!ws.open) flash(t('reconnecting')); // visible feedback; the message is queued
  armThen(() => ws.send({ type: 'create', clientId: S.clientId }));
});

const codeInputs = [...document.querySelectorAll('.code-char')];
function readCode() {
  return codeInputs.map((i) => i.value).join('').toUpperCase();
}
codeInputs.forEach((input, idx) => {
  input.addEventListener('input', () => {
    let v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (v.length > 1) {
      // paste of a full code: distribute across the boxes
      for (let i = 0; i < 4; i++) codeInputs[Math.min(idx + i, 3)].value = v[i] || codeInputs[Math.min(idx + i, 3)].value;
      v = v[0];
      codeInputs[Math.min(idx + v.length, 3)].focus();
    }
    input.value = (input.value.toUpperCase().replace(/[^A-Z0-9]/g, '') || '').slice(0, 1);
    if (input.value && idx < 3) codeInputs[idx + 1].focus();
    if (readCode().length === 4) joinWithCode();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && idx > 0) codeInputs[idx - 1].focus();
    if (e.key === 'Enter') joinWithCode();
  });
});

function joinWithCode() {
  const code = readCode();
  if (code.length !== 4) return;
  if (!ws.open) flash(t('reconnecting'));
  armThen(() => ws.send({ type: 'join', sessionCode: code, clientId: S.clientId }));
}
$('btn-join').addEventListener('click', joinWithCode);

$('logo-home').addEventListener('click', (e) => {
  e.preventDefault();
  leaveSession();
});

// ---------------------------------------------------------------- protocol --
ws.onstatus = (st) => {
  $('net-status').textContent = st === 'open' ? t('connected') : t('reconnecting');
};

ws.on('_open', async () => {
  // Fresh socket (first connect or reconnect): full clock resync, then rejoin.
  await clock.burst(ws._everSynced ? 10 : 20);
  ws._everSynced = true;
  clock.startPeriodic();
  // Join priority: shared URL (/5CEG) wins over a previously saved session.
  const target = urlSessionCode() || safeGet(sessionStorage, 'wavepool-session');
  if (target && !S.code) {
    armThen(() => ws.send({ type: 'join', sessionCode: target, clientId: S.clientId }));
  } else if (S.code) {
    ws.send({ type: 'join', sessionCode: S.code, clientId: S.clientId });
  }
});

ws.on('created', (msg) => {
  enterSession(msg.sessionCode, 'lead', null, { status: 'idle' }, []);
});

ws.on('joined', (msg) => {
  if (typeof msg.deviceIndex === 'number') S.deviceIndex = msg.deviceIndex;
  enterSession(msg.sessionCode, msg.role, msg.queue, msg.playback, msg.peers);
  // Late join / reconnect: adopt the current light-show look, request pool and
  // spatial-zone assignment (this device applies its own zone).
  if (msg.lightshow) lightshow.set(msg.lightshow);
  jukebox.apply(msg.jukebox || { open: false, proposals: [] });
  multizone.apply(msg.multizone || { on: false, zones: {} });
});

ws.on('error', (msg) => {
  if (msg.code === 'SESSION_NOT_FOUND') {
    flash(t('err_not_found'));
    safeRemove(sessionStorage, 'wavepool-session');
    history.replaceState(null, '', '/'); // drop a dead shared URL
    codeInputs.forEach((i) => { i.value = ''; });
    codeInputs[0].focus();
  } else if (msg.code === 'NOT_READY') {
    flash(t('err_not_ready'));
  } else if (msg.code === 'NO_TRACK') {
    flash(t('err_no_track'));
  } else if (msg.code !== 'NO_SESSION') {
    flash(`ERR: ${msg.text || msg.code}`);
  }
});

ws.on('peer-update', (msg) => {
  S.peers = msg.peers;
  const me = msg.peers.find((p) => p.id === S.clientId);
  if (me) S.deviceIndex = me.deviceIndex; // used by the light show's spatial patterns
  renderPeers();
  multizone.render(); // the assignment grid tracks who's connected
});

ws.on('queue-update', (msg) => {
  applyQueueUpdate(msg);
});

// Track change (queue advance, skip, seek, play): the server fixed the start
// instant; swap the buffer and schedule. The outgoing source keeps playing
// until the handover (gapless cut) or across the whole crossfade (MIX
// transitions ride in msg.transition; rate/rateRamp carry beatmatch tempo).
ws.on('track-change', (msg) => {
  S.playback = {
    status: 'playing',
    click: msg.click,
    startAtServerTime: msg.startAtServerTime,
    trackOffset: msg.trackOffset,
    rate: msg.rate ?? 1,
    rateRamp: msg.rateRamp || null,
  };
  if (!msg.click) S.currentTrackId = msg.trackId;
  const buf = msg.click ? null : bufferCache.get(msg.trackId);
  if (msg.click || buf) {
    if (buf) player.setBuffer(buf);
    schedulePlayback(msg.startAtServerTime, msg.trackOffset, !!msg.click, {
      rate: msg.rate ?? 1,
      ramp: msg.rateRamp || null,
      transition: msg.transition || null,
    });
  }
  // else: still decoding — ensurePlaying() fires after the decode completes.
  renderStatus();
  renderQueue();
});

// MIX: master tempo changed mid-play — the server re-anchored its timeline,
// every client glides playbackRate at the same instant.
ws.on('rate-change', (msg) => {
  if (typeof msg.rate !== 'number') return;
  if (S.playback.status === 'playing') {
    S.playback.rate = msg.rate;
    S.playback.rateRamp = null;
    S.playback.trackOffset = msg.trackOffset;
    S.playback.startAtServerTime = msg.applyAtServerTime;
  }
  player.setRate(msg.rate, msg.trackOffset, msg.applyAtServerTime);
});

// MIX: live EQ/filter — rendered identically by lead and satellites.
ws.on('fx-update', (msg) => {
  if (!msg.fx) return;
  S.fx = msg.fx;
  const applyCtx = player.ctx
    ? player.ctxTimeFor(clock.serverToLocal(msg.applyAtServerTime || 0))
    : 0;
  player.setFx(msg.fx, applyCtx);
  if (dj) dj.onFx();
});

// Light show: the lead set a new "look"; render it (timing stays local).
ws.on('lightshow-update', (msg) => lightshow.set(msg.lightshow));

// Jukebox: the request pool changed (open/close, new proposal, vote, approve).
ws.on('jukebox-update', (msg) => jukebox.apply(msg.jukebox));

// Multi-zone: the mode toggled or a device's zone changed. Each client applies
// its own zone; the lead re-renders the assignment grid.
ws.on('multizone-update', (msg) => multizone.apply(msg.multizone));

// ------------------------------------------------------------- DUAL DECK --
// One reconciler for everything deck-related: every decks-update (and the
// decks snapshot inside queue-update/joined) describes the authoritative
// state of both timelines; each channel is nudged to match. The same code
// path therefore serves live updates, late join and self-heal. A `glide`
// hint marks pitch-only changes so the source glides instead of restarting.
const deckTrack = { A: null, B: null }; // trackId currently on each channel

function reconcileDeck(id, d, glide) {
  if (d.status === 'playing') {
    if (glide && player.deckPlaying(id)) {
      player.deckSetRate(id, glide.rate, glide.trackOffset, glide.applyAtServerTime);
      return;
    }
    const cur = player.deckLastMsg(id);
    const matches = player.deckPlaying(id) && cur
      && Math.abs(cur.startAtServerTime - d.startAtServerTime) < 1
      && Math.abs(cur.trackOffset - d.trackOffset) < 1e-6
      && cur.rate === d.rate;
    if (matches) { deckTrack[id] = d.trackId; return; } // includes seamless adoption
    const buf = d.trackId ? bufferCache.get(d.trackId) : null;
    if (!buf) return; // still decoding — healDecks() re-runs after the decode
    armThen(() => {
      const dd = S.decks && S.decks[id];
      if (!S.decks || !S.decks.on || !dd || dd.status !== 'playing') return;
      const b = bufferCache.get(dd.trackId);
      if (!b) return;
      player.deckSetBuffer(id, b);
      deckTrack[id] = dd.trackId;
      player.deckScheduleAt(id, dd.startAtServerTime, dd.trackOffset, {
        rate: dd.rate,
        fadeIn: player.deckPlaying(id) ? 0.06 : 0, // micro-seek/sync lands as a short crossfade
      });
    });
  } else if (d.status === 'paused' || d.status === 'ended') {
    if (player.deckPlaying(id)) player.deckPause(id, d.pausedPosition);
    deckTrack[id] = d.trackId;
  } else { // empty | loaded
    if (player.deckPlaying(id)) player.deckStop(id);
    deckTrack[id] = d.trackId;
  }
}

function applyDecks(snapshot, glide = null) {
  if (!snapshot) return;
  const prevOn = !!(S.decks && S.decks.on);
  S.decks = snapshot;
  if (snapshot.on !== prevOn) player.setDecksActive(snapshot.on);
  if (snapshot.on) {
    if (snapshot.on !== prevOn) player.setXfader(snapshot.xfader);
    for (const id of ['A', 'B']) reconcileDeck(id, snapshot[id], glide && glide.deck === id ? glide : null);
    if (S.playback.status === 'playing' && !S.playback.click) {
      // The queue timeline was adopted (or stopped) server-side.
      S.playback = { status: 'idle' };
    }
  } else {
    deckTrack.A = null;
    deckTrack.B = null;
  }
  renderStatus();
  renderTrack();
  renderQueue();
  if (dj) dj.onDecks();
}

function healDecks() {
  if (!S.decks || !S.decks.on) return;
  for (const id of ['A', 'B']) reconcileDeck(id, S.decks[id], null);
}

ws.on('decks-update', (msg) => applyDecks(msg.decks, msg.glide || null));

ws.on('xfader-update', (msg) => {
  if (typeof msg.x !== 'number') return;
  if (S.decks) S.decks.xfader = msg.x;
  const applyCtx = player.ctx
    ? player.ctxTimeFor(clock.serverToLocal(msg.applyAtServerTime || 0))
    : 0;
  player.setXfader(msg.x, applyCtx);
  if (dj) dj.onXfader();
});

ws.on('pause', (msg) => {
  S.playback = { status: 'paused', position: msg.position };
  player.pauseAt(msg.position);
  renderStatus();
});

ws.on('stop', () => {
  S.playback = { status: 'idle' };
  player.stopLocal();
  player.lastPos = 0;
  renderStatus();
});

ws.on('position-heartbeat', (msg) => {
  if (msg.decks && msg.decks.on) {
    // DECKS mode: per-channel drift against both authoritative timelines.
    for (const id of ['A', 'B']) {
      const d = msg.decks[id];
      if (d && d.status === 'playing') {
        player.deckCheckDrift(id, msg.serverTime, d.position, d.rate);
      }
      if (S.decks && S.decks[id]) {
        S.decks[id].status = d.status;
        S.decks[id].rate = d.rate;
      }
    }
    healDecks();
    renderTech();
    return;
  }
  if (msg.status && msg.status !== 'playing') return;
  player.checkDrift(msg.serverTime, msg.trackPosition, msg.rate ?? 1, !!msg.rampActive);
  ensurePlaying();
  renderTech();
});

ws.on('session-ended', () => {
  player.stopLocal();
  showView('home');
  flash(t('session_ended'));
});

// Schedule against the shared clock; if the clock is not synced yet (play can
// race the first burst), sync first. Then ask for an immediate authoritative
// position so any residual error is corrected now, not at the next 5 s beat.
async function schedulePlayback(startAtServerTime, trackOffset, click, opts = {}) {
  if (!clock.synced) await clock.burst(10);
  player.scheduleAt(startAtServerTime, trackOffset, click, 0, opts);
  if (!click) ws.send({ type: 'position-request', sessionCode: S.code });
}

// -------------------------------------------------------- queue / prefetch --
// Decoded AudioBuffers are heavy (~10 MB/min): keep at most the tracks the
// server asks for (current + next, shuffle/repeat already resolved) and drop
// the rest when the queue moves on.
const bufferCache = new Map(); // trackId -> AudioBuffer
const decoding = new Set();

function applyQueueUpdate(msg) {
  S.queue = msg.queue;
  S.currentTrackId = msg.currentTrackId;
  S.nextTrackId = msg.nextTrackId;
  S.prefetch = msg.prefetch || [];
  S.repeatMode = msg.repeatMode;
  S.shuffle = msg.shuffle;
  if (msg.transitionMode) S.transitionMode = msg.transitionMode;
  if (typeof msg.tempo === 'number') S.tempo = msg.tempo;
  if (msg.fx && JSON.stringify(msg.fx) !== JSON.stringify(S.fx)) {
    // Late join / reconnect: pick up the session's live EQ/filter state.
    S.fx = msg.fx;
    player.setFx(msg.fx, 0);
  }
  renderQueue();
  renderTrack();
  renderStatus();
  ensureBuffers();
  if (msg.decks) applyDecks(msg.decks); // snapshot rides in every queue-update
  if (dj) dj.onQueue();
}

async function ensureBuffers() {
  if (!S.code) return;
  const want = new Set(S.prefetch);
  for (const id of [...bufferCache.keys()]) {
    if (!want.has(id)) bufferCache.delete(id); // free memory as the queue moves
  }
  for (const id of want) {
    if (bufferCache.has(id) || decoding.has(id)) continue;
    decoding.add(id);
    renderQueue();
    try {
      player.init();
      const buf = await player.decode(`/audio/${S.code}/${id}`);
      decoding.delete(id);
      if (!S.prefetch.includes(id)) continue; // queue moved meanwhile
      bufferCache.set(id, buf);
      ws.send({ type: 'client-ready', sessionCode: S.code, trackId: id, duration: buf.duration });
      renderQueue();
      renderTrack();
      ensurePlaying(); // late join / track-change that was waiting on this decode
      healDecks();     // same, for deck timelines
    } catch (err) {
      decoding.delete(id);
      flash(`ERR: ${String(err.message).toUpperCase()}`);
    }
  }
  renderStatus();
}

// ----------------------------------------------------------- session flow --
function enterSession(code, role, queueSnapshot, playback, peers) {
  S.code = code;
  S.role = role;
  S.peers = peers || [];
  S.playback = playback || { status: 'idle' };
  safeSet(sessionStorage, 'wavepool-session', code);
  // The address bar becomes the invite: share the URL and whoever opens it
  // joins this session as a satellite.
  history.replaceState(null, '', `/${code}`);

  if (role === 'lead') {
    $('lead-code').textContent = code;
    showView('lead');
    // MIX MODE tools load only here — satellites never fetch the module.
    if (!dj) {
      import('./dj.js')
        .then((m) => { dj = m; dj.init({ S, ws, player, bufferCache, flash }); })
        .catch(() => { /* MIX tools are optional: playback works without them */ });
    } else {
      dj.onQueue();
    }
  } else {
    $('sat-code').textContent = code;
    showView('sat');
  }
  if (queueSnapshot) applyQueueUpdate(queueSnapshot);
  else { S.queue = []; S.currentTrackId = null; S.nextTrackId = null; S.prefetch = []; renderQueue(); }
  if (playback && playback.status === 'paused') player.lastPos = playback.position || 0;
  renderPeers();
  renderTrack();
  renderStatus();
  requestWakeLock();
  jukebox.onEnter();   // re-assert saved nickname + render the request pool
  lightshow.refresh(); // role is known now → correct overlay/controls
  multizone.render();  // render the zone toggle / badge for this role
  // Late join into running playback: handled by ensureBuffers → ensurePlaying.
}

function leaveSession() {
  if (S.code) ws.send({ type: 'leave', sessionCode: S.code });
  player.stopLocal();
  player.lastPos = 0;
  showView('home');
}
$('btn-leave-lead').addEventListener('click', leaveSession);
$('btn-leave-sat').addEventListener('click', leaveSession);

// ------------------------------------------------------------------ lead ---
const fileInput = $('file-input');
const dropzone = $('dropzone');
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles([...fileInput.files]);
  fileInput.value = '';
});

// Multi-file upload: sequential (keeps the selection order in the queue), one
// invalid file is skipped with a message without blocking the others. Tracks
// can be added at any time — the queue keeps playing.
async function uploadFiles(files) {
  let n = 0;
  for (const file of files) {
    n++;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (file.size > 60 * 1024 * 1024 || !['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) {
      flash(`${t('err_upload')} — ${file.name.toUpperCase()}`);
      continue;
    }
    $('drop-label').textContent = `${t('uploading')} ${n}/${files.length}`;
    try {
      const fd = new FormData();
      fd.append('audio', file);
      const res = await fetch(`/upload/${S.code}`, { method: 'POST', body: fd });
      if (!res.ok) throw new Error((await res.json()).error || 'UPLOAD');
      // server broadcasts queue-update (to us too)
    } catch (err) {
      flash(`ERR: ${String(err.message).toUpperCase()} — ${file.name.toUpperCase()}`);
    }
  }
  $('drop-label').textContent = t('drop');
}

$('btn-play').addEventListener('click', () => {
  const pos = S.playback.status === 'paused' ? (S.playback.position || 0) : 0;
  ws.send({ type: 'play', sessionCode: S.code, position: pos });
});
$('btn-force').addEventListener('click', () => {
  ws.send({ type: 'play', sessionCode: S.code, position: 0, force: true });
});
$('btn-pause').addEventListener('click', () => ws.send({ type: 'pause', sessionCode: S.code }));
$('btn-stop').addEventListener('click', () => ws.send({ type: 'stop', sessionCode: S.code }));
$('btn-prev').addEventListener('click', () => ws.send({ type: 'skip-prev', sessionCode: S.code }));
$('btn-next').addEventListener('click', () => ws.send({ type: 'skip-next', sessionCode: S.code }));

$('btn-repeat').addEventListener('click', () => {
  const next = { off: 'all', all: 'one', one: 'off' }[S.repeatMode] || 'off';
  ws.send({ type: 'set-repeat', sessionCode: S.code, mode: next });
});
$('btn-shuffle').addEventListener('click', () => {
  ws.send({ type: 'set-shuffle', sessionCode: S.code, on: !S.shuffle });
});

$('btn-click').addEventListener('click', () => {
  if (S.playback.click) {
    ws.send({ type: 'click-stop', sessionCode: S.code });
  } else {
    ws.send({ type: 'click-start', sessionCode: S.code });
  }
});

const progress = $('progress');
progress.addEventListener('click', (e) => {
  const track = currentTrack();
  if (S.role !== 'lead' || !track || !track.duration) return;
  if (S.decks && S.decks.on) return; // seek the decks from their own strips
  const r = progress.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  ws.send({ type: 'seek', sessionCode: S.code, position: frac * track.duration });
});

// ------------------------------------------------------------- rendering ---
function statusKey() {
  if (S.decks && S.decks.on) return 'st_decks';
  if (S.playback.click) return 'st_click';
  if (S.playback.status === 'playing') {
    // Playing per the server but this device hasn't decoded the track yet.
    if (!S.playback.click && !bufferCache.get(S.currentTrackId)) return 'st_buffering';
    return 'st_playing';
  }
  if (S.playback.status === 'paused') return 'st_paused';
  if (decoding.size > 0) return 'st_loading';
  if (S.role === 'satellite' && S.queue.length === 0) return 'st_waiting';
  return 'st_idle';
}

function renderStatus() {
  const st = t(statusKey());
  $('lead-status').textContent = st;
  $('sat-status').textContent = st;
  const decksLive = !!(S.decks && S.decks.on
    && (S.decks.A.status === 'playing' || S.decks.B.status === 'playing'));
  const playing = S.playback.status === 'playing' || decksLive;
  $('sat-waiting').hidden = !(S.role === 'satellite' && !playing && S.queue.length === 0);
  const an = playing ? player.analyser : null;
  waves.sat.setAnalyser(an);
  waves.top.setAnalyser(an);
  updateTransport();
}

function renderTrack() {
  if (S.decks && S.decks.on) {
    // DECKS mode: show what sits on each deck instead of the queue track.
    const nameOf = (id) => {
      const tr = S.queue.find((q) => q.id === S.decks[id].trackId);
      return tr ? tr.name.toUpperCase() : '—';
    };
    const line = `A: ${nameOf('A')} · B: ${nameOf('B')}`;
    $('lead-track').textContent = line;
    $('sat-track').textContent = line;
    $('time-dur').textContent = fmtTime(0);
    return;
  }
  const track = currentTrack();
  $('lead-track').textContent = track ? track.name.toUpperCase() : t('no_track');
  $('sat-track').textContent = track ? track.name.toUpperCase() : '';
  $('time-dur').textContent = fmtTime(track?.duration || 0);
}

function allReady() {
  return S.peers.every((p) => !p.connected || p.ready);
}

function renderPeers() {
  const connected = S.peers.filter((p) => p.connected);
  $('lead-count').textContent = String(connected.length).padStart(2, '0');
  const ul = $('device-list');
  ul.innerHTML = '';
  for (const p of S.peers) {
    const li = document.createElement('li');
    const who = p.role === 'lead' ? t('lead') : t('satellite');
    const me = p.id === S.clientId ? ` [${t('you')}]` : '';
    // Nickname when set, else the short id. Built with textContent (user input).
    const label = (p.name || p.id.slice(0, 4)).toUpperCase();
    const state = !p.connected ? '· · ·' : (p.ready ? t('st_ready') : (S.queue.length ? t('st_loading') : '—'));
    const left = document.createElement('span');
    left.textContent = `${who} ${label}${me}`;
    const right = document.createElement('span');
    right.className = p.ready ? 'ready' : 'dim';
    right.textContent = state;
    li.appendChild(left);
    li.appendChild(right);
    if (!p.connected) li.classList.add('dim');
    ul.appendChild(li);
  }
  updateTransport();
}

// Queue panel: lead gets reorder/remove controls, satellites read-only.
// ▶ marks the playing track, › the next one (shuffle/repeat already resolved
// by the server).
function renderQueue() {
  for (const listId of ['queue-list', 'sat-queue-list']) {
    const ul = $(listId);
    if (!ul) continue;
    const isLead = listId === 'queue-list' && S.role === 'lead';
    ul.innerHTML = '';
    S.queue.forEach((track, i) => {
      const li = document.createElement('li');
      li.className = 'queue-row';
      if (track.id === S.currentTrackId) li.classList.add('active');
      const mark = track.id === S.currentTrackId ? '▶' : (track.id === S.nextTrackId ? '›' : '');
      const state = bufferCache.has(track.id) ? '' : (decoding.has(track.id) ? '…' : '');
      const dur = track.duration ? fmtTime(track.duration) : '--:--';
      // BPM chip from the lead's analysis (MIX MODE); low confidence shows ~.
      const bpm = track.meta && track.meta.bpm
        ? `${track.meta.confidence < 0.2 ? '~' : ''}${Math.round(track.meta.bpm)}`
        : '';
      li.innerHTML =
        `<span class="q-mark">${mark}</span>` +
        `<span class="q-num num">${String(i + 1).padStart(2, '0')}</span>` +
        `<span class="q-name">${track.name.toUpperCase()}</span>` +
        `<span class="q-state">${state}</span>` +
        (bpm ? `<span class="q-bpm num">${bpm}</span>` : '') +
        `<span class="q-dur num">${dur}</span>`;
      if (isLead) {
        const controls = document.createElement('span');
        controls.className = 'q-controls';
        const mk = (label, aria, fn, disabled = false) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.setAttribute('aria-label', aria);
          b.disabled = disabled;
          b.addEventListener('click', fn);
          controls.appendChild(b);
        };
        if (S.decks && S.decks.on) {
          // DECKS mode: each row can be thrown onto a deck (server refuses if
          // that deck is playing). Reorder is meaningless here, remove stays.
          const onDeck = (id) => S.decks[id].trackId === track.id;
          const mkDeck = (id) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = id;
            b.setAttribute('aria-label', `load deck ${id}`);
            if (onDeck(id)) b.classList.add('on');
            b.addEventListener('click', () => ws.send({ type: 'deck-load', sessionCode: S.code, deck: id, trackId: track.id }));
            controls.appendChild(b);
          };
          mkDeck('A');
          mkDeck('B');
          mk('✕', 'remove', () => ws.send({ type: 'queue-remove', sessionCode: S.code, trackId: track.id }));
        } else {
          mk('↑', 'up', () => ws.send({ type: 'queue-reorder', sessionCode: S.code, from: i, to: i - 1 }), i === 0);
          mk('↓', 'down', () => ws.send({ type: 'queue-reorder', sessionCode: S.code, from: i, to: i + 1 }), i === S.queue.length - 1);
          mk('✕', 'remove', () => ws.send({ type: 'queue-remove', sessionCode: S.code, trackId: track.id }));
        }
        li.appendChild(controls);
      }
      ul.appendChild(li);
    });
  }
  const count = `${String(S.queue.length).padStart(2, '0')}`;
  $('queue-count').textContent = count;
  $('sat-queue-count').textContent = count;
  $('queue-panel').hidden = S.queue.length === 0;
  $('sat-queue-panel').hidden = S.queue.length === 0;
  updateTransport();
}

// Lead transport gating: PLAY only when every connected client has decoded
// the track it would start; after 10 s of waiting, expose PLAY ANYWAY.
function updateTransport() {
  if (S.role !== 'lead') return;
  const hasQueue = S.queue.length > 0;
  const ready = hasQueue && allReady();
  const decksOn = !!(S.decks && S.decks.on);
  // DECKS mode: the queue transport is the server's to refuse anyway — grey
  // it out so the UI tells the truth.
  $('btn-play').disabled = decksOn || !ready || S.playback.status === 'playing';
  $('btn-pause').disabled = decksOn || S.playback.status !== 'playing' || !!S.playback.click;
  $('btn-stop').disabled = decksOn || S.playback.status === 'idle';
  $('btn-prev').disabled = decksOn || !hasQueue || !!S.playback.click;
  $('btn-next').disabled = decksOn || !hasQueue || !!S.playback.click;
  $('btn-click').disabled = decksOn;
  $('btn-repeat').textContent = `${t('repeat')}: ${t('rep_' + S.repeatMode)}`;
  $('btn-repeat').classList.toggle('on', S.repeatMode !== 'off');
  $('btn-shuffle').textContent = `${t('shuffle')}: ${S.shuffle ? t('on') : t('off')}`;
  $('btn-shuffle').classList.toggle('on', S.shuffle);
  $('btn-click').textContent = S.playback.click ? t('click_stop') : t('click_start');
  $('click-hint').hidden = !S.playback.click;

  clearTimeout(S.forceTimer);
  if (hasQueue && !ready) {
    S.forceTimer = setTimeout(() => { $('btn-force').hidden = false; }, 10000);
  } else {
    $('btn-force').hidden = true;
  }
}

// Progress bar + technical readout, 4×/s (cheap; the audio clock is the truth).
// Also a stall watchdog: iOS can freeze audioContext.currentTime (silent
// switch / route changes) while state still reads 'running' — the UI says
// PLAYING but nothing moves. Detect the frozen clock and self-heal.
let stallClock = -1;
let stallTicks = 0;
setInterval(() => {
  if (player.anyPlaying && player.ctx) {
    if (player.ctx.currentTime === stallClock) {
      stallTicks++;
      if (stallTicks >= 10) { // frozen for ~2.5 s
        stallTicks = 0;
        // Drop the dead sources; the heal paths re-arm and re-schedule.
        player.ch[0].playing = false;
        player.ch[1].playing = false;
        ensurePlaying();
        healDecks();
      }
    } else {
      stallClock = player.ctx.currentTime;
      stallTicks = 0;
    }
  }
  const track = currentTrack();
  if (S.role === 'lead' && track?.duration && !(S.decks && S.decks.on)) {
    const pos = S.playback.status === 'playing' ? player.idealPosition()
      : (S.playback.status === 'paused' ? (S.playback.position || 0) : player.lastPos);
    const frac = Math.min(1, Math.max(0, pos / track.duration));
    $('progress-fill').style.width = `${frac * 100}%`;
    progress.setAttribute('aria-valuenow', Math.round(frac * 100));
    $('time-cur').textContent = fmtTime(pos);
  }
  if (dj) dj.tick();
  lightshow.tick(); // repaint fallback (throttled/backgrounded webviews)
  renderTech();
}, 250);

// The app exhibits its own mechanics, like VU meters on a mixer.
function renderTech() {
  if (!S.code) return;
  const line = [
    `OFFSET: ${fmtMs(clock.offset)}`,
    `RTT: ${Math.round(clock.medianRtt)}MS`,
    `DRIFT: ${fmtMs(player.lastDrift * 1000)}`,
  ].join(' · ');
  $('lead-tech').textContent = line;
  $('sat-tech').textContent = line;
}

// -------------------------------------------------------------- satellite --
const vol = $('vol');
vol.addEventListener('input', () => {
  $('vol-val').textContent = vol.value;
  player.setVolume(vol.value / 100);
});

const cal = $('cal');
cal.value = loadCalibration();
$('cal-val').textContent = fmtMs(cal.value);
player.calibrationMs = Number(cal.value);

// The calibration slider is LOCKED by default — people nudge it by accident.
// Tap SBLOCCA to edit; it re-locks itself after 15 s without input.
const calLockBtn = $('btn-cal-lock');
let calRelockTimer = null;
function setCalLocked(locked) {
  cal.disabled = locked;
  calLockBtn.textContent = t(locked ? 'cal_unlock' : 'cal_lock');
  calLockBtn.classList.toggle('on', !locked);
  clearTimeout(calRelockTimer);
  if (!locked) calRelockTimer = setTimeout(() => setCalLocked(true), 15000);
}
calLockBtn.addEventListener('click', () => setCalLocked(!cal.disabled));
setCalLocked(true); // locked at boot, label in the active language

cal.addEventListener('input', () => {
  $('cal-val').textContent = fmtMs(cal.value);
  // still editing: push the auto-relock forward
  clearTimeout(calRelockTimer);
  calRelockTimer = setTimeout(() => setCalLocked(true), 15000);
});
cal.addEventListener('change', () => {
  const ms = Number(cal.value);
  saveCalibration(ms);
  player.setCalibration(ms); // soft re-anchor if playing
});

// ------------------------------------------------- background / foreground --
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) return;
  // Back to foreground: resume audio, resync the clock, realign position.
  if (player.ctx) { try { await player.ctx.resume(); } catch { /* ignore */ } }
  if (S.wakeLock === null || S.wakeLock?.released) requestWakeLock();
  if (ws.open) {
    await clock.burst(5);
    if (S.code) ws.send({ type: 'position-request', sessionCode: S.code });
  }
  ensurePlaying();
  healDecks();
});

// Shared URL: show the code in the boxes while the auto-join runs.
{
  const uc = urlSessionCode();
  if (uc) uc.split('').forEach((ch, i) => { codeInputs[i].value = ch; });
}

// ------------------------------------------------------------------ debug --
if (location.pathname === '/debug') {
  showView('debug');
  waves.home.stop();
  const upd = () => {
    $('dbg-offset').textContent = `${clock.offset.toFixed(2)} MS`;
    $('dbg-rtt').textContent = `${clock.medianRtt.toFixed(2)} MS`;
    $('dbg-unc').textContent = clock.uncertainty === Infinity ? '—' : `±${clock.uncertainty.toFixed(2)} MS`;
    $('dbg-drift').textContent = `${(player.lastDrift * 1000).toFixed(1)} MS`;
    $('dbg-outlat').textContent = player.ctx ? `${(player.outputLatency() * 1000).toFixed(1)} MS` : '— (AUDIO NOT ARMED)';
  };
  setInterval(upd, 500);
  $('btn-resync').addEventListener('click', async () => {
    player.init();
    await player.arm();
    await clock.burst(20);
    upd();
  });
}

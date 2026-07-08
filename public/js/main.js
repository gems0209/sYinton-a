// UI state machine + view routing. All sync logic lives in player/clocksync.
import { WPSocket } from './ws.js';
import { ClockSync } from './clocksync.js';
import { SyncPlayer } from './player.js';
import { createField } from './wavefield.js';
import { loadCalibration, saveCalibration } from './calibration.js';
import { t, apply as applyI18n, setLang, onLangChange } from './i18n.js';

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
  track: null,         // { name, duration }
  playback: { status: 'idle' },
  peers: [],
  loading: false,      // this client is downloading/decoding
  wakeLock: null,
  forceTimer: null,
};

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
    const el = $(`view-${v === 'sat' ? 'sat' : v}`);
    el.hidden = v !== name;
  }
  waves.home[name === 'home' ? 'start' : 'stop']();
  waves.sat[name === 'sat' ? 'start' : 'stop']();
  if (name === 'home') {
    S.role = null;
    S.code = null;
    safeRemove(sessionStorage, 'wavepool-session');
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

// ------------------------------------------------------------- arm overlay --
// AudioContext starts suspended (autoplay policy). We arm inside the CREATE /
// JOIN tap when possible; the overlay covers flows with no usable gesture
// (auto-rejoin after reload) and iOS edge cases.
function armThen(fn) {
  player.init();
  // Some browsers leave resume() pending until a "better" gesture: don't hang
  // silently, fall through to the overlay after 1.5 s.
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 1500));
  Promise.race([player.arm(), timeout]).then((ok) => {
    if (ok) { fn(); return; }
    const ov = $('arm-overlay');
    ov.hidden = false;
    waves.arm.start();
    const onTap = async () => {
      const armed = await player.arm();
      if (!armed) return; // keep overlay until the context is really running
      ov.hidden = true;
      waves.arm.stop();
      ov.removeEventListener('click', onTap);
      fn();
    };
    ov.addEventListener('click', onTap);
  });
}

async function requestWakeLock() {
  try {
    S.wakeLock = await navigator.wakeLock.request('screen');
    $('keep-screen').hidden = true;
  } catch {
    // Fallback: tell the user to keep the screen on.
    $('keep-screen').hidden = false;
  }
}

// ------------------------------------------------------------------ i18n ---
applyI18n();
for (const btn of document.querySelectorAll('[data-lang]')) {
  btn.addEventListener('click', () => setLang(btn.dataset.lang));
}
onLangChange(() => {
  renderPeers();
  renderStatus();
  renderTrack();
  $('net-status').textContent = ws.open ? t('connected') : t('reconnecting');
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
  const saved = safeGet(sessionStorage, 'wavepool-session');
  if (saved && !S.code) {
    // Auto-rejoin after reload — needs the arm overlay (no gesture available).
    armThen(() => ws.send({ type: 'join', sessionCode: saved, clientId: S.clientId }));
  } else if (S.code) {
    ws.send({ type: 'join', sessionCode: S.code, clientId: S.clientId });
  }
});

ws.on('created', (msg) => {
  enterSession(msg.sessionCode, 'lead', null, { status: 'idle' }, []);
});

ws.on('joined', (msg) => {
  enterSession(msg.sessionCode, msg.role, msg.track, msg.playback, msg.peers);
});

ws.on('error', (msg) => {
  if (msg.code === 'SESSION_NOT_FOUND') {
    flash(t('err_not_found'));
    safeRemove(sessionStorage, 'wavepool-session');
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
  renderPeers();
});

ws.on('track-loaded', (msg) => {
  S.track = { name: msg.trackName, duration: null };
  S.playback = { status: 'idle' };
  player.stopLocal();
  player.lastPos = 0;
  loadTrack(msg.url);
  renderTrack();
  renderStatus();
});

ws.on('play', (msg) => {
  S.playback = { status: 'playing', click: msg.click, startAtServerTime: msg.startAtServerTime, trackOffset: msg.trackOffset };
  schedulePlayback(msg.startAtServerTime, msg.trackOffset, !!msg.click);
  renderStatus();
});

// Schedule against the shared clock; if the clock is not synced yet (play can
// race the first burst), sync first. Then ask for an immediate authoritative
// position so any residual error is corrected now, not at the next 5 s beat.
async function schedulePlayback(startAtServerTime, trackOffset, click) {
  if (!clock.synced) await clock.burst(10);
  player.scheduleAt(startAtServerTime, trackOffset, click);
  if (!click) ws.send({ type: 'position-request', sessionCode: S.code });
}

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
  if (msg.status && msg.status !== 'playing') return;
  player.checkDrift(msg.serverTime, msg.trackPosition);
  renderTech();
});

ws.on('session-ended', () => {
  player.stopLocal();
  showView('home');
  flash(t('session_ended'));
});

// ----------------------------------------------------------- session flow --
function enterSession(code, role, track, playback, peers) {
  S.code = code;
  S.role = role;
  S.peers = peers || [];
  S.track = track ? { name: track.name, duration: track.duration } : null;
  S.playback = playback || { status: 'idle' };
  safeSet(sessionStorage, 'wavepool-session', code);

  if (role === 'lead') {
    $('lead-code').textContent = code;
    showView('lead');
  } else {
    $('sat-code').textContent = code;
    showView('sat');
  }
  renderPeers();
  renderTrack();
  renderStatus();
  requestWakeLock();

  if (track) {
    // Late join: download + decode, then sync into the running playback.
    loadTrack(track.url, playback);
  }
}

function leaveSession() {
  if (S.code) ws.send({ type: 'leave', sessionCode: S.code });
  player.stopLocal();
  player.lastPos = 0;
  showView('home');
}
$('btn-leave-lead').addEventListener('click', leaveSession);
$('btn-leave-sat').addEventListener('click', leaveSession);

async function loadTrack(url, playbackAfter = null) {
  S.loading = true;
  renderStatus();
  try {
    const duration = await player.load(url);
    if (S.track) S.track.duration = duration;
    S.loading = false;
    ws.send({ type: 'client-ready', sessionCode: S.code, duration });
    renderTrack();
    renderStatus();
    // Late join into a running track: compute current position from the
    // shared clock and start immediately at the right point.
    const pb = playbackAfter || S.playback;
    if (pb.status === 'playing' && !pb.click) {
      schedulePlayback(pb.startAtServerTime, pb.trackOffset, false);
    } else if (pb.status === 'paused') {
      player.lastPos = pb.position || 0;
    }
  } catch (err) {
    S.loading = false;
    flash(`ERR: ${err.message.toUpperCase()}`);
    renderStatus();
  }
}

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
  if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
  fileInput.value = '';
});

async function uploadFile(file) {
  if (file.size > 60 * 1024 * 1024) { flash(t('err_upload')); return; }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) { flash(t('err_upload')); return; }
  $('drop-label').textContent = t('uploading');
  try {
    const fd = new FormData();
    fd.append('audio', file);
    const res = await fetch(`/upload/${S.code}`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || 'UPLOAD');
    // server broadcasts track-loaded (to us too)
  } catch (err) {
    flash(`ERR: ${String(err.message).toUpperCase()}`);
  }
  $('drop-label').textContent = t('drop');
}

$('btn-play').addEventListener('click', () => {
  const pos = S.playback.status === 'paused' ? (S.playback.position || 0) : player.idealPosition();
  ws.send({ type: 'play', sessionCode: S.code, position: S.playback.status === 'idle' ? 0 : pos });
});
$('btn-force').addEventListener('click', () => {
  ws.send({ type: 'play', sessionCode: S.code, position: 0, force: true });
});
$('btn-pause').addEventListener('click', () => ws.send({ type: 'pause', sessionCode: S.code }));
$('btn-stop').addEventListener('click', () => ws.send({ type: 'stop', sessionCode: S.code }));

$('btn-click').addEventListener('click', () => {
  if (S.playback.click) {
    ws.send({ type: 'click-stop', sessionCode: S.code });
  } else {
    ws.send({ type: 'click-start', sessionCode: S.code });
  }
});

const progress = $('progress');
progress.addEventListener('click', (e) => {
  if (S.role !== 'lead' || !S.track || !S.track.duration) return;
  const r = progress.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  ws.send({ type: 'seek', sessionCode: S.code, position: frac * S.track.duration });
});

// ------------------------------------------------------------- rendering ---
function statusKey() {
  if (S.loading) return 'st_loading';
  if (S.playback.click) return 'st_click';
  if (S.playback.status === 'playing') return 'st_playing';
  if (S.playback.status === 'paused') return 'st_paused';
  if (S.role === 'satellite' && !S.track) return 'st_waiting';
  return 'st_idle';
}

function renderStatus() {
  const st = t(statusKey());
  $('lead-status').textContent = st;
  $('sat-status').textContent = st;
  const playing = S.playback.status === 'playing';
  $('sat-waiting').hidden = !(S.role === 'satellite' && !playing && !S.track);
  // waves react to real audio while playing, ambient motion otherwise
  const an = playing ? player.analyser : null;
  waves.sat.setAnalyser(an);
  waves.top.setAnalyser(an);
  updateTransport();
}

function renderTrack() {
  $('lead-track').textContent = S.track ? S.track.name.toUpperCase() : t('no_track');
  $('sat-track').textContent = S.track ? S.track.name.toUpperCase() : '';
  $('time-dur').textContent = fmtTime(S.track?.duration || 0);
  updateTransport();
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
    const state = !p.connected ? '· · ·' : (p.ready ? t('st_ready') : (S.track ? t('st_loading') : '—'));
    li.innerHTML = `<span>${who} ${p.id.slice(0, 4).toUpperCase()}${me}</span><span class="${p.ready ? 'ready' : 'dim'}">${state}</span>`;
    if (!p.connected) li.classList.add('dim');
    ul.appendChild(li);
  }
  updateTransport();
}

// Lead transport gating: PLAY only when every connected client is ready;
// after 10 s of waiting, expose PLAY ANYWAY.
function updateTransport() {
  if (S.role !== 'lead') return;
  const hasTrack = !!S.track && !S.loading;
  const ready = hasTrack && allReady();
  $('btn-play').disabled = !ready || S.playback.status === 'playing';
  $('btn-pause').disabled = S.playback.status !== 'playing' || !!S.playback.click;
  $('btn-stop').disabled = S.playback.status === 'idle';
  $('btn-click').textContent = S.playback.click ? t('click_stop') : t('click_start');
  $('click-hint').hidden = !S.playback.click;

  clearTimeout(S.forceTimer);
  if (hasTrack && !ready) {
    S.forceTimer = setTimeout(() => { $('btn-force').hidden = false; }, 10000);
  } else {
    $('btn-force').hidden = true;
  }
}

// Progress bar + technical readout, 4×/s (cheap; the audio clock is the truth).
setInterval(() => {
  if (S.role === 'lead' && S.track?.duration) {
    const pos = S.playback.status === 'playing' ? player.idealPosition()
      : (S.playback.status === 'paused' ? (S.playback.position || 0) : player.lastPos);
    const frac = Math.min(1, Math.max(0, pos / S.track.duration));
    $('progress-fill').style.width = `${frac * 100}%`;
    progress.setAttribute('aria-valuenow', Math.round(frac * 100));
    $('time-cur').textContent = fmtTime(pos);
  }
  renderTech();
}, 250);

// The app exhibits its own mechanics, like VU meters on a mixer.
function renderTech() {
  if (!S.code) return;
  const parts = [
    `OFFSET: ${fmtMs(clock.offset)}`,
    `RTT: ${Math.round(clock.medianRtt)}MS`,
    `DRIFT: ${fmtMs(player.lastDrift * 1000)}`,
  ];
  const line = parts.join(' · ');
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
cal.addEventListener('input', () => {
  $('cal-val').textContent = fmtMs(cal.value);
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
});

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

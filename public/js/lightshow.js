// lightshow.js — the synchronized "light wall". Runs on EVERY device.
//
// The room's screens become one light: they pulse together because the TIMING
// is a purely LOCAL function of the already-synchronized playback timeline
// (the beat grid) or the analyser level. The server never streams "flash"
// events — it only pushes the *look* (lightshow-update). So the pulses land on
// the beat on every phone within the same tolerance as the audio itself, at
// zero extra protocol cost.
//
// Rendering is intentionally trivial: a single full-screen <div> whose
// background-color is rewritten each frame (one style write — no canvas, no
// per-pixel work) so phones stay cool. On the LEAD the overlay stays out of the
// way (it keeps its controls) and the same color is shown in a small preview;
// satellites go full-screen and can tap to reveal a local EXIT.

const PATTERNS = ['pulse', 'colorbeat', 'wave', 'breathe', 'strobe'];
const PULSE_BEATS = { bar: 4, beat: 1, half: 0.5, quarter: 0.25 };
const MIN_PULSE_SEC = 0.14;   // decaying-pulse flicker cap (~7 Hz)
const MIN_STROBE_SEC = 0.34;  // hard-strobe photosensitive cap (~3 Hz)

let deps = null;
let el = null, revealEl = null, previewEl = null, patternNameEl = null;
let timeBuf = null;
let raf = 0, running = false, lastNow = 0;
let flash = 0, level = 0, lastPulseCount = null;
let userExit = false, strobeAck = false;
let sendTimer = 0, pending = null;

const state = {
  on: false, pattern: 'pulse', palette: 'spectrum', source: 'auto',
  beatDiv: 'beat', intensity: 1, floor: 0.12,
};

const reduce = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ timing --
function nowSec() {
  const p = deps.player;
  return (p.ctx && p.ctx.state === 'running') ? p.ctx.currentTime : performance.now() / 1000;
}

// The playing timeline's beat grid, or null if there's nothing reliable to
// follow (no track, no confident BPM). In DECKS mode we lock onto a playing
// deck's grid; two grids at once would be ambiguous so only one drives it.
function beatContext() {
  const { S, player } = deps;
  if (S.decks && S.decks.on) {
    for (const id of ['A', 'B']) {
      if (!player.deckPlaying(id)) continue;
      const d = S.decks[id];
      const tr = d && S.queue.find((q) => q.id === d.trackId);
      if (tr && tr.meta && tr.meta.bpm && tr.meta.confidence >= 0.2) {
        return { pos: player.deckIdealPosition(id), bpm: tr.meta.bpm, phase: tr.meta.beatPhase || 0 };
      }
    }
    return null;
  }
  if (player.playing && !player.clickMode) {
    const tr = S.queue.find((q) => q.id === S.currentTrackId);
    if (tr && tr.meta && tr.meta.bpm && tr.meta.confidence >= 0.2) {
      return { pos: player.idealPosition(), bpm: tr.meta.bpm, phase: tr.meta.beatPhase || 0 };
    }
  }
  return null;
}

// Instantaneous loudness from the shared analyser (time-domain RMS, 0..~0.7).
// null when audio isn't running on this device yet.
function readLevel(player) {
  const an = player.analyser;
  if (!an || !player.ctx || player.ctx.state !== 'running') return null;
  const n = an.fftSize;
  if (!timeBuf || timeBuf.length !== n) timeBuf = new Uint8Array(n);
  an.getByteTimeDomainData(timeBuf);
  let sum = 0;
  for (let i = 0; i < n; i++) { const v = (timeBuf[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / n);
}

// ------------------------------------------------------------------ colour --
function hueFor(palette, phase) {
  switch (palette) {
    case 'mono': return null;                                    // white
    case 'warm': return 25 + 25 * Math.sin(phase * Math.PI * 2); // amber ↔ red
    case 'cool': return 210 + 45 * Math.sin(phase * Math.PI * 2);// blue ↔ cyan
    default: return (phase * 360) % 360;                         // spectrum
  }
}
function colorOf(hue, bright) {
  const b = Math.max(0, Math.min(1, bright));
  if (hue === null) { const v = Math.round(255 * b); return `rgb(${v},${v},${v})`; }
  const L = Math.round(b * 52);
  return `hsl(${Math.round(((hue % 360) + 360) % 360)}, 88%, ${L}%)`;
}

// One frame → the colour every visible surface on this device should show.
function compute(dt) {
  const { S } = deps;
  const t = nowSec();
  const idx = S.deviceIndex || 0;
  const intensity = reduce() ? Math.min(state.intensity, 0.6) : state.intensity;
  const floor = state.floor;

  if (state.pattern === 'breathe') {
    const b = 0.5 + 0.5 * Math.sin(t * (Math.PI * 2) / 6);
    return colorOf(hueFor(state.palette, (t / 20) % 1), floor + (1 - floor) * b * intensity);
  }

  const bc = beatContext();
  const useBeat = state.source === 'level' ? false : !!bc; // beat / auto → beat if available

  if (useBeat && bc) {
    let pulseLen = (60 / bc.bpm) * (PULSE_BEATS[state.beatDiv] || 1);
    const isStrobe = state.pattern === 'strobe' && !reduce();
    const minSec = isStrobe ? MIN_STROBE_SEC : MIN_PULSE_SEC;
    while (pulseLen < minSec) pulseLen *= 2; // photosensitive cap, kept beat-aligned
    let pos = bc.pos;
    if (state.pattern === 'wave') pos -= idx * pulseLen * 0.16; // ripple across the room
    const rel = (pos - bc.phase) / pulseLen;
    const count = Math.floor(rel);
    const frac = ((rel % 1) + 1) % 1;
    if (lastPulseCount === null) lastPulseCount = count;
    else if (count !== lastPulseCount) { flash = 1; lastPulseCount = count; }

    let bright;
    if (isStrobe) {
      bright = frac < 0.16 ? floor + (1 - floor) * intensity : floor * 0.5;
    } else {
      flash *= Math.exp(-dt / Math.min(0.18, pulseLen * 0.5));
      bright = floor + (1 - floor) * flash * intensity;
    }
    let huePhase;
    if (state.pattern === 'pulse') huePhase = (t / 12) % 1;
    else if (state.pattern === 'wave') huePhase = ((count / 12) + idx / 8) % 1;
    else huePhase = (count / 12) % 1; // colorbeat, strobe
    return colorOf(hueFor(state.palette, (huePhase + 1) % 1), bright);
  }

  // level (or auto with no grid): follow the sound; breathe if there's none.
  const rms = readLevel(deps.player);
  if (rms === null) {
    const b = 0.5 + 0.5 * Math.sin(t * (Math.PI * 2) / 6);
    return colorOf(hueFor(state.palette, (t / 20) % 1), floor + (1 - floor) * b * intensity * 0.8);
  }
  level = Math.max(Math.min(1, rms * 3.2), level * Math.exp(-dt / 0.22));
  return colorOf(hueFor(state.palette, (t / 14) % 1), floor + (1 - floor) * level * intensity);
}

// ------------------------------------------------------------------ render --
function paint() {
  const now = nowSec();
  let dt = now - lastNow;
  if (!(dt > 0) || dt > 0.5) dt = 0.016;
  lastNow = now;
  const color = state.on ? compute(dt) : null;
  if (!color) return;
  if (el) el.style.backgroundColor = color;
  if (previewEl) previewEl.style.backgroundColor = color;
}
function frame() {
  if (!running) return;
  paint();
  raf = requestAnimationFrame(frame);
}
function start() {
  if (running) return;
  running = true; lastNow = nowSec();
  raf = requestAnimationFrame(frame);
}
function stop() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

// The full-screen light shows on satellites only (the lead keeps its controls
// and watches a small preview swatch instead).
function updateOverlay() {
  const show = state.on && !userExit && deps.S.role && deps.S.role !== 'lead';
  if (el) el.hidden = !show;
  if (!show && revealEl) revealEl.hidden = true;
}

// ------------------------------------------------------------- lead sending --
function sendPatch(patch) {
  if (deps.S.role !== 'lead') return;
  const wasOn = state.on;
  Object.assign(state, patch);
  if (state.on && !wasOn) userExit = false;
  if (state.on) start(); else { stop(); if (el) el.style.backgroundColor = '#000'; if (previewEl) previewEl.style.backgroundColor = '#000'; }
  updateOverlay();
  renderControls();
  pending = { ...state };
  if (!sendTimer) {
    flushSend();
    sendTimer = setTimeout(() => { sendTimer = 0; if (pending) flushSend(); }, 90);
  }
}
function flushSend() {
  if (!pending || !deps.S.code) { pending = null; return; }
  deps.ws.send({
    type: 'lightshow-set', sessionCode: deps.S.code,
    lightshow: {
      on: pending.on, pattern: pending.pattern, palette: pending.palette,
      source: pending.source, beatDiv: pending.beatDiv,
      intensity: pending.intensity, floor: pending.floor,
    },
  });
  pending = null;
}

// ----------------------------------------------------------- control render --
function renderControls() {
  const toggle = document.getElementById('btn-lights');
  if (toggle) {
    toggle.textContent = `${deps.t('ls_title')}: ${state.on ? deps.t('on') : deps.t('off')}`;
    toggle.classList.toggle('on', state.on);
  }
  const controls = document.getElementById('lightshow-controls');
  if (controls) controls.hidden = !state.on;
  segActive('ls-pattern', state.pattern);
  segActive('ls-palette', state.palette);
  segActive('ls-source', state.source);
  segActive('ls-div', state.beatDiv);
  setSlider('ls-intensity', Math.round(state.intensity * 100));
  setSlider('ls-floor', Math.round(state.floor * 100));
  if (patternNameEl) patternNameEl.textContent = deps.t('lsp_' + state.pattern);
}

function bindSeg(group, fn) {
  document.querySelectorAll(`[data-${group}]`).forEach((b) => {
    b.addEventListener('click', () => fn(b.getAttribute(`data-${group}`)));
  });
}
function segActive(group, val) {
  document.querySelectorAll(`[data-${group}]`).forEach((b) => {
    b.classList.toggle('on', b.getAttribute(`data-${group}`) === val);
  });
}
function bindSlider(id, fn) {
  const s = document.getElementById(id);
  if (!s) return;
  const emit = () => fn(Number(s.value) / 100);
  s.addEventListener('input', emit);
  s.addEventListener('change', emit);
}
function setSlider(id, v) {
  const s = document.getElementById(id);
  if (s && document.activeElement !== s) s.value = v;
}

// -------------------------------------------------------------------- api ---
export function init(d) {
  deps = d;
  el = document.getElementById('lightshow');
  revealEl = document.getElementById('lightshow-reveal');
  previewEl = document.getElementById('ls-preview');
  patternNameEl = document.getElementById('lightshow-pattern-name');

  if (el) el.addEventListener('click', () => { if (revealEl) revealEl.hidden = !revealEl.hidden; });
  const exitBtn = document.getElementById('lightshow-exit');
  if (exitBtn) exitBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    userExit = true;
    updateOverlay();
  });

  const toggle = document.getElementById('btn-lights');
  if (toggle) toggle.addEventListener('click', () => sendPatch({ on: !state.on }));
  bindSeg('ls-pattern', (v) => {
    if (v === 'strobe' && !strobeAck) { strobeAck = true; deps.flash(deps.t('ls_strobe_warn')); }
    sendPatch({ pattern: v });
  });
  bindSeg('ls-palette', (v) => sendPatch({ palette: v }));
  bindSeg('ls-source', (v) => sendPatch({ source: v }));
  bindSeg('ls-div', (v) => sendPatch({ beatDiv: v }));
  bindSlider('ls-intensity', (v) => sendPatch({ intensity: v }));
  bindSlider('ls-floor', (v) => sendPatch({ floor: v }));

  renderControls();
}

// Apply authoritative state (lightshow-update or the join snapshot).
export function set(ns) {
  if (!ns) return;
  const wasOn = state.on;
  state.on = !!ns.on;
  if (PATTERNS.includes(ns.pattern)) state.pattern = ns.pattern;
  if (ns.palette) state.palette = ns.palette;
  if (ns.source) state.source = ns.source;
  if (ns.beatDiv) state.beatDiv = ns.beatDiv;
  if (typeof ns.intensity === 'number') state.intensity = ns.intensity;
  if (typeof ns.floor === 'number') state.floor = ns.floor;
  if (state.on && !wasOn) userExit = false;
  if (state.on) start();
  else { stop(); if (el) el.style.backgroundColor = '#000'; if (previewEl) previewEl.style.backgroundColor = '#000'; }
  updateOverlay();
  renderControls();
}

// Re-evaluate overlay visibility (e.g. after the role is known post-join).
export function refresh() { updateOverlay(); renderControls(); }

// Called from main's 250 ms tick: a repaint fallback when rAF is throttled
// (backgrounded/locked webviews, headless) and to keep the lead preview alive.
export function tick() { if (state.on) paint(); }

// Leaving a session: stop painting and drop the overlay (no server change).
export function hide() {
  stop();
  userExit = false;
  if (el) { el.hidden = true; el.style.backgroundColor = '#000'; }
  if (revealEl) revealEl.hidden = true;
}

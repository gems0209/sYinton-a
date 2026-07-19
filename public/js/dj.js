// MIX MODE — lead-only DJ tools (dynamically imported by main.js, never
// downloaded by satellites). Three responsibilities:
//   1. ANALYSIS: BPM + beat phase + waveform peaks + gain suggestion for every
//      queued track, computed here and reported to the server (track-meta) so
//      the beatmatch planner and every reconnecting client can use them.
//   2. DECK: waveform of the current track with beat grid, playhead, tap-to-
//      seek and 4 hot cues (stored server-side, session-lived).
//   3. MIX PANEL: transition mode, master tempo, 3-band EQ with kills and the
//      bipolar filter. Nothing here touches audio directly — every control is
//      a websocket message; the server schedules it and ALL devices (this one
//      included) render it. That's the sync contract.
import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

let E = null;               // {S, ws, player, bufferCache, flash} from main.js
let analyzing = null;       // trackId being analyzed
const analyzed = new Set(); // ids already pumped (success or failure)
const peaksCache = new Map(); // trackId -> Float32Array(640) — local only

const send = (obj) => E.ws.send({ sessionCode: E.S.code, ...obj });

// ---------------------------------------------------------------- analysis --
// Onset-energy autocorrelation on a low-passed mono mix, then a fine comb
// search around the best coarse lag (and its half/double) with joint phase
// estimation. Runs chunked on the main thread — a few tens of ms of work per
// track, spread over idle slices; no worker, no library.
const YIELD = () => new Promise((r) => setTimeout(r, 0));

async function analyzeBuffer(buf) {
  const sr = buf.sampleRate;
  const n = buf.length;
  const dur = buf.duration;
  const nCh = Math.min(2, buf.numberOfChannels);
  const ch0 = buf.getChannelData(0);
  const ch1 = nCh > 1 ? buf.getChannelData(1) : null;

  // Full pass: waveform peaks (640 bins) + RMS for the gain suggestion.
  const PBINS = 640;
  const peaks = new Float32Array(PBINS);
  const binLen = Math.max(1, Math.ceil(n / PBINS));
  let sumSq = 0;
  for (let start = 0; start < n; start += 1 << 20) {
    const end = Math.min(n, start + (1 << 20));
    for (let i = start; i < end; i++) {
      const m = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
      const a = Math.abs(m);
      const b = (i / binLen) | 0;
      if (a > peaks[b]) peaks[b] = a;
      sumSq += m * m;
    }
    await YIELD();
  }
  let pMax = 0;
  for (let i = 0; i < PBINS; i++) if (peaks[i] > pMax) pMax = peaks[i];
  if (pMax > 0) for (let i = 0; i < PBINS; i++) peaks[i] /= pMax;
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  const gainDb = Math.max(-12, Math.min(12, -14 - 20 * Math.log10(rms + 1e-9)));

  // Analysis window: skip intros/outros, cap the cost on long tracks.
  const skip = Math.min(10, dur * 0.15);
  const spanSec = Math.min(90, dur - 2 * skip);
  if (spanSec < 5) {
    return { bpm: null, confidence: 0, beatPhase: 0, gainDb, peaks }; // too short to trust
  }
  const s0 = Math.floor(skip * sr);
  const s1 = Math.min(n, Math.floor((skip + spanSec) * sr));

  // Low-passed (~150 Hz) energy envelope, hop 256 → half-wave rectified diff.
  const HOP = 256;
  const hopSec = HOP / sr;
  const env = new Float32Array(Math.floor((s1 - s0) / HOP));
  const aLP = 1 - Math.exp(-2 * Math.PI * 150 / sr);
  let lp = 0;
  for (let k = 0; k < env.length; k++) {
    const base = s0 + k * HOP;
    let acc = 0;
    for (let i = 0; i < HOP; i++) {
      const idx = base + i;
      const m = ch1 ? (ch0[idx] + ch1[idx]) * 0.5 : ch0[idx];
      lp += aLP * (m - lp);
      acc += Math.abs(lp);
    }
    env[k] = acc / HOP;
    if ((k & 1023) === 1023) await YIELD();
  }
  const onset = new Float32Array(env.length);
  let oMax = 0;
  for (let k = 1; k < env.length; k++) {
    const d = env[k] - env[k - 1];
    onset[k] = d > 0 ? d : 0;
    if (onset[k] > oMax) oMax = onset[k];
  }
  if (oMax > 0) for (let k = 0; k < onset.length; k++) onset[k] /= oMax;

  // Coarse: autocorrelation of the onset train over the 70–180 BPM lag range,
  // with harmonic support so the true tempo beats its own subdivisions.
  const Lmin = Math.max(1, Math.floor((60 / 180) / hopSec));
  const Lmax = Math.min(onset.length - 2, Math.ceil((60 / 70) / hopSec));
  // Extended range so the 2L/3L harmonic support of high BPMs exists too.
  const LmaxExt = Math.min(onset.length - 2, 3 * Lmax);
  const ac = new Float32Array(LmaxExt + 1);
  for (let L = Lmin; L <= LmaxExt; L++) {
    let s = 0;
    for (let k = 0; k + L < onset.length; k++) s += onset[k] * onset[k + L];
    ac[L] = s / (onset.length - L);
    if ((L & 63) === 63) await YIELD();
  }
  const acAt = (L) => (L >= Lmin && L <= LmaxExt ? ac[Math.round(L)] : 0);
  let bestL = Lmin;
  let bestS = -1;
  for (let L = Lmin; L <= Lmax; L++) {
    const s = ac[L] + 0.5 * acAt(2 * L) + 0.25 * acAt(3 * L);
    if (s > bestS) { bestS = s; bestL = L; }
  }
  const bpmCoarse = 60 / (bestL * hopSec);

  // Fine: comb search ±3 BPM at 0.1 steps around the candidate and its
  // half/double, folding onsets into 48 phase bins per period — the winning
  // (bpm, phase) is the grid; the score spread is the confidence.
  const cands = [...new Set([bpmCoarse / 2, bpmCoarse, bpmCoarse * 2]
    .filter((b) => b >= 68 && b <= 182)
    .map((b) => Math.min(180, Math.max(70, b))))];
  const NB = 48;
  const hist = new Float32Array(NB);
  let best = { bpm: bpmCoarse, phase: 0, score: -1 };
  const scores = [];
  for (const cand of cands) {
    for (let bpm = cand - 3; bpm <= cand + 3; bpm += 0.1) {
      if (bpm < 68 || bpm > 182) continue;
      const Phop = (60 / bpm) / hopSec; // period in hops (float)
      hist.fill(0);
      for (let k = 0; k < onset.length; k++) {
        if (onset[k] === 0) continue;
        const ph = k % Phop;
        hist[Math.min(NB - 1, (ph / Phop * NB) | 0)] += onset[k];
      }
      let hBest = 0;
      let hIdx = 0;
      for (let b = 0; b < NB; b++) {
        const v = hist[b] + 0.5 * (hist[(b + 1) % NB] + hist[(b + NB - 1) % NB]);
        if (v > hBest) { hBest = v; hIdx = b; }
      }
      scores.push(hBest);
      if (hBest > best.score) best = { bpm, phase: (hIdx + 0.5) / NB * (60 / bpm), score: hBest };
    }
    await YIELD();
  }
  scores.sort((a, b) => a - b);
  const median = scores.length ? scores[scores.length >> 1] : 0;
  const confidence = best.score > 0
    ? Math.max(0, Math.min(1, 1 - median / best.score))
    : 0;
  // Phase measured relative to the analysis window → absolute beat grid.
  const period = 60 / best.bpm;
  const beatPhase = ((skip + best.phase) % period + period) % period;
  return {
    bpm: Math.round(best.bpm * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    beatPhase: Math.round(beatPhase * 1000) / 1000,
    gainDb: Math.round(gainDb * 10) / 10,
    peaks,
  };
}

// One track at a time, lowest queue position first. Meta lives on the server;
// peaks stay local (they are only drawn here) — after a lead reload the
// current track gets a peaks-only re-run.
function needsAnalysis(tr) {
  if (analyzed.has(tr.id)) return false;
  if (!tr.meta) return true;
  return tr.id === E.S.currentTrackId && !peaksCache.has(tr.id);
}

async function pump() {
  if (analyzing || !E || E.S.role !== 'lead' || !E.S.code) return;
  const tr = E.S.queue.find(needsAnalysis);
  if (!tr) return;
  analyzing = tr.id;
  renderBpmLine();
  try {
    let buf = E.bufferCache.get(tr.id);
    if (!buf) buf = await E.player.decode(`/audio/${E.S.code}/${tr.id}`);
    const r = await analyzeBuffer(buf);
    peaksCache.set(tr.id, r.peaks);
    if (peaksCache.size > 12) peaksCache.delete(peaksCache.keys().next().value);
    if (!tr.meta) {
      send({
        type: 'track-meta', trackId: tr.id,
        bpm: r.bpm, confidence: r.confidence, beatPhase: r.beatPhase, gainDb: r.gainDb,
      });
    }
    analyzed.add(tr.id);
    deckDirty = true;
  } catch {
    analyzed.add(tr.id); // don't loop on a broken file
  } finally {
    analyzing = null;
    renderBpmLine();
    pump();
  }
}

// -------------------------------------------------------------------- deck --
let deckDirty = true;   // static layer (peaks + grid) needs a redraw
let deckRaf = 0;
const deckBg = document.createElement('canvas');

function currentTrack() {
  return E.S.queue.find((q) => q.id === E.S.currentTrackId) || null;
}

function drawDeckBg(w, h, track) {
  deckBg.width = w;
  deckBg.height = h;
  const c = deckBg.getContext('2d');
  c.clearRect(0, 0, w, h);
  const peaks = track && peaksCache.get(track.id);
  const mid = h / 2;
  c.fillStyle = 'rgba(245,245,245,0.28)';
  if (peaks) {
    const step = Math.max(1, Math.floor(peaks.length / w));
    for (let x = 0; x < w; x++) {
      const i = Math.min(peaks.length - 1, Math.floor(x / w * peaks.length));
      let v = 0;
      for (let k = 0; k < step; k++) v = Math.max(v, peaks[Math.min(peaks.length - 1, i + k)]);
      const bh = Math.max(1, v * (h - 6));
      c.fillRect(x, mid - bh / 2, 1, bh);
    }
  } else {
    c.fillRect(0, mid, w, 1);
  }
  // Beat grid from the analysis: every beat faint, every 4th a touch brighter.
  const meta = track && track.meta;
  if (meta && meta.bpm && track.duration) {
    const period = 60 / meta.bpm;
    const n = Math.floor((track.duration - meta.beatPhase) / period);
    for (let k = 0; k <= n; k++) {
      const x = Math.round(((meta.beatPhase + k * period) / track.duration) * w);
      c.fillStyle = k % 4 === 0 ? 'rgba(245,245,245,0.30)' : 'rgba(245,245,245,0.12)';
      c.fillRect(x, 0, 1, h);
    }
  }
}

function drawDeck() {
  const cv = $('deck');
  if (!cv || cv.clientWidth === 0) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.round(cv.clientWidth * dpr);
  const h = Math.round(cv.clientHeight * dpr);
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; deckDirty = true; }
  const track = currentTrack();
  if (deckDirty) { drawDeckBg(w, h, track); deckDirty = false; }
  const c = cv.getContext('2d');
  c.clearRect(0, 0, w, h);
  c.drawImage(deckBg, 0, 0);
  if (!track || !track.duration) return;
  const st = E.S.playback.status;
  const pos = st === 'playing' ? E.player.idealPosition()
    : (st === 'paused' ? (E.S.playback.position || 0) : E.player.lastPos);
  const frac = Math.min(1, Math.max(0, pos / track.duration));
  // Played part brighter: overlay, then the playhead.
  c.globalCompositeOperation = 'source-atop';
  c.fillStyle = 'rgba(245,245,245,0.42)';
  c.fillRect(0, 0, Math.round(frac * w), h);
  c.globalCompositeOperation = 'source-over';
  c.fillStyle = '#FFFFFF';
  c.fillRect(Math.round(frac * w), 0, Math.max(1, dpr), h);
  // Hot cue markers.
  const cues = track.cues || [];
  for (let i = 0; i < 4; i++) {
    if (cues[i] == null) continue;
    const x = Math.round((cues[i] / track.duration) * w);
    c.fillStyle = '#FFFFFF';
    c.fillRect(x, 0, Math.max(1, dpr), 8 * dpr);
    c.font = `${9 * dpr}px monospace`;
    c.fillText(String(i + 1), x + 3 * dpr, 9 * dpr);
  }
}

function deckLoop() {
  drawDeck();
  deckRaf = requestAnimationFrame(deckLoop);
}
function setDeckRunning(on) {
  if (on && !deckRaf) deckRaf = requestAnimationFrame(deckLoop);
  if (!on && deckRaf) { cancelAnimationFrame(deckRaf); deckRaf = 0; }
}

// ---------------------------------------------------------------- controls --
let fxTimer = null;
let fxPending = false; // an outbound fx-set is queued: server echoes must not clobber uiFx
let uiFx = { low: 0, mid: 0, high: 0, killLow: false, killMid: false, killHigh: false, filter: 0 };

function sendFx(immediate = false) {
  clearTimeout(fxTimer);
  fxPending = true;
  const fire = () => { fxPending = false; send({ type: 'fx-set', fx: { ...uiFx } }); };
  if (immediate) fire();
  else fxTimer = setTimeout(fire, 90); // collapse slider streams
}

function renderBpmLine() {
  const el = $('mix-bpm');
  if (!el) return;
  const track = currentTrack();
  if (analyzing && (!track || analyzing === track.id)) {
    el.textContent = t('mix_analyzing');
    return;
  }
  const meta = track && track.meta;
  if (!meta || !meta.bpm) { el.textContent = `BPM —`; return; }
  const eff = meta.bpm * (E.S.tempo || 1);
  const tempoTxt = Math.abs((E.S.tempo || 1) - 1) > 0.0005 ? ` · ${eff.toFixed(1)} @ TEMPO` : '';
  const conf = meta.confidence < 0.2 ? ' ~' : '';
  el.textContent = `${meta.bpm.toFixed(1)} BPM${conf}${tempoTxt}`;
}

function renderTransition() {
  for (const m of ['cut', 'fade2', 'fade4', 'fade8', 'beatmatch']) {
    const b = $(`tr-${m}`);
    if (b) b.classList.toggle('on', E.S.transitionMode === m);
  }
}

function renderTempo() {
  const el = $('tempo');
  const val = Math.round((E.S.tempo || 1) * 1000) / 10;
  if (el && document.activeElement !== el) el.value = String(val);
  const lab = $('tempo-val');
  if (lab) lab.textContent = `${val.toFixed(1)}%`;
}

function renderFxControls() {
  // Adopt the server state only when nothing is about to be sent from here —
  // otherwise the echo of message N wipes the user's edit for message N+1.
  if (!fxPending && E.S.fx) uiFx = { ...uiFx, ...E.S.fx };
  for (const [band, kill] of [['low', 'killLow'], ['mid', 'killMid'], ['high', 'killHigh']]) {
    const sl = $(`eq-${band}`);
    const kb = $(`kill-${band}`);
    const lab = $(`eq-${band}-val`);
    if (sl && document.activeElement !== sl) sl.value = String(uiFx[band]);
    if (lab) lab.textContent = `${uiFx[band] > 0 ? '+' : ''}${Math.round(uiFx[band])}DB`;
    if (kb) kb.classList.toggle('on', !!uiFx[kill]);
  }
  const f = $('filter');
  if (f && document.activeElement !== f) f.value = String(uiFx.filter);
  const fl = $('filter-val');
  if (fl) {
    const v = uiFx.filter;
    fl.textContent = v === 0 ? '—' : (v < 0 ? `LP ${Math.abs(v)}` : `HP ${v}`);
  }
}

function renderCues() {
  const track = currentTrack();
  for (let i = 0; i < 4; i++) {
    const b = $(`cue-${i}`);
    if (!b) continue;
    const cueVal = track && track.cues ? track.cues[i] : null;
    b.disabled = !track;
    b.classList.toggle('set', cueVal != null);
    b.textContent = cueVal != null ? `${i + 1}·${fmtShort(cueVal)}` : `${t('mix_cue')} ${i + 1}`;
  }
}

function fmtShort(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderAll() {
  renderBpmLine();
  renderTransition();
  renderTempo();
  renderFxControls();
  renderCues();
  deckDirty = true;
}

function wire() {
  $('mix-panel').hidden = false;
  const details = $('mix');
  details.addEventListener('toggle', () => setDeckRunning(details.open));

  // Deck: tap to seek (same protocol path as the progress band).
  $('deck').addEventListener('click', (e) => {
    const track = currentTrack();
    if (!track || !track.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    send({ type: 'seek', position: frac * track.duration });
  });

  // Hot cues: tap = set (empty) or jump (set); hold ≈ 0.6 s = clear.
  for (let i = 0; i < 4; i++) {
    const b = $(`cue-${i}`);
    let holdTimer = null;
    let held = false;
    const down = () => {
      held = false;
      holdTimer = setTimeout(() => {
        held = true;
        const track = currentTrack();
        if (track) send({ type: 'cue-set', trackId: track.id, slot: i, position: null });
      }, 600);
    };
    const up = () => clearTimeout(holdTimer);
    b.addEventListener('pointerdown', down);
    b.addEventListener('pointerup', up);
    b.addEventListener('pointerleave', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      if (held) return;
      const track = currentTrack();
      if (!track) return;
      const cueVal = track.cues ? track.cues[i] : null;
      if (cueVal == null) {
        const st = E.S.playback.status;
        const pos = st === 'playing' ? E.player.idealPosition()
          : (st === 'paused' ? (E.S.playback.position || 0) : 0);
        send({ type: 'cue-set', trackId: track.id, slot: i, position: Math.max(0, pos) });
      } else {
        send({ type: 'seek', position: cueVal });
      }
    });
  }

  for (const m of ['cut', 'fade2', 'fade4', 'fade8', 'beatmatch']) {
    $(`tr-${m}`).addEventListener('click', () => send({ type: 'set-transition', mode: m }));
  }

  const tempo = $('tempo');
  tempo.addEventListener('input', () => {
    $('tempo-val').textContent = `${Number(tempo.value).toFixed(1)}%`;
  });
  tempo.addEventListener('change', () => {
    send({ type: 'set-tempo', tempo: Number(tempo.value) / 100 });
  });
  $('btn-tempo-reset').addEventListener('click', () => {
    tempo.value = '100';
    $('tempo-val').textContent = '100.0%';
    send({ type: 'set-tempo', tempo: 1 });
  });

  for (const [band, kill] of [['low', 'killLow'], ['mid', 'killMid'], ['high', 'killHigh']]) {
    const sl = $(`eq-${band}`);
    sl.addEventListener('input', () => {
      uiFx[band] = Number(sl.value);
      $(`eq-${band}-val`).textContent = `${uiFx[band] > 0 ? '+' : ''}${Math.round(uiFx[band])}DB`;
      sendFx();
    });
    $(`kill-${band}`).addEventListener('click', () => {
      uiFx[kill] = !uiFx[kill];
      $(`kill-${band}`).classList.toggle('on', uiFx[kill]);
      sendFx(true);
    });
  }
  const filter = $('filter');
  filter.addEventListener('input', () => {
    let v = Number(filter.value);
    if (Math.abs(v) < 8) v = 0; // center detent
    uiFx.filter = v;
    $('filter-val').textContent = v === 0 ? '—' : (v < 0 ? `LP ${Math.abs(v)}` : `HP ${v}`);
    sendFx();
  });
  filter.addEventListener('change', () => {
    if (uiFx.filter === 0) filter.value = '0'; // snap the knob home
  });
  $('btn-fx-reset').addEventListener('click', () => {
    uiFx = { low: 0, mid: 0, high: 0, killLow: false, killMid: false, killHigh: false, filter: 0 };
    sendFx(true);
    renderFxControls();
  });
}

// ------------------------------------------------------------------- hooks --
export function init(env) {
  E = env;
  wire();
  renderAll();
  pump();
  if ($('mix').open) setDeckRunning(true);
}

// Queue/session snapshot changed (also fired on language switch).
export function onQueue() {
  if (!E) return;
  for (const id of [...peaksCache.keys()]) {
    if (!E.S.queue.some((q) => q.id === id)) peaksCache.delete(id);
  }
  renderAll();
  pump();
}

// Live fx echoed back (our own or a reconnect catch-up).
export function onFx() {
  if (!E) return;
  renderFxControls();
}

// 250 ms UI tick from main.js. The deck normally animates on its own rAF;
// drawing it here too guarantees ≥4 fps when rAF is throttled or starved
// (backgrounded webviews, battery savers) — the draw is a cheap blit.
export function tick() {
  if (!E || E.S.role !== 'lead') return;
  renderBpmLine();
  const mix = $('mix');
  if (mix && mix.open) drawDeck();
}

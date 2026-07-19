// Sync playback engine — Web Audio API only. <audio> is never used: its
// play() latency is unpredictable, AudioBufferSourceNode.start(when) is
// sample-accurate against AudioContext.currentTime.
//
// SCHEDULING MATH
// ---------------
// Server broadcasts {startAtServerTime, trackOffset} (server monotonic ms).
//   localPerfStart = startAtServerTime - clockOffset          (perf.now() ms)
// We keep a frequently-sampled mapping (perf.now(), ctx.currentTime), so:
//   whenCtx = ctxAtSample + (localPerfStart - perfAtSample)/1000
// Two corrections are applied by SHIFTING `when`:
//   - output latency: sound leaves the speaker ~(outputLatency+baseLatency)
//     AFTER the sample is rendered → start earlier by that amount;
//   - user calibration c (ms): positive = play later on this device.
//   shiftSec = c/1000 - outputLatency;  when += shiftSec
// Because of the shift, the MEASURED position of this client differs from the
// ideal server position by -shiftSec·rate. Drift checks compare like with
// like: drift = measuredPos - (idealServerPos - shiftSec·rate).
//
// CHANNELS (DUAL DECK)
// --------------------
// The engine is two independent Channels — each with its own source, fade
// gain, EQ-swap shelf, anchors, rate (+ optional ramp) and drift machinery —
// mixed by a crossfader (two gain nodes) into the shared MIX fx chain.
// Channel 0 doubles as the QUEUE path (playlist, transitions, click track):
// the legacy single-track API delegates to it untouched. In DECKS mode the
// same two channels become deck A and deck B under the crossfader; a playing
// queue track can be adopted as deck A with zero glitch because it already
// lives on channel 0.

// iPadOS 13+ pretends to be MacIntel; the touch check catches it.
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Equal-power fade curve (cos/sin quarter-wave), for crossfades.
function epCurve(up, n = 33) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    c[i] = Math.max(0.0001, Math.cos((up ? 1 - x : x) * Math.PI / 2));
  }
  return c;
}

// One independent playback timeline: source + fade gain + shelf feeding a
// channel output gain (the crossfader leg). All scheduling/drift math lives
// here; the player owns the clock mapping and the shared fx chain.
class Channel {
  constructor(player) {
    this.p = player;
    this.out = null;         // crossfader leg (GainNode), created in init
    this.buffer = null;
    this.source = null;
    this.srcGain = null;
    this.srcShelf = null;
    this.tail = null;        // outgoing source during a queue transition
    this.playing = false;
    this.clickMode = false;
    this.anchorCtx = 0;
    this.anchorPos = 0;
    this.rate = 1;
    this.rateRamp = null;    // {startCtx, dur, from, to}
    this.lastPos = 0;
    this.lastDrift = 0;
    this.lastPlayMsg = null; // {startAtServerTime, trackOffset, click, rate, ramp}
  }

  get ctx() { return this.p.ctx; }

  setBuffer(buffer) { this.buffer = buffer; }

  _resolveRamp(rate, ramp) {
    if (!ramp) return { rate, rampCtx: null };
    const startCtx = this.p.ctxTimeFor(this.p.clock.serverToLocal(ramp.startAt)) + this.p.shiftSec;
    const dur = ramp.dur / 1000;
    const nowCtx = this.ctx.currentTime;
    if (nowCtx >= startCtx + dur) return { rate: ramp.to, rampCtx: null };
    if (nowCtx > startCtx) {
      const u = (nowCtx - startCtx) / dur;
      const cur = rate + (ramp.to - rate) * u;
      return { rate: cur, rampCtx: { startCtx: nowCtx, dur: dur - (nowCtx - startCtx), from: cur, to: ramp.to } };
    }
    return { rate, rampCtx: { startCtx, dur, from: rate, to: ramp.to } };
  }

  _advance(rate, rampCtx, a, b) {
    if (!rampCtx) return (b - a) * rate;
    let adv = (Math.min(b, rampCtx.startCtx) - a) * rate;
    if (b > rampCtx.startCtx) {
      const u = Math.min(b - rampCtx.startCtx, rampCtx.dur);
      adv += rampCtx.from * u + (rampCtx.to - rampCtx.from) * u * u / (2 * rampCtx.dur);
      if (b - rampCtx.startCtx > rampCtx.dur) adv += (b - rampCtx.startCtx - rampCtx.dur) * rampCtx.to;
    }
    return adv;
  }

  // Schedule playback so the first sample leaves the speaker at the instant
  // the server fixed. Late join: if the start is already past, jump forward.
  // opts: rate, ramp {to,startAt,dur} (server time), transition {type,dur}.
  scheduleAt(startAtServerTime, trackOffset, click = false, fadeIn = 0, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return false;
    const buf = click ? this.p.clickBuffer() : this.buffer;
    if (!buf) return false;
    const transition = (!click && opts.transition) || null;
    const old = this.source;
    const oldGain = this.srcGain;
    const oldShelf = this.srcShelf;
    this.source = null;
    this.srcGain = null;
    this.srcShelf = null;
    this.clickMode = click;
    this.lastPlayMsg = {
      startAtServerTime, trackOffset, click,
      rate: opts.rate ?? 1, ramp: opts.ramp || null,
    };
    this.p._sampleMap();

    this.p.shiftSec = this.p.calibrationMs / 1000 - this.p.outputLatency();
    let when = this.p.ctxTimeFor(this.p.clock.serverToLocal(startAtServerTime)) + this.p.shiftSec;
    let offset = trackOffset;
    const { rate, rampCtx } = click
      ? { rate: 1, rampCtx: null }
      : this._resolveRamp(opts.rate ?? 1, opts.ramp || null);
    const minStart = this.ctx.currentTime + 0.1;
    if (when < minStart) {
      offset += this._advance(rate, rampCtx, when, minStart);
      when = minStart;
    }

    this._killTail(when);

    if (old && oldGain) {
      try {
        oldGain.gain.cancelScheduledValues(this.ctx.currentTime);
        if (transition && this.playing) {
          // Crossfade: the outgoing source stays alive under an equal-power
          // fade for the overlap (queue auto-advance places `when` exactly
          // fade seconds before its natural end).
          const d = Math.max(0.1, transition.dur);
          oldGain.gain.setValueAtTime(oldGain.gain.value, this.ctx.currentTime);
          oldGain.gain.setValueCurveAtTime(epCurve(false), when, d);
          if (transition.type === 'beatmatch' && oldShelf) {
            oldShelf.gain.setValueAtTime(oldShelf.gain.value, this.ctx.currentTime);
            oldShelf.gain.linearRampToValueAtTime(-28, when + d * 0.6);
          }
          old.stop(when + d + 0.1);
          this.tail = { src: old, gain: oldGain, shelf: oldShelf };
          old.onended = () => { if (this.tail && this.tail.src === old) this.tail = null; };
        } else {
          // Cut the outgoing source exactly at the handover with a 20 ms fade.
          const cut = Math.max(this.ctx.currentTime, when - 0.02);
          oldGain.gain.setValueAtTime(oldGain.gain.value, cut);
          oldGain.gain.linearRampToValueAtTime(0.0001, when);
          old.stop(when + 0.02);
        }
      } catch { /* already stopped */ }
    }
    if (click) {
      offset = offset % buf.duration;
    } else if (offset >= buf.duration) {
      this.playing = false;
      return false; // past the end
    }
    this._startSource(buf, when, offset, click, fadeIn, {
      rate, rampCtx,
      xfade: transition ? Math.max(0.1, transition.dur) : 0,
      eqSwapIn: !!(transition && transition.type === 'beatmatch'),
    });
    this.anchorCtx = when;
    this.anchorPos = offset;
    this.rate = rate;
    this.rateRamp = rampCtx;
    this.playing = true;
    return true;
  }

  _startSource(buf, when, offset, loop, fadeIn = 0, opts = {}) {
    const { rate = 1, rampCtx = null, xfade = 0, eqSwapIn = false } = opts;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.onended = () => {
      if (this.source === src) {
        this.source = null;
        this.srcGain = null;
        this.srcShelf = null;
        this.playing = false;
        this.lastPos = buf.duration;
      }
    };
    try {
      src.playbackRate.setValueAtTime(rate, when);
      if (rampCtx) {
        const rs = Math.max(when, rampCtx.startCtx);
        src.playbackRate.setValueAtTime(rampCtx.from, rs);
        src.playbackRate.linearRampToValueAtTime(rampCtx.to, rs + rampCtx.dur);
      }
    } catch { src.playbackRate.value = rate; }
    const g = this.ctx.createGain();
    if (xfade > 0) {
      try {
        g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
        g.gain.setValueCurveAtTime(epCurve(true), when, xfade);
      } catch { g.gain.setValueAtTime(1, when); }
    } else if (fadeIn > 0) {
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(1, when + fadeIn);
    } else {
      g.gain.setValueAtTime(1, when);
    }
    const shelf = this.ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = 250;
    if (eqSwapIn) {
      shelf.gain.setValueAtTime(-28, when);
      shelf.gain.setValueAtTime(-28, when + xfade * 0.4);
      shelf.gain.linearRampToValueAtTime(0, when + xfade);
    } else {
      shelf.gain.value = 0;
    }
    src.connect(g);
    g.connect(shelf);
    // The calibration click bypasses crossfader + MIX fx (a killed-low EQ or
    // a closed filter must never silence the click you calibrate with).
    shelf.connect(loop ? this.p.master : this.out);
    src.start(when, offset);
    this.source = src;
    this.srcGain = g;
    this.srcShelf = shelf;
  }

  _killTail(atCtx) {
    if (!this.tail) return;
    const { src, gain } = this.tail;
    this.tail = null;
    try {
      const t = this.ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(gain.gain.value, Math.max(t, atCtx - 0.02));
      gain.gain.linearRampToValueAtTime(0.0001, Math.max(t + 0.02, atCtx));
      src.stop(Math.max(t + 0.03, atCtx + 0.02));
    } catch { /* already stopped */ }
  }

  stopLocal(fade = 0.03) {
    if (!this.ctx) { this.playing = false; return; }
    this._killTail(this.ctx.currentTime + fade);
    if (this.source) {
      const src = this.source;
      const g = this.srcGain;
      const t = this.ctx.currentTime;
      try {
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0.0001, t + fade);
        src.stop(t + fade + 0.01);
      } catch { /* already stopped */ }
      this.source = null;
      this.srcGain = null;
      this.srcShelf = null;
    }
    if (this.playing) this.lastPos = this.position();
    this.playing = false;
    this.rateRamp = null;
  }

  pauseAt(position) {
    this.stopLocal(0.03);
    this.lastPos = position;
  }

  position() {
    if (!this.playing || !this.ctx) return this.lastPos;
    return this._positionAtCtx(this.ctx.currentTime);
  }

  _positionAtCtx(t) {
    const r = this.rateRamp;
    let pos = this.anchorPos;
    if (!r) return pos + (t - this.anchorCtx) * this.rate;
    pos += (Math.min(t, r.startCtx) - this.anchorCtx) * this.rate;
    if (t > r.startCtx) {
      const u = Math.min(t - r.startCtx, r.dur);
      pos += r.from * u + (r.to - r.from) * u * u / (2 * r.dur);
      if (t - r.startCtx > r.dur) pos += (t - r.startCtx - r.dur) * r.to;
    }
    return pos;
  }

  idealPosition() {
    return this.position() + this.p.shiftSec * this.rate;
  }

  // Rate change without restart: the server re-anchored at applyAt; glide
  // playbackRate over ~150 ms centred there (a step is an audible pitch
  // click); the ≤4 ms position error is swallowed by the next drift check.
  setRate(rate, trackOffset, applyAtServerTime) {
    this.lastPlayMsg = { startAtServerTime: applyAtServerTime, trackOffset, click: false, rate, ramp: null };
    if (!this.playing || !this.source || this.clickMode) return;
    const applyCtx = Math.max(
      this.ctx.currentTime + 0.02,
      this.p.ctxTimeFor(this.p.clock.serverToLocal(applyAtServerTime)) + this.p.shiftSec,
    );
    try {
      const pr = this.source.playbackRate;
      pr.cancelScheduledValues(this.ctx.currentTime);
      pr.setValueAtTime(this.rate, Math.max(this.ctx.currentTime, applyCtx - 0.075));
      pr.linearRampToValueAtTime(rate, applyCtx + 0.075);
    } catch { this.source.playbackRate.value = rate; }
    this.anchorPos = this._positionAtCtx(applyCtx);
    this.anchorCtx = applyCtx;
    this.rate = rate;
    this.rateRamp = null;
  }

  // DRIFT CORRECTION — see the header comment; suspended during rate ramps.
  checkDrift(serverTime, trackPosition, hbRate = 1, rampActive = false) {
    if (!this.playing || this.clickMode || !this.ctx) return 0;
    if (rampActive) return 0;
    this.p._sampleMap();
    const ctxNow = this.ctx.currentTime;
    if (this.rateRamp && ctxNow < this.rateRamp.startCtx + this.rateRamp.dur + 0.5) return 0;
    if (ctxNow < this.anchorCtx + 0.05) return 0; // scheduled, not started yet
    const ctxAtHb = this.p.ctxTimeFor(this.p.clock.serverToLocal(serverTime));
    const rate = hbRate || this.rate || 1;
    const expected = trackPosition + (ctxNow - ctxAtHb) * rate - this.p.shiftSec * rate;
    if (expected < 0.1) return 0;
    const drift = this.position() - expected;
    this.lastDrift = drift;
    const abs = Math.abs(drift);
    if (abs < 0.015) return drift;
    this._reseek(abs <= 0.06 ? 0.05 : 0.03, expected, ctxNow);
    return drift;
  }

  _reseek(fade, expectedNow, ctxNow) {
    if (!this.buffer) return;
    const startCtx = ctxNow + fade;
    const newOffset = expectedNow + fade * this.rate;
    if (newOffset >= this.buffer.duration || newOffset < 0) return;
    const old = this.source;
    const oldGain = this.srcGain;
    this.source = null;
    this.srcGain = null;
    this.srcShelf = null;
    if (old && oldGain) {
      try {
        oldGain.gain.cancelScheduledValues(ctxNow);
        oldGain.gain.setValueAtTime(oldGain.gain.value, ctxNow);
        oldGain.gain.linearRampToValueAtTime(0.0001, startCtx);
        old.stop(startCtx + 0.01);
      } catch { /* ignore */ }
    }
    this._startSource(this.buffer, startCtx, newOffset, false, fade, { rate: this.rate });
    this.anchorCtx = startCtx;
    this.anchorPos = newOffset;
    this.rateRamp = null;
  }
}

const DECK_INDEX = { A: 0, B: 1 };

export class SyncPlayer {
  constructor(clock) {
    this.clock = clock;
    this.ctx = null;
    this.master = null;      // volume
    this.analyser = null;    // feeds the WaveField when playing
    this._click = null;      // generated click-track buffer (lazy)
    this.calibrationMs = 0;
    this.shiftSec = 0;
    this.fxState = null;     // last applied MIX fx (EQ/filter)
    this.lastHeartbeat = null;
    this._map = { perf: 0, ctx: 0 };
    this._xfaderX = -1;      // full A while decks are off (channel 0 = queue)
    // Channel 0 = queue path AND deck A; channel 1 = deck B.
    this.ch = [new Channel(this), new Channel(this)];
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.85;

    // MIX fx chain, identical on every device (the lead drives it, satellites
    // render it): channels → crossfader legs → fxInput → 3-band EQ → bipolar
    // filter (HP+LP) → master (volume) → analyser → destination. Everything
    // is sonically neutral at rest.
    this.fxInput = this.ctx.createGain();
    this.eqLow = this.ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 200;
    this.eqMid = this.ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.frequency.value = 1000;
    this.eqMid.Q.value = 0.9;
    this.eqHigh = this.ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 4000;
    this.hp = this.ctx.createBiquadFilter();
    this.hp.type = 'highpass';
    this.hp.frequency.value = 20;
    this.lp = this.ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 20000;
    this.fxInput.connect(this.eqLow);
    this.eqLow.connect(this.eqMid);
    this.eqMid.connect(this.eqHigh);
    this.eqHigh.connect(this.hp);
    this.hp.connect(this.lp);
    this.lp.connect(this.master);

    // Crossfader legs. Queue mode: channel 0 full, channel 1 silent.
    for (const c of this.ch) {
      c.out = this.ctx.createGain();
      c.out.connect(this.fxInput);
    }
    this.ch[0].out.gain.value = 1;
    this.ch[1].out.gain.value = 0;

    this.master.connect(this.analyser);
    if (IS_IOS) {
      // iOS mutes raw Web Audio output with the hardware silent switch, but
      // treats <audio>-element playback as "media" and lets it through.
      this.mediaDest = this.ctx.createMediaStreamDestination();
      this.analyser.connect(this.mediaDest);
      this.audioEl = document.createElement('audio');
      this.audioEl.setAttribute('playsinline', '');
      this.audioEl.srcObject = this.mediaDest.stream;
    } else {
      this.analyser.connect(this.ctx.destination);
    }
    if (this.fxState) this.setFx(this.fxState, 0);
    this._sampleMap();
    setInterval(() => this._sampleMap(), 2000);
  }

  async arm() {
    this.init();
    try { await this.ctx.resume(); } catch { /* retried by overlay */ }
    try {
      const b = this.ctx.createBuffer(1, 32, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
    } catch { /* ignore */ }
    if (this.audioEl) {
      try { await this.audioEl.play(); } catch { /* overlay will retry */ }
    }
    return this.ctx.state === 'running';
  }

  _sampleMap() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    this._map = { perf: performance.now(), ctx: this.ctx.currentTime };
  }

  ctxTimeFor(perfTime) {
    return this._map.ctx + (perfTime - this._map.perf) / 1000;
  }

  outputLatency() {
    if (!this.ctx) return 0;
    const out = (typeof this.ctx.outputLatency === 'number' && this.ctx.outputLatency > 0)
      ? this.ctx.outputLatency : 0;
    return out + (this.ctx.baseLatency || 0);
  }

  async decode(url) {
    this.init();
    const res = await fetch(url);
    if (!res.ok) throw new Error('download failed');
    const data = await res.arrayBuffer();
    return new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  clickBuffer() {
    if (this._click) return this._click;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr, sr);
    const chd = buf.getChannelData(0);
    for (let i = 0; i < sr * 0.03; i++) {
      const t = i / sr;
      chd[i] = Math.sin(2 * Math.PI * 1500 * t) * Math.exp(-t / 0.005) * 0.8;
    }
    this._click = buf;
    return buf;
  }

  // ---- legacy queue API: delegates to channel 0 ---------------------------
  get playing() { return this.ch[0].playing; }
  set playing(v) { this.ch[0].playing = v; }
  get lastPos() { return this.ch[0].lastPos; }
  set lastPos(v) { this.ch[0].lastPos = v; }
  get rate() { return this.ch[0].rate; }
  get rateRamp() { return this.ch[0].rateRamp; }
  get tail() { return this.ch[0].tail; }
  get clickMode() { return this.ch[0].clickMode; }
  get buffer() { return this.ch[0].buffer; }
  get duration() { return this.ch[0].buffer ? this.ch[0].buffer.duration : 0; }
  get lastDrift() {
    // The techline shows the worse of the two channels.
    const a = this.ch[0].lastDrift;
    const b = this.ch[1].playing ? this.ch[1].lastDrift : 0;
    return Math.abs(b) > Math.abs(a) ? b : a;
  }
  get anyPlaying() { return this.ch[0].playing || this.ch[1].playing; }

  setBuffer(buffer) { this.ch[0].setBuffer(buffer); }
  scheduleAt(startAtServerTime, trackOffset, click = false, fadeIn = 0, opts = {}) {
    return this.ch[0].scheduleAt(startAtServerTime, trackOffset, click, fadeIn, opts);
  }
  pauseAt(position) { this.ch[0].pauseAt(position); }
  position() { return this.ch[0].position(); }
  idealPosition() { return this.ch[0].idealPosition(); }
  setRate(rate, trackOffset, applyAtServerTime) { this.ch[0].setRate(rate, trackOffset, applyAtServerTime); }
  checkDrift(serverTime, trackPosition, hbRate = 1, rampActive = false) {
    return this.ch[0].checkDrift(serverTime, trackPosition, hbRate, rampActive);
  }
  stopLocal(fade = 0.03) {
    // Silence everything (leave, session end, queue stop).
    this.ch[0].stopLocal(fade);
    this.ch[1].stopLocal(fade);
  }

  // ---- deck API -----------------------------------------------------------
  deck(id) { return this.ch[DECK_INDEX[id] ?? 0]; }
  deckSetBuffer(id, buf) { this.deck(id).setBuffer(buf); }
  deckScheduleAt(id, startAtServerTime, trackOffset, opts = {}) {
    return this.deck(id).scheduleAt(startAtServerTime, trackOffset, false, opts.fadeIn || 0, { rate: opts.rate ?? 1 });
  }
  deckPause(id, position) { this.deck(id).pauseAt(position); }
  deckStop(id, fade = 0.03) { this.deck(id).stopLocal(fade); }
  deckSetRate(id, rate, trackOffset, applyAtServerTime) {
    this.deck(id).setRate(rate, trackOffset, applyAtServerTime);
  }
  deckCheckDrift(id, serverTime, position, rate) {
    return this.deck(id).checkDrift(serverTime, position, rate, false);
  }
  deckPlaying(id) { return this.deck(id).playing; }
  deckPosition(id) { return this.deck(id).position(); }
  deckIdealPosition(id) { return this.deck(id).idealPosition(); }
  deckLastMsg(id) { return this.deck(id).lastPlayMsg; }

  // Crossfader: −1 full A … +1 full B, equal-power. Applied at a server-fixed
  // instant (converted to ctx time by the caller) with a short smoothing.
  setXfader(x, applyCtx = 0) {
    this._xfaderX = Math.min(1, Math.max(-1, x));
    if (!this.ctx) return;
    const t = (this._xfaderX + 1) / 2;
    const at = Math.max(this.ctx.currentTime + 0.01, applyCtx || 0);
    this.ch[0].out.gain.setTargetAtTime(Math.cos(t * Math.PI / 2), at, 0.04);
    this.ch[1].out.gain.setTargetAtTime(Math.sin(t * Math.PI / 2), at, 0.04);
  }

  // Entering/leaving DECKS mode: route the crossfader or park it on the
  // queue channel. Leaving also silences deck B.
  setDecksActive(on) {
    if (!this.ctx) { this._decksOn = on; return; }
    this._decksOn = on;
    if (on) {
      this.setXfader(this._xfaderX === -1 ? 0 : this._xfaderX);
    } else {
      this.ch[1].stopLocal(0.05);
      this._xfaderX = -1;
      const t = this.ctx.currentTime;
      this.ch[0].out.gain.setTargetAtTime(1, t, 0.04);
      this.ch[1].out.gain.setTargetAtTime(0, t, 0.04);
    }
  }

  setVolume(v) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  // Live EQ/filter — applied by every device at the same server-fixed instant.
  setFx(fx, applyCtx) {
    this.fxState = fx;
    if (!this.ctx) return;
    const at = Math.max(this.ctx.currentTime + 0.01, applyCtx || 0);
    const T = 0.04;
    const db = (v, kill) => (kill ? -40 : (v || 0));
    this.eqLow.gain.setTargetAtTime(db(fx.low, fx.killLow), at, T);
    this.eqMid.gain.setTargetAtTime(db(fx.mid, fx.killMid), at, T);
    this.eqHigh.gain.setTargetAtTime(db(fx.high, fx.killHigh), at, T);
    const v = (fx.filter || 0) / 100;
    const lpF = v < 0 ? 150 * Math.pow(20000 / 150, 1 + v) : 20000;
    const hpF = v > 0 ? 20 * Math.pow(8000 / 20, v) : 20;
    this.lp.frequency.setTargetAtTime(lpF, at, 0.06);
    this.hp.frequency.setTargetAtTime(hpF, at, 0.06);
  }

  setCalibration(ms) {
    this.calibrationMs = ms;
    // Re-anchor every playing channel against its authoritative schedule.
    for (const c of this.ch) {
      if (c.playing && c.lastPlayMsg) {
        const m = c.lastPlayMsg;
        c.scheduleAt(m.startAtServerTime, m.trackOffset, m.click, 0.05, {
          rate: m.rate, ramp: m.ramp,
        });
      }
    }
  }
}

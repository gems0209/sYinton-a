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
// ideal server position by -shiftSec·rate (a time shift of dt at playback
// rate r displaces the track position by r·dt). Drift checks must compare
// like with like: drift = measuredPos - (idealServerPos - shiftSec·rate).
//
// PLAYBACK RATE (MIX MODE)
// ------------------------
// The server owns a per-track constant rate (master tempo × beatmatch ratio)
// plus, right after a beatmatch overlap, a single linear ramp gliding the rate
// back to the master tempo. Position is the integral of the rate — piecewise
// linear/quadratic, computed exactly on both sides. Drift correction is
// suspended while a ramp is in flight (the server heartbeat flags it) and
// picks the timeline back up once the rate is constant again.

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

export class SyncPlayer {
  constructor(clock) {
    this.clock = clock;
    this.ctx = null;
    this.master = null;      // volume
    this.analyser = null;    // feeds the WaveField when playing
    this.buffer = null;      // decoded track
    this._click = null;      // generated click-track buffer (lazy)
    this.source = null;
    this.srcGain = null;     // per-source gain, used for fades/crossfades
    this.srcShelf = null;    // per-source low shelf, used by the beatmatch EQ swap
    this.tail = null;        // outgoing source during a transition {src, gain, shelf}
    this.playing = false;
    this.clickMode = false;
    this.calibrationMs = 0;
    this.shiftSec = 0;
    this.anchorCtx = 0;      // ctx time ↔ track position anchor of current source
    this.anchorPos = 0;
    this.rate = 1;           // constant playback rate of the current source
    this.rateRamp = null;    // {startCtx, dur, from, to} — linear glide (beatmatch exit)
    this.lastPos = 0;
    this.lastDrift = 0;
    this.lastPlayMsg = null; // {startAtServerTime, trackOffset, click, rate, ramp} for re-scheduling
    this.lastHeartbeat = null;
    this.fxState = null;     // last applied MIX fx (EQ/filter)
    this._map = { perf: 0, ctx: 0 };
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
    // render it): sources → [srcGain → srcShelf] → fxInput → 3-band EQ →
    // bipolar filter (HP+LP) → master (volume) → analyser → destination.
    // At rest every stage is flat/parked, so the chain is sonically neutral.
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

    this.master.connect(this.analyser);
    if (IS_IOS) {
      // iOS mutes raw Web Audio output with the hardware silent switch, but
      // treats <audio>-element playback as "media" (like YouTube) and lets it
      // through. Route the mix into an element via MediaStream. This path has
      // a device-fixed extra latency — that's what the calibration slider and
      // the click track are for.
      this.mediaDest = this.ctx.createMediaStreamDestination();
      this.analyser.connect(this.mediaDest);
      this.audioEl = document.createElement('audio');
      this.audioEl.setAttribute('playsinline', '');
      this.audioEl.srcObject = this.mediaDest.stream;
    } else {
      this.analyser.connect(this.ctx.destination);
    }
    if (this.fxState) this.setFx(this.fxState, 0); // fx arrived before audio was armed
    this._sampleMap();
    // Re-sample often: the two clocks tick at (slightly) different rates and
    // ctx.currentTime freezes while suspended.
    setInterval(() => this._sampleMap(), 2000);
  }

  // Arm on a user gesture: resume + play a silent buffer (required to really
  // unlock audio on iOS Safari).
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
      // Must start inside a user gesture at least once (iOS media policy).
      try { await this.audioEl.play(); } catch { /* overlay will retry */ }
    }
    // Safari exposes a non-standard 'interrupted' state — treat it as not armed.
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
    // Safari/iOS often expose neither (or 0): fall back to 0 and rely on the
    // manual calibration slider.
    const out = (typeof this.ctx.outputLatency === 'number' && this.ctx.outputLatency > 0)
      ? this.ctx.outputLatency : 0;
    return out + (this.ctx.baseLatency || 0);
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
  }

  // The queue prefetch (main.js) owns the decoded buffers; the player only
  // holds the one being scheduled.
  setBuffer(buffer) {
    this.buffer = buffer;
  }

  // Decode without touching current playback (prefetch of the next track).
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

  // 1 s looped buffer with a short 1.5 kHz burst at t=0 — one beat per second.
  // Generated locally on every device (identical by construction), scheduled
  // exactly like a normal track.
  clickBuffer() {
    if (this._click) return this._click;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr, sr);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < sr * 0.03; i++) {
      const t = i / sr;
      ch[i] = Math.sin(2 * Math.PI * 1500 * t) * Math.exp(-t / 0.005) * 0.8;
    }
    this._click = buf;
    return buf;
  }

  // Convert a server-time rate ramp into ctx time, folding it away if it is
  // already over (late join) or splitting it if we land mid-glide.
  _resolveRamp(rate, ramp) {
    if (!ramp) return { rate, rampCtx: null };
    const startCtx = this.ctxTimeFor(this.clock.serverToLocal(ramp.startAt)) + this.shiftSec;
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

  // Track seconds elapsed between two ctx instants under rate+ramp (piecewise).
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
  // the server fixed. Handles late join transparently: if the ideal start is
  // already in the past, start "now + ε" from the correspondingly advanced
  // track offset. Options (MIX MODE):
  //   rate        constant playback rate of the new source (default 1)
  //   ramp        {to, startAt, dur} server-time rate glide (beatmatch exit)
  //   transition  {type:'fade'|'beatmatch', dur} — overlap the OUTGOING source
  //               for dur seconds with an equal-power crossfade instead of
  //               cutting it; beatmatch adds a low-shelf EQ swap.
  scheduleAt(startAtServerTime, trackOffset, click = false, fadeIn = 0, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return false;
    const buf = click ? this.clickBuffer() : this.buffer;
    if (!buf) return false;
    const transition = (!click && opts.transition) || null;
    // Detach the old source but DON'T silence it yet: it keeps playing until
    // the handover (gapless cut) or through the crossfade (transition).
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
    this._sampleMap();

    this.shiftSec = this.calibrationMs / 1000 - this.outputLatency();
    let when = this.ctxTimeFor(this.clock.serverToLocal(startAtServerTime)) + this.shiftSec;
    let offset = trackOffset;
    const { rate, rampCtx } = click
      ? { rate: 1, rampCtx: null }
      : this._resolveRamp(opts.rate ?? 1, opts.ramp || null);
    const minStart = this.ctx.currentTime + 0.1;
    if (when < minStart) {
      // Late join / message arrived after the start instant: jump forward.
      offset += this._advance(rate, rampCtx, when, minStart);
      when = minStart;
    }

    // Whatever was already tailing (previous transition) is silenced at the
    // new handover: only ever two audible sources at once.
    this._killTail(when);

    if (old && oldGain) {
      try {
        oldGain.gain.cancelScheduledValues(this.ctx.currentTime);
        if (transition && this.playing) {
          // Crossfade: the outgoing source stays alive under an equal-power
          // fade for the overlap (auto-advance places `when` exactly fade
          // seconds before its natural end — the two line up by construction).
          const d = Math.max(0.1, transition.dur);
          oldGain.gain.setValueAtTime(oldGain.gain.value, this.ctx.currentTime);
          oldGain.gain.setValueCurveAtTime(epCurve(false), when, d);
          if (transition.type === 'beatmatch' && oldShelf) {
            // EQ swap, first act: pull the outgoing lows out over the first
            // 60% of the overlap to leave room for the incoming kick.
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
      // Natural end of the buffer (replaced sources are nulled out first).
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
      // EQ swap, second act: the incoming track enters with its lows tucked
      // away, and gets them back over the final 60% of the overlap.
      shelf.gain.setValueAtTime(-28, when);
      shelf.gain.setValueAtTime(-28, when + xfade * 0.4);
      shelf.gain.linearRampToValueAtTime(0, when + xfade);
    } else {
      shelf.gain.value = 0;
    }
    src.connect(g);
    g.connect(shelf);
    // The calibration click bypasses the MIX fx chain (a killed-low EQ or a
    // closed filter must never silence the click you calibrate with).
    shelf.connect(loop ? this.master : this.fxInput);
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
    // Fade out over `fade` s before stopping — avoids the click of a hard cut.
    this._killTail(this.ctx ? this.ctx.currentTime + fade : 0);
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

  // Local measured track position of the running source (integral of the rate).
  position() {
    if (!this.playing || !this.ctx) return this.lastPos;
    const t = this.ctx.currentTime;
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

  // Position corrected back into "server ideal" terms (for UI display).
  idealPosition() {
    return this.position() + this.shiftSec * this.rate;
  }

  setVolume(v) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  // Master tempo change: the server re-anchored its timeline at applyAt
  // (ideal position trackOffset, new constant rate). Glide playbackRate over
  // ~150 ms centred on that instant (a hard step is audible as a pitch
  // click); the ≤ 4 ms position error of the glide is swallowed by the next
  // drift check.
  setRate(rate, trackOffset, applyAtServerTime) {
    // Keep the authoritative anchor for later re-schedules (calibration,
    // self-heal) even if nothing is playing locally right now.
    this.lastPlayMsg = { startAtServerTime: applyAtServerTime, trackOffset, click: false, rate, ramp: null };
    if (!this.playing || !this.source || this.clickMode) return;
    const applyCtx = Math.max(
      this.ctx.currentTime + 0.02,
      this.ctxTimeFor(this.clock.serverToLocal(applyAtServerTime)) + this.shiftSec,
    );
    try {
      const p = this.source.playbackRate;
      p.cancelScheduledValues(this.ctx.currentTime);
      p.setValueAtTime(this.rate, Math.max(this.ctx.currentTime, applyCtx - 0.075));
      p.linearRampToValueAtTime(rate, applyCtx + 0.075);
    } catch { this.source.playbackRate.value = rate; }
    // Re-anchor the local position mapping at the switch instant (continuous).
    this.anchorPos = this._positionAtCtx(applyCtx);
    this.anchorCtx = applyCtx;
    this.rate = rate;
    this.rateRamp = null;
  }

  // Same math as position(), evaluated at an arbitrary ctx instant.
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

  // Live EQ/filter — applied by every device at the same server-fixed instant.
  setFx(fx, applyCtx) {
    this.fxState = fx;
    if (!this.ctx) return; // stored; init() re-applies once audio exists
    const at = Math.max(this.ctx.currentTime + 0.01, applyCtx || 0);
    const T = 0.04;
    const db = (v, kill) => (kill ? -40 : (v || 0));
    this.eqLow.gain.setTargetAtTime(db(fx.low, fx.killLow), at, T);
    this.eqMid.gain.setTargetAtTime(db(fx.mid, fx.killMid), at, T);
    this.eqHigh.gain.setTargetAtTime(db(fx.high, fx.killHigh), at, T);
    // Bipolar filter, one knob djay-style: negative sweeps the lowpass down
    // (20 kHz → 150 Hz), positive sweeps the highpass up (20 Hz → 8 kHz).
    const v = (fx.filter || 0) / 100;
    const lpF = v < 0 ? 150 * Math.pow(20000 / 150, 1 + v) : 20000;
    const hpF = v > 0 ? 20 * Math.pow(8000 / 20, v) : 20;
    this.lp.frequency.setTargetAtTime(lpF, at, 0.06);
    this.hp.frequency.setTargetAtTime(hpF, at, 0.06);
  }

  setCalibration(ms) {
    this.calibrationMs = ms;
    // Re-anchor against the authoritative server schedule with a soft restart.
    if (this.playing && this.lastPlayMsg) {
      const m = this.lastPlayMsg;
      this.scheduleAt(m.startAtServerTime, m.trackOffset, m.click, 0.05, {
        rate: m.rate, ramp: m.ramp,
      });
    }
  }

  // DRIFT CORRECTION — called on every 5 s server heartbeat.
  //   expected(ctxNow) = hbPosition + (ctxNow - ctxAtHeartbeat)·rate - shiftSec·rate
  //   drift = measured - expected     (positive = this device is AHEAD)
  //   |drift| < 15 ms  → leave it alone (inaudible, correction would cost more)
  //   15–60 ms         → soft re-seek with 50 ms crossfade
  //   > 60 ms          → hard re-seek with 30 ms fades
  // NOTE on playbackRate: micro-nudging the rate for a glide correction makes
  // the position-vs-time mapping unobservable, so we use crossfaded re-seeks
  // (at 50 ms fades they are inaudible on music and keep the math exact).
  // MIX-mode rates are different: they are few, server-fixed, and mirrored in
  // the anchor bookkeeping — during a beatmatch glide (rampActive) correction
  // is simply suspended and resumes on the next constant-rate heartbeat.
  checkDrift(serverTime, trackPosition, hbRate = 1, rampActive = false) {
    this.lastHeartbeat = { serverTime, trackPosition };
    if (!this.playing || this.clickMode || !this.ctx) return 0;
    if (rampActive) return 0;
    this._sampleMap();
    const ctxNow = this.ctx.currentTime;
    // Local glide still in flight (clocks can disagree by a beat with the
    // server's rampActive flag): wait until it has settled.
    if (this.rateRamp && ctxNow < this.rateRamp.startCtx + this.rateRamp.dur + 0.5) return 0;
    // Track-transition window: the next source is scheduled but hasn't started
    // yet (and the server's authoritative position describes the not-yet-
    // started segment). Comparing positions here is meaningless and the
    // resulting "correction" would start the new track early — skip.
    if (ctxNow < this.anchorCtx + 0.05) return 0;
    const ctxAtHb = this.ctxTimeFor(this.clock.serverToLocal(serverTime));
    const rate = hbRate || this.rate || 1;
    const expected = trackPosition + (ctxNow - ctxAtHb) * rate - this.shiftSec * rate;
    if (expected < 0.1) return 0; // segment not really rolling server-side yet
    const drift = this.position() - expected;
    this.lastDrift = drift;
    const abs = Math.abs(drift);
    if (abs < 0.015) return drift;
    this._reseek(abs <= 0.06 ? 0.05 : 0.03, expected, ctxNow);
    return drift;
  }

  // Crossfaded re-seek: new source starts at the corrected position while the
  // old one fades out — no click, no gap. Runs only at constant rate (drift
  // checks are suspended during ramps), so the offset advances at this.rate.
  _reseek(fade, expectedNow, ctxNow) {
    if (!this.buffer) return;
    const startCtx = ctxNow + fade;
    const newOffset = expectedNow + fade * this.rate; // corrected position when new source starts
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

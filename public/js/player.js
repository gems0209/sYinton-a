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
// ideal server position by -shiftSec. Drift checks must compare like with
// like: drift = measuredPos - (idealServerPos - shiftSec).

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
    this.playing = false;
    this.clickMode = false;
    this.calibrationMs = 0;
    this.shiftSec = 0;
    this.anchorCtx = 0;      // ctx time ↔ track position anchor of current source
    this.anchorPos = 0;
    this.lastPos = 0;
    this.lastDrift = 0;
    this.lastPlayMsg = null; // {startAtServerTime, trackOffset, click} for re-scheduling
    this.lastHeartbeat = null;
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
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
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

  async load(url, onProgress) {
    this.init();
    this.stopLocal();
    this.buffer = null;
    const res = await fetch(url);
    if (!res.ok) throw new Error('download failed');
    const data = await res.arrayBuffer();
    if (onProgress) onProgress('decoding');
    // decodeAudioData with promise + callback fallback (older Safari)
    this.buffer = await new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(data, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
    return this.buffer.duration;
  }

  get duration() {
    return this.buffer ? this.buffer.duration : 0;
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

  // Schedule playback so the first sample leaves the speaker at the instant
  // the server fixed. Handles late join transparently: if the ideal start is
  // already in the past, start "now + ε" from the correspondingly advanced
  // track offset.
  scheduleAt(startAtServerTime, trackOffset, click = false, fadeIn = 0) {
    if (!this.ctx || this.ctx.state !== 'running') return false;
    const buf = click ? this.clickBuffer() : this.buffer;
    if (!buf) return false;
    this.stopLocal(fadeIn > 0 ? fadeIn : 0.02);
    this.clickMode = click;
    this.lastPlayMsg = { startAtServerTime, trackOffset, click };
    this._sampleMap();

    this.shiftSec = this.calibrationMs / 1000 - this.outputLatency();
    let when = this.ctxTimeFor(this.clock.serverToLocal(startAtServerTime)) + this.shiftSec;
    let offset = trackOffset;
    const minStart = this.ctx.currentTime + 0.1;
    if (when < minStart) {
      // Late join / message arrived after the start instant: jump forward.
      offset += minStart - when;
      when = minStart;
    }
    if (click) {
      offset = offset % buf.duration;
    } else if (offset >= buf.duration) {
      return false; // past the end
    }
    this._startSource(buf, when, offset, click, fadeIn);
    this.anchorCtx = when;
    this.anchorPos = offset;
    this.playing = true;
    return true;
  }

  _startSource(buf, when, offset, loop, fadeIn = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.onended = () => {
      // Natural end of the buffer (replaced sources are nulled out first).
      if (this.source === src) {
        this.source = null;
        this.srcGain = null;
        this.playing = false;
        this.lastPos = buf.duration;
      }
    };
    const g = this.ctx.createGain();
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(1, when + fadeIn);
    } else {
      g.gain.setValueAtTime(1, when);
    }
    src.connect(g);
    g.connect(this.master);
    src.start(when, offset);
    this.source = src;
    this.srcGain = g;
  }

  stopLocal(fade = 0.03) {
    // Fade out over `fade` s before stopping — avoids the click of a hard cut.
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
    }
    if (this.playing) this.lastPos = this.position();
    this.playing = false;
  }

  pauseAt(position) {
    this.stopLocal(0.03);
    this.lastPos = position;
  }

  // Local measured track position of the running source.
  position() {
    if (!this.playing || !this.ctx) return this.lastPos;
    return this.anchorPos + (this.ctx.currentTime - this.anchorCtx);
  }

  // Position corrected back into "server ideal" terms (for UI display).
  idealPosition() {
    return this.position() + this.shiftSec;
  }

  setVolume(v) {
    if (!this.master) return;
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setCalibration(ms) {
    this.calibrationMs = ms;
    // Re-anchor against the authoritative server schedule with a soft restart.
    if (this.playing && this.lastPlayMsg) {
      this.scheduleAt(
        this.lastPlayMsg.startAtServerTime,
        this.lastPlayMsg.trackOffset,
        this.lastPlayMsg.click,
        0.05,
      );
    }
  }

  // DRIFT CORRECTION — called on every 5 s server heartbeat.
  //   expected(ctxNow) = hbPosition + (ctxNow - ctxAtHeartbeat) - shiftSec
  //   drift = measured - expected     (positive = this device is AHEAD)
  //   |drift| < 15 ms  → leave it alone (inaudible, correction would cost more)
  //   15–60 ms         → soft re-seek with 50 ms crossfade
  //   > 60 ms          → hard re-seek with 30 ms fades
  // NOTE on playbackRate: AudioBufferSourceNode.playbackRate can be nudged
  // ±0.3% for a glide correction, but rate changes make the source's
  // position-vs-time mapping nonlinear and unobservable (no .position
  // property), so the anchor bookkeeping degrades exactly when precision
  // matters. We use crossfaded re-seeks instead: at 50 ms fades they are
  // inaudible on music and keep the math exact.
  checkDrift(serverTime, trackPosition) {
    this.lastHeartbeat = { serverTime, trackPosition };
    if (!this.playing || this.clickMode || !this.ctx) return 0;
    this._sampleMap();
    const ctxAtHb = this.ctxTimeFor(this.clock.serverToLocal(serverTime));
    const ctxNow = this.ctx.currentTime;
    const expected = trackPosition + (ctxNow - ctxAtHb) - this.shiftSec;
    const drift = this.position() - expected;
    this.lastDrift = drift;
    const abs = Math.abs(drift);
    if (abs < 0.015) return drift;
    this._reseek(abs <= 0.06 ? 0.05 : 0.03, expected, ctxNow);
    return drift;
  }

  // Crossfaded re-seek: new source starts at the corrected position while the
  // old one fades out — no click, no gap.
  _reseek(fade, expectedNow, ctxNow) {
    if (!this.buffer) return;
    const startCtx = ctxNow + fade;
    const newOffset = expectedNow + fade; // corrected position when new source starts
    if (newOffset >= this.buffer.duration || newOffset < 0) return;

    const old = this.source;
    const oldGain = this.srcGain;
    this.source = null;
    this.srcGain = null;
    if (old && oldGain) {
      try {
        oldGain.gain.cancelScheduledValues(ctxNow);
        oldGain.gain.setValueAtTime(oldGain.gain.value, ctxNow);
        oldGain.gain.linearRampToValueAtTime(0.0001, startCtx);
        old.stop(startCtx + 0.01);
      } catch { /* ignore */ }
    }
    this._startSource(this.buffer, startCtx, newOffset, false, fade);
    this.anchorCtx = startCtx;
    this.anchorPos = newOffset;
  }
}

// WaveField — the ethereal counterpoint. Thin (1px) white sinusoid lines at
// low opacity, 3–4 layers with slightly different phases/frequencies, that
// fade in and out over 4–8 s like interference patterns.
//
// Performance budget: ONE shared rAF loop for every field on the page, canvas
// sized with devicePixelRatio, everything paused when the tab is hidden or
// the canvas is detached. Per frame each field draws (layers × ~1 path), so
// it costs next to nothing on cheap phones.

const fields = new Set();
let rafId = null;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function loop(t) {
  rafId = null;
  if (document.hidden) return; // resumed by visibilitychange below
  let any = false;
  for (const f of fields) {
    if (f.running && f.canvas.isConnected && f.canvas.offsetParent !== null) {
      f._draw(t / 1000);
      any = true;
    }
  }
  if (any) rafId = requestAnimationFrame(loop);
}

function ensureLoop() {
  if (rafId === null && !document.hidden && !reducedMotion.matches) {
    rafId = requestAnimationFrame(loop);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) ensureLoop();
});

function rand(a, b) {
  return a + Math.random() * (b - a);
}

export class WaveField {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.layerCount = opts.layers ?? 3;
    this.baseAmp = opts.amplitude ?? 0.35;     // fraction of half-height
    this.opacity = opts.opacity ?? [0.06, 0.2];
    this.speed = opts.speed ?? 1;
    this.analyser = null;
    this._level = 0;                            // smoothed audio level
    this._data = null;
    this.running = false;
    this.layers = [];
    for (let i = 0; i < this.layerCount; i++) this.layers.push(this._spawnLayer(true));
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
  }

  _spawnLayer(midlife = false) {
    // Sum of 3 sinusoids with non-commensurable frequencies + slow phase
    // drift: the pattern never visibly repeats.
    const comps = [];
    for (let c = 0; c < 3; c++) {
      comps.push({
        k: rand(1.3, 4.2) * (c + 1) * (0.9 + Math.random() * 0.23), // spatial freq
        w: rand(0.12, 0.5) * this.speed * (Math.random() < 0.5 ? -1 : 1), // temporal
        p: rand(0, Math.PI * 2),
        a: 1 / (c + 1.4),
      });
    }
    const fadeIn = rand(4, 8);
    const hold = rand(4, 10);
    const fadeOut = rand(4, 8);
    return {
      comps,
      drift: rand(-0.02, 0.02),
      opacity: rand(this.opacity[0], this.opacity[1]),
      born: performance.now() / 1000 - (midlife ? fadeIn + rand(0, hold) : 0),
      fadeIn, hold, fadeOut,
      life: fadeIn + hold + fadeOut,
      amp: rand(0.5, 1) * this.baseAmp,
    };
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    if (r.width === 0) return;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.dpr = dpr;
    if (reducedMotion.matches) this._drawStatic();
  }

  setAnalyser(analyser) {
    this.analyser = analyser;
    if (analyser) this._data = new Uint8Array(analyser.fftSize);
  }

  start() {
    this.running = true;
    if (reducedMotion.matches) {
      this._drawStatic(); // static waves, no animation
      return;
    }
    ensureLoop();
  }

  stop() {
    this.running = false;
    const { width, height } = this.canvas;
    this.ctx2d.clearRect(0, 0, width, height);
  }

  _audioLevel() {
    if (!this.analyser) return null;
    this.analyser.getByteTimeDomainData(this._data);
    let sum = 0;
    for (let i = 0; i < this._data.length; i += 4) {
      const v = (this._data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (this._data.length / 4));
    // Heavy smoothing: ethereal, never nervous. Fast-ish attack, slow release.
    const target = Math.min(1, rms * 3);
    this._level += (target - this._level) * (target > this._level ? 0.12 : 0.025);
    return this._level;
  }

  _envelope(layer, t) {
    const age = t - layer.born;
    if (age > layer.life) {
      // respawn with fresh parameters
      Object.assign(layer, this._spawnLayer());
      return 0;
    }
    if (age < layer.fadeIn) return age / layer.fadeIn;
    if (age < layer.fadeIn + layer.hold) return 1;
    return 1 - (age - layer.fadeIn - layer.hold) / layer.fadeOut;
  }

  _draw(t) {
    const g = this.ctx2d;
    const W = this.canvas.width;
    const H = this.canvas.height;
    if (!W) return;
    g.clearRect(0, 0, W, H);
    const level = this._audioLevel(); // null when no analyser attached
    const audioGain = level === null ? 1 : 0.55 + level * 2.2;
    const mid = H / 2;
    const ampBase = (H / 2) * 0.8;
    g.lineWidth = this.dpr; // 1 CSS px
    g.strokeStyle = '#FFFFFF';

    for (const layer of this.layers) {
      const env = this._envelope(layer, t);
      if (env <= 0.01) continue;
      // ease the envelope for softer appearance
      const e = env * env * (3 - 2 * env);
      g.globalAlpha = layer.opacity * e;
      g.beginPath();
      const steps = Math.min(160, Math.max(60, W / (3 * this.dpr)));
      for (let s = 0; s <= steps; s++) {
        const x = (s / steps) * W;
        const u = s / steps;
        let y = 0;
        for (const c of layer.comps) {
          y += c.a * Math.sin(c.k * u * Math.PI * 2 + c.p + t * c.w + t * layer.drift);
        }
        y = mid + y * layer.amp * ampBase * audioGain * 0.55;
        if (s === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // prefers-reduced-motion: one static frame, no loop.
  _drawStatic() {
    if (!this.running) return;
    for (const l of this.layers) l.born = performance.now() / 1000 - l.fadeIn; // full envelope
    this._draw(0);
  }

  destroy() {
    this.stop();
    fields.delete(this);
    window.removeEventListener('resize', this._resize);
  }
}

export function createField(canvas, opts) {
  const f = new WaveField(canvas, opts);
  fields.add(f);
  return f;
}

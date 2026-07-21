// NTP-like clock sync, client side.
//
// A burst of pings; for each: rtt = t1 - t0, offset = tServer - (t0 + rtt/2).
// Samples travelling on congested paths (high RTT) have asymmetric delays that
// bias the midpoint estimate, so we discard everything above the median RTT
// and take the MEDIAN of the surviving offsets (robust to outliers).
// Uncertainty ≈ best one-way delay = minRTT / 2: the true offset cannot be
// pinned tighter than that without a symmetric-path assumption.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fresh estimate this far from the current offset is not drift — it's a
// discontinuity (the server process restarted and its monotonic clock reset, or
// this device was asleep). Snap to it instead of smoothing, which would take
// many 30 s bursts to catch up and leave playback desynced meanwhile.
const CLOCK_JUMP_MS = 500;

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

export class ClockSync {
  constructor(ws) {
    this.ws = ws;
    this.offset = 0;          // tServer - tClient (ms, performance.now() domain)
    this.uncertainty = Infinity;
    this.medianRtt = 0;
    this.synced = false;
    this._pending = new Map(); // t0 -> resolve
    this._timer = null;
    ws.on('timesync', (msg) => this._onPong(msg));
  }

  _onPong(msg) {
    const t1 = performance.now();
    const resolve = this._pending.get(msg.t0);
    if (!resolve) return;
    this._pending.delete(msg.t0);
    resolve({ t0: msg.t0, tServer: msg.tServer, t1 });
  }

  _ping(timeout = 2000) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      this._pending.set(t0, resolve);
      this.ws.send({ type: 'timesync', t0 });
      setTimeout(() => {
        if (this._pending.delete(t0)) resolve(null); // lost ping
      }, timeout);
    });
  }

  async burst(n = 20) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const s = await this._ping();
      if (s) {
        const rtt = s.t1 - s.t0;
        samples.push({ rtt, offset: s.tServer - (s.t0 + rtt / 2) });
      }
      // Small jitter between pings so we don't sample one congestion event n times.
      await sleep(15 + Math.random() * 25);
    }
    if (samples.length < 3) return false;

    const medRtt = median(samples.map((s) => s.rtt));
    const kept = samples.filter((s) => s.rtt <= medRtt);
    const estimate = median(kept.map((s) => s.offset));
    const minRtt = Math.min(...samples.map((s) => s.rtt));

    if (!this.synced || Math.abs(estimate - this.offset) > CLOCK_JUMP_MS) {
      // First sync, a fresh reconnect, or a discontinuity (server restart /
      // device wake): snap straight to the estimate.
      this.offset = estimate;
    } else {
      // Exponential smoothing: absorbs system-clock drift without step changes
      // that would audibly jerk an already-scheduled playback.
      this.offset += 0.3 * (estimate - this.offset);
    }
    this.medianRtt = medRtt;
    this.uncertainty = minRtt / 2;
    this.synced = true;
    return true;
  }

  // Drop the current fix so the NEXT burst snaps instead of smoothing. Called on
  // every reconnect: the server (and its monotonic clock) may have restarted
  // while we were away, so the old offset can't be trusted as a drift baseline.
  reset() {
    this.synced = false;
    this.uncertainty = Infinity;
  }

  // Light re-sync burst every 30 s to track clock drift.
  startPeriodic() {
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (this.ws.open) this.burst(5);
    }, 30000);
  }

  serverToLocal(tServer) {
    return tServer - this.offset; // performance.now() domain
  }
}

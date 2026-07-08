'use strict';
// NTP-like clock sync over WebSocket.
//
// The client sends {type:'timesync', t0} where t0 is its own performance.now().
// We reply IMMEDIATELY, echoing t0 and attaching tServer (our monotonic clock).
// The client records t1 = performance.now() on receipt and computes per sample:
//
//   rtt    = t1 - t0                     (round trip, measured entirely locally)
//   offset = tServer - (t0 + rtt/2)      (assumes a symmetric network path)
//
// so that  tServer ≈ tClient + offset  at any instant. The client aggregates a
// burst of samples (discard high-RTT, median of offsets) — see public/js/clocksync.js.
//
// performance.now() is monotonic (immune to NTP steps / wall-clock changes),
// which is exactly what a playback scheduler needs.
const { performance } = require('perf_hooks');

const now = () => performance.now();

function handleTimesync(ws, msg) {
  if (typeof msg.t0 !== 'number') return;
  ws.send(JSON.stringify({ type: 'timesync', t0: msg.t0, tServer: now() }));
}

module.exports = { now, handleTimesync };

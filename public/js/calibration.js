// Per-device calibration offset (ms), persisted in localStorage keyed by a
// hash of the user agent — same device, next session: already set.

function hashUA(ua) {
  // djb2 — we only need a stable short key, not cryptography.
  let h = 5381;
  for (let i = 0; i < ua.length; i++) h = ((h << 5) + h + ua.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const KEY = `wavepool-cal-${hashUA(navigator.userAgent)}`;

export const CAL_MIN = -250;
export const CAL_MAX = 250;
export const CAL_STEP = 5;

export function loadCalibration() {
  const v = parseInt(localStorage.getItem(KEY), 10);
  if (Number.isNaN(v)) return 0;
  return Math.max(CAL_MIN, Math.min(CAL_MAX, v));
}

export function saveCalibration(ms) {
  localStorage.setItem(KEY, String(ms));
}

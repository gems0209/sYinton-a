// multizone.js — the OPTIONAL spatial mode. Runs on EVERY device.
//
// The lead turns it on and assigns each phone a zone: a stereo CHANNEL
// (full / left / right), a frequency BAND (full / low / mid / high) and a gain
// trim. Each device applies only its OWN zone to its OWN output — the sync
// timeline is untouched, so this is a pure per-device output shaping, off by
// default and bit-identical to normal playback until a zone is assigned.
// It's orthogonal: queue, MIX and DECKS all keep working with zones live.

const NEUTRAL = { channel: 'full', band: 'full', gain: 1 };
const CHANNELS = ['left', 'full', 'right']; // UI order: SX · PIENO · DX
const BANDS = ['low', 'mid', 'high', 'full'];

let deps = null;

function zoneOf(clientId) {
  const z = deps.S.multizone && deps.S.multizone.zones && deps.S.multizone.zones[clientId];
  return z || NEUTRAL;
}
function isNeutral(z) { return z.channel === 'full' && z.band === 'full' && (z.gain ?? 1) === 1; }

function sendZone(clientId, patch) {
  const z = { ...zoneOf(clientId), ...patch };
  // Optimistic local merge: two quick patches to the same device (e.g. channel
  // then band) must accumulate — the server echo lags a round-trip, so reading
  // it back would drop the first change.
  if (!deps.S.multizone) deps.S.multizone = { on: true, zones: {} };
  if (!deps.S.multizone.zones) deps.S.multizone.zones = {};
  deps.S.multizone.zones[clientId] = z;
  deps.ws.send({ type: 'zone-assign', sessionCode: deps.S.code, clientId, zone: z });
}

// A small segmented control built from DOM nodes.
function seg(values, keyFn, current, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'seg mz-seg';
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = deps.t(keyFn(v));
    if (v === current) b.classList.add('on');
    b.addEventListener('click', () => onPick(v));
    wrap.appendChild(b);
  }
  return wrap;
}

// ------------------------------------------------------------------- api ---
export function init(d) {
  deps = d;
  const toggle = document.getElementById('btn-multizone');
  if (toggle) toggle.addEventListener('click', () => {
    if (deps.S.role !== 'lead') return;
    const on = !(deps.S.multizone && deps.S.multizone.on);
    deps.ws.send({ type: 'multizone-set', sessionCode: deps.S.code, on });
  });
  const stereo = document.getElementById('mz-preset-stereo');
  if (stereo) stereo.addEventListener('click', () => {
    // Alternate left/right by join index — a quick room split.
    for (const p of deps.S.peers.filter((x) => x.connected)) {
      sendZone(p.id, { channel: (p.deviceIndex % 2 === 0) ? 'left' : 'right', band: 'full', gain: 1 });
    }
  });
  const reset = document.getElementById('mz-preset-reset');
  if (reset) reset.addEventListener('click', () => {
    for (const p of deps.S.peers.filter((x) => x.connected)) sendZone(p.id, { ...NEUTRAL });
  });
  render();
}

// Authoritative state (multizone-update or the join snapshot): store it and
// drive this device's output, then re-render the lead UI / satellite badge.
export function apply(snapshot) {
  if (!snapshot) return;
  deps.S.multizone = { on: !!snapshot.on, zones: snapshot.zones || {} };
  deps.player.setMultizoneActive(deps.S.multizone.on);
  deps.player.setZone(deps.S.multizone.on ? zoneOf(deps.S.clientId) : NEUTRAL);
  render();
}

export function render() {
  const mz = deps.S.multizone || { on: false, zones: {} };
  const { t } = deps;

  // Lead: toggle + per-device assignment rows.
  const toggle = document.getElementById('btn-multizone');
  if (toggle) {
    toggle.textContent = `${t('mz_title')}: ${mz.on ? t('on') : t('off')}`;
    toggle.classList.toggle('on', mz.on);
  }
  const controls = document.getElementById('multizone-controls');
  if (controls) controls.hidden = !mz.on;
  const list = document.getElementById('mz-list');
  if (list && deps.S.role === 'lead') {
    list.innerHTML = '';
    for (const p of deps.S.peers.filter((x) => x.connected)) {
      const z = zoneOf(p.id);
      const li = document.createElement('li');
      li.className = 'mz-row';
      const name = document.createElement('span');
      name.className = 'mz-dev';
      const label = (p.name || p.id.slice(0, 4)).toUpperCase();
      name.textContent = p.id === deps.S.clientId ? `${label} [${t('you')}]` : label;
      li.appendChild(name);
      li.appendChild(seg(CHANNELS, (v) => `mz_ch_${v}`, z.channel, (v) => sendZone(p.id, { channel: v })));
      li.appendChild(seg(BANDS, (v) => `mz_band_${v}`, z.band, (v) => sendZone(p.id, { band: v })));
      const gwrap = document.createElement('div');
      gwrap.className = 'mz-gain';
      const gval = document.createElement('span');
      gval.className = 'num mz-gain-val';
      gval.textContent = `${Math.round((z.gain ?? 1) * 100)}`;
      const g = document.createElement('input');
      g.type = 'range'; g.min = '0'; g.max = '100'; g.step = '5';
      g.value = String(Math.round((z.gain ?? 1) * 100));
      g.setAttribute('aria-label', `gain ${label}`);
      g.addEventListener('input', () => { gval.textContent = g.value; });
      g.addEventListener('change', () => sendZone(p.id, { gain: Number(g.value) / 100 }));
      gwrap.appendChild(gval);
      gwrap.appendChild(g);
      li.appendChild(gwrap);
      list.appendChild(li);
    }
  }

  // Satellite: a read-only badge of its own zone.
  const badge = document.getElementById('sat-multizone');
  if (badge) {
    const show = deps.S.role === 'satellite' && mz.on;
    badge.hidden = !show;
    if (show) {
      const z = zoneOf(deps.S.clientId);
      const txt = document.getElementById('sat-zone-text');
      if (txt) txt.textContent = isNeutral(z)
        ? t('mz_zone_full')
        : `${t('mz_ch_' + z.channel)} · ${t('mz_band_' + z.band)}${(z.gain ?? 1) < 1 ? ` · ${Math.round(z.gain * 100)}%` : ''}`;
    }
  }
}

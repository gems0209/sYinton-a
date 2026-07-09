// i18n — Italian default, English via the switch in the header.
// Dry, imperative copy in both languages (design spec: no friendly phrasing).

export const STRINGS = {
  it: {
    create: 'CREA SESSIONE',
    join: 'UNISCITI',
    join_label: 'CODICE SESSIONE',
    help_title: 'COME FUNZIONA',
    help_0: 'sYntonia trasforma gli altoparlanti di più dispositivi in un unico sound system.',
    help_1: '1 — Da un telefono si crea la sessione e si carica la traccia. Chi la avvia gestisce la musica.',
    help_2: '2 — Chiunque può entrare col codice o il link della sessione, mettendo a disposizione le proprie casse.',
    help_3: '3 — Play: tutte le casse suonano insieme, in sync.',
    help_4: 'Fuori sync? Usa lo slider di calibrazione.',
    arm: 'TOCCA PER ATTIVARE L’AUDIO',
    session: 'SESSIONE',
    devices: 'DISPOSITIVI',
    status: 'STATO',
    st_idle: 'FERMO',
    st_loading: 'CARICAMENTO',
    st_ready: 'PRONTO',
    st_playing: 'IN RIPRODUZIONE',
    st_paused: 'PAUSA',
    st_waiting: 'IN ATTESA DEL LEAD',
    st_buffering: 'BUFFERING',
    st_click: 'CLICK TRACK',
    queue_title: 'CODA',
    repeat: 'REPEAT',
    shuffle: 'SHUFFLE',
    rep_off: 'OFF',
    rep_all: 'ALL',
    rep_one: 'ONE',
    on: 'ON',
    off: 'OFF',
    drop: 'TRASCINA I FILE QUI — O TOCCA',
    drop_hint: 'ANCHE PIÙ FILE INSIEME · MP3 WAV OGG M4A FLAC · MAX 60 MB',
    uploading: 'INVIO FILE…',
    track: 'TRACCIA',
    no_track: 'NESSUNA TRACCIA',
    play: 'PLAY',
    pause: 'PAUSE',
    stop: 'STOP',
    play_anyway: 'AVVIA COMUNQUE',
    click_start: 'CLICK TRACK',
    click_stop: 'STOP CLICK',
    click_hint: 'REGOLA LA CALIBRAZIONE FINCHÉ I CLICK COINCIDONO',
    volume: 'VOLUME',
    calibration: 'CALIBRAZIONE',
    cal_hint: '+ RITARDA · − ANTICIPA',
    cal_unlock: 'SBLOCCA',
    cal_lock: 'BLOCCA',
    leave: 'ESCI',
    lead_hint: 'CONDIVIDI IL CODICE. CARICA UNA TRACCIA. PREMI PLAY.',
    share_hint: 'CONDIVIDI L’URL DI QUESTA PAGINA: CHI LO APRE ENTRA COME SATELLITE',
    sat_hint: 'COMANDA IL LEAD. QUI REGOLI SOLO VOLUME E CALIBRAZIONE.',
    sat_note: 'IPHONE: TOGLI IL SILENZIOSO · ALZA IL VOLUME · SCHERMO ACCESO',
    keep_screen: 'TIENI LO SCHERMO ACCESO',
    session_ended: 'SESSIONE TERMINATA',
    err_not_found: 'ERR: SESSIONE NON TROVATA',
    err_upload: 'ERR: FILE NON VALIDO',
    err_no_track: 'ERR: NESSUNA TRACCIA CARICATA',
    err_not_ready: 'ERR: DISPOSITIVI IN CARICAMENTO',
    connected: 'CONNESSO',
    reconnecting: 'RICONNESSIONE…',
    you: 'TU',
    lead: 'LEAD',
    satellite: 'SAT',
    debug_title: 'DEBUG — CLIENT CORRENTE',
    dbg_offset: 'OFFSET CLOCK',
    dbg_rtt: 'RTT (MEDIANA)',
    dbg_unc: 'INCERTEZZA',
    dbg_drift: 'DRIFT CORRENTE',
    dbg_outlat: 'OUTPUT LATENCY',
    dbg_resync: 'RESYNC',
    dbg_back: 'TORNA ALL’APP',
  },
  en: {
    create: 'CREATE SESSION',
    join: 'JOIN SESSION',
    join_label: 'SESSION CODE',
    help_title: 'HOW IT WORKS',
    help_0: 'sYntonia turns the speakers of multiple devices into one sound system.',
    help_1: '1 — One phone creates the session and loads the track. Whoever starts it controls the music.',
    help_2: '2 — Anyone can join with the session code or link, lending their speakers.',
    help_3: '3 — Play: every speaker plays together, in sync.',
    help_4: 'Out of sync? Use the calibration slider.',
    arm: 'TAP TO ARM AUDIO',
    session: 'SESSION',
    devices: 'DEVICES',
    status: 'STATUS',
    st_idle: 'IDLE',
    st_loading: 'LOADING',
    st_ready: 'READY',
    st_playing: 'PLAYING',
    st_paused: 'PAUSED',
    st_waiting: 'WAITING FOR LEAD',
    st_buffering: 'BUFFERING',
    st_click: 'CLICK TRACK',
    queue_title: 'QUEUE',
    repeat: 'REPEAT',
    shuffle: 'SHUFFLE',
    rep_off: 'OFF',
    rep_all: 'ALL',
    rep_one: 'ONE',
    on: 'ON',
    off: 'OFF',
    drop: 'DROP FILES — OR TAP',
    drop_hint: 'MULTIPLE FILES OK · MP3 WAV OGG M4A FLAC · MAX 60 MB',
    uploading: 'UPLOADING…',
    track: 'TRACK',
    no_track: 'NO TRACK',
    play: 'PLAY',
    pause: 'PAUSE',
    stop: 'STOP',
    play_anyway: 'PLAY ANYWAY',
    click_start: 'CLICK TRACK',
    click_stop: 'STOP CLICK',
    click_hint: 'ADJUST CALIBRATION UNTIL THE CLICKS COINCIDE',
    volume: 'VOLUME',
    calibration: 'CALIBRATION',
    cal_hint: '+ DELAYS · − ADVANCES',
    cal_unlock: 'UNLOCK',
    cal_lock: 'LOCK',
    leave: 'LEAVE',
    lead_hint: 'SHARE THE CODE. LOAD A TRACK. PRESS PLAY.',
    share_hint: 'SHARE THIS PAGE’S URL: WHOEVER OPENS IT JOINS AS SATELLITE',
    sat_hint: 'THE LEAD DRIVES. HERE YOU ONLY SET VOLUME AND CALIBRATION.',
    sat_note: 'IPHONE: SILENT SWITCH OFF · VOLUME UP · SCREEN ON',
    keep_screen: 'KEEP YOUR SCREEN ON',
    session_ended: 'SESSION ENDED',
    err_not_found: 'ERR: SESSION NOT FOUND',
    err_upload: 'ERR: INVALID FILE',
    err_no_track: 'ERR: NO TRACK LOADED',
    err_not_ready: 'ERR: DEVICES STILL LOADING',
    connected: 'CONNECTED',
    reconnecting: 'RECONNECTING…',
    you: 'YOU',
    lead: 'LEAD',
    satellite: 'SAT',
    debug_title: 'DEBUG — CURRENT CLIENT',
    dbg_offset: 'CLOCK OFFSET',
    dbg_rtt: 'RTT (MEDIAN)',
    dbg_unc: 'UNCERTAINTY',
    dbg_drift: 'CURRENT DRIFT',
    dbg_outlat: 'OUTPUT LATENCY',
    dbg_resync: 'RESYNC',
    dbg_back: 'BACK TO APP',
  },
};

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

let lang = safeGet('wavepool-lang') || 'it';
const listeners = [];

export function getLang() {
  return lang;
}

export function setLang(l) {
  if (!STRINGS[l] || l === lang) return;
  lang = l;
  try { localStorage.setItem('wavepool-lang', l); } catch { /* private mode */ }
  apply();
  for (const fn of listeners) fn(l);
}

export function onLangChange(fn) {
  listeners.push(fn);
}

export function t(key) {
  return STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
}

// Stamp every [data-i18n] element; dynamic strings re-render via onLangChange.
export function apply() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const btn of document.querySelectorAll('[data-lang]')) {
    btn.classList.toggle('active', btn.dataset.lang === lang);
    btn.setAttribute('aria-pressed', btn.dataset.lang === lang ? 'true' : 'false');
  }
}

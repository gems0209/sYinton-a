// jukebox.js — the crowd feeds the music. Runs on EVERY device.
//
// Satellites propose tracks (an upload into a separate pool, gated on an open
// jukebox and quotas) and everyone upvotes; the lead sees the ranked list and
// approves proposals into the queue or dismisses them. Zero audio-path changes:
// this is only protocol + UI. Proposer names resolve live from nicknames.

let deps = null;

// Local storage that never throws (Safari private mode).
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

const ALLOWED = ['mp3', 'wav', 'ogg', 'm4a', 'flac'];

function mkBtn(label, aria, fn) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.setAttribute('aria-label', aria);
  b.addEventListener('click', fn);
  return b;
}

// One proposal row, built from DOM nodes (user strings via textContent → no
// injection). Lead rows also carry APPROVE / NEXT / DISMISS.
function row(p, isLead) {
  const { S, ws, t } = deps;
  const li = document.createElement('li');
  li.className = 'jb-row';

  const main = document.createElement('div');
  main.className = 'jb-main';
  const name = document.createElement('span');
  name.className = 'jb-name';
  name.textContent = (p.name || '').toUpperCase();
  const by = document.createElement('span');
  by.className = 'jb-by';
  by.textContent = p.byName + (p.note ? ` · ${p.note}` : '');
  main.appendChild(name);
  main.appendChild(by);
  li.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'jb-actions';

  const voted = Array.isArray(p.voterIds) && p.voterIds.includes(S.clientId);
  const vote = mkBtn(`▲ ${p.votes}`, 'vote',
    () => ws.send({ type: 'vote-proposal', sessionCode: S.code, proposalId: p.id }));
  vote.className = 'jb-vote';
  if (voted) vote.classList.add('on');
  actions.appendChild(vote);

  if (isLead) {
    actions.appendChild(mkBtn(t('jb_approve'), 'approve',
      () => ws.send({ type: 'approve-proposal', sessionCode: S.code, proposalId: p.id, mode: 'end' })));
    const next = mkBtn(t('jb_next'), 'play next',
      () => ws.send({ type: 'approve-proposal', sessionCode: S.code, proposalId: p.id, mode: 'next' }));
    next.className = 'jb-next';
    actions.appendChild(next);
    const dismiss = mkBtn('✕', 'dismiss',
      () => ws.send({ type: 'dismiss-proposal', sessionCode: S.code, proposalId: p.id }));
    dismiss.className = 'jb-dismiss';
    actions.appendChild(dismiss);
  }
  li.appendChild(actions);
  return li;
}

function fillList(id, proposals, isLead) {
  const ul = document.getElementById(id);
  if (!ul) return;
  ul.innerHTML = '';
  proposals.forEach((p) => ul.appendChild(row(p, isLead)));
}

// Propose a file: same client-side guards as a normal upload, POSTed with the
// `proposal` flag + this device's id + the optional note.
async function proposeFile(file) {
  const { S, ws, flash, t } = deps;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (file.size > 60 * 1024 * 1024 || !ALLOWED.includes(ext)) {
    flash(`${t('err_upload')} — ${file.name.toUpperCase()}`);
    return;
  }
  const noteEl = document.getElementById('jukebox-note');
  const btn = document.getElementById('jukebox-add');
  if (btn) { btn.disabled = true; btn.textContent = t('jb_sending'); }
  try {
    const fd = new FormData();
    fd.append('proposal', '1');
    fd.append('clientId', S.clientId);
    fd.append('note', noteEl ? noteEl.value : '');
    fd.append('audio', file); // file LAST so multer has the text fields ready
    const res = await fetch(`/upload/${S.code}`, { method: 'POST', body: fd });
    if (!res.ok) throw new Error((await res.json()).error || 'UPLOAD');
    if (noteEl) noteEl.value = '';
    flash(t('jb_sent'));
    // server broadcasts jukebox-update
  } catch (err) {
    flash(`ERR: ${String(err.message).toUpperCase()}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('jb_add'); }
  }
}

// ------------------------------------------------------------------- api ---
export function init(d) {
  deps = d;

  // lead: open/close the pool
  const toggle = document.getElementById('btn-jukebox');
  if (toggle) toggle.addEventListener('click', () => {
    if (deps.S.role !== 'lead') return;
    const open = !(deps.S.jukebox && deps.S.jukebox.open);
    deps.ws.send({ type: 'jukebox-set', sessionCode: deps.S.code, open });
  });

  // satellite: nickname (persisted), note, add-track
  const nick = document.getElementById('jukebox-nick');
  if (nick) {
    const saved = lsGet('wavepool-nick');
    if (saved) nick.value = saved;
    nick.addEventListener('change', () => {
      const v = nick.value.replace(/\s+/g, ' ').trim().slice(0, 16);
      nick.value = v;
      lsSet('wavepool-nick', v);
      if (deps.S.code) deps.ws.send({ type: 'set-nickname', sessionCode: deps.S.code, name: v });
    });
  }
  const addBtn = document.getElementById('jukebox-add');
  const fileInput = document.getElementById('jukebox-file');
  if (addBtn && fileInput) {
    addBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) proposeFile(fileInput.files[0]);
      fileInput.value = '';
    });
  }
  render();
}

export function apply(snapshot) {
  if (!snapshot) return;
  deps.S.jukebox = { open: !!snapshot.open, proposals: snapshot.proposals || [] };
  render();
}

export function render() {
  const j = deps.S.jukebox || { open: false, proposals: [] };
  const { t } = deps;
  const isLead = deps.S.role === 'lead';

  const btn = document.getElementById('btn-jukebox');
  if (btn) {
    btn.textContent = `${t('jb_title')}: ${j.open ? t('jb_open') : t('jb_closed')}`;
    btn.classList.toggle('on', j.open);
  }
  const count = document.getElementById('jukebox-count');
  if (count) count.textContent = String(j.proposals.length).padStart(2, '0');
  const leadEmpty = document.getElementById('jukebox-empty');
  if (leadEmpty) leadEmpty.hidden = j.proposals.length > 0;
  fillList('jukebox-list', j.proposals, true);

  const satPanel = document.getElementById('sat-jukebox');
  if (satPanel) satPanel.hidden = !(isLead === false && deps.S.role && j.open);
  const satEmpty = document.getElementById('sat-jukebox-empty');
  if (satEmpty) satEmpty.hidden = j.proposals.length > 0;
  fillList('sat-jukebox-list', j.proposals, false);
}

// After (re)joining: re-assert the saved nickname and refresh the panels.
export function onEnter() {
  const saved = lsGet('wavepool-nick');
  if (saved && deps.S.code) deps.ws.send({ type: 'set-nickname', sessionCode: deps.S.code, name: saved });
  render();
}

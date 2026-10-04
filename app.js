import {
  getSettings, setSetting, getAll, get, put, del, snapshotsFor, addSnapshot,
  deleteSnapshotsFor, requestPersist, newPiece, exportAll, importAll,
} from './store.js';
import { analyze, auditReport } from './lint.js';
import { countWords, slugify, toFile, mdToHtml } from './md.js';
import { wordDiff, lineHunks, mergeHunks, locate } from './diff.js';
import { PASSES, buildRequest, buildPastePrompt, projectSetupText, callClaude, parseResult } from './passes.js';
import { syncAll, syncConfigured } from './sync.js';
import { DEFAULT_RULES, AUDIT_CATEGORIES, cloneRules } from './rules.js';

const STATUSES = ['idea', 'drafting', 'review', 'ready', 'published'];
const $ = (id) => document.getElementById(id);

const S = {
  settings: null,
  pieces: [],
  cur: null,
  filter: 'all',
  query: '',
  sel: { start: 0, end: 0 },
  lint: null,
  results: null,
  error: null,
  run: null,
  passId: 'revise',
  pending: null,
  hunkFocus: null,
  openChecks: false,
  syncing: false,
  lastTry: 0,
};

/* ---------- small helpers ---------- */

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function ago(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

let toastT;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

function openModal(title, ...content) {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren(...content.flat(Infinity).filter(Boolean));
  const d = $('modal');
  if (!d.open) d.showModal();
}
const closeModal = () => { const d = $('modal'); if (d.open) d.close(); };

async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = t;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

async function saveFile(name, text, type = 'text/plain') {
  const file = new File([text], name, { type });
  const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
  if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function setTab(t) {
  $('app').dataset.tab = t;
  document.querySelectorAll('#tabs button').forEach((b) =>
    b.setAttribute('aria-current', b.dataset.tab === t ? 'page' : 'false'));
  if (t === 'library') renderLibrary();
  if (t === 'review') renderReview();
}

/* ---------- piece persistence ---------- */

let saveT;
function touch(p) {
  p.updatedAt = Date.now();
  p.dirty = true;
  p.words = countWords(p.body);
  clearTimeout(saveT);
  saveT = setTimeout(() => put('pieces', p), 500);
}

async function flush() {
  clearTimeout(saveT);
  if (S.cur) await put('pieces', S.cur);
}

const livePieces = () => S.pieces.filter((p) => !p.deleted);
const dirtyCount = () => livePieces().filter((p) => p.dirty).length;

/* ---------- library ---------- */

let libT;
const renderLibraryLater = () => { clearTimeout(libT); libT = setTimeout(renderLibrary, 400); };

function renderLibrary() {
  const all = livePieces();
  const counts = { all: all.length };
  for (const s of STATUSES) counts[s] = all.filter((p) => p.status === s).length;

  $('filters').replaceChildren(
    ...['all', ...STATUSES].map((s) =>
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(S.filter === s),
        onclick: () => { S.filter = s; renderLibrary(); },
      }, s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1), h('span', { class: 'n', text: String(counts[s]) })))
  );

  const q = S.query.trim().toLowerCase();
  const rows = all
    .filter((p) => S.filter === 'all' || p.status === S.filter)
    .filter((p) => !q || p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const configured = syncConfigured(S.settings);
  $('list').replaceChildren(
    ...(rows.length
      ? rows.map((p) =>
          h('li', {},
            h('button', { type: 'button', class: 'row' + (S.cur && S.cur.id === p.id ? ' active' : ''), onclick: () => openPiece(p.id) },
              h('span', { class: 'row-title', text: p.title || 'Untitled' }),
              h('span', { class: 'row-meta' },
                h('span', { class: 'st', text: p.status }),
                h('span', { text: `${(p.words || 0).toLocaleString()} words` }),
                h('span', { text: ago(p.updatedAt) }),
                p.conflict ? h('span', { class: 'flag bad', text: 'conflict' })
                  : configured && p.dirty ? h('span', { class: 'flag', text: 'unsynced' }) : null))))
      : [h('li', { class: 'list-empty', text: all.length ? 'Nothing matches.' : 'No pieces yet. Start one with New piece.' })])
  );
  renderSyncLine();
}

function renderSyncLine(msg) {
  const el = $('sync-line');
  if (msg) { el.textContent = msg; return; }
  if (!syncConfigured(S.settings)) { el.textContent = 'Sync is off. Add a GitHub repo in Settings.'; return; }
  const conf = livePieces().filter((p) => p.conflict).length;
  const dirty = dirtyCount();
  el.textContent = conf ? `${conf} conflict${conf > 1 ? 's' : ''} to resolve`
    : dirty ? `${dirty} unsynced`
    : S.settings.lastSync ? `Synced ${ago(S.settings.lastSync)}` : 'Up to date';
}

async function createPiece() {
  await flush();
  const p = newPiece();
  S.pieces.push(p);
  await put('pieces', p);
  await openPiece(p.id);
  setTab('write');
  $('title').focus();
}

async function openPiece(id) {
  await flush();
  const p = S.pieces.find((x) => x.id === id);
  if (!p) return;
  S.cur = p;
  S.settings.lastPiece = id;
  setSetting('lastPiece', id);
  S.results = (await get('results', id)) || null;
  S.error = null;
  S.hunkFocus = null;
  loadEditor();
  renderLibrary();
  renderReview();
  setTab('write');
}

/* ---------- editor ---------- */

function loadEditor() {
  const p = S.cur;
  $('write').classList.toggle('empty-state', !p);
  if (!p) return;
  $('title').value = p.title;
  $('status').value = p.status;
  $('body').value = p.body;
  $('body').scrollTop = 0;
  S.sel = { start: 0, end: 0 };
  $('banner').hidden = !p.conflict;
  refreshMeter();
}

function setBody(text, caret) {
  const p = S.cur;
  const ta = $('body');
  const top = ta.scrollTop;
  ta.value = text;
  ta.scrollTop = top;
  p.body = text;
  if (caret != null) { ta.setSelectionRange(caret, caret); S.sel = { start: caret, end: caret }; }
  touch(p);
  refreshMeter();
}

let lintT;
const scheduleLint = () => { clearTimeout(lintT); lintT = setTimeout(refreshMeter, 300); };

function refreshMeter() {
  const p = S.cur;
  if (!p) return;
  S.lint = analyze(p.body, S.settings.rules);
  const m = S.lint;
  const r = S.settings.rules;
  const items = [
    ['words', m.words.toLocaleString(), false],
    ['passive', `${m.passivePct}%`, m.passivePct > r.maxPassivePct],
    ['openers', m.openers.length, m.openers.length > 0],
    ['long paragraphs', m.longParas.length, m.longParas.length > 0],
    ['flagged', m.flagged.length, m.flagged.length > 0],
  ];
  $('meter').replaceChildren(
    ...items.map(([k, v, over]) =>
      h('span', { class: 'm' + (over ? ' over' : '') }, h('span', { text: k }), ' ', h('b', { text: String(v) })))
  );
  if (S.openChecks) renderChecks();
}

function renderChecks() {
  const box = $('checks');
  const issues = (S.lint ? S.lint.issues : []).slice(0, 200);
  box.replaceChildren(
    ...(issues.length
      ? issues.map((i) =>
          h('button', { type: 'button', class: 'issue', onclick: () => revealRange(i.start, i.end) },
            h('span', { class: 'what', text: i.label }),
            h('span', { class: 'ctx', text: i.text })))
      : [h('p', { class: 'none', text: 'No issues found.' })])
  );
}

function toggleChecks() {
  S.openChecks = !S.openChecks;
  $('meter').setAttribute('aria-expanded', String(S.openChecks));
  $('checks').hidden = !S.openChecks;
  if (S.openChecks) renderChecks();
}

function caretY(ta, pos) {
  const cs = getComputedStyle(ta);
  const m = document.createElement('div');
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingLeft', 'paddingRight', 'paddingTop']) {
    m.style[k] = cs[k];
  }
  Object.assign(m.style, {
    position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
    boxSizing: 'border-box', width: ta.clientWidth + 'px', top: '0', left: '-9999px',
  });
  m.textContent = ta.value.slice(0, pos);
  const s = document.createElement('span');
  s.textContent = '\u200b';
  m.append(s);
  document.body.append(m);
  const y = s.offsetTop;
  m.remove();
  return y;
}

function revealRange(start, end) {
  const ta = $('body');
  setTab('write');
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(start, end);
  S.sel = { start, end };
  ta.scrollTop = Math.max(0, caretY(ta, start) - ta.clientHeight / 3);
  updateTargetLine();
}

/* ---------- scope and target ---------- */

function sectionRange(body, pos) {
  const lines = body.split('\n');
  let off = 0;
  const heads = [];
  for (const l of lines) {
    if (/^#{1,6}\s/.test(l)) heads.push(off);
    off += l.length + 1;
  }
  if (!heads.length) return null;
  let start = 0;
  let end = body.length;
  for (const hp of heads) {
    if (hp <= pos) start = hp;
    else { end = hp; break; }
  }
  if (heads[0] > pos) { start = 0; end = heads[0]; }
  return { start, end };
}

function resolveTarget(pass) {
  const body = S.cur.body;
  const hasSel = S.sel.end > S.sel.start;
  const scope = $('scope').value;
  const order = scope === 'auto' ? pass.auto : [scope];
  for (const o of order) {
    if (o === 'selection' && hasSel) {
      return { label: 'Selection', whole: false, start: S.sel.start, end: S.sel.end, text: body.slice(S.sel.start, S.sel.end) };
    }
    if (o === 'section') {
      const r = sectionRange(body, S.sel.start);
      if (r) return { label: 'Section', whole: false, start: r.start, end: r.end, text: body.slice(r.start, r.end) };
    }
    if (o === 'whole') break;
  }
  return { label: 'Whole piece', whole: true, start: 0, end: body.length, text: body };
}

function updateTargetLine() {
  const el = $('target-line');
  if (!S.cur) { el.textContent = ''; return; }
  const pass = PASSES.find((x) => x.id === S.passId);
  const t = resolveTarget(pass);
  el.textContent = `Target: ${t.label.toLowerCase()}, ${countWords(t.text).toLocaleString()} words`;
}

/* ---------- review ---------- */

function renderReview() {
  $('pass-row').replaceChildren(
    ...PASSES.map((p) =>
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(S.passId === p.id),
        onclick: () => { S.passId = p.id; S.pending = null; S.settings.lastPass = p.id; setSetting('lastPass', p.id); renderReview(); },
      }, p.label))
  );
  const pass = PASSES.find((x) => x.id === S.passId);
  $('pass-hint').textContent = pass.hint;
  const running = !!S.run;
  const paste = S.settings.mode !== 'api' && !pass.local;
  $('btn-run').disabled = running;
  $('btn-run').textContent = pass.local ? 'Run audit' : paste ? 'Copy prompt' : `Run ${pass.label.toLowerCase()}`;
  $('btn-abort').hidden = !running;
  $('instruction').hidden = !!pass.local;
  $('reply-box').hidden = !paste;
  if (paste) {
    const reading = PASSES.find((x) => x.id === (S.pending ? S.pending.passId : S.passId));
    $('paste-hint').textContent = S.pending
      ? `Prompt copied. Run it in Claude, then paste the reply here. Reading it as ${reading.label.toLowerCase()}.`
      : `Reading the reply as ${reading.label.toLowerCase()}. Copy the prompt first to send it to Claude.`;
  }
  renderRunStatus();
  updateTargetLine();
  renderResults();
}

function renderRunStatus() {
  const el = $('run-status');
  if (!S.run) { el.textContent = ''; return; }
  const secs = Math.round((Date.now() - S.run.start) / 1000);
  el.textContent = `Working, ${secs}s`;
}

function prepare(pass) {
  const p = S.cur;
  if (!p) { toast('Open a piece first'); return null; }
  const tgt = resolveTarget(pass);
  if (pass.id === 'outline') {
    if (!p.title.trim() && !p.body.trim()) { toast('Add a title or notes first'); return null; }
  } else if (!tgt.text.trim()) { toast('Nothing to work on in that scope'); return null; }
  return { p, tgt };
}

function runPass() {
  if (S.run) return;
  const pass = PASSES.find((x) => x.id === S.passId);
  if (pass.local) runAudit(pass);
  else if (S.settings.mode === 'api') runApi(pass);
  else copyPrompt(pass);
}

// Audit is local: instant, offline, nothing sent anywhere.
function runAudit(pass) {
  const prep = prepare(pass);
  if (!prep) return;
  const { p, tgt } = prep;
  const rep = auditReport(p.body, S.settings.rules, tgt.whole ? null : { start: tgt.start, end: tgt.end });
  S.results = {
    pieceId: p.id, passId: pass.id, label: pass.label, type: 'audit',
    scope: tgt.label, createdAt: Date.now(), groups: rep.groups, total: rep.total,
  };
  S.error = null;
  renderReview();
}

// Paste mode: copy the prompt, open the Claude Project, read the reply back.
function copyPrompt(pass) {
  const prep = prepare(pass);
  if (!prep) return;
  const { p, tgt } = prep;
  const prompt = buildPastePrompt(pass, {
    title: p.title, doc: p.body, target: tgt.text, whole: tgt.whole,
    instruction: $('instruction').value.trim(),
  });
  // Clipboard and window must start inside the tap, before any await.
  const copied = navigator.clipboard && navigator.clipboard.writeText
    ? navigator.clipboard.writeText(prompt).then(() => true, () => false)
    : Promise.resolve(false);
  window.open((S.settings.projectUrl || '').trim() || 'https://claude.ai/new', '_blank', 'noopener');
  S.pending = { passId: pass.id, scope: tgt.label };
  renderReview();
  (async () => {
    const ok = await copied;
    await flush();
    if (p.body.trim()) await addSnapshot(p, `Before ${pass.label.toLowerCase()}`, 'pass');
    if (ok) toast('Prompt copied. Paste it into Claude.');
    else {
      openModal('Copy this prompt',
        h('p', { class: 'subtle', text: 'The browser blocked the clipboard. Select all, copy, and paste it into Claude.' }),
        h('textarea', { class: 'field-area prompt-box', readonly: true }, prompt));
    }
  })();
}

async function readReply() {
  const p = S.cur;
  if (!p) { toast('Open a piece first'); return; }
  const raw = $('reply').value;
  if (!raw.trim()) { toast("Paste Claude's reply first"); return; }
  const pass = PASSES.find((x) => x.id === (S.pending ? S.pending.passId : S.passId));
  let parsed;
  try {
    parsed = parseResult(pass, raw);
  } catch {
    S.error = { message: 'That reply is not in the expected format. Paste the whole reply, and check the Project holds the setup text from Settings.', raw };
    renderReview();
    return;
  }
  const result = {
    pieceId: p.id, passId: pass.id, label: pass.label, type: pass.type,
    scope: 'pasted reply', createdAt: Date.now(), ...parsed,
  };
  await put('results', result);
  S.results = result;
  S.error = null;
  S.pending = null;
  S.hunkFocus = null;
  $('reply').value = '';
  renderReview();
}

async function pasteAndRead() {
  try {
    const t = await navigator.clipboard.readText();
    if (!t.trim()) { toast('The clipboard is empty'); return; }
    $('reply').value = t;
    await readReply();
  } catch {
    toast('Could not read the clipboard. Paste into the box instead.');
  }
}

// API mode (optional): the same prompt, sent straight from the browser.
async function runApi(pass) {
  if (!S.settings.apiKey) { toast('Add your API key in Settings'); setTab('settings'); return; }
  const prep = prepare(pass);
  if (!prep) return;
  const { p, tgt } = prep;

  await flush();
  if (p.body.trim()) await addSnapshot(p, `Before ${pass.label.toLowerCase()}`, 'pass');

  const req = buildRequest(pass, {
    title: p.title,
    doc: p.body,
    target: tgt.text,
    whole: tgt.whole,
    instruction: $('instruction').value.trim(),
    rules: S.settings.rules,
  });

  const ctl = new AbortController();
  S.run = { passId: pass.id, start: Date.now(), ctl };
  S.run.timer = setInterval(renderRunStatus, 1000);
  S.error = null;
  renderReview();

  try {
    const out = await callClaude(S.settings, { ...req, signal: ctl.signal });
    let parsed;
    try {
      parsed = parseResult(pass, out.text);
    } catch {
      const er = new Error(
        out.stop === 'max_tokens'
          ? 'The response was cut off. Raise Max tokens in Settings and run it again.'
          : 'The response was not in the expected format.'
      );
      er.raw = out.text;
      throw er;
    }
    const result = {
      pieceId: p.id, passId: pass.id, label: pass.label, type: pass.type,
      scope: tgt.label, createdAt: Date.now(), ...parsed,
    };
    await put('results', result);
    if (S.cur && S.cur.id === p.id) { S.results = result; S.hunkFocus = null; }
  } catch (err) {
    S.error = err.name === 'AbortError' ? { message: 'Stopped.' } : { message: err.message, raw: err.raw };
  } finally {
    clearInterval(S.run.timer);
    S.run = null;
    renderReview();
  }
}

const saveResults = () => { if (S.results) put('results', S.results); };

function diffFragment(a, b) {
  return wordDiff(a, b).map((seg) =>
    seg.t === '=' ? document.createTextNode(seg.s)
      : seg.t === '-' ? h('del', { text: seg.s })
      : h('ins', { text: seg.s }));
}

function renderResults() {
  const box = $('results');
  const parts = [];

  if (S.run) {
    parts.push(h('p', { class: 'subtle', text: 'The pass is running. Nothing in your text changes until you accept it.' }));
  }
  if (S.error) {
    parts.push(h('div', { class: 'err' }, S.error.message,
      S.error.raw ? h('div', { class: 'raw', text: S.error.raw }) : null));
  }
  const r = S.results;
  if (r && S.cur && r.pieceId === S.cur.id && !S.run) {
    if (r.type === 'hunks') parts.push(...hunkView(r));
    else if (r.type === 'notes') parts.push(...notesView(r));
    else if (r.type === 'audit') parts.push(...auditView(r));
    else parts.push(...draftView(r));
  } else if (!S.run && !S.error) {
    parts.push(h('p', { class: 'subtle', text: S.cur ? 'Run a pass to see results here.' : 'Open a piece to run a pass.' }));
  }
  box.replaceChildren(...parts);
}

function headFor(r, extra) {
  return h('div', { class: 'res-head' },
    h('p', { class: 'what', text: `${r.label}, ${r.scope.toLowerCase()}` }),
    h('span', { class: 'subtle', text: ago(r.createdAt) }),
    extra);
}

/* hunks */

function hunkView(r) {
  const pending = r.hunks.filter((x) => x.status === 'pending').length;
  const accepted = r.hunks.filter((x) => x.status === 'accepted').length;
  const head = headFor(r, pending
    ? [h('button', { type: 'button', class: 'text-btn keep', onclick: acceptAll, text: 'Accept all' }),
       h('button', { type: 'button', class: 'text-btn', onclick: rejectAll, text: 'Reject all' })]
    : null);
  if (!r.hunks.length) return [head, h('p', { class: 'subtle', text: 'No edits proposed.' })];
  return [
    head,
    h('p', { class: 'subtle', text: `${pending} pending, ${accepted} accepted` }),
    ...r.hunks.map(hunkRow),
  ];
}

function hunkRow(hk) {
  const open = hk.status === 'pending' || hk.status === 'stale';
  return h('div', { class: `hunk ${hk.status}` + (S.hunkFocus === hk.id ? ' focus' : ''), dataset: { id: hk.id } },
    h('div', { class: 'txt' }, diffFragment(hk.find, hk.replace)),
    hk.reason ? h('div', { class: 'why', text: hk.reason }) : null,
    hk.status === 'stale' ? h('div', { class: 'why', text: 'The text changed since this edit was proposed, so it cannot be placed.' }) : null,
    h('div', { class: 'acts' },
      hk.status === 'pending' ? h('button', { type: 'button', class: 'text-btn keep', onclick: () => acceptHunk(hk.id), text: 'Accept' }) : null,
      open ? h('button', { type: 'button', class: 'text-btn', onclick: () => rejectHunk(hk.id), text: 'Reject' }) : null,
      open ? h('button', { type: 'button', class: 'text-btn', onclick: () => locateHunk(hk), text: 'Show in text' }) : null,
      hk.status === 'rejected' ? h('button', { type: 'button', class: 'text-btn', onclick: () => { hk.status = 'pending'; saveResults(); renderResults(); }, text: 'Reconsider' }) : null,
      !open && hk.status !== 'rejected' ? h('span', { class: 'state', text: hk.status }) : null));
}

function applyHunk(hk) {
  const p = S.cur;
  const loc = locate(p.body, hk.find);
  if (loc.index < 0) { hk.status = 'stale'; return false; }
  const next = p.body.slice(0, loc.index) + hk.replace + p.body.slice(loc.index + loc.length);
  setBody(next, loc.index + hk.replace.length);
  hk.status = 'accepted';
  return true;
}

function acceptHunk(id) {
  const hk = S.results.hunks.find((x) => x.id === id);
  if (!hk || hk.status !== 'pending') return;
  applyHunk(hk);
  saveResults();
  advanceFocus(id);
  renderResults();
}

function rejectHunk(id) {
  const hk = S.results.hunks.find((x) => x.id === id);
  if (!hk) return;
  hk.status = 'rejected';
  saveResults();
  advanceFocus(id);
  renderResults();
}

function acceptAll() {
  for (const hk of S.results.hunks) if (hk.status === 'pending') applyHunk(hk);
  saveResults();
  renderResults();
  toast('Accepted. Restore from History if you want the earlier text back.');
}

function rejectAll() {
  for (const hk of S.results.hunks) if (hk.status === 'pending') hk.status = 'rejected';
  saveResults();
  renderResults();
}

function locateHunk(hk) {
  const loc = locate(S.cur.body, hk.find);
  if (loc.index < 0) { hk.status = 'stale'; saveResults(); renderResults(); return; }
  revealRange(loc.index, loc.index + loc.length);
}

function advanceFocus(fromId) {
  const list = S.results.hunks.filter((x) => x.status === 'pending');
  S.hunkFocus = list.length ? list[0].id : null;
  void fromId;
}

function moveFocus(dir) {
  if (!S.results || S.results.type !== 'hunks') return;
  const list = S.results.hunks.filter((x) => x.status === 'pending');
  if (!list.length) return;
  const i = list.findIndex((x) => x.id === S.hunkFocus);
  const n = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  S.hunkFocus = list[n].id;
  renderResults();
  const el = $('results').querySelector(`.hunk[data-id="${S.hunkFocus}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
}

/* notes */

function notesView(r) {
  const out = [headFor(r)];
  if (r.objection) {
    out.push(h('div', { class: 'objection' },
      h('p', { class: 'lbl', text: 'Strongest objection' }),
      h('p', { text: r.objection })));
  }
  if (!r.notes.length) out.push(h('p', { class: 'subtle', text: 'No notes.' }));
  for (const n of r.notes) {
    const found = n.quote && locate(S.cur.body, n.quote).index >= 0;
    out.push(h('div', { class: `note ${n.severity}` + (n.dismissed ? ' dismissed' : '') },
      h('div', { class: 'meta', text: [n.severity, n.kind].filter(Boolean).join(', ') }),
      n.quote
        ? (found
            ? h('button', { type: 'button', class: 'quote', onclick: () => { const l = locate(S.cur.body, n.quote); revealRange(l.index, l.index + l.length); }, text: `“${n.quote}”` })
            : h('span', { class: 'quote', text: `“${n.quote}”` }))
        : null,
      h('div', { class: 'issue-text', text: n.issue }),
      h('div', { class: 'acts' },
        h('button', { type: 'button', class: 'text-btn', onclick: () => { n.dismissed = !n.dismissed; saveResults(); renderResults(); }, text: n.dismissed ? 'Restore' : 'Dismiss' }))));
  }
  return out;
}

/* audit (local) */

function auditView(r) {
  const head = headFor(r);
  if (!r.total) return [head, h('p', { class: 'subtle', text: 'Nothing flagged. The local checks found no rule breaks.' })];
  return [
    head,
    h('p', { class: 'subtle', text: `${r.total} finding${r.total > 1 ? 's' : ''}. Tap one to jump to it. Run the audit again after editing.` }),
    ...r.groups.map((g) =>
      h('details', { class: 'group', open: g.items.length <= 6 },
        h('summary', {}, g.label, h('span', { class: 'n', text: String(g.items.length) })),
        ...g.items.slice(0, 100).map((i) =>
          h('button', { type: 'button', class: 'issue', onclick: () => revealRange(i.start, i.end) },
            h('span', { class: 'what', text: i.label }),
            h('span', { class: 'ctx', text: i.text }))))),
  ];
}

/* drafts */

function draftView(r) {
  return [
    headFor(r),
    h('div', { class: 'draft-text', text: r.text }),
    h('div', { class: 'draft-acts' },
      h('button', { type: 'button', class: 'text-btn keep', onclick: () => applyDraft('insert'), text: 'Insert at cursor' }),
      h('button', { type: 'button', class: 'text-btn', onclick: () => applyDraft('replace'), text: 'Replace selection' }),
      h('button', { type: 'button', class: 'text-btn', onclick: () => applyDraft('append'), text: 'Append' }),
      h('button', { type: 'button', class: 'text-btn', onclick: () => copyText(r.text), text: 'Copy' }),
      h('button', { type: 'button', class: 'text-btn danger', onclick: discardResults, text: 'Discard' })),
  ];
}

function applyDraft(mode) {
  const p = S.cur;
  const t = S.results.text;
  const b = p.body;
  const { start, end } = S.sel;
  let next;
  let caret;
  if (mode === 'append') {
    next = b.replace(/\s*$/, '') + (b.trim() ? '\n\n' : '') + t + '\n';
    caret = next.length;
  } else if (mode === 'replace') {
    if (end <= start) { toast('Select text in the editor first'); return; }
    next = b.slice(0, start) + t + b.slice(end);
    caret = start + t.length;
  } else {
    const before = b.slice(0, end);
    const after = b.slice(end);
    const pre = before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const post = after && !after.startsWith('\n\n') ? (after.startsWith('\n') ? '\n' : '\n\n') : '';
    next = before + pre + t + post + after;
    caret = before.length + pre.length + t.length;
  }
  setBody(next, caret);
  toast('Inserted');
}

function discardResults() {
  if (!S.cur) return;
  S.results = null;
  del('results', S.cur.id);
  renderResults();
}

/* ---------- dialogs ---------- */

function openMenu() {
  const item = (label, fn, cls = '') =>
    h('button', { type: 'button', class: 'menu-item ' + cls, onclick: () => { fn(); }, text: label });
  openModal(S.cur.title || 'Untitled',
    item('Checkpoint', () => { closeModal(); checkpoint(); }),
    item('History', openHistory),
    item('Details', openDetails),
    item('Export', openExport),
    item('Delete piece', deletePiece, 'danger'));
}

async function checkpoint() {
  if (!S.cur) return;
  await flush();
  await addSnapshot(S.cur, 'Checkpoint', 'manual');
  toast('Checkpoint saved');
  if (syncConfigured(S.settings)) syncNow({ quiet: true });
}

async function openHistory() {
  const p = S.cur;
  const snaps = await snapshotsFor(p.id);
  const rows = snaps.length
    ? snaps.map((s) => {
        const box = h('div');
        return h('div', { class: 'snap' },
          h('div', { class: 'top' },
            h('b', { text: s.label }),
            h('span', { class: 'subtle', text: `${s.words.toLocaleString()} words, ${ago(s.createdAt)}` })),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'text-btn', text: 'Compare', onclick: () => { box.replaceChildren(...compareView(s.body, p.body)); } }),
            h('button', { type: 'button', class: 'text-btn danger', text: 'Restore', onclick: async () => {
              if (!confirm('Replace the current text with this version? The current text is saved first.')) return;
              await addSnapshot(p, 'Before restore', 'pass');
              setBody(s.body, 0);
              $('body').value = s.body;
              closeModal();
              toast('Restored');
            } })),
          box);
      })
    : [h('p', { class: 'subtle', text: 'No snapshots yet. Passes and checkpoints add them.' })];
  openModal('History', rows);
}

function compareView(oldText, newText) {
  const items = lineHunks(oldText, newText).filter((x) => x.type === 'hunk');
  if (!items.length) return [h('p', { class: 'subtle', text: 'Identical to the current text.' })];
  return items.slice(0, 40).map((it) =>
    h('div', { class: 'diffbox' }, diffFragment(it.mine.join('\n'), it.theirs.join('\n'))));
}

function openDetails() {
  const p = S.cur;
  const save = () => { touch(p); renderLibraryLater(); };
  openModal('Details',
    h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Tags' }),
      h('input', { type: 'text', value: p.tags.join(', '), placeholder: 'comma separated', onchange: (e) => { p.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean); save(); } })),
    h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Excerpt' }),
      h('textarea', { class: 'field-area', onchange: (e) => { p.excerpt = e.target.value; save(); } }, p.excerpt || '')),
    h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'Stage note' }),
      h('input', { type: 'text', value: p.stage || '', placeholder: 'for example: outline approved', onchange: (e) => { p.stage = e.target.value; save(); } })),
    h('p', { class: 'subtle', text: p.path ? `File on GitHub: ${p.path}` : 'Gets a file on GitHub at the first sync.' }));
}

function openExport() {
  const p = S.cur;
  const html = mdToHtml(p.body);
  openModal('Export',
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'primary', text: 'Copy HTML', onclick: () => copyText(html) }),
      h('button', { type: 'button', class: 'text-btn', text: 'Copy markdown', onclick: () => copyText(p.body) }),
      h('button', { type: 'button', class: 'text-btn', text: 'Save .md file', onclick: () => saveFile(`${p.slug || slugify(p.title) || 'piece'}.md`, toFile(p), 'text/markdown') })),
    h('p', { class: 'subtle', text: 'HTML pastes into a WordPress Custom HTML or Classic block. The .md file includes title, tags, and excerpt as frontmatter.' }),
    p.excerpt ? h('p', { class: 'subtle', text: `Excerpt: ${p.excerpt}` }) : null,
    p.tags.length ? h('p', { class: 'subtle', text: `Tags: ${p.tags.join(', ')}` }) : null);
}

async function deletePiece() {
  const p = S.cur;
  if (!confirm(`Delete “${p.title || 'Untitled'}”? ${p.remoteSha ? 'It is removed from GitHub at the next sync.' : 'This cannot be undone.'}`)) return;
  closeModal();
  if (p.remoteSha) {
    p.deleted = true;
    await put('pieces', p);
  } else {
    await del('pieces', p.id);
    S.pieces = S.pieces.filter((x) => x.id !== p.id);
  }
  await deleteSnapshotsFor(p.id);
  await del('results', p.id);
  S.cur = null;
  S.results = null;
  S.settings.lastPiece = null;
  setSetting('lastPiece', null);
  loadEditor();
  renderLibrary();
  renderReview();
  setTab('library');
}

/* ---------- conflicts ---------- */

function openConflict(p) {
  if (!p.conflict) return;
  const items = lineHunks(p.body, p.conflict.body);
  const hunks = items.filter((x) => x.type === 'hunk');
  if (!hunks.length) {
    p.remoteSha = p.conflict.sha;
    p.conflict = null;
    p.dirty = true;
    put('pieces', p);
    toast('No differences in the text. Sync again to finish.');
    return;
  }
  const choices = hunks.map(() => 'mine');
  const rows = hunks.map((hk, i) => {
    const mine = h('div', { class: 'side on' }, h('span', { class: 'who', text: 'This device' }), hk.mine.join('\n') || '(nothing)');
    const theirs = h('div', { class: 'side' }, h('span', { class: 'who', text: 'GitHub' }), hk.theirs.join('\n') || '(nothing)');
    const bMine = h('button', { type: 'button', 'aria-pressed': 'true', text: 'Keep this device' });
    const bTheirs = h('button', { type: 'button', 'aria-pressed': 'false', text: 'Keep GitHub' });
    const set = (c) => {
      choices[i] = c;
      bMine.setAttribute('aria-pressed', String(c === 'mine'));
      bTheirs.setAttribute('aria-pressed', String(c === 'theirs'));
      mine.classList.toggle('on', c === 'mine');
      theirs.classList.toggle('on', c === 'theirs');
    };
    bMine.addEventListener('click', () => set('mine'));
    bTheirs.addEventListener('click', () => set('theirs'));
    return h('div', { class: 'conflict-hunk' }, mine, theirs, h('div', { class: 'choice' }, bMine, bTheirs));
  });
  openModal('Resolve conflict',
    h('p', { class: 'subtle', text: `${hunks.length} difference${hunks.length > 1 ? 's' : ''} between this device and GitHub. Pick one side for each.` }),
    rows,
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'primary', text: 'Apply and sync', onclick: async () => {
        await addSnapshot(p, 'Before conflict merge', 'pass');
        const merged = mergeHunks(items, choices);
        p.remoteSha = p.conflict.sha;
        p.conflict = null;
        if (S.cur && S.cur.id === p.id) { setBody(merged, 0); $('banner').hidden = true; }
        else { p.body = merged; touch(p); }
        await put('pieces', p);
        closeModal();
        syncNow();
      } })));
}

/* ---------- settings ---------- */

let savedT;
function flashSaved() {
  $('saved').textContent = 'Saved';
  clearTimeout(savedT);
  savedT = setTimeout(() => { $('saved').textContent = ''; }, 1600);
}

function renderSettings() {
  const s = S.settings;
  const r = s.rules;
  const save = (k, v) => { s[k] = v; setSetting(k, v); flashSaved(); };
  const saveRule = (k, v) => { r[k] = v; setSetting('rules', r); flashSaved(); refreshMeter(); };
  const field = (label, input, hint) =>
    h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
  const text = (k, type = 'text', ph = '') =>
    h('input', { type, value: s[k] ?? '', placeholder: ph, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', onchange: (e) => { save(k, e.target.value.trim()); if (k.startsWith('gh')) renderSyncLine(); } });
  const num = (k, target, handler) =>
    h('input', { type: 'number', min: '0', value: target[k], onchange: (e) => handler(k, Math.max(0, Number(e.target.value) || 0)) });

  const persistLine = h('p', { class: 'subtle', text: 'Checking storage…' });
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then((ok) => {
      persistLine.textContent = ok
        ? 'Storage is protected from automatic cleanup.'
        : 'The browser may clear this storage after weeks of non-use. Sync to GitHub or save a backup.';
    });
  } else persistLine.textContent = 'Storage protection is not reported by this browser. Sync to GitHub or save a backup.';

  const paste = s.mode !== 'api';
  const setup = projectSetupText(r);

  const modeSection = [
    h('h3', { text: 'How passes run' }),
    field('Mode', h('select', { id: 'mode', onchange: (e) => { save('mode', e.target.value); renderSettings(); renderReview(); } },
      h('option', { value: 'paste', selected: paste, text: 'Copy and paste (free, uses your Claude plan)' }),
      h('option', { value: 'api', selected: !paste, text: 'API (key required, billed per use)' })),
      paste
        ? 'Proof copies a prompt, you run it in your Claude Project, and you paste the reply back. No key. Audit always runs on this device.'
        : 'Proof sends passes straight to Anthropic. Audit still runs on this device.'),
  ];

  const pasteSection = [
    h('h3', { text: 'Claude Project' }),
    field('Project link', text('projectUrl', 'text', 'https://claude.ai/project/…'),
      'Open your Project on claude.ai and copy its address. Copy prompt opens it for you.'),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'primary', text: 'Copy Project setup text', onclick: () => copyText(setup) })),
    h('p', { class: 'hint subtle', text: 'Paste this into the Project\u2019s instructions once. Copy it again after you change the voice profile or rules below.' }),
    h('details', {}, h('summary', { text: 'Preview setup text' }), h('textarea', { class: 'field-area prompt-box', readonly: true }, setup)),
  ];

  const apiSection = [
    h('h3', { text: 'API' }),
    field('Anthropic API key', text('apiKey', 'password', 'sk-ant-…'), 'Stored on this device only. Requests go straight from the browser to Anthropic.'),
    field('Model', h('input', { type: 'text', list: 'models', value: s.model, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', onchange: (e) => save('model', e.target.value.trim()) }),
      'Applies to every pass.'),
    h('datalist', { id: 'models' }, ...['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'].map((m) => h('option', { value: m }))),
    field('Effort', h('select', { onchange: (e) => save('effort', e.target.value) },
      ...['low', 'medium', 'high', 'xhigh', 'max'].map((v) => h('option', { value: v, selected: s.effort === v, text: v })))),
    field('Max tokens', num('maxTokens', s, (k, v) => save(k, v || 16000)), 'Thinking counts against this. Raise it if a pass comes back cut off.'),
  ];

  const auditLists = h('details', {},
    h('summary', { text: 'Audit phrase lists' }),
    h('p', { class: 'hint subtle', text: 'One phrase per line. The local audit and the flagged count use these.' }),
    ...AUDIT_CATEGORIES.map((c) =>
      field(c.label, h('textarea', {
        class: 'field-area', rows: '6', spellcheck: 'false',
        onchange: (e) => saveRule('audit', { ...r.audit, [c.id]: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) }),
      }, (r.audit[c.id] || []).join('\n')))));

  $('settings-body').replaceChildren(
    ...modeSection,
    ...(paste ? pasteSection : apiSection),

    h('h3', { text: 'GitHub sync' }),
    field('Repository', text('ghRepo', 'text', 'owner/essays'), 'Use a private repo. Pieces are saved as markdown files under pieces/.'),
    field('Branch', text('ghBranch', 'text', 'main')),
    field('Token', text('ghToken', 'password', 'github_pat_…'), 'A fine-grained token limited to that one repo, with Contents set to read and write.'),

    h('h3', { text: 'Voice and rules' }),
    field('Voice profile', h('textarea', { class: 'field-area', rows: '14', onchange: (e) => { saveRule('voiceProfile', e.target.value); renderSettings(); } }, r.voiceProfile),
      'Goes into the Project setup text, or with every pass in API mode.'),
    field('Forbidden words and phrases', h('textarea', { class: 'field-area', rows: '10', onchange: (e) => { saveRule('forbidden', e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)); renderSettings(); } }, r.forbidden.join('\n')),
      'One per line. Flagged in the editor and included in the Project setup text.'),
    field('Passive voice limit, percent of sentences', num('maxPassivePct', r, (k, v) => { saveRule(k, v); renderSettings(); })),
    field('Sentences per paragraph, maximum', num('maxSentencesPerParagraph', r, (k, v) => { saveRule(k, v); renderSettings(); })),
    field('Em dashes per 1,000 words, maximum', num('maxEmDashPer1000', r, (k, v) => { saveRule(k, v); renderSettings(); })),
    auditLists,
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'text-btn', text: 'Reset rules to defaults', onclick: () => {
        if (!confirm('Replace your voice profile and rules with the defaults?')) return;
        s.rules = cloneRules(DEFAULT_RULES);
        setSetting('rules', s.rules);
        renderSettings();
        refreshMeter();
      } })),

    h('h3', { text: 'Data' }),
    persistLine,
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'text-btn', text: 'Save backup', onclick: async () => saveFile(`proof-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await exportAll()), 'application/json') }),
      h('label', { class: 'text-btn', style: 'display:inline-flex;align-items:center;cursor:pointer' }, 'Restore backup',
        h('input', { type: 'file', accept: 'application/json,.json', style: 'display:none', onchange: restoreBackup })),
      h('button', { type: 'button', class: 'text-btn danger', text: 'Clear keys from this device', onclick: () => {
        save('apiKey', ''); save('ghToken', ''); renderSettings(); renderSyncLine();
      } }))
  );
}

async function restoreBackup(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!confirm('Merge this backup into the current library? Pieces with the same id are overwritten.')) return;
    const n = await importAll(data);
    S.pieces = await getAll('pieces');
    S.cur = S.cur ? S.pieces.find((p) => p.id === S.cur.id) || null : null;
    loadEditor();
    renderLibrary();
    toast(`Restored ${n} piece${n === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message || 'Could not read that file');
  }
  e.target.value = '';
}

/* ---------- sync ---------- */

async function syncNow({ quiet = false } = {}) {
  if (!syncConfigured(S.settings)) {
    if (!quiet) { toast('Add a GitHub repo and token in Settings'); setTab('settings'); }
    return;
  }
  if (S.syncing) return;
  S.syncing = true;
  S.lastTry = Date.now();
  $('btn-sync').disabled = true;
  renderSyncLine('Syncing…');
  try {
    await flush();
    const removed = new Set();
    const report = await syncAll(S.settings, S.pieces, {
      save: (p) => put('pieces', p),
      remove: async (p) => { removed.add(p.id); await del('pieces', p.id); },
      add: async (p) => { S.pieces.push(p); await put('pieces', p); },
    });
    S.pieces = S.pieces.filter((p) => !removed.has(p.id));
    S.settings.lastSync = Date.now();
    setSetting('lastSync', S.settings.lastSync);

    if (S.cur && removed.has(S.cur.id)) { S.cur = null; loadEditor(); }
    if (S.cur && report.pulledIds.includes(S.cur.id)) loadEditor();
    if (S.cur) $('banner').hidden = !S.cur.conflict;

    renderLibrary();
    if (!quiet || report.conflicts || report.pulled) {
      const bits = [];
      if (report.pushed) bits.push(`${report.pushed} pushed`);
      if (report.pulled) bits.push(`${report.pulled} pulled`);
      if (report.deleted) bits.push(`${report.deleted} deleted`);
      if (report.conflicts) bits.push(`${report.conflicts} conflict${report.conflicts > 1 ? 's' : ''}`);
      toast(bits.length ? bits.join(', ') : 'Already up to date');
    }
  } catch (err) {
    renderSyncLine();
    toast(err.message || 'Sync failed');
  } finally {
    S.syncing = false;
    $('btn-sync').disabled = false;
    renderSyncLine();
  }
}

/* ---------- wiring ---------- */

function bind() {
  const ta = $('body');

  ta.addEventListener('input', () => {
    if (!S.cur) return;
    S.cur.body = ta.value;
    touch(S.cur);
    scheduleLint();
  });
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === ta) {
      S.sel = { start: ta.selectionStart, end: ta.selectionEnd };
      updateTargetLine();
    }
  });

  $('title').addEventListener('input', (e) => {
    if (!S.cur) return;
    S.cur.title = e.target.value;
    S.cur.slug = slugify(S.cur.title);
    touch(S.cur);
    renderLibraryLater();
  });
  $('status').replaceChildren(...STATUSES.map((s) => h('option', { value: s, text: s })));
  $('status').addEventListener('change', (e) => {
    if (!S.cur) return;
    S.cur.status = e.target.value;
    touch(S.cur);
    renderLibrary();
  });

  $('meter').addEventListener('click', toggleChecks);
  $('btn-menu').addEventListener('click', () => S.cur && openMenu());
  $('btn-checkpoint').addEventListener('click', checkpoint);
  $('btn-resolve').addEventListener('click', () => S.cur && openConflict(S.cur));

  $('btn-new').addEventListener('click', createPiece);
  $('btn-new-empty').addEventListener('click', createPiece);
  $('btn-sync').addEventListener('click', () => syncNow());
  $('btn-settings-d').addEventListener('click', () => setTab('settings'));
  $('btn-settings-done').addEventListener('click', () => setTab(S.cur ? 'write' : 'library'));
  $('q').addEventListener('input', (e) => { S.query = e.target.value; renderLibrary(); });

  $('scope').addEventListener('change', updateTargetLine);
  $('btn-run').addEventListener('click', runPass);
  $('btn-abort').addEventListener('click', () => S.run && S.run.ctl.abort());
  $('btn-read').addEventListener('click', readReply);
  $('btn-paste').addEventListener('click', pasteAndRead);

  document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });

  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === 'KeyS') { e.preventDefault(); checkpoint(); return; }
    if (!e.altKey) return;
    if (e.code === 'Enter') { e.preventDefault(); runPass(); }
    else if (e.code === 'KeyA') { e.preventDefault(); if (S.hunkFocus) acceptHunk(S.hunkFocus); else moveFocus(1); }
    else if (e.code === 'KeyR') { e.preventDefault(); if (S.hunkFocus) rejectHunk(S.hunkFocus); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
    else if (e.code === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else if (syncConfigured(S.settings) && Date.now() - S.lastTry > 5 * 60 * 1000) syncNow({ quiet: true });
  });
  window.addEventListener('pagehide', flush);
}

async function boot() {
  S.settings = await getSettings();
  S.pieces = await getAll('pieces');
  S.passId = PASSES.some((p) => p.id === S.settings.lastPass) ? S.settings.lastPass : 'revise';
  requestPersist();

  bind();
  renderSettings();
  renderLibrary();
  renderReview();

  const last = S.settings.lastPiece && S.pieces.find((p) => p.id === S.settings.lastPiece && !p.deleted);
  if (last) {
    S.cur = last;
    S.results = (await get('results', last.id)) || null;
    loadEditor();
    renderLibrary();
    renderReview();
  } else {
    loadEditor();
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (syncConfigured(S.settings)) syncNow({ quiet: true });
}

boot();

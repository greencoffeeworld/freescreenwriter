import * as store from './storage.js';
import { toPDF, toTXT, toFountain, parseLines } from './export.js';

const TYPES = ['scene', 'action', 'character', 'parenthetical', 'dialogue', 'transition'];
const LABEL = { scene: 'INT. LOCATION — DAY', action: 'Action', character: 'CHARACTER', parenthetical: '(parenthetical)', dialogue: 'Dialogue', transition: 'CUT TO:' };
const NEXT = { scene: 'action', action: 'action', character: 'dialogue', parenthetical: 'dialogue', dialogue: 'action', transition: 'scene' };
const TAB_ORDER = ['action', 'character', 'parenthetical', 'dialogue', 'transition', 'scene'];

const $ = (s) => document.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  id: null, version: 0, doc: null,
  dirty: false, saving: false, saveAgain: false, lastInput: 0,
  saveTimer: null, retryTimer: null,
  currentId: null, activeComment: null, composer: null, showResolved: false,
};

const blankDoc = () => ({ title: '', author: '', contact: '', blocks: [{ id: uid(), type: 'scene', text: '' }], comments: [] });
function normalize(d) {
  d = { ...blankDoc(), ...(d || {}) };
  if (!Array.isArray(d.blocks) || !d.blocks.length) d.blocks = blankDoc().blocks;
  if (!Array.isArray(d.comments)) d.comments = [];
  return d;
}

/* =================== Routing =================== */

function route() {
  const m = location.hash.match(/^#\/p\/([a-z0-9]{4,32})/i);
  if (m) open(m[1].toLowerCase());
  else showHome();
}
window.addEventListener('hashchange', route);

function showHome() {
  flushSave();
  S.id = null;
  document.title = 'Screenwriter — Minimal Online Screenplay Editor';
  $('#app').hidden = true;
  $('#home').hidden = false;
  const list = store.getRecent();
  $('#recent').innerHTML = list.map((r) =>
    `<li><a href="#/p/${esc(r.id)}"><span>${esc(r.title || 'Untitled')}</span><small>${esc(r.id)}</small></a></li>`).join('');
}

async function open(id) {
  if (S.id === id) return;
  flushSave();
  setStatus('Loading…', 'busy');
  let res = null;
  try { res = await store.loadProject(id); }
  catch (e) {
    if (e.status === 404) { toast('Project not found'); location.hash = ''; return; }
  }
  const backup = store.local.get(id);
  if (res) {
    S.doc = normalize(res.data);
    S.version = res.version;
    S.dirty = false;
    if (backup?.dirty && backup.version >= res.version) { S.doc = normalize(backup.doc); S.dirty = true; }
  } else if (backup) {
    S.doc = normalize(backup.doc); S.version = backup.version; S.dirty = !!backup.dirty;
  } else { toast('Could not reach the server'); location.hash = ''; return; }

  S.id = id;
  store.watch?.(id);
  S.activeComment = null; S.composer = null;
  $('#home').hidden = true;
  $('#app').hidden = false;
  $('#pid').textContent = id;
  store.addRecent(id, S.doc.title);
  if (S.doc.comments.some((c) => !c.resolved) && innerWidth > 1240) document.body.classList.add('comments-open');
  renderAll();
  if (S.dirty) scheduleSave(0); else setStatus(res ? 'Saved' : 'Offline — local copy', res ? 'ok' : 'warn');
  const first = S.doc.blocks.length === 1 && !S.doc.blocks[0].text ? S.doc.blocks[0] : null;
  if (first) setCaret(elOf(first.id), 0);
}

$('#newBtn').addEventListener('click', async () => {
  try {
    const r = await store.createProject(blankDoc());
    location.hash = `#/p/${r.id}`;
  } catch { toast('Could not reach the server'); }
});
$('#openForm').addEventListener('submit', (e) => {
  e.preventDefault();
  let v = $('#openId').value.trim();
  const m = v.match(/#\/p\/([a-z0-9]+)/i);
  if (m) v = m[1];
  if (v) location.hash = `#/p/${v.toLowerCase()}`;
});

/* =================== Rendering =================== */

const editor = $('#editor');
const byId = (id) => S.doc.blocks.find((b) => b.id === id);
const idx = (b) => S.doc.blocks.indexOf(b);
const elOf = (id) => editor.querySelector(`[data-id="${id}"]`);

function blockEl(b) {
  const d = document.createElement('div');
  d.className = 'block';
  d.dataset.id = b.id;
  d.dataset.type = b.type;
  d.dataset.placeholder = LABEL[b.type];
  try { d.contentEditable = 'plaintext-only'; } catch { d.contentEditable = 'true'; }
  d.spellcheck = true;
  d.textContent = b.text;
  return d;
}

function renderAll() {
  editor.replaceChildren(...S.doc.blocks.map(blockEl));
  renderMeta();
  renderComments();
}

function renderMeta() {
  if (document.activeElement !== $('#title')) $('#title').value = S.doc.title || '';
  document.title = `${S.doc.title || 'Untitled'} — Screenwriter`;
}

/* =================== Caret helpers =================== */

function pointAt(el, off) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n, last = null;
  while ((n = w.nextNode())) {
    if (off <= n.length) return [n, off];
    off -= n.length; last = n;
  }
  return last ? [last, last.length] : [el, 0];
}
function offsetOf(el, node, o) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, o);
  return r.toString().length;
}
function caretOffset(el) {
  const s = getSelection();
  if (!s.rangeCount) return 0;
  const r = s.getRangeAt(0);
  return el.contains(r.startContainer) ? offsetOf(el, r.startContainer, r.startOffset) : 0;
}
function selOffsets(el) {
  const r = getSelection().getRangeAt(0);
  const s = el.contains(r.startContainer) ? offsetOf(el, r.startContainer, r.startOffset) : 0;
  const e = el.contains(r.endContainer) ? offsetOf(el, r.endContainer, r.endOffset) : el.textContent.length;
  return [s, e];
}
function setCaret(el, off) {
  if (!el) return;
  el.focus({ preventScroll: true });
  const [n, o] = pointAt(el, off);
  const r = document.createRange();
  r.setStart(n, o); r.collapse(true);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  const rect = el.getBoundingClientRect();
  if (rect.bottom > innerHeight - 80 || rect.top < 70) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function caretLine(el, which) {
  const s = getSelection();
  if (!s.rangeCount) return true;
  const rects = s.getRangeAt(0).getClientRects();
  if (!rects.length) return true;
  const r = rects[0], er = el.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 20;
  return which === 'first' ? r.top - er.top < lh * 0.8 : er.bottom - r.bottom < lh * 0.8;
}

/* =================== Editing =================== */

function touched() {
  S.dirty = true;
  S.lastInput = Date.now();
  document.body.classList.add('typing');
  scheduleSave();
  scheduleLayout();
}

function setType(b, t) {
  if (b.type === t) return;
  b.type = t;
  const el = elOf(b.id);
  el.dataset.type = t;
  el.dataset.placeholder = LABEL[t];
  $('#elType').value = t;
  touched();
}

function autodetect(b) {
  const s = b.text;
  if (b.type === 'action' && /^(int|ext|int\.?\/ext|i\/e)[.\s]/i.test(s)) setType(b, 'scene');
  else if (b.type === 'action' && /^[A-Z0-9 .'\-]+TO:$/.test(s)) setType(b, 'transition');
  else if (b.type === 'dialogue' && s === '(') setType(b, 'parenthetical');
}

function insertBlock(nb, at) {
  S.doc.blocks.splice(at, 0, nb);
  const ref = editor.children[at];
  const el = blockEl(nb);
  editor.insertBefore(el, ref || null);
  return el;
}

function removeBlock(b) {
  S.doc.blocks.splice(idx(b), 1);
  elOf(b.id)?.remove();
}

/** Move comments when text from one block is merged into another. */
function moveComments(fromId, toId, shift) {
  for (const c of S.doc.comments) if (c.blockId === fromId) { c.blockId = toId; c.start += shift; c.end += shift; }
}

editor.addEventListener('input', (e) => {
  const el = e.target.closest('.block');
  if (!el) return;
  const b = byId(el.dataset.id);
  b.text = el.textContent;
  if (!el.textContent && el.innerHTML) el.innerHTML = '';
  autodetect(b);
  touched();
  paintHighlights();
});

editor.addEventListener('keydown', (e) => {
  const el = e.target.closest('.block');
  if (!el || e.isComposing) return;
  const b = byId(el.dataset.id);
  const i = idx(b);
  const mod = e.metaKey || e.ctrlKey;
  const blocks = S.doc.blocks;

  if (mod && /^[1-6]$/.test(e.key)) { e.preventDefault(); setType(b, TYPES[+e.key - 1]); return; }
  if (mod && e.key.toLowerCase() === 'm') { e.preventDefault(); startComment(); return; }

  if (e.key === 'Enter' && !e.shiftKey && !mod) {
    e.preventDefault();
    const o = caretOffset(el);
    if (!b.text.trim() && b.type !== 'action' && b.type !== 'scene') { setType(b, 'action'); return; }
    if (o === 0 && b.text) {
      insertBlock({ id: uid(), type: b.type, text: '' }, i);
      touched();
      return;
    }
    const before = b.text.slice(0, o), after = b.text.slice(o);
    b.text = before; el.textContent = before;
    const nb = { id: uid(), type: after ? b.type : NEXT[b.type], text: after };
    for (const c of S.doc.comments) if (c.blockId === b.id && c.start >= o) { c.blockId = nb.id; c.start -= o; c.end -= o; }
    const nel = insertBlock(nb, i + 1);
    setCaret(nel, 0);
    $('#elType').value = nb.type;
    touched(); paintHighlights();
    return;
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    const k = TAB_ORDER.indexOf(b.type);
    setType(b, TAB_ORDER[(k + (e.shiftKey ? -1 : 1) + TAB_ORDER.length) % TAB_ORDER.length]);
    return;
  }

  const collapsed = getSelection().isCollapsed;
  if (e.key === 'Backspace' && collapsed && caretOffset(el) === 0 && i > 0) {
    e.preventDefault();
    const prev = blocks[i - 1];
    const L = prev.text.length;
    prev.text += b.text;
    moveComments(b.id, prev.id, L);
    removeBlock(b);
    const pel = elOf(prev.id);
    pel.textContent = prev.text;
    setCaret(pel, L);
    touched(); paintHighlights();
    return;
  }
  if (e.key === 'Delete' && collapsed && caretOffset(el) === b.text.length && i < blocks.length - 1) {
    e.preventDefault();
    const nx = blocks[i + 1];
    const L = b.text.length;
    b.text += nx.text;
    moveComments(nx.id, b.id, L);
    removeBlock(nx);
    el.textContent = b.text;
    setCaret(el, L);
    touched(); paintHighlights();
    return;
  }

  if (e.key === 'ArrowUp' && !e.shiftKey && i > 0 && caretLine(el, 'first')) {
    e.preventDefault();
    setCaret(elOf(blocks[i - 1].id), blocks[i - 1].text.length);
  } else if (e.key === 'ArrowDown' && !e.shiftKey && i < blocks.length - 1 && caretLine(el, 'last')) {
    e.preventDefault();
    setCaret(elOf(blocks[i + 1].id), 0);
  }
});

editor.addEventListener('paste', (e) => {
  const el = e.target.closest('.block');
  const text = e.clipboardData.getData('text/plain');
  if (!el || !text.includes('\n')) return;
  e.preventDefault();
  const b = byId(el.dataset.id);
  const [s, en] = selOffsets(el);
  const before = b.text.slice(0, s), after = b.text.slice(en);
  const parsed = parseLines(text).map((p) => ({ id: uid(), ...p }));
  if (!parsed.length) return;
  let at = idx(b);
  if (before.trim()) { b.text = before; at++; } else removeBlock(b);
  S.doc.blocks.splice(at, 0, ...parsed);
  if (after.trim()) S.doc.blocks.splice(at + parsed.length, 0, { id: uid(), type: b.type, text: after });
  renderAll();
  const last = parsed[parsed.length - 1];
  setCaret(elOf(last.id), last.text.length);
  touched();
});

editor.addEventListener('focusin', (e) => {
  const el = e.target.closest('.block');
  if (!el) return;
  S.currentId = el.dataset.id;
  $('#elType').value = el.dataset.type;
});

document.addEventListener('selectionchange', () => {
  const el = document.activeElement?.closest?.('.block');
  if (!el || !S.doc) return;
  const off = caretOffset(el);
  const hit = S.doc.comments.find((c) => c.blockId === el.dataset.id && visible(c) && anchor(c) && off >= c.start && off <= c.end);
  if (hit && hit.id !== S.activeComment) setActive(hit.id);
});

document.addEventListener('mousemove', () => document.body.classList.remove('typing'));

$('#elType').addEventListener('change', (e) => {
  const b = byId(S.currentId) || S.doc.blocks[S.doc.blocks.length - 1];
  setType(b, e.target.value);
  setCaret(elOf(b.id), b.text.length);
});

$('#title').addEventListener('input', (e) => {
  S.doc.title = e.target.value;
  renderMeta(); touched();
});
$('#title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); setCaret(elOf(S.doc.blocks[0].id), 0); }
});

/* =================== Title page dialog =================== */

const tp = $('#tpDialog');
$('#titlePageBtn').addEventListener('click', () => {
  const f = tp.querySelector('form');
  f.title.value = S.doc.title; f.author.value = S.doc.author; f.contact.value = S.doc.contact;
  tp.showModal();
});
tp.addEventListener('input', (e) => {
  S.doc[e.target.name] = e.target.value;
  renderMeta(); touched();
});

/* =================== Saving & syncing =================== */

function setStatus(text, kind = '') {
  const el = $('#status');
  el.textContent = text;
  el.className = 'status ' + kind;
}

function scheduleSave(delay = 900) {
  clearTimeout(S.saveTimer);
  setStatus('Editing…', 'busy');
  S.saveTimer = setTimeout(saveNow, delay);
}

async function saveNow() {
  if (!S.dirty || !S.id) return;
  if (S.saving) { S.saveAgain = true; return; }
  clearTimeout(S.retryTimer);
  S.saving = true;
  const id = S.id, stamp = S.lastInput;
  store.local.set(id, { doc: S.doc, version: S.version, dirty: true });
  setStatus('Saving…', 'busy');
  try {
    const r = await store.saveProject(id, S.doc);
    if (id !== S.id) return;
    S.version = r.version;
    if (S.lastInput === stamp) {
      S.dirty = false;
      store.local.set(id, { doc: S.doc, version: S.version, dirty: false });
      setStatus('Saved', 'ok');
    }
    store.addRecent(id, S.doc.title);
  } catch {
    setStatus('Offline — saved locally', 'warn');
    S.retryTimer = setTimeout(saveNow, 5000);
  } finally {
    S.saving = false;
    if (S.saveAgain) { S.saveAgain = false; saveNow(); }
  }
}

function flushSave() {
  if (S.id && S.dirty) {
    store.local.set(S.id, { doc: S.doc, version: S.version, dirty: true });
    store.saveOnExit(S.id, S.doc);
  }
}
window.addEventListener('pagehide', flushSave);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

// Pull collaborators' changes while you're idle (last-write-wins).
setInterval(async () => {
  if (!S.id || S.dirty || S.saving || S.composer || document.hidden) return;
  if (Date.now() - S.lastInput < 2500) return;
  if (document.activeElement?.closest?.('#gutter, dialog')) return;
  try {
    const { version } = await store.getVersion(S.id);
    if (version <= S.version) return;
    const r = await store.loadProject(S.id);
    if (S.dirty || Date.now() - S.lastInput < 2500) return;
    const focusId = document.activeElement?.closest?.('.block')?.dataset.id;
    const off = focusId ? caretOffset(elOf(focusId)) : 0;
    S.doc = normalize(r.data);
    S.version = r.version;
    store.local.set(S.id, { doc: S.doc, version: S.version, dirty: false });
    renderAll();
    if (focusId && elOf(focusId)) setCaret(elOf(focusId), Math.min(off, byId(focusId).text.length));
    setStatus('Updated', 'ok');
  } catch { /* offline; try later */ }
}, 4000);

/* =================== Share =================== */

$('#shareBtn').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}#/p/${S.id}`;
  try { await navigator.clipboard.writeText(url); toast('Link copied — anyone with it can view & edit'); }
  catch { prompt('Share this link', url); }
});

/* =================== Export =================== */

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
$('#exportMenu').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-export]');
  if (!btn) return;
  const kind = btn.dataset.export;
  const base = (S.doc.title || 'screenplay').trim().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '_') || 'screenplay';
  if (kind === 'pdf') download(`${base}.pdf`, toPDF(S.doc));
  if (kind === 'txt') download(`${base}.txt`, toTXT(S.doc));
  if (kind === 'fountain') download(`${base}.fountain`, toFountain(S.doc, $('#withComments').checked));
  $('#exportMenu').hidePopover();
});

/* =================== Comments =================== */

const gutter = $('#gutter');
const visible = (c) => S.showResolved || !c.resolved;
const hue = (name) => [...(name || '?')].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 17);
const initials = (name) => (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Resolve a comment's current [start, end] in its block, re-anchoring by quote if text moved. */
function anchor(c) {
  const b = byId(c.blockId);
  if (!b || !c.quote) return null;
  const t = b.text;
  if (t.slice(c.start, c.start + c.quote.length) === c.quote) { c.end = c.start + c.quote.length; return [c.start, c.end]; }
  let best = -1, bd = Infinity, k = t.indexOf(c.quote);
  while (k >= 0) { const d = Math.abs(k - c.start); if (d < bd) { bd = d; best = k; } k = t.indexOf(c.quote, k + 1); }
  if (best < 0) return null;
  c.start = best; c.end = best + c.quote.length;
  return [c.start, c.end];
}

function rangeFor(blockId, s, e) {
  const el = elOf(blockId);
  if (!el) return null;
  const r = document.createRange();
  const [n1, o1] = pointAt(el, s), [n2, o2] = pointAt(el, e);
  try { r.setStart(n1, o1); r.setEnd(n2, o2); } catch { return null; }
  return r;
}

function paintHighlights() {
  if (!window.CSS?.highlights || !S.doc) return;
  const all = [], act = [];
  for (const c of S.doc.comments) {
    if (!visible(c)) continue;
    const a = anchor(c);
    const r = a && rangeFor(c.blockId, a[0], a[1]);
    if (r) (c.id === S.activeComment ? act : all).push(r);
  }
  if (S.composer) { const r = rangeFor(S.composer.blockId, S.composer.start, S.composer.end); if (r) act.push(r); }
  CSS.highlights.set('cm', new Highlight(...all));
  CSS.highlights.set('cm-active', new Highlight(...act));
}

function startComment() {
  const sel = getSelection();
  const node = sel.anchorNode;
  const el = (node?.nodeType === 1 ? node : node?.parentElement)?.closest?.('.block');
  if (!el) return toast('Put your cursor on a line to comment');
  const b = byId(el.dataset.id);
  if (!b.text.trim()) return toast('Write something first');
  let [s, e] = selOffsets(el);
  if (s > e) [s, e] = [e, s];
  if (s === e) { s = 0; e = b.text.length; }
  S.composer = { blockId: b.id, start: s, end: e, quote: b.text.slice(s, e) };
  S.activeComment = null;
  document.body.classList.add('comments-open');
  renderComments();
  gutter.querySelector('.composer [name=author]:placeholder-shown, .composer textarea')?.focus();
}

function cardHTML(c) {
  const a = anchor(c);
  const replies = (c.replies || []).map((r) => `
    <div class="reply" data-reply="${esc(r.id)}">
      <div class="card-head"><span class="avatar" style="--h:${hue(r.author)}">${esc(initials(r.author))}</span><b>${esc(r.author)}</b><time>${ago(r.ts)}</time></div>
      <p>${esc(r.text)}</p>
    </div>`).join('');
  return `
    <div class="card-head">
      <span class="avatar" style="--h:${hue(c.author)}">${esc(initials(c.author))}</span>
      <b>${esc(c.author)}</b><time>${ago(c.ts)}</time>
      <div class="card-actions">
        <button data-act="resolve" title="${c.resolved ? 'Reopen' : 'Resolve'}">${c.resolved ? '↺' : '✓'}</button>
        <button data-act="delete" title="Delete">×</button>
      </div>
    </div>
    <blockquote class="${a ? '' : 'orphan'}" title="${esc(c.quote)}">${esc(c.quote)}</blockquote>
    <p>${esc(c.text)}</p>
    ${replies}
    <form class="reply-form"><input name="reply" placeholder="Reply…" autocomplete="off"></form>`;
}

function renderComments() {
  if (!S.doc) return;
  const order = new Map(S.doc.blocks.map((b, k) => [b.id, k]));
  const list = S.doc.comments.filter(visible)
    .sort((a, b) => (order.get(a.blockId) ?? 1e9) - (order.get(b.blockId) ?? 1e9) || a.start - b.start);

  const frag = document.createDocumentFragment();
  const resolvedCount = S.doc.comments.filter((c) => c.resolved).length;
  if (resolvedCount) {
    const tools = document.createElement('div');
    tools.className = 'gutter-tools';
    tools.innerHTML = `<label><input type="checkbox" data-act="show-resolved" ${S.showResolved ? 'checked' : ''}> Show resolved (${resolvedCount})</label>`;
    frag.append(tools);
  }
  if (S.composer) {
    const d = document.createElement('div');
    d.className = 'card composer active';
    d.dataset.block = S.composer.blockId;
    d.innerHTML = `
      <blockquote>${esc(S.composer.quote)}</blockquote>
      ${store.getName() ? '' : '<input name="author" placeholder="Your name" autocomplete="name">'}
      <textarea placeholder="Add a comment…  (⌘↵ to post)"></textarea>
      <div class="row"><button class="ghost" data-act="cancel">Cancel</button><button class="primary" data-act="post">Comment</button></div>`;
    frag.append(d);
  }
  for (const c of list) {
    const d = document.createElement('div');
    d.className = 'card' + (c.resolved ? ' resolved' : '') + (c.id === S.activeComment ? ' active' : '');
    d.dataset.id = c.id;
    d.dataset.block = c.blockId;
    d.innerHTML = cardHTML(c);
    frag.append(d);
  }
  if (!list.length && !S.composer) {
    const e = document.createElement('div');
    e.className = 'gutter-empty';
    e.innerHTML = 'No comments yet.<br>Select text and press <kbd>⌘M</kbd>.';
    frag.append(e);
  }
  gutter.replaceChildren(frag);
  const open = S.doc.comments.filter((c) => !c.resolved).length;
  $('#ccount').textContent = open || '';
  $('#commentsBtn').classList.toggle('on', document.body.classList.contains('comments-open'));
  layoutComments();
  paintHighlights();
}

let layoutRaf = 0;
function scheduleLayout() { cancelAnimationFrame(layoutRaf); layoutRaf = requestAnimationFrame(layoutComments); }

/** Align each card next to its line; push down to avoid overlap. Active card wins its slot. */
function layoutComments() {
  if (matchMedia('(max-width: 1240px)').matches || !document.body.classList.contains('comments-open')) return;
  const gTop = gutter.getBoundingClientRect().top;
  const cards = [...gutter.querySelectorAll('.card')];
  const want = cards.map((card) => {
    const el = elOf(card.dataset.block);
    return el ? el.getBoundingClientRect().top - gTop : 0;
  });
  const activeIdx = cards.findIndex((c) => c.classList.contains('active'));
  const tops = new Array(cards.length);
  let y = gutter.querySelector('.gutter-tools') ? 36 : 0;
  if (activeIdx >= 0) {
    tops[activeIdx] = Math.max(want[activeIdx], 0);
    for (let k = activeIdx - 1, lim = tops[activeIdx]; k >= 0; k--) {
      const h = cards[k].offsetHeight + 10;
      tops[k] = Math.min(want[k], lim - h); lim = tops[k];
    }
    if (tops[0] < y) { const shift = y - tops[0]; for (let k = 0; k <= activeIdx; k++) tops[k] += shift; }
    y = tops[activeIdx] + cards[activeIdx].offsetHeight + 10;
    for (let k = activeIdx + 1; k < cards.length; k++) { tops[k] = Math.max(want[k], y); y = tops[k] + cards[k].offsetHeight + 10; }
  } else {
    cards.forEach((card, k) => { tops[k] = Math.max(want[k], y); y = tops[k] + card.offsetHeight + 10; });
  }
  cards.forEach((card, k) => { card.style.top = `${tops[k]}px`; });
  gutter.style.minHeight = `${y}px`;
}
window.addEventListener('resize', scheduleLayout);

function setActive(id) {
  S.activeComment = id;
  for (const card of gutter.querySelectorAll('.card[data-id]')) card.classList.toggle('active', card.dataset.id === id);
  paintHighlights();
  scheduleLayout();
}

function ensureName() {
  let n = store.getName();
  if (!n) { n = (prompt('Your name (shown on comments)') || '').trim(); if (n) store.setName(n); }
  return n;
}

function postComment() {
  const card = gutter.querySelector('.composer');
  const nameInput = card.querySelector('[name=author]');
  if (nameInput) { const n = nameInput.value.trim(); if (!n) { nameInput.focus(); return; } store.setName(n); }
  const text = card.querySelector('textarea').value.trim();
  if (!text) return;
  const c = { id: uid(), ...S.composer, author: store.getName(), text, ts: Date.now(), resolved: false, replies: [] };
  S.doc.comments.push(c);
  S.composer = null;
  S.activeComment = c.id;
  touched();
  renderComments();
}

gutter.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const card = e.target.closest('.card');
  if (act === 'show-resolved') { S.showResolved = e.target.checked; renderComments(); return; }
  if (act === 'cancel') { S.composer = null; renderComments(); return; }
  if (act === 'post') { postComment(); return; }
  if (!card?.dataset.id) return;
  const c = S.doc.comments.find((x) => x.id === card.dataset.id);
  if (act === 'resolve') { c.resolved = !c.resolved; if (c.resolved) S.activeComment = null; touched(); renderComments(); return; }
  if (act === 'delete') {
    if (confirm('Delete this comment?')) { S.doc.comments = S.doc.comments.filter((x) => x !== c); touched(); renderComments(); }
    return;
  }
  if (c.id !== S.activeComment) {
    setActive(c.id);
    const el = elOf(c.blockId);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
});

gutter.addEventListener('keydown', (e) => {
  if (e.target.closest('.composer')) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postComment(); }
    if (e.key === 'Escape') { S.composer = null; renderComments(); }
  }
});

gutter.addEventListener('submit', (e) => {
  e.preventDefault();
  const card = e.target.closest('.card');
  const input = e.target.reply;
  const text = input.value.trim();
  if (!text) return;
  const name = ensureName();
  if (!name) return;
  const c = S.doc.comments.find((x) => x.id === card.dataset.id);
  (c.replies ||= []).push({ id: uid(), author: name, text, ts: Date.now() });
  touched();
  renderComments();
  gutter.querySelector(`.card[data-id="${c.id}"] [name=reply]`)?.focus();
});

$('#commentsBtn').addEventListener('click', () => {
  document.body.classList.toggle('comments-open');
  renderComments();
});

/* =================== Toast =================== */

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

route();

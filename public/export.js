// Screenplay pagination + exporters (PDF, plain text, Fountain).
// Industry layout: US Letter, 12pt Courier (10 chars/inch, 6 lines/inch),
// 1" top/bottom, 1.5" left, 1" right → 54 lines × 60 columns per page.

const LINES_PER_PAGE = 54;
const COLS = 60;

// x = left edge in inches from page edge, w = max characters per line.
export const SPEC = {
  scene:         { x: 1.5, w: 60, upper: true, gap: true },
  action:        { x: 1.5, w: 60, gap: true },
  character:     { x: 3.7, w: 38, upper: true, gap: true },
  parenthetical: { x: 3.1, w: 26 },
  dialogue:      { x: 2.5, w: 35 },
  transition:    { x: 1.5, w: 60, upper: true, gap: true, right: true },
};

const SCENE_RE = /^(int|ext|est|int\.?\/ext|i\/e)[.\s]/i;

function wrap(text, width) {
  const out = [];
  for (const para of text.split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (let word of words) {
      while (word.length > width) { // hard-break very long tokens
        if (line) { out.push(line); line = ''; }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

function toElements(blocks) {
  return blocks
    .filter((b) => b.text && b.text.trim())
    .map((b) => {
      const s = SPEC[b.type] || SPEC.action;
      let txt = b.text.trim();
      if (s.upper) txt = txt.toUpperCase();
      if (b.type === 'parenthetical' && !txt.startsWith('(')) txt = `(${txt})`;
      return { type: b.type, s, lines: wrap(txt, s.w).map((t) => ({ t, x: s.x, right: !!s.right })) };
    });
}

/** Returns an array of pages; each page is an array of lines ({t, x, right} or null for blank). */
export function paginate(blocks) {
  const els = toElements(blocks);
  const pages = [];
  let page = [];
  const room = () => LINES_PER_PAGE - page.length;
  const flush = () => { pages.push(page); page = []; };
  const gapFor = (el) => (page.length && el.s.gap ? 1 : 0);
  const put = (lines, gap) => { if (gap) page.push(null); page.push(...lines); };

  let i = 0;
  while (i < els.length) {
    const el = els[i];

    // Dialogue group: CHARACTER + parentheticals/dialogue, split with (MORE)/(CONT'D).
    if (el.type === 'character') {
      let j = i + 1;
      while (j < els.length && (els[j].type === 'dialogue' || els[j].type === 'parenthetical')) j++;
      const name = el.lines[0].t.replace(/\s*\(CONT'D\)\s*$/, '');
      let header = el.lines;
      let body = els.slice(i + 1, j).flatMap((e) => e.lines.map((l) => ({ ...l, kind: e.type })));
      let gap = gapFor(el);
      for (;;) {
        if (gap + header.length + body.length <= room()) { put([...header, ...body], gap); break; }
        let k = Math.min(room() - gap - header.length - 1, body.length - 1);
        while (k > 0 && body[k - 1].kind === 'parenthetical') k--;
        if (page.length === 0) k = Math.max(k, 1);
        if (k >= 2 || (page.length === 0 && k >= 1)) {
          put([...header, ...body.slice(0, k), { t: '(MORE)', x: SPEC.character.x }], gap);
          flush();
          header = [{ t: `${name} (CONT'D)`, x: SPEC.character.x }];
          body = body.slice(k);
          gap = 0;
          continue;
        }
        flush();
        gap = 0;
      }
      i = j;
      continue;
    }

    // Scene heading: never orphan at page bottom — keep with ≥2 lines of what follows.
    if (el.type === 'scene') {
      const gap = gapFor(el);
      const next = els[i + 1];
      const nextNeed = next ? (next.s.gap ? 1 : 0) + Math.min(2, next.lines.length) : 0;
      if (page.length && gap + el.lines.length + nextNeed > room()) flush();
      put(el.lines, gapFor(el));
      i++;
      continue;
    }

    // Action (splittable, keeping ≥2 lines each side), transitions and others.
    let lines = el.lines;
    let gap = gapFor(el);
    while (lines.length) {
      if (gap + lines.length <= room()) { put(lines, gap); break; }
      const k = Math.min(room() - gap, lines.length - 2);
      if (el.type === 'action' && k >= 2) {
        put(lines.slice(0, k), gap); flush(); lines = lines.slice(k); gap = 0; continue;
      }
      if (page.length === 0) { put(lines.slice(0, LINES_PER_PAGE), 0); flush(); lines = lines.slice(LINES_PER_PAGE); continue; }
      flush(); gap = 0;
    }
    i++;
  }
  if (page.length || !pages.length) flush();
  return pages;
}

function titlePage(doc) {
  if (!doc.title?.trim()) return null;
  const rows = new Array(LINES_PER_PAGE).fill(null);
  rows[18] = { t: doc.title.trim().toUpperCase(), center: true };
  if (doc.author?.trim()) {
    rows[21] = { t: 'Written by', center: true };
    rows[23] = { t: doc.author.trim(), center: true };
  }
  const contact = (doc.contact || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 8);
  contact.forEach((t, k) => { rows[LINES_PER_PAGE - contact.length + k] = { t, x: 1.5 }; });
  return rows;
}

/* ---------------- Plain text ---------------- */

function lineText(l) {
  if (!l || !l.t) return '';
  if (l.right) return ' '.repeat(Math.max(0, COLS - l.t.length)) + l.t;
  if (l.center) return ' '.repeat(Math.max(0, Math.floor((COLS - l.t.length) / 2))) + l.t;
  return ' '.repeat(Math.round((l.x - 1.5) * 10)) + l.t;
}

export function toTXT(doc) {
  const out = [];
  const tp = titlePage(doc);
  if (tp) out.push(tp.map(lineText).join('\n').replace(/\s+$/, ''), '\f');
  paginate(doc.blocks).forEach((pg, n) => {
    if (n > 0) out.push('\f');
    if (n > 0) out.push(' '.repeat(COLS - String(n + 1).length - 1) + (n + 1) + '.\n\n');
    out.push(pg.map(lineText).join('\n').replace(/\s+$/, '') + '\n');
  });
  return new Blob([out.join('')], { type: 'text/plain;charset=utf-8' });
}

/* ---------------- Fountain ---------------- */

export function toFountain(doc, withComments = false) {
  const head = [];
  if (doc.title) head.push(`Title: ${doc.title}`);
  if (doc.author) head.push('Credit: Written by', `Author: ${doc.author}`);
  if (doc.contact) head.push('Contact:', ...doc.contact.split('\n').map((l) => '    ' + l));

  const notesFor = (id) => !withComments ? '' : (doc.comments || [])
    .filter((c) => c.blockId === id && !c.resolved)
    .map((c) => ` [[${c.author || 'Note'}: ${c.text}${(c.replies || []).map((r) => ` / ${r.author}: ${r.text}`).join('')}]]`)
    .join('');

  let body = '';
  for (const b of doc.blocks) {
    let t = (b.text || '').trim();
    if (!t) continue;
    let tight = false;
    switch (b.type) {
      case 'scene': t = t.toUpperCase(); if (!SCENE_RE.test(t)) t = '.' + t; break;
      case 'character': t = t.toUpperCase(); if (!/[A-Z]/.test(t)) t = '@' + t; break;
      case 'parenthetical': tight = true; if (!t.startsWith('(')) t = `(${t})`; break;
      case 'dialogue': tight = true; break;
      case 'transition': t = t.toUpperCase(); if (!/TO:$/.test(t)) t = '> ' + t; break;
      default: if (/[A-Z]/.test(t) && !/[a-z]/.test(t)) t = '!' + t;
    }
    body += (body ? (tight ? '\n' : '\n\n') : '') + t + notesFor(b.id);
  }
  const text = (head.length ? head.join('\n') + '\n\n' : '') + body + '\n';
  return new Blob([text], { type: 'text/plain;charset=utf-8' });
}

/* ---------------- PDF (hand-built, standard Courier font) ---------------- */

const WIN_ANSI = { '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '–': 0x96, '—': 0x97, '…': 0x85, '•': 0x95, '€': 0x80 };

function pdfText(s) {
  let out = '';
  for (const ch of s) {
    let c = WIN_ANSI[ch] ?? ch.codePointAt(0);
    if (c > 255) c = 63; // '?'
    const chr = String.fromCharCode(c);
    out += chr === '(' || chr === ')' || chr === '\\' ? '\\' + chr : chr;
  }
  return out;
}

export function toPDF(doc) {
  const W = 612, H = 792, CHAR_W = 7.2; // Courier 12pt: 600/1000 em
  const all = [];
  const tp = titlePage(doc);
  if (tp) all.push({ lines: tp });
  paginate(doc.blocks).forEach((lines, n) => all.push({ lines, num: n > 0 ? n + 1 : 0 }));

  const objs = {};
  const kids = [];
  let next = 4;
  for (const pg of all) {
    const pid = next++, cid = next++;
    kids.push(pid);
    let s = 'BT\n/F1 12 Tf\n';
    const draw = (t, x, y) => { s += `1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${pdfText(t)}) Tj\n`; };
    pg.lines.forEach((l, row) => {
      if (!l || !l.t) return;
      const w = l.t.length * CHAR_W;
      const x = l.right ? 7.5 * 72 - w : l.center ? (W - w) / 2 : l.x * 72;
      draw(l.t, x, H - 72 - row * 12 - 9);
    });
    if (pg.num) { const t = `${pg.num}.`; draw(t, 7.5 * 72 - t.length * CHAR_W, H - 36 - 9); }
    s += 'ET';
    objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${cid} 0 R >>`;
    objs[cid] = `<< /Length ${s.length} >>\nstream\n${s}\nendstream`;
  }
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  const infoId = next++;
  objs[infoId] = `<< /Title (${pdfText(doc.title || 'Screenplay')}) /Author (${pdfText(doc.author || '')}) /Creator (Screenwriter) >>`;

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let k = 1; k < next; k++) {
    offsets[k] = out.length;
    out += `${k} 0 obj\n${objs[k]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let k = 1; k < next; k++) out += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${next} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF`;

  const bytes = new Uint8Array(out.length);
  for (let k = 0; k < out.length; k++) bytes[k] = out.charCodeAt(k) & 0xff;
  return new Blob([bytes], { type: 'application/pdf' });
}

/* ---------------- Fountain-ish paste parser ---------------- */

export function parseLines(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const blocks = [];
  let inDialogue = false;
  for (let k = 0; k < lines.length; k++) {
    const raw = lines[k];
    const t = raw.trim();
    if (!t) { inDialogue = false; continue; }
    const prevBlank = k === 0 || !lines[k - 1].trim();
    const nextFilled = k + 1 < lines.length && lines[k + 1].trim();
    let type = 'action', txt = t;
    if (inDialogue) type = t.startsWith('(') ? 'parenthetical' : 'dialogue';
    else if (t.startsWith('.') && !t.startsWith('..')) { type = 'scene'; txt = t.slice(1); }
    else if (SCENE_RE.test(t)) type = 'scene';
    else if (t.startsWith('>') && !t.endsWith('<')) { type = 'transition'; txt = t.slice(1).trim(); }
    else if (/^[A-Z0-9 .'\-]+TO:$/.test(t)) type = 'transition';
    else if (t.startsWith('!')) txt = t.slice(1);
    else if ((t.startsWith('@') || (/[A-Z]/.test(t) && !/[a-z]/.test(t.replace(/\(.*?\)/g, '')))) && prevBlank && nextFilled) {
      type = 'character'; txt = t.replace(/^@/, ''); inDialogue = true;
    }
    blocks.push({ type, text: txt });
  }
  return blocks;
}

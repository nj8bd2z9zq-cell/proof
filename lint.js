// Local, offline checks that drive the margin meter and the checks list.
// Every issue carries absolute offsets into the body so the editor can jump to it.

import { countWords } from './md.js';

const ABBR = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'u.s', 'u.k', 'no', 'inc', 'ltd', 'co', 'fig', 'approx', 'dept',
]);

const NOT_PARTICIPLES =
  'need|speed|feed|seed|indeed|hundred|proceed|exceed|succeed|breed|bleed|freed|weed|greed|creed|bed|red|shed|sled';
const IRREGULAR =
  'built|made|taken|given|shown|known|seen|done|held|kept|left|lost|paid|sold|told|brought|bought|caught|found|taught|thought|written|driven|chosen|broken|spoken|stolen|forced|funded';
const PASSIVE_RE = new RegExp(
  `\\b(?:am|is|are|was|were|be|been|being|get|gets|got|gotten)\\s+(?:\\w+ly\\s+)?(?:(?!(?:${NOT_PARTICIPLES})\\b)\\w{2,}ed|${IRREGULAR})\\b`,
  'i'
);
const TRIAD_RE = /\b[\w'’-]+, [\w'’-]+,? (?:and|or) [\w'’-]+\b/g;

function isAbbr(text, i) {
  let k = i;
  while (k > 0 && /[A-Za-z.]/.test(text[k - 1])) k--;
  const w = text.slice(k, i).toLowerCase();
  if (w.length === 1 && /[a-z]/.test(w)) return true;
  return ABBR.has(w);
}

export function sentencesOf(text, base = 0) {
  const res = [];
  let start = 0;
  const n = text.length;
  const push = (s, e) => {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) res.push({ start: base + s, end: base + e, text: text.slice(s, e) });
  };
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === '.' || c === '!' || c === '?') {
      let j = i + 1;
      while (j < n && /[.!?]/.test(text[j])) j++;
      while (j < n && /["”’')\]*_]/.test(text[j])) j++;
      if (j >= n || /\s/.test(text[j])) {
        if (c === '.' && j === i + 1 && isAbbr(text, i)) { i = j - 1; continue; }
        push(start, j);
        start = j;
      }
      i = j - 1;
    }
  }
  push(start, n);
  return res;
}

function splitBlocks(body) {
  const blocks = [];
  let pos = 0;
  let cur = null;
  let fence = false;
  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
  for (const line of body.split('\n')) {
    const start = pos;
    const end = pos + line.length;
    pos = end + 1;
    if (/^\s*```/.test(line)) { flush(); fence = !fence; continue; }
    if (fence) continue;
    if (/^\s*$/.test(line)) { flush(); continue; }
    if (/^#{1,6}\s/.test(line)) { flush(); blocks.push({ kind: 'heading', start, end, text: line }); continue; }
    const isList = /^\s*(?:[-*+]|\d+[.)])\s+/.test(line);
    if (isList) {
      if (cur && cur.kind !== 'list') flush();
      if (!cur) cur = { kind: 'list', start, end, text: line };
      else { cur.end = end; cur.text += '\n' + line; }
      continue;
    }
    if (cur && cur.kind === 'list') flush();
    if (!cur) cur = { kind: 'prose', start, end, text: line };
    else { cur.end = end; cur.text += '\n' + line; }
  }
  flush();
  return blocks;
}

function forbiddenRegex(list) {
  const parts = (list || [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const e = s
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+')
        .replace(/'/g, "['’]");
      return (/^\w/.test(s) ? '\\b' : '') + e + (/\w$/.test(s) ? '\\b' : '');
    });
  return parts.length ? new RegExp(parts.join('|'), 'gi') : null;
}

const firstWord = (t) => {
  const m = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/u);
  return m ? m[0].toLowerCase() : '';
};

const excerpt = (s, n = 90) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s);

export function analyze(body, rules) {
  const words = countWords(body);
  const blocks = splitBlocks(body);
  const issues = [];
  const longParas = [];
  const prose = [];

  for (const b of blocks) {
    if (b.kind !== 'prose') continue;
    const sents = sentencesOf(b.text, b.start);
    if (sents.length > rules.maxSentencesPerParagraph) {
      longParas.push({ start: b.start, end: b.end, count: sents.length });
      issues.push({
        kind: 'longpara', start: b.start, end: b.end,
        label: `Paragraph has ${sents.length} sentences`, text: excerpt(b.text),
      });
    }
    prose.push(...sents);
  }

  let passiveCount = 0;
  for (const s of prose) {
    if (PASSIVE_RE.test(s.text)) {
      passiveCount++;
      issues.push({ kind: 'passive', start: s.start, end: s.end, label: 'Passive voice', text: excerpt(s.text) });
    }
  }
  const passivePct = prose.length ? Math.round((passiveCount / prose.length) * 100) : 0;

  const openers = [];
  for (let i = 1; i < prose.length; i++) {
    const a = firstWord(prose[i - 1].text);
    if (a && a === firstWord(prose[i].text)) {
      openers.push({ start: prose[i].start, end: prose[i].end });
      issues.push({
        kind: 'opener', start: prose[i].start, end: prose[i].end,
        label: `Opens with “${a}” like the sentence before`, text: excerpt(prose[i].text),
      });
    }
  }

  const forbidden = [];
  const re = forbiddenRegex(rules.forbidden);
  if (re) {
    let m;
    while ((m = re.exec(body))) {
      forbidden.push({ start: m.index, end: m.index + m[0].length, match: m[0] });
      issues.push({
        kind: 'forbidden', start: m.index, end: m.index + m[0].length,
        label: `Flagged: ${m[0].toLowerCase()}`, text: excerpt(body.slice(Math.max(0, m.index - 30), m.index + m[0].length + 40).replace(/\s+/g, ' ')),
      });
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  const triads = [];
  for (const b of blocks) {
    if (b.kind !== 'prose') continue;
    TRIAD_RE.lastIndex = 0;
    let m;
    while ((m = TRIAD_RE.exec(b.text))) {
      const start = b.start + m.index;
      triads.push({ start, end: start + m[0].length });
      issues.push({ kind: 'triad', start, end: start + m[0].length, label: 'List of three', text: m[0] });
    }
  }

  const dashes = [];
  const dashRe = /—/g;
  let dm;
  while ((dm = dashRe.exec(body))) dashes.push({ start: dm.index, end: dm.index + 1 });
  if (words && (dashes.length / words) * 1000 > rules.maxEmDashPer1000) {
    for (const d of dashes) {
      issues.push({
        kind: 'dash', start: d.start, end: d.end, label: 'Em dash',
        text: excerpt(body.slice(Math.max(0, d.start - 30), d.end + 40).replace(/\s+/g, ' ')),
      });
    }
  }

  issues.sort((a, b) => a.start - b.start);
  return {
    words,
    sentences: prose.length,
    passiveCount,
    passivePct,
    openers,
    longParas,
    forbidden,
    triads,
    dashes,
    issues,
  };
}

// Compact summary handed to the audit pass.
export function lintNote(m) {
  if (!m) return '';
  const lines = [
    `words ${m.words}; sentences ${m.sentences}`,
    `passive sentences ${m.passiveCount} (${m.passivePct}%)`,
    `repeated openers ${m.openers.length}; long paragraphs ${m.longParas.length}; flagged terms ${m.forbidden.length}; triads ${m.triads.length}; em dashes ${m.dashes.length}`,
  ];
  for (const f of m.forbidden.slice(0, 15)) lines.push(`flagged: ${f.match}`);
  return lines.join('\n');
}

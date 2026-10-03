// Markdown helpers: frontmatter read/write, word count, slugs, HTML export.

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function countWords(text) {
  const t = String(text || '').replace(/```[\s\S]*?```/g, ' ');
  const m = t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
  return m ? m.length : 0;
}

/* ---------- frontmatter ---------- */

const q = (s) => JSON.stringify(String(s == null ? '' : s));

export function toFile(p) {
  const fm = [
    '---',
    `title: ${q(p.title)}`,
    `slug: ${q(p.slug)}`,
    `status: ${p.status}`,
    `stage: ${q(p.stage || '')}`,
    `tags: [${(p.tags || []).map(q).join(', ')}]`,
    `excerpt: ${q(p.excerpt || '')}`,
    `created: ${new Date(p.createdAt).toISOString()}`,
    `updated: ${new Date(p.updatedAt).toISOString()}`,
    '---',
    '',
  ].join('\n');
  return fm + '\n' + p.body;
}

function splitList(inner) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && inQ) { cur += c + (inner[++i] || ''); continue; }
    if (c === '"') inQ = !inQ;
    if (c === ',' && !inQ) { out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseVal(v) {
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { /* fall through */ }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? splitList(inner).map(parseVal) : [];
  }
  return v;
}

export function fromFile(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  let body = text;
  if (m) {
    body = text.slice(m[0].length).replace(/^\r?\n/, '');
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i < 1) continue;
      meta[line.slice(0, i).trim()] = parseVal(line.slice(i + 1).trim());
    }
  }
  return { meta, body };
}

/* ---------- markdown to HTML ---------- */

function safeUrl(u) {
  return /^\s*(javascript|data|vbscript):/i.test(u) ? '#' : u;
}

function inline(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img src="${safeUrl(u)}" alt="${a}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${safeUrl(u)}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
  s = s.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
  return s;
}

const isBlockStart = (l) =>
  /^```/.test(l) || /^#{1,6}\s/.test(l) || /^>\s?/.test(l) ||
  /^\s*[-*+]\s+/.test(l) || /^\s*\d+[.)]\s+/.test(l) ||
  /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l);

export function mdToHtml(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }

    if (/^```/.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }

    let m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) {
      out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^>\s?/.test(line)) {
      const inner = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) inner.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${mdToHtml(inner.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && (para.length === 0 || !isBlockStart(lines[i]))) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

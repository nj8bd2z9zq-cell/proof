// Diff helpers. No dependencies.

export function diffSeq(a, b, eq = (x, y) => x === y) {
  let s = 0;
  const maxS = Math.min(a.length, b.length);
  while (s < maxS && eq(a[s], b[s])) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && eq(a[ea - 1], b[eb - 1])) { ea--; eb--; }

  const ops = [];
  for (let i = 0; i < s; i++) ops.push({ t: '=', v: a[i] });

  const A = a.slice(s, ea);
  const B = b.slice(s, eb);
  const n = A.length;
  const m = B.length;

  if (n === 0) B.forEach((v) => ops.push({ t: '+', v }));
  else if (m === 0) A.forEach((v) => ops.push({ t: '-', v }));
  else if (n * m > 6e6) {
    A.forEach((v) => ops.push({ t: '-', v }));
    B.forEach((v) => ops.push({ t: '+', v }));
  } else {
    const W = m + 1;
    const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = eq(A[i], B[j])
          ? L[(i + 1) * W + j + 1] + 1
          : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(A[i], B[j])) { ops.push({ t: '=', v: A[i] }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { ops.push({ t: '-', v: A[i] }); i++; }
      else { ops.push({ t: '+', v: B[j] }); j++; }
    }
    while (i < n) ops.push({ t: '-', v: A[i++] });
    while (j < m) ops.push({ t: '+', v: B[j++] });
  }

  for (let i = ea; i < a.length; i++) ops.push({ t: '=', v: a[i] });
  return ops;
}

const TOKEN = /\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu;

// Returns segments [{t:'=' | '-' | '+', s}] describing a -> b at word level.
export function wordDiff(a, b) {
  const ops = diffSeq(a.match(TOKEN) || [], b.match(TOKEN) || []);

  const fold = ops.map((o, i) =>
    o.t === '=' && /^\s+$/.test(o.v) && i > 0 && i < ops.length - 1 &&
    ops[i - 1].t !== '=' && ops[i + 1].t !== '='
  );

  const out = [];
  let del = '';
  let ins = '';
  const flush = () => {
    if (del) out.push({ t: '-', s: del });
    if (ins) out.push({ t: '+', s: ins });
    del = '';
    ins = '';
  };
  ops.forEach((o, i) => {
    if (o.t === '=' && !fold[i]) {
      flush();
      const last = out[out.length - 1];
      if (last && last.t === '=') last.s += o.v;
      else out.push({ t: '=', s: o.v });
    } else if (o.t === '=') { del += o.v; ins += o.v; }
    else if (o.t === '-') del += o.v;
    else ins += o.v;
  });
  flush();
  return out;
}

// Conflict view: line-level hunks between two bodies.
export function lineHunks(mine, theirs) {
  const ops = diffSeq(mine.split('\n'), theirs.split('\n'));
  const items = [];
  let cur = null;
  for (const o of ops) {
    if (o.t === '=') {
      cur = null;
      const last = items[items.length - 1];
      if (last && last.type === 'same') last.lines.push(o.v);
      else items.push({ type: 'same', lines: [o.v] });
    } else {
      if (!cur) { cur = { type: 'hunk', mine: [], theirs: [] }; items.push(cur); }
      (o.t === '-' ? cur.mine : cur.theirs).push(o.v);
    }
  }
  return items;
}

// choices: array of 'mine' | 'theirs', one per hunk, in order.
export function mergeHunks(items, choices) {
  let k = 0;
  const out = [];
  for (const it of items) {
    if (it.type === 'same') out.push(...it.lines);
    else out.push(...(choices[k++] === 'theirs' ? it.theirs : it.mine));
  }
  return out.join('\n');
}

// Find an AI-proposed `find` string in the body. Exact match first, then a
// whitespace- and quote-tolerant match.
export function locate(body, find) {
  const i = body.indexOf(find);
  if (i >= 0) {
    let count = 0;
    let k = -1;
    while ((k = body.indexOf(find, k + 1)) >= 0) count++;
    return { index: i, length: find.length, count };
  }
  const pattern = find
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
    .replace(/["“”]/g, '["“”]')
    .replace(/['‘’]/g, "['‘’]");
  if (!pattern) return { index: -1, length: 0, count: 0 };
  try {
    const m = new RegExp(pattern).exec(body);
    if (m) return { index: m.index, length: m[0].length, count: 1 };
  } catch { /* fall through */ }
  return { index: -1, length: 0, count: 0 };
}

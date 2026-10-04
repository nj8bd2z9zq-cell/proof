// GitHub sync. One markdown file per piece under pieces/. Conflict detection
// compares the remote blob sha to the sha recorded at the last successful sync.

import { fromFile, toFile, slugify, countWords } from './md.js';
import { uid } from './store.js';

const API = 'https://api.github.com';
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64e(str) {
  const bytes = enc.encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64d(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  return dec.decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function syncConfigured(s) {
  return /^[^/\s]+\/[^/\s]+$/.test((s.ghRepo || '').trim()) && !!(s.ghToken || '').trim();
}

function cfg(s) {
  const [owner, repo] = s.ghRepo.trim().split('/');
  return { owner, repo, branch: (s.ghBranch || 'main').trim(), token: s.ghToken.trim() };
}

async function gh(c, method, path, body) {
  const res = await fetch(`${API}/repos/${c.owner}/${c.repo}${path ? '/' + path : ''}`, {
    method,
    headers: {
      Authorization: `Bearer ${c.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 404 && method === 'GET') return { notFound: true, data };
  if (!res.ok) {
    const msg = (data && data.message) || res.statusText || 'request failed';
    if (res.status === 401) throw new Error('GitHub rejected the token. Check it in Settings.');
    if (res.status === 403) throw new Error(`GitHub refused access: ${msg}`);
    throw new Error(`GitHub ${res.status}: ${msg}`);
  }
  return { data };
}

async function listRemote(c) {
  const repo = await gh(c, 'GET', '');
  if (repo.notFound) throw new Error('Repo not found, or the token has no access to it.');
  const r = await gh(c, 'GET', `contents/pieces?ref=${encodeURIComponent(c.branch)}`);
  const map = new Map();
  if (r.notFound) return map; // folder does not exist yet
  for (const f of r.data) if (f.type === 'file' && f.name.endsWith('.md')) map.set(f.path, f.sha);
  return map;
}

async function getRemote(c, path) {
  const r = await gh(c, 'GET', `contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(c.branch)}`);
  if (r.notFound) throw new Error(`Missing on GitHub: ${path}`);
  return { sha: r.data.sha, text: b64d(r.data.content) };
}

async function putRemote(c, path, text, sha, message) {
  const r = await gh(c, 'PUT', `contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    message,
    content: b64e(text),
    branch: c.branch,
    ...(sha ? { sha } : {}),
  });
  return r.data.content.sha;
}

async function delRemote(c, path, sha, message) {
  await gh(c, 'DELETE', `contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    message,
    sha,
    branch: c.branch,
  });
}

function uniquePath(p, used) {
  const base = slugify(p.title) || p.id.slice(0, 8);
  let path = `pieces/${base}.md`;
  let n = 2;
  while (used.has(path)) path = `pieces/${base}-${n++}.md`;
  return path;
}

function applyRemote(p, remote) {
  const { meta, body } = fromFile(remote.text);
  const h1 = body.match(/^#\s+(.+)$/m);
  const fileSlug = p.path ? p.path.replace(/^pieces\//, '').replace(/\.md$/, '') : '';
  p.title = meta.title || (h1 && h1[1]) || fileSlug || 'Untitled';
  p.slug = meta.slug || fileSlug;
  p.status = ['idea', 'drafting', 'review', 'ready', 'published'].includes(meta.status) ? meta.status : p.status || 'drafting';
  p.stage = meta.stage || '';
  p.tags = Array.isArray(meta.tags) ? meta.tags : [];
  p.excerpt = meta.excerpt || '';
  p.body = body;
  p.words = countWords(body);
  p.createdAt = Date.parse(meta.created) || p.createdAt || Date.now();
  p.updatedAt = Date.parse(meta.updated) || p.updatedAt || Date.now();
  p.remoteSha = remote.sha;
  p.dirty = false;
  p.conflict = null;
}

// io: { save(p), remove(p), add(p) }. Returns a report; throws on network or auth errors.
export async function syncAll(settings, pieces, io) {
  const c = cfg(settings);
  const remote = await listRemote(c);
  const report = { pushed: 0, pulled: 0, deleted: 0, conflicts: 0, pulledIds: [] };
  const known = new Map(pieces.filter((p) => p.path).map((p) => [p.path, p]));
  const used = new Set([...remote.keys(), ...pieces.filter((p) => p.path).map((p) => p.path)]);

  for (const p of pieces) {
    if (!p.path && !p.deleted) {
      p.path = uniquePath(p, used);
      used.add(p.path);
    }
  }

  for (const p of [...pieces]) {
    if (p.conflict) { report.conflicts++; continue; }
    const rsha = p.path ? remote.get(p.path) : undefined;

    if (p.deleted) {
      if (p.path && rsha && rsha === p.remoteSha) {
        await delRemote(c, p.path, rsha, `Delete ${p.title || p.path}`);
        report.deleted++;
      }
      await io.remove(p);
      continue;
    }

    if (p.dirty) {
      let baseSha = p.remoteSha;
      if (rsha && rsha !== p.remoteSha) {
        const r = await getRemote(c, p.path);
        const theirs = fromFile(r.text);
        if (theirs.body === p.body) {
          baseSha = r.sha; // only metadata differs; local metadata wins
        } else {
          p.conflict = { body: theirs.body, sha: r.sha, title: theirs.meta.title || '' };
          report.conflicts++;
          await io.save(p);
          continue;
        }
      } else if (!rsha) {
        baseSha = undefined;
      }
      const stamp = p.updatedAt;
      const text = toFile(p);
      const sha = await putRemote(c, p.path, text, baseSha || undefined, `Update ${p.title || p.path}`);
      p.remoteSha = sha;
      if (p.updatedAt === stamp) p.dirty = false;
      report.pushed++;
      await io.save(p);
    } else if (rsha && rsha !== p.remoteSha) {
      const r = await getRemote(c, p.path);
      if (p.dirty) continue; // edited while the request was in flight
      applyRemote(p, r);
      report.pulled++;
      report.pulledIds.push(p.id);
      await io.save(p);
    } else if (!rsha && p.remoteSha) {
      // Gone from GitHub: keep the local copy and push it again.
      p.remoteSha = null;
      p.dirty = true;
      const stamp = p.updatedAt;
      const sha = await putRemote(c, p.path, toFile(p), undefined, `Restore ${p.title || p.path}`);
      p.remoteSha = sha;
      if (p.updatedAt === stamp) p.dirty = false;
      report.pushed++;
      await io.save(p);
    }
  }

  for (const [path, sha] of remote) {
    if (known.has(path)) continue;
    const r = await getRemote(c, path);
    const now = Date.now();
    const p = {
      id: uid(), title: '', slug: '', status: 'drafting', stage: '', tags: [], excerpt: '',
      body: '', words: 0, createdAt: now, updatedAt: now, path, remoteSha: sha,
      dirty: false, deleted: false, conflict: null,
    };
    applyRemote(p, r);
    await io.add(p);
    report.pulled++;
  }

  return report;
}

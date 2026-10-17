// Moving git history between people through the huddle server, so nobody
// needs push access to anyone else's remote. Branches are published as
// bundles; everyone fetches them into refs/remotes/huddle/<person>/<branch>,
// which works with plain `git merge huddle/<person>/<branch>`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { CONFIG_DIR } = require('./client');

const CHUNK = 900 * 1024;

function git(root, args, opts = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: opts.encoding || 'utf8', maxBuffer: 256 * 1024 * 1024, input: opts.input });
  return { ok: r.status === 0, out: (r.stdout || '').toString().trim(), err: (r.stderr || '').toString().trim(), status: r.status };
}

function isRepo(root) { return git(root, ['rev-parse', '--is-inside-work-tree']).out === 'true'; }

// .huddle/ holds the project token and .claude/settings.local.json our hooks:
// neither may ever be committed, or they'd travel to everyone with the history
const PRIVATE = ['.huddle/', '.claude/settings.local.json'];
function ensureExcluded(root) {
  const dir = git(root, ['rev-parse', '--git-dir']);
  if (!dir.ok) return;
  const file = path.resolve(root, dir.out, 'info', 'exclude');
  let cur = '';
  try { cur = fs.readFileSync(file, 'utf8'); } catch {}
  const missing = PRIVATE.filter(l => !cur.split('\n').includes(l));
  if (!missing.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (cur && !cur.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}

// refuse to share history that contains huddle's private files
function leaksPrivate(root, revs) {
  const r = git(root, ['log', '--format=', '--name-only', ...revs, '--', '.huddle', '.claude/settings.local.json']);
  return r.ok && r.out.trim().length > 0;
}
function head(root) { const r = git(root, ['rev-parse', '--verify', '-q', 'HEAD']); return r.ok ? r.out : null; }
function hasCommit(root, sha) { return git(root, ['cat-file', '-e', `${sha}^{commit}`]).ok; }
function subject(root, ref = 'HEAD') { return git(root, ['log', '-1', '--format=%s', ref]).out; }
function dirty(root) {
  const r = git(root, ['status', '--porcelain', '--untracked-files=no']);
  return r.ok ? r.out.split('\n').filter(Boolean) : [];
}

// current branch name, or null outside git / on a detached HEAD
let cached = { root: null, at: 0, branch: null };
function currentBranch(root, maxAgeMs = 2000) {
  if (cached.root === root && Date.now() - cached.at < maxAgeMs) return cached.branch;
  const r = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  cached = { root, at: Date.now(), branch: r.ok && r.out ? r.out : null };
  return cached.branch;
}

const refSafe = (s) => String(s).replace(/[^\w.-]+/g, '-');
function remoteRef(owner, branch) { return `refs/remotes/huddle/${refSafe(owner)}/${branch}`; }
function shortRef(owner, branch) { return `huddle/${refSafe(owner)}/${branch}`; }

function stateFile(root) { return path.join(root, CONFIG_DIR, 'git.json'); }
function loadState(root) { try { return JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); } catch { return { applied: [] }; } }
function saveState(root, st) { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), JSON.stringify(st)); }

function tmpFile(ext) { return path.join(os.tmpdir(), `huddle-${process.pid}-${crypto.randomBytes(4).toString('hex')}${ext}`); }

// Share the current branch. Sends only commits the server doesn't already have.
async function publish(client, root, { branch } = {}) {
  if (!isRepo(root)) return { skipped: 'not a git repository' };
  ensureExcluded(root);
  branch = branch || currentBranch(root, 0);
  const tip = branch ? git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).out : null;
  if (!branch || !tip) return { skipped: 'no commits on a branch yet' };
  const me = client.agent.name;
  const st = await client.get('git');
  const mine = st.refs[`${me}/${branch}`];
  const snap = st.snapshots && st.snapshots[`${me}/${branch}`];
  if (mine && mine.sha === tip) {
    if (!snap || snap.sha !== tip) await uploadSnapshot(client, root, branch, tip);
    return { unchanged: true, branch, tip };
  }
  const known = [...new Set([...st.bundles.map(b => b.tip), ...Object.values(st.refs).map(r => r.sha)])].filter(s => hasCommit(root, s));
  const subj = subject(root, tip);
  if (known.includes(tip)) {
    await client.post('git-ref', { branch, tip, subject: subj });
    await uploadSnapshot(client, root, branch, tip);
    return { branch, tip, bytes: 0 };
  }
  if (leaksPrivate(root, [tip, ...known.map(s => `^${s}`)])) {
    throw new Error('these commits contain .huddle/ or .claude/settings.local.json (your invite token and hook settings). Remove them from history before sharing.');
  }
  const file = tmpFile('.bundle');
  try {
    const r = git(root, ['bundle', 'create', file, `refs/heads/${branch}`, ...known.map(s => `^${s}`)]);
    if (!r.ok) {
      if (/empty bundle/i.test(r.err)) { await client.post('git-ref', { branch, tip, subject: subj }); await uploadSnapshot(client, root, branch, tip); return { branch, tip, bytes: 0 }; }
      throw new Error('git bundle failed: ' + r.err);
    }
    const buf = fs.readFileSync(file);
    const prereqs = bundlePrereqs(buf);
    const id = crypto.randomBytes(8).toString('hex');
    const n = Math.max(1, Math.ceil(buf.length / CHUNK));
    for (let i = 0; i < n; i++) {
      const data = buf.subarray(i * CHUNK, (i + 1) * CHUNK).toString('base64');
      await client.post('git-upload', { id, i, n, data, branch, tip, prereqs, subject: subj }, { timeout: 120000 });
    }
    const s = loadState(root);
    s.applied = [...new Set([...(s.applied || []), id])];
    saveState(root, s);
    await uploadSnapshot(client, root, branch, tip);
    return { branch, tip, bytes: buf.length };
  } finally { fs.rmSync(file, { force: true }); }
}

// A readable copy of the branch's text files for the dashboard's Code view.
// Binary and very large files are listed as skipped instead.
const SNAP_FILE_MAX = 256 * 1024, SNAP_TOTAL_MAX = 4 * 1024 * 1024, SNAP_PART = 800 * 1024;
async function uploadSnapshot(client, root, branch, sha) {
  const ls = git(root, ['ls-tree', '-r', '-l', '-z', sha]);
  if (!ls.ok) return;
  const files = [], skipped = [];
  let total = 0;
  for (const rec of ls.out.split('\0').filter(Boolean)) {
    const m = /^\d+ (\w+) ([0-9a-f]+)\s+(-|\d+)\t([\s\S]*)$/.exec(rec);
    if (!m || m[1] !== 'blob') continue;
    const [, , obj, size, fp] = m;
    if (Number(size) > SNAP_FILE_MAX || total + Number(size) > SNAP_TOTAL_MAX) { skipped.push(fp); continue; }
    const buf = spawnSync('git', ['cat-file', 'blob', obj], { cwd: root, maxBuffer: SNAP_FILE_MAX * 2 }).stdout;
    if (!buf || buf.includes(0)) { skipped.push(fp); continue; }
    files.push({ path: fp, content: buf.toString('utf8') });
    total += buf.length;
  }
  const parts = [[]];
  let cur = 0;
  for (const f of files) {
    const sz = JSON.stringify(f).length;
    if (cur + sz > SNAP_PART && parts[parts.length - 1].length) { parts.push([]); cur = 0; }
    parts[parts.length - 1].push(f);
    cur += sz;
  }
  for (let i = 0; i < parts.length; i++) {
    await client.post('git-snapshot', { branch, sha, i, n: parts.length, files: parts[i], skipped: i === parts.length - 1 ? skipped : [] }, { timeout: 120000 });
  }
}

// "-<sha>" lines in a bundle header are commits the receiver must already have
function bundlePrereqs(buf) {
  const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString('latin1');
  const end = head.indexOf('\n\n');
  return (end < 0 ? head : head.slice(0, end)).split('\n').filter(l => l.startsWith('-')).map(l => l.slice(1, 41));
}

// Pull everyone else's published branches into refs/remotes/huddle/*.
// Never touches the working tree or local branches.
async function fetchAll(client, root, log = () => {}) {
  if (!isRepo(root)) return { skipped: 'not a git repository' };
  const st = await client.get('git');
  const s = loadState(root);
  const applied = new Set(s.applied || []);
  let fetched = 0;
  for (const b of st.bundles) {
    if (applied.has(b.id)) continue;
    if (hasCommit(root, b.tip)) { applied.add(b.id); continue; }
    if (b.prereqs.some(x => !hasCommit(root, x))) continue; // an earlier bundle we can't use yet
    const file = tmpFile('.bundle');
    try {
      const parts = [];
      for (let i = 0; i < b.n; i++) parts.push(Buffer.from((await client.get('git-chunk', { id: b.id, i: String(i) }, { timeout: 120000 })).data, 'base64'));
      fs.writeFileSync(file, Buffer.concat(parts));
      const r = git(root, ['fetch', '-q', '--no-tags', file, `+refs/heads/${b.branch}:${remoteRef(b.owner, b.branch)}`]);
      if (!r.ok) { log(`couldn't fetch ${b.owner}/${b.branch}: ${r.err}`); continue; }
      applied.add(b.id);
      fetched++;
    } finally { fs.rmSync(file, { force: true }); }
  }
  // point every ref at its latest commit (some moves came without a bundle)
  for (const ref of Object.values(st.refs)) {
    if (ref.owner === client.agent.name && ref.checkout === client.agent.checkout) continue;
    if (hasCommit(root, ref.sha)) git(root, ['update-ref', remoteRef(ref.owner, ref.branch), ref.sha]);
  }
  s.applied = [...applied];
  saveState(root, s);
  return { fetched, refs: st.refs };
}

// how HEAD relates to another commit
function relation(root, other) {
  const h = head(root);
  if (!h) return 'empty';
  if (h === other) return 'same';
  if (git(root, ['merge-base', '--is-ancestor', h, other]).ok) return 'behind';
  if (git(root, ['merge-base', '--is-ancestor', other, h]).ok) return 'ahead';
  return git(root, ['merge-base', h, other]).ok ? 'diverged' : 'unrelated';
}

function counts(root, other) {
  const r = git(root, ['rev-list', '--left-right', '--count', `HEAD...${other}`]);
  const [ahead, behind] = r.ok ? r.out.split(/\s+/).map(Number) : [0, 0];
  return { ahead, behind };
}

function merge(root, ref) {
  const unrelated = relation(root, git(root, ['rev-parse', ref]).out) === 'unrelated';
  const r = git(root, ['merge', '--no-edit', ...(unrelated ? ['--allow-unrelated-histories'] : []), ref]);
  const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
  return { ok: r.ok, conflicts, output: (r.out + '\n' + r.err).trim() };
}

// "alex" or "alex/feature": their branch with that name, else the one matching
// ours, else their newest
function resolveRef(refs, query, me) {
  const [owner, ...rest] = String(query || '').split('/');
  const want = rest.join('/');
  const others = Object.values(refs || {}).filter(r => !(r.owner === me.name && r.checkout === me.checkout));
  const cands = others.filter(r => r.owner.toLowerCase() === owner.toLowerCase()).sort((x, y) => y.at - x.at);
  return cands.find(x => x.branch === want) || (!want && (cands.find(x => x.branch === me.branch) || cands[0])) || null;
}

module.exports = { ensureExcluded, resolveRef, git, isRepo, head, hasCommit, dirty, currentBranch, publish, fetchAll, relation, counts, merge,
  remoteRef, shortRef, subject, refSafe };

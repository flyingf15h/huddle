// Environment-agnostic heart of the relay: project state and the API routes.
// Used by the Node server (server.js) and the Cloudflare Worker (worker/).
'use strict';
const path = require('path');
const crypto = require('crypto');

const ONLINE_MS = 2 * 60 * 1000;          // agent counts as online if seen this recently
const LOCK_STALE_MS = 5 * 60 * 1000;      // locks of agents unseen this long are dropped
const FORGET_MS = 24 * 60 * 60 * 1000;   // offline agents drop off the list after a day
const MAX_EVENTS = 2000;
const MAX_MESSAGES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const HASH_HISTORY = 100;
const MAX_FILES = 2000;                    // per project
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const OPEN_MAX_PROJECTS = 5000;            // open mode limits, so a public server can't be filled up
const OPEN_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const OPEN_CREATES_PER_HOUR = 20;

const DEFAULT_LIMITS = { fileBytes: MAX_FILE_BYTES, files: MAX_FILES, projectBytes: MAX_PROJECT_BYTES,
  sharedBytes: 1536 * 1024, gitBytes: 200 * 1024 * 1024 };
const DOC_BYTES = 64 * 1024;        // PROJECT.md and each skill
const MEMORY_BYTES = 4 * 1024;      // each memory note
const MAX_MEMORIES = 300;
const MAX_SKILLS = 40;
const MAX_ACTIVITY = 600;
const GIT_CHUNK = 900 * 1024;       // raw bytes per uploaded bundle piece
const MAX_TASKS = 400;
const SNAP_PART = 900 * 1024;       // JSON bytes per uploaded piece of a branch's file listing           // per project, newest kept
const ACTIVITY_TEXT = 4000;
const STATS_DAYS = 60;              // daily buckets kept per person
const STATS_MODELS = 20;            // models tracked per person
const MAX_WORKLOG = 80;             // recent "now working on" changes, newest kept
const MAX_HANDOFFS = 60;            // "where I left off" notes, newest kept
// events that change who's doing what; hooks only re-read the team when this count moves
const TEAM_EVENTS = new Set(['status', 'lock', 'unlock', 'join', 'leave', 'setting']);

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function now() { return Date.now(); }
function httpError(code, msg) { const e = new Error(msg); e.code = code; return e; }
function sameSecret(x, y) {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Locks and live file copies are per git branch: people on the same branch
// share a working copy, people on different branches only see each other.
function fileKey(branch, fp) { return branch ? `${branch}::${fp}` : fp; }

// "Pip (tszfei's Claude)", or just "tszfei's Claude" when the person hasn't named it
function aiLabel(settings, person) {
  const n = ((settings || {})[person] || {}).aiName;
  return n ? `${n} (${person}'s Claude)` : `${person}'s Claude`;
}
// lets people address someone's Claude by the name they gave it: "Pip" -> "tszfei"
function personFor(p, name) {
  if (!name) return null;
  const want = String(name).toLowerCase();
  for (const [person, s] of Object.entries(p.settings || {})) if (s && s.aiName && s.aiName.toLowerCase() === want) return person;
  return name;
}

// The lock of someone else's Claude that stops `who` locking fp (a folder when dir is set). A folder
// lock covers everything inside it, and two Claudes' locks never overlap: no file in someone's
// folder, no folder around someone's file or folder.
function blockingLock(p, who, branch, fp, dir) {
  const mine = dir ? fp + '/' : fp;
  for (const l of Object.values(p.locks)) {
    if (l.holder === who || (l.branch || null) !== branch) continue;
    if (l.path === mine || (l.dir && (fp + '/').startsWith(l.path)) || (dir && l.path.startsWith(fp + '/'))) return l;
  }
  return null;
}
// a person's canonical name: aliases first, then a name that only differs in capitals ("kelly" -> "Kelly")
function canonicalName(p, name) {
  name = (p.aliases || {})[name] || name;
  if (!name) return name;
  const known = new Set([...Object.values(p.agents).map(a => a.name), ...Object.keys(p.settings || {}), ...Object.keys(p.stats || {})]);
  if (known.has(name)) return name;
  for (const k of known) if (k && k.toLowerCase() === name.toLowerCase()) return k;
  return name;
}
// board tasks a commit message says it finishes: "[1a2b3c4d]", "#1a2b3c4d", "closes 1a2b3c4d", "done: task 1a2b3c4d"
const CLOSES = /(?:\[|#|\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|done|finish(?:e[sd])?|complete[sd]?)\b[\s:]*(?:task\s*)?\[?#?)([0-9a-f]{8})\b/gi;
function taskIdsIn(text) { return [...new Set([...String(text || '').matchAll(CLOSES)].map(m => m[1].toLowerCase()))]; }

function normPath(p) {
  if (typeof p !== 'string' || !p) throw httpError(400, 'path required');
  const n = path.posix.normalize(p.replace(/\\/g, '/')).replace(/(.)\/+$/, '$1'); // folders are passed as "dir/"; we keep the slash ourselves
  if (n.startsWith('../') || n === '..' || path.posix.isAbsolute(n)) throw httpError(400, 'path must be relative to the project root');
  return n;
}

class Project {
  constructor(name, saved) {
    this.name = name;
    this.agents = {};   // id -> {id,name,host,checkout,kind,status,lastSeen,readSeq,joined}
    this.locks = {};    // path -> {path,holder,holderName,checkout,since,note,hold}
    this.files = {};    // path -> {path,hash,content,by,byName,at,version,hashes,checkout}
    this.messages = [];
    this.events = [];
    this.seq = 0;
    this.tokenHash = null;   // set for projects created in open mode; their own token unlocks them
    this.lastActive = now();
    // knowledge every agent in the project shares: a brief, notes and skills
    this.shared = { version: 0, doc: null, memories: [], skills: [] };
    this.activity = [];   // what each agent's Claude is doing: prompts, replies, tool calls
    // git history people published, as bundles; refs are "<person>/<branch>"
    this.git = { refs: {}, bundles: [], bytes: 0, uploads: {}, snapshots: {} };
    // team prompts ("goals") and the tasks the agents split them into
    this.board = { version: 0, goals: [], tasks: [] };
    this.settings = {};   // per person: { autopilot: 'off' | 'requests' | 'full', aiName: what they call their Claude }
    this.aliases = {};    // other names a person has used ("Kelly-Wang" -> "Kelly")
    this.stats = {};      // per person: conversations, turns, time with Claude, tokens (see 'POST stats')
    this.teamVersion = 0; // bumped by TEAM_EVENTS
    this.worklog = [];    // [{name, status, at}]: what each Claude said it started on
    this.handoffs = [];   // [{name, ai, text, files, commits, at}]: where a session left off, for whoever comes next
    this.waiters = new Set();
    if (saved) Object.assign(this, saved);
    this.waiters = new Set();
    this.dirty = false;
    this.changedFiles = new Set();     // paths whose content changed since the last save
    this.sharedChanged = false;
    this.activityChanged = false;
    this.boardChanged = false;
    this.isConnected = () => false;    // servers with live sockets count those agents as online
    this.limits = { ...DEFAULT_LIMITS };
  }
  toJSON() {
    const { waiters, dirty, changedFiles, sharedChanged, activityChanged, boardChanged, isConnected, limits, ...rest } = this;
    return rest;
  }
  // events after `since`, or null if they've been dropped and the client must resync
  eventsSince(since) {
    if (since >= this.seq) return [];
    if (!this.events.length || this.events[0].seq > since + 1) return since === 0 && !this.events.length ? [] : null;
    return this.events.filter(ev => ev.seq > since);
  }
  sharedSize() { return JSON.stringify(this.shared).length; }
  changeShared(kind, action, info, by) {
    if (this.sharedSize() > this.limits.sharedBytes) throw httpError(413, 'shared knowledge is full; delete some memories or skills');
    this.shared.version++;
    this.sharedChanged = true;
    return this.emit('shared', { kind, action, ...info, byName: by.name, version: this.shared.version });
  }
  online(a) { return now() - a.lastSeen < ONLINE_MS || this.isConnected(a.id); }
  emit(type, data) {
    const ev = { seq: ++this.seq, type, at: now(), ...data };
    if (TEAM_EVENTS.has(type)) this.teamVersion = (this.teamVersion || 0) + 1;
    this.dirty = true;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const w of [...this.waiters]) w(ev);
    return ev;
  }
  publicAgent(a) {
    return { id: a.id, name: a.name, host: a.host, checkout: a.checkout, kind: a.kind, branch: a.branch || null, runner: a.runner || null,
      status: a.status, statusAt: a.statusAt || null, lastSeen: a.lastSeen, online: this.online(a), build: a.build || null, clone: a.clone || null };
  }
  fileMeta(f) {
    return { path: f.path, branch: f.branch || null, hash: f.hash, by: f.by, byName: f.byName, at: f.at,
      version: f.version, size: f.content == null ? 0 : f.content.length, checkout: f.checkout };
  }
  snapshot() {
    return {
      project: this.name,
      seq: this.seq,
      agents: Object.values(this.agents).map(a => this.publicAgent(a)),
      locks: Object.values(this.locks),
      files: Object.values(this.files).map(f => this.fileMeta(f)),
      settings: this.settings || {},
      aliases: this.aliases || {},
      teamVersion: this.teamVersion || 0,
    };
  }
  touch(agent) {
    if (!agent || !agent.id) throw httpError(400, 'agent.id required');
    // a dashboard tab that never set a name is a visitor, not a teammate
    if (agent.kind === 'human' && agent.host === 'dashboard' && ['human', 'guest'].includes(agent.name)) {
      return { id: agent.id, name: agent.name, kind: 'human', status: '', lastSeen: now(), readSeq: this.seq, transient: true };
    }
    let a = this.agents[agent.id];
    // the name a session gives resolves once (aliases, capitals), not on every request
    const name = a && a.rawName === agent.name ? a.name : canonicalName(this, agent.name);
    const fresh = !a || !this.online(a);
    if (!a) {
      a = this.agents[agent.id] = { id: agent.id, readSeq: this.seq, joined: now(), status: '' };
    }
    a.rawName = agent.name;
    a.name = name || a.name || agent.id;
    a.host = agent.host || a.host || '';
    a.checkout = agent.checkout || a.checkout || '';
    a.kind = agent.kind || a.kind || 'agent';
    if (agent.branch !== undefined) a.branch = agent.branch || null;
    a.lastSeen = now();
    this.lastActive = a.lastSeen;
    if (fresh) this.emit('join', { agent: this.publicAgent(a) });
    return a;
  }
  relevant(m, a) {
    if (m.from === a.id) return false;
    return !m.to || m.to === a.id || m.to === a.name || m.to === '*';
  }
  sweep() {
    const t = now();
    for (const l of Object.values(this.locks)) {
      const a = this.agents[l.holder];
      if (!a || (t - a.lastSeen > LOCK_STALE_MS && !this.isConnected(a.id))) {
        delete this.locks[l.path];
        this.emit('unlock', { path: l.path, holder: l.holder, holderName: l.holderName, reason: 'stale' });
      }
    }
    const held = new Set(Object.values(this.locks).map(l => l.holder));
    // each person keeps one offline row per kind (the newest): old sessions are noise, not people
    const newest = {};
    for (const a of Object.values(this.agents)) {
      const k = a.name + '\0' + a.kind;
      if (!this.online(a) && !held.has(a.id) && (!newest[k] || newest[k].lastSeen < a.lastSeen)) newest[k] = a;
    }
    for (const a of Object.values(this.agents)) {
      const k = a.name + '\0' + a.kind;
      if (newest[k] && newest[k] !== a && !this.online(a) && !held.has(a.id) && !a.wasOnline) { delete this.agents[a.id]; continue; }
      if (t - a.lastSeen > FORGET_MS && !held.has(a.id) && !this.isConnected(a.id)) { delete this.agents[a.id]; continue; }
      const on = this.online(a);
      if (a.wasOnline && !on) {
        a.wasOnline = false;
        this.emit('leave', { agent: this.publicAgent(a) });
      } else if (on) a.wasOnline = true;
    }
  }
}


const routes = {
  'POST hello': (p, b) => {
    const a = p.touch(b.agent);
    if (b.build !== undefined) a.build = b.build && typeof b.build === 'object' ? { sha: String(b.build.sha || '').slice(0, 40), at: Number(b.build.at) || 0 } : null;
    if (b.clone !== undefined) a.clone = b.clone ? String(b.clone).slice(0, 200) : null;
    if (b.status !== undefined && a.clone) a.statusAt = now();
    if (b.runner !== undefined) a.runner = ['off', 'requests', 'full'].includes(b.runner) ? b.runner : null;
    if (b.status !== undefined) a.status = String(b.status).slice(0, 300);
    p.dirty = true;
    return { ...p.snapshot(), you: p.publicAgent(a), ...(b.handoffs ? { handoffs: (p.handoffs || []).slice(-20) } : {}) };
  },
  'GET state': (p) => p.snapshot(),
  'GET worklog': (p, b, q) => ({ worklog: (p.worklog || []).slice(-Math.min(Number(q.get('limit')) || 20, MAX_WORKLOG)) }),
  // one call per prompt instead of five: share the prompt, set the status, read mail, and get the
  // team's state and this person's open tasks back
  'POST turn': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    if (Array.isArray(b.items) && b.items.length) routes['POST activity'](p, { agent: b.agent, items: b.items });
    if (b.status) routes['POST status'](p, { agent: b.agent, status: b.status, auto: b.auto });
    const out = await routes['POST inbox'](p, { agent: b.agent }, q, ctx);
    // the rest only when it changed since the versions the caller last saw
    if (b.state || (b.teamVersion !== undefined && b.teamVersion !== out.teamVersion)) out.state = p.snapshot();
    if (b.boardVersion !== undefined && b.boardVersion !== p.board.version) out.board = p.board;
    if (b.sharedVersion !== undefined && b.sharedVersion !== p.shared.version) out.shared = p.shared;
    if (b.handoffsSince !== undefined) out.handoffs = (p.handoffs || []).filter(h => h.at > b.handoffsSince && h.agent !== a.id);
    out.tasks = p.board.tasks.filter(t => t.owner === a.name && t.status !== 'done');
    return out;
  },
  // where a session left off, for the team and the next session: one note per session, newest wins
  'POST handoff': (p, b) => {
    const a = p.touch(b.agent);
    const text = String(b.text || '').trim().slice(0, 2000);
    if (!text) throw httpError(400, 'say where you left off');
    const h = { id: crypto.randomBytes(4).toString('hex'), name: a.name, agent: a.id, text, branch: a.branch || null,
      files: (Array.isArray(b.files) ? b.files : []).slice(0, 20).map(x => String(x).slice(0, 200)),
      commits: (Array.isArray(b.commits) ? b.commits : []).slice(0, 10).map(x => String(x).slice(0, 160)),
      at: now(), auto: !!b.auto };
    const prev = (p.handoffs || []).find(x => x.agent === a.id);
    if (b.auto && prev && !prev.auto) return { ok: true, handoff: prev, kept: true }; // Claude's own note beats a generated one
    p.handoffs = (p.handoffs || []).filter(x => x.agent !== a.id);
    p.handoffs.push(h);
    if (p.handoffs.length > MAX_HANDOFFS) p.handoffs.splice(0, p.handoffs.length - MAX_HANDOFFS);
    p.emit('handoff', { handoff: h });
    return { ok: true, handoff: h };
  },
  'GET handoffs': (p, b, q) => ({ handoffs: (p.handoffs || []).slice(-Math.min(Number(q.get('limit')) || 10, MAX_HANDOFFS)) }),
  // new commits from someone's checkout: tasks their messages say are finished get closed
  'POST commits': (p, b) => {
    const a = p.touch(b.agent);
    const closed = [];
    for (const c of (Array.isArray(b.commits) ? b.commits : []).slice(0, 50)) {
      for (const id of taskIdsIn(c.message)) {
        const t = p.board.tasks.find(x => x.id === id);
        if (!t || t.status === 'done') continue;
        t.status = 'done';
        t.owner = t.owner || a.name;
        t.updated = now();
        t.notes = [...(t.notes || []), { by: a.name, at: now(), text: `closed by commit ${String(c.sha || '').slice(0, 8)}: ${String(c.message).split('\n')[0].slice(0, 200)}` }].slice(-20);
        goalDone(p, t);
        closed.push(t);
      }
    }
    if (closed.length) boardChanged(p, 'task-update', { task: closed[0], tasks: closed }, a);
    return { ok: true, closed: closed.map(t => ({ id: t.id, title: t.title })) };
  },
  'POST bye': (p, b) => {
    const a = p.agents[b.agent && b.agent.id];
    if (a) {
      a.lastSeen = now() - ONLINE_MS; // shows as just gone offline
      a.runner = null;
      a.wasOnline = false;
      a.status = '';
      p.emit('leave', { agent: p.publicAgent(a) });
      p.dirty = true;
    }
    return { ok: true };
  },
  // two names are the same person: fold "from" into "into" everywhere, and keep it that way
  'POST merge-person': (p, b) => {
    p.touch(b.agent);
    const from = String(b.from || ''), into = String(b.into || '');
    if (!from || !into || from === into) throw httpError(400, 'from and into required');
    if (!Object.values(p.agents).some(a => a.name === from) && !p.messages.some(m => m.fromName === from)) throw httpError(404, `nobody called ${from}`);
    mergePerson(p, from, into);
    return { ok: true };
  },
  // tidy the team list: names that only differ in capitals become one person (the one used most
  // recently wins), and each person keeps a single offline row
  'POST tidy': (p, b) => {
    p.touch(b.agent);
    const seen = {};
    for (const a of Object.values(p.agents)) {
      const k = a.name.toLowerCase();
      seen[k] = seen[k] || {};
      seen[k][a.name] = Math.max(seen[k][a.name] || 0, a.lastSeen);
    }
    for (const n of [...Object.keys(p.settings || {}), ...Object.keys(p.stats || {})]) {
      const k = n.toLowerCase();
      seen[k] = seen[k] || {};
      seen[k][n] = seen[k][n] || 0;
    }
    const merged = [];
    for (const names of Object.values(seen)) {
      const list = Object.entries(names).sort((x, y) => y[1] - x[1]).map(x => x[0]);
      for (const from of list.slice(1)) { mergePerson(p, from, list[0]); merged.push({ from, into: list[0] }); }
    }
    const before = Object.keys(p.agents).length;
    p.sweep();
    p.emit('forget', { name: '' });
    return { ok: true, merged, removed: before - Object.keys(p.agents).length };
  },
  // drop someone who isn't around any more (test runs, a name typo); never someone online or holding files
  'POST forget-agent': (p, b) => {
    p.touch(b.agent);
    const name = String(b.name || '');
    const theirs = Object.values(p.agents).filter(x => x.name === name && x.id !== b.agent.id);
    if (!theirs.length) throw httpError(404, `nobody called ${name}`);
    if (theirs.some(x => p.online(x))) throw httpError(409, `${name} is online right now`);
    if (Object.values(p.locks).some(l => theirs.some(x => x.id === l.holder))) throw httpError(409, `${name} still holds files`);
    for (const x of theirs) delete p.agents[x.id];
    p.emit('forget', { name });
    return { ok: true, removed: theirs.length };
  },
  'POST status': (p, b) => {
    const a = p.touch(b.agent);
    const status = String(b.status || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (status === a.status) return { ok: true };
    a.status = status;
    a.statusAt = now();
    if (status) {
      p.worklog = p.worklog || [];
      p.worklog.push({ name: a.name, status, at: a.statusAt, auto: !!b.auto });
      if (p.worklog.length > MAX_WORKLOG) p.worklog.splice(0, p.worklog.length - MAX_WORKLOG);
    }
    p.emit('status', { agent: p.publicAgent(a) });
    p.dirty = true;
    return { ok: true };
  },
  'POST lock': (p, b) => {
    const a = p.touch(b.agent);
    const dir = !!b.dir || /[\\/]$/.test(String(b.path || ''));
    const fp = normPath(b.path);
    if (dir && fp === '.') throw httpError(400, 'lock a folder inside the project, not the whole project');
    const branch = b.branch || null;
    const key = fileKey(branch, dir ? fp + '/' : fp);
    const cur = p.locks[key];
    const f = dir ? null : p.files[key];
    const blocker = blockingLock(p, a.id, branch, fp, dir);
    // same file held on another branch: not a block, but a merge conflict in the making
    const elsewhere = Object.values(p.locks).filter(l => l.path === fp && (l.branch || null) !== branch && l.holder !== a.id)
      .map(l => ({ branch: l.branch, holderName: l.holderName }));
    const latest = f ? { hash: f.hash, version: f.version, byName: f.byName, at: f.at,
      known: b.baseHash ? f.hashes.includes(b.baseHash) : false } : null;
    if (blocker) {
      p.dirty = true;
      return { ok: false, lock: blocker, latest, elsewhere };
    }
    // a folder is a deliberate claim, so it stays until released or the session ends
    const lock = p.locks[key] = {
      path: dir ? fp + '/' : fp, branch, holder: a.id, holderName: a.name, checkout: a.checkout,
      since: cur ? cur.since : now(), note: b.note || (cur && cur.note) || '',
      hold: !!(b.hold || dir || (cur && cur.hold)), ...(dir ? { dir: true } : {}),
    };
    if (!cur) p.emit('lock', { lock });
    if (b.baseHash && !f) {
      // first time anyone locks this file: remember its starting point
      p.files[key] = { path: fp, branch, hash: b.baseHash, content: null, by: a.id, byName: a.name,
        at: now(), version: 0, hashes: [b.baseHash], checkout: a.checkout };
    }
    p.dirty = true;
    const withContent = f && f.content != null && b.baseHash !== f.hash && b.wantContent;
    return { ok: true, lock, latest, elsewhere, content: withContent ? f.content : undefined };
  },
  'POST unlock': (p, b) => {
    const a = p.touch(b.agent);
    const released = [];
    const keys = b.all ? Object.keys(p.locks) : (b.paths || [b.path]).map(x => fileKey(b.branch || null, normPath(x) + (/[\\/]$/.test(x) ? '/' : '')));
    for (const key of keys) {
      const l = p.locks[key];
      if (!l || l.holder !== a.id) continue;
      if (b.all && b.keepHeld && l.hold) continue;
      delete p.locks[key];
      released.push(l.path);
      p.emit('unlock', { path: l.path, branch: l.branch || null, holder: a.id, holderName: a.name, reason: b.reason || 'released' });
    }
    p.dirty = true;
    return { ok: true, released };
  },
  'POST content': (p, b) => {
    const a = p.touch(b.agent);
    const fp = normPath(b.path);
    if (typeof b.content !== 'string') throw httpError(400, 'content must be a string');
    if (Buffer.byteLength(b.content) > p.limits.fileBytes) throw httpError(413, 'file too large to share');
    const branch = b.branch || null;
    const key = fileKey(branch, fp);
    const blocker = blockingLock(p, a.id, branch, fp, false);
    if (blocker) throw httpError(409, `locked by ${blocker.holderName}${blocker.dir ? ` (the whole ${blocker.path} folder)` : ''}`);
    const l = p.locks[key];
    if (!l) {
      p.locks[key] = { path: fp, branch, holder: a.id, holderName: a.name, checkout: a.checkout,
        since: now(), note: '', hold: false };
      p.emit('lock', { lock: p.locks[key] });
    }
    const hash = sha(b.content);
    const prev = p.files[key];
    if (!prev && Object.keys(p.files).length >= p.limits.files) throw httpError(413, 'project has too many shared files');
    const total = Object.values(p.files).reduce((n, f) => n + (f.content ? f.content.length : 0), 0);
    if (total - (prev && prev.content ? prev.content.length : 0) + b.content.length > p.limits.projectBytes) throw httpError(413, 'project storage is full');
    if (prev && prev.hash === hash && prev.content != null) return { ok: true, version: prev.version, unchanged: true };
    p.changedFiles.add(key);
    const f = p.files[key] = {
      path: fp, branch, hash, content: b.content, by: a.id, byName: a.name, at: now(),
      version: (prev ? prev.version : 0) + 1,
      hashes: [...(prev ? prev.hashes : []), hash].slice(-HASH_HISTORY),
      checkout: a.checkout,
    };
    p.emit('file', { file: p.fileMeta(f), prevHash: prev ? prev.hash : null, tool: b.tool || '' });
    p.dirty = true;
    return { ok: true, version: f.version, hash };
  },
  'GET file': (p, b, q) => {
    const fp = normPath(q.get('path'));
    const key = fileKey(q.get('branch') || null, fp);
    const f = p.files[key];
    if (!f || f.content == null) throw httpError(404, 'no shared content for ' + fp);
    return { ...p.fileMeta(f), content: f.content, hashes: f.hashes, lock: p.locks[key] || null };
  },
  'POST message': (p, b) => {
    const a = p.touch(b.agent);
    const text = String(b.text || '').trim();
    if (!text) throw httpError(400, 'text required');
    const m = { id: crypto.randomBytes(6).toString('hex'), from: a.id, fromName: a.name,
      to: personFor(p, b.to) || null, text: text.slice(0, 20000), at: now() };
    p.messages.push(m);
    if (p.messages.length > MAX_MESSAGES) p.messages.splice(0, p.messages.length - MAX_MESSAGES);
    m.seq = p.emit('message', { message: m }).seq;
    p.dirty = true;
    return { ok: true, message: m };
  },
  'GET messages': (p, b, q) => {
    const since = Number(q.get('since') || 0);
    const limit = Math.min(Number(q.get('limit') || 200), 1000);
    return { messages: p.messages.filter(m => m.seq > since).slice(-limit) };
  },
  // unread messages for an agent; advances its read pointer unless peek=1
  'POST inbox': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const unread = () => p.messages.filter(m => m.seq > a.readSeq && p.relevant(m, a));
    let msgs = unread();
    if (!msgs.length && b.wait > 0) {
      await ctx.waitFor(ev => ev.type === 'message' && p.relevant(ev.message, a), b.wait * 1000);
      msgs = unread();
    }
    if (!b.peek && msgs.length) { a.readSeq = msgs[msgs.length - 1].seq; p.dirty = true; }
    return { messages: msgs, sharedVersion: p.shared.version, boardVersion: p.board.version, teamVersion: p.teamVersion || 0 };
  },
  'GET shared': (p) => p.shared,
  // ---- git: people publish branches as bundles, everyone fetches them ----
  'GET git': (p) => ({ refs: p.git.refs, bundles: p.git.bundles, bytes: p.git.bytes, limit: p.limits.gitBytes,
    snapshots: Object.fromEntries(Object.entries(p.git.snapshots || {}).map(([k, v]) => [k, { sha: v.sha, at: v.at }])) }),
  // a bundle arrives in pieces (requests are size-limited); the last piece registers it
  'POST git-upload': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const id = String(b.id || '');
    if (!/^[a-f0-9]{8,32}$/.test(id)) throw httpError(400, 'bad bundle id');
    const n = Number(b.n), i = Number(b.i);
    if (!(n >= 1 && n <= 64 && i >= 0 && i < n)) throw httpError(400, 'bad chunk index');
    const data = String(b.data || '');
    const size = Math.floor(data.length * 3 / 4);
    if (size > GIT_CHUNK + 4) throw httpError(413, 'chunk too large');
    if (p.git.bytes + size > p.limits.gitBytes) throw httpError(413, `the project's git storage is full (${Math.round(p.limits.gitBytes / 1048576)} MB); share history through a normal git remote instead`);
    await ctx.blobs.put(`git:${id}:${i}`, data);
    const up = p.git.uploads[id] = p.git.uploads[id] || { got: [], bytes: 0, at: now() };
    if (!up.got.includes(i)) { up.got.push(i); up.bytes += size; }
    if (up.got.length < n) { p.dirty = true; return { ok: true, pending: n - up.got.length }; }
    delete p.git.uploads[id];
    const branch = String(b.branch || '').slice(0, 200);
    const sha40 = /^[0-9a-f]{40}$/;
    if (!branch || !sha40.test(b.tip || '')) throw httpError(400, 'branch and tip required');
    const bundle = { id, owner: a.name, branch, tip: b.tip, prereqs: (b.prereqs || []).filter(x => sha40.test(x)).slice(0, 200),
      n, size: up.bytes, at: now(), checkout: a.checkout };
    p.git.bundles.push(bundle);
    p.git.bytes += up.bytes;
    const ref = p.git.refs[`${a.name}/${branch}`] = { owner: a.name, branch, sha: b.tip, at: now(), checkout: a.checkout, subject: String(b.subject || '').slice(0, 200) };
    p.emit('git', { action: 'publish', ref, bundle: bundle.id });
    return { ok: true, id };
  },
  // a branch moved to a commit the server already has (no new objects to send)
  'POST git-ref': (p, b) => {
    const a = p.touch(b.agent);
    if (!/^[0-9a-f]{40}$/.test(b.tip || '') || !b.branch) throw httpError(400, 'branch and tip required');
    const ref = p.git.refs[`${a.name}/${b.branch}`] = { owner: a.name, branch: String(b.branch).slice(0, 200), sha: b.tip, at: now(), checkout: a.checkout, subject: String(b.subject || '').slice(0, 200) };
    p.emit('git', { action: 'publish', ref });
    return { ok: true };
  },
  // take back a branch you published (only your own); its bundles go too
  'POST git-forget': (p, b) => {
    const a = p.touch(b.agent);
    const drop = Object.values(p.git.refs).filter(r => r.owner === a.name && (!b.branch || r.branch === b.branch));
    if (!drop.length) throw httpError(404, 'you have no published branch by that name');
    for (const r of drop) {
      delete p.git.refs[`${r.owner}/${r.branch}`];
      for (const x of p.git.bundles.filter(x => x.owner === r.owner && x.branch === r.branch)) p.git.bytes -= x.size;
      p.git.bundles = p.git.bundles.filter(x => !(x.owner === r.owner && x.branch === r.branch));
      p.emit('git', { action: 'forget', owner: r.owner, branch: r.branch });
    }
    return { ok: true, removed: drop.map(r => `${r.owner}/${r.branch}`) };
  },
  // a readable copy of a published branch's files, so the dashboard can show the project
  'POST git-snapshot': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const branch = String(b.branch || '');
    if (!branch || !/^[0-9a-f]{40}$/.test(b.sha || '')) throw httpError(400, 'branch and sha required');
    const n = Number(b.n), i = Number(b.i);
    if (!(n >= 1 && n <= 32 && i >= 0 && i < n)) throw httpError(400, 'bad part index');
    const files = (Array.isArray(b.files) ? b.files : []).map(f => ({ path: normPath(f.path), content: String(f.content || '') }));
    const data = JSON.stringify(files);
    if (data.length > SNAP_PART + 4096) throw httpError(413, 'snapshot part too large');
    const key = `${a.name}/${branch}`;
    await ctx.blobs.put(`snap:${key}:${b.sha}:${i}`, data);
    p.git.snapshots = p.git.snapshots || {};
    const up = p.git.uploads['snap:' + key] = (p.git.uploads['snap:' + key] && p.git.uploads['snap:' + key].sha === b.sha) ? p.git.uploads['snap:' + key] : { sha: b.sha, got: [], files: {} };
    if (!up.got.includes(i)) up.got.push(i);
    for (const f of files) up.files[f.path] = { i, size: f.content.length };
    if (up.got.length < n) { p.dirty = true; return { ok: true, pending: n - up.got.length }; }
    delete p.git.uploads['snap:' + key];
    const old = p.git.snapshots[key];
    p.git.snapshots[key] = { owner: a.name, branch, sha: b.sha, n, at: now(), files: up.files, skipped: (b.skipped || []).slice(0, 200).map(String) };
    if (old && old.sha !== b.sha && ctx.blobs.del) for (let j = 0; j < old.n; j++) await ctx.blobs.del(`snap:${key}:${old.sha}:${j}`);
    p.emit('git', { action: 'snapshot', ref: p.git.refs[key] || { owner: a.name, branch, sha: b.sha } });
    return { ok: true };
  },
  'GET git-tree': (p, b, q) => {
    const snaps = p.git.snapshots || {};
    if (!q.get('ref')) return { refs: Object.values(snaps).map(x => ({ owner: x.owner, branch: x.branch, sha: x.sha, at: x.at, count: Object.keys(x.files).length })) };
    const sn = snaps[q.get('ref')];
    if (!sn) throw httpError(404, 'no snapshot for ' + q.get('ref'));
    return { owner: sn.owner, branch: sn.branch, sha: sn.sha, at: sn.at, skipped: sn.skipped,
      files: Object.entries(sn.files).map(([path, f]) => ({ path, size: f.size })).sort((x, y) => x.path.localeCompare(y.path)) };
  },
  'GET git-blob': async (p, b, q, ctx) => {
    const sn = (p.git.snapshots || {})[q.get('ref')];
    const fp = normPath(q.get('path'));
    if (!sn || !sn.files[fp]) throw httpError(404, 'no such file in ' + q.get('ref'));
    const part = await ctx.blobs.get(`snap:${q.get('ref')}:${sn.sha}:${sn.files[fp].i}`);
    const f = part && JSON.parse(part).find(x => x.path === fp);
    if (!f) throw httpError(404, 'file content missing');
    return { path: fp, content: f.content, sha: sn.sha, owner: sn.owner, branch: sn.branch };
  },
  'GET git-chunk': async (p, b, q, ctx) => {
    const data = await ctx.blobs.get(`git:${q.get('id')}:${Number(q.get('i'))}`);
    if (data == null) throw httpError(404, 'no such bundle piece');
    return { data };
  },

  // ---- team board: a person gives the team a goal, one Claude plans it, everyone works it ----
  'GET board': (p) => p.board,
  'GET settings': (p) => ({ settings: p.settings || {} }),
  // your own settings only: whether others can start your Claude on things
  // and the name you gave your Claude ("" clears it)
  'POST setting': (p, b) => {
    const a = p.touch(b.agent);
    p.settings = p.settings || {};
    const change = {};
    if (b.autopilot !== undefined) {
      const mode = String(b.autopilot || '');
      if (!['off', 'requests', 'full'].includes(mode)) throw httpError(400, 'autopilot must be off, requests or full');
      change.autopilot = mode;
    }
    if (b.aiName !== undefined) {
      const n = String(b.aiName || '').replace(/[\s"'`<>]+/g, ' ').trim().slice(0, 32);
      const taken = n && (Object.values(p.agents).some(x => x.name.toLowerCase() === n.toLowerCase() && x.name !== a.name) ||
        Object.entries(p.settings).some(([who, s]) => who !== a.name && s && s.aiName && s.aiName.toLowerCase() === n.toLowerCase()));
      if (taken) throw httpError(409, `"${n}" is already someone on this team; pick another name`);
      change.aiName = n || null;
    }
    if (!Object.keys(change).length) throw httpError(400, 'nothing to change: give autopilot or aiName');
    p.settings[a.name] = { ...(p.settings[a.name] || {}), ...change, at: now() };
    p.emit('setting', { name: a.name, settings: p.settings[a.name] });
    return { ok: true, settings: p.settings[a.name] };
  },
  'POST goal': (p, b) => {
    const a = p.touch(b.agent);
    const text = String(b.text || '').trim().slice(0, 8000);
    if (!text) throw httpError(400, 'what should the team do?');
    const to = personFor(p, b.to);
    const goal = { id: crypto.randomBytes(4).toString('hex'), text, by: a.id, byName: a.name, at: now(), status: 'open', planner: null, to: to || null };
    p.board.goals.push(goal);
    if (p.board.goals.length > 100) p.board.goals.splice(0, p.board.goals.length - 100);
    // aimed at one person's Claude: skip planning, it's simply their task
    if (to) {
      goal.status = 'planned';
      goal.planner = to;
      pushTask(p, { goalId: goal.id, title: text.split('\n')[0].slice(0, 200), detail: text, owner: to, direct: true }, a);
    }
    boardChanged(p, 'goal', { goal }, a);
    return { ok: true, goal };
  },
  // first agent to claim a goal gets to split it into tasks; everyone else waits for the plan
  'POST claim-goal': (p, b) => {
    const a = p.touch(b.agent);
    const g = p.board.goals.find(x => x.id === b.id);
    if (!g) throw httpError(404, 'no such goal');
    if (g.planner && g.planner !== a.name) return { ok: false, planner: g.planner, goal: g };
    g.planner = a.name;
    g.status = g.status === 'open' ? 'planning' : g.status;
    boardChanged(p, 'claim-goal', { goal: g }, a);
    return { ok: true, goal: g };
  },
  'POST plan': (p, b) => {
    const a = p.touch(b.agent);
    const g = p.board.goals.find(x => x.id === b.goalId);
    if (!g) throw httpError(404, 'no such goal');
    if (g.planner && g.planner !== a.name) throw httpError(409, `${g.planner} is planning this goal`);
    const tasks = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 30);
    if (!tasks.length) throw httpError(400, 'a plan needs at least one task');
    g.planner = a.name;
    g.status = 'planned';
    g.plan = String(b.summary || '').slice(0, 4000);
    const made = tasks.map(t => pushTask(p, { goalId: g.id, title: t.title, detail: t.detail, owner: t.owner || null }, a));
    // "after" refers to earlier tasks in this same list by index
    tasks.forEach((t, i) => { made[i].after = (Array.isArray(t.after) ? t.after : []).map(j => made[j] && made[j].id).filter(Boolean); });
    boardChanged(p, 'plan', { goal: g, tasks: made }, a);
    return { ok: true, tasks: made };
  },
  'POST task': (p, b) => {
    const a = p.touch(b.agent);
    const t = pushTask(p, { goalId: b.goalId || null, title: b.title, detail: b.detail, owner: b.owner || null }, a);
    boardChanged(p, 'task', { task: t }, a);
    return { ok: true, task: t };
  },
  // take an unowned task (atomic, so two Claudes can't both grab it)
  'POST claim-task': (p, b) => {
    const a = p.touch(b.agent);
    const t = p.board.tasks.find(x => x.id === b.id);
    if (!t) throw httpError(404, 'no such task');
    if (t.owner && t.owner !== a.name) return { ok: false, owner: t.owner, task: t };
    t.owner = a.name;
    if (t.status === 'todo') t.status = 'doing';
    t.updated = now();
    boardChanged(p, 'claim-task', { task: t }, a);
    return { ok: true, task: t };
  },
  'POST task-update': (p, b) => {
    const a = p.touch(b.agent);
    const t = p.board.tasks.find(x => x.id === b.id);
    if (!t) throw httpError(404, 'no such task');
    if (b.status) {
      if (!['todo', 'doing', 'done', 'blocked'].includes(b.status)) throw httpError(400, 'status must be todo, doing, done or blocked');
      t.status = b.status;
    }
    if (b.owner !== undefined) t.owner = b.owner || null;
    if (b.note) t.notes = [...(t.notes || []), { by: a.name, at: now(), text: String(b.note).slice(0, 2000) }].slice(-20);
    t.updated = now();
    goalDone(p, t);
    boardChanged(p, 'task-update', { task: t }, a);
    return { ok: true, task: t };
  },

  'POST activity': (p, b) => {
    const a = p.touch(b.agent);
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50).map(it => ({
      kind: ['prompt', 'text', 'tool', 'end'].includes(it.kind) ? it.kind : 'text',
      text: String(it.text || '').slice(0, ACTIVITY_TEXT),
      tool: it.tool ? String(it.tool).slice(0, 80) : undefined,
      at: now(), agent: a.id, name: a.name,
    })).filter(it => it.text || it.kind === 'end');
    if (!items.length) return { ok: true };
    p.activity.push(...items);
    if (p.activity.length > MAX_ACTIVITY) p.activity.splice(0, p.activity.length - MAX_ACTIVITY);
    p.activityChanged = true;
    p.emit('activity', { agent: p.publicAgent(a), items });
    return { ok: true };
  },
  // usage counts from each person's hooks at the end of a turn: numbers only, never content
  'POST stats': (p, b) => {
    const a = p.touch(b.agent);
    if (a.transient) return { ok: true };
    const n = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));
    const add = {
      conversations: b.conversation && !b.request ? 1 : 0,
      requests: b.conversation && b.request ? 1 : 0,
      turns: n(b.turns, 1), activeMs: n(b.activeMs, 4 * 3600 * 1000),
      requestMs: b.request ? n(b.activeMs, 4 * 3600 * 1000) : 0,
      models: {},
    };
    for (const [model, u] of Object.entries(b.usage && typeof b.usage === 'object' ? b.usage : {}).slice(0, 5)) {
      if (!u || typeof u !== 'object') continue;
      add.models[String(model).slice(0, 60)] = { input: n(u.input, 5e7), output: n(u.output, 5e7), cacheRead: n(u.cacheRead, 5e8),
        cacheWrite: n(u.cacheWrite, 5e8), messages: n(u.messages, 1e4) };
    }
    const day = new Date().toISOString().slice(0, 10);
    p.stats = p.stats || {};
    p.stats[a.name] = addStats(p.stats[a.name] || newStats(), { ...add, days: { [day]: dayOf(add) } });
    p.emit('stats', { name: a.name });
    return { ok: true };
  },
  'GET stats': (p) => ({ stats: p.stats || {}, since: Math.min(...Object.values(p.stats || {}).map(s => s.since || now()), now()) }),
  'GET activity': (p, b, q) => {
    const who = q.get('agent');
    const limit = Math.min(Number(q.get('limit') || 200), MAX_ACTIVITY);
    const mine = who ? p.activity.filter(it => it.agent === who || it.name === who) : p.activity;
    return { activity: mine.slice(-limit) };
  },
  // the project brief; base_version guards against overwriting someone else's edit
  'POST doc': (p, b) => {
    const a = p.touch(b.agent);
    const text = String(b.text == null ? '' : b.text);
    if (Buffer.byteLength(text) > DOC_BYTES) throw httpError(413, 'PROJECT.md is limited to 64 KB');
    const cur = p.shared.doc;
    if (!b.force && b.baseVersion !== undefined && (cur ? cur.version : 0) !== b.baseVersion) {
      throw httpError(409, `PROJECT.md changed since you read it (now v${cur ? cur.version : 0} by ${cur ? cur.byName : '?'}); read it again and reapply your change`);
    }
    const prev = cur ? cur.text : '';
    p.shared.doc = { text, version: (cur ? cur.version : 0) + 1, by: a.id, byName: a.name, at: now() };
    p.changeShared('doc', 'update', { docVersion: p.shared.doc.version, summary: diffSummary(prev, text) }, a);
    return { ok: true, version: p.shared.doc.version };
  },
  'POST memory': (p, b) => {
    const a = p.touch(b.agent);
    const title = String(b.title || '').trim().slice(0, 120);
    const text = String(b.text || '').trim();
    if (!title || !text) throw httpError(400, 'title and text required');
    if (Buffer.byteLength(text) > MEMORY_BYTES) throw httpError(413, 'keep a memory under 4 KB; split it or put details in PROJECT.md');
    const list = p.shared.memories;
    let m = b.id ? list.find(x => x.id === b.id) : list.find(x => x.title.toLowerCase() === title.toLowerCase());
    const action = m ? 'update' : 'add';
    if (!m) {
      if (list.length >= MAX_MEMORIES) throw httpError(413, 'too many memories; forget some first');
      m = { id: crypto.randomBytes(4).toString('hex'), created: now() };
      list.push(m);
    }
    Object.assign(m, { title, text, by: a.id, byName: a.name, at: now() });
    p.changeShared('memory', action, { id: m.id, title, text }, a);
    return { ok: true, id: m.id, action };
  },
  'POST forget': (p, b) => {
    const a = p.touch(b.agent);
    const i = p.shared.memories.findIndex(x => x.id === b.id || x.title.toLowerCase() === String(b.id || '').toLowerCase());
    if (i < 0) throw httpError(404, 'no such memory');
    const [m] = p.shared.memories.splice(i, 1);
    p.changeShared('memory', 'delete', { id: m.id, title: m.title }, a);
    return { ok: true };
  },
  // a skill is a whole SKILL.md (frontmatter + instructions), synced into .claude/skills/
  'POST skill': (p, b) => {
    const a = p.touch(b.agent);
    const name = String(b.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    if (!name) throw httpError(400, 'skill name required');
    let body = String(b.body || '');
    if (Buffer.byteLength(body) > DOC_BYTES) throw httpError(413, 'a skill is limited to 64 KB');
    const fm = parseFrontmatter(body);
    const description = String(b.description || fm.description || '').trim().slice(0, 1000);
    if (!description) throw httpError(400, 'a skill needs a description saying when to use it');
    if (!fm.name) body = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n${body.trim()}\n`;
    const list = p.shared.skills;
    let sk = list.find(x => x.name === name);
    const action = sk ? 'update' : 'add';
    if (!sk) {
      if (list.length >= MAX_SKILLS) throw httpError(413, 'too many shared skills');
      sk = { name, version: 0 };
      list.push(sk);
    }
    Object.assign(sk, { description, body, version: sk.version + 1, by: a.id, byName: a.name, at: now() });
    p.changeShared('skill', action, { name, description }, a);
    return { ok: true, name, version: sk.version };
  },
  'POST skill-delete': (p, b) => {
    const a = p.touch(b.agent);
    const i = p.shared.skills.findIndex(x => x.name === b.name);
    if (i < 0) throw httpError(404, 'no such skill');
    p.shared.skills.splice(i, 1);
    p.changeShared('skill', 'delete', { name: b.name }, a);
    return { ok: true };
  },
  'POST wait-unlock': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const fp = normPath(b.path);
    const dir = /[\\/]$/.test(String(b.path || ''));
    const blocker = () => blockingLock(p, a.id, b.branch || null, fp, dir);
    if (blocker()) await ctx.waitFor(ev => ev.type === 'unlock' && !blocker(), (b.timeout || 300) * 1000);
    return { free: !blocker(), lock: blocker() };
  },
  // long-poll; servers stream the same events over SSE / WebSocket themselves
  'GET events': async (p, b, q, ctx) => {
    const since = Number(q.get('since') || 0);
    const pending = () => p.eventsSince(since);
    let evs = pending();
    const wait = Number(q.get('wait') || 0);
    if (evs && !evs.length && wait > 0) { await ctx.waitFor(() => true, wait * 1000); evs = pending(); }
    return { events: evs || [], seq: p.seq, truncated: !evs };
  },
};

// One person's usage totals, plus daily buckets for the last STATS_DAYS days.
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'messages'];
function newStats() {
  return { since: now(), last: 0, conversations: 0, requests: 0, turns: 0, activeMs: 0, requestMs: 0, models: {}, days: {} };
}
function dayOf(s) {
  const tokens = Object.values(s.models || {}).reduce((t, u) => t + u.input + u.output + u.cacheRead + u.cacheWrite, 0);
  const output = Object.values(s.models || {}).reduce((t, u) => t + u.output, 0);
  return { conversations: s.conversations || 0, turns: s.turns || 0, activeMs: s.activeMs || 0, tokens, output };
}
function addStats(into, add) {
  for (const k of ['conversations', 'requests', 'turns', 'activeMs', 'requestMs']) into[k] = (into[k] || 0) + (add[k] || 0);
  for (const [m, u] of Object.entries(add.models || {})) {
    if (!into.models[m] && Object.keys(into.models).length >= STATS_MODELS) continue;
    const t = into.models[m] || (into.models[m] = Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])));
    for (const k of TOKEN_KEYS) t[k] += u[k] || 0;
  }
  for (const [d, v] of Object.entries(add.days || {})) {
    const t = into.days[d] || (into.days[d] = { conversations: 0, turns: 0, activeMs: 0, tokens: 0, output: 0 });
    for (const k of Object.keys(t)) t[k] += v[k] || 0;
  }
  const keep = Object.keys(into.days).sort().slice(-STATS_DAYS);
  into.days = Object.fromEntries(keep.map(d => [d, into.days[d]]));
  into.since = Math.min(into.since || now(), add.since || now());
  into.last = Math.max(into.last || 0, add.last || now());
  return into;
}

// two names are the same person: fold `from` into `into` everywhere, and keep it that way
function mergePerson(p, from, into) {
  p.aliases = p.aliases || {};
  for (const [k, v] of Object.entries(p.aliases)) if (v === from) p.aliases[k] = into;
  p.aliases[from] = into;
  const fix = (o, k) => { if (o && o[k] === from) o[k] = into; };
  for (const a of Object.values(p.agents)) fix(a, 'name');
  for (const m of p.messages) { fix(m, 'fromName'); fix(m, 'to'); }
  for (const it of p.activity) fix(it, 'name');
  for (const w of p.worklog || []) fix(w, 'name');
  for (const h of p.handoffs || []) fix(h, 'name');
  for (const g of p.board.goals) { fix(g, 'byName'); fix(g, 'to'); fix(g, 'planner'); }
  for (const t of p.board.tasks) { fix(t, 'owner'); fix(t, 'by'); for (const n of t.notes || []) fix(n, 'by'); }
  for (const l of Object.values(p.locks)) fix(l, 'holderName');
  for (const f of Object.values(p.files)) fix(f, 'byName');
  for (const m of p.shared.memories) fix(m, 'byName');
  if (p.settings && p.settings[from]) { p.settings[into] = p.settings[into] || p.settings[from]; delete p.settings[from]; }
  if (p.stats && p.stats[from]) { p.stats[into] = addStats(p.stats[into] || newStats(), p.stats[from]); delete p.stats[from]; }
  p.activityChanged = p.sharedChanged = true;
  p.board.version++;
  p.emit('merge', { from, into });
}

function pushTask(p, t, a) {
  const title = String(t.title || '').trim().slice(0, 200);
  if (!title) throw httpError(400, 'every task needs a title');
  if (p.board.tasks.length >= MAX_TASKS) p.board.tasks.splice(0, p.board.tasks.findIndex(x => x.status === 'done') + 1 || 1);
  const task = { id: crypto.randomBytes(4).toString('hex'), goalId: t.goalId, title, detail: String(t.detail || '').slice(0, 6000),
    owner: t.owner || null, status: 'todo', by: a.name, at: now(), updated: now(), after: Array.isArray(t.after) ? t.after.slice(0, 10) : [],
    direct: !!t.direct };
  p.board.tasks.push(task);
  return task;
}

function goalDone(p, t) {
  const g = p.board.goals.find(x => x.id === t.goalId);
  if (g && p.board.tasks.filter(x => x.goalId === g.id).every(x => x.status === 'done')) g.status = 'done';
}

function boardChanged(p, action, info, a) {
  p.board.version++;
  p.boardChanged = true;
  p.emit('board', { action, byName: a.name, version: p.board.version, ...info });
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// "+3 -1 lines" style summary so other agents know roughly what changed
function diffSummary(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let i = 0, j = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  const added = y.slice(i, y.length - j).filter(l => l.trim());
  const removed = x.length - i - j;
  return { added: y.length - i - j, removed, firstAdded: added.slice(0, 6).join('\n').slice(0, 600) };
}

function waitOn(p, pred, timeoutMs, onAbort) {
  return new Promise(resolve => {
    const done = (v) => { clearTimeout(timer); p.waiters.delete(w); resolve(v); };
    const w = (ev) => { if (pred(ev)) done(ev); };
    const timer = setTimeout(() => done(null), Math.min(timeoutMs, 10 * 60 * 1000));
    p.waiters.add(w);
    if (onAbort) onAbort(() => done(null));
  });
}

module.exports = { Project, routes, waitOn, parseFrontmatter, fileKey, GIT_CHUNK, sha, now, httpError, sameSecret, normPath, aiLabel, taskIdsIn, blockingLock,
  ONLINE_MS, MAX_FILE_BYTES, OPEN_IDLE_MS, OPEN_MAX_PROJECTS, OPEN_CREATES_PER_HOUR };

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
  sharedBytes: 1536 * 1024 };
const DOC_BYTES = 64 * 1024;        // PROJECT.md and each skill
const MEMORY_BYTES = 4 * 1024;      // each memory note
const MAX_MEMORIES = 300;
const MAX_SKILLS = 40;

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function now() { return Date.now(); }
function httpError(code, msg) { const e = new Error(msg); e.code = code; return e; }
function sameSecret(x, y) {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function normPath(p) {
  if (typeof p !== 'string' || !p) throw httpError(400, 'path required');
  const n = path.posix.normalize(p.replace(/\\/g, '/'));
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
    this.waiters = new Set();
    if (saved) Object.assign(this, saved);
    this.waiters = new Set();
    this.dirty = false;
    this.changedFiles = new Set();     // paths whose content changed since the last save
    this.sharedChanged = false;
    this.isConnected = () => false;    // servers with live sockets count those agents as online
    this.limits = { ...DEFAULT_LIMITS };
  }
  toJSON() {
    const { waiters, dirty, changedFiles, sharedChanged, isConnected, limits, ...rest } = this;
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
    this.dirty = true;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const w of [...this.waiters]) w(ev);
    return ev;
  }
  publicAgent(a) {
    return { id: a.id, name: a.name, host: a.host, checkout: a.checkout, kind: a.kind,
      status: a.status, lastSeen: a.lastSeen, online: this.online(a) };
  }
  fileMeta(f) {
    return { path: f.path, hash: f.hash, by: f.by, byName: f.byName, at: f.at,
      version: f.version, size: f.content == null ? 0 : f.content.length, checkout: f.checkout };
  }
  snapshot() {
    return {
      project: this.name,
      seq: this.seq,
      agents: Object.values(this.agents).map(a => this.publicAgent(a)),
      locks: Object.values(this.locks),
      files: Object.values(this.files).map(f => this.fileMeta(f)),
    };
  }
  touch(agent) {
    if (!agent || !agent.id) throw httpError(400, 'agent.id required');
    let a = this.agents[agent.id];
    const fresh = !a || !this.online(a);
    if (!a) {
      a = this.agents[agent.id] = { id: agent.id, readSeq: this.seq, joined: now(), status: '' };
    }
    a.name = agent.name || a.name || agent.id;
    a.host = agent.host || a.host || '';
    a.checkout = agent.checkout || a.checkout || '';
    a.kind = agent.kind || a.kind || 'agent';
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
    for (const a of Object.values(this.agents)) {
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
    if (b.status !== undefined) a.status = String(b.status).slice(0, 300);
    p.dirty = true;
    return { ...p.snapshot(), you: p.publicAgent(a) };
  },
  'GET state': (p) => p.snapshot(),
  'POST bye': (p, b) => {
    const a = p.agents[b.agent && b.agent.id];
    if (a) {
      a.lastSeen = now() - ONLINE_MS; // shows as just gone offline
      a.wasOnline = false;
      a.status = '';
      p.emit('leave', { agent: p.publicAgent(a) });
      p.dirty = true;
    }
    return { ok: true };
  },
  'POST status': (p, b) => {
    const a = p.touch(b.agent);
    a.status = String(b.status || '').slice(0, 300);
    p.emit('status', { agent: p.publicAgent(a) });
    p.dirty = true;
    return { ok: true };
  },
  'POST lock': (p, b) => {
    const a = p.touch(b.agent);
    const fp = normPath(b.path);
    const cur = p.locks[fp];
    const f = p.files[fp];
    const latest = f ? { hash: f.hash, version: f.version, byName: f.byName, at: f.at,
      known: b.baseHash ? f.hashes.includes(b.baseHash) : false } : null;
    if (cur && cur.holder !== a.id) {
      p.dirty = true;
      return { ok: false, lock: cur, latest };
    }
    const lock = p.locks[fp] = {
      path: fp, holder: a.id, holderName: a.name, checkout: a.checkout,
      since: cur ? cur.since : now(), note: b.note || (cur && cur.note) || '',
      hold: !!(b.hold || (cur && cur.hold)),
    };
    if (!cur) p.emit('lock', { lock });
    if (b.baseHash && !f) {
      // first time anyone locks this file: remember its starting point
      p.files[fp] = { path: fp, hash: b.baseHash, content: null, by: a.id, byName: a.name,
        at: now(), version: 0, hashes: [b.baseHash], checkout: a.checkout };
    }
    p.dirty = true;
    const withContent = f && f.content != null && b.baseHash !== f.hash && b.wantContent;
    return { ok: true, lock, latest, content: withContent ? f.content : undefined };
  },
  'POST unlock': (p, b) => {
    const a = p.touch(b.agent);
    const released = [];
    const paths = b.all ? Object.keys(p.locks) : (b.paths || [b.path]).map(normPath);
    for (const fp of paths) {
      const l = p.locks[fp];
      if (!l || l.holder !== a.id) continue;
      if (b.all && b.keepHeld && l.hold) continue;
      delete p.locks[fp];
      released.push(fp);
      p.emit('unlock', { path: fp, holder: a.id, holderName: a.name, reason: b.reason || 'released' });
    }
    p.dirty = true;
    return { ok: true, released };
  },
  'POST content': (p, b) => {
    const a = p.touch(b.agent);
    const fp = normPath(b.path);
    if (typeof b.content !== 'string') throw httpError(400, 'content must be a string');
    if (Buffer.byteLength(b.content) > p.limits.fileBytes) throw httpError(413, 'file too large to share');
    const l = p.locks[fp];
    if (l && l.holder !== a.id) throw httpError(409, `locked by ${l.holderName}`);
    if (!l) {
      p.locks[fp] = { path: fp, holder: a.id, holderName: a.name, checkout: a.checkout,
        since: now(), note: '', hold: false };
      p.emit('lock', { lock: p.locks[fp] });
    }
    const hash = sha(b.content);
    const prev = p.files[fp];
    if (!prev && Object.keys(p.files).length >= p.limits.files) throw httpError(413, 'project has too many shared files');
    const total = Object.values(p.files).reduce((n, f) => n + (f.content ? f.content.length : 0), 0);
    if (total - (prev && prev.content ? prev.content.length : 0) + b.content.length > p.limits.projectBytes) throw httpError(413, 'project storage is full');
    if (prev && prev.hash === hash && prev.content != null) return { ok: true, version: prev.version, unchanged: true };
    p.changedFiles.add(fp);
    const f = p.files[fp] = {
      path: fp, hash, content: b.content, by: a.id, byName: a.name, at: now(),
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
    const f = p.files[fp];
    if (!f || f.content == null) throw httpError(404, 'no shared content for ' + fp);
    return { ...p.fileMeta(f), content: f.content, hashes: f.hashes, lock: p.locks[fp] || null };
  },
  'POST message': (p, b) => {
    const a = p.touch(b.agent);
    const text = String(b.text || '').trim();
    if (!text) throw httpError(400, 'text required');
    const m = { id: crypto.randomBytes(6).toString('hex'), from: a.id, fromName: a.name,
      to: b.to || null, text: text.slice(0, 20000), at: now() };
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
    return { messages: msgs, sharedVersion: p.shared.version };
  },
  'GET shared': (p) => p.shared,
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
    const free = () => !p.locks[fp] || p.locks[fp].holder === a.id;
    if (!free()) await ctx.waitFor(ev => ev.type === 'unlock' && ev.path === fp, (b.timeout || 300) * 1000);
    return { free: free(), lock: p.locks[fp] || null };
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

module.exports = { Project, routes, waitOn, parseFrontmatter, sha, now, httpError, sameSecret, normPath,
  ONLINE_MS, MAX_FILE_BYTES, OPEN_IDLE_MS, OPEN_MAX_PROJECTS, OPEN_CREATES_PER_HOUR };

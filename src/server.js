// huddle relay server: holds agents, locks, live file contents and chat for
// each project, and streams every change to clients over SSE / long-poll.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ONLINE_MS = 2 * 60 * 1000;          // agent counts as online if seen this recently
const LOCK_STALE_MS = 5 * 60 * 1000;      // locks of agents unseen this long are dropped
const MAX_EVENTS = 2000;
const MAX_MESSAGES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const HASH_HISTORY = 100;

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function now() { return Date.now(); }

class Project {
  constructor(name, saved) {
    this.name = name;
    this.agents = {};   // id -> {id,name,host,checkout,kind,status,lastSeen,readSeq,joined}
    this.locks = {};    // path -> {path,holder,holderName,checkout,since,note,hold}
    this.files = {};    // path -> {path,hash,content,by,byName,at,version,hashes,checkout}
    this.messages = [];
    this.events = [];
    this.seq = 0;
    this.waiters = new Set();
    if (saved) Object.assign(this, saved, { waiters: new Set() });
  }
  toJSON() {
    const { waiters, ...rest } = this;
    return rest;
  }
  emit(type, data) {
    const ev = { seq: ++this.seq, type, at: now(), ...data };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const w of [...this.waiters]) w(ev);
    return ev;
  }
  publicAgent(a) {
    return { id: a.id, name: a.name, host: a.host, checkout: a.checkout, kind: a.kind,
      status: a.status, lastSeen: a.lastSeen, online: now() - a.lastSeen < ONLINE_MS };
  }
  fileMeta(f) {
    return { path: f.path, hash: f.hash, by: f.by, byName: f.byName, at: f.at,
      version: f.version, size: f.content.length, checkout: f.checkout };
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
    const fresh = !a || now() - a.lastSeen >= ONLINE_MS;
    if (!a) {
      a = this.agents[agent.id] = { id: agent.id, readSeq: this.seq, joined: now(), status: '' };
    }
    a.name = agent.name || a.name || agent.id;
    a.host = agent.host || a.host || '';
    a.checkout = agent.checkout || a.checkout || '';
    a.kind = agent.kind || a.kind || 'agent';
    a.lastSeen = now();
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
      if (!a || t - a.lastSeen > LOCK_STALE_MS) {
        delete this.locks[l.path];
        this.emit('unlock', { path: l.path, holder: l.holder, holderName: l.holderName, reason: 'stale' });
      }
    }
    for (const a of Object.values(this.agents)) {
      if (a.wasOnline && t - a.lastSeen >= ONLINE_MS) {
        a.wasOnline = false;
        this.emit('leave', { agent: this.publicAgent(a) });
      } else if (t - a.lastSeen < ONLINE_MS) a.wasOnline = true;
    }
  }
}

function httpError(code, msg) { const e = new Error(msg); e.code = code; return e; }

function normPath(p) {
  if (typeof p !== 'string' || !p) throw httpError(400, 'path required');
  const n = path.posix.normalize(p.replace(/\\/g, '/'));
  if (n.startsWith('../') || n === '..' || path.posix.isAbsolute(n)) throw httpError(400, 'path must be relative to the project root');
  return n;
}

function createServer(opts = {}) {
  const dataDir = opts.dataDir || path.join(process.cwd(), 'huddle-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const stateFile = path.join(dataDir, 'state.json');
  const tokenFile = path.join(dataDir, 'token');
  let token = opts.token || process.env.HUDDLE_TOKEN;
  if (!token) {
    if (fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile, 'utf8').trim();
    else {
      token = crypto.randomBytes(18).toString('base64url');
      fs.writeFileSync(tokenFile, token + '\n', { mode: 0o600 });
    }
  }

  const projects = new Map();
  if (fs.existsSync(stateFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      for (const [name, p] of Object.entries(saved)) projects.set(name, new Project(name, p));
    } catch (e) { console.error('huddle: could not load state:', e.message); }
  }
  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tmp = stateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(projects)));
      fs.renameSync(tmp, stateFile);
    }, 500);
  }
  function project(name) {
    if (!/^[\w.-]{1,64}$/.test(name)) throw httpError(400, 'bad project name');
    let p = projects.get(name);
    if (!p) { p = new Project(name); projects.set(name, p); }
    return p;
  }

  const sweeper = setInterval(() => {
    for (const p of projects.values()) p.sweep();
  }, 10 * 1000);
  sweeper.unref();

  const dashboard = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

  function waitFor(p, pred, timeoutMs, req) {
    return new Promise(resolve => {
      const done = (v) => { clearTimeout(timer); p.waiters.delete(w); resolve(v); };
      const w = (ev) => { if (pred(ev)) done(ev); };
      const timer = setTimeout(() => done(null), Math.min(timeoutMs, 10 * 60 * 1000));
      p.waiters.add(w);
      req.on('close', () => done(null));
    });
  }

  const routes = {
    'POST hello': (p, b) => {
      const a = p.touch(b.agent);
      if (b.status !== undefined) a.status = String(b.status).slice(0, 300);
      save();
      return { ...p.snapshot(), you: p.publicAgent(a) };
    },
    'GET state': (p) => p.snapshot(),
    'POST status': (p, b) => {
      const a = p.touch(b.agent);
      a.status = String(b.status || '').slice(0, 300);
      p.emit('status', { agent: p.publicAgent(a) });
      save();
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
        save();
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
      save();
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
      save();
      return { ok: true, released };
    },
    'POST content': (p, b) => {
      const a = p.touch(b.agent);
      const fp = normPath(b.path);
      if (typeof b.content !== 'string') throw httpError(400, 'content must be a string');
      if (Buffer.byteLength(b.content) > MAX_FILE_BYTES) throw httpError(413, 'file too large to share');
      const l = p.locks[fp];
      if (l && l.holder !== a.id) throw httpError(409, `locked by ${l.holderName}`);
      if (!l) {
        p.locks[fp] = { path: fp, holder: a.id, holderName: a.name, checkout: a.checkout,
          since: now(), note: '', hold: false };
        p.emit('lock', { lock: p.locks[fp] });
      }
      const hash = sha(b.content);
      const prev = p.files[fp];
      if (prev && prev.hash === hash && prev.content != null) return { ok: true, version: prev.version, unchanged: true };
      const f = p.files[fp] = {
        path: fp, hash, content: b.content, by: a.id, byName: a.name, at: now(),
        version: (prev ? prev.version : 0) + 1,
        hashes: [...(prev ? prev.hashes : []), hash].slice(-HASH_HISTORY),
        checkout: a.checkout,
      };
      p.emit('file', { file: p.fileMeta(f), prevHash: prev ? prev.hash : null, tool: b.tool || '' });
      save();
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
      save();
      return { ok: true, message: m };
    },
    'GET messages': (p, b, q) => {
      const since = Number(q.get('since') || 0);
      const limit = Math.min(Number(q.get('limit') || 200), 1000);
      return { messages: p.messages.filter(m => m.seq > since).slice(-limit) };
    },
    // unread messages for an agent; advances its read pointer unless peek=1
    'POST inbox': async (p, b, q, req) => {
      const a = p.touch(b.agent);
      const unread = () => p.messages.filter(m => m.seq > a.readSeq && p.relevant(m, a));
      let msgs = unread();
      if (!msgs.length && b.wait > 0) {
        await waitFor(p, ev => ev.type === 'message' && p.relevant(ev.message, a), b.wait * 1000, req);
        msgs = unread();
      }
      if (!b.peek && msgs.length) { a.readSeq = msgs[msgs.length - 1].seq; save(); }
      return { messages: msgs };
    },
    'POST wait-unlock': async (p, b, q, req) => {
      const a = p.touch(b.agent);
      const fp = normPath(b.path);
      const free = () => !p.locks[fp] || p.locks[fp].holder === a.id;
      if (!free()) await waitFor(p, ev => ev.type === 'unlock' && ev.path === fp, (b.timeout || 300) * 1000, req);
      return { free: free(), lock: p.locks[fp] || null };
    },
    'GET events': async (p, b, q, req, res) => {
      const since = Number(q.get('since') || 0);
      if ((req.headers.accept || '').includes('text/event-stream')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
          connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(p.snapshot())}\n\n`);
        for (const ev of p.events) if (ev.seq > since) res.write(`data: ${JSON.stringify(ev)}\n\n`);
        const w = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        p.waiters.add(w);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { p.waiters.delete(w); clearInterval(ping); });
        return undefined;
      }
      const pending = () => p.events.filter(ev => ev.seq > since);
      let evs = pending();
      const wait = Number(q.get('wait') || 0);
      if (!evs.length && wait > 0) { await waitFor(p, () => true, wait * 1000, req); evs = pending(); }
      const truncated = p.events.length && p.events[0].seq > since + 1 && since > 0;
      return { events: evs, seq: p.seq, truncated };
    },
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      if (res.headersSent) return;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(dashboard);
      }
      if (url.pathname === '/health') return send(200, { ok: true });
      const m = url.pathname.match(/^\/api\/p\/([^/]+)\/([\w-]+)$/);
      if (url.pathname === '/api/projects') {
        checkAuth(req, url);
        return send(200, { projects: [...projects.keys()] });
      }
      if (!m) return send(404, { error: 'not found' });
      checkAuth(req, url);
      const route = routes[`${req.method} ${m[2]}`];
      if (!route) return send(404, { error: 'no such endpoint' });
      const p = project(decodeURIComponent(m[1]));
      let body = {};
      if (req.method === 'POST') body = await readBody(req);
      const out = await route(p, body, url.searchParams, req, res);
      if (out !== undefined) send(200, out);
    } catch (e) {
      send(e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
    }
  });

  function checkAuth(req, url) {
    const h = req.headers.authorization || '';
    const given = h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token');
    const a = Buffer.from(String(given || '')), b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(401, 'bad token');
  }

  server.huddleToken = token;
  server.on('close', () => clearInterval(sweeper));
  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_FILE_BYTES * 2) { reject(httpError(413, 'body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(httpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

module.exports = { createServer, sha };

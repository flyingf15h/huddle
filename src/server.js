// huddle relay server for Node: keeps projects on disk and serves the core
// routes over HTTP, with SSE for the dashboard.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Project, routes, dispatch, takeOutbox, waitOn, sha, now, httpError, sameSecret,
  MAX_FILE_BYTES, OPEN_IDLE_MS, OPEN_MAX_PROJECTS, OPEN_CREATES_PER_HOUR } = require('./core');
const gh = require('./github-auth');
const { statusPage } = require('./status-page');

function createServer(opts = {}) {
  const dataDir = opts.dataDir || path.join(process.cwd(), 'huddle-data');
  fs.mkdirSync(dataDir, { recursive: true });
  const projectDir = path.join(dataDir, 'projects');
  fs.mkdirSync(projectDir, { recursive: true });
  const open = !!(opts.open || process.env.HUDDLE_OPEN);
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
  const projectFile = (name) => path.join(projectDir, name + '.json');
  for (const f of fs.readdirSync(projectDir)) {
    if (!f.endsWith('.json')) continue;
    try { const name = f.slice(0, -5); projects.set(name, new Project(name, JSON.parse(fs.readFileSync(path.join(projectDir, f), 'utf8')))); }
    catch (e) { console.error(`huddle: could not load ${f}:`, e.message); }
  }
  const legacy = path.join(dataDir, 'state.json'); // single-file format from 0.1
  if (fs.existsSync(legacy)) {
    try {
      for (const [name, p] of Object.entries(JSON.parse(fs.readFileSync(legacy, 'utf8')))) {
        if (!projects.has(name)) projects.set(name, Object.assign(new Project(name, p), { dirty: true }));
      }
      fs.renameSync(legacy, legacy + '.migrated');
    } catch (e) { console.error('huddle: could not migrate state.json:', e.message); }
  }
  function save(p) { p.dirty = true; }
  function flush() {
    for (const p of projects.values()) {
      if (!p.dirty) continue;
      p.dirty = false;
      const file = projectFile(p.name), tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(p));
      fs.renameSync(tmp, file);
    }
  }
  function project(name, admin) {
    if (!/^[\w.-]{1,64}$/.test(name)) throw httpError(400, 'bad project name');
    let p = projects.get(name);
    if (!p) {
      if (!admin) throw httpError(401, 'bad token or no such project');
      p = new Project(name);
      p.dirty = true;
      projects.set(name, p);
    }
    return p;
  }

  const saver = setInterval(flush, 1000);
  saver.unref();
  const sweeper = setInterval(() => {
    for (const p of projects.values()) {
      p.sweep();
      sendOutbox(p);
      if (open && p.tokenHash && now() - p.lastActive > OPEN_IDLE_MS) {
        projects.delete(p.name);
        fs.rmSync(projectFile(p.name), { force: true });
      }
    }
  }, 10 * 1000);
  sweeper.unref();

  const creates = new Map(); // ip -> timestamps of recent project creations
  function createProject(req, body) {
    const ip = req.headers['fly-client-ip'] || req.headers['cf-connecting-ip'] ||
      String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const recent = (creates.get(ip) || []).filter(t => now() - t < 3600 * 1000);
    if (recent.length >= OPEN_CREATES_PER_HOUR) throw httpError(429, 'too many new projects from your address, try again later');
    if (projects.size >= OPEN_MAX_PROJECTS) throw httpError(503, 'this server is full');
    recent.push(now());
    creates.set(ip, recent);
    const slug = String(body.name || 'project').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
    let name;
    do name = `${slug}-${crypto.randomBytes(3).toString('hex')}`; while (projects.has(name));
    const ptoken = 'hp_' + crypto.randomBytes(24).toString('base64url');
    const p = new Project(name);
    p.tokenHash = sha(ptoken + ':' + name);
    p.dirty = true;
    projects.set(name, p);
    return { project: name, token: ptoken };
  }

  const dashboard = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
  const invitesFile = path.join(dataDir, 'invites.json');
  let invites = {};
  try { invites = JSON.parse(fs.readFileSync(invitesFile, 'utf8')); } catch {}

  // large blobs (git bundle pieces) live next to the project file, not inside it
  function blobStore(name) {
    const dir = path.join(dataDir, 'blobs', name);
    const file = (key) => path.join(dir, key.replace(/[^\w.-]/g, '_'));
    return {
      async put(key, data) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(key), data); },
      async get(key) { try { return fs.readFileSync(file(key), 'utf8'); } catch { return null; } },
      async del(key) { fs.rmSync(file(key), { force: true }); },
    };
  }

  // GitHub sign-in (HUDDLE_GITHUB_CLIENT_ID / HUDDLE_GITHUB_CLIENT_SECRET) and which projects each login is in
  const ghCfg = { clientId: opts.githubClientId || process.env.HUDDLE_GITHUB_CLIENT_ID, clientSecret: opts.githubClientSecret || process.env.HUDDLE_GITHUB_CLIENT_SECRET, secret: token };
  const usersFile = path.join(dataDir, 'users.json');
  let users = {};
  try { users = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch {}
  const saveUsers = () => { try { fs.writeFileSync(usersFile, JSON.stringify(users), { mode: 0o600 }); } catch {} };
  const started = now();

  // notifications a route queued: posted after the answer, never holding it up
  function sendOutbox(p) {
    for (const o of takeOutbox(p)) {
      fetch(o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o.body), signal: AbortSignal.timeout(10000) })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); })
        .catch(e => { p.problems = p.problems || []; p.problems.push({ id: sha(String(Math.random())).slice(0, 8), at: now(), name: 'huddle', kind: 'notify', message: `a notification could not be delivered: ${e.message}`, detail: '' }); p.dirty = true; });
    }
  }

  function sse(p, since, req, res, auth) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
      connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`event: snapshot\ndata: ${JSON.stringify(p.snapshot())}\n\n`);
    for (const ev of p.eventsSince(since) || []) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const w = (ev) => {
      // someone the owner removed stops receiving the project at once
      if (ev.type === 'members' && ev.removed && auth && auth.name === ev.removed) { res.end(); p.waiters.delete(w); return; }
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    p.waiters.add(w);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { p.waiters.delete(w); clearInterval(ping); });
  }

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
      if (url.pathname === '/health') return send(200, { ok: true, open });
      if (url.pathname === '/status') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(statusPage({ ok: true, server: 'self-hosted', since: started, projects: projects.size, github: gh.configured(ghCfg) }));
      }
      const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      const reply = (r) => { res.writeHead(r.status, r.headers); res.end(r.body); };
      if (url.pathname === '/auth/github/login') return reply(await gh.login(ghCfg, origin, url.searchParams.get('next') || '/'));
      if (url.pathname === '/auth/github/callback') return reply(await gh.callback(ghCfg, origin, url, req.headers.cookie));
      if (url.pathname === '/auth/logout') return reply(gh.logout(origin));
      if (url.pathname === '/auth/me') {
        const who = await gh.session(ghCfg, req.headers.cookie);
        return send(200, { github: gh.configured(ghCfg), user: who });
      }
      if (url.pathname === '/api/me/projects') {
        const who = await gh.session(ghCfg, req.headers.cookie);
        if (!who) throw httpError(401, 'sign in with GitHub first');
        const out = [];
        for (const name of users[who.login.toLowerCase()] || []) {
          const p = projects.get(name);
          const m = p && Object.entries(p.members || {}).find(([, x]) => x.github && x.github.toLowerCase() === who.login.toLowerCase());
          if (m) out.push({ project: name, name: m[0], role: m[1].role });
        }
        return send(200, { user: who, projects: out });
      }
      const short = url.pathname.match(/^\/api\/invite\/([\w-]{12})$/);
      if (short && req.method === 'GET') {
        const inv = invites[short[1]];
        if (!inv) throw httpError(404, 'no such invite');
        if (inv.personal) return send(200, { server: origin, project: inv.project, personal: true });
        return send(200, { server: origin, project: inv.project, token: inv.token });
      }
      if (url.pathname === '/api/new' && req.method === 'POST') {
        const body = await readBody(req);
        if (!open) checkAdmin(req, url);
        return send(200, createProject(req, body));
      }
      const m = url.pathname.match(/^\/api\/p\/([^/]+)\/([\w-]+)$/);
      if (url.pathname === '/api/projects') {
        checkAdmin(req, url);
        return send(200, { projects: [...projects.keys()] });
      }
      if (!m) return send(404, { error: 'not found' });
      const admin = isAdmin(req, url);
      const p = project(decodeURIComponent(m[1]), admin);
      // what the caller holds: the server's own token or the project's shared one, a personal token
      // (hm_…), a GitHub session cookie, or nothing (only good for turning a personal invite into a token)
      const tok = given(req, url);
      const who = await gh.session(ghCfg, req.headers.cookie);
      const cred = admin || (p.tokenHash && sameSecret(sha(tok + ':' + p.name), p.tokenHash)) ? { kind: 'project', github: who && who.login }
        : tok.startsWith('hm_') ? { kind: 'member', token: tok, github: who && who.login }
        : who ? { kind: 'github', github: who.login } : { kind: 'none' };
      if (cred.kind === 'none' && m[2] !== 'redeem') throw httpError(401, 'bad token or no such project');
      p.origin = origin;
      if (m[2] === 'events' && (req.headers.accept || '').includes('text/event-stream')) {
        const auth = require('./core').authorize(p, cred);
        return sse(p, Number(url.searchParams.get('since') || 0), req, res, auth);
      }
      let body = {};
      if (req.method === 'POST') body = await readBody(req);
      const ctx = { waitFor: (pred, ms) => waitOn(p, pred, ms, (abort) => req.on('close', abort)), blobs: blobStore(p.name) };
      const out = await dispatch(p, req.method, m[2], body, url.searchParams, ctx, cred);
      // what a short invite stands for: the project and the token of whoever asked for it
      if (m[2] === 'invite-code') saveInvite(out.code, { project: p.name, token: tok });
      if (m[2] === 'member-invite' && out.inviteCode) saveInvite(out.inviteCode, { project: p.name, personal: true });
      if (m[2] === 'link-github' && out.linked) {
        const k = out.linked.toLowerCase();
        users[k] = [...new Set([...(users[k] || []), p.name])];
        saveUsers();
      }
      send(200, out);
      sendOutbox(p);
    } catch (e) {
      send(e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
    }
  });

  function saveInvite(code, inv) {
    invites[code] = inv;
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(invitesFile, JSON.stringify(invites), { mode: 0o600 }); } catch {}
  }
  function given(req, url) {
    const h = req.headers.authorization || '';
    return String((h.startsWith('Bearer ') ? h.slice(7) : url.searchParams.get('token')) || '');
  }
  function isAdmin(req, url) { return sameSecret(given(req, url), token); }
  function checkAdmin(req, url) { if (!isAdmin(req, url)) throw httpError(401, 'bad token'); }

  // outlive clients' idle sockets, or a reused connection can be closed under a request
  server.keepAliveTimeout = 70 * 1000;
  server.headersTimeout = 75 * 1000;
  server.huddleToken = token;
  server.huddleOpen = open;
  server.huddleFlush = flush;
  server.on('close', () => { clearInterval(sweeper); clearInterval(saver); flush(); });
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

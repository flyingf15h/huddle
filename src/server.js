// huddle relay server for Node: keeps projects on disk and serves the core
// routes over HTTP, with SSE for the dashboard.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { Project, routes, dispatch, takeOutbox, waitOn, sha, now, httpError, sameSecret,
  MAX_FILE_BYTES, OPEN_IDLE_MS, OPEN_MAX_PROJECTS, OPEN_CREATES_PER_HOUR } = require('./core');
const accounts = require('./accounts');
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
  }, Number(process.env.HUDDLE_SWEEP_MS) || 10 * 1000);
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
  // the public/ folder: screenshots, the privacy and terms pages, icons
  const publicDir = path.join(__dirname, '..', 'public');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
  function staticFile(pathname, res) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
    if (!rel || rel.includes('..') || rel.startsWith('api/')) return false;
    if (!path.extname(rel)) rel += '.html';
    const file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'public, max-age=300' });
    res.end(fs.readFileSync(file));
    return true;
  }
  const landing = fs.readFileSync(path.join(__dirname, 'landing.html'), 'utf8');
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

  // accounts: sign in with an email code (HUDDLE_RESEND_API_KEY or HUDDLE_EMAIL_WEBHOOK sends the mail;
  // HUDDLE_EMAIL_DEV=1 hands the code back instead, for local use) or GitHub (HUDDLE_GITHUB_CLIENT_ID / _SECRET)
  const accountsFile = path.join(dataDir, 'accounts.json');
  let acct = {};
  try { acct = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); } catch {}
  const saveAccounts = () => { try { fs.writeFileSync(accountsFile + '.tmp', JSON.stringify(acct), { mode: 0o600 }); fs.renameSync(accountsFile + '.tmp', accountsFile); } catch {} };
  const emailDev = !!(opts.emailDev || process.env.HUDDLE_EMAIL_DEV);
  const send = accounts.mailer({ resendKey: opts.resendKey || process.env.HUDDLE_RESEND_API_KEY, webhook: opts.emailWebhook || process.env.HUDDLE_EMAIL_WEBHOOK, from: process.env.HUDDLE_EMAIL_FROM });
  const acctCfg = {
    secret: token,
    github: { clientId: opts.githubClientId || process.env.HUDDLE_GITHUB_CLIENT_ID, clientSecret: opts.githubClientSecret || process.env.HUDDLE_GITHUB_CLIENT_SECRET },
    email: (send || emailDev) ? { send: send || (emailDev ? async (m) => console.log(`huddle: sign-in email for ${m.to}:\n${m.text}`) : null), dev: emailDev } : null,
    store: { async get(k) { return acct[k] || null; }, async put(k, v) { acct[k] = v; saveAccounts(); }, async del(k) { delete acct[k]; saveAccounts(); } },
  };
  const started = now();

  // notifications a route queued: posted after the answer, never holding it up
  function sendOutbox(p) {
    for (const o of takeOutbox(p)) {
      if (o.email) {
        if (acctCfg.email && acctCfg.email.send) acctCfg.email.send(o.email).catch(e => { (p.problems = p.problems || []).push({ id: sha(String(Math.random())).slice(0, 8), at: now(), name: 'huddle', kind: 'notify', message: `an email could not be sent: ${e.message}`, detail: '' }); p.dirty = true; });
        continue;
      }
      fetch(o.url, { method: o.method || 'POST', headers: { 'content-type': 'application/json', ...(o.headers || {}) }, body: JSON.stringify(o.body), signal: AbortSignal.timeout(10000) })
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
      // the landing page at /, the app at /app (the landing page sends invite links and returning people on)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(landing);
      }
      if (req.method === 'GET' && (url.pathname === '/app' || url.pathname === '/app/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(dashboard);
      }
      if (url.pathname === '/health') return send(200, { ok: true, open });
      if (url.pathname === '/status') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(statusPage({ ok: true, server: 'self-hosted', since: started, projects: projects.size, github: accounts.githubConfigured(acctCfg), email: accounts.emailConfigured(acctCfg) }));
      }
      const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
      const reply = (r) => { res.writeHead(r.status, r.headers); res.end(r.body); };
      if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/me')) {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const r = await accounts.handle(acctCfg, origin, { method: req.method, url, cookie: req.headers.cookie, body });
        if (r) return reply(r);
      }
      if (staticFile(url.pathname, res)) return;
      // GitHub's webhook for a project's connected repository (the project checks its signature)
      const hook = url.pathname.match(/^\/api\/hooks\/github\/([\w.-]{1,64})$/);
      if (hook && req.method === 'POST') {
        const p = projects.get(hook[1]);
        if (!p) throw httpError(404, 'no such project');
        const raw = await readRaw(req);
        let body = {};
        try { body = JSON.parse(raw); } catch { throw httpError(400, 'invalid JSON'); }
        const ctx = { request: { raw, header: (k) => req.headers[k.toLowerCase()] || '' }, blobs: blobStore(p.name), waitFor: () => Promise.resolve(null) };
        send(200, await dispatch(p, 'POST', 'github-webhook', body, url.searchParams, ctx, { kind: 'none' }));
        return sendOutbox(p);
      }
      const slk = url.pathname.match(/^\/api\/slack\/([\w.-]{1,64})\/(command|interact)$/);
      if (slk && req.method === 'POST') {
        const p = projects.get(slk[1]);
        if (!p) throw httpError(404, 'no such project');
        const raw = await readRaw(req);
        const ctx = { request: { raw, header: (k) => req.headers[k.toLowerCase()] || '' }, blobs: blobStore(p.name), waitFor: () => Promise.resolve(null) };
        const out = await dispatch(p, 'POST', 'slack-' + slk[2], {}, url.searchParams, ctx, { kind: 'none' });
        send(200, out);
        return sendOutbox(p);
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
      const who = accounts.credOf(await accounts.sessionUser(acctCfg, req.headers.cookie).catch(() => null));
      const cred = admin || (p.tokenHash && sameSecret(sha(tok + ':' + p.name), p.tokenHash)) ? { kind: 'project', ...(who || {}) }
        : tok.startsWith('hm_') ? { kind: 'member', token: tok, ...(who || {}) }
        : who ? { kind: 'user', ...who } : { kind: 'none' };
      if (cred.kind === 'none' && m[2] !== 'redeem') throw httpError(401, 'bad token or no such project');
      p.origin = origin;
      if (m[2] === 'events' && (req.headers.accept || '').includes('text/event-stream')) {
        const auth = require('./core').authorize(p, cred);
        return sse(p, Number(url.searchParams.get('since') || 0), req, res, auth);
      }
      let body = {};
      if (req.method === 'POST') body = await readBody(req);
      const ctx = { waitFor: (pred, ms) => waitOn(p, pred, ms, (abort) => req.on('close', abort)), blobs: blobStore(p.name),
        deleteProject: async () => { projects.delete(p.name); fs.rmSync(projectFile(p.name), { force: true }); fs.rmSync(path.join(dataDir, 'blobs', p.name), { recursive: true, force: true }); p.dirty = false; } };
      const out = await dispatch(p, req.method, m[2], body, url.searchParams, ctx, cred);
      // what a short invite stands for: the project and the token of whoever asked for it
      if (m[2] === 'invite-code') saveInvite(out.code, { project: p.name, token: tok });
      if (m[2] === 'member-invite' && out.inviteCode) saveInvite(out.inviteCode, { project: p.name, personal: true });
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

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_FILE_BYTES * 2) { reject(httpError(413, 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

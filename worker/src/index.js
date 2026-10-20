// Public huddle relay on Cloudflare Workers. Each project lives in its own
// Durable Object; clients stream events over hibernating WebSockets so idle
// projects cost nothing. Project tokens are an HMAC of the project name, so
// creating a project stores nothing until someone actually uses it.
import { DurableObject } from 'cloudflare:workers';
import core from '../../src/core.js';
import accounts from '../../src/accounts.js';
import statusPageMod from '../../src/status-page.js';
import dashboard from '../../src/dashboard.html';
import landing from '../../src/landing.html';

const { Project, dispatch, authorize, takeOutbox, waitOn, httpError, now } = core;
const { statusPage } = statusPageMod;
// accounts: email codes sent with Resend (RESEND_API_KEY, EMAIL_FROM) and GitHub OAuth (GITHUB_CLIENT_ID / _SECRET);
// each account record lives in a small index instance of its own ("acct:user:<id>", "acct:email:<address>", …)
function acctCfg(env) {
  const send = accounts.mailer({ resendKey: env.RESEND_API_KEY, webhook: env.EMAIL_WEBHOOK, from: env.EMAIL_FROM });
  const dev = env.EMAIL_DEV === '1';
  return {
    secret: env.HUDDLE_SECRET,
    github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    email: send || dev ? { send, dev } : null,
    store: {
      async get(k) { const v = await indexGet(env, 'acct:' + k); return v && Object.keys(v).length ? v : null; },
      put: (k, v) => indexPut(env, 'acct:' + k, v),
      del: (k) => indexDel(env, 'acct:' + k),
    },
  };
}
// the plain { status, headers, body } answers from github-auth.js as Responses (set-cookie may be a list)
function reply(r) {
  const h = new Headers();
  for (const [k, v] of Object.entries(r.headers || {})) for (const x of [].concat(v)) h.append(k, x);
  return new Response(r.body || null, { status: r.status, headers: h });
}
// a small index instance: which projects a short invite or a GitHub login opens
const index = (env, key) => env.PROJECTS.get(env.PROJECTS.idFromName(key));
async function indexGet(env, key) { return (await index(env, key).fetch(new Request('https://index/', { headers: { 'x-huddle-index': key } }))).json(); }
async function indexPut(env, key, value) { await index(env, key).fetch(new Request('https://index/', { method: 'PUT', headers: { 'x-huddle-index': key }, body: JSON.stringify(value) })); }
async function indexDel(env, key) { await index(env, key).fetch(new Request('https://index/', { method: 'DELETE', headers: { 'x-huddle-index': key } })); }

// tighter than the self-hosted defaults: the free plan has 5 GB for everyone
const LIMITS = { fileBytes: 1024 * 1024, files: 500, projectBytes: 10 * 1024 * 1024, sharedBytes: 1536 * 1024, gitBytes: 25 * 1024 * 1024 };
const IDLE_DELETE_MS = 30 * 24 * 60 * 60 * 1000;
const SWEEP_MS = 60 * 1000;
const MSGS_BYTES = 1024 * 1024;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
});

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const projectToken = async (env, name) => 'hp_' + (await hmac(env.HUDDLE_SECRET, 'project:' + name)).slice(0, 32);

function givenToken(request, url) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') || '');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (!env.HUDDLE_SECRET) throw httpError(500, 'server is missing HUDDLE_SECRET');
      // the landing page at /, the app at /app (the landing page sends invite links and returning people on)
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return new Response(landing, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (request.method === 'GET' && (url.pathname === '/app' || url.pathname === '/app/')) {
        return new Response(dashboard, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/health') return json({ ok: true, open: true });
      if (url.pathname === '/status') {
        // a real round trip through a Durable Object, timed
        const t0 = Date.now();
        let doCheck;
        try { await indexGet(env, 'status:probe'); doCheck = { name: 'Project storage (Durable Objects)', ok: true, ms: Date.now() - t0 }; }
        catch (e) { doCheck = { name: 'Project storage (Durable Objects)', ok: false, error: e.message }; }
        return new Response(statusPage({ server: url.host, version: env.HUDDLE_VERSION || null, github: accounts.githubConfigured(acctCfg(env)),
          email: accounts.emailConfigured(acctCfg(env)), checks: [{ name: 'API', ok: true }, doCheck] }), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/me')) {
        const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
        const r = await accounts.handle(acctCfg(env), url.origin, { method: request.method, url, cookie: request.headers.get('cookie'), body });
        if (r) return reply(r);
      }
      // GitHub's webhook for a project's repository: the project checks the signature itself
      const hook = url.pathname.match(/^\/api\/hooks\/github\/([\w.-]{1,64})$/);
      if (hook && request.method === 'POST') {
        const headers = new Headers(request.headers);
        headers.set('x-huddle-project', hook[1]);
        headers.set('x-huddle-cred', JSON.stringify({ kind: 'none' }));
        headers.set('x-huddle-origin', url.origin);
        headers.delete('x-huddle-index');
        return env.PROJECTS.get(env.PROJECTS.idFromName(hook[1])).fetch(new Request(`https://do/api/p/${hook[1]}/github-webhook`, { method: 'POST', headers, body: await request.text() }));
      }
      // screenshots, privacy and terms pages, icons
      if (request.method === 'GET' && env.ASSETS && !url.pathname.startsWith('/api/')) {
        const a = await env.ASSETS.fetch(new Request(new URL(url.pathname.includes('.') ? url.pathname : url.pathname + '.html', url.origin)));
        if (a.ok) return a;
      }
      if (url.pathname === '/api/new' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const slug = String(body.name || 'project').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
        const rand = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
        const name = `${slug}-${rand}`;
        return json({ project: name, token: await projectToken(env, name) });
      }
      // a short invite: which project it opens, with that project's token
      const short = url.pathname.match(/^\/api\/invite\/([\w-]{12})$/);
      if (short && request.method === 'GET') {
        const r = await indexGet(env, 'invite:' + short[1]);
        if (!r.project) throw httpError(404, 'no such invite');
        if (r.personal) return json({ server: url.origin, project: r.project, personal: true });
        return json({ server: url.origin, project: r.project, token: await projectToken(env, r.project) });
      }
      const m = url.pathname.match(/^\/api\/p\/([\w.-]{1,64})\/([\w-]+)$/);
      if (!m) return json({ error: 'not found' }, 404);
      const name = m[1];
      const tok = givenToken(request, url);
      // what the caller holds: the project's shared token (checked here), a personal token (hm_…, checked by
      // the project), a GitHub session, or nothing (only good for turning a personal invite into a token)
      const who = accounts.credOf(await accounts.sessionUser(acctCfg(env), request.headers.get('cookie')).catch(() => null));
      const cred = timingSafeEqual(tok, await projectToken(env, name)) ? { kind: 'project', ...(who || {}) }
        : tok.startsWith('hm_') ? { kind: 'member', token: tok, ...(who || {}) }
        : who ? { kind: 'user', ...who } : { kind: 'none' };
      if (cred.kind === 'none' && m[2] !== 'redeem') throw httpError(401, 'bad token or no such project');
      const stub = env.PROJECTS.get(env.PROJECTS.idFromName(name));
      const headers = new Headers(request.headers);
      headers.set('x-huddle-project', name);
      headers.set('x-huddle-cred', JSON.stringify(cred));
      headers.set('x-huddle-origin', url.origin);
      headers.delete('x-huddle-index');
      const res = await stub.fetch(new Request(request, { headers }));
      // remember what a project's short invite stands for (written each time it's asked for, so it can't go missing)
      if (m[2] === 'invite-code' && res.ok) await indexPut(env, 'invite:' + (await res.clone().json()).code, { project: name });
      if (m[2] === 'member-invite' && res.ok) await indexPut(env, 'invite:' + (await res.clone().json()).inviteCode, { project: name, personal: true });
      return res;
    } catch (e) {
      return json({ error: e.message }, e.code >= 400 && e.code < 600 ? e.code : 500);
    }
  },
};

export class HuddleProject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.p = null;
    this.saved = { seq: -1, reads: '', msgSeq: -1 };
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async load(name) {
    if (this.p) return this.p;
    const s = this.ctx.storage;
    const meta = await s.get('meta');
    const p = new Project(name || (meta && meta.name) || 'project', meta || undefined);
    p.events = []; // not persisted; clients that fall behind resync from a snapshot
    if (meta) {
      for (const [k, v] of await s.list({ prefix: 'f:' })) {
        const f = p.files[k.slice(2)];
        if (f) f.content = v;
      }
      p.messages = (await s.get('msgs')) || [];
      p.shared = (await s.get('shared')) || p.shared;
      p.activity = (await s.get('activity')) || [];
      p.audit = (await s.get('audit')) || meta.audit || [];
      p.problems = (await s.get('problems')) || meta.problems || [];
    }
    p.limits = { ...LIMITS };
    p.isConnected = (id) => this.ctx.getWebSockets(id).length > 0;
    p.waiters.add((ev) => {
      if (ev.type === 'members' && ev.removed) for (const ws of this.ctx.getWebSockets('member:' + ev.removed)) { try { ws.close(4001, 'removed from the project'); } catch {} }
      this.broadcast(ev);
    });
    this.p = p;
    this.saved = { seq: p.seq, reads: this.reads(), msgSeq: lastSeq(p.messages) };
    return p;
  }

  // locks need sweeping, and batched emails need sending, a minute or two later
  busy() { return Object.keys(this.p.locks).length > 0 || Object.values(this.p.mailQueue || {}).some(x => x.length); }

  reads() { return Object.values(this.p.agents).map(a => a.readSeq).join(','); }

  broadcast(ev) {
    const data = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(data); } catch {} }
  }

  // Write only what changed; heartbeats alone don't touch storage.
  async save() {
    const p = this.p;
    const reads = this.reads();
    if (p.seq === this.saved.seq && reads === this.saved.reads && !p.changedFiles.size && !p.auditChanged && !p.problemsChanged) return;
    const meta = JSON.parse(JSON.stringify(p));
    delete meta.events;
    delete meta.messages;
    delete meta.shared;
    delete meta.activity;
    delete meta.audit;
    delete meta.problems;
    for (const f of Object.values(meta.files)) delete f.content;
    const puts = { meta };
    if (p.auditChanged) { puts.audit = p.audit; p.auditChanged = false; }
    if (p.problemsChanged) { puts.problems = p.problems; p.problemsChanged = false; }
    if (p.sharedChanged) { puts.shared = p.shared; p.sharedChanged = false; }
    if (p.activityChanged) {
      let act = p.activity;
      while (act.length > 1 && JSON.stringify(act).length > MSGS_BYTES) act = act.slice(Math.ceil(act.length / 4));
      puts.activity = act;
      p.activityChanged = false;
    }
    for (const fp of p.changedFiles) if (p.files[fp] && p.files[fp].content != null) puts['f:' + fp] = p.files[fp].content;
    p.changedFiles.clear();
    const msgSeq = lastSeq(p.messages);
    if (msgSeq !== this.saved.msgSeq) {
      let msgs = p.messages.slice(-500);
      while (msgs.length > 1 && JSON.stringify(msgs).length > MSGS_BYTES) msgs = msgs.slice(Math.ceil(msgs.length / 4));
      puts.msgs = msgs;
    }
    await this.ctx.storage.put(puts);
    this.saved = { seq: p.seq, reads, msgSeq };
    await this.schedule();
  }

  // locks need sweeping while they exist; otherwise just come back to clean up an abandoned project
  async schedule() {
    let want = this.busy() ? now() + SWEEP_MS : this.p.lastActive + IDLE_DELETE_MS;
    // the daily digest has its own time
    const nd = core.features.nextDigestAt(this.p);
    if (nd) want = Math.min(want, nd + 1000);
    const cur = await this.ctx.storage.getAlarm();
    if (!cur || cur > want + 1000 || (want - cur > 24 * 3600 * 1000)) await this.ctx.storage.setAlarm(want);
  }

  async alarm() {
    const p = await this.load();
    if (!Object.keys(p.locks).length && now() - p.lastActive > IDLE_DELETE_MS && !this.ctx.getWebSockets().length) {
      await this.ctx.storage.deleteAll();
      this.p = null;
      return;
    }
    p.sweep();
    await this.save();
    this.flushOutbox(p);
    if (this.busy()) await this.ctx.storage.setAlarm(now() + SWEEP_MS);
  }

  async fetch(request) {
    // an instance named "invite:<code>" only remembers which project a short invite opens
    const idxKey = request.headers.get('x-huddle-index');
    if (idxKey) {
      if (request.method === 'PUT') { await this.ctx.storage.put('invite', await request.json()); return json({ ok: true }); }
      if (request.method === 'DELETE') { await this.ctx.storage.deleteAll(); return json({ ok: true }); }
      return json((await this.ctx.storage.get('invite')) || {});
    }
    const url = new URL(request.url);
    const name = request.headers.get('x-huddle-project');
    const ep = url.pathname.split('/').pop();
    try {
      const p = await this.load(name);
      p.sweep();
      let cred = { kind: 'none' };
      try { cred = JSON.parse(request.headers.get('x-huddle-cred') || '{"kind":"none"}'); } catch {}
      if (request.headers.get('x-huddle-origin')) p.origin = request.headers.get('x-huddle-origin');
      if (ep === 'ws') return this.connect(request, url, p, authorize(p, cred));
      let body = {}, raw = '';
      if (request.method === 'POST') {
        raw = await request.text();
        if (raw.length > LIMITS.fileBytes * 2) throw httpError(413, 'body too large');
        try { body = raw ? JSON.parse(raw) : {}; } catch { throw httpError(400, 'invalid JSON'); }
      }
      const store = this.ctx.storage;
      const ctx = {
        request: { raw, header: (k) => request.headers.get(k) || '' },
        deleteProject: async () => { for (const ws of this.ctx.getWebSockets()) { try { ws.close(4004, 'project deleted'); } catch {} } await store.deleteAll(); await store.deleteAlarm(); this.p = null; this.deleted = true; },
        waitFor: (pred, ms) => waitOn(p, pred, Math.min(ms, 60 * 1000)),
        blobs: { put: (k, v) => store.put('blob:' + k, v), get: async (k) => (await store.get('blob:' + k)) ?? null, del: (k) => store.delete('blob:' + k) },
      };
      const out = await dispatch(p, request.method, ep, body, url.searchParams, ctx, cred);
      if (this.deleted) { this.deleted = false; return json(out); }
      await this.save();
      this.flushOutbox(p);
      return json(out);
    } catch (e) {
      return json({ error: e.message }, e.code >= 400 && e.code < 600 ? e.code : 500);
    }
  }

  // notifications the last request queued, sent after it's been answered
  flushOutbox(p) {
    const all = takeOutbox(p);
    if (!all.length) return;
    const mail = all.filter(o => o.email), out = all.filter(o => !o.email);
    const cfg = acctCfg(this.env);
    if (mail.length && cfg.email && cfg.email.send) this.ctx.waitUntil(Promise.all(mail.map(o => cfg.email.send(o.email).catch(() => {}))));
    this.ctx.waitUntil(Promise.all(out.map(o => fetch(o.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o.body) })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); })
      .catch(e => { (p.problems = p.problems || []).push({ id: Math.random().toString(16).slice(2, 10), at: now(), name: 'huddle', kind: 'notify', message: `a notification could not be delivered: ${e.message}`, detail: '' }); p.problemsChanged = true; }))));
  }

  async connect(request, url, p, auth) {
    if (request.headers.get('upgrade') !== 'websocket') throw httpError(426, 'expected a websocket');
    let agent = null;
    try { agent = JSON.parse(url.searchParams.get('agent') || 'null'); } catch {}
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // tagged with the person's name too, so removing them from the project closes their connections
    const tags = [...(agent && agent.id ? [agent.id] : []), ...(auth && auth.name ? ['member:' + auth.name] : [])];
    this.ctx.acceptWebSocket(server, tags);
    server.serializeAttachment({ agent: agent && agent.id ? agent.id : null, member: auth && auth.name || null });
    if (auth && auth.name && agent) agent.name = auth.name;
    if (agent && agent.id) p.touch(agent); // counts as online for as long as the socket is open
    const since = Number(url.searchParams.get('since') || 0);
    server.send(JSON.stringify({ type: 'snapshot', ...p.snapshot() }));
    const evs = p.eventsSince(since);
    if (!evs) server.send(JSON.stringify({ type: 'truncated', seq: p.seq }));
    else for (const ev of evs) server.send(JSON.stringify(ev));
    await this.save();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage() {}

  async webSocketClose(ws, code) {
    try { ws.close(code, 'bye'); } catch {}
    const p = await this.load();
    p.sweep();
    await this.save();
  }
}

function lastSeq(msgs) { return msgs.length ? msgs[msgs.length - 1].seq : 0; }

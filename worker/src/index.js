// Public huddle relay on Cloudflare Workers. Each project lives in its own
// Durable Object; clients stream events over hibernating WebSockets so idle
// projects cost nothing. Project tokens are an HMAC of the project name, so
// creating a project stores nothing until someone actually uses it.
import { DurableObject } from 'cloudflare:workers';
import core from '../../src/core.js';
import dashboard from '../../src/dashboard.html';

const { Project, routes, waitOn, httpError, now } = core;

// tighter than the self-hosted defaults: the free plan has 5 GB for everyone
const LIMITS = { fileBytes: 1024 * 1024, files: 500, projectBytes: 10 * 1024 * 1024 };
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
      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return new Response(dashboard, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/health') return json({ ok: true, open: true });
      if (url.pathname === '/api/new' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const slug = String(body.name || 'project').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
        const rand = [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
        const name = `${slug}-${rand}`;
        return json({ project: name, token: await projectToken(env, name) });
      }
      const m = url.pathname.match(/^\/api\/p\/([\w.-]{1,64})\/([\w-]+)$/);
      if (!m) return json({ error: 'not found' }, 404);
      const name = m[1];
      const tok = givenToken(request, url);
      if (!timingSafeEqual(tok, await projectToken(env, name))) throw httpError(401, 'bad token or no such project');
      const stub = env.PROJECTS.get(env.PROJECTS.idFromName(name));
      const headers = new Headers(request.headers);
      headers.set('x-huddle-project', name);
      return stub.fetch(new Request(request, { headers }));
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
    }
    p.limits = { ...LIMITS };
    p.isConnected = (id) => this.ctx.getWebSockets(id).length > 0;
    p.waiters.add((ev) => this.broadcast(ev));
    this.p = p;
    this.saved = { seq: p.seq, reads: this.reads(), msgSeq: lastSeq(p.messages) };
    return p;
  }

  reads() { return Object.values(this.p.agents).map(a => a.readSeq).join(','); }

  broadcast(ev) {
    const data = JSON.stringify(ev);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(data); } catch {} }
  }

  // Write only what changed; heartbeats alone don't touch storage.
  async save() {
    const p = this.p;
    const reads = this.reads();
    if (p.seq === this.saved.seq && reads === this.saved.reads && !p.changedFiles.size) return;
    const meta = JSON.parse(JSON.stringify(p));
    delete meta.events;
    delete meta.messages;
    for (const f of Object.values(meta.files)) delete f.content;
    const puts = { meta };
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
    const want = Object.keys(this.p.locks).length ? now() + SWEEP_MS : this.p.lastActive + IDLE_DELETE_MS;
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
    if (Object.keys(p.locks).length) await this.ctx.storage.setAlarm(now() + SWEEP_MS);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const name = request.headers.get('x-huddle-project');
    const ep = url.pathname.split('/').pop();
    try {
      const p = await this.load(name);
      p.sweep();
      if (ep === 'ws') return this.connect(request, url, p);
      const route = routes[`${request.method} ${ep}`];
      if (!route) return json({ error: 'no such endpoint' }, 404);
      let body = {};
      if (request.method === 'POST') {
        const text = await request.text();
        if (text.length > LIMITS.fileBytes * 2) throw httpError(413, 'body too large');
        try { body = text ? JSON.parse(text) : {}; } catch { throw httpError(400, 'invalid JSON'); }
      }
      const ctx = { waitFor: (pred, ms) => waitOn(p, pred, Math.min(ms, 60 * 1000)) };
      const out = await route(p, body, url.searchParams, ctx);
      await this.save();
      return json(out);
    } catch (e) {
      return json({ error: e.message }, e.code >= 400 && e.code < 600 ? e.code : 500);
    }
  }

  async connect(request, url, p) {
    if (request.headers.get('upgrade') !== 'websocket') throw httpError(426, 'expected a websocket');
    let agent = null;
    try { agent = JSON.parse(url.searchParams.get('agent') || 'null'); } catch {}
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, agent && agent.id ? [agent.id] : []);
    server.serializeAttachment({ agent: agent && agent.id ? agent.id : null });
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

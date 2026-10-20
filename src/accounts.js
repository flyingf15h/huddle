// Accounts for people using the dashboard: sign in with an email code (or link) or with GitHub, and
// your projects follow you to any browser. Shared by the Cloudflare Worker and the Node server, so
// only web-standard APIs (fetch, WebCrypto). Each server hands in a small key-value store and, for
// email, a way to send mail.
//
// What an account holds: an id, the email and/or GitHub login it signs in with, a display name, and
// the projects it has opened with the credential for each (the same token the browser would keep in
// localStorage). Projects keep their own members and roles; an account is how a person carries
// their access around, and how a project can reach them by email.
'use strict';

const subtle = (globalThis.crypto && globalThis.crypto.subtle) || require('crypto').webcrypto.subtle;
const rand = (n) => (globalThis.crypto && globalThis.crypto.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(n)) : require('crypto').randomBytes(n));
const COOKIE = 'huddle_s';
const STATE_COOKIE = 'huddle_gh_state';
const SESSION_DAYS = 30;
const CODE_MINUTES = 15;
const CODES_PER_HOUR = 5;
const MAX_PROJECTS = 200;

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const enc = (s) => new TextEncoder().encode(s);
async function hmac(secret, text) {
  const key = await subtle.importKey('raw', enc('gh-session:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await subtle.sign('HMAC', key, enc(text)));
}
async function digest(text) { return b64u(await subtle.digest('SHA-256', enc(text))); }
function same(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function cookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const cookie = (name, value, maxAge, secure) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
const json = (obj, status = 200, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(obj) });
const fail = (status, error) => json({ error }, status);
const redirect = (location, setCookie) => ({ status: 302, headers: { location, ...(setCookie ? { 'set-cookie': setCookie } : {}) }, body: '' });
const safeNext = (n) => { n = String(n || '/app'); return n.startsWith('/') && !n.startsWith('//') ? n.slice(0, 400) : '/app'; };
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i;
const normEmail = (e) => String(e || '').trim().toLowerCase();
const newId = () => 'u_' + b64u(rand(12));

function githubConfigured(cfg) { return !!(cfg && cfg.github && cfg.github.clientId && cfg.github.clientSecret && cfg.secret); }
function emailConfigured(cfg) { return !!(cfg && cfg.email && (cfg.email.send || cfg.email.dev)); }

// ---------- sessions ----------
async function makeSession(cfg, user) {
  const body = b64u(enc(JSON.stringify({ uid: user.id, exp: Date.now() + SESSION_DAYS * 86400000 })));
  return `${body}.${await hmac(cfg.secret, body)}`;
}
// the signed-in account (or null). Sessions from before accounts carried only a GitHub login.
async function sessionUser(cfg, cookieHeader) {
  if (!cfg || !cfg.secret || !cfg.store) return null;
  const raw = cookies(cookieHeader)[COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [body, sig] = raw.split('.');
  if (!same(sig, await hmac(cfg.secret, body))) return null;
  let s;
  try { s = JSON.parse(new TextDecoder().decode(unb64u(body))); } catch { return null; }
  if (!s || !(s.exp > Date.now())) return null;
  if (s.uid) return getUser(cfg, s.uid);
  if (s.login) {
    const idx = await cfg.store.get('gh:' + s.login.toLowerCase());
    if (idx && idx.user) return getUser(cfg, idx.user);
    return upsertGithub(cfg, { login: s.login, id: s.id, name: s.name }, null);
  }
  return null;
}
async function getUser(cfg, id) {
  const u = await cfg.store.get('user:' + id);
  return u && u.id ? u : null;
}
async function saveUser(cfg, u) { u.updated = Date.now(); await cfg.store.put('user:' + u.id, u); return u; }
function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email || null, github: u.github ? u.github.login : null, name: u.name || (u.github && u.github.name) || null,
    login: u.github ? u.github.login : null, repoAccess: !!u.githubToken && /\brepo\b/.test(u.githubScope || ''), prefs: u.prefs || {}, created: u.created };
}

// a GitHub login becomes an account, or joins the one that's signed in (linking)
async function upsertGithub(cfg, gh, token, scope, current) {
  const key = 'gh:' + gh.login.toLowerCase();
  const idx = await cfg.store.get(key);
  let u = idx && idx.user ? await getUser(cfg, idx.user) : null;
  if (current && u && u.id !== current.id) {
    // signed in as one account and linking a GitHub login another account already has: keep them apart
    throw Object.assign(new Error(`the GitHub account ${gh.login} already belongs to another huddle account; sign in with it, or unlink it there first`), { code: 409 });
  }
  if (!u) u = current || { id: newId(), created: Date.now(), projects: {} };
  u.github = { login: gh.login, id: gh.id, name: gh.name || null };
  if (!u.name && gh.name) u.name = gh.name;
  if (token) { u.githubToken = token; u.githubScope = scope || ''; }
  if (!u.email && gh.email && EMAIL.test(gh.email)) {
    const other = await cfg.store.get('email:' + normEmail(gh.email));
    if (!other || !other.user || other.user === u.id) { u.email = normEmail(gh.email); await cfg.store.put('email:' + u.email, { user: u.id }); }
  }
  await saveUser(cfg, u);
  await cfg.store.put(key, { user: u.id });
  return u;
}

// ---------- email codes ----------
async function startEmail(cfg, origin, body) {
  if (!emailConfigured(cfg)) return fail(501, 'email sign-in is not set up on this server');
  const email = normEmail(body.email);
  if (!EMAIL.test(email)) return fail(400, "that doesn't look like an email address");
  const key = 'code:' + email;
  const prev = (await cfg.store.get(key)) || {};
  const sent = (prev.sent || []).filter(t => Date.now() - t < 3600 * 1000);
  if (sent.length >= CODES_PER_HOUR) return fail(429, 'too many sign-in emails for this address; try again in an hour');
  const code = String(100000 + (new DataView(rand(4).buffer).getUint32(0) % 900000));
  const link = b64u(rand(24));
  const next = safeNext(body.next);
  await cfg.store.put(key, { code: await digest(email + ':' + code), link: await digest(email + ':' + link), exp: Date.now() + CODE_MINUTES * 60000, tries: 0, sent: [...sent, Date.now()], next });
  const url = `${origin}/auth/email/verify?e=${encodeURIComponent(email)}&t=${link}&next=${encodeURIComponent(next)}`;
  const brand = cfg.brand || 'huddle';
  const text = `Your ${brand} sign-in code is ${code}\n\nOr open this link to sign in:\n${url}\n\nIt works for ${CODE_MINUTES} minutes. If you didn't ask for it, ignore this email.`;
  const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#24211c;max-width:480px"><p>Your ${brand} sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px;margin:8px 0 16px">${code}</p><p><a href="${url}" style="background:#2f5d62;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-weight:600">Sign in to ${brand}</a></p><p style="color:#8a857b;font-size:13px">The code and link work for ${CODE_MINUTES} minutes. If you didn't ask for this, ignore it.</p></div>`;
  if (cfg.email.send) {
    try { await cfg.email.send({ to: email, subject: `${code} is your ${brand} sign-in code`, text, html }); }
    catch (e) { return fail(502, "couldn't send the email: " + e.message); }
  }
  // with no mail provider (local development), the server hands the link back instead
  return json({ ok: true, sent: !!cfg.email.send, ...(cfg.email.dev ? { dev: { code, url } } : {}) });
}
async function checkEmail(cfg, email, what, value) {
  email = normEmail(email);
  const key = 'code:' + email;
  const rec = await cfg.store.get(key);
  if (!rec || !rec.exp || rec.exp < Date.now()) return { error: 'that code has expired; ask for a new one' };
  if (rec.tries >= 6) return { error: 'too many wrong codes; ask for a new one' };
  if (!same(rec[what], await digest(email + ':' + String(value || '').trim()))) {
    rec.tries = (rec.tries || 0) + 1;
    await cfg.store.put(key, rec);
    return { error: what === 'code' ? "that code isn't right" : 'that sign-in link is no longer valid; ask for a new one' };
  }
  await cfg.store.put(key, { sent: rec.sent });
  return { email, next: rec.next };
}
async function userForEmail(cfg, email, current) {
  const idx = await cfg.store.get('email:' + email);
  let u = idx && idx.user ? await getUser(cfg, idx.user) : null;
  if (current && u && u.id !== current.id) throw Object.assign(new Error(`${email} already belongs to another account`), { code: 409 });
  if (!u) {
    u = current || { id: newId(), created: Date.now(), projects: {} };
    if (u.email && u.email !== email) await cfg.store.del('email:' + u.email);
    u.email = email;
    await saveUser(cfg, u);
    await cfg.store.put('email:' + email, { user: u.id });
  }
  return u;
}

// ---------- GitHub OAuth ----------
async function githubLogin(cfg, origin, url) {
  if (!githubConfigured(cfg)) return { status: 501, headers: { 'content-type': 'text/plain' }, body: 'GitHub sign-in is not set up on this server.' };
  const next = safeNext(url.searchParams.get('next'));
  // "repo" when someone connects a repository: lets the server read branches, pull requests and checks
  const scope = url.searchParams.get('scope') === 'repo' ? 'read:user user:email repo admin:repo_hook' : 'read:user user:email';
  const state = `${b64u(rand(16))}.${b64u(enc(next))}`;
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', cfg.github.clientId);
  u.searchParams.set('redirect_uri', origin + '/auth/github/callback');
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  return { status: 302, headers: { location: u.toString(), 'set-cookie': cookie(STATE_COOKIE, state, 600, origin.startsWith('https:')) }, body: '' };
}
async function githubCallback(cfg, origin, url, cookieHeader) {
  const bad = (msg) => ({ status: 400, headers: { 'content-type': 'text/plain' }, body: `GitHub sign-in failed: ${msg}` });
  if (!githubConfigured(cfg)) return bad('not set up on this server');
  const state = url.searchParams.get('state') || '';
  if (!state || state !== cookies(cookieHeader)[STATE_COOKIE]) return bad('the sign-in link expired; try again');
  const tok = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.github.clientId, client_secret: cfg.github.clientSecret, code: url.searchParams.get('code'), redirect_uri: origin + '/auth/github/callback' }),
  }).then(r => r.json()).catch(() => ({}));
  if (!tok.access_token) return bad(tok.error_description || 'GitHub did not accept the sign-in');
  const h = { authorization: `Bearer ${tok.access_token}`, 'user-agent': 'huddle', accept: 'application/vnd.github+json' };
  const gh = await fetch('https://api.github.com/user', { headers: h }).then(r => r.json()).catch(() => ({}));
  if (!gh.login) return bad('could not read your GitHub account');
  if (!gh.email) {
    const emails = await fetch('https://api.github.com/user/emails', { headers: h }).then(r => r.ok ? r.json() : []).catch(() => []);
    const primary = Array.isArray(emails) && emails.find(e => e.primary && e.verified);
    if (primary) gh.email = primary.email;
  }
  let next = '/app';
  try { next = safeNext(new TextDecoder().decode(unb64u(state.split('.')[1]))); } catch {}
  const current = await sessionUser(cfg, cookieHeader);
  let u;
  try { u = await upsertGithub(cfg, gh, tok.access_token, tok.scope, current); }
  catch (e) { return bad(e.message); }
  const secure = origin.startsWith('https:');
  return { status: 302, headers: { location: next, 'set-cookie': [cookie(COOKIE, await makeSession(cfg, u), SESSION_DAYS * 86400, secure), cookie(STATE_COOKIE, '', 0, secure)] }, body: '' };
}

// ---------- the routes: /auth/* and /api/me/* ----------
// req: { method, url (URL), cookie, body (parsed JSON or {}) }. Returns null when the path isn't ours.
async function handle(cfg, origin, req) {
  const p = req.url.pathname;
  const secure = origin.startsWith('https:');
  const signIn = async (u, location) => {
    const c = cookie(COOKIE, await makeSession(cfg, u), SESSION_DAYS * 86400, secure);
    return location ? redirect(location, c) : json({ ok: true, user: publicUser(u) }, 200, { 'set-cookie': c });
  };
  if (p === '/auth/github/login') return githubLogin(cfg, origin, req.url);
  if (p === '/auth/github/callback') return githubCallback(cfg, origin, req.url, req.cookie);
  if (p === '/auth/logout') return redirect('/', cookie(COOKIE, '', 0, secure));
  if (p === '/auth/me') {
    return json({ github: githubConfigured(cfg), email: emailConfigured(cfg), user: publicUser(await sessionUser(cfg, req.cookie).catch(() => null)) });
  }
  if (p === '/auth/email/start' && req.method === 'POST') return startEmail(cfg, origin, req.body || {});
  if (p === '/auth/email/code' && req.method === 'POST') {
    const r = await checkEmail(cfg, req.body.email, 'code', req.body.code);
    if (r.error) return fail(400, r.error);
    try { return signIn(await userForEmail(cfg, r.email, await sessionUser(cfg, req.cookie))); } catch (e) { return fail(e.code || 400, e.message); }
  }
  if (p === '/auth/email/verify') {
    const r = await checkEmail(cfg, req.url.searchParams.get('e'), 'link', req.url.searchParams.get('t'));
    if (r.error) return { status: 400, headers: { 'content-type': 'text/plain' }, body: r.error };
    try { return signIn(await userForEmail(cfg, r.email, await sessionUser(cfg, req.cookie)), safeNext(req.url.searchParams.get('next') || r.next)); }
    catch (e) { return { status: e.code || 400, headers: { 'content-type': 'text/plain' }, body: e.message }; }
  }
  if (!p.startsWith('/api/me')) return null;
  const u = await sessionUser(cfg, req.cookie);
  if (!u) return fail(401, 'sign in first');
  u.projects = u.projects || {};
  // the projects this account has opened, with the credential for each
  if (p === '/api/me/projects' && req.method === 'GET') {
    return json({ user: publicUser(u), projects: Object.entries(u.projects).map(([project, x]) => ({ project, token: x.token, name: x.name || null, at: x.at || 0 })) });
  }
  if (p === '/api/me/projects' && req.method === 'POST') {
    const add = Array.isArray(req.body.projects) ? req.body.projects : [req.body];
    for (const x of add.slice(0, 50)) {
      const project = String(x.project || '');
      if (!/^[\w.-]{1,64}$/.test(project) || !x.token || String(x.token).length > 200) continue;
      u.projects[project] = { token: String(x.token), name: x.name ? String(x.name).slice(0, 40) : (u.projects[project] || {}).name || null, at: Date.now() };
    }
    const keys = Object.keys(u.projects);
    if (keys.length > MAX_PROJECTS) for (const k of keys.sort((a, b) => u.projects[a].at - u.projects[b].at).slice(0, keys.length - MAX_PROJECTS)) delete u.projects[k];
    await saveUser(cfg, u);
    return json({ ok: true, count: Object.keys(u.projects).length });
  }
  if (p === '/api/me/forget-project' && req.method === 'POST') {
    delete u.projects[String(req.body.project || '')];
    await saveUser(cfg, u);
    return json({ ok: true });
  }
  if (p === '/api/me/profile' && req.method === 'POST') {
    if (req.body.name !== undefined) u.name = String(req.body.name || '').replace(/[<>\n\r\t]+/g, ' ').trim().slice(0, 60) || null;
    if (req.body.prefs && typeof req.body.prefs === 'object') {
      u.prefs = { ...(u.prefs || {}) };
      for (const k of ['emailNotes', 'digest']) if (req.body.prefs[k] !== undefined) u.prefs[k] = k === 'digest' ? (['off', 'daily'].includes(req.body.prefs[k]) ? req.body.prefs[k] : 'off') : !!req.body.prefs[k];
    }
    await saveUser(cfg, u);
    return json({ ok: true, user: publicUser(u) });
  }
  if (p === '/api/me/unlink-github' && req.method === 'POST') {
    if (!u.email) return fail(409, 'add an email first, so you can still sign in');
    if (u.github) await cfg.store.del('gh:' + u.github.login.toLowerCase());
    delete u.github; delete u.githubToken; delete u.githubScope;
    await saveUser(cfg, u);
    return json({ ok: true, user: publicUser(u) });
  }
  // everything the account holds, as a file
  if (p === '/api/me/export') {
    const { githubToken, ...rest } = u;
    return { status: 200, headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="huddle-account.json"' },
      body: JSON.stringify({ exported: new Date().toISOString(), account: { ...rest, projects: Object.keys(u.projects) } }, null, 2) };
  }
  // the account and its sign-ins go; projects keep the work people did in them
  if (p === '/api/me/delete' && req.method === 'POST') {
    if (u.email) await cfg.store.del('email:' + u.email);
    if (u.github) await cfg.store.del('gh:' + u.github.login.toLowerCase());
    await cfg.store.del('user:' + u.id);
    return json({ ok: true }, 200, { 'set-cookie': cookie(COOKIE, '', 0, secure) });
  }
  return fail(404, 'not found');
}

// what a project needs to know about the signed-in person: who they are, for matching members
function credOf(u) {
  return u ? { user: u.id, email: u.email || null, github: u.github ? u.github.login : null, githubToken: u.githubToken || null } : null;
}

// Mail through Resend (RESEND_API_KEY) or any webhook that takes { to, subject, text, html }.
function mailer({ resendKey, webhook, from }) {
  if (resendKey) {
    return async (m) => {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${resendKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: from || 'huddle <onboarding@resend.dev>', to: [m.to], subject: m.subject, text: m.text, html: m.html }) });
      if (!r.ok) throw new Error(`the mail service said ${r.status}: ${(await r.text()).slice(0, 200)}`);
    };
  }
  if (webhook) {
    return async (m) => {
      const r = await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, ...m }) });
      if (!r.ok) throw new Error(`the mail webhook said ${r.status}`);
    };
  }
  return null;
}

module.exports = { handle, sessionUser, credOf, publicUser, mailer, cookies, githubConfigured, emailConfigured, getUser, saveUser, COOKIE };

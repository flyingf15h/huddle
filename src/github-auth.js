// Sign in with GitHub for the dashboard, shared by the Cloudflare Worker and the Node server. Only
// web-standard APIs (fetch, WebCrypto), so it runs in both. A session is a signed cookie holding the
// GitHub login; projects let a signed-in person in when that login is one of their members.
'use strict';

const subtle = (globalThis.crypto && globalThis.crypto.subtle) || require('crypto').webcrypto.subtle;
const COOKIE = 'huddle_s';
const STATE_COOKIE = 'huddle_gh_state';
const SESSION_DAYS = 30;

const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function sign(secret, text) {
  const key = await subtle.importKey('raw', new TextEncoder().encode('gh-session:' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}
function same(a, b) {
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

function configured(cfg) { return !!(cfg && cfg.clientId && cfg.clientSecret && cfg.secret); }

// the signed-in GitHub account, or null
async function session(cfg, cookieHeader) {
  if (!configured(cfg)) return null;
  const raw = cookies(cookieHeader)[COOKIE];
  if (!raw || !raw.includes('.')) return null;
  const [body, sig] = raw.split('.');
  if (!same(sig, await sign(cfg.secret, body))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return s.exp > Date.now() ? { login: s.login, id: s.id, name: s.name || null } : null;
  } catch { return null; }
}

// a plain answer the server turns into its own response type: { status, headers, body }
async function login(cfg, origin, next) {
  if (!configured(cfg)) return { status: 501, headers: { 'content-type': 'text/plain' }, body: 'GitHub sign-in is not set up on this server.' };
  const nonce = b64u(globalThis.crypto ? globalThis.crypto.getRandomValues(new Uint8Array(16)) : require('crypto').randomBytes(16));
  const state = `${nonce}.${b64u(new TextEncoder().encode(String(next || '/app').slice(0, 300)))}`;
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('redirect_uri', origin + '/auth/github/callback');
  u.searchParams.set('scope', 'read:user');
  u.searchParams.set('state', state);
  return { status: 302, headers: { location: u.toString(), 'set-cookie': cookie(STATE_COOKIE, state, 600, origin.startsWith('https:')) }, body: '' };
}

async function callback(cfg, origin, url, cookieHeader) {
  const fail = (msg) => ({ status: 400, headers: { 'content-type': 'text/plain' }, body: `GitHub sign-in failed: ${msg}` });
  if (!configured(cfg)) return fail('not set up on this server');
  const state = url.searchParams.get('state') || '';
  if (!state || state !== cookies(cookieHeader)[STATE_COOKIE]) return fail('the sign-in link expired; try again');
  const tok = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code: url.searchParams.get('code'), redirect_uri: origin + '/auth/github/callback' }),
  }).then(r => r.json()).catch(() => ({}));
  if (!tok.access_token) return fail(tok.error_description || 'GitHub did not accept the sign-in');
  const user = await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${tok.access_token}`, 'user-agent': 'huddle', accept: 'application/vnd.github+json' } }).then(r => r.json()).catch(() => ({}));
  if (!user.login) return fail('could not read your GitHub account');
  const body = b64u(new TextEncoder().encode(JSON.stringify({ login: user.login, id: user.id, name: user.name || null, exp: Date.now() + SESSION_DAYS * 86400000 })));
  let next = '/';
  try { next = new TextDecoder().decode(unb64u(state.split('.')[1])); } catch {}
  if (!next.startsWith('/') || next.startsWith('//')) next = '/';
  const secure = origin.startsWith('https:');
  return { status: 302, headers: { location: next, 'set-cookie': [cookie(COOKIE, `${body}.${await sign(cfg.secret, body)}`, SESSION_DAYS * 86400, secure), cookie(STATE_COOKIE, '', 0, secure)] }, body: '' };
}

function logout(origin) {
  return { status: 302, headers: { location: '/', 'set-cookie': cookie(COOKIE, '', 0, origin.startsWith('https:')) }, body: '' };
}

module.exports = { configured, session, login, callback, logout, cookies };

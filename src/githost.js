// A project's real repository on GitHub: branches, pull requests, checks and issues, read with the
// token of whoever connected it, and pushed to the server by a webhook when GitHub allows one.
// fetch and WebCrypto only, so it runs in the Worker and on Node alike.
'use strict';

const subtle = (globalThis.crypto && globalThis.crypto.subtle) || require('crypto').webcrypto.subtle;
const API = 'https://api.github.com';
const REPO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

// "owner/name" from what someone typed: a URL, an SSH remote or the short form
function parseRepo(text) {
  let t = String(text || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
  t = t.replace(/^git@github\.com:/, '').replace(/^(https?:\/\/)?(www\.)?github\.com\//, '');
  const m = REPO.exec(t.split('/').slice(0, 2).join('/'));
  return m ? { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` } : null;
}

async function gh(token, method, path, body) {
  const r = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'huddle', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && data.message) || `HTTP ${r.status}`;
    throw Object.assign(new Error(r.status === 404 ? `GitHub says that repository doesn't exist or the token can't see it (${msg})` : r.status === 401 ? 'GitHub did not accept the token' : `GitHub: ${msg}`), { status: r.status, code: r.status === 401 || r.status === 404 ? 400 : 502 });
  }
  return data;
}

async function repoInfo(token, full) {
  const r = await gh(token, 'GET', `/repos/${full}`);
  return { full: r.full_name, url: r.html_url, defaultBranch: r.default_branch, private: !!r.private, admin: !!(r.permissions && r.permissions.admin), push: !!(r.permissions && r.permissions.push) };
}

// what the dashboard shows: branches with their newest commit and check status, open pull requests,
// recent commits on the default branch and open issues
async function overview(token, full, defaultBranch) {
  const [branches, pulls, commits, issues] = await Promise.all([
    gh(token, 'GET', `/repos/${full}/branches?per_page=30`).catch(() => []),
    gh(token, 'GET', `/repos/${full}/pulls?state=open&per_page=20&sort=updated&direction=desc`).catch(() => []),
    gh(token, 'GET', `/repos/${full}/commits?per_page=15${defaultBranch ? '&sha=' + encodeURIComponent(defaultBranch) : ''}`).catch(() => []),
    gh(token, 'GET', `/repos/${full}/issues?state=open&per_page=20&sort=updated`).catch(() => []),
  ]);
  const status = async (sha) => {
    const s = await gh(token, 'GET', `/repos/${full}/commits/${sha}/check-runs?per_page=50`).catch(() => null);
    return s ? summarizeChecks(s.check_runs || []) : null;
  };
  const prs = (pulls || []).map(p => ({ number: p.number, title: p.title, url: p.html_url, head: p.head && p.head.ref, base: p.base && p.base.ref, sha: p.head && p.head.sha,
    author: p.user && p.user.login, draft: !!p.draft, updated: Date.parse(p.updated_at) || 0 }));
  // checks for the open pull requests and the default branch (a few requests, not one per branch)
  for (const p of prs.slice(0, 8)) p.checks = await status(p.sha);
  const def = (branches || []).find(b => b.name === defaultBranch);
  return {
    branches: (branches || []).map(b => ({ name: b.name, sha: b.commit && b.commit.sha, protected: !!b.protected })),
    defaultChecks: def ? await status(def.commit.sha) : null,
    pulls: prs,
    commits: (commits || []).map(c => ({ sha: c.sha, message: String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 200), author: (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || '', at: Date.parse(c.commit && c.commit.author && c.commit.author.date) || 0, url: c.html_url })),
    issues: (issues || []).filter(i => !i.pull_request).map(i => ({ number: i.number, title: i.title, url: i.html_url, author: i.user && i.user.login, labels: (i.labels || []).map(l => l.name).slice(0, 5), body: String(i.body || '').slice(0, 4000), updated: Date.parse(i.updated_at) || 0 })),
    at: Date.now(),
  };
}

// "passing", "failing", "running" or null, from a list of check runs
function summarizeChecks(runs) {
  if (!runs.length) return null;
  if (runs.some(r => r.status !== 'completed')) return { state: 'running', total: runs.length, failed: runs.filter(r => ['failure', 'timed_out', 'cancelled'].includes(r.conclusion)).length };
  const failed = runs.filter(r => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion));
  return { state: failed.length ? 'failing' : 'passing', total: runs.length, failed: failed.length, names: failed.slice(0, 5).map(r => r.name) };
}

async function createPull(token, full, { head, base, title, body, draft }) {
  const p = await gh(token, 'POST', `/repos/${full}/pulls`, { head, base, title: String(title).slice(0, 250), body: String(body || '').slice(0, 60000), draft: !!draft });
  return { number: p.number, url: p.html_url, state: p.state };
}

const WEBHOOK_EVENTS = ['push', 'pull_request', 'check_suite', 'check_run', 'issues', 'issue_comment'];
async function createWebhook(token, full, url, secret) {
  const h = await gh(token, 'POST', `/repos/${full}/hooks`, { name: 'web', active: true, events: WEBHOOK_EVENTS, config: { url, content_type: 'json', secret, insecure_ssl: '0' } });
  return h.id;
}
async function deleteWebhook(token, full, id) { await gh(token, 'DELETE', `/repos/${full}/hooks/${id}`).catch(() => {}); }

// X-Hub-Signature-256: "sha256=<hex hmac of the raw body>"
async function verifySignature(secret, raw, header) {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const key = await subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const hex = [...sig].map(b => b.toString(16).padStart(2, '0')).join('');
  const given = header.slice(7);
  if (given.length !== hex.length) return false;
  let d = 0;
  for (let i = 0; i < hex.length; i++) d |= hex.charCodeAt(i) ^ given.charCodeAt(i);
  return d === 0;
}

module.exports = { parseRepo, repoInfo, overview, summarizeChecks, createPull, createWebhook, deleteWebhook, verifySignature, WEBHOOK_EVENTS };

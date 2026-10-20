// Sign-in with email, notifications, search, costs, task editing, data controls and merge conflicts,
// against a real Node server.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const pricing = require('../src/pricing');
const githost = require('../src/githost');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'huddle-prod-'));
const ok = (m) => console.log('✓ ' + m);

(async () => {
  // pricing and parsing first: no server needed
  assert.strictEqual(pricing.canonical('claude-sonnet-4-5-20250929'), 'claude-sonnet-4-5');
  assert.strictEqual(pricing.canonical('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.ok(Math.abs(pricing.costOf('claude-opus-5-5', { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }) - (4 + 20 + 0.2 + 5)) < 1e-9);
  assert.strictEqual(pricing.costOf('gpt-5.5-codex', { input: 1e6 }), null);
  assert.strictEqual(pricing.costOf('gpt-5.5-codex', { input: 1e6, output: 0 }, { 'gpt-5.5-codex': [1.5, 12] }), 1.5);
  assert.deepStrictEqual(githost.parseRepo('git@github.com:acme/shop.git'), { owner: 'acme', name: 'shop', full: 'acme/shop' });
  assert.strictEqual(githost.parseRepo('https://github.com/acme/shop/pull/3').full, 'acme/shop');
  assert.strictEqual(githost.parseRepo('not a repo'), null);
  const crypto = require('crypto');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update('{"a":1}').digest('hex');
  assert.ok(await githost.verifySignature('s3cret', '{"a":1}', sig));
  assert.ok(!(await githost.verifySignature('s3cret', '{"a":2}', sig)));
  ok('prices per model (with an owner\'s own for unknown models), repository names and webhook signatures');

  const mail = [];
  const mailSrv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { mail.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise(r => mailSrv.listen(0, '127.0.0.1', r));
  const proc = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))}).createServer({ dataDir: ${JSON.stringify(tmp)}, token: 'admin-secret', open: true, emailDev: true, emailWebhook: 'http://127.0.0.1:${mailSrv.address().port}/mail' });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, HUDDLE_MAIL_BATCH_MS: '300', HUDDLE_SWEEP_MS: '400' } });
  const port = await new Promise(r => proc.stdout.once('data', d => r(String(d).trim())));
  const base = `http://127.0.0.1:${port}`;
  const jar = {};
  const web = async (who, method, url, body) => {
    const res = await fetch(base + url, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(jar[who] ? { cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) jar[who] = set.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  };
  const agent = (name, kind = 'agent') => ({ id: name + '#t' + kind, name, host: 'test', kind });

  try {
    // ---------- email sign-in ----------
    assert.ok((await web('ana', 'GET', '/auth/me')).email);
    assert.strictEqual((await web('ana', 'POST', '/auth/email/start', { email: 'nope' })).status, 400);
    const start = await web('ana', 'POST', '/auth/email/start', { email: 'Ana@Example.com', next: '/app' });
    assert.ok(start.ok && /^\d{6}$/.test(start.dev.code));
    assert.strictEqual((await web('ana', 'POST', '/auth/email/code', { email: 'ana@example.com', code: '000000' === start.dev.code ? '111111' : '000000' })).status, 400);
    const signed = await web('ana', 'POST', '/auth/email/code', { email: 'ana@example.com', code: start.dev.code });
    assert.strictEqual(signed.user.email, 'ana@example.com');
    assert.strictEqual((await web('ana', 'GET', '/auth/me')).user.email, 'ana@example.com');
    // the link in the email works too, once
    const s2 = await web('bob', 'POST', '/auth/email/start', { email: 'bob@example.com' });
    const link = new URL(s2.dev.url);
    const v = await fetch(base + link.pathname + link.search, { redirect: 'manual' });
    assert.strictEqual(v.status, 302);
    jar.bob = v.headers.get('set-cookie').split(';')[0];
    assert.strictEqual((await fetch(base + link.pathname + link.search, { redirect: 'manual' })).status, 400);
    assert.strictEqual((await web('bob', 'GET', '/auth/me')).user.email, 'bob@example.com');
    ok('email sign-in with a code or the emailed link, once, with wrong codes refused');

    // ---------- a project, carried by the account ----------
    const made = await (await fetch(`${base}/api/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'prod' }) })).json();
    const P = made.project, T = made.token;
    await web('ana', 'POST', '/api/me/projects', { project: P, token: T, name: 'ana' });
    const mine = await web('ana', 'GET', '/api/me/projects');
    assert.deepStrictEqual(mine.projects.map(x => [x.project, x.token]), [[P, T]]);
    assert.strictEqual((await web('nobody', 'GET', '/api/me/projects')).status, 401);
    const call = async (who, method, ep, body, token = T) => {
      const res = await fetch(`${base}/api/p/${P}/${ep}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...(jar[who] ? { cookie: jar[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, ...(await res.json().catch(() => ({}))) };
    };
    const as = (name, kind) => (method, ep, body, token) => call(name, method, ep, body ? { agent: agent(name, kind), ...body } : undefined, token);
    const ana = as('ana'), bob = as('bob'), anaWeb = as('ana', 'human');
    await ana('POST', 'hello', { tool: 'claude' });
    await bob('POST', 'hello', { tool: 'cursor' });
    assert.strictEqual((await ana('GET', 'state')).settings.bob.tool, 'cursor');
    // accounts: ana owns it, bob gets a personal invite; an account then opens it with no token at all
    const own = await ana('POST', 'setup-owner', {});
    const inv = await call(null, 'POST', 'member-invite', { agent: agent('ana'), role: 'member' }, own.token);
    const bobTok = (await call(null, 'POST', 'redeem', { code: inv.code, name: 'bob' }, null)).token;
    assert.ok((await call('bob', 'POST', 'link-account', { agent: agent('bob') }, bobTok)).email === 'bob@example.com');
    assert.strictEqual((await call('bob', 'GET', 'whoami', null, null)).name, 'bob');
    assert.strictEqual((await call('nobody', 'GET', 'whoami', null, null)).status, 401);
    await call('ana', 'POST', 'link-account', { agent: agent('ana') }, own.token);
    ok('an account keeps its projects and their credentials, and a linked account opens a project by itself');

    // ---------- notifications ----------
    const A = own.token;
    await call(null, 'POST', 'goal', { agent: agent('ana'), text: 'Add Apple Pay to checkout', to: 'bob' }, A);
    await call(null, 'POST', 'message', { agent: agent('ana'), text: 'can you look at the cart test, @bob?' }, A);
    await call(null, 'POST', 'message', { agent: agent('ana'), to: 'bob', text: 'and the README' }, A);
    let notes = (await call(null, 'GET', 'notes', null, bobTok)).notes;
    assert.deepStrictEqual(notes.map(n => n.kind), ['request', 'mention', 'message']);
    assert.ok(!(await call(null, 'GET', 'notes', null, A)).notes.length);
    const board = await call(null, 'GET', 'board', null, A);
    const tid = board.tasks[0].id;
    await call(null, 'POST', 'approval-request', { agent: agent('bob'), taskId: tid, commands: [{ command: 'npm run deploy' }] }, bobTok);
    await call(null, 'POST', 'task-update', { agent: agent('bob'), id: tid, status: 'blocked', note: 'needs the Apple login' }, bobTok);
    notes = (await call(null, 'GET', 'notes', null, bobTok)).notes;
    assert.ok(['approval', 'stuck'].every(k => notes.some(n => n.kind === k)));
    assert.ok((await call(null, 'GET', 'notes', null, A)).notes.some(n => n.kind === 'stuck'), 'whoever asked hears it got stuck');
    await call(null, 'POST', 'notes-read', { agent: agent('bob'), ids: [notes[0].id] }, bobTok);
    assert.ok((await call(null, 'GET', 'notes', null, bobTok)).notes[0].read);
    const prefs = await call(null, 'POST', 'note-prefs', { agent: agent('bob'), prefs: { message: { email: true }, stuck: { email: false } } }, bobTok);
    assert.deepStrictEqual([prefs.prefs.message.email, prefs.prefs.stuck.email], [true, false]);
    // bob's unread request, mention and approval went out as one email
    const until = Date.now() + 6000;
    while (!mail.some(m => m.to === 'bob@example.com' && !/sign-in/.test(m.subject)) && Date.now() < until) await new Promise(r => setTimeout(r, 100));
    const bobMail = mail.filter(m => m.to === 'bob@example.com' && !/sign-in/.test(m.subject));
    assert.strictEqual(bobMail.length, 1, JSON.stringify(mail.map(m => m.subject)));
    assert.ok(/things need you/.test(bobMail[0].subject) && /Apple Pay/.test(bobMail[0].text) && !/README/.test(bobMail[0].text), bobMail[0].text);
    ok('requests, mentions, messages, approvals and stuck work reach the right person, can be read, and arrive as one email');

    // ---------- tasks ----------
    const e = await call(null, 'POST', 'task-edit', { agent: agent('ana', 'human'), id: tid, title: 'Apple Pay button', status: 'todo', effort: 'heavy' }, A);
    assert.deepStrictEqual([e.task.title, e.task.status, e.task.effort], ['Apple Pay button', 'todo', 'heavy']);
    await call(null, 'POST', 'task-comment', { agent: agent('ana'), id: tid, text: 'use the sandbox merchant id' }, A);
    assert.ok((await call(null, 'GET', 'board', null, A)).tasks[0].notes.some(n => n.comment && /sandbox/.test(n.text)));
    const extra = await call(null, 'POST', 'task', { agent: agent('bob'), title: 'Tidy imports' }, bobTok);
    assert.strictEqual((await call(null, 'POST', 'task-delete', { agent: agent('bob'), id: tid }, bobTok)).status, 403);
    assert.ok((await call(null, 'POST', 'task-delete', { agent: agent('bob'), id: extra.task.id }, bobTok)).ok);
    ok('tasks can be renamed, moved, sized, commented on and deleted by whoever asked for them');

    // ---------- costs ----------
    await call(null, 'POST', 'cost-settings', { agent: agent('ana'), budget: { monthly: 10, alertPct: 50 }, prices: { 'gpt-5.5-codex': [1.25, 10] } }, A);
    await call(null, 'POST', 'stats', { agent: agent('bob'), conversation: true, turns: 1, activeMs: 60000, task: tid,
      usage: { 'claude-opus-5-5': { input: 1e6, output: 1e5, cacheRead: 0, cacheWrite: 0, messages: 3 }, 'gpt-5.5-codex': { input: 2e6, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1 } } }, bobTok);
    const c = await call(null, 'GET', 'costs', null, A);
    assert.ok(Math.abs(c.people.bob.cost - (4 + 2 + 2.5)) < 1e-6, JSON.stringify(c.people.bob));
    assert.ok(Math.abs(c.monthSpend - 8.5) < 1e-6);
    assert.ok(Math.abs(c.tasks[0].cost - 8.5) < 1e-6 && c.tasks[0].id === tid);
    assert.ok((await call(null, 'GET', 'notes', null, A)).notes.some(n => n.kind === 'budget'), 'owner warned at 50% of the budget');
    assert.strictEqual((await call(null, 'POST', 'cost-settings', { agent: agent('bob'), budget: null }, bobTok)).status, 403);
    ok('usage is priced per model, charged to its task, added up for the month, and owners hear when it passes the budget line');

    // ---------- search ----------
    await call(null, 'POST', 'memory', { agent: agent('ana'), title: 'Cents everywhere', text: 'Every amount in the payments API is in cents.' }, A);
    await call(null, 'POST', 'content', { agent: agent('bob'), path: 'src/pay.js', content: 'export const toCents = (d) => Math.round(d * 100);\n' }, bobTok);
    await call(null, 'POST', 'git-snapshot', { agent: agent('bob'), branch: 'main', sha: 'a'.repeat(40), i: 0, n: 1, files: [{ path: 'src/refund.js', content: 'line one\nrefund in cents here\n' }] }, bobTok);
    const sr = await call(null, 'GET', 'search?q=cents', null, A);
    const kinds = new Set(sr.results.map(x => x.kind));
    for (const k of ['memory', 'file', 'code']) assert.ok(kinds.has(k), `search finds ${k}: ${[...kinds]}`);
    assert.ok(sr.results.some(x => x.kind === 'code' && x.ref.path === 'src/refund.js' && x.ref.line === 2));
    assert.ok((await call(null, 'GET', 'search?q=apple%20pay&kinds=tasks', null, A)).results.every(x => ['task', 'request'].includes(x.kind)));
    ok('search finds tasks, memory, live files and the lines inside shared branches');

    // ---------- merge conflicts ----------
    await call(null, 'POST', 'conflicts', { agent: agent('bob'), branch: 'main', items: [{ other: 'ana/checkout', files: ['src/pay.js'] }] }, bobTok);
    const cf = await call(null, 'GET', 'conflicts', null, A);
    assert.strictEqual(cf.conflicts[0].items[0].files[0], 'src/pay.js');
    assert.ok((await call(null, 'GET', 'notes', null, A)).notes.some(n => n.kind === 'conflict'), 'the other side hears about it');
    const fix = await call(null, 'POST', 'resolve-conflicts', { agent: agent('ana'), key: 'bob/main', other: 'ana/checkout' }, A);
    assert.ok(fix.task.direct && fix.task.owner === 'bob' && /src\/pay\.js/.test(fix.task.detail));
    ok("conflicts between branches reach both people, and one click hands the merge to the branch owner's agent");

    // ---------- data ----------
    const ex = await call(null, 'GET', 'export', null, A);
    const flat = JSON.stringify(ex);
    assert.ok(ex.format === 'huddle-project-export' && ex.data.board.tasks.length);
    assert.ok(!/tokenHash|codeHash|secretHooks/.test(flat), 'no secrets in the export');
    assert.strictEqual((await call(null, 'GET', 'export', null, bobTok)).status, 403);
    await call(null, 'POST', 'activity', { agent: agent('bob'), items: [{ kind: 'prompt', text: 'my private-ish prompt' }] }, bobTok);
    const er = await call(null, 'POST', 'erase-me', { agent: agent('bob') }, bobTok);
    assert.ok(er.activity >= 1);
    const act = (await call(null, 'GET', 'activity', null, A)).activity;
    assert.ok(!act.some(a => a.name === 'bob'));
    assert.ok((await call(null, 'POST', 'retention', { agent: agent('ana'), activityDays: 30, messageDays: 90 }, A)).settings.retention.activityDays === 30);
    assert.strictEqual((await call(null, 'POST', 'delete-project', { agent: agent('ana'), confirm: 'wrong' }, A)).status, 400);
    assert.ok((await call(null, 'POST', 'delete-project', { agent: agent('ana'), confirm: 'prod' }, A)).ok);
    assert.strictEqual((await call(null, 'GET', 'state', null, T)).status, 401);
    // webhook for a project with no repository connected: refused
    assert.strictEqual((await fetch(`${base}/api/hooks/github/${P}`, { method: 'POST', body: '{}' })).status, 404);
    ok('owners export everything but secrets, set how long data is kept, and delete the project; anyone erases their own trail');

    // the account goes, and signs out
    assert.ok((await web('bob', 'POST', '/api/me/delete')).ok);
    assert.strictEqual((await web('bob', 'GET', '/auth/me')).user, null);
    ok('an account can be deleted');
    console.log('\nall good');
  } finally {
    proc.kill();
    mailSrv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });

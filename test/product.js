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

  // cost trends, in-process: a busy day, a month heading over budget, a task that costs far too much
  {
    const core = require('../src/core'), X = core.features;
    const day = (t) => new Date(t).toISOString().slice(0, 10);
    const P = new core.Project('unit-abc123');
    P.members = { ana: { role: 'owner', tokenHash: 'x' } };
    P.stats = { ana: { models: {}, days: {} } };
    for (let i = 1; i <= 6; i++) P.stats.ana.days[day(Date.now() - i * 864e5)] = { cost: 10 };
    P.board.tasks.push({ id: 'aa11bb22', title: 'Rework billing', owner: 'ana', status: 'doing' });
    const big = { 'claude-opus-5-5': { input: 6e6, output: 2e5, cacheRead: 0, cacheWrite: 0, messages: 4 } };   // $28
    X.chargeUsage(P, 'ana', big, 'aa11bb22');
    const kinds = () => (P.notes.ana || []).filter(n => n.kind === 'cost').map(n => n.title);
    assert.ok(kinds().includes('Agent usage is high today') && kinds().includes('A task is costing a lot'), kinds().join('|'));
    const n1 = kinds().length;
    X.chargeUsage(P, 'ana', big, 'aa11bb22');
    assert.strictEqual(kinds().length, n1, 'each alert fires once');
    const T = X.nextDigestAt ? null : null;
    P.projectSettings = { budget: { monthly: 20, alertPct: 80 }, costAlerts: { spike: false, task: false } };
    P.costAlerts = {};
    for (let i = 0; i < 4; i++) P.stats.ana.days[day(Date.now() - i * 864e5)] = { cost: 20 };
    if (new Date().getUTCDate() >= 6) { X.chargeUsage(P, 'ana', { 'claude-opus-5-5': { input: 1e6, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1 } }, null); assert.ok(kinds().includes('On course to go over budget')); }
    ok('cost alerts: a day far above the usual, a month on course to pass the budget, and a runaway task, each once');
  }

  // automations, in-process: GitHub starts requests from a label or "/huddle", and says so when they're done
  {
    const core = require('../src/core'), crypto = require('crypto');
    const P2 = new core.Project('unit-def456');
    P2.members = { ana: { role: 'owner', tokenHash: 'x', github: 'ana-gh' } };
    P2.projectSettings = { repo: { full: 'acme/shop' }, trigger: { github: true, label: 'huddle', to: null, ack: true } };
    P2.secretRepo = { token: 'tok', secret: 'sec' };
    const send = (event, body) => {
      const raw = JSON.stringify(body), sig = 'sha256=' + crypto.createHmac('sha256', 'sec').update(raw).digest('hex');
      return core.routes['POST github-webhook'](P2, body, new URLSearchParams(), { request: { raw, header: (k) => ({ 'x-hub-signature-256': sig, 'x-github-event': event })[k.toLowerCase()] } });
    };
    const issue = { number: 7, title: 'Login redirect loops', body: 'After signing in you bounce between /login and /app', html_url: 'https://github.com/acme/shop/issues/7' };
    await send('issues', { action: 'labeled', label: { name: 'bug' }, issue, sender: { login: 'zed' }, repository: { full_name: 'acme/shop' } });
    assert.strictEqual(P2.board.goals.length, 0, 'other labels do nothing');
    await send('issues', { action: 'labeled', label: { name: 'huddle' }, issue, sender: { login: 'zed' }, repository: { full_name: 'acme/shop' } });
    assert.strictEqual(P2.board.goals.length, 1);
    assert.deepStrictEqual([P2.board.goals[0].source.number, /Login redirect loops/.test(P2.board.goals[0].text)], [7, true]);
    assert.ok(P2.outbox.some(o => /issues\/7\/comments/.test(o.url) && /Picked up by huddle/.test(o.body.body) && o.headers.authorization === 'Bearer tok'));
    await send('issues', { action: 'labeled', label: { name: 'huddle' }, issue, sender: { login: 'zed' }, repository: { full_name: 'acme/shop' } });
    assert.strictEqual(P2.board.goals.length, 1, 'the same issue is not started twice while it is open');
    const cm = (assoc, body, n = 8) => send('issue_comment', { action: 'created', issue: { ...issue, number: n, pull_request: { url: 'x' } }, comment: { body, author_association: assoc, user: { login: 'ana-gh' } }, sender: { login: 'ana-gh' }, repository: { full_name: 'acme/shop' } });
    await cm('NONE', '/huddle drop the database');
    assert.strictEqual(P2.board.goals.length, 1, 'only collaborators can start things from a comment');
    await cm('MEMBER', 'looks good to me');
    assert.strictEqual(P2.board.goals.length, 1);
    await cm('MEMBER', '/huddle add a test for the redirect');
    assert.strictEqual(P2.board.goals.length, 2);
    assert.ok(/add a test for the redirect/.test(P2.board.goals[1].text) && P2.board.goals[1].source.isPr);
    // finishing the first one says so on the issue
    const task = core.routes['POST task'](P2, { agent: { id: 'a#1', name: 'ana', kind: 'agent' }, goalId: P2.board.goals[0].id, title: 'Fix the redirect', owner: 'ana' }).task;
    P2.outbox = [];
    core.routes['POST task-update'](P2, { agent: { id: 'a#1', name: 'ana', kind: 'agent' }, id: task.id, status: 'done', note: 'Cleared the stale cookie' });
    assert.ok(P2.outbox.some(o => /issues\/7\/comments/.test(o.url) && /^Done\./.test(o.body.body)));
    // a schedule starts a request, once a day, and not on top of an unfinished one
    const P3 = new core.Project('unit-sched01');
    P3.automations = [{ id: 's1', kind: 'schedule', name: 'Triage issues', text: 'Look at new issues and label them', hour: 0, tz: 'UTC', days: 'daily', enabled: true, lastDate: null, to: null }];
    core.features.maybeAutomations(P3);
    assert.strictEqual(P3.board.goals.length, 1);
    assert.strictEqual(P3.board.goals[0].automation, 's1');
    core.features.maybeAutomations(P3);
    assert.strictEqual(P3.board.goals.length, 1, 'once a day');
    P3.automations[0].lastDate = null;
    core.features.maybeAutomations(P3);
    assert.strictEqual(P3.board.goals.length, 1, 'not on top of an unfinished one');
    assert.ok(core.features.nextWakeAt(P3) > Date.now(), 'the Worker is woken for the next one');
    ok('GitHub starts requests from a label or a collaborator\'s /huddle comment and reports back; schedules start one a day without piling up');
  }

  // Slack, in-process: signed slash commands, linking a channel, mapping a person, buttons on approvals
  {
    const core = require('../src/core'), slack = require('../src/slack');
    const P4 = new core.Project('unit-slack1');
    P4.members = { ana: { role: 'owner', tokenHash: 'x' }, bo: { role: 'member', tokenHash: 'y' } };
    const secret = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    P4.secretSlack = { signingSecret: secret };
    const post = async (route, form) => {
      const raw = new URLSearchParams(form).toString(), ts = String(Math.floor(Date.now() / 1000)), sig = await slack.sign(secret, raw, ts);
      return core.routes[route](P4, {}, new URLSearchParams(), { request: { raw, header: (k) => ({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig })[k.toLowerCase()] } });
    };
    const cmd = (text, extra = {}) => post('POST slack-command', { team_id: 'T1', channel_id: 'C1', channel_name: 'dev', user_id: 'U1', user_name: 'zed', text, ...extra });
    await assert.rejects(core.routes['POST slack-command'](P4, {}, new URLSearchParams(), { request: { raw: 'text=hi', header: () => 'bad' } }), /signature|401/i);
    assert.match((await cmd('fix the cart')).text, /not linked/);
    const code = (await core.routes['POST slack-code'](P4, { agent: { id: 'ana#t', name: 'ana', host: 't', kind: 'human' }, kind: 'link' }, new URLSearchParams(), { auth: { role: 'owner', name: 'ana' } })).code;
    assert.match((await cmd('link WRONG')).text, /didn't work/);
    assert.match((await cmd('link ' + code)).text, /Linked/);
    assert.match((await cmd('link ' + code)).text, /didn't work/, 'a code works once');
    assert.match((await cmd('status', { channel_id: 'C9' })).text, /only works in the linked channel/);
    assert.match((await cmd('status')).text, /unit-slack1|0 in progress/);
    const r = await cmd('@bo fix the cart total');
    assert.match(r.text, /asked bo/);
    assert.strictEqual(P4.board.goals.length, 1);
    assert.strictEqual(P4.board.goals[0].to, 'bo');
    // approval buttons: only the person's mapped Slack account may press them
    P4.approvals = [{ id: 'ap1', owner: 'bo', command: 'npm test', status: 'waiting', taskId: null, at: Date.now() }];
    const press = (uid, action) => post('POST slack-interact', { payload: JSON.stringify({ user: { id: uid }, actions: [{ action_id: action, value: 'ap1' }], response_url: 'https://hooks.slack.com/actions/x' }) });
    await press('U1', 'approve');
    assert.strictEqual(P4.approvals[0].status, 'waiting', 'an unmapped Slack user cannot approve');
    const me = (await core.routes['POST slack-code'](P4, { agent: { id: 'bo#t', name: 'bo', host: 't', kind: 'human' }, kind: 'me' }, new URLSearchParams(), { auth: { role: 'member', name: 'bo' } })).code;
    assert.match((await cmd('iam ' + me, { user_id: 'U2', user_name: 'bo' })).text, /You're bo/);
    await press('U2', 'approve');
    assert.strictEqual(P4.approvals[0].status, 'approved');
    assert.ok(P4.outbox.some(o => /hooks\.slack\.com\/actions/.test(o.url)));
    assert.ok(slack.manifest('https://h.example', 'my-team').features.slash_commands[0].url.endsWith('/api/slack/my-team/command'));
    ok('Slack: signed /huddle commands, one-time link codes, status, requests to a person, and approval buttons only for the mapped person');
  }

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

    // ---------- conflict-aware planning ----------
    const g1 = await call(null, 'POST', 'goal', { agent: agent('ana'), text: 'rework the cart' }, A);
    await call(null, 'POST', 'claim-goal', { agent: agent('ana'), id: g1.goal.id }, A);
    const pl = await call(null, 'POST', 'plan', { agent: agent('ana'), goalId: g1.goal.id, summary: 'x', tasks: [
      { title: 'Cart totals', detail: 'Change src/cart.ts so totals are in cents', effort: 'medium', paths: ['src/cart.ts'], owner: 'bob' },
      { title: 'Cart tests', detail: 'Add cases to the cart module', effort: 'light', paths: ['src/'] },
      { title: 'Docs page', detail: 'Write docs/cart.md', effort: 'light', paths: ['docs/'] },
      { title: 'Refund helper', detail: 'Add a refund helper next to cart.ts', effort: 'light' } ] }, A);
    const [t1, t2, t3, t4] = pl.tasks;
    assert.deepStrictEqual(t1.after, []);
    assert.deepStrictEqual(t2.after, [t1.id], 'work in src/ waits for the change to src/cart.ts');
    assert.strictEqual(t2.owner, 'bob', 'and stays with whoever has the files');
    assert.deepStrictEqual(t3.after, [], 'docs/ is somewhere else and runs in parallel');
    assert.ok(t4.after.includes(t1.id), 'a file named only in the text still counts');
    assert.ok(t2.notes.some(n => /both change src\/cart\.ts/.test(n.text)));
    ok('tasks that change the same files wait for each other and stay with whoever has them, while unrelated ones run in parallel');

    // ---------- the daily digest ----------
    assert.strictEqual((await call(null, 'POST', 'digest-settings', { agent: agent('bob'), enabled: true }, bobTok)).status, 403);
    assert.strictEqual((await call(null, 'POST', 'digest-settings', { agent: agent('ana'), enabled: true, hour: 30 }, A)).status, 400);
    assert.strictEqual((await call(null, 'POST', 'digest-settings', { agent: agent('ana'), enabled: true, tz: 'Mars/Base' }, A)).status, 400);
    assert.strictEqual((await call(null, 'POST', 'digest-settings', { agent: agent('ana'), enabled: true, email: false, popup: false }, A)).status, 400);
    const ds = await call(null, 'POST', 'digest-settings', { agent: agent('ana'), enabled: true, to: 'owners', email: true, popup: true, hour: 8, tz: 'America/Toronto', weekdaysOnly: false }, A);
    assert.strictEqual(ds.settings.tz, 'America/Toronto');
    const gd0 = await call(null, 'GET', 'digests', null, bobTok);
    assert.deepStrictEqual([gd0.recipient, gd0.digests.length], [false, 0], 'members are not recipients when it goes to owners');
    const prev = await call(null, 'POST', 'digest-now', { agent: agent('ana') }, A);
    assert.ok(prev.preview && /task|stuck|usage|request/.test(prev.digest.headline), prev.digest.headline);
    assert.ok(prev.digest.sections.some(x => /Needs a person/.test(x.title)), 'the stuck task shows as needing a person');
    assert.strictEqual((await call(null, 'GET', 'digests', null, A)).digests.length, 0, 'a preview is not kept');
    const mailBefore = mail.length;
    const sent1 = await call(null, 'POST', 'digest-now', { agent: agent('ana'), deliver: true }, A);
    assert.deepStrictEqual([sent1.sent.people, sent1.sent.popup], [1, 1]);
    assert.ok((await call(null, 'GET', 'notes', null, A)).notes.some(n => n.kind === 'digest' && n.link.digest === sent1.digest.id));
    assert.ok(!(await call(null, 'GET', 'notes', null, bobTok)).notes.some(n => n.kind === 'digest'), 'owners only');
    let until2 = Date.now() + 5000;
    while (!mail.slice(mailBefore).some(m => /ana@example/.test(m.to)) && Date.now() < until2) await new Promise(r => setTimeout(r, 100));
    const dm = mail.slice(mailBefore).filter(m => !/sign-in/.test(m.subject));
    assert.ok(dm.length === 1 && dm[0].to === 'ana@example.com' && /\[prod\]/.test(dm[0].subject) && /Needs a person/.test(dm[0].text), JSON.stringify(dm.map(m => m.subject)));
    // to everyone, by pop-up only: bob gets it in the dashboard and no email
    await call(null, 'POST', 'digest-settings', { agent: agent('ana'), to: 'everyone', email: false, popup: true }, A);
    const digestMails = () => mail.filter(m => /Needs a person|Daily digest/.test(m.text) || /\[prod\] .*(finished|stuck|usage|request)/.test(m.subject)).length;
    const mailMid = digestMails();
    const sent2 = await call(null, 'POST', 'digest-now', { agent: agent('ana'), deliver: true }, A);
    assert.ok(sent2.sent.people >= 2 && sent2.sent.email === 0);
    assert.ok((await call(null, 'GET', 'notes', null, bobTok)).notes.some(n => n.kind === 'digest'));
    assert.strictEqual((await call(null, 'GET', 'digests', null, bobTok)).digests.length, 2);
    await new Promise(r => setTimeout(r, 600));
    assert.strictEqual(digestMails(), mailMid, 'no digest email when it is pop-up only');
    // switched off: nothing is due
    await call(null, 'POST', 'digest-settings', { agent: agent('ana'), enabled: false }, A);
    ok('the daily digest goes to owners or everyone, by email, pop-up or both, can be previewed, and skips email for pop-up only');

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
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { if (process.platform !== 'win32') throw e; } // (Windows keeps a folder busy while a stopped process exits)
  }
})().catch(e => { console.error(e); process.exit(1); });

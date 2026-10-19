// Accounts, trust controls, notifications and failure reports, against a real server.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'huddle-acct-'));
const ok = (m) => console.log('✓ ' + m);

(async () => {
  // a stand-in for Slack: records what it was sent
  const got = [];
  const hookSrv = http.createServer((req, res) => { let b = ''; req.on('data', d => b += d); req.on('end', () => { got.push({ path: req.url, body: JSON.parse(b) }); res.end('ok'); }); });
  await new Promise(r => hookSrv.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hookSrv.address().port}`;

  const proc = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))}).createServer({ dataDir: ${JSON.stringify(tmp)}, token: 'admin-secret', open: true });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise(r => proc.stdout.once('data', d => r(String(d).trim())));
  // HUDDLE_TEST_URL runs the same checks against another server (e.g. `wrangler dev` of the worker)
  const base = process.env.HUDDLE_TEST_URL || `http://127.0.0.1:${port}`;
  const call = async (token, method, ep, body, project) => {
    const res = await fetch(`${base}/api/p/${project}/${ep}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, ...data };
  };
  const agent = (name, kind = 'agent') => ({ id: name + '#t' + kind, name, host: 'test', kind });

  try {
    const made = await (await fetch(`${base}/api/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'acct' }) })).json();
    const P = made.project, shared = made.token;
    const as = (tok) => (method, ep, body) => call(tok, method, ep, body, P);
    const s = as(shared);

    // before accounts: the shared token can do everything, as it always could
    assert.strictEqual((await s('GET', 'whoami')).role, 'owner');
    assert.strictEqual((await s('POST', 'member-invite', { agent: agent('ana'), role: 'member' })).status, 409);
    const own = await s('POST', 'setup-owner', { agent: agent('ana') });
    assert.ok(own.token.startsWith('hm_'));
    const ana = as(own.token);
    assert.deepStrictEqual([(await ana('GET', 'whoami')).role, (await s('GET', 'whoami')).role], ['owner', 'member']);
    assert.strictEqual((await s('POST', 'setup-owner', { agent: agent('bob') })).status, 409);
    ok('the first owner sets up accounts; after that the shared token is only a member');

    // personal invites: a short code, looked up, turned into a personal token once
    const inv = await ana('POST', 'member-invite', { agent: agent('ana'), role: 'member' });
    const look = await (await fetch(`${base}/api/invite/${inv.code}`)).json();
    assert.deepStrictEqual([look.project, look.personal, look.token], [P, true, undefined]);
    const bobJoin = await call(null, 'POST', 'redeem', { code: inv.code, name: 'bob' }, P);
    assert.strictEqual(bobJoin.role, 'member');
    assert.strictEqual((await call(null, 'POST', 'redeem', { code: inv.code, name: 'eve' }, P)).status, 410);
    assert.strictEqual((await call(null, 'GET', 'state', null, P)).status, 401);
    const bob = as(bobJoin.token);
    // a personal token speaks as its person, whatever name it gives
    await bob('POST', 'status', { agent: agent('mallory'), status: 'fixing the parser' });
    const st = await ana('GET', 'state');
    assert.ok(st.agents.some(a => a.name === 'bob' && a.status === 'fixing the parser'));
    assert.ok(!st.agents.some(a => a.name === 'mallory'));
    ok('personal invites become personal tokens, once, and a token always speaks as its own person');

    const vinv = await ana('POST', 'member-invite', { agent: agent('ana'), role: 'viewer' });
    const vic = as((await call(null, 'POST', 'redeem', { code: vinv.code, name: 'vic' }, P)).token);
    assert.ok((await vic('GET', 'board')).goals);
    assert.strictEqual((await vic('POST', 'goal', { agent: agent('vic'), text: 'delete everything' })).status, 403);
    assert.strictEqual((await bob('POST', 'project-setting', { agent: agent('bob'), testCommand: 'rm -rf /' })).status, 403);
    assert.strictEqual((await bob('POST', 'member-invite', { agent: agent('bob'), role: 'owner' })).status, 403);
    assert.strictEqual((await bob('POST', 'invite-code', { agent: agent('bob') })).status, 403);
    assert.strictEqual((await s('POST', 'invite-code', { agent: agent('x') })).status, 403);
    ok('viewers only look, only the owner changes project settings or makes owners, and the shared invite stays with owners');

    // taking access back
    const r1 = await ana('POST', 'member-remove', { agent: agent('ana'), name: 'vic' });
    assert.ok(r1.ok);
    assert.strictEqual((await vic('GET', 'state')).status, 401);
    const inv2 = await ana('POST', 'member-invite', { agent: agent('ana') });
    await ana('POST', 'invite-revoke', { agent: agent('ana'), id: inv2.invite.id });
    assert.strictEqual((await call(null, 'POST', 'redeem', { code: inv2.code, name: 'zed' }, P)).status, 404);
    await ana('POST', 'project-setting', { agent: agent('ana'), sharedToken: false });
    assert.strictEqual((await s('GET', 'state')).status, 401);
    assert.ok((await bob('GET', 'state')).agents);
    ok('removed people and revoked invites stop working at once, and the shared invite can be switched off');

    // trust: never-allowed commands, private files, secrets out of the feed, the audit log
    await ana('POST', 'policy', { agent: agent('ana'), allow: ['npm test'], deny: ['git push', 'curl'] });
    const g = await ana('POST', 'goal', { agent: agent('ana'), text: 'rename add to plus', to: 'bob' });
    const tid = (await ana('GET', 'board')).tasks.find(t => t.goalId === g.goal.id).id;
    const ar = await bob('POST', 'approval-request', { agent: agent('bob'), taskId: tid, commands: [{ command: 'git push origin main' }, { command: 'npm run build' }] });
    assert.deepStrictEqual(ar.approvals.map(x => x.status), ['denied', 'waiting']);
    assert.strictEqual((await bob('POST', 'content', { agent: agent('bob'), path: 'config/.env', content: 'X=1' })).status, 403);
    await bob('POST', 'activity', { agent: { ...agent('bob'), id: 'bob#clone' }, items: [{ kind: 'text', text: 'set OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123 in .env' }] });
    const feed = await ana('GET', 'activity?limit=5');
    assert.ok(feed.activity.some(it => it.text.includes('[secret hidden]') && !it.text.includes('sk-proj')));
    const log = (await ana('GET', 'audit')).audit;
    for (const action of ['owner', 'invite', 'join', 'remove', 'invite-revoke', 'settings', 'policy']) assert.ok(log.some(e => e.action === action), 'audit has ' + action);
    assert.strictEqual((await vic('GET', 'audit')).status, 401);
    ok('never-allowed commands are refused, private files stay home, secrets leave the feed, and every change is in the audit log');

    // notifications: owner-only, the URL never shown to the team, sent on stuck work
    assert.strictEqual((await bob('POST', 'notify-set', { agent: agent('bob'), url: hookUrl + '/x' })).status, 403);
    await ana('POST', 'notify-set', { agent: agent('ana'), url: hookUrl + '/hooks.slack.com/services/T0/B0/xyz', kind: 'slack', events: ['stuck', 'failed', 'approval'] });
    const ps = (await bob('GET', 'state')).projectSettings;
    assert.ok(ps.notify.length === 1 && !JSON.stringify(ps).includes(hookUrl));
    await bob('POST', 'task-update', { agent: agent('bob'), id: tid, status: 'blocked', note: 'the build needs a token' });
    await bob('POST', 'problem', { agent: agent('bob'), kind: 'crash', message: 'claude exited with code 1' });
    const until = Date.now() + 5000;
    while (got.length < 2 && Date.now() < until) await new Promise(r => setTimeout(r, 50));
    assert.ok(got.some(x => /Stuck: "Rename add to plus"/.test(x.body.text)), JSON.stringify(got));
    assert.ok(got.some(x => /claude exited/.test(x.body.text)));
    ok('stuck work and crashes reach Slack, and only the owner sees where they go');

    // retries and crashes show up on the task and in the problem list
    await bob('POST', 'task-update', { agent: agent('bob'), id: tid, run: { attempt: 1, outcome: 'crashed', error: 'exit 1', ms: 1200 } });
    await bob('POST', 'task-update', { agent: agent('bob'), id: tid, run: { attempt: 2, outcome: 'ok', ms: 9000 } });
    const t = (await ana('GET', 'board')).tasks.find(x => x.id === tid);
    assert.deepStrictEqual(t.runs.map(r => r.outcome), ['crashed', 'ok']);
    assert.ok((await ana('GET', 'problems')).problems.some(x => x.kind === 'crash'));
    const status = await (await fetch(base + '/status')).text();
    assert.ok(/All systems operational/.test(status));
    ok('each attempt is kept on its task, crashes are listed, and /status answers');

    console.log('\nall good');
  } finally {
    proc.kill();
    hookSrv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });

// A second opinion from another vendor: the team has a Codex user, so the review of a Claude's work is
// asked of `codex` (a stand-in here), and the task says who reviewed it. Same setup as test/worker.js.
'use strict';
require('./winbin');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'huddle-cross-'));
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const sh = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };

(async () => {
  const srv = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))}).createServer({ dataDir: ${JSON.stringify(path.join(tmp, 'server'))}, open: true });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = `http://127.0.0.1:${await new Promise(r => srv.stdout.once('data', d => r(String(d).trim())))}`;
  const { project, token } = await (await fetch(url + '/api/new', { method: 'POST', body: '{"name":"cross"}' })).json();
  const api = (ep, body) => fetch(`${url}/api/p/${project}/${ep}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
  let worker;
  try {
    const origin = path.join(tmp, 'origin');
    fs.mkdirSync(origin);
    sh(origin, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(origin, 'a.txt'), 'one\n');
    sh(origin, 'add', '-A'); sh(origin, 'commit', '-qm', 'init');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const p = process.argv[process.argv.indexOf('-p') + 1] || '';
const id = (p.match(/Your task \\[(\\w+)\\]/) || [])[1];
if (p.includes('You are reviewing work')) { console.log('VERDICT: OK'); process.exit(0); }
fs.writeFileSync('triaged-' + id + '.txt', 'done\\n');
console.log('triaged ' + id);
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'codex'), `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(path.join(tmp, 'codex-called'))}, process.argv.slice(2).join(' '));
console.log('VERDICT: OK');
`, { mode: 0o755 });
    await api('hello', { agent: { id: 'cy#1', name: 'cy', kind: 'claude' }, tool: 'codex' });
    assert.equal((await api('state')).settings.cy.tool, 'codex');
    const invite = (await api('invite-code', {})).code;
    const dir = path.join(tmp, 'work');
    assert.ok(invite);
    worker = spawn(process.execPath, [CLI, 'worker', `${url}/app#invite=${invite}`, '--repo', origin, '--dir', dir, '--agent', 'claude', '--name', 'worker'], {
      env: { ...process.env, ...gitEnv, PATH: bin + path.delimiter + process.env.PATH, HUDDLE_SESSION: '777' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    worker.stdout.on('data', d => out += d); worker.stderr.on('data', d => out += d);
    const until = Date.now() + 30000;
    while (Date.now() < until && !(await api('state')).agents.some(a => a.name === 'worker')) await new Promise(r => setTimeout(r, 300));
    assert.ok((await api('state')).agents.some(a => a.name === 'worker'), 'the worker joined\n' + out);
    console.log('worker on duty');
    // a schedule that is due now starts a request, and the worker (the only Claude around) picks it up
    const made = await api('automation-set', { agent: { id: 'h#boss', name: 'boss', kind: 'human' }, name: 'Triage', text: 'Triage the new issues', hour: new Date().getUTCHours(), tz: 'UTC', days: 'daily', enabled: true, to: 'worker' });
    const id = (made.automation || made.schedule || (made.automations || [])[0] || {}).id;
    if (id) await api('automation-set', { agent: { id: 'h#boss', name: 'boss', kind: 'human' }, id, run: true });
    let task;
    const until2 = Date.now() + 40000;
    while (Date.now() < until2) { task = (await api('board')).tasks[0]; if (task && task.status === 'done') break; await new Promise(r => setTimeout(r, 400)); }
    assert.ok(task && task.status === 'done', JSON.stringify(task) + '\n' + out);
    assert.ok(fs.existsSync(path.join(tmp, 'codex-called')), 'codex reviewed\n' + out);
    assert.equal((task.checks || {}).reviewer, 'Codex', JSON.stringify(task.checks));
    console.log('✓ the review of a Claude\'s work was asked of Codex, and the task says so');
    await api('project-setting', { agent: { id: 'h#boss', name: 'boss', kind: 'human' }, crossReview: false });
    assert.equal((await api('state')).projectSettings.crossReview, false);
    console.log('✓ the team can switch it off');
    console.log('\nall good');
  } finally {
    if (worker) worker.kill();
    srv.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch (e) { if (process.platform !== 'win32') throw e; } // (Windows keeps a folder busy while a stopped process exits)
  }
})().catch(e => { console.error(e); process.exit(1); });

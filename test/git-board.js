// Versions, branches and the team board, end to end with real git repos.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'huddle-git-'));
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
let step = 'start';
const ok = (s) => { step = s; console.log('✓', s); };

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function person(name, pid, url, token, project, { git = true } = {}) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.huddle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.huddle', 'config.json'), JSON.stringify({ server: url, token, project, name }));
  const env = { ...process.env, ...gitEnv, HUDDLE_SESSION: String(pid), HUDDLE_ROOT: root };
  const cli = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: 'utf8' });
    return (r.stdout + r.stderr).trim();
  };
  const hook = (event, input) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', event], { input: JSON.stringify({ cwd: root, ...input }), env, encoding: 'utf8' });
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  const write = (f, text) => fs.writeFileSync(path.join(root, f), text);
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  return { name, root, env, cli, hook, write, read, git: (...a) => sh(root, ...a) };
}

(async () => {
  const proc = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))})
      .createServer({ dataDir: ${JSON.stringify(path.join(tmp, 'server'))}, open: true });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = process.env.HUDDLE_TEST_URL || `http://127.0.0.1:${await new Promise(r => proc.stdout.once('data', d => r(String(d).trim())))}`;
  const { project, token } = await (await fetch(url + '/api/new', { method: 'POST', body: '{"name":"gitboard"}' })).json();
  const api = (ep, body) => fetch(`${url}/api/p/${project}/${ep}`, {
    method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token }, body: body && JSON.stringify(body),
  }).then(r => r.json());

  try {
    // dave starts the project and shares his history
    const dave = person('dave', 101, url, token, project);
    sh(dave.root, 'init', '-q', '-b', 'main');
    require('../src/git').ensureExcluded(dave.root);
    dave.write('calc.py', 'def add(a, b):\n    return a + b\n');
    dave.git('add', '-A'); dave.git('commit', '-qm', 'add');
    assert.match(dave.cli('sync', '--sync', 'share'), /shared main/);
    ok('the first person shares their git history');

    // huddle's own files never get into history, and history that has them is refused
    assert.equal(dave.git('ls-files', '.huddle'), '');
    const leak = person('leak', 999, url, token, project);
    sh(leak.root, 'init', '-q', '-b', 'main');
    leak.write('x.txt', 'x'); sh(leak.root, 'add', '-f', '-A'); sh(leak.root, 'commit', '-qm', 'oops');
    assert.match(leak.cli('publish'), /contain \.huddle/);
    ok('the invite token and hook settings can never be shared through git');

    // erin cloned the same repo earlier; both have moved on since
    const erin = person('erin', 202, url, token, project);
    fs.rmSync(erin.root, { recursive: true });
    sh(tmp, 'clone', '-q', dave.root, 'erin');
    person('erin', 202, url, token, project); // rewrite config into the clone
    require('../src/git').ensureExcluded(erin.root);
    dave.write('calc.py', 'def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n');
    dave.git('commit', '-qam', 'sub');
    assert.match(dave.cli('publish'), /shared main/);
    erin.write('README.md', '# calc\n');
    erin.git('add', '-A'); erin.git('commit', '-qm', 'readme');
    const synced = erin.cli('sync', '--sync', 'merge');
    assert.match(synced, /both changed since they split/);
    assert.match(synced, /Merged dave\/main into main/);
    assert(erin.read('calc.py').includes('def sub') && fs.existsSync(path.join(erin.root, 'README.md')));
    ok('joining with a diverged copy merges the team version in');

    assert.match(dave.cli('sync', '--sync', 'merge'), /commit\(s\) you don't have|Updated to erin\/main/);
    dave.cli('merge', 'erin');
    assert(fs.existsSync(path.join(dave.root, 'README.md')));
    ok("the other side picks up the merge (git history travels through huddle)");

    // frank has an unrelated copy in a folder that isn't even a git repo
    const frank = person('frank', 303, url, token, project);
    frank.write('calc.py', 'print("my own calc")\n');
    const fr = frank.cli('sync', '--sync', 'theirs');
    assert.match(fr, /not a git repository/);
    assert.match(fr, /Switched to (dave|erin)\/main\. Your previous version is on branch huddle-backup-/);
    assert(frank.read('calc.py').includes('def sub'));
    assert(frank.git('branch').includes('huddle-backup-'));
    ok('a non-git copy gets git set up, and "theirs" switches over with a backup branch');

    // branches: erin goes her own way; locks no longer block her
    assert.match(erin.cli('branch', 'own'), /now on your own branch erin\/main/);
    const edit = (p) => ({ tool_name: 'Edit', tool_input: { file_path: path.join(p.root, 'calc.py') } });
    assert.equal(dave.hook('pre', edit(dave)), null);
    const warn = erin.hook('pre', edit(erin));
    assert.match(warn.hookSpecificOutput.additionalContext, /dave is also editing calc\.py on branch main/);
    assert.notEqual(warn.hookSpecificOutput.permissionDecision, 'deny');
    frank.git('checkout', '-q', 'main');
    const blocked = frank.hook('pre', edit(frank));
    assert.equal(blocked.hookSpecificOutput.permissionDecision, 'deny');
    ok('locks only apply on the same branch; other branches get a heads-up instead');

    // both change the same line on different branches, then merge
    dave.write('calc.py', dave.read('calc.py').replace('return a + b', 'return int(a) + int(b)'));
    dave.git('commit', '-qam', 'ints');
    dave.hook('stop', {});
    erin.write('calc.py', erin.read('calc.py').replace('return a + b', 'return float(a) + float(b)'));
    erin.git('commit', '-qam', 'floats');
    erin.hook('stop', {});
    const mg = erin.cli('merge', 'dave');
    assert.match(mg, /conflicts in:\s+calc\.py/);
    assert(erin.read('calc.py').includes('<<<<<<<'));
    sh(erin.root, 'merge', '--abort');
    ok('commits are shared at the end of a turn, and a clashing merge lists the conflicts for Claude');

    // the team board
    assert.match(dave.cli('ask', 'add multiply and divide, with tests'), /posted to the team as goal/);
    let b = await api('board');
    const goal = b.goals[b.goals.length - 1];
    const [c1, c2] = await Promise.all([
      api('claim-goal', { agent: { id: 'erin#x', name: 'erin' }, id: goal.id }),
      api('claim-goal', { agent: { id: 'frank#x', name: 'frank' }, id: goal.id }),
    ]);
    assert.equal([c1.ok, c2.ok].filter(Boolean).length, 1);
    const planner = c1.ok ? 'erin' : 'frank';
    const other = planner === 'erin' ? 'frank' : 'erin';
    const p = person(planner, planner === 'erin' ? 202 : 303, url, token, project);
    const o = person(other, other === 'erin' ? 202 : 303, url, token, project);
    fs.rmSync(path.join(o.root, '.huddle', 'sessions'), { recursive: true, force: true });
    o.hook('session-start', {});   // o has now seen the board as it is
    const plan = await api('plan', { agent: { id: `${planner}#x`, name: planner }, goalId: goal.id, summary: 'split by function',
      tasks: [{ title: 'multiply', owner: planner }, { title: 'divide', owner: other }, { title: 'tests for both', after: [0, 1] }] });
    assert.deepEqual(plan.tasks[2].after, [plan.tasks[0].id, plan.tasks[1].id]);
    const told = o.hook('post', { tool_name: 'Read', tool_input: {} }).hookSpecificOutput.additionalContext;
    assert.match(told, /Task assigned to you \[[0-9a-f]+\]: divide/);
    assert.match(told, /New unassigned task \[[0-9a-f]+\]: tests for both/);
    fs.rmSync(path.join(o.root, '.huddle', 'sessions'), { recursive: true, force: true });
    const briefing = o.hook('session-start', {}).hookSpecificOutput.additionalContext;
    assert.match(briefing, /divide \(owner [a-z]+, todo\)  ← yours/);
    ok('one Claude wins the goal, plans it, and each agent sees its own tasks');

    const pickd = require('../src/autopilot').pick(await api('board'), other, new Set());
    assert.equal(pickd.kind, 'task');
    assert.equal(pickd.task.title, 'divide');
    const blockedTest = require('../src/autopilot').pick(await api('board'), 'nobody', new Set());
    assert.equal(blockedTest, null); // "tests for both" waits for its dependencies
    for (const t of plan.tasks.slice(0, 2)) await api('task-update', { agent: { id: 'x#1', name: t.owner }, id: t.id, status: 'done', note: 'ok' });
    const nowFree = require('../src/autopilot').pick(await api('board'), 'nobody', new Set());
    assert.equal(nowFree.kind, 'claim');
    const [k1, k2] = await Promise.all([
      api('claim-task', { agent: { id: 'a#1', name: 'erin' }, id: plan.tasks[2].id }),
      api('claim-task', { agent: { id: 'b#1', name: 'frank' }, id: plan.tasks[2].id }),
    ]);
    assert.equal([k1.ok, k2.ok].filter(Boolean).length, 1);
    await api('task-update', { agent: { id: 'a#1', name: 'erin' }, id: plan.tasks[2].id, status: 'done' });
    b = await api('board');
    assert.equal(b.goals.find(g => g.id === goal.id).status, 'done');
    assert.match(dave.cli('ask', 'rename add to plus', '--to', 'erin'), /sent to erin's Claude/);
    b = await api('board');
    assert.equal(b.tasks[b.tasks.length - 1].owner, 'erin');
    ok('dependencies hold tasks back, claims are first-come, goals close when their tasks are done, direct asks go to one Claude');

    console.log('\nall good');
  } catch (e) {
    console.error(`\n✗ failed after "${step}":`, e);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

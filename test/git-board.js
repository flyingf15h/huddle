// Versions, branches and the team board, end to end with real git repos.
'use strict';
require('./winbin');
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
  fs.writeFileSync(path.join(root, '.huddle', 'config.json'), JSON.stringify({ server: url, token, project, name, summarize: false, shareActivity: 'full' }));
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
    const tree = await fetch(`${url}/api/p/${project}/git-tree?ref=dave/main`, { headers: { authorization: 'Bearer ' + token } }).then(r => r.json());
    assert.deepEqual(tree.files.map(f => f.path), ['calc.py']);
    const blob = await fetch(`${url}/api/p/${project}/git-blob?ref=dave/main&path=calc.py`, { headers: { authorization: 'Bearer ' + token } }).then(r => r.json());
    assert.match(blob.content, /def add/);
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

    // a commit that says it finishes a task closes it on the board
    const davey = { id: 'dave#x', name: 'dave' };
    const tk = (await api('task', { agent: davey, title: 'add pow', owner: 'dave' })).task;
    await api('task-update', { agent: davey, id: tk.id, status: 'doing' });
    fs.rmSync(path.join(dave.root, '.huddle', 'sessions'), { recursive: true, force: true });
    dave.hook('session-start', {});
    assert.match(dave.hook('prompt', { prompt: 'make the division errors friendlier please' }).hookSpecificOutput.additionalContext,
      new RegExp(`Board tasks you still have in progress: \\[${tk.id}\\] add pow`));
    dave.write('pow.py', 'def pow(a, b):\n    return a ** b\n');
    dave.git('add', '-A'); dave.git('commit', '-qm', `pow, closes ${tk.id}`);
    assert.match(dave.hook('stop', { stop_hook_active: true }).systemMessage, /closed "add pow"/);
    const closedTask = (await api('board')).tasks.find(t => t.id === tk.id);
    assert.equal(closedTask.status, 'done');
    assert.match(closedTask.notes[closedTask.notes.length - 1].text, /closed by commit [0-9a-f]{8}: pow, closes/);
    ok('a commit that says "closes <task>" closes it on the board');

    // requests run as Claudes of their own, side by side in their own worktrees, and merge back
    const fakeBin = path.join(tmp, 'bin');
    fs.mkdirSync(fakeBin);
    const runLog = path.join(tmp, 'runs.log');
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const p = process.argv[process.argv.indexOf('-p') + 1] || '';
const id = (p.match(/Your task \\[(\\w+)\\]/) || [])[1];
const clone = JSON.parse(fs.readFileSync('.huddle/config.json', 'utf8')).clone || {};
if (p.includes('You are reviewing work')) { fs.appendFileSync(${JSON.stringify(runLog)}, ['review', process.argv.includes('sonnet'), process.cwd(), process.env.HUDDLE_ROOT].join(' ') + '\\n'); console.log('VERDICT: OK'); process.exit(0); }
fs.appendFileSync(${JSON.stringify(runLog)}, ['start', id, Date.now(), process.cwd(), process.env.HUDDLE_SESSION, process.env.HUDDLE_ROOT, clone.branch].join(' ') + '\\n');
setTimeout(() => {
  if (p.includes('touch calc')) fs.appendFileSync('calc.py', '# from the request\\n');
  else fs.writeFileSync('notes-' + id + '.txt', 'done\\n');
  fs.appendFileSync(${JSON.stringify(runLog)}, ['end', id, Date.now()].join(' ') + '\\n');
  console.log('did ' + id);
}, 1200);
`, { mode: 0o755 });
    process.env.PATH = fakeBin + path.delimiter + process.env.PATH;
    Object.assign(process.env, gitEnv);
    dave.write('calc.py', dave.read('calc.py') + '# wip\n'); // dave is in the middle of something
    const ap = require('../src/autopilot');
    const { loadConfig, Client, identity } = require('../src/client');
    const dcfg = { ...loadConfig(dave.root), clonesDir: path.join(tmp, 'clones') };
    await api('setting', { agent: davey, autopilot: 'requests' });
    const asker = { id: 'h#erin', name: 'erin', kind: 'human' };
    for (const text of ['write notes A', 'write notes B', 'touch calc please']) await api('goal', { agent: asker, text, to: 'dave' });
    const runner = ap.createRunner({ cfg: dcfg, client: new Client(dcfg, identity(dcfg, 'autopilot')), log: () => {} });
    await runner.refreshMode();
    runner.work();
    const reqs = () => api('board').then(bd => bd.tasks.filter(t => ['write notes a', 'write notes b', 'touch calc please'].includes(t.title.toLowerCase())));
    const end = Date.now() + 20000;
    while (!(await reqs()).every(t => t.status === 'done')) { assert(Date.now() < end, 'requests never finished'); await new Promise(r => setTimeout(r, 200)); }
    runner.stop();
    const runs = fs.readFileSync(runLog, 'utf8').trim().split('\n').map(l => l.split(' '));
    const [ra, rb] = (await reqs()).slice(0, 2).map(t => t.id);
    const at = (kind, id) => Number(runs.find(r => r[0] === kind && r[1] === id)[2]);
    assert(at('start', rb) < at('end', ra) && at('start', ra) < at('end', rb), 'the two requests ran at the same time');
    for (const r of runs.filter(r => r[0] === 'start')) {
      assert(r[3].split(path.sep).includes('clones') && path.basename(r[3]) === path.basename(r[5]), 'each runs in its own worktree, with huddle pointed there');
      assert.equal(r[4], 'clone-' + r[1]);
      assert.equal(r[6], 'main');
    }
    const reviews = runs.filter(r => r[0] === 'review');
    assert(reviews.length >= 2 && reviews.every(r => r[1] === 'true' && path.basename(r[2]) === path.basename(r[3]) && r[2].split(path.sep).includes('clones')), 'each change is reviewed by Sonnet in its own worktree');
    assert.equal((await reqs()).find(t => t.title === 'Write notes A').checks.review, 'ok');
    assert(fs.existsSync(path.join(dave.root, `notes-${ra}.txt`)) && fs.existsSync(path.join(dave.root, `notes-${rb}.txt`)), 'clean results merged into dave\'s branch');
    assert(dave.read('calc.py').includes('# wip') && !dave.read('calc.py').includes('# from the request'), "dave's own work is untouched");
    const calcId = (await reqs()).find(t => t.title === 'Touch calc please').id;
    assert(dave.git('branch').includes(`huddle-request-${calcId}`) && !dave.git('branch').includes(`huddle-request-${ra}`));
    assert.equal(dave.git('worktree', 'list').split('\n').length, 1, 'worktrees are cleaned up');
    const replies = (await api('messages')).messages.filter(m => m.to === 'erin' && /Re your request/.test(m.text));
    assert.equal(replies.filter(m => /merged into dave's main/.test(m.text)).length, 2);
    assert.match(replies.find(m => /touch calc/i.test(m.text)).text, new RegExp(`on branch huddle-request-${calcId}`));
    ok('requests run as their own Claudes in parallel worktrees; clean results merge in, the rest wait on a branch');

    // checks before merging: failing tests keep the work on its branch; commands it couldn't run wait for dave's OK
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const p = process.argv[process.argv.indexOf('-p') + 1] || '';
if (p.includes('You are reviewing work')) { console.log('VERDICT: OK'); process.exit(0); }
if (p.includes('break the tests')) fs.writeFileSync('bad.txt', 'oops\\n');
if (p.includes('ship it')) { fs.writeFileSync('ship.txt', 'ready\\n'); console.log('Built it.\\nNeeds dave\\'s OK:\\n- npm run deploy — puts it live'); }
`, { mode: 0o755 });
    dave.git('checkout', '--', 'calc.py');
    fs.writeFileSync(path.join(dave.root, 'check.js'), "process.exit(require('fs').existsSync('bad.txt') ? 1 : 0)\n");
    dave.git('add', 'check.js'); dave.git('commit', '-q', '-m', 'a test');
    await api('project-setting', { agent: davey, testCommand: 'node check.js' });
    await api('goal', { agent: asker, text: 'break the tests', to: 'dave' });
    await api('goal', { agent: asker, text: 'ship it', to: 'dave' });
    const runner2 = ap.createRunner({ cfg: dcfg, client: new Client(dcfg, identity(dcfg, 'autopilot')), log: () => {} });
    await runner2.refreshMode();
    runner2.work();
    const task2 = (title) => api('board').then(bd => bd.tasks.find(t => t.title.toLowerCase() === title));
    const end2 = Date.now() + 30000;
    while (!((await task2('break the tests')).checks && (await task2('ship it')).status === 'done')) { assert(Date.now() < end2, 'checked requests never finished'); await new Promise(r => setTimeout(r, 200)); }
    const broke = await task2('break the tests');
    assert.equal(broke.checks.tests, 'failed');
    assert.equal(broke.status, 'blocked');
    assert(!fs.existsSync(path.join(dave.root, 'bad.txt')), 'work that fails the tests is not merged');
    assert(dave.git('branch').includes(`huddle-request-${broke.id}`), 'it waits on its branch');
    const ship = await task2('ship it');
    assert.equal(ship.checks.tests, 'passed');
    assert(fs.existsSync(path.join(dave.root, 'ship.txt')), 'passing work merges');
    const appr = (await api('approvals')).approvals.find(x => x.taskId === ship.id);
    assert.equal(appr.command, 'npm run deploy');
    // only dave can say yes: not someone else, and not a browser without dave's key
    const no1 = await fetch(`${url}/api/p/${project}/approve`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ agent: asker, id: appr.id }) });
    assert.equal(no1.status, 403);
    const no2 = await fetch(`${url}/api/p/${project}/approve`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ agent: { id: 'h#dave', name: 'dave', kind: 'human' }, id: appr.id, key: 'guess' }) });
    assert.equal(no2.status, 403);
    await api('hello', { agent: { ...davey, kind: 'agent' }, keyHash: require('../src/client').sha('dave-key') });
    const yes = await api('approve', { agent: { id: 'h#dave', name: 'dave', kind: 'human' }, id: appr.id, key: 'dave-key' });
    assert.equal(yes.approval.status, 'approved');
    const again = await task2('ship it');
    assert.deepEqual([again.status, again.allow], ['todo', ['npm run deploy']], 'approved: it runs again with the command allowed');
    // diff review: every task's changes are shared; changes can be asked for, and work left on a branch merged
    const brokeNow = await task2('break the tests');
    assert.ok(brokeNow.diff && brokeNow.diff.files.some(f => f.path === 'bad.txt') && brokeNow.diff.left === true && brokeNow.diff.add >= 1);
    const dd = await api('task-diff?id=' + brokeNow.id);
    assert.match(dd.diff, /\+\+\+ b\/bad\.txt/);
    const calcTask = (await api('board')).tasks.find(t => t.id === calcId);
    assert.ok(calcTask.diff && calcTask.diff.left, 'work left on its branch can be merged from the dashboard');
    await api('task-merge', { agent: asker, id: calcId });
    await runner2.onEvent({ type: 'board', action: 'merge-request', task: { id: calcId, title: calcTask.title, owner: 'dave' } });
    assert.ok(dave.read('calc.py').includes('# from the request'), 'merged into dave\'s branch');
    assert.ok(!dave.git('branch').includes('huddle-request-' + calcId));
    assert.equal(((await api('board')).tasks.find(t => t.id === calcId).diff || {}).left, false);
    // asking for changes sends the comments back, and the agent carries on from the branch it left
    assert.match((await api('task-review', { agent: asker, id: brokeNow.id, verdict: 'changes' })).error, /say what should change/);
    await api('task-review', { agent: asker, id: brokeNow.id, verdict: 'changes', comments: [{ file: 'bad.txt', line: 1, text: 'remove this file, it breaks check.js' }] });
    assert.equal((await task2('break the tests')).status, 'todo');
    fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
const p = process.argv[process.argv.indexOf('-p') + 1] || '';
if (p.includes('You are reviewing work')) { console.log('VERDICT: OK'); process.exit(0); }
if (p.includes('asked for changes') && p.includes('remove this file')) { fs.rmSync('bad.txt', { force: true }); console.log('fixed it'); }
else if (p.includes('break the tests')) fs.writeFileSync('bad.txt', 'oops\\n');
`, { mode: 0o755 });
    await runner2.onEvent({ type: 'board', action: 'task-update', task: { id: brokeNow.id, status: 'todo' } });
    const end3 = Date.now() + 30000;
    while ((await task2('break the tests')).status !== 'done') { assert(Date.now() < end3, 'the changes were never made'); await new Promise(r => setTimeout(r, 200)); }
    assert.equal((await task2('break the tests')).checks.tests, 'passed');
    assert.ok(!fs.existsSync(path.join(dave.root, 'bad.txt')), 'the fixed work merged without the bad file');
    await api('task-review', { agent: asker, id: brokeNow.id, verdict: 'approve', note: 'thanks' });
    assert.equal((await task2('break the tests')).diff.review.verdict, 'approved');
    runner2.stop();
    ok('work is reviewed and tested before it merges; commands it needs wait for its person\'s OK');
    ok('every task\'s changes can be read, commented on, approved, sent back for changes or merged from a branch');

    // someone nearly out of Claude usage (or away) has their waiting tasks handed to someone with room
    const core = require('../src/core');
    const P = new core.Project('unit');
    const t0 = Date.now();
    P.agents = { 'a#1': { id: 'a#1', name: 'amy', kind: 'agent', lastSeen: t0, runner: 'full' }, 'b#1': { id: 'b#1', name: 'ben', kind: 'agent', lastSeen: t0, runner: 'full' } };
    P.usage = { amy: { five: 95, at: t0 }, ben: { five: 20, at: t0 } };
    P.board.tasks = [{ id: 't1', title: 'big job', owner: 'amy', status: 'todo', effort: 'heavy' }, { id: 't2', title: 'started', owner: 'amy', status: 'doing' }, { id: 't3', title: 'for amy', owner: 'amy', status: 'todo', direct: true }];
    core.handOn(P);
    assert.deepEqual(P.board.tasks.map(t => t.owner), ['ben', 'amy', 'amy'], 'only waiting team tasks move');
    assert.match(P.board.tasks[0].notes[0].text, /Moved from amy to ben: amy has under 10%/);
    ok('tasks move off someone who is out of usage or away');

    console.log('\nall good');
  } catch (e) {
    console.error(`\n✗ failed after "${step}":`, e);
    process.exitCode = 1;
  } finally {
    proc.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

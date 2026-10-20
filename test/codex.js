// Codex in a huddle: its config and hooks, apply_patch edits under the same locks, its transcript
// and usage, never-allowed commands, and background runs with `codex exec` (retries and pull requests).
// `codex` and `gh` are stand-ins that record how they were called.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'huddle-codex-'));
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const ok = (s) => console.log('✓', s);
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

function person(name, pid, url, token, project, agent) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.huddle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.huddle', 'config.json'), JSON.stringify({ server: url, token, project, name, agent, summarize: false, notify: false, shareActivity: 'full' }));
  const env = { ...process.env, ...gitEnv, HUDDLE_SESSION: String(pid), HUDDLE_ROOT: root };
  const hook = (event, input, flags = agent === 'codex' ? ['--agent', 'codex'] : []) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', event, ...flags], { input: JSON.stringify({ cwd: root, ...input }), env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  return { name, root, hook, write: (f, t) => fs.writeFileSync(path.join(root, f), t), read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
}
const denied = (r) => r && r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny';

(async () => {
  const proc = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))}).createServer({ dataDir: ${JSON.stringify(path.join(tmp, 'server'))}, open: true });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = `http://127.0.0.1:${await new Promise(r => proc.stdout.once('data', d => r(String(d).trim())))}`;
  const { project, token } = await (await fetch(url + '/api/new', { method: 'POST', body: '{"name":"codex"}' })).json();
  const api = (ep, body) => fetch(`${url}/api/p/${project}/${ep}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
  const boss = { id: 'h#boss', name: 'boss', kind: 'human' };

  try {
    // ---- its config: MCP server in .codex/config.toml, hooks in .codex/hooks.json, next to the project's own
    const codex = require('../src/codex');
    const cora = person('cora', 301, url, token, project, 'codex');
    fs.mkdirSync(path.join(cora.root, '.codex'));
    fs.writeFileSync(path.join(cora.root, '.codex', 'config.toml'), 'model = "gpt-5.5-codex"\n');
    fs.writeFileSync(path.join(cora.root, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] } }));
    codex.install(cora.root, path.join(__dirname, '..'), cora.root, (ev) => `node cli.js hook ${ev} --agent codex #huddle-hook`, 'huddle-hook');
    codex.install(cora.root, path.join(__dirname, '..'), cora.root, (ev) => `node cli.js hook ${ev} --agent codex #huddle-hook`, 'huddle-hook'); // twice: no duplicates
    const toml = fs.readFileSync(path.join(cora.root, '.codex', 'config.toml'), 'utf8');
    assert.match(toml, /model = "gpt-5.5-codex"/);
    assert.equal(toml.match(/\[mcp_servers\.huddle\]/g).length, 1);
    assert.match(toml, /HUDDLE_AGENT = "codex"/);
    const hj = JSON.parse(fs.readFileSync(path.join(cora.root, '.codex', 'hooks.json'), 'utf8'));
    assert.deepEqual(Object.keys(hj.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
    assert.equal(hj.hooks.Stop.length, 2);
    assert.equal(hj.hooks.PreToolUse[0].matcher, '^(apply_patch|Bash)$');
    codex.uninstall(cora.root, 'huddle-hook');
    assert.equal(fs.readFileSync(path.join(cora.root, '.codex', 'config.toml'), 'utf8').trim(), 'model = "gpt-5.5-codex"');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cora.root, '.codex', 'hooks.json'), 'utf8')).hooks, { Stop: [{ hooks: [{ type: 'command', command: 'echo theirs' }] }] });
    ok("Codex gets huddle's MCP server and hooks in .codex/, beside the project's own, and loses only those on leave");

    // ---- a Codex session in the huddle
    const dan = person('dan', 302, url, token, project, 'claude');
    for (const f of ['a.txt', 'b.txt', 'c.txt']) { cora.write(f, 'v0\n'); dan.write(f, 'v0\n'); }
    const transcript = path.join(tmp, 'rollout.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: 's1' } }) + '\n');
    cora.hook('session-start', { transcript_path: transcript, source: 'startup' });
    dan.hook('session-start', {});
    let st = await api('state');
    assert.equal(st.agents.find(a => a.name === 'cora').tool, 'codex');
    assert.equal(st.settings.cora.tool, 'codex');
    ok('a Codex session joins and the team knows it is Codex');

    assert.equal(dan.hook('pre', { tool_name: 'Edit', tool_input: { file_path: path.join(dan.root, 'b.txt') } }), null);
    const patch = (...files) => ({ tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${files.map(f => `*** Update File: ${f}\n@@\n-v0\n+v1`).join('\n')}\n*** End Patch` } });
    const r1 = cora.hook('pre', patch('a.txt', 'b.txt'));
    assert(denied(r1) && /b\.txt locked by dan/.test(r1.hookSpecificOutput.permissionDecisionReason), JSON.stringify(r1));
    assert(!denied(cora.hook('pre', patch('a.txt', 'c.txt'))));
    cora.write('a.txt', 'v1\n'); cora.write('c.txt', 'v1\n');
    cora.hook('post', patch('a.txt', 'c.txt'));
    st = await api('state');
    assert(['a.txt', 'c.txt'].every(f => st.locks.some(l => l.path === f && l.holderName === 'cora')));
    assert.equal((await api('file?path=c.txt')).content, 'v1\n');
    let act = (await api('activity')).activity;
    assert(act.some(it => it.name === 'cora' && it.kind === 'tool' && it.text === 'Edit: a.txt, c.txt'), JSON.stringify(act.slice(-3)));
    ok('a Codex patch locks every file it writes, waits for the ones others hold, and shares its edits live');

    // its transcript: replies and usage, including the plan's 5-hour and weekly windows
    cora.hook('prompt', { prompt: 'make c better', transcript_path: transcript, session_id: 's1' });
    const resets = Math.floor(Date.now() / 1000) + 3600;
    fs.appendFileSync(transcript, [
      { type: 'turn_context', payload: { model: 'gpt-5.5-codex' } },
      { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking at c.txt first.' }] } },
      { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300, reasoning_output_tokens: 50 } }, rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: resets }, secondary: { used_percent: 7, window_minutes: 10080 } } } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    cora.hook('stop', { transcript_path: transcript, last_assistant_message: 'Done: c.txt now says v1.' });
    act = (await api('activity')).activity.filter(it => it.name === 'cora');
    assert(act.some(it => it.kind === 'prompt' && it.text === 'make c better'));
    assert(act.some(it => it.kind === 'text' && it.text === 'Looking at c.txt first.'));
    assert(act.some(it => it.kind === 'text' && it.text === 'Done: c.txt now says v1.'));
    st = await api('state');
    assert.equal(st.usage.cora.five, 42);
    assert.equal(st.usage.cora.week, 7);
    const stats = (await api('stats')).stats.cora;
    assert(stats && JSON.stringify(stats).includes('gpt-5.5-codex'), JSON.stringify(stats));
    ok("Codex's replies, token use and plan windows reach the team like Claude's");

    // the project's never-allowed commands, in both agents' own sessions
    await api('project-setting', { agent: boss, crossReview: false });
    await api('policy', { agent: boss, deny: ['git push'] });
    cora.hook('prompt', { prompt: 'ship', transcript_path: transcript });
    dan.hook('prompt', { prompt: 'ship' });
    assert(denied(cora.hook('pre', { tool_name: 'Bash', tool_input: { command: 'npm test && git push origin main' } })));
    assert(denied(dan.hook('pre', { tool_name: 'Bash', tool_input: { command: 'git push' } }, [])));
    assert.equal(cora.hook('pre', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), null);
    ok('never-allowed commands are refused in Codex and Claude sessions alike');

    // ---- background work with `codex exec`
    const fakeBin = path.join(tmp, 'bin');
    fs.mkdirSync(fakeBin);
    const runLog = path.join(tmp, 'codex-runs.jsonl');
    fs.writeFileSync(path.join(fakeBin, 'codex'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const a = process.argv.slice(2);
const dir = a[a.indexOf('-C') + 1], last = a[a.indexOf('-o') + 1], prompt = a[a.length - 1];
let rules = '';
try { rules = fs.readFileSync(path.join(dir, '.codex', 'rules', 'huddle.rules'), 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(runLog)}, JSON.stringify({ args: a.slice(0, -1), dir, rules, env: process.env.HUDDLE_AGENT, review: prompt.includes('You are reviewing work') }) + '\\n');
if (prompt.includes('You are reviewing work')) { fs.writeFileSync(last, 'VERDICT: OK'); process.exit(0); }
const flag = ${JSON.stringify(path.join(tmp, 'crashed-once'))};
if (prompt.includes('flaky') && !fs.existsSync(flag)) { fs.writeFileSync(flag, '1'); console.error('stream disconnected before completion'); process.exit(1); }
const name = prompt.includes('flaky') ? 'flaky.txt' : 'feature.txt';
fs.writeFileSync(path.join(dir, name), 'made by codex\\n');
execFileSync('git', ['add', name], { cwd: dir });
execFileSync('git', ['commit', '-qm', 'codex: ' + name], { cwd: dir });
console.log('progress noise that is not the answer');
fs.writeFileSync(last, 'Added ' + name + '.');
`, { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'gh'), `#!/usr/bin/env node
const a = process.argv.slice(2);
require('fs').appendFileSync(${JSON.stringify(path.join(tmp, 'gh.log'))}, JSON.stringify(a) + '\\n');
if (a[0] === '--version') { console.log('gh version 2.80.0'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'create') { console.log('https://github.com/acme/app/pull/7'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') { console.log('{"state":"MERGED"}'); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
    process.env.PATH = fakeBin + path.delimiter + process.env.PATH;
    process.env.HUDDLE_RETRY_MS = '50';
    Object.assign(process.env, gitEnv);

    sh(cora.root, 'init', '-q', '-b', 'main');
    require('../src/git').ensureExcluded(cora.root);
    fs.appendFileSync(path.join(cora.root, '.git', 'info', 'exclude'), '.codex/\n'); // as `huddle join --agent codex` leaves it
    sh(cora.root, 'add', '-A'); sh(cora.root, 'commit', '-qm', 'start');
    await api('setting', { agent: { id: 'cora#x', name: 'cora', kind: 'agent' }, autopilot: 'requests' });
    const ap = require('../src/autopilot');
    const { loadConfig, Client, identity } = require('../src/client');
    const ccfg = { ...loadConfig(cora.root), clonesDir: path.join(tmp, 'clones') };
    assert.equal(ccfg.agent, 'codex');
    await api('goal', { agent: boss, text: 'fix the flaky thing', to: 'cora' });
    const runner = ap.createRunner({ cfg: ccfg, client: new Client(ccfg, identity(ccfg, 'autopilot')), log: () => {} });
    await runner.refreshMode();
    runner.work();
    const task = (re) => api('board').then(b => b.tasks.find(t => re.test(t.title)));
    let end = Date.now() + 20000;
    while ((await task(/flaky/i)).status !== 'done') { assert(Date.now() < end, 'the Codex request never finished'); await new Promise(r => setTimeout(r, 150)); }
    const flaky = await task(/flaky/i);
    assert.deepEqual(flaky.runs.map(r => [r.outcome, r.attempt, r.agent]), [['retrying', 1, 'codex'], ['ok', 2, 'codex']]);
    assert.equal(cora.read('flaky.txt'), 'made by codex\n');
    const runs = fs.readFileSync(runLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const work = runs.filter(r => !r.review), review = runs.find(r => r.review);
    assert(work.every(r => r.args[0] === 'exec' && r.args.includes('workspace-write') && r.args.includes('approval_policy="never"') && r.env === 'codex'));
    assert(work.every(r => r.dir.split(path.sep).includes('clones') /* (macOS and Windows spell the temp folder differently) */ && r.args.includes('--add-dir')), 'each run is in its own worktree and may commit to the repository');
    assert(work[0].rules.includes('pattern = ["git","push"], decision = "forbidden"'), work[0].rules);
    assert(review && review.args.includes('read-only'));
    const reply = (await api('messages')).messages.find(m => m.to === 'boss' && /Re your request/.test(m.text));
    assert(/Added flaky\.txt\./.test(reply.text) && !/progress noise/.test(reply.text), reply.text);
    ok("background requests run as `codex exec` in their own worktree and sandbox, a crash is retried, and the reply is Codex's final message");

    // ---- pull requests instead of merging
    const origin = path.join(tmp, 'origin.git');
    sh(tmp, 'init', '-q', '--bare', origin);
    sh(cora.root, 'remote', 'add', 'origin', origin);
    sh(cora.root, 'push', '-q', 'origin', 'main');
    sh(cora.root, 'remote', 'set-head', 'origin', 'main');
    await api('project-setting', { agent: boss, delivery: 'pr' });
    await api('goal', { agent: boss, text: 'add the feature', to: 'cora' });
    await runner.refreshMode();
    runner.work();
    end = Date.now() + 20000;
    while ((await task(/feature/i)).status !== 'done') { assert(Date.now() < end, 'the PR request never finished'); await new Promise(r => setTimeout(r, 150)); }
    const feat = await task(/feature/i);
    assert.equal(feat.checks.pr, 'https://github.com/acme/app/pull/7');
    assert(!fs.existsSync(path.join(cora.root, 'feature.txt')), 'a pull request is not merged locally');
    const heads = sh(origin, 'branch', '--list', 'huddle/*');
    assert(heads.includes(`huddle/${feat.id}-add-the-feature`), heads);
    const created = fs.readFileSync(path.join(tmp, 'gh.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).find(a => a[1] === 'create');
    assert.equal(created[created.indexOf('--base') + 1], 'main');
    assert.match(created[created.indexOf('--body') + 1], /\| Review \| No problems found \|/);
    runner.stop();
    ok('with delivery set to pr, finished work is pushed as huddle/<task> and opened as a pull request with its checks');

    console.log('\nall good');
  } finally {
    proc.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); proc_exit(); });
function proc_exit() { process.exit(1); }

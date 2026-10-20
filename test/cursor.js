// Cursor in a huddle: its config and hooks next to the project's own, Cursor's hook events driving the
// same locks and sharing as Claude Code, never-allowed commands, and background runs with a stand-in
// `agent` command that records how it was called.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'huddle-cursor-'));
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
  fs.writeFileSync(path.join(root, '.huddle', 'config.json'), JSON.stringify({ server: url, token, project, name, agent, summarize: false, notify: false }));
  const env = { ...process.env, ...gitEnv, HUDDLE_SESSION: String(pid), HUDDLE_ROOT: root };
  const hook = (event, input) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', event, '--agent', agent], { input: JSON.stringify({ workspace_roots: [root], conversation_id: 'conv-' + pid, ...input }), env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  return { name, root, hook, write: (f, t) => fs.writeFileSync(path.join(root, f), t), read: (f) => fs.readFileSync(path.join(root, f), 'utf8') };
}

(async () => {
  const proc = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))}).createServer({ dataDir: ${JSON.stringify(path.join(tmp, 'server'))}, open: true });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = `http://127.0.0.1:${await new Promise(r => proc.stdout.once('data', d => r(String(d).trim())))}`;
  const { project, token } = await (await fetch(url + '/api/new', { method: 'POST', body: '{"name":"cursor"}' })).json();
  const api = (ep, body) => fetch(`${url}/api/p/${project}/${ep}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
  const boss = { id: 'h#boss', name: 'boss', kind: 'human' };

  try {
    // ---- install: MCP server, hooks and a rule, next to the project's own, once
    const cursor = require('../src/cursor');
    const cy = person('cy', 401, url, token, project, 'cursor');
    fs.mkdirSync(path.join(cy.root, '.cursor'));
    fs.writeFileSync(path.join(cy.root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { theirs: { command: 'x' } } }));
    fs.writeFileSync(path.join(cy.root, '.cursor', 'hooks.json'), JSON.stringify({ version: 1, hooks: { stop: [{ command: 'echo theirs' }] } }));
    const install = () => cursor.install(cy.root, path.join(__dirname, '..'), cy.root, (ev) => `node cli.js hook ${ev} --agent cursor #huddle-hook`, 'huddle-hook');
    install(); install();
    const mcp = JSON.parse(fs.readFileSync(path.join(cy.root, '.cursor', 'mcp.json'), 'utf8'));
    assert.deepEqual(Object.keys(mcp.mcpServers).sort(), ['huddle', 'theirs']);
    assert.equal(mcp.mcpServers.huddle.env.HUDDLE_AGENT, 'cursor');
    const hj = JSON.parse(fs.readFileSync(path.join(cy.root, '.cursor', 'hooks.json'), 'utf8'));
    assert.equal(hj.version, 1);
    assert.equal(hj.hooks.stop.length, 2);
    assert.equal(hj.hooks.preToolUse[0].matcher, '^(Write|Delete|Shell)$');
    assert.ok(fs.existsSync(path.join(cy.root, '.cursor', 'rules', 'huddle.mdc')));
    cursor.uninstall(cy.root, 'huddle-hook');
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(cy.root, '.cursor', 'mcp.json'), 'utf8')).mcpServers), ['theirs']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cy.root, '.cursor', 'hooks.json'), 'utf8')).hooks, { stop: [{ command: 'echo theirs' }] });
    assert.ok(!fs.existsSync(path.join(cy.root, '.cursor', 'rules', 'huddle.mdc')));
    ok('Cursor gets huddle\'s MCP server, hooks and rule beside the project\'s own, and loses only those on leave');

    // ---- a Cursor session: Cursor's events through the same handlers
    sh(cy.root, 'init', '-q'); cy.write('a.js', 'one\n'); sh(cy.root, 'add', '-A', ':!.huddle'); sh(cy.root, 'commit', '-qm', 'init');
    const start = cy.hook('sessionStart', {});
    assert.match(start.additional_context, /huddle project/);
    assert.equal((await api('state')).settings.cy.tool, 'cursor');
    ok('a Cursor session joins and the team knows it is Cursor');

    const ana = person('ana', 402, url, token, project, 'cursor');
    sh(ana.root, 'init', '-q'); ana.write('a.js', 'one\n'); ana.write('b.js', 'x\n');
    // Cursor's Write tool: the file is locked for cy, shared after, and refused for ana while cy holds it
    assert.deepEqual(cy.hook('preToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(cy.root, 'a.js') } }), {});
    cy.write('a.js', 'two\n');
    cy.hook('afterFileEdit', { file_path: path.join(cy.root, 'a.js'), edits: [] });
    const branch = sh(cy.root, 'rev-parse', '--abbrev-ref', 'HEAD');
    const f = await api('file?path=a.js&branch=' + branch);
    assert.equal(f.content, 'two\n');
    assert.equal(f.lock.holderName, 'cy');
    const refused = ana.hook('preToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(ana.root, 'a.js') } });
    assert.equal(refused.permission, 'deny');
    assert.match(refused.agent_message, /locked by cy/);
    ok('a Cursor edit takes the file lock, shares the change live, and another Cursor is refused');

    // ---- never-allowed commands, and what the team says arrives with the next tool result
    await api('policy', { agent: boss, deny: ['git push'] });
    cy.hook('sessionStart', {});
    const push = cy.hook('preToolUse', { tool_name: 'Shell', tool_input: { command: 'git push origin main' } });
    assert.equal(push.permission, 'deny');
    assert.match(push.user_message, /never allows/);
    await api('message', { agent: boss, to: 'cy', text: 'please check the cart test' });
    const prompt = cy.hook('beforeSubmitPrompt', { prompt: 'work on the cart' });
    assert.equal(prompt.continue, true);
    const next = cy.hook('postToolUse', { tool_name: 'Read', tool_input: { file_path: 'a.js' } });
    assert.match(next.additional_context, /please check the cart test/);
    assert.deepEqual(cy.hook('postToolUse', { tool_name: 'Read', tool_input: {} }), {});
    ok('never-allowed commands are refused, and messages from the team reach Cursor with its next tool result');

    // ---- the agent's reply is shared with the stop hook, then the turn ends
    cy.hook('afterAgentResponse', { text: 'The cart test used a shared clock; fixed.' });
    cy.hook('stop', { status: 'completed', loop_count: 0 });
    const act = (await api('activity?limit=20')).activity;
    assert.ok(act.some(a => a.name === 'cy' && a.kind === 'text' && /shared clock/.test(a.text)));
    assert.ok(act.some(a => a.name === 'cy' && a.kind === 'end'));
    cy.hook('sessionEnd', { reason: 'completed' });
    ok("Cursor's reply and the end of its turn reach the team feed");

    // ---- background requests: `agent -p --force` in a worktree with .cursor/cli.json permissions
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'agent'), `#!/bin/sh
echo "$@" > "${tmp}/agent-args"
cp .cursor/cli.json "${tmp}/agent-cli.json" 2>/dev/null
echo "$HUDDLE_AGENT:$HUDDLE_TASK" > "${tmp}/agent-env"
echo done > made.txt
git add -A . ':!.cursor' ':!.huddle' 2>/dev/null
echo "All done, made made.txt"
`, { mode: 0o755 });
    const dee = person('dee', 403, url, token, project, 'cursor');
    sh(dee.root, 'init', '-q'); dee.write('a.js', 'one\n'); sh(dee.root, 'add', '-A', ':!.huddle'); sh(dee.root, 'commit', '-qm', 'init');
    fs.writeFileSync(path.join(dee.root, '.huddle', 'config.json'), JSON.stringify({ ...JSON.parse(dee.read('.huddle/config.json')), requestsParallel: 1 }));
    await api('policy', { agent: boss, allow: ['npm test'], deny: ['git push'] });
    const g = await api('goal', { agent: boss, text: 'make made.txt', to: 'dee' });
    const { createRunner } = require('../src/autopilot');
    const { loadConfig, Client, identity } = require('../src/client');
    const prevPath = process.env.PATH;
    process.env.PATH = bin + path.delimiter + prevPath;
    process.env.HUDDLE_SESSION = '403';
    const cfg = loadConfig(dee.root);
    const client = new Client(cfg, { ...identity(cfg), branch: sh(dee.root, 'rev-parse', '--abbrev-ref', 'HEAD') });
    const runner = createRunner({ cfg, client, flags: { mode: 'requests' }, log: () => {} });
    await runner.refreshMode();
    await runner.work();
    const until = Date.now() + 30000;
    let task;
    while (Date.now() < until) { task = (await api('board')).tasks.find(t => t.goalId === g.goal.id); if (task && task.status === 'done') break; await new Promise(r => setTimeout(r, 200)); }
    process.env.PATH = prevPath;
    assert.ok(task && task.status === 'done', JSON.stringify(task));
    const args = fs.readFileSync(path.join(tmp, 'agent-args'), 'utf8');
    assert.match(args, /^-p --force --output-format text /);
    const perms = JSON.parse(fs.readFileSync(path.join(tmp, 'agent-cli.json'), 'utf8')).permissions;
    assert.ok(perms.allow.includes('Shell(npm)') && perms.deny.includes('Shell(git)'), JSON.stringify(perms));
    assert.equal(fs.readFileSync(path.join(tmp, 'agent-env'), 'utf8').trim(), 'cursor:' + task.id);
    assert.ok(task.runs.some(r => r.outcome === 'ok'));
    ok('a background request runs `agent -p --force` in its own worktree with the project rules as Cursor permissions');
    console.log('\nall good');
  } finally {
    proc.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e); process.exit(1); });

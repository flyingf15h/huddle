// End-to-end: a real server, three checkouts in temp dirs, MCP servers and hook
// processes run exactly the way Claude Code would run them.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'huddle-e2e-'));
// a stand-in `claude` for autopilot runs: records the prompt it was given
const fakeBin = path.join(tmp, 'bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const p = process.argv[process.argv.indexOf('-p') + 1] || '';
require('fs').appendFileSync(require('path').join(process.cwd(), 'claude-runs.txt'), p.split('\\n').find(l => l.startsWith('Your task')) + '\\n');
if (p.includes('goes back to')) console.log('Renamed add to plus.\\nNeeds alice\\'s OK: npm test');
if (p.includes('sent you this message')) console.log('Tests live in test/, run them with npm test.');
`, { mode: 0o755 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch {}
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

function checkout(name, pid, server, token, project = 'demo') {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.huddle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.huddle', 'config.json'), JSON.stringify({ server, token, project, name, notify: false, summarize: false, shareActivity: 'full' })); // (the default shares only tool steps; tests exercise full sharing) no desktop pop-ups from test runs
  fs.writeFileSync(path.join(root, 'shared.txt'), 'v0\n');
  const env = { ...process.env, HUDDLE_SESSION: String(pid), HUDDLE_ROOT: root, PATH: fakeBin + path.delimiter + process.env.PATH };
  const hook = (event, input) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', event], { input: JSON.stringify({ cwd: root, ...input }), env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  let mcp = null, buf = '', nextId = 1;
  const pending = new Map();
  const startMcp = () => {
    mcp = spawn(process.execPath, [CLI, 'mcp'], { env, cwd: root, stdio: ['pipe', 'pipe', 'inherit'] });
    mcp.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        pending.get(msg.id)(msg); pending.delete(msg.id);
      }
    });
  };
  const rpc = (method, params) => new Promise(res => {
    const id = nextId++;
    pending.set(id, res);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const r = await rpc('tools/call', { name, arguments: args });
    return r.result.content[0].text;
  };
  const file = path.join(root, 'shared.txt');
  return { name, root, file, hook, startMcp, rpc, tool, stop: () => mcp && mcp.kill('SIGTERM'),
    read: () => fs.readFileSync(file, 'utf8'), writable: () => (fs.statSync(file).mode & 0o222) !== 0 };
}

const edit = (who) => ({ tool_name: 'Edit', tool_input: { file_path: who.file } });

(async () => {
  // own process: hooks run through spawnSync, which would freeze an in-process server
  const startServer = async (dir, open) => {
    const proc = spawn(process.execPath, ['-e', `
      const s = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))})
        .createServer({ dataDir: ${JSON.stringify(path.join(tmp, dir))}, token: 'secret', open: ${open} });
      s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise(r => proc.stdout.once('data', d => r(String(d).trim())));
    return { proc, url: `http://127.0.0.1:${port}` };
  };
  // HUDDLE_TEST_URL=http://localhost:8787 runs everything against an open server
  // (e.g. the Cloudflare worker under `wrangler dev`) instead of a local Node one
  const external = process.env.HUDDLE_TEST_URL;
  const { proc: server, url } = external ? { proc: { kill() {} }, url: external } : await startServer('server', false);
  const pub = external ? { proc: { kill() {} }, url: external } : await startServer('public', true);
  let token = 'secret', project = 'demo';
  if (external) ({ token, project } = await (await fetch(url + '/api/new', { method: 'POST', body: '{"name":"e2e"}' })).json());
  const alice = checkout('alice', 1001, url, token, project);
  const bob = checkout('bob', 2002, url, token, project);
  const carol = checkout('carol', 3003, url, token, project); // no MCP running, so no live sync
  let step = 'start';
  const ok = (s) => { step = s; console.log('✓', s); };

  try {
    alice.startMcp(); bob.startMcp();
    const init = await alice.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'huddle');
    await bob.rpc('initialize', {});
    const tools = (await alice.rpc('tools/list')).result.tools.map(t => t.name);
    assert(tools.includes('huddle_send') && tools.includes('huddle_view'));
    ok('MCP servers start and list tools');

    const start = alice.hook('session-start', {});
    assert(start.hookSpecificOutput.additionalContext.includes(`huddle project "${project}"`));
    ok('session-start hook briefs the agent');

    assert.equal(alice.hook('pre', edit(alice)), null);
    fs.writeFileSync(alice.file, 'v1 from alice\n');
    alice.hook('post', edit(alice));
    await until(() => bob.read() === 'v1 from alice\n', 8000, "alice's edit on bob's disk");
    await until(() => !bob.writable(), 4000, 'bob read-only');
    ok("alice's edit streams to bob's disk and bob's copy goes read-only");

    const denied = bob.hook('pre', edit(bob));
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, /locked by alice/);
    ok("bob's Edit on the locked file is refused with the holder's name");

    const view = await bob.tool('huddle_view', { path: 'shared.txt' });
    assert.match(view, /v1 from alice/);
    assert.match(view, /locked by alice/);
    ok('huddle_view shows the live version');

    // a shell command sneaking past the read-only bit (rename over it) gets reverted
    fs.writeFileSync(bob.file + '.tmp', 'bob was here\n');
    fs.renameSync(bob.file + '.tmp', bob.file);
    await until(() => bob.read() === 'v1 from alice\n', 6000, 'guard revert');
    assert(fs.readdirSync(path.join(bob.root, '.huddle', 'conflicts')).length >= 1);
    ok('out-of-band change to a locked file is reverted and backed up');

    assert.match(await alice.tool('huddle_send', { text: 'taking shared.txt, can you do the tests?', to: 'bob' }), /sent to bob/);
    const post = bob.hook('post', { tool_name: 'Read', tool_input: {} });
    assert.match(post.hookSpecificOutput.additionalContext, /alice → you.*can you do the tests/);
    ok("alice's message lands in bob's context via the PostToolUse hook");

    await bob.tool('huddle_send', { text: 'sure, on it', to: 'alice' });
    const stopA = alice.hook('stop', {});
    assert.equal(stopA.decision, 'block');
    assert.match(stopA.reason, /sure, on it/);
    assert.equal(alice.hook('stop', { stop_hook_active: true }), null);
    await until(() => bob.writable(), 6000, 'bob writable again');
    ok('stop hook releases locks and makes alice answer a direct message first');

    assert.equal(bob.hook('pre', edit(bob)), null);
    fs.writeFileSync(bob.file, 'v2 from bob\n');
    bob.hook('post', edit(bob));
    await until(() => alice.read() === 'v2 from bob\n', 8000, "bob's edit at alice");
    ok('lock passes to bob and his edit reaches alice');

    bob.hook('stop', {});
    // carol has no sync running and still has v0: her edit is stopped and her copy refreshed
    const stale = carol.hook('pre', edit(carol));
    assert.equal(stale.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(stale.hookSpecificOutput.permissionDecisionReason, /out of date/);
    assert.equal(carol.read(), 'v2 from bob\n');
    ok("a stale checkout gets refreshed before its edit can clobber bob's work");
    carol.hook('session-end', {});

    assert.match(await alice.tool('huddle_lock', { paths: ['shared.txt'], hold: true, note: 'refactor' }), /locked shared.txt/);
    alice.hook('stop', {});
    assert.match(await bob.tool('huddle_status'), /shared\.txt: alice.*held.*refactor/);
    ok('held locks survive the end of a turn');

    setTimeout(() => alice.tool('huddle_unlock', {}), 800);
    const waited = await bob.tool('huddle_wait', { path: 'shared.txt', timeout_seconds: 10 });
    assert.match(waited, /now locked by you/);
    ok('huddle_wait blocks until the file frees up, then locks it');

    const inbox = bob.tool('huddle_inbox', { wait_seconds: 10 });
    await sleep(300);
    await alice.tool('huddle_send', { text: 'ping' });
    assert.match(await inbox, /ping/);
    ok('huddle_inbox can block for a reply');

    assert.match(await (await fetch(url + '/app')).text(), /<title>huddle<\/title>/);
    assert.match(await (await fetch(url + '/')).text(), /Try the live demo/);
    const bad = await fetch(url + `/api/p/${project}/state`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
    ok('the landing page and the dashboard are served, and a wrong token is rejected');

    // shared knowledge: PROJECT.md, memory, skills
    bob.hook('post', { tool_name: 'Read', tool_input: {} }); // bob has now seen the (empty) shared state
    assert.match(await alice.tool('huddle_project', { new_text: '# Calc\nUse tabs. Run tests with make test.\n', base_version: 0 }), /v1/);
    assert.match(await bob.tool('huddle_project', { new_text: 'stale write', base_version: 0 }), /changed since you read it/);
    assert.match(await alice.tool('huddle_remember', { title: 'tests need FOO=1', text: 'otherwise the db fixture hangs' }), /saved/);
    assert.match(await alice.tool('huddle_save_skill', { name: 'Release Steps', description: 'Use when cutting a release', instructions: '1. bump version\n2. tag' }), /release-steps/);
    const skillFile = path.join(bob.root, '.claude', 'skills', 'release-steps', 'SKILL.md');
    await until(() => fs.existsSync(skillFile), 8000, "skill on bob's disk");
    assert.match(fs.readFileSync(skillFile, 'utf8'), /^---\nname: release-steps\ndescription: Use when cutting a release\n---/);
    await until(() => fs.readFileSync(path.join(bob.root, '.huddle', 'shared', 'PROJECT.md'), 'utf8').includes('Use tabs'), 8000, 'PROJECT.md on disk');
    fs.rmSync(path.join(bob.root, '.huddle', 'sessions'), { recursive: true, force: true }); // skip the inbox throttle
    bob.hook('session-start', {});
    await alice.tool('huddle_remember', { title: 'ports', text: 'dev server is on 5173' });
    const told = bob.hook('post', { tool_name: 'Read', tool_input: {} }).hookSpecificOutput.additionalContext;
    assert.match(told, /New shared memory from alice: ports: dev server is on 5173/);
    const brief = carol.hook('session-start', {}).hookSpecificOutput.additionalContext;
    assert.match(brief, /Use tabs\. Run tests with make test/);
    assert.match(brief, /tests need FOO=1: otherwise the db fixture hangs/);
    assert.match(brief, /release-steps: Use when cutting a release/);
    assert(fs.existsSync(path.join(carol.root, '.claude', 'skills', 'release-steps', 'SKILL.md')));
    assert.match(await bob.tool('huddle_recall', { query: 'fixture' }), /FOO=1/);
    await alice.tool('huddle_delete_skill', { name: 'release-steps' });
    await until(() => !fs.existsSync(skillFile), 8000, 'skill removed from bob');
    carol.hook('session-end', {});
    ok('PROJECT.md, memories and skills reach every agent, on disk and in context');

    // activity: a conversation is only shared when someone opts in (the test agents all have)
    const aliceCfg = path.join(alice.root, '.huddle', 'config.json');
    const bareCfg = { ...JSON.parse(fs.readFileSync(aliceCfg, 'utf8')) };
    delete bareCfg.shareActivity;
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-share-'));
    fs.mkdirSync(path.join(bare, '.huddle'));
    fs.writeFileSync(path.join(bare, '.huddle', 'config.json'), JSON.stringify(bareCfg));
    assert.equal(require('../src/client').loadConfig(bare).shareActivity, 'tools', 'sharing defaults to tool steps only');
    fs.rmSync(bare, { recursive: true, force: true });
    // prompts, replies and tool calls stream to the others
    const transcript = path.join(alice.root, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'old prompt' } }) + '\n');
    fs.rmSync(path.join(alice.root, '.huddle', 'sessions'), { recursive: true, force: true });
    alice.hook('session-start', { transcript_path: transcript });
    alice.hook('prompt', { transcript_path: transcript, prompt: 'add a multiply function' });
    fs.appendFileSync(transcript, [
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: "I'll add multiply." }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pytest -q' } }] } },
      { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent chatter' }] } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    alice.hook('post', { tool_name: 'Bash', tool_input: {}, transcript_path: transcript });
    alice.hook('stop', { transcript_path: transcript, stop_hook_active: true, last_assistant_message: 'Done, multiply is in.' });
    // Claude Code writes the final reply after the Stop hook; it must not be sent twice
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done, multiply is in.' }] } }) + '\n');
    alice.hook('prompt', { transcript_path: transcript, prompt: 'thanks' });
    const seen = await bob.tool('huddle_activity', { agent: 'alice' });
    assert.match(seen, /user asked: add a multiply function[\s\S]*said: I'll add multiply\.[\s\S]*→ Bash: pytest -q[\s\S]*said: Done, multiply is in\.[\s\S]*finished its turn[\s\S]*user asked: thanks/);
    assert.equal(seen.split('Done, multiply is in.').length, 2);
    assert(!/old prompt|secret|subagent chatter/.test(seen));
    ok("each Claude's prompts, replies and tool calls show up for the others");

    // a private turn shares nothing, not even the reply that lands after Stop
    alice.hook('prompt', { transcript_path: transcript, prompt: 'private: what do you think of bob honestly' });
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'secret opinion' }, { type: 'tool_use', name: 'Read', input: { file_path: 'diary.txt' } }] } }) + '\n');
    alice.hook('post', { tool_name: 'Read', tool_input: {}, transcript_path: transcript });
    alice.hook('stop', { transcript_path: transcript, stop_hook_active: true, last_assistant_message: 'final secret' });
    fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'final secret' }] } }) + '\n');
    alice.hook('prompt', { transcript_path: transcript, prompt: 'back to work: run the tests' });
    const after = await bob.tool('huddle_activity', { agent: 'alice', limit: 200 });
    assert(!/honestly|secret|diary/.test(after), after);
    assert.match(after, /user asked: back to work: run the tests/);
    ok('a prompt starting with "private:" keeps that whole turn out of the feed');

    const api = (ep, body) => fetch(`${url}/api/p/${project}/${ep}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) }).then(r => r.json());

    // stats: conversations, turns, time and tokens per person, each message's usage counted once
    const statsOf = async (name) => (await api('stats')).stats[name] || { conversations: 0, turns: 0, activeMs: 0, models: {} };
    const before0 = await statsOf('alice');
    const statsLog = path.join(alice.root, 'stats-transcript.jsonl');
    const usageLine = (id, output) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-test', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }, content: [{ type: 'text', text: 'x' }] } }) + '\n';
    fs.writeFileSync(statsLog, usageLine('old', 999)); // before this conversation joined: not counted
    alice.hook('prompt', { transcript_path: statsLog, session_id: 'conv-1', prompt: 'private: count me' });
    fs.appendFileSync(statsLog, usageLine('m1', 5) + usageLine('m1', 40) + usageLine('m2', 7)); // m1 spans two content blocks
    alice.hook('stop', { transcript_path: statsLog, session_id: 'conv-1', stop_hook_active: true, last_assistant_message: 'x' });
    alice.hook('prompt', { transcript_path: statsLog, session_id: 'conv-1', prompt: 'and again' });
    fs.appendFileSync(statsLog, usageLine('m3', 3));
    alice.hook('stop', { transcript_path: statsLog, session_id: 'conv-1', stop_hook_active: true, last_assistant_message: 'x' });
    const s1 = await statsOf('alice');
    assert.equal(s1.conversations - before0.conversations, 1, 'one new conversation');
    assert.equal(s1.turns - before0.turns, 2, 'two prompts');
    const m = s1.models['claude-test'];
    assert.deepEqual([m.messages, m.output, m.input, m.cacheRead], [3, 40 + 7 + 3, 30, 3000]);
    assert(s1.activeMs >= before0.activeMs);
    assert.match(await (await fetch(url + "/app")).text(), /id="root"/);
    ok('the stats page counts conversations, prompts, time with Claude and tokens per person (numbers only)');

    // autopilot: every Claude is active for the team by default; "requests" only runs what is sent to it
    const runs = () => { try { return fs.readFileSync(path.join(alice.root, 'claude-runs.txt'), 'utf8'); } catch { return ''; } };
    const human = { id: 'human:carol', name: 'carol', kind: 'human' };
    await until(async () => (await api('state')).agents.some(a => a.name === 'alice' && a.runner === 'full'), 8000, "alice's runner, active by default");
    assert.match(await alice.tool('huddle_autopilot', { mode: 'requests' }), /requests only/);
    await until(async () => (await api('state')).agents.some(a => a.name === 'alice' && a.runner === 'requests'), 8000, "alice's runner on requests");
    await api('goal', { agent: human, text: 'rename add to plus', to: 'alice' });
    await until(() => /rename add to plus/i.test(runs()), 10000, 'request run by alice\'s Claude');
    await until(async () => (await api('board')).tasks.some(t => t.title === 'Rename add to plus' && t.status === 'done'), 8000, 'request marked done');
    // the answer goes back to whoever asked, with any command that needs alice's OK
    await until(async () => (await api('messages')).messages.some(m => m.to === 'carol' && m.fromName === 'alice'
      && /Re your request "Rename add to plus"/.test(m.text) && /Renamed add to plus/.test(m.text) && /Needs alice's OK: npm test/.test(m.text)), 8000, 'reply to carol');
    await api('goal', { agent: human, text: 'whole team: write docs' });
    await sleep(1500);
    assert(!/write docs/.test(runs()), 'requests mode must not take team-wide goals');
    assert.match(await alice.tool('huddle_autopilot', { mode: 'on' }), /active/);
    await until(async () => (await api('board')).goals.some(g => g.text === 'whole team: write docs' && g.planner), 10000, 'full autopilot plans the team goal');
    // a direct message while alice's session is idle gets answered in the background, once, marked auto
    fs.writeFileSync(path.join(alice.root, '.huddle', 'turns.json'), '{}');
    const asked = (await api('message', { agent: { id: 'bob#x', name: 'bob', kind: 'agent' }, to: 'alice', text: 'where do the tests live?' })).message.at;
    await until(async () => (await api('messages')).messages.some(m => m.at >= asked && m.fromName === 'alice' && m.to === 'bob' && m.auto && /test\//.test(m.text)), 10000, 'background answer to bob');
    await api('message', { agent: human, to: 'alice', text: 'thanks', auto: true });
    await sleep(1500);
    { const am = (await api('messages')).messages.filter(m => m.at >= asked && m.fromName === 'alice' && m.auto); assert.equal(am.length, 1, 'automatic answers never start another run: ' + JSON.stringify(am)); }
    // big prompts: huddle_distribute gives the heaviest part to whoever has the most of their window left
    await api('usage', { agent: { name: 'alice' }, five: 40 });
    await api('usage', { agent: { name: 'bob' }, five: 10 });
    assert.equal((await api('state')).usage.bob.five, 10);
    const dist = await bob.tool('huddle_distribute', { summary: 'three things', tasks: [
      { title: 'light part', effort: 'light' }, { title: 'heavy part', effort: 'heavy' }, { title: 'medium part', effort: 'medium' }, { title: 'anyone part' }, { title: 'my part', effort: 'light', keep_for_me: true }] });
    assert.match(dist, /my part \(light\) → you, here/);
    const tb = (await api('board')).tasks;
    const owner = (t) => tb.find(x => x.title === t).owner;
    assert.deepEqual([owner('heavy part'), owner('medium part')], ['bob', 'alice'], 'heavy work goes where there is most room');
    assert(tb.find(x => x.title === 'my part').held, 'kept parts are held by the session');
    assert.equal(owner('anyone part'), null, 'a part with no size stays open');
    assert.match(alice.hook('prompt', { prompt: 'Make the task titles shorter. Also switch the colour scheme to pink and blue. And then add a project switcher to the header, plus a guided tour of the dashboard that points at each part of the page while it explains what that part does.' }).hookSpecificOutput.additionalContext, /huddle_distribute/);
    assert.match(await alice.tool('huddle_autopilot', { mode: 'off' }), /off/);
    await sleep(500);
    const before = runs();
    await api('goal', { agent: human, text: 'do this later', to: 'alice' });
    await sleep(2000);
    assert.equal(runs(), before, 'off means requests wait');
    assert.equal((await api('board')).tasks.find(t => t.title === 'Do this later').status, 'todo');
    ok("Claudes are active by default and answer each other once; big prompts are split by remaining usage; off makes requests wait");

    // whatever the person asks, their Claude reads the team's messages and open requests first
    await api('message', { agent: human, to: 'alice', text: 'please update huddle' });
    const first = alice.hook('prompt', { prompt: 'fix the typo in the readme' }).hookSpecificOutput.additionalContext;
    assert(first.startsWith("huddle: read this first, before your user's prompt"), first);
    assert.match(first, /please update huddle/);
    assert.match(first, /Requests sent to you \(alice's Claude\):\n- \[\w+\] from carol, todo: Do this later/);
    assert.match(first, /runner is off, so these wait for you/);
    ok('every prompt starts with the messages and open requests sent to that Claude');

    // people can name their Claude; the team can send it work by that name
    assert.match(await alice.tool('huddle_name', { name: 'Pip' }), /You are now "Pip" \(alice's Claude\)/);
    const named = alice.hook('prompt', { prompt: 'hi' }).hookSpecificOutput.additionalContext;
    assert.match(named, /alice named you "Pip"/);
    assert.match(named, /Requests sent to you \(Pip, alice's Claude\)/);
    assert(!/named you/.test(alice.hook('prompt', { prompt: 'again' }).hookSpecificOutput.additionalContext), 'only said once');
    await api('goal', { agent: human, text: 'task for pip', to: 'pip' });
    assert.equal((await api('board')).tasks.find(t => t.title === 'Task for pip').owner, 'alice');
    await api('message', { agent: human, to: 'Pip', text: 'hello pip' });
    assert.equal((await api('messages')).messages.find(m => m.text === 'hello pip').to, 'alice');
    assert.match((await api('setting', { agent: human, aiName: 'pip' })).error, /already someone/);
    assert.match((await api('setting', { agent: human, aiName: 'alice' })).error, /already someone/);
    assert.match(await alice.tool('huddle_name', {}), /alice named you "Pip"/);
    assert.match(await alice.tool('huddle_name', { name: '' }), /cleared/);
    assert.match(alice.hook('prompt', { prompt: 'x' }).hookSpecificOutput.additionalContext, /you are alice's Claude again/);
    ok('people can name their Claude, it learns the name, and others can send it work by that name');

    // what each Claude is working on reaches the others, and only when it changes
    alice.hook('prompt', { prompt: 'baseline' });
    bob.hook('prompt', { prompt: 'add a search box to the parts library panel' });
    const teamSeen = alice.hook('prompt', { prompt: 'what now' }).hookSpecificOutput.additionalContext;
    assert.match(teamSeen, /what the other Claudes are doing changed:\n- bob's Claude: Add a search box to the parts library panel/);
    assert(!/Claudes are doing/.test((alice.hook('prompt', { prompt: 'and now' }).hookSpecificOutput || {}).additionalContext || ''), 'unchanged team is not repeated');
    bob.hook('prompt', { prompt: 'yes go ahead' });
    assert(!/Claudes are doing/.test((alice.hook('prompt', { prompt: 'again' }).hookSpecificOutput || {}).additionalContext || ''), 'a short follow-up keeps the status');
    await bob.tool('huddle_set_status', { status: 'parts search: filtering by category' });
    assert.match(alice.hook('prompt', { prompt: 'x' }).hookSpecificOutput.additionalContext, /- bob's Claude: parts search: filtering by category/);
    assert.match(await alice.tool('huddle_status'), /Recently started work[\s\S]*bob, \d+s ago: Add a search box[\s\S]*bob, \d+s ago: parts search/);
    ok("each Claude's current work reaches the others as it changes, and only then");

    // folder locks: only one Claude edits inside a locked folder, and locks never overlap
    fs.mkdirSync(path.join(alice.root, 'lib', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(bob.root, 'lib', 'sub'), { recursive: true });
    assert.match(await alice.tool('huddle_lock', { paths: ['lib/'], note: 'reworking lib' }), /locked lib\/ \(the whole folder/);
    const inLib = { tool_name: 'Write', tool_input: { file_path: path.join(bob.root, 'lib', 'sub', 'x.js') } };
    const no = bob.hook('pre', inLib);
    assert.equal(no.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(no.hookSpecificOutput.permissionDecisionReason, /lib\/sub\/x\.js is inside lib\/, a folder locked by alice/);
    assert.match(await bob.tool('huddle_lock', { paths: ['lib/sub/'] }), /overlaps lib\/ \(a folder\), locked by alice/);
    assert.match(await bob.tool('huddle_lock', { paths: ['docs/a.md'] }), /locked docs\/a\.md/);
    assert.match(await alice.tool('huddle_lock', { paths: ['docs/'] }), /overlaps docs\/a\.md, locked by bob/);
    alice.hook('stop', { stop_hook_active: true }); // the end of a turn keeps the folder
    assert.equal(bob.hook('pre', inLib).hookSpecificOutput.permissionDecision, 'deny');
    assert.match(await alice.tool('huddle_status'), /lib\/ \(whole folder\): you/);
    assert.match(await alice.tool('huddle_unlock', { paths: ['lib/'] }), /released lib\//);
    assert.equal(bob.hook('pre', inLib), null);
    await bob.tool('huddle_unlock', {});
    ok('a locked folder is editable by one Claude only, and no two locks overlap');

    // hand-off notes: where a session left off reaches the team and the next session
    assert.match(await bob.tool('huddle_handoff', { text: 'parts search works for names; next: filter by category' }), /hand-off saved/);
    const hand = alice.hook('prompt', { prompt: 'what next' }).hookSpecificOutput.additionalContext;
    assert.match(hand, /left a hand-off note:\n- bob, \d+s ago: parts search works for names; next: filter by category/);
    assert(!/hand-off/.test((alice.hook('prompt', { prompt: 'and' }).hookSpecificOutput || {}).additionalContext || ''), 'a note is told once');
    // carol's session ends without one: huddle writes it from her status and the files she edited
    fs.rmSync(path.join(carol.root, '.huddle', 'sessions'), { recursive: true, force: true });
    carol.hook('session-start', {});
    carol.hook('prompt', { prompt: 'tighten the error messages in notes.txt' });
    const notesEdit = { tool_name: 'Write', tool_input: { file_path: path.join(carol.root, 'notes.txt') } };
    assert.equal(carol.hook('pre', notesEdit), null);
    fs.writeFileSync(path.join(carol.root, 'notes.txt'), 'clearer errors\n');
    carol.hook('post', notesEdit);
    carol.hook('session-end', {});
    const autoNote = (await api('handoffs')).handoffs.find(h => h.name === 'carol');
    assert(autoNote && autoNote.auto && /Was on: tighten the error messages/i.test(autoNote.text) && autoNote.files.includes('notes.txt'), JSON.stringify(autoNote));
    assert.match(carol.hook('session-start', {}).hookSpecificOutput.additionalContext, /Where people left off[\s\S]*you \(an earlier session\)[^\n]*tighten the error[\s\S]*- bob, /i);
    carol.hook('session-end', {});
    assert.match(await alice.tool('huddle_status'), /Hand-off notes[\s\S]*bob[^\n]*parts search works/);
    ok('hand-off notes reach the team and the next session, written by huddle when Claude leaves none');

    // one person, one entry: a name in other capitals is the same person, old sessions drop off
    assert.equal((await api('hello', { agent: { id: 'BOB#web', name: 'BOB', kind: 'human', host: 'x' } })).you.name, 'bob');
    for (const id of ['dave#1', 'dave#2', 'dave#3']) {
      await api('hello', { agent: { id, name: 'dave', kind: 'agent' } });
      await api('bye', { agent: { id } });
    }
    await api('tidy', { agent: { id: 'h#tidy', name: 'carol', kind: 'human' } });
    assert.equal((await api('state')).agents.filter(a => a.name === 'dave').length, 1);
    ok('names that differ in capitals are one person, and old sessions leave the team list');

    // secrets never leave the machine: no lock, no live copy
    fs.writeFileSync(path.join(alice.root, '.env.local'), 'GEMINI_API_KEY=secret123\n');
    const envEdit = { tool_name: 'Edit', tool_input: { file_path: path.join(alice.root, '.env.local') } };
    assert.equal(alice.hook('pre', envEdit), null);
    alice.hook('post', envEdit);
    const st2 = await api('state');
    assert(!st2.locks.some(l => l.path === '.env.local') && !st2.files.some(f => f.path === '.env.local'), '.env.local must not be shared');
    ok('.env files and git-ignored files are never locked or shared');

        // open mode: anyone can create a project, and each project's token only opens that project
    const mk = async (name) => (await fetch(pub.url + '/api/new', { method: 'POST', body: JSON.stringify({ name }) })).json();
    const p1 = await mk('My App'), p2 = await mk('other');
    assert.match(p1.project, /^my-app-[0-9a-f]{6,8}$/);
    const st = (proj, tok) => fetch(`${pub.url}/api/p/${proj}/state`, { headers: { authorization: 'Bearer ' + tok } }).then(r => r.status);
    assert.equal(await st(p1.project, p1.token), 200);
    assert.equal(await st(p2.project, p1.token), 401);
    assert.equal(await st('made-up', p1.token), 401);
    if (!external) {
      assert.equal(await st(p2.project, 'secret'), 200);
      assert.equal((await fetch(url + '/api/new', { method: 'POST', body: '{}' })).status, 401);
    }
    ok("open mode hands out per-project tokens that can't open other projects");

    const joinOut = spawnSync(process.execPath, [CLI, 'new', 'demo', '--server', pub.url, '--no-join'], { encoding: 'utf8' }).stdout;
    const code = joinOut.match(/join (\S+)/)[1];
    assert.match(code, /^[A-Za-z0-9][\w-]{11}$/, 'a short invite');
    assert.match(joinOut, new RegExp(`--server ${pub.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'with its server, since it isn\'t the public one');
    const inv = await (await fetch(`${pub.url}/api/invite/${code}`)).json();
    assert.equal(await st(inv.project, inv.token), 200);
    assert.equal((await fetch(`${pub.url}/api/invite/AAAAAAAAAAAA`)).status, 404);
    ok('`huddle new` prints a working short invite');

    console.log('\nall good');
  } catch (e) {
    console.error(`\n✗ failed after "${step}":`, e);
    process.exitCode = 1;
  } finally {
    alice.stop(); bob.stop();
    server.kill();
    pub.proc.kill();
    await sleep(200);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

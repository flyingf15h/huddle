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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return; } catch {}
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(100);
  }
}

function checkout(name, pid, server, token) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.huddle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.huddle', 'config.json'), JSON.stringify({ server, token, project: 'demo', name }));
  fs.writeFileSync(path.join(root, 'shared.txt'), 'v0\n');
  const env = { ...process.env, HUDDLE_SESSION: String(pid), HUDDLE_ROOT: root };
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
  const { proc: server, url } = await startServer('server', false);
  const pub = await startServer('public', true);
  const alice = checkout('alice', 1001, url, 'secret');
  const bob = checkout('bob', 2002, url, 'secret');
  const carol = checkout('carol', 3003, url, 'secret'); // no MCP running, so no live sync
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
    assert.match(start.hookSpecificOutput.additionalContext, /huddle project "demo"/);
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

    const res = await fetch(url + '/');
    assert.match(await res.text(), /<title>huddle<\/title>/);
    const bad = await fetch(url + '/api/p/demo/state', { headers: { authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
    ok('dashboard is served and a wrong token is rejected');

    // open mode: anyone can create a project, and each project's token only opens that project
    const mk = async (name) => (await fetch(pub.url + '/api/new', { method: 'POST', body: JSON.stringify({ name }) })).json();
    const p1 = await mk('My App'), p2 = await mk('other');
    assert.match(p1.project, /^my-app-[0-9a-f]{6}$/);
    const st = (proj, tok) => fetch(`${pub.url}/api/p/${proj}/state`, { headers: { authorization: 'Bearer ' + tok } }).then(r => r.status);
    assert.equal(await st(p1.project, p1.token), 200);
    assert.equal(await st(p2.project, p1.token), 401);
    assert.equal(await st('made-up', p1.token), 401);
    assert.equal(await st(p2.project, 'secret'), 200);
    assert.equal((await fetch(url + '/api/new', { method: 'POST', body: '{}' })).status, 401);
    ok("open mode hands out per-project tokens that can't open other projects");

    const joinOut = spawnSync(process.execPath, [CLI, 'new', 'demo', '--server', pub.url], { encoding: 'utf8' }).stdout;
    const code = joinOut.match(/join (\S+)/)[1];
    const inv = JSON.parse(Buffer.from(code, 'base64url'));
    assert.equal(await st(inv.p, inv.t), 200);
    ok('`huddle new` prints a working invite');

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

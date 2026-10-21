// Unity and Blender through their MCP servers: which calls count as changes, which files they name,
// registering the servers for each kind of agent, keeping them out of background clones, and two
// teammates' hooks locking the scene files their editors change.
'use strict';
require('./winbin');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'src', 'cli.js');
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'huddle-apps-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
process.env.HOME = process.env.USERPROFILE = home; // registrations are read from ~/.claude.json
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' };
const ok = (s) => console.log('✓', s);
const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

// a stand-in `claude` that records `claude mcp add-json` calls the way the real one stores them
const fakeBin = path.join(tmp, 'bin');
fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'claude'), `#!/usr/bin/env node
const fs = require('fs'), path = require('path'), a = process.argv.slice(2);
const file = path.join(${JSON.stringify(home)}, '.claude.json');
let all = {}; try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
const p = (all.projects = all.projects || {})[process.cwd()] = (all.projects || {})[process.cwd()] || {};
p.mcpServers = p.mcpServers || {};
if (a[0] === 'mcp' && a[1] === 'add-json') p.mcpServers[a[4]] = JSON.parse(a[5]);
if (a[0] === 'mcp' && a[1] === 'remove') delete p.mcpServers[a[a.length - 1]];
fs.writeFileSync(file, JSON.stringify(all));
`, { mode: 0o755 });
process.env.PATH = fakeBin + path.delimiter + process.env.PATH;

function unityRepo(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'ProjectSettings'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', 'Scenes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.0.30f1\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scenes', 'Main.unity'), '%YAML 1.1\nmain: 0\n');
  fs.writeFileSync(path.join(root, 'Assets', 'Scenes', 'Menu.unity'), '%YAML 1.1\nmenu: 0\n');
  fs.writeFileSync(path.join(root, 'ship.blend'), 'BLENDER-v400');
  return root;
}

function person(name, pid, url, token, project) {
  const root = unityRepo(name);
  fs.mkdirSync(path.join(root, '.huddle'), { recursive: true });
  fs.writeFileSync(path.join(root, '.huddle', 'config.json'), JSON.stringify({ server: url, token, project, name, summarize: false, notify: false, shareActivity: 'full' }));
  sh(root, 'init', '-q'); sh(root, 'add', '-A', ':!.huddle'); sh(root, 'commit', '-qm', 'init');
  const env = { ...process.env, ...gitEnv, HUDDLE_SESSION: String(pid), HUDDLE_ROOT: root };
  const hook = (event, input) => {
    const r = spawnSync(process.execPath, [CLI, 'hook', event], { input: JSON.stringify({ cwd: root, session_id: 's' + pid, ...input }), env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  };
  return { name, root, hook, write: (f, t) => fs.writeFileSync(path.join(root, f), t) };
}

(async () => {
  const apps = require('../src/apps');

  // ---- which editor, and whether a call changes anything
  assert.equal(apps.match('mcp__blender__execute_blender_code').id, 'blender');
  assert.equal(apps.match('mcp__UnityMCP__manage_scene').id, 'unity');
  assert.equal(apps.match('mcp__unity-mcp__whatever_unity_6_calls_it').id, 'unity');
  assert.equal(apps.match('mcp__studio__manage_gameobject').id, 'unity'); // registered under another name
  assert.equal(apps.match('mcp__huddle__huddle_status'), null);
  assert.equal(apps.match('mcp__github__search_code'), null);
  assert.equal(apps.match('Edit'), null);
  const u = apps.match('mcp__unity__manage_scene'), b = apps.match('mcp__blender__look');
  assert.equal(apps.changes(u, { action: 'get_hierarchy' }), false);
  assert.equal(apps.changes(u, { action: 'save' }), true);
  assert.equal(apps.changes(b, {}), false);
  assert.equal(apps.changes(apps.match('mcp__blender__execute_blender_code'), { code: 'print(1)' }), true);
  const batch = apps.match('mcp__unity__batch_execute');
  assert.equal(apps.changes(batch, { commands: [{ tool: 'find_gameobjects', params: {} }, { tool: 'manage_scene', params: { action: 'get_active' } }] }), false);
  assert.equal(apps.changes(batch, { commands: [{ tool: 'find_gameobjects', params: {} }, { tool: 'manage_gameobject', params: { action: 'create' } }] }), true);
  ok('Unity and Blender calls are told apart, and only calls that can change the project count as changes');

  // ---- the files a call names, relative to the project
  const repo = unityRepo('paths');
  assert.deepEqual(apps.targets(u, { action: 'save', name: 'Main', path: 'Scenes' }, repo), ['Assets/Scenes/Main.unity']);
  assert.deepEqual(apps.targets(apps.match('mcp__unity__manage_script'), { action: 'update', name: 'Player', path: 'Assets/Scripts' }, repo), ['Assets/Scripts/Player.cs']);
  assert.deepEqual(apps.targets(u, { action: 'load', path: 'Assets/Scenes/Menu.unity' }, repo), ['Assets/Scenes/Menu.unity']);
  assert.deepEqual(apps.targets(apps.match('mcp__blender__execute_blender_code'), { code: `bpy.ops.wm.save_as_mainfile(filepath="${path.join(repo, 'art', 'car.blend').replace(/\\/g, '/')}")` }, repo), ['art/car.blend']);
  assert.deepEqual(apps.targets(u, { action: 'save', path: '/somewhere/else/x.unity' }, repo), []);
  const nested = path.join(tmp, 'nested');
  fs.mkdirSync(nested);
  fs.renameSync(unityRepo('nested-game'), path.join(nested, 'game'));
  assert.deepEqual(apps.targets(u, { action: 'save', path: 'Assets/Scenes/Main.unity' }, nested), ['game/Assets/Scenes/Main.unity']);
  ok('files named in a call are found (Unity\'s Assets-relative paths, a project in a subfolder, Blender save paths)');

  // ---- registration for Codex and Cursor, beside the project's own servers
  const cdx = path.join(tmp, 'cdx');
  fs.mkdirSync(path.join(cdx, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(cdx, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.theirs]\ncommand = "t"\n');
  assert.deepEqual(apps.install(cdx, 'codex', ['blender']), ['blender']);
  assert.deepEqual(apps.install(cdx, 'codex', ['blender', 'unity']), ['unity']);
  let toml = fs.readFileSync(path.join(cdx, '.codex', 'config.toml'), 'utf8');
  assert.match(toml, /\[mcp_servers\.blender\]\ncommand = "uvx"\nargs = \["mcp-for-blender"\]/);
  assert.match(toml, /\[mcp_servers\.unity\]/);
  assert.equal(toml.match(/huddle-apps-begin/g).length, 1);
  apps.uninstall(cdx, 'codex', 'blender');
  toml = fs.readFileSync(path.join(cdx, '.codex', 'config.toml'), 'utf8');
  assert.ok(!/mcp_servers\.blender/.test(toml) && /mcp_servers\.unity/.test(toml) && /mcp_servers\.theirs/.test(toml));
  apps.uninstall(cdx, 'codex', 'unity');
  assert.equal(fs.readFileSync(path.join(cdx, '.codex', 'config.toml'), 'utf8').trim(), 'model = "x"\n\n[mcp_servers.theirs]\ncommand = "t"');
  const cur = path.join(tmp, 'cur');
  fs.mkdirSync(path.join(cur, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(cur, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { myblender: { command: 'uvx', args: ['blender-mcp'] } } }));
  assert.deepEqual(apps.install(cur, 'cursor', ['blender', 'unity']), ['unity']); // their own Blender server counts
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(cur, '.cursor', 'mcp.json'), 'utf8')).mcpServers).sort(), ['myblender', 'unity']);
  ok('Codex and Cursor get the editor servers they lack, next to their own, and lose only those');

  // ---- background clones never get an editor server
  const ap = require('../src/autopilot');
  const fm = path.join(tmp, 'fm');
  fs.mkdirSync(fm);
  fs.writeFileSync(path.join(fm, '.mcp.json'), JSON.stringify({ mcpServers: { blender: { command: 'uvx', args: ['mcp-for-blender'] }, game: { command: 'uvx', args: ['--from', 'mcpforunityserver', 'mcp-for-unity'] }, db: { command: 'pg' } } }));
  assert.deepEqual(Object.keys(ap.folderMcpServers(fm)), ['db']);
  ok('a background Claude gets the person\'s other MCP servers but not Unity or Blender');

  // ---- two teammates through their hooks
  const proc = spawn(process.execPath, ['-e', `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'server.js'))}).createServer({ dataDir: ${JSON.stringify(path.join(tmp, 'server'))}, open: true });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));`], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = `http://127.0.0.1:${await new Promise(r => proc.stdout.once('data', d => r(String(d).trim())))}`;
  const { project, token } = await (await fetch(url + '/api/new', { method: 'POST', body: '{"name":"game"}' })).json();
  const api = (ep, body) => fetch(`${url}/api/p/${project}/${ep}`, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body && JSON.stringify(body) }).then(r => r.json());
  const boss = { id: 'h#boss', name: 'boss', kind: 'human' };

  try {
    const set = await api('project-setting', { agent: boss, apps: ['unity', 'blender', 'maya'] });
    assert.deepEqual(set.settings.apps, ['unity', 'blender']);

    const ana = person('ana', 501, url, token, project);
    const start = ana.hook('session-start', { source: 'startup' });
    assert.match(start.systemMessage || '', /huddle added the Unity and Blender tools/);
    assert.match(start.hookSpecificOutput.additionalContext, /This project uses Unity and Blender through MCP/);
    const reg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects[ana.root].mcpServers;
    assert.deepEqual(reg.blender, { type: 'stdio', command: 'uvx', args: ['mcp-for-blender'] });
    assert.equal(reg.unity.args[1], 'mcpforunityserver');
    assert.ok(!/huddle added/.test(ana.hook('session-start', { source: 'startup' }).systemMessage || ''));
    ok('a teammate\'s first session registers the project\'s editor servers and briefs Claude; the next one doesn\'t repeat it');

    // a read leaves everything alone; a change through the editor locks the scene it changed on disk
    assert.equal(ana.hook('pre', { tool_name: 'mcp__unity__manage_scene', tool_input: { action: 'get_hierarchy' } }), null);
    ana.write('Assets/Scenes/Main.unity', '%YAML 1.1\nmain: 1\n');
    ana.hook('post', { tool_name: 'mcp__unity__manage_gameobject', tool_input: { action: 'modify', target: 'Player' } });
    let locks = (await api('state')).locks;
    assert.deepEqual(locks.map(l => [l.path, l.holderName]), [['Assets/Scenes/Main.unity', 'ana']]);
    ok('a Unity change locks the scene it changed, and reads lock nothing');

    // the other teammate can't save that scene through their editor, can work on another one, and is
    // told which editor files are taken
    const ben = person('ben', 502, url, token, project);
    ben.hook('session-start', { source: 'startup' });
    const refused = ben.hook('pre', { tool_name: 'mcp__unity__manage_scene', tool_input: { action: 'save', path: 'Assets/Scenes/Main.unity' } });
    assert.equal(refused.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(refused.hookSpecificOutput.permissionDecisionReason, /Assets\/Scenes\/Main\.unity locked by ana/);
    const other = ben.hook('pre', { tool_name: 'mcp__unity__manage_scene', tool_input: { action: 'load', name: 'Menu', path: 'Scenes' } });
    assert.notEqual(other.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(other.hookSpecificOutput.additionalContext, /don't change or save them through Unity: Assets\/Scenes\/Main\.unity \(ana\)/);
    assert.equal(ben.hook('pre', { tool_name: 'mcp__unity__manage_gameobject', tool_input: { action: 'create' } }), null); // once a minute is enough
    locks = (await api('state')).locks;
    assert.ok(locks.some(l => l.path === 'Assets/Scenes/Menu.unity' && l.holderName === 'ben'));
    ok('a teammate is refused a scene someone else holds, gets the one they named, and is told what\'s taken');

    // a change that reaches a held file anyway is caught after the fact
    ben.write('Assets/Scenes/Main.unity', '%YAML 1.1\nmain: 2\n');
    ben.write('ship.blend', 'BLENDER-v400 changed');
    const after = ben.hook('post', { tool_name: 'mcp__unity__manage_scene', tool_input: { action: 'save' } });
    assert.match(after.hookSpecificOutput.additionalContext, /this Unity change touched files a teammate is working on: Assets\/Scenes\/Main\.unity locked by ana/);
    ben.hook('post', { tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'bpy.ops.wm.save_mainfile()' } });
    locks = (await api('state')).locks;
    assert.ok(locks.some(l => l.path === 'ship.blend' && l.holderName === 'ben'));
    ok('editor changes to a file someone else holds are flagged to undo, and the rest are locked');

    // the CLI: off for the team removes the server from this folder
    const r = spawnSync(process.execPath, [CLI, 'apps', 'remove', 'blender'], { cwd: ana.root, env: { ...process.env, HUDDLE_ROOT: ana.root }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Blender: off for the team/);
    assert.deepEqual((await api('state')).projectSettings.apps, ['unity']);
    assert.ok(!JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).projects[ana.root].mcpServers.blender);
    const list = spawnSync(process.execPath, [CLI, 'apps'], { cwd: ana.root, env: { ...process.env, HUDDLE_ROOT: ana.root }, encoding: 'utf8' });
    assert.match(list.stdout, /Unity: on · MCP server registered here/);
    assert.match(list.stdout, /looks like a Blender project: huddle apps add blender/);
    ok('huddle apps lists, adds and removes editors for the team');
  } finally {
    proc.kill();
  }
  console.log('\nall apps checks passed');
})().catch((e) => { console.error(e); process.exit(1); });

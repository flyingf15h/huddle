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

  // ---- Godot and Figma
  assert.equal(apps.match('mcp__godot__save_scene').id, 'godot');
  assert.equal(apps.match('mcp__tools__create_scene').id, 'godot');
  assert.equal(apps.changes(apps.match('mcp__godot__get_project_info'), {}), false);
  assert.equal(apps.changes(apps.match('mcp__godot__add_node'), {}), true);
  const gd = path.join(tmp, 'gd');
  fs.mkdirSync(path.join(gd, 'game', 'scenes'), { recursive: true });
  fs.writeFileSync(path.join(gd, 'game', 'project.godot'), '[application]\n');
  assert.deepEqual(apps.targets(apps.match('mcp__godot__save_scene'), { projectPath: 'game', scenePath: 'res://scenes/level1.tscn' }, gd), ['game/scenes/level1.tscn']);
  assert.deepEqual(apps.targets(apps.match('mcp__godot__save_scene'), { scenePath: 'scenes/level1.tscn' }, gd), ['game/scenes/level1.tscn']);
  assert.equal(apps.changes(apps.match('mcp__figma__get_design_context'), { nodeId: '1:2' }), false);
  assert.deepEqual(apps.specFor('figma', 'claude'), { type: 'http', url: 'https://mcp.figma.com/mcp' });
  assert.deepEqual(apps.specFor('figma', 'codex').args, ['-y', 'mcp-remote', 'https://mcp.figma.com/mcp']);
  assert.deepEqual(apps.specFor('godot', 'cursor'), { command: 'npx', args: ['-y', '@coding-solo/godot-mcp'] });
  assert.ok(apps.shows(apps.match('mcp__blender__look'), {}) && apps.shows(apps.match('mcp__unity__manage_camera'), { action: 'screenshot' }) && !apps.shows(apps.match('mcp__unity__manage_scene'), { action: 'save' }));
  assert.deepEqual(apps.imagesIn([{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]), [{ data: 'AAAA', mime: 'image/png' }]);
  assert.deepEqual(apps.imagesIn({ content: [{ type: 'image', source: { data: 'BBBB', media_type: 'image/jpeg' } }] }), [{ data: 'BBBB', mime: 'image/jpeg' }]);
  ok('Godot scenes are found and locked like Unity\'s; Figma is read-only; screenshots are picked out of tool results');

  // ---- merging set up in the clone, never in a committed file
  const mg = unityRepo('merge');
  sh(mg, 'init', '-q');
  const tools = path.join(home, 'Unity', 'Hub', 'Editor', '6000.0.30f1', 'Editor', 'Data', 'Tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, 'UnityYAMLMerge'), '#!/bin/sh\n', { mode: 0o755 });
  const did = apps.setupMerge(mg);
  if (process.platform === 'linux') {
    assert.match(did.did.join(' '), /UnityYAMLMerge/);
    assert.match(sh(mg, 'config', 'merge.unityyamlmerge.driver'), /UnityYAMLMerge" merge -h -p --force %O %B %A %A/);
    assert.match(sh(mg, 'check-attr', 'merge', 'Assets/Scenes/Main.unity'), /merge: unityyamlmerge/);
  }
  assert.match(sh(mg, 'check-attr', 'binary', 'ship.blend'), /binary: set/);
  assert.equal(apps.setupMerge(mg).changed, false);
  assert.ok(!fs.existsSync(path.join(mg, '.gitattributes')));
  ok('joining sets up Unity\'s scene merger and binary art in this clone only, once');

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

    // ---- the gallery: viewport screenshots arrive by themselves, kept out of the feed
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    ana.hook('post', { tool_name: 'mcp__blender__look', tool_input: {}, tool_response: [{ type: 'image', data: png, mimeType: 'image/png' }] });
    let media = (await api('media')).media;
    assert.equal(media.length, 1);
    assert.equal(media[0].source, 'Blender');
    assert.match(media[0].caption, /Blender: looked at the viewport/);
    assert.equal((await api('media-file?id=' + media[0].id)).data, png);
    assert.equal((await fetch(`${url}/api/p/${project}/media`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ agent: boss, mime: 'text/html', data: 'AA' }) })).status, 400);
    await api('media-delete', { agent: boss, id: media[0].id });
    assert.equal((await api('media')).media.length, 0);
    ok('screenshots from the editors land in the gallery, and only images are accepted');

    // ---- builds
    assert.equal((await fetch(`${url}/api/p/${project}/build`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ agent: boss, url: 'javascript:alert(1)', title: 'x' }) })).status, 400);
    const bl = await api('build', { agent: boss, url: 'https://team.itch.io/game', title: 'Prototype 1', platform: 'web' });
    assert.equal((await api('builds')).builds[0].url, 'https://team.itch.io/game');
    await api('build-delete', { agent: boss, id: bl.build.id });
    ok('builds keep their full link, and only http(s) links are taken');

    // ---- asset hand-off: a model saved in Blender becomes a task for whoever is in Unity
    await api('project-setting', { agent: boss, apps: ['unity', 'blender'] });
    ben.write('Assets/Scenes/Menu.unity', '%YAML 1.1\nmenu: 9\n');
    ben.hook('post', { tool_name: 'mcp__unity__manage_scene', tool_input: { action: 'save' } });
    fs.mkdirSync(path.join(ana.root, 'art'), { recursive: true });
    ana.write('art/crate.blend', 'BLENDER crate');
    ana.hook('post', { tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'bpy.ops.wm.save_as_mainfile(filepath="art/crate.blend")' } });
    let board = await api('board');
    assert.ok(board.tasks.some(t => t.asset && t.asset.includes('ship.blend'))); // ben's save earlier
    const hand = board.tasks.filter(t => t.asset && t.asset.includes('art/crate.blend'));
    assert.equal(hand.length, 1);
    assert.equal(hand[0].title, 'Bring crate.blend into Unity');
    assert.equal(hand[0].editor, 'unity');
    assert.equal(hand[0].owner, 'ben');
    ana.hook('post', { tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'print(1)' } }); // nothing new saved
    fs.utimesSync(path.join(ana.root, 'art', 'crate.blend'), new Date(), new Date(Date.now() + 5000));
    ana.hook('post', { tool_name: 'mcp__blender__execute_blender_code', tool_input: { code: 'save again' } });
    assert.equal((await api('board')).tasks.filter(t => t.asset && t.asset.includes('art/crate.blend')).length, 1);
    const ap2 = require('../src/autopilot');
    assert.equal(ap2.pick({ goals: [], tasks: [{ ...hand[0], owner: 'ben', status: 'todo', after: [] }] }, 'ben', new Set(), 'full'), null);
    assert.match(require('../src/board').briefing(await api('board'), 'ben'), /Bring crate\.blend into Unity  ← yours/);
    ok('a model saved in Blender becomes one hand-off for the person in Unity, which background runs leave alone');

    // ---- timeline: goals and a plan every agent is told about
    assert.equal((await fetch(`${url}/api/p/${project}/timeline-draft`, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ agent: boss }) })).status, 400);
    const due = Date.now() + 2 * 3600000;
    await api('timeline-milestone', { agent: boss, title: 'Playable prototype', due, detail: 'one level start to finish' });
    await api('timeline-milestone', { agent: boss, title: 'Submit', due: due + 864e5 });
    const dr = await api('timeline-draft', { agent: boss });
    assert.equal(dr.task.title, 'Draft the team timeline plan');
    const tp = ana.hook('prompt', { prompt: 'keep going on the jump' });
    assert.match(tp.hookSpecificOutput.additionalContext, /the team timeline changed[\s\S]*Playable prototype: due/);
    assert.match(tp.hookSpecificOutput.additionalContext, /"Playable prototype" is close/);
    const again = ana.hook('prompt', { prompt: 'and the camera' });
    assert.ok(!/timeline changed/.test((again && again.hookSpecificOutput && again.hookSpecificOutput.additionalContext) || ''));
    const st0 = ben.hook('session-start', { source: 'startup' });
    assert.match(st0.hookSpecificOutput.additionalContext, /Team timeline[\s\S]*Submit/);
    assert.match(st0.hookSpecificOutput.additionalContext, /huddle_claim_feature/);
    ok('timeline goals reach every agent at the start and when they change, with a nudge near a deadline');

    // ---- the agent tools: plan, goals done, feature claims, images and builds
    const mcp = spawn(process.execPath, [CLI, 'mcp'], { cwd: ana.root, env: { ...process.env, ...gitEnv, HUDDLE_SESSION: '501', HUDDLE_ROOT: ana.root }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '', nid = 1;
    const waiting = new Map();
    mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } });
    const rpc = (method, params) => new Promise(r => { const id = nid++; waiting.set(id, r); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text;
    await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    try {
      assert.match(await tool('huddle_timeline', { plan: 'Playable prototype\n- jump, one enemy, one level', done: 'playable prototype' }), /Submit[\s\S]*jump, one enemy/);
      assert.ok((await api('timeline')).timeline.milestones.find(m => m.title === 'Playable prototype').done);
      fs.mkdirSync(path.join(ana.root, 'Assets', 'Scripts', 'Inventory'), { recursive: true });
      ana.write('Assets/Scripts/Inventory/DragDrop.cs', 'class DragDrop {}\n');
      ana.write('Assets/Scripts/Inventory/Slot.cs', 'class Slot {}\n');
      assert.match(await tool('huddle_claim_feature', { feature: 'inventory: drag and drop', paths: ['Assets/Scripts/Inventory/DragDrop.cs', 'Assets/Scripts/Inventory/Slot.cs'] }), /claimed Assets\/Scripts\/Inventory\/DragDrop\.cs/);
      assert.match(await tool('huddle_claim_feature', { feature: 'everything', paths: [...Array(13)].map((_, i) => `f${i}.cs`) }), /more than a feature/);
      assert.match(await tool('huddle_claim_feature', { feature: 'all assets', paths: ['Assets/'] }), /more than one feature|Assets\/ overlaps Assets\/Scenes\/\w+\.unity, held by ben/);
      locks = (await api('state')).locks;
      assert.equal(locks.filter(l => l.note === 'feature: inventory: drag and drop').length, 2);
      const busy = ben.hook('pre', { tool_name: 'Edit', tool_input: { file_path: path.join(ben.root, 'Assets/Scripts/Inventory/Slot.cs') } });
      assert.equal(busy.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(await tool('huddle_release_feature', { feature: 'inventory: drag and drop' }), /released/);
      assert.equal((await api('state')).locks.filter(l => /^feature: inventory/.test(l.note || '')).length, 0);
      fs.writeFileSync(path.join(ana.root, 'shot.png'), Buffer.from(png, 'base64'));
      assert.match(await tool('huddle_share_image', { path: 'shot.png', caption: 'new crate' }), /in the gallery/);
      assert.match(await tool('huddle_share_build', { url: 'https://team.itch.io/game', title: 'Prototype 2', platform: 'web' }), /on the Builds page/);
      assert.equal((await api('media')).media.pop().caption, 'new crate');
      ok('agents keep the plan, tick goals off, claim one feature at a time (not whole folders) and share images and builds');
    } finally { mcp.kill(); }

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

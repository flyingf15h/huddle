// Editors that agents drive through an MCP server of their own: Unity (MCP for Unity, or Unity's own
// MCP) and Blender (MCP for Blender). A project turns one on for the whole team with `huddle apps add`;
// every teammate's agent then gets that MCP server registered in their folder. Changes made through
// the editor never go through Edit/Write, so huddle locks the scene and asset files they touch instead:
// files named in the tool call are locked before it runs, and files the call changed on disk after.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawnSync } = require('child_process');

const READ_ACTION = /^(get|find|list|read|search|inspect|info|ping|status|validate|describe|query|screenshot|scene_view_frame|preview|count|exists|has|check|help)/i;

const APPS = {
  blender: {
    label: 'Blender',
    server: { type: 'stdio', command: 'uvx', args: ['mcp-for-blender'] },
    // an existing registration of the same server under any name (old package name included)
    known: /mcp-for-blender|blender-mcp/i,
    port: 9876,
    tools: new Set(['execute_blender_code', 'look', 'get_scene_info', 'generate_3d', 'search_assets', 'import_asset', 'get_addon_status', 'disable_telemetry', 'record_trajectory_feedback']),
    // tool names no other server is likely to have, for a server registered under another name
    only: /^(execute_blender_code|get_scene_info|generate_3d|get_addon_status)$/,
    reads: new Set(['look', 'get_scene_info', 'search_assets', 'get_addon_status', 'disable_telemetry', 'record_trajectory_feedback']),
    files: /\.(blend|fbx|obj|glb|gltf|usd[acz]?|abc|stl|png|jpe?g|exr|hdr|tga|tiff?)$/i,
    setup: [
      'install uv (https://docs.astral.sh/uv/getting-started/installation/)',
      'uvx mcp-for-blender install-addon',
      'in Blender: Edit > Preferences > Add-ons, turn on "MCP for Blender"',
      'in the 3D viewport press N, open the MCP for Blender tab and click Start MCP Server',
    ],
    detect: (root) => findFiles(root, /\.blend$/i, 3).length > 0,
  },
  unity: {
    label: 'Unity',
    server: { type: 'stdio', command: 'uvx', args: ['--from', 'mcpforunityserver', 'mcp-for-unity', '--transport', 'stdio'] },
    known: /mcpforunityserver|mcp-for-unity|localhost:8080\/mcp|\.unity[\\/]relay/i,
    tools: new Set(['batch_execute', 'execute_code', 'execute_custom_tool', 'execute_menu_item', 'find_gameobjects', 'find_in_file', 'generate_audio', 'generate_image',
      'generate_model', 'import_model', 'import_model_file', 'manage_animation', 'manage_asset', 'manage_build', 'manage_camera', 'manage_components', 'manage_editor',
      'manage_gameobject', 'manage_graphics', 'manage_material', 'manage_packages', 'manage_physics', 'manage_prefabs', 'manage_probuilder', 'manage_profiler',
      'manage_scene', 'manage_script', 'manage_scriptable_object', 'manage_shader', 'manage_sprite', 'manage_texture', 'manage_tools', 'manage_ui', 'manage_vfx',
      'read_console', 'refresh_unity', 'run_tests', 'script_apply_edits', 'set_active_instance', 'unity_docs', 'unity_reflect']),
    only: /^(manage_(scene|gameobject|prefabs|asset|script|editor|components|material)|find_gameobjects|script_apply_edits|execute_menu_item|read_console)$/,
    reads: new Set(['find_gameobjects', 'find_in_file', 'read_console', 'unity_docs', 'unity_reflect', 'set_active_instance', 'run_tests', 'refresh_unity', 'debug_request_context', 'preflight']),
    files: /\.(unity|prefab|asset|mat|controller|overrideController|anim|mask|physicMaterial|physicsMaterial2D|lighting|shadergraph|shadersubgraph|vfx|cs|shader|uxml|uss|inputactions|fbx|png|psd|tga|wav|mp3|ogg)$/i,
    setup: [
      'install uv (https://docs.astral.sh/uv/getting-started/installation/)',
      'in Unity: Window > Package Manager > + > Add package from git URL: https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main',
      'open Window > MCP for Unity, choose stdio under Settings, and click Start Bridge',
      'with Unity 6 and a Unity AI plan, Unity\'s own MCP (Edit > Project Settings > AI > Unity MCP) works too; register it instead and huddle treats it the same',
    ],
    detect: (root) => unityRoots(root).length > 0,
  },
};

function findFiles(root, re, depth, out = []) {
  if (depth < 0 || out.length > 50) return out;
  let ents = [];
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.') || ['node_modules', 'Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds'].includes(e.name)) continue;
    const abs = path.join(root, e.name);
    if (e.isDirectory()) findFiles(abs, re, depth - 1, out);
    else if (re.test(e.name)) out.push(abs);
  }
  return out;
}
// folders holding a Unity project (the repo itself, or a folder a level or two down)
function unityRoots(root) {
  return findFiles(root, /^ProjectVersion\.txt$/, 3).filter(f => path.basename(path.dirname(f)) === 'ProjectSettings').map(f => path.dirname(path.dirname(f)));
}

// Which editor an MCP tool call is for: by the server's name, or for a server registered under some
// other name, by a tool name only that editor's server has.
function match(toolName) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(toolName || ''));
  if (!m || m[1] === 'huddle') return null;
  const server = m[1], tool = m[2];
  for (const [id, app] of Object.entries(APPS)) {
    if (new RegExp(id, 'i').test(server)) return { id, app, server, tool };
  }
  for (const [id, app] of Object.entries(APPS)) if (app.only.test(tool)) return { id, app, server, tool };
  return null;
}

// Whether a call can change the project. Unity's manage_* tools take an action; their read actions
// don't count. Anything unknown counts as a change, to be safe.
function changes(hit, input = {}) {
  const { app, tool } = hit;
  if (app.reads.has(tool)) return false;
  if (tool === 'batch_execute' && Array.isArray(input.commands)) {
    return input.commands.some(c => changes({ ...hit, tool: String(c.tool || c.name || '') }, c.params || c.arguments || {}));
  }
  if (typeof input.action === 'string' && READ_ACTION.test(input.action)) return false;
  return true;
}

// Project files a call names outright (a scene to save, a script to edit, a .blend to open). Paths
// come back relative to the project, for the lock route.
function targets(hit, input = {}, root) {
  const found = new Set();
  const add = (v) => {
    if (typeof v !== 'string' || !hit.app.files.test(v.trim())) return;
    let p = v.trim().replace(/\\/g, '/');
    if (path.isAbsolute(p)) { const r = path.relative(root, p); if (r.startsWith('..')) return; p = r.split(path.sep).join('/'); }
    else if (hit.id === 'unity' && !p.startsWith('Assets/') && !p.startsWith('Packages/')) {
      // MCP for Unity takes paths inside Assets/, with or without that prefix
      const u = unityRoots(root)[0];
      p = path.relative(root, path.join(u || root, 'Assets', p)).split(path.sep).join('/');
    } else if (hit.id === 'unity') {
      const u = unityRoots(root)[0];
      if (u && u !== root) p = path.relative(root, path.join(u, p)).split(path.sep).join('/');
    }
    found.add(p);
  };
  for (const k of ['path', 'file_path', 'filepath', 'scene_path', 'scenePath', 'asset_path', 'assetPath', 'prefab_path', 'prefabPath', 'target', 'destination', 'save_path'])
    add(input[k]);
  if (hit.id === 'unity' && input.name && input.path && !/\.\w+$/.test(input.name)) {
    // manage_script / manage_scene: a name plus a folder
    const ext = hit.tool === 'manage_script' ? '.cs' : hit.tool === 'manage_scene' ? '.unity' : hit.tool === 'manage_prefabs' ? '.prefab' : '';
    if (ext) add(String(input.path).replace(/\/?$/, '/') + input.name + ext);
  }
  if (hit.tool === 'execute_blender_code' && typeof input.code === 'string') {
    for (const m of input.code.matchAll(/filepath\s*=\s*r?["']([^"']+\.blend)["']/g)) add(m[1]);
  }
  return [...found];
}

// Files of this editor's kinds that differ from git right now (modified or new), relative to root.
function changedFiles(root, app) {
  const r = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return [];
  const out = [];
  const parts = r.stdout.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2), file = e.slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is the old name
    if (code.includes('D')) continue;
    if (app.files.test(file) && !file.endsWith('.meta')) out.push(file);
  }
  return out;
}

// A short line for the activity feed, in the editor's terms
function summary(hit, input = {}) {
  const what = hit.tool === 'execute_blender_code' ? `ran Python in Blender (${String(input.code || '').split('\n').length} lines)`
    : hit.tool === 'look' ? 'looked at the viewport'
    : typeof input.action === 'string' ? `${hit.tool.replace(/^manage_/, '')} ${input.action}` : hit.tool.replace(/_/g, ' ');
  const on = input.path || input.name || input.target || input.scene_path || input.query || '';
  return `${hit.app.label}: ${what}${on && hit.tool !== 'execute_blender_code' ? ' ' + String(on).slice(0, 120) : ''}`.slice(0, 300);
}

// ---- registering the MCP servers in a teammate's folder ----

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// every MCP server a Claude started in root would load, by name
function claudeServers(root) {
  const all = readJson(path.join(os.homedir(), '.claude.json')) || {};
  return { ...(all.mcpServers || {}), ...((readJson(path.join(root, '.mcp.json')) || {}).mcpServers || {}), ...(((all.projects || {})[root] || {}).mcpServers || {}) };
}
function registered(root, agent, id) {
  const app = APPS[id];
  let servers = {};
  if (agent === 'cursor') servers = (readJson(path.join(root, '.cursor', 'mcp.json')) || {}).mcpServers || {};
  else if (agent === 'codex') {
    let t = '';
    try { t = fs.readFileSync(path.join(root, '.codex', 'config.toml'), 'utf8'); } catch {}
    try { t += fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8'); } catch {}
    return app.known.test(t) || new RegExp(`\\[mcp_servers\\.[^\\]]*${id}`, 'i').test(t);
  } else servers = claudeServers(root);
  return Object.entries(servers).some(([name, s]) => new RegExp(id, 'i').test(name) || app.known.test(JSON.stringify(s)));
}

const BEGIN = '# huddle-apps-begin (huddle apps manages this block)';
const END = '# huddle-apps-end';
function codexBlock(ids) {
  const q = (s) => JSON.stringify(String(s));
  return [BEGIN, ...ids.flatMap(id => [`[mcp_servers.${id}]`, `command = ${q(APPS[id].server.command)}`, `args = [${APPS[id].server.args.map(q).join(', ')}]`, 'startup_timeout_sec = 30', '']), END].join('\n');
}

// Registers each app's server that the folder doesn't have yet. Returns the ids it added; a running
// session picks them up when it restarts.
function install(root, agent, ids) {
  const added = [];
  const todo = ids.filter(id => APPS[id] && !registered(root, agent, id));
  if (!todo.length) return added;
  if (agent === 'cursor') {
    const file = path.join(root, '.cursor', 'mcp.json');
    const mcp = readJson(file) || {};
    mcp.mcpServers = mcp.mcpServers || {};
    for (const id of todo) { const { type, ...s } = APPS[id].server; mcp.mcpServers[id] = s; added.push(id); }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(mcp, null, 2) + '\n');
  } else if (agent === 'codex') {
    const file = path.join(root, '.codex', 'config.toml');
    let cur = '';
    try { cur = fs.readFileSync(file, 'utf8'); } catch {}
    const had = inBlock(cur);
    const keep = stripBlock(cur);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, (keep ? keep + '\n\n' : '') + codexBlock([...new Set([...had, ...todo])]) + '\n');
    added.push(...todo);
  } else {
    for (const id of todo) {
      const r = require('./bin').spawnSync('claude', ['mcp', 'add-json', '-s', 'local', id, JSON.stringify(APPS[id].server)], { cwd: root, encoding: 'utf8', windowsHide: true });
      if (r.status === 0) added.push(id);
    }
  }
  return added;
}
function uninstall(root, agent, id) {
  if (agent === 'cursor') {
    const file = path.join(root, '.cursor', 'mcp.json'), mcp = readJson(file);
    if (mcp && mcp.mcpServers && mcp.mcpServers[id]) { delete mcp.mcpServers[id]; fs.writeFileSync(file, JSON.stringify(mcp, null, 2) + '\n'); }
  } else if (agent === 'codex') {
    const file = path.join(root, '.codex', 'config.toml');
    let cur = '';
    try { cur = fs.readFileSync(file, 'utf8'); } catch { return; }
    const left = inBlock(cur).filter(n => n !== id);
    const keep = stripBlock(cur);
    fs.writeFileSync(file, (keep ? keep + '\n\n' : '') + (left.length ? codexBlock(left) + '\n' : ''));
  } else {
    require('./bin').spawnSync('claude', ['mcp', 'remove', '-s', 'local', id], { cwd: root, stdio: 'ignore', windowsHide: true });
  }
}
// the apps already in huddle's block of a Codex config
function inBlock(text) {
  const i = text.indexOf(BEGIN), j = text.indexOf(END);
  return i < 0 || j < i ? [] : [...text.slice(i, j).matchAll(/^\[mcp_servers\.(\w+)\]/gm)].map(m => m[1]).filter(n => APPS[n]);
}
function stripBlock(text) {
  const i = text.indexOf(BEGIN), j = text.indexOf(END);
  if (i < 0 || j < i) return text.trim();
  return (text.slice(0, i) + text.slice(j + END.length)).replace(/\n{3,}/g, '\n\n').trim();
}

// MCP servers that drive an editor on this machine: a background Claude in a worktree mustn't get
// them, or its changes would land in the editor's open project (the person's folder) instead of its
// own branch.
function isEditorServer(name, spec) {
  return Object.entries(APPS).some(([id, app]) => new RegExp(id, 'i').test(name) || app.known.test(JSON.stringify(spec || {})));
}

// whether Blender's add-on is listening (the Unity bridge has no fixed port to check)
function listening(port, host = '127.0.0.1', ms = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(ms, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

module.exports = { APPS, match, changes, targets, changedFiles, summary, install, uninstall, registered, isEditorServer, unityRoots, listening, READ_ACTION };

#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const { loadConfig, identity, Client, relPath, hashFile, formatMessages, ago, build, ownerKey, sha, CONFIG_DIR } = require('./client');
const gitx = require('./git');

const PKG_DIR = path.resolve(__dirname, '..');
const INSTALL_DIR = process.env.HUDDLE_HOME || path.join(os.homedir(), '.huddle', 'app');
const HOOK_MARK = 'huddle-hook';
const PUBLIC_SERVER = process.env.HUDDLE_PUBLIC_SERVER || 'https://huddle.sage-hill.workers.dev';
const REPO = process.env.HUDDLE_REPO || 'flyingf15h/huddle';
const FOLDERS = path.join(path.dirname(INSTALL_DIR), 'folders.json'); // every folder this computer joined, for `huddle update`

const HELP = `huddle — let Claude agents on different machines work on one project together

Start a project (one person, in the project folder):
  huddle new [NAME]             create a project on the public server, join this folder,
                                and print the invite for everyone else
  huddle server [--port 7777] [--tunnel] [--project NAME] [--open]
      Or run your own relay. --tunnel gives it a public https URL via cloudflared,
      --open lets anyone create projects on it with \`huddle new --server URL\`.

Everyone (in the project folder):
  huddle join <invite> [--name YOUR_NAME]
      Set up this folder: config, Claude Code hooks and the huddle MCP tools.
  huddle leave                  remove huddle from this folder
  huddle update [--from DIR] [--ref REF]
                                get the newest huddle (from GitHub, or a local checkout) and
                                refresh the hooks in every folder you joined; then restart Claude
  huddle permissions [--write]  a shared .claude/settings.json so every teammate's Claude stops
                                asking about edits, huddle, git, builds and tests (deploys still ask)
  huddle link FOLDER            run in a parent folder: Claude started here joins FOLDER's huddle

Talk to the whole team of Claudes:
  huddle ask "build X"          give every agent a goal; one plans it, all of them work it
  huddle ask "fix Y" --to alex  hand a task straight to alex's Claude
  huddle board                  goals, tasks, who owns what
  huddle autopilot on|requests|off
                                what YOUR Claude does with work from the team (uses your
                                Claude subscription; runs claude -p in this folder):
                                on (default, "active") = answers the other Claudes while you're
                                away, takes its tasks, plans team goals; requests = only what
                                people send to your Claude; off = everything waits
  huddle autopilot [--allow "Bash(npm test:*)"] [--model M] [--parallel N]
                                run it in this terminal (when no Claude session is open here).
                                Each request runs as its own Claude in its own git worktree,
                                up to 3 at once, and merges back into your branch when clean

Versions, branches and merging (git history travels through huddle, no shared remote needed):
  huddle sync                   compare your copy with the team's and merge / branch / switch
  huddle branches               everyone's branches and how they compare to yours
  huddle branch own [NAME]      work on your own branch (no locks with others, merge later)
  huddle branch join PERSON[/BRANCH]   switch to someone's branch to work on it together
  huddle merge PERSON[/BRANCH]  merge their branch into yours
  huddle publish                share your current branch now (also automatic after each turn)
  huddle unpublish [BRANCH]     take back a branch you shared
  huddle forget NAME            remove someone who left from the team list
  huddle same-person OLD NAME   merge two names for the same person (e.g. a dashboard name)
  huddle tidy                   merge names that only differ in capitals ("kelly" and "Kelly")
                                and drop old sessions from the team list

Shared team knowledge (not in git, every agent gets it):
  huddle project                print PROJECT.md, the brief every agent starts with
  huddle project --edit         edit it in $EDITOR  (or --set FILE, e.g. --set CLAUDE.md)
  huddle memory                 list shared memories
  huddle memory add "title" "text"   /   huddle memory rm ID
  huddle skill                  list shared skills
  huddle skill add PATH         share a skill (a SKILL.md or a folder holding one)
  huddle skill rm NAME

Day to day:
  huddle status                 who's online, locks, recent edits
  huddle send <text> [--to N]   message the agents
  huddle inbox                  read messages for you
  huddle watch                  live feed of everything, incl. each Claude's prompts, replies
                                and tool calls; keeps files synced while you edit by hand
  huddle sharing [full|tools|off]   how much of YOUR Claude sessions others can see
  huddle ai-name [NAME]         name your Claude (e.g. "Pip"); the team sees it and can send it
                                work with --to Pip. No NAME: show it. --clear removes it.
  huddle lock <file|folder/> / unlock [file|folder/]
                                a locked folder is only editable by whoever locked it
  huddle handoff ["note"]       leave a note on where you left off; no note: show everyone's
  huddle invite                 print this project's invite code again
  huddle open                   open the live dashboard in your browser (it can approve
                                commands for your Claude, so don't share that link)
  huddle approve [ID] [--deny]  commands your background Claudes need your OK for
  huddle tests ["CMD"] [--review on|off]
                                what checks background work before it merges: the test
                                command (default: guessed) and a Sonnet review
`;

function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const encodeInvite = (server, token, project) =>
  Buffer.from(JSON.stringify({ s: server, t: token, p: project })).toString('base64url');
function decodeInvite(code) {
  const j = JSON.parse(Buffer.from(code.trim().replace(/^huddle:/, ''), 'base64url').toString('utf8'));
  if (!j.s || !j.t || !j.p) throw new Error('incomplete invite');
  return { server: j.s, token: j.t, project: j.p };
}
const joinCommand = (code) => `npx -y github:flyingf15h/huddle join ${code}`;

function need(cond, msg) { if (!cond) { console.error(msg); process.exit(1); } }

function configured() {
  const cfg = loadConfig();
  need(cfg && cfg.server, 'This folder isn\'t in a huddle. Run `huddle join <invite>` in the project root first.');
  return cfg;
}

// ---------- server ----------

async function cmdServer({ flags }) {
  const { createServer } = require('./server');
  const port = Number(flags.port || process.env.PORT || 7777);
  const dataDir = path.resolve(flags.data || path.join(os.homedir(), '.huddle', 'server'));
  const project = flags.project || path.basename(process.cwd()).replace(/[^\w.-]/g, '-') || 'project';
  const server = createServer({ dataDir, open: !!flags.open });
  await new Promise((res, rej) => server.listen(port, flags.host || '0.0.0.0', res).on('error', rej));
  const token = server.huddleToken;
  const quit = () => { server.huddleFlush(); process.exit(0); };
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);

  const show = (url, label) => {
    if (server.huddleOpen) return console.log(`\n${label}: ${url}\n  anyone can start a project:  huddle new NAME --server ${url}`);
    const code = encodeInvite(url, token, project);
    console.log(`\n${label}: ${url}`);
    console.log(`  dashboard:  ${url}/#invite=${code}`);
    console.log(`  invite:     ${joinCommand(code)}`);
  };
  console.log(`huddle server listening on port ${port} (data in ${dataDir})`);
  if (server.huddleOpen) console.log('open mode: every project gets its own token; the admin token in the data dir unlocks all of them, keep it private');
  else console.log(`project "${project}" (pass --project to change; any number of projects can share one server)`);
  show(`http://localhost:${port}`, 'this machine');
  for (const ip of lanAddresses()) show(`http://${ip}:${port}`, 'same network / tailnet');
  console.log('\nAnyone with the invite code can read and edit the project through huddle; only share it with collaborators.');

  if (flags.tunnel) {
    const cf = spawnSync('cloudflared', ['--version']).status === 0;
    if (!cf) {
      console.log('\n--tunnel needs cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    } else {
      const t = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      let shown = false;
      const scan = (buf) => {
        const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m && !shown) { shown = true; show(m[0], 'public tunnel (works from anywhere)'); }
      };
      t.stdout.on('data', scan);
      t.stderr.on('data', scan);
      t.on('exit', (c) => console.log(`cloudflared exited (${c}); the public URL is gone, LAN URLs still work`));
      const stop = () => { t.kill(); quit(); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    }
  }
}

function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

// ---------- join / leave ----------

// Copy huddle somewhere stable so the hooks keep working after npx clears its cache.
function selfInstall() {
  if (path.resolve(PKG_DIR) === path.resolve(INSTALL_DIR)) return INSTALL_DIR;
  if (process.env.HUDDLE_DEV) return PKG_DIR;
  fs.rmSync(INSTALL_DIR, { recursive: true, force: true });
  fs.mkdirSync(INSTALL_DIR, { recursive: true });
  fs.cpSync(path.join(PKG_DIR, 'src'), path.join(INSTALL_DIR, 'src'), { recursive: true });
  fs.copyFileSync(path.join(PKG_DIR, 'package.json'), path.join(INSTALL_DIR, 'package.json'));
  if (fs.existsSync(path.join(PKG_DIR, 'build.json'))) fs.copyFileSync(path.join(PKG_DIR, 'build.json'), path.join(INSTALL_DIR, 'build.json'));
  // put `huddle` on PATH if ~/.local/bin is there
  if (process.platform !== 'win32' && !process.env.HUDDLE_HOME) {
    const bin = path.join(os.homedir(), '.local', 'bin');
    if ((process.env.PATH || '').split(path.delimiter).includes(bin)) {
      fs.mkdirSync(bin, { recursive: true });
      const shim = path.join(bin, 'huddle');
      fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${path.join(INSTALL_DIR, 'src', 'cli.js')}" "$@"\n`, { mode: 0o755 });
    }
  }
  return INSTALL_DIR;
}

function rememberFolder(root, projectRoot) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(FOLDERS, 'utf8')); } catch {}
  list = list.filter(f => f.root !== root);
  list.push({ root, ...(projectRoot ? { projectRoot } : {}) });
  try { fs.mkdirSync(path.dirname(FOLDERS), { recursive: true }); fs.writeFileSync(FOLDERS, JSON.stringify(list, null, 1)); } catch {}
}
// folders joined (or linked) on this computer: our own list, plus Claude Code's record of where
// the huddle MCP server is registered (covers folders joined before the list existed)
function joinedFolders() {
  const out = new Map();
  try { for (const f of JSON.parse(fs.readFileSync(FOLDERS, 'utf8'))) out.set(f.root, f); } catch {}
  // (a custom HUDDLE_HOME is a separate install: only the folders it joined itself)
  if (!process.env.HUDDLE_HOME) try {
    const cc = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    for (const [root, p] of Object.entries(cc.projects || {})) {
      const h = p && p.mcpServers && p.mcpServers.huddle;
      if (!h || out.has(root)) continue;
      const target = h.env && h.env.HUDDLE_ROOT;
      out.set(root, { root, ...(target && path.resolve(target) !== path.resolve(root) ? { projectRoot: target } : {}) });
    }
  } catch {}
  return [...out.values()].filter(f => fs.existsSync(path.join(f.projectRoot || f.root, CONFIG_DIR, 'config.json')));
}

// Get the newest huddle and point every joined folder's hooks at it.
async function cmdUpdate({ flags }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-update-'));
  try {
    let src, info;
    if (flags.from) {
      src = path.resolve(String(flags.from));
      need(fs.existsSync(path.join(src, 'src', 'cli.js')), `${src} doesn't look like a huddle checkout`);
      const g = gitx.git(src, ['log', '-1', '--format=%H %ct']);
      info = g.ok ? { sha: g.out.split(' ')[0], at: Number(g.out.split(' ')[1]) * 1000, from: src } : { sha: 'local', at: Date.now(), from: src };
    } else {
      const ref = String(flags.ref || 'main');
      process.stdout.write(`checking github.com/${REPO} (${ref}) … `);
      let c;
      try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${encodeURIComponent(ref)}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'huddle' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        c = await res.json();
      } catch (e) { console.log('failed'); need(false, `couldn't look up the latest huddle: ${e.message}`); }
      info = { sha: c.sha, at: Date.parse(c.commit.committer.date), from: `github:${REPO}` };
      const cur = build();
      if (cur && cur.sha === info.sha && !flags.force) console.log(`already on ${info.sha.slice(0, 7)}`);
      else {
        console.log(`${info.sha.slice(0, 7)} from ${new Date(info.at).toLocaleString()}`);
        const res = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${info.sha}`);
        need(res.ok, `download failed: HTTP ${res.status}`);
        fs.writeFileSync(path.join(tmp, 'huddle.tgz'), Buffer.from(await res.arrayBuffer()));
        const x = spawnSync('tar', ['-xzf', 'huddle.tgz'], { cwd: tmp });
        need(x.status === 0, "couldn't unpack the download (is tar installed?)");
        src = path.join(tmp, fs.readdirSync(tmp).find(d => d !== 'huddle.tgz'));
      }
    }
    if (src) {
      need(path.resolve(src) !== path.resolve(INSTALL_DIR), 'that is the installed copy itself');
      fs.rmSync(path.join(INSTALL_DIR, 'src'), { recursive: true, force: true });
      fs.mkdirSync(INSTALL_DIR, { recursive: true });
      fs.cpSync(path.join(src, 'src'), path.join(INSTALL_DIR, 'src'), { recursive: true });
      fs.copyFileSync(path.join(src, 'package.json'), path.join(INSTALL_DIR, 'package.json'));
      fs.writeFileSync(path.join(INSTALL_DIR, 'build.json'), JSON.stringify(info));
      console.log(`installed huddle ${info.sha.slice(0, 7)} into ${INSTALL_DIR}`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  const folders = joinedFolders();
  for (const f of folders) {
    installHooks(f.root, INSTALL_DIR, f.projectRoot);
    installCommand(f.root);
  }
  console.log(`refreshed the hooks in ${folders.length} folder${folders.length === 1 ? '' : 's'}${folders.length ? ':\n  ' + folders.map(f => f.root).join('\n  ') : ''}
Restart Claude Code in those folders to load the new version.`);
}

// A shared .claude/settings.json (committed with the project) so nobody's Claude asks about routine
// work: file edits, huddle, git short of force-pushing, and this project's builds and tests.
// Deploys, installs of new packages and anything destructive still ask.
function permissionPreset(root) {
  const allow = ['mcp__huddle', 'Bash(huddle:*)',
    'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git fetch:*)', 'Bash(git pull:*)',
    'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git stash:*)', 'Bash(curl -s:*)'];
  const main = gitx.isRepo(root) ? (gitx.git(root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).out.replace(/^origin\//, '') || gitx.currentBranch(root, 0)) : null;
  // a prefix rule would let --force through too, so force-pushes are asked about explicitly
  const ask = ['Bash(git push -f:*)', 'Bash(git push --force:*)'];
  if (main) {
    allow.push(`Bash(git push origin ${main}:*)`);
    for (const f of ['-f', '--force', '--force-with-lease']) ask.push(`Bash(git push origin ${main} ${f}:*)`);
  }
  // look at the project and the folders right inside it (e.g. viewer/package.json)
  const dirs = [root, ...fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules').map(d => path.join(root, d.name))];
  const has = (f) => dirs.some(d => fs.existsSync(path.join(d, f)));
  if (has('package.json')) {
    allow.push('Bash(npm ci:*)', 'Bash(npm run build:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(npm run lint:*)', 'Bash(npx tsc:*)', 'Bash(npx eslint:*)');
  }
  if (has('pyproject.toml') || has('uv.lock')) allow.push('Bash(uv sync:*)', 'Bash(uv run pytest:*)');
  else if (has('requirements.txt')) allow.push('Bash(pytest:*)', 'Bash(python -m pytest:*)');
  if (has('Cargo.toml')) allow.push('Bash(cargo build:*)', 'Bash(cargo test:*)', 'Bash(cargo check:*)', 'Bash(cargo clippy:*)');
  if (has('go.mod')) allow.push('Bash(go build:*)', 'Bash(go test:*)', 'Bash(go vet:*)');
  if (has('Makefile')) allow.push('Bash(make test:*)', 'Bash(make build:*)');
  return { defaultMode: 'acceptEdits', allow, ask };
}

function cmdPermissions({ flags }) {
  const cfg = configured();
  const file = path.join(cfg.root, '.claude', 'settings.json');
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { need(e.code === 'ENOENT', `${file} isn't valid JSON; fix it first`); }
  const want = permissionPreset(cfg.root);
  const have = (cur.permissions && cur.permissions.allow) || [];
  const adding = want.allow.filter(a => !have.includes(a));
  const haveAsk = (cur.permissions && cur.permissions.ask) || [];
  const asking = want.ask.filter(a => !haveAsk.includes(a));
  const mode = (cur.permissions && cur.permissions.defaultMode) || null;
  if (!adding.length && !asking.length && mode) return console.log(`.claude/settings.json already has all of it (defaultMode ${mode}).`);
  console.log(`${flags.write ? 'Adding' : 'Would add'} to .claude/settings.json:\n${mode ? '' : '  defaultMode: acceptEdits (file edits without asking)\n'}${adding.map(a => '  ' + a).join('\n')}${asking.length ? `\nand always asks before: ${asking.map(a => a.slice(5, -3)).join(', ')}` : ''}
Anything else (deploys, ssh, installing new packages, rm) still asks too.`);
  if (!flags.write) return console.log('\nRun huddle permissions --write to save it.');
  cur.permissions = { ...(cur.permissions || {}), defaultMode: mode || want.defaultMode, allow: [...have, ...adding], ask: [...haveAsk, ...asking] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cur, null, 2) + '\n');
  console.log(`\nSaved. Commit .claude/settings.json so every teammate's Claude gets it:\n  git add .claude/settings.json && git commit -m "let Claude do routine work without asking"`);
}

function q(s) { return process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`; }

// projectRoot is set when the hooks live in a parent folder linked to a joined project
function hookCmd(dir, event, projectRoot) {
  return cliCmd(dir, `hook ${event}`, projectRoot);
}
function cliCmd(dir, args, projectRoot) {
  const env = projectRoot ? (process.platform === 'win32' ? '' : `HUDDLE_ROOT=${q(projectRoot)} `) : '';
  return `${env}${q(process.execPath)} ${q(path.join(dir, 'src', 'cli.js'))} ${args} #${HOOK_MARK}`;
}

function globalStatusLine() {
  try { return !!JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')).statusLine; } catch { return false; }
}

function settingsPath(root) { return path.join(root, '.claude', 'settings.local.json'); }

function stripHooks(settings) {
  if (!settings.hooks) return settings;
  for (const ev of Object.keys(settings.hooks)) {
    settings.hooks[ev] = settings.hooks[ev]
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !String(h.command || '').includes(HOOK_MARK)) }))
      .filter(g => g.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (settings.statusLine && String(settings.statusLine.command || '').includes(HOOK_MARK)) delete settings.statusLine;
  return settings;
}

function installHooks(root, dir, projectRoot) {
  const file = settingsPath(root);
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  stripHooks(s);
  s.hooks = s.hooks || {};
  const add = (ev, matcher, name, timeout = 15) => {
    (s.hooks[ev] = s.hooks[ev] || []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hookCmd(dir, name, projectRoot), timeout }] });
  };
  add('SessionStart', null, 'session-start');
  add('UserPromptSubmit', null, 'prompt');
  add('PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit', 'pre');
  add('PostToolUse', '*', 'post');
  add('Stop', null, 'stop');
  add('SessionEnd', null, 'session-end');
  // a status line that shows this folder is in a huddle, unless the person already has their own
  // (refreshed every 10 s even while idle, so "📬 new message" shows up without a prompt)
  if (!s.statusLine && !globalStatusLine()) s.statusLine = { type: 'command', command: cliCmd(dir, 'statusline', projectRoot), padding: 0, refreshInterval: 10 };
  // let the agent use huddle's own tools without a permission prompt each time
  s.permissions = s.permissions || {};
  s.permissions.allow = [...new Set([...(s.permissions.allow || []), 'mcp__huddle'])];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
}

// /autopilot inside Claude Code
const AUTOPILOT_COMMAND = `---
description: Set huddle autopilot: on (active for the team), requests only, or off
argument-hint: on | requests | off
---
Use the huddle_autopilot tool with mode "$ARGUMENTS". If no mode was given, just show the current setting. Then say in one short line what that means: whether teammates can start this Claude on things, and what still waits for me.
`;
function installCommand(root) {
  const file = path.join(root, '.claude', 'commands', 'autopilot.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, AUTOPILOT_COMMAND);
}

function installMcp(root, dir, projectRoot) {
  const spec = JSON.stringify({ type: 'stdio', command: process.execPath, args: [path.join(dir, 'src', 'cli.js'), 'mcp'], env: { HUDDLE_ROOT: projectRoot || root } });
  spawnSync('claude', ['mcp', 'remove', '-s', 'local', 'huddle'], { cwd: root, stdio: 'ignore' });
  const r = spawnSync('claude', ['mcp', 'add-json', '-s', 'local', 'huddle', spec], { cwd: root, encoding: 'utf8' });
  if (r.status === 0) return true;
  console.log(`\nCouldn't register the MCP server automatically (${r.error ? r.error.code : (r.stderr || '').trim()}). Run this in ${root}:`);
  console.log(`  claude mcp add-json -s local huddle '${spec}'`);
  return false;
}

// keep .huddle/ (it holds the token) out of git without touching tracked files
function ignoreLocally(root) {
  const exclude = path.join(root, '.git', 'info', 'exclude');
  if (!fs.existsSync(path.join(root, '.git'))) return;
  let cur = '';
  try { cur = fs.readFileSync(exclude, 'utf8'); } catch {}
  const want = ['.huddle/', '.claude/settings.local.json', '.claude/commands/autopilot.md'].filter(l => !cur.split('\n').includes(l));
  if (!want.length) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.appendFileSync(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + want.join('\n') + '\n');
}

async function cmdNew({ pos, flags }) {
  const server = String(flags.server || PUBLIC_SERVER).replace(/\/+$/, '');
  const name = pos[0] || path.basename(process.cwd());
  let r;
  try {
    const res = await fetch(`${server}/api/new`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error || `HTTP ${res.status}`);
  } catch (e) {
    need(false, `couldn't create a project on ${server}: ${e.cause ? e.cause.code || e.message : e.message}`);
  }
  const code = encodeInvite(server, r.token, r.project);
  console.log(`created project ${r.project} on ${server}

Send this to your collaborators (and run it yourself in your copy of the project):
  ${joinCommand(code)}

Live dashboard: ${server}/#invite=${code}
Anyone with the invite can join and see the project's shared files, so keep it to people you trust.`);
  if (flags['no-join']) return;
  console.log('');
  await cmdJoin({ pos: [code], flags });
}

async function cmdJoin({ pos, flags }) {
  need(pos[0], 'usage: huddle join <invite> [--name NAME]');
  let inv;
  try { inv = decodeInvite(pos[0]); } catch { need(false, 'That invite code looks broken. Ask for a fresh one (`huddle invite`).'); }
  const root = path.resolve(flags.dir || process.cwd());
  const name = (flags.name || os.userInfo().username).replace(/[#\s]+/g, '-');
  const cfg = { server: inv.server, token: inv.token, project: inv.project, name, root };

  process.stdout.write(`checking ${inv.server} … `);
  try {
    const s = await new Client(cfg, identity(cfg, 'join')).get('state');
    console.log(`ok, ${s.agents.filter(a => a.online).length} online`);
  } catch (e) {
    console.log('failed');
    need(flags.offline, `Couldn't reach the huddle server: ${e.message}\n(Is the host's server running? Pass --offline to set up anyway.)`);
  }

  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  const cfgFile = path.join(root, CONFIG_DIR, 'config.json');
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch {}
  if (prev.project && prev.project !== inv.project) prev = {}; // a different project: start clean
  fs.writeFileSync(cfgFile, JSON.stringify({ ...prev, server: inv.server, token: inv.token, project: inv.project, name }, null, 2) + '\n', { mode: 0o600 });
  ignoreLocally(root);
  const dir = selfInstall();
  rememberFolder(root);
  installHooks(root, dir);
  installCommand(root);
  const mcp = installMcp(root, dir);
  console.log(`
joined "${inv.project}" as ${name} in ${root}
  hooks   → .claude/settings.local.json
  tools   → ${mcp ? 'huddle MCP server registered for this folder' : 'see above'}
Live dashboard: ${inv.server}/#invite=${pos[0]}

Your Claude sessions here are shared with the team (your prompts, Claude's replies,
its tool calls) so everyone can follow along. Change that with: huddle sharing tools|off

While Claude is open here, your Claude is active for the team: it answers the other
Claudes' messages while you're away and runs work handed to it, using your Claude
subscription. Change it any time: /autopilot requests or /autopilot off (in Claude),
huddle autopilot off, or the dashboard.

Tip: huddle permissions --write makes a shared .claude/settings.json so nobody's Claude
asks before routine edits, git, builds and tests (deploys still ask).

Next: start (or restart) Claude Code in this folder, then just prompt it as usual.
It already knows who else is working, what's locked, and the team's PROJECT.md,
memory and skills. Ask it things like "what is everyone working on?" or
"remember that the tests need Docker running".${fs.existsSync(path.join(root, 'CLAUDE.md')) ? `

Tip: share your CLAUDE.md with the team without committing anything:
  huddle project --set CLAUDE.md` : ''}`);
  try { require('./shared').writeShared(root, await new Client(cfg, identity(cfg, 'join')).get('shared')); } catch {}
  if (!flags['no-sync']) {
    console.log('');
    try { await syncCopy({ ...cfg, root }, flags); }
    catch (e) { console.log(`couldn't compare with the team's version: ${e.message}\nTry again later with: huddle sync`); }
  }
}

// ---------- versions and branches ----------

let rl = null;
async function askUser(question, choices, dflt) {
  if (!process.stdin.isTTY) return dflt;
  if (!rl) rl = require('readline/promises').createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim().toLowerCase();
  if (!a) return dflt;
  return choices.find(c => c === a || c.startsWith(a)) || dflt;
}
const yes = async (q, dflt = 'y') => (await askUser(`${q} [${dflt === 'y' ? 'Y/n' : 'y/N'}] `, ['y', 'n'], dflt)) === 'y';
function closeAsk() { if (rl) { rl.close(); rl = null; } }

function gitClient(cfg) {
  const c = new Client(cfg, { ...identity(cfg, 'human'), kind: 'human' });
  c.agent.branch = gitx.currentBranch(cfg.root, 0);
  return c;
}

function commitAll(root, message) {
  gitx.ensureExcluded(root);
  gitx.git(root, ['add', '-A']);
  const r = gitx.git(root, ['commit', '-q', '-m', message]);
  return r.ok;
}

// Compare this copy with the team's and offer to merge, branch off, or switch.
// --sync merge|branch|theirs|share|skip answers without asking.
async function syncCopy(cfg, flags = {}) {
  const root = cfg.root;
  const choice = flags.sync;
  if (choice === 'skip') return;
  const client = gitClient(cfg);
  const st = await client.get('git');
  const me = client.agent;
  const others = Object.values(st.refs).filter(r => !(r.owner === me.name && r.checkout === me.checkout));

  if (!gitx.isRepo(root)) {
    const files = fs.readdirSync(root).filter(f => !['.huddle', '.claude', '.git'].includes(f));
    console.log('This folder is not a git repository. huddle uses git to merge different versions and to let people work on separate branches.');
    if (!(choice || await yes('Set it up with git now?'))) {
      console.log('OK. Live editing, locks and chat still work; run `git init` and `huddle sync` later for merging.');
      return closeAsk();
    }
    gitx.git(root, ['init', '-q', '-b', 'main']);
    gitx.ensureExcluded(root);
    if (files.length) commitAll(root, 'starting point before joining huddle');
  }
  if (others.length) {
    process.stdout.write('fetching the team\'s branches … ');
    const f = await gitx.fetchAll(client, root);
    console.log(`${f.fetched} new`);
  }
  me.branch = gitx.currentBranch(root, 0);
  const head = gitx.head(root);

  if (!others.length) {
    if (!head) { console.log('Nothing to share yet. Your commits are shared automatically once you make some.'); return closeAsk(); }
    console.log(`Nobody has shared code in this project yet.`);
    if (choice === 'share' || choice === 'merge' || await yes(`Share your ${me.branch || 'current'} branch so others can sync with it?`)) {
      const r = await gitx.publish(client, root);
      console.log(r.skipped ? `not shared: ${r.skipped}` : `shared ${r.branch} (${Math.ceil((r.bytes || 0) / 1024)} KB)`);
    }
    return closeAsk();
  }

  const target = others.filter(r => r.branch === me.branch).sort((a, b) => b.at - a.at)[0] || others.sort((a, b) => b.at - a.at)[0];
  const ref = gitx.shortRef(target.owner, target.branch);
  const label = `${target.owner}/${target.branch}`;
  if (!gitx.hasCommit(root, target.sha)) { console.log(`couldn't get ${label} yet; try \`huddle sync\` again in a moment`); return closeAsk(); }

  if (!head) {
    // brand new repo with nothing committed: just start from the team's version
    const r = gitx.git(root, ['checkout', '-q', '-B', target.branch, ref]);
    console.log(r.ok ? `Started from ${label}.` : `couldn't check out ${label}: ${r.err}`);
    return closeAsk();
  }

  const rel = gitx.relation(root, target.sha);
  const { ahead, behind } = gitx.counts(root, target.sha);
  if (rel === 'same') {
    console.log(`Your copy matches ${label}. You're on ${me.branch}; anyone else on ${me.branch} edits live with you.`);
    console.log('To work on your own branch instead: huddle branch own');
    return closeAsk();
  }
  if (rel === 'behind') {
    console.log(`${label} has ${behind} commit(s) you don't have.`);
    if (choice === 'skip' || !(choice || await yes('Update your copy to it?'))) return closeAsk();
    const r = gitx.git(root, ['merge', '-q', '--ff-only', ref]);
    console.log(r.ok ? `Updated to ${label}.` : `couldn't update: ${r.err}\n(commit or stash your changes, then run huddle sync)`);
    return closeAsk();
  }
  if (rel === 'ahead') {
    console.log(`You have ${ahead} commit(s) that ${label} doesn't.`);
    if (choice || await yes('Share them with the team?')) {
      const r = await gitx.publish(client, root);
      console.log(r.skipped ? `not shared: ${r.skipped}` : `shared ${r.branch}`);
    }
    return closeAsk();
  }

  console.log(rel === 'unrelated'
    ? `Your copy and ${label} don't share any history (different starting points).`
    : `Your copy and ${label} have both changed since they split: you have ${ahead} commit(s) they don't, they have ${behind} you don't.`);
  console.log(`  1) merge  — merge ${label} into your copy now (Claude can resolve any conflicts)
  2) branch — keep your version on your own branch and merge later; you'll still see each other and chat
  3) theirs — switch to ${label} (your version is kept on a backup branch)
  4) skip   — decide later with: huddle sync`);
  const pickd = choice || await askUser('Choose 1-4 [1]: ', ['1', '2', '3', '4', 'merge', 'branch', 'theirs', 'skip'], '1');
  const act = { 1: 'merge', 2: 'branch', 3: 'theirs', 4: 'skip' }[pickd] || pickd;
  if (act === 'skip') return closeAsk();

  const changed = gitx.dirty(root);
  if (changed.length && act !== 'branch') {
    console.log(`You have uncommitted changes in ${changed.length} file(s).`);
    if (!(flags.sync || await yes('Commit them first so nothing is lost?'))) { console.log('Stopped; nothing changed.'); return closeAsk(); }
    commitAll(root, 'work in progress before syncing with the team');
  }

  if (act === 'merge') {
    const m = gitx.merge(root, ref);
    if (m.ok) {
      console.log(`Merged ${label} into ${me.branch}.`);
      const r = await gitx.publish(client, root);
      if (!r.skipped) console.log(`shared the merged ${r.branch} with the team`);
    } else if (m.conflicts.length) {
      console.log(`Merged with conflicts in:\n${m.conflicts.map(c => '  ' + c).join('\n')}\nOpen Claude Code here and say "resolve the merge conflicts", or fix them by hand, then commit.`);
    } else console.log('merge failed:\n' + m.output);
  } else if (act === 'branch') {
    const own = ownBranchName(root, me.name, me.branch);
    const r = gitx.git(root, ['checkout', '-q', '-b', own]);
    if (!r.ok) { console.log(`couldn't create ${own}: ${r.err}`); return closeAsk(); }
    if (changed.length) commitAll(root, 'my work before joining huddle');
    const p = await gitx.publish(client, root, { branch: own });
    console.log(`You're on your own branch ${own}${p.skipped ? '' : ' (shared)'}. Nobody locks files on you, and you still see each other's activity and chat.\nMerge when you're ready: huddle merge ${target.owner}   (or ask Claude to)`);
  } else if (act === 'theirs') {
    const backup = `huddle-backup-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    gitx.git(root, ['branch', backup]);
    const r = gitx.git(root, ['reset', '-q', '--hard', ref]);
    console.log(r.ok ? `Switched to ${label}. Your previous version is on branch ${backup}.` : `couldn't switch: ${r.err}`);
  }
  closeAsk();
}

function ownBranchName(root, name, base) {
  let b = `${gitx.refSafe(name)}/${base || 'work'}`, i = 2;
  while (gitx.git(root, ['rev-parse', '--verify', '-q', `refs/heads/${b}`]).ok) b = `${gitx.refSafe(name)}/${base || 'work'}-${i++}`;
  return b;
}

// Connect Claude sessions started in this (parent) folder to a joined project inside it.
function cmdLink({ pos }) {
  need(pos[0], 'usage: huddle link PROJECT_FOLDER   (run in a folder that contains the joined project)');
  const here = process.cwd();
  const target = path.resolve(pos[0]);
  need(fs.existsSync(path.join(target, CONFIG_DIR, 'config.json')), `${target} isn't joined to a huddle yet (run huddle join there first)`);
  need(target !== here, 'that is this folder; it is already connected');
  const dir = selfInstall();
  rememberFolder(here, target);
  installHooks(here, dir, target);
  installCommand(here);
  const mcp = installMcp(here, dir, target);
  console.log(`Claude sessions started in ${here} now join the huddle of ${path.relative(here, target) || target}.
Only files inside that folder are shared and locked; everything else here stays local.${mcp ? '' : '\n(register the MCP server as shown above)'}
Undo with: huddle unlink`);
}

function cmdUnlink() {
  const here = process.cwd();
  const file = settingsPath(here);
  try {
    const s = stripHooks(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (s.permissions && s.permissions.allow) s.permissions.allow = s.permissions.allow.filter(p => p !== 'mcp__huddle');
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  } catch {}
  spawnSync('claude', ['mcp', 'remove', '-s', 'local', 'huddle'], { cwd: here, stdio: 'ignore' });
  console.log('Claude sessions started here are no longer connected to huddle');
}

// Claude Code's status line in a huddled folder: "● huddle · project · who's online · autopilot".
// Cached for a few seconds so it never slows the prompt down.
async function cmdStatusline() {
  let input = {};
  try { let raw = ''; for await (const c of process.stdin) raw += c; input = JSON.parse(raw || '{}'); } catch {}
  const cfg = loadConfig((input.workspace && input.workspace.current_dir) || input.cwd || process.cwd());
  if (!cfg || !cfg.server) return;
  const cache = path.join(cfg.root, CONFIG_DIR, 'statusline.json');
  let c = null;
  try { c = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch {}
  if (!c || Date.now() - c.at > 15000) {
    try {
      const client = new Client(cfg, identity(cfg, 'status'));
      const opt = { timeout: 1500 };
      const [s, st, m, b] = await Promise.all([client.get('state', null, opt), client.get('settings', null, opt),
        client.get('messages', { limit: 200 }, opt), client.get('board', null, opt)]);
      const others = [...new Set(s.agents.filter(a => a.online && a.name !== cfg.name && a.kind !== 'human').map(a => a.name))];
      const mode = (st.settings[cfg.name] || {}).autopilot || 'full';
      // what came in for this person since they last prompted (the prompt hook writes seen.json)
      const seenFile = path.join(cfg.root, CONFIG_DIR, 'seen.json');
      let seen = Date.now(); // nothing recorded yet: count from now, not the whole history
      try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')).at; } catch { try { fs.writeFileSync(seenFile, JSON.stringify({ at: seen })); } catch {} }
      const unread = m.messages.filter(x => x.at > seen && x.fromName !== cfg.name && (!x.to || x.to === cfg.name)).length;
      const requests = b.tasks.filter(t => t.direct && t.owner === cfg.name && t.status !== 'done').length;
      c = { at: Date.now(), ok: true, others, mode, unread, requests, usage: c && c.usage };
      // how much of this person's Claude plan is used, so plans can give heavier work to whoever has more left
      const rl = input.rate_limits || {};
      const u = { five: rl.five_hour && rl.five_hour.used_percentage, week: rl.seven_day && rl.seven_day.used_percentage,
        fiveResets: rl.five_hour && rl.five_hour.resets_at, weekResets: rl.seven_day && rl.seven_day.resets_at };
      const key = `${Math.round(u.five)}:${Math.round(u.week)}`;
      if (typeof u.five === 'number' && (!c.usage || c.usage.key !== key || Date.now() - c.usage.at > 30 * 60 * 1000)) {
        await client.post('usage', u, opt).then(() => { c.usage = { key, at: Date.now() }; }).catch(() => {});
      }
    } catch { c = { at: Date.now(), ok: false }; }
    try { fs.writeFileSync(cache, JSON.stringify(c)); } catch {}
  }
  const green = (t) => `\x1b[32m${t}\x1b[0m`, dim = (t) => `\x1b[2m${t}\x1b[0m`;
  if (!c.ok) return process.stdout.write(`${dim('○')} huddle · ${cfg.project} ${dim('· server unreachable')}`);
  const who = c.others.length ? `${c.others.join(', ')} online` : 'nobody else online';
  const mode = { requests: 'takes requests', full: 'active', off: 'requests wait' }[c.mode];
  const yellow = (t) => `\x1b[1;33m${t}\x1b[0m`;
  const mail = [c.unread ? `📬 ${c.unread} new message${c.unread === 1 ? '' : 's'}` : '',
    c.requests ? `${c.requests} request${c.requests === 1 ? '' : 's'} for your Claude` : ''].filter(Boolean).join(' · ');
  process.stdout.write(`${green('●')} huddle · ${cfg.project.replace(/-[0-9a-f]{6,8}$/, '')} ${dim('·')} ${who} ${dim('·')} ${mode}` +
    (mail ? ` ${dim('·')} ${yellow(mail)}` : ''));
}

async function cmdSync({ flags }) { await syncCopy(configured(), flags); }

async function cmdBranches() {
  const cfg = configured();
  need(gitx.isRepo(cfg.root), 'not a git repository (run `huddle sync` to set it up)');
  const client = gitClient(cfg);
  await gitx.fetchAll(client, cfg.root);
  const st = await client.get('git');
  const s = await client.get('state');
  console.log(`you: ${client.agent.branch || '(detached)'} at ${(gitx.head(cfg.root) || '').slice(0, 8)}${gitx.dirty(cfg.root).length ? ' (uncommitted changes)' : ''}\n`);
  for (const r of Object.values(st.refs).sort((a, b) => b.at - a.at)) {
    const own = r.owner === client.agent.name && r.checkout === client.agent.checkout;
    let rel = '';
    if (!own && gitx.hasCommit(cfg.root, r.sha)) {
      const c = gitx.counts(cfg.root, r.sha), x = gitx.relation(cfg.root, r.sha);
      rel = x === 'same' ? 'same as yours' : `${x} (you +${c.ahead} / -${c.behind})`;
    }
    console.log(`${own ? '*' : ' '} ${(r.owner + '/' + r.branch).padEnd(28)} ${r.sha.slice(0, 8)}  ${ago(r.at).padEnd(8)} ${rel}  ${r.subject || ''}`);
  }
  if (!Object.keys(st.refs).length) console.log('  nothing published yet (huddle publish)');
  const on = s.agents.filter(a => a.online && a.kind === 'agent' && a.branch);
  if (on.length) console.log('\nonline: ' + [...new Set(on.map(a => `${a.name} on ${a.branch}`))].join(', '));
}

async function cmdForget({ pos }) {
  need(pos[0], 'usage: huddle forget NAME   (remove someone who left from the team list)');
  const r = await humanClient('human').post('forget-agent', { name: pos[0] });
  console.log(`removed ${pos[0]} (${r.removed} session${r.removed === 1 ? '' : 's'})`);
}

async function cmdSamePerson({ pos }) {
  need(pos[0] && pos[1], 'usage: huddle same-person OTHER_NAME NAME   (show OTHER_NAME as NAME from now on)');
  await humanClient('human').post('merge-person', { from: pos[0], into: pos[1] });
  console.log(`${pos[0]} now shows as ${pos[1]} everywhere`);
}

async function cmdUnpublish({ pos }) {
  const cfg = configured();
  const r = await gitClient(cfg).post('git-forget', { branch: pos[0] || undefined });
  console.log('removed ' + r.removed.join(', '));
}

async function cmdPublish() {
  const cfg = configured();
  const r = await gitx.publish(gitClient(cfg), cfg.root);
  console.log(r.skipped ? `nothing shared: ${r.skipped}` : r.unchanged ? `${r.branch} is already shared` : `shared ${r.branch} at ${r.tip.slice(0, 8)}`);
}

async function cmdFetch() {
  const cfg = configured();
  const r = await gitx.fetchAll(gitClient(cfg), cfg.root, console.log);
  console.log(r.skipped || `fetched ${r.fetched} new bundle(s); branches are under huddle/<person>/<branch>`);
}

async function cmdMerge({ pos }) {
  const cfg = configured();
  need(pos[0], 'usage: huddle merge PERSON[/BRANCH]');
  const client = gitClient(cfg);
  const f = await gitx.fetchAll(client, cfg.root);
  const r = gitx.resolveRef(f.refs, pos[0], client.agent);
  need(r, `no published branch matches "${pos[0]}" (see huddle branches)`);
  need(!gitx.dirty(cfg.root).length, 'commit your changes first, then merge');
  const m = gitx.merge(cfg.root, gitx.shortRef(r.owner, r.branch));
  if (m.ok) {
    console.log(`merged ${r.owner}/${r.branch} into ${client.agent.branch}`);
    await gitx.publish(client, cfg.root);
  } else if (m.conflicts.length) {
    console.log(`conflicts in:\n${m.conflicts.map(c => '  ' + c).join('\n')}\nAsk Claude: "resolve the merge conflicts", or fix by hand and commit.`);
  } else console.log('merge failed:\n' + m.output);
}

async function cmdBranch({ pos }) {
  const cfg = configured();
  need(gitx.isRepo(cfg.root), 'not a git repository (run `huddle sync` to set it up)');
  const client = gitClient(cfg);
  const cur = client.agent.branch;
  if (pos[0] === 'own') {
    const name = pos[1] || ownBranchName(cfg.root, cfg.name, cur);
    const r = gitx.git(cfg.root, ['checkout', '-q', '-b', name]);
    need(r.ok, r.err);
    const p = await gitx.publish(client, cfg.root, { branch: name });
    return console.log(`now on your own branch ${name}${p.skipped ? '' : ' (shared)'}. No locks with people on other branches; merge later with huddle merge PERSON.`);
  }
  if (pos[0] === 'join') {
    need(pos[1], 'usage: huddle branch join PERSON[/BRANCH]');
    const f = await gitx.fetchAll(client, cfg.root);
    const r = gitx.resolveRef(f.refs, pos[1], client.agent);
    need(r, `no published branch matches "${pos[1]}"`);
    need(!gitx.dirty(cfg.root).length, 'commit or stash your changes first');
    const ref = gitx.shortRef(r.owner, r.branch);
    const exists = gitx.git(cfg.root, ['rev-parse', '--verify', '-q', `refs/heads/${r.branch}`]).ok;
    if (exists) {
      gitx.git(cfg.root, ['checkout', '-q', r.branch]);
      const rel = gitx.relation(cfg.root, r.sha);
      if (rel === 'behind') gitx.git(cfg.root, ['merge', '-q', '--ff-only', ref]);
      else if (rel !== 'same') return console.log(`switched to ${r.branch}, but it differs from ${r.owner}'s (${rel}). Run huddle merge ${r.owner}/${r.branch} to combine them.`);
    } else {
      const c = gitx.git(cfg.root, ['checkout', '-q', '-b', r.branch, ref]);
      need(c.ok, c.err);
    }
    return console.log(`on ${r.branch} with ${r.owner}: you now edit together live, with locks.`);
  }
  console.log(`you are on ${cur || '(detached)'}\n  huddle branch own [NAME]          work on your own branch\n  huddle branch join PERSON[/BRANCH]  work on someone's branch with them\n  huddle branches                   see everyone's`);
}

async function cmdAsk({ pos, flags }) {
  need(pos.length, 'usage: huddle ask "what the team should do" [--to NAME]');
  const r = await humanClient('human').post('goal', { text: pos.join(' '), to: flags.to || null });
  console.log(flags.to ? `sent to ${flags.to}'s Claude` : `posted to the team as goal ${r.goal.id}. The first free Claude plans it and hands out tasks; follow along with huddle watch or huddle board.`);
  console.log('Claudes pick it up at their next step, or right away if their person runs huddle autopilot.');
}

async function cmdApprove({ pos, flags }) {
  const client = humanClient();
  if (!pos[0]) {
    const w = (await client.get('approvals')).approvals.filter(x => x.status === 'waiting' && x.owner === client.cfg.name);
    if (!w.length) return console.log('Nothing is waiting for your OK.');
    for (const x of w) console.log(`${x.id}  ${x.command}${x.why ? `  (${x.why})` : ''}\n          for "${x.title}"`);
    return console.log('\nhuddle approve ID  lets that task run again with the command allowed; --deny says no.');
  }
  const r = await client.post('approve', { id: pos[0], allow: !flags.deny });
  console.log(r.approval.status === 'approved' ? `approved: ${r.approval.command}` : `said no to: ${r.approval.command}`);
}

async function cmdTests({ pos, flags }) {
  const client = humanClient();
  const body = {};
  if (pos.length) body.testCommand = pos.join(' ');
  if (flags.review !== undefined) body.review = !['off', 'false', 'no'].includes(String(flags.review));
  const ps = Object.keys(body).length ? (await client.post('project-setting', body)).settings : ((await client.get('state')).projectSettings || {});
  const ap = require('./autopilot');
  console.log(`tests before merging: ${ps.testCommand || `guessed (${ap.detectTests(client.cfg.root) || 'nothing found, so no tests run'})`}`);
  console.log(`Sonnet review: ${ps.review === false ? 'off' : 'on'}`);
}

async function cmdBoard() {
  console.log(require('./board').format(await humanClient('human').get('board')));
}

async function cmdAutopilot({ pos, flags }) {
  const ap = require('./autopilot');
  const cfg = configured();
  if (pos[0] && pos[0] !== 'run') {
    const mode = ap.normMode(pos[0]);
    need(mode, 'usage: huddle autopilot [on|requests|off]   (no argument: run here in the foreground)');
    await humanClient('human').post('setting', { autopilot: mode });
    return console.log(`autopilot: ${ap.MODE_WORDS[mode]}.
${mode === 'off' ? '' : 'It runs while you have Claude open in this folder, or while `huddle autopilot` runs in a terminal here.'}`);
  }
  await ap.runAutopilot(cfg, flags);
}

function cmdLeave() {
  const cfg = configured();
  const file = settingsPath(cfg.root);
  try {
    const s = stripHooks(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (s.permissions && s.permissions.allow) s.permissions.allow = s.permissions.allow.filter(p => p !== 'mcp__huddle');
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  } catch {}
  spawnSync('claude', ['mcp', 'remove', '-s', 'local', 'huddle'], { cwd: cfg.root, stdio: 'ignore' });
  fs.rmSync(path.join(cfg.root, CONFIG_DIR), { recursive: true, force: true });
  console.log('left the huddle; hooks and MCP server removed from this folder');
}

// ---------- everyday commands ----------

function humanClient(kind = 'cli') {
  const cfg = configured();
  return new Client(cfg, identity(cfg, kind));
}

async function cmdAiName({ pos, flags }) {
  const c = humanClient('human');
  const me = c.cfg.name;
  if (pos.length || flags.clear) {
    const r = await c.post('setting', { aiName: flags.clear ? '' : pos.join(' ') });
    return console.log(r.settings.aiName
      ? `your Claude is now "${r.settings.aiName}". The team sees it as ${r.settings.aiName} (${me}'s Claude) and can send it work with --to ${r.settings.aiName}.`
      : `your Claude has no name now; it shows as ${me}'s Claude.`);
  }
  const st = await c.get('settings');
  const n = (st.settings[me] || {}).aiName;
  console.log(n ? `your Claude is "${n}". Change it with huddle ai-name NAME, or --clear.` : `your Claude has no name yet. Give it one with huddle ai-name NAME.`);
  const others = Object.entries(st.settings).filter(([who, x]) => who !== me && x && x.aiName);
  if (others.length) console.log('\n' + others.map(([who, x]) => `${x.aiName.padEnd(16)} ${who}'s Claude`).join('\n'));
}

async function cmdStatus() {
  const c = humanClient();
  const [s, hand] = await Promise.all([c.get('state'), c.get('handoffs', { limit: 6 }).catch(() => ({ handoffs: [] }))]);
  const settings = s.settings || {};
  console.log(`${c.cfg.project} @ ${c.cfg.server}\n`);
  // one block per person: their Claude sessions (and background request Claudes) underneath
  const people = new Map();
  for (const a of s.agents.filter(a => a.kind !== 'cli')) {
    if (!people.has(a.name)) people.set(a.name, []);
    people.get(a.name).push(a);
  }
  const lower = new Map();
  for (const n of people.keys()) lower.set(n.toLowerCase(), [...(lower.get(n.toLowerCase()) || []), n]);
  const order = [...people.entries()].sort((x, y) => y[1].some(a => a.online) - x[1].some(a => a.online) || x[0].localeCompare(y[0]));
  for (const [name, list] of order) {
    const on = list.filter(a => a.online);
    const ai = (settings[name] || {}).aiName;
    const last = Math.max(...list.map(a => a.lastSeen));
    console.log(`${on.length ? '●' : '○'} ${ai ? `${name} (${ai})` : name}${on.length ? '' : `  seen ${ago(last)}`}`);
    for (const a of on.filter(a => a.kind !== 'human')) {
      const what = a.clone ? `background Claude, ${a.clone}` : a.kind === 'autopilot' ? 'autopilot' : 'Claude';
      console.log(`    ${what}${a.branch ? ' on ' + a.branch : ''}${a.status ? ` · ${a.status}${a.statusAt ? ` (${ago(a.statusAt)})` : ''}` : ''}`);
    }
  }
  const dupes = [...lower.values()].filter(v => v.length > 1);
  if (dupes.length) console.log(`\n${dupes.map(v => v.join(' / ')).join(', ')} look like the same person: huddle tidy merges them`);
  console.log('\nlocks:' + (s.locks.length ? '' : ' none'));
  for (const l of s.locks) console.log(`  🔒 ${l.path}${l.dir ? ' (whole folder)' : ''}  ${l.holderName}, ${ago(l.since)}${l.note ? ' — ' + l.note : ''}`);
  const recent = s.files.filter(f => f.size).sort((a, b) => b.at - a.at).slice(0, 8);
  if (recent.length) console.log('\nrecent edits:');
  for (const f of recent) console.log(`  ${f.path} v${f.version} by ${f.byName}, ${ago(f.at)}`);
  if (hand.handoffs.length) console.log('\nwhere people left off:');
  for (const h of hand.handoffs.reverse()) console.log(`  ${h.name}, ${ago(h.at)}: ${h.text}`);
}

async function cmdTidy() {
  const r = await humanClient('human').post('tidy', {});
  for (const m of r.merged) console.log(`${m.from} is now ${m.into}`);
  console.log(`${r.merged.length ? '' : 'no duplicate names. '}removed ${r.removed} old session${r.removed === 1 ? '' : 's'} from the team list`);
}

async function cmdHandoff({ pos }) {
  const c = humanClient('human');
  if (pos.length) {
    await c.post('handoff', { text: pos.join(' ') });
    return console.log('saved; the team and your next Claude session see it');
  }
  const r = await c.get('handoffs', { limit: 20 });
  if (!r.handoffs.length) return console.log('no hand-off notes yet');
  for (const h of r.handoffs) {
    console.log(`${h.name}, ${ago(h.at)}${h.branch ? ' on ' + h.branch : ''}${h.auto ? ' (written by huddle)' : ''}\n  ${h.text}`);
    if (h.commits.length) console.log(`  commits: ${h.commits.join('; ')}`);
    if (h.files.length) console.log(`  files: ${h.files.join(', ')}`);
  }
}

async function cmdSend({ pos, flags }) {
  need(pos.length, 'usage: huddle send <text> [--to NAME]');
  await humanClient('human').post('message', { text: pos.join(' '), to: flags.to || null });
  console.log('sent');
}

async function cmdInbox({ flags }) {
  const c = humanClient('human');
  const r = await c.post('inbox', { wait: Number(flags.wait || 0) }, { timeout: (Number(flags.wait || 0) + 15) * 1000 });
  console.log(r.messages.length ? formatMessages(r.messages, c.agent) : 'no new messages');
}

function isDirArg(p) {
  if (/[\\/]$/.test(p)) return true;
  try { return fs.statSync(path.resolve(p)).isDirectory(); } catch { return false; }
}

async function cmdLock({ pos, flags }) {
  const c = humanClient('human');
  const branch = gitx.isRepo(c.cfg.root) ? gitx.currentBranch(c.cfg.root, 0) : null;
  for (const p of pos) {
    const r0 = relPath(c.cfg.root, path.resolve(p));
    need(r0, `${p} is outside the project`);
    const dir = isDirArg(p);
    const r = await c.post('lock', dir ? { path: r0 + '/', dir: true, branch, note: flags.note || '' }
      : { path: r0, branch, note: flags.note || '', hold: true, baseHash: hashFile(path.resolve(p)) });
    console.log(r.ok ? `locked ${r0}${dir ? '/ (the whole folder)' : ''}` : `${r0}${dir ? '/' : ''} overlaps ${r.lock.path}, locked by ${r.lock.holderName}`);
  }
}

async function cmdUnlock({ pos }) {
  const c = humanClient('human');
  const r = pos.length
    ? await c.post('unlock', { paths: pos.map(p => relPath(c.cfg.root, path.resolve(p)) + (isDirArg(p) ? '/' : '')), branch: gitx.isRepo(c.cfg.root) ? gitx.currentBranch(c.cfg.root, 0) : null })
    : await c.post('unlock', { all: true });
  console.log(r.released.length ? 'released ' + r.released.join(', ') : 'nothing to release');
}

async function cmdWatch() {
  const { Sync } = require('./sync');
  const c = humanClient('human');
  const t = () => new Date().toLocaleTimeString();
  const sync = new Sync(c, c.cfg, (m) => console.log(`${t()}  ${m}`));
  sync.onEvent = (ev) => {
    const line = {
      join: () => `${ev.agent.name} joined`,
      leave: () => `${ev.agent.name} went offline`,
      status: () => `${ev.agent.name}: ${ev.agent.status}`,
      lock: () => `🔒 ${ev.lock.holderName} locked ${ev.lock.path}`,
      unlock: () => `🔓 ${ev.holderName} released ${ev.path}${ev.reason === 'stale' ? ' (timed out)' : ''}`,
      file: () => `✎ ${ev.file.byName} edited ${ev.file.path} (v${ev.file.version})`,
      message: () => `💬 ${ev.message.fromName}${ev.message.to ? ' → ' + ev.message.to : ''}: ${ev.message.text}`,
      activity: () => ev.items.map(it => `🤖 ${ev.agent.name}: ${it.kind === 'prompt' ? '❯ ' + it.text : it.kind === 'tool' ? '→ ' + it.text : it.kind === 'end' ? '(done)' : it.text}`.replace(/\n/g, '\n      ')).join('\n' + t() + '  '),
      shared: () => `📚 ${ev.byName} ${ev.action === 'delete' ? 'deleted' : ev.action === 'add' ? 'added' : 'updated'} ${ev.kind === 'doc' ? 'PROJECT.md' : ev.kind + ' ' + (ev.title || ev.name)}`,
    }[ev.type];
    if (line) console.log(`${t()}  ${line()}`);
  };
  setInterval(() => c.post('hello', {}).catch(() => {}), 45000);
  const stop = () => { sync.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`watching ${c.cfg.project} (ctrl-c to stop)` + (sync.claim() ? '' : ' — another session already syncs this folder, showing events only'));
  await sync.start();
}

async function cmdProject({ flags }) {
  const c = humanClient('human');
  const sh = await c.get('shared');
  const cur = sh.doc ? sh.doc.text : '';
  let text = null;
  if (flags.set) text = fs.readFileSync(path.resolve(flags.set), 'utf8');
  else if (flags.edit) {
    const tmp = path.join(os.tmpdir(), `huddle-PROJECT-${process.pid}.md`);
    fs.writeFileSync(tmp, cur || '# Project\n\nGoals, conventions, architecture, how to run and test, who is working on what.\n');
    const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'nano');
    const r = spawnSync(editor, [tmp], { stdio: 'inherit', shell: true });
    text = fs.readFileSync(tmp, 'utf8');
    fs.rmSync(tmp, { force: true });
    if (r.status !== 0 || text === cur) return console.log('no changes');
  }
  if (text === null) {
    if (!cur.trim()) return console.log('PROJECT.md is empty. Write one with `huddle project --edit` or `huddle project --set CLAUDE.md`.');
    return console.log(`PROJECT.md v${sh.doc.version}, edited by ${sh.doc.byName} ${ago(sh.doc.at)}\n\n${cur}`);
  }
  const r = await c.post('doc', { text, baseVersion: sh.doc ? sh.doc.version : 0 });
  console.log(`PROJECT.md saved (v${r.version}); every agent sees it`);
}

async function cmdMemory({ pos }) {
  const c = humanClient('human');
  if (pos[0] === 'add') {
    need(pos[1] && pos[2], 'usage: huddle memory add "title" "text"');
    const r = await c.post('memory', { title: pos[1], text: pos.slice(2).join(' ') });
    return console.log(`${r.action === 'add' ? 'saved' : 'updated'} ${r.id}`);
  }
  if (pos[0] === 'rm') {
    need(pos[1], 'usage: huddle memory rm ID');
    await c.post('forget', { id: pos.slice(1).join(' ') });
    return console.log('forgotten');
  }
  const sh = await c.get('shared');
  if (!sh.memories.length) return console.log('no shared memories yet');
  for (const m of sh.memories) console.log(`[${m.id}] ${m.title}  (${m.byName}, ${ago(m.at)})\n    ${m.text.replace(/\n/g, '\n    ')}\n`);
}

async function cmdSkill({ pos, flags }) {
  const c = humanClient('human');
  if (pos[0] === 'add') {
    need(pos[1], 'usage: huddle skill add PATH  (a SKILL.md or a folder containing one)');
    let file = path.resolve(pos[1]);
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'SKILL.md');
    const body = fs.readFileSync(file, 'utf8');
    const fm = require('./core').parseFrontmatter(body);
    const name = flags.name || fm.name || path.basename(path.dirname(file));
    const r = await c.post('skill', { name, body, description: flags.description });
    return console.log(`shared skill "${r.name}" (v${r.version})`);
  }
  if (pos[0] === 'rm') {
    need(pos[1], 'usage: huddle skill rm NAME');
    await c.post('skill-delete', { name: pos[1] });
    return console.log('removed');
  }
  const sh = await c.get('shared');
  if (!sh.skills.length) return console.log('no shared skills yet');
  for (const k of sh.skills) console.log(`${k.name}  v${k.version} by ${k.byName}\n    ${k.description}\n`);
}

function cmdSharing({ pos }) {
  const cfg = configured();
  const file = path.join(cfg.root, CONFIG_DIR, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pos[0]) {
    need(['full', 'tools', 'off'].includes(pos[0]), 'usage: huddle sharing full|tools|off');
    raw.shareActivity = pos[0];
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  }
  const level = raw.shareActivity || 'full';
  console.log({
    full: 'sharing: full. Others see your prompts, Claude\'s replies and its tool calls.',
    tools: 'sharing: tools. Others see which tools your Claude runs (commands, files), not the conversation.',
    off: 'sharing: off. Others only see locks, edits and messages.',
  }[level] + (pos[0] ? '' : '\nchange with: huddle sharing full|tools|off'));
}

function cmdInvite() {
  const cfg = configured();
  const code = encodeInvite(cfg.server, cfg.token, cfg.project);
  console.log(joinCommand(code));
  console.log(`\ndashboard: ${cfg.server}/#invite=${code}`);
}

function cmdOpen() {
  const cfg = configured();
  // your approve key rides along (the page keeps it and drops it from the address bar), so this
  // browser can approve commands your Claude asks for
  const key = ownerKey(cfg);
  const url = `${cfg.server}/#invite=${encodeInvite(cfg.server, cfg.token, cfg.project)}${key ? '&name=' + encodeURIComponent(cfg.name) + '&k=' + key : ''}`;
  if (key) humanClient().post('hello', { keyHash: sha(key) }).catch(() => {});
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => console.log(url)).unref();
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  const cmds = {
    server: cmdServer, new: cmdNew, join: cmdJoin, leave: cmdLeave, status: cmdStatus, send: cmdSend, inbox: cmdInbox,
    lock: cmdLock, unlock: cmdUnlock, watch: cmdWatch, invite: cmdInvite, open: cmdOpen, approve: cmdApprove, tests: cmdTests,
    project: cmdProject, sharing: cmdSharing, 'ai-name': cmdAiName, update: cmdUpdate, permissions: cmdPermissions, tidy: cmdTidy, handoff: cmdHandoff, handoffs: cmdHandoff,
    sync: cmdSync, branches: cmdBranches, branch: cmdBranch, publish: cmdPublish, fetch: cmdFetch, merge: cmdMerge,
    ask: cmdAsk, board: cmdBoard, autopilot: cmdAutopilot, unpublish: cmdUnpublish, forget: cmdForget, 'same-person': cmdSamePerson, link: cmdLink, unlink: cmdUnlink, statusline: cmdStatusline, memory: cmdMemory, memories: cmdMemory, skill: cmdSkill, skills: cmdSkill,
    hook: () => require('./hooks').runHook(args.pos[0]),
    mcp: () => require('./mcp').runMcp(),
  };
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === '--version' || cmd === '-v') return console.log(require('../package.json').version);
  need(cmds[cmd], `unknown command "${cmd}"\n\n${HELP}`);
  try { await cmds[cmd](args); }
  catch (e) { console.error(`huddle: ${e.message}`); process.exit(1); }
}

main();

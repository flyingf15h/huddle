// `huddle doctor`: checks that this folder is set up the way huddle needs and says what to fix,
// one line per check. Nothing here changes anything.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { loadConfig, Client, identity, CONFIG_DIR } = require('./client');
const policy = require('./policy');

const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// every file under root that the project's private-file rules cover (shallow walk, skips junk folders)
function privateFiles(root, settings, limit = 400) {
  const found = [];
  const walk = (dir, depth) => {
    if (found.length >= limit || depth > 4) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (['node_modules', '.git', CONFIG_DIR, 'dist', 'build', '.venv'].includes(e.name)) continue;
      const abs = path.join(dir, e.name), rel = path.relative(root, abs).split(path.sep).join('/');
      if (policy.isPrivatePath(settings, e.isDirectory() ? rel + '/x' : rel)) { found.push(rel + (e.isDirectory() ? '/' : '')); continue; }
      if (e.isDirectory()) walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

async function doctor({ installDir, hookMark }) {
  const rows = [];
  const add = (level, text, fix) => rows.push({ level, text, fix });
  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 22 ? 'ok' : major >= 18 ? 'warn' : 'bad', `Node ${process.versions.node} on ${process.platform}`, major < 22 ? 'Node 22 or newer is recommended (huddle works on 18+)' : '');
  add(has('git') ? 'ok' : 'warn', has('git') ? 'git is installed' : 'git is missing', 'install git; without it code isn\'t shared through huddle (live edits still are)');

  const cfg = loadConfig();
  if (!cfg || !cfg.server) {
    add('bad', 'this folder isn\'t in a huddle', 'run `huddle join <invite>` (or `huddle new`) in the project folder');
    return rows;
  }
  const raw = readJson(path.join(cfg.root, CONFIG_DIR, 'config.json')) || {};
  const agent = raw.agent || 'claude';
  const tool = agent === 'cursor' ? (has('agent') || has('cursor-agent') ? 'agent' : null) : has(agent) ? agent : null;
  add(tool ? 'ok' : agent === 'cursor' ? 'warn' : 'bad', tool ? `${agent} is installed` : `${agent}'s command line isn't installed`,
    agent === 'codex' ? 'npm install -g @openai/codex' : agent === 'cursor' ? 'only needed for background requests: curl https://cursor.com/install -fsS | bash' : 'npm install -g @anthropic-ai/claude-code');

  // the server and this project's token
  let state = null;
  const t0 = Date.now();
  try {
    state = await new Client(cfg, identity(cfg, 'doctor')).get('state');
    add('ok', `${cfg.server} answers in ${Date.now() - t0} ms, project "${String(cfg.project).replace(/-[0-9a-f]{6,8}$/, '')}" has ${state.agents.filter(a => a.online).length} online`);
  } catch (e) {
    add('bad', `can't use ${cfg.server}: ${e.message}`, e.status === 401 ? 'your access was taken back or the project is gone; ask for a new invite' : 'check your connection, or that the host\'s server is running');
  }

  // hooks and tools wired into this folder
  const hookFile = agent === 'codex' ? path.join(cfg.root, '.codex', 'hooks.json') : agent === 'cursor' ? path.join(cfg.root, '.cursor', 'hooks.json') : path.join(cfg.root, '.claude', 'settings.local.json');
  let hooked = false;
  try { hooked = fs.readFileSync(hookFile, 'utf8').includes(hookMark); } catch {}
  add(hooked ? 'ok' : 'bad', hooked ? 'hooks are installed' : 'huddle\'s hooks are missing from this folder', 'run `huddle join` again here (your invite or `huddle invite`)');
  const cliPath = path.join(installDir, 'src', 'cli.js');
  add(fs.existsSync(cliPath) ? 'ok' : 'bad', fs.existsSync(cliPath) ? 'the installed copy that hooks run exists' : `${cliPath} is missing, so every hook fails`, 'run `huddle update`');
  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['huddle'], { encoding: 'utf8' }).status === 0;
  add(onPath ? 'ok' : 'warn', onPath ? '`huddle` is on your PATH' : '`huddle` isn\'t on your PATH', `use \`npx -y github:flyingf15h/huddle <command>\`, or run: node "${cliPath}" <command>`);

  // privacy: what is shared, and which sensitive files here are kept private
  const sharing = raw.shareActivity || 'tools';
  const cap = state && state.projectSettings && state.projectSettings.maxSharing;
  add(sharing === 'full' ? 'warn' : 'ok', `sharing: ${sharing} (${{ full: 'teammates see your prompts and replies', tools: 'teammates see which tools ran, not your conversation', off: 'teammates see only locks, edits and messages' }[sharing] || sharing})${cap && cap !== 'full' ? `; the project caps everyone at ${cap}` : ''}`, sharing === 'full' ? 'huddle sharing tools keeps your conversation to yourself' : '');
  const settings = state && state.projectSettings;
  const secrets = privateFiles(cfg.root, settings);
  add('ok', secrets.length ? `kept private, never uploaded: ${secrets.slice(0, 6).join(', ')}${secrets.length > 6 ? ` and ${secrets.length - 6} more` : ''}` : 'no .env, key or credential files found here (those would stay private)');
  const probe = policy.redact('token=ghp_' + 'a'.repeat(36) + ' password: hunter2hunter2');
  add(/ghp_a{36}|hunter2hunter2/.test(probe) ? 'bad' : 'ok', /ghp_a{36}|hunter2hunter2/.test(probe) ? 'secret redaction isn\'t working' : 'secrets in shared text are stripped');

  // permissions that let an agent send things off this machine without asking
  const perm = readJson(path.join(cfg.root, '.claude', 'settings.local.json')) || {};
  const risky = ((perm.permissions && perm.permissions.allow) || []).filter(a => /^Bash\((curl|wget|ssh|scp|rsync|git push|npm publish|sudo|rm)\b/.test(a) || a === 'Bash' || /^Bash\(\*\)/.test(a));
  add(risky.length ? 'warn' : 'ok', risky.length ? `your agent may run without asking: ${risky.slice(0, 4).join(', ')}` : 'nothing that sends data off this computer is allowed without asking',
    risky.length ? 'remove those from .claude/settings.local.json unless you meant them' : '');
  if (state && state.agents) {
    const mine = state.agents.find(a => a.name === cfg.name && a.build);
    const newest = state.agents.filter(a => a.build).sort((x, y) => y.build.at - x.build.at)[0];
    if (mine && newest && newest.build.at > mine.build.at + 60 * 1000) add('warn', 'a teammate runs a newer huddle than you', 'run `huddle update`');
  }
  return rows;
}

function print(rows) {
  const icon = { ok: '✓', warn: '!', bad: '✗' };
  for (const r of rows) console.log(`${icon[r.level]} ${r.text}${r.fix && r.level !== 'ok' ? `\n    → ${r.fix}` : ''}`);
  const bad = rows.filter(r => r.level === 'bad').length, warn = rows.filter(r => r.level === 'warn').length;
  console.log(bad ? `\n${bad} problem${bad > 1 ? 's' : ''} to fix.` : warn ? `\nWorks, with ${warn} thing${warn > 1 ? 's' : ''} worth a look.` : '\nAll good.');
  return bad ? 1 : 0;
}

module.exports = { doctor, print, privateFiles };

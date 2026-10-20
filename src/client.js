// Shared client bits: finding the project config, working out who "this agent"
// is, and talking to the relay.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CONFIG_DIR = '.huddle';

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }

function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_DIR, 'config.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function loadConfig(start) {
  const root = process.env.HUDDLE_ROOT || findRoot(start || process.env.CLAUDE_PROJECT_DIR);
  if (!root) return null;
  const file = path.join(root, CONFIG_DIR, 'config.json');
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return {
    ...cfg, // the rest of config.json: notify, shareGit, autopilotAllow, clone, …
    root,
    server: (process.env.HUDDLE_SERVER || cfg.server || '').replace(/\/+$/, ''),
    token: process.env.HUDDLE_TOKEN || cfg.token,
    project: process.env.HUDDLE_PROJECT || cfg.project,
    name: process.env.HUDDLE_NAME || cfg.name || `${os.userInfo().username}@${os.hostname()}`,
    releaseOnStop: cfg.releaseOnStop !== false,
    failClosed: !!cfg.failClosed,
    // how much of this person's Claude session others can watch: full | tools | off
    shareActivity: process.env.HUDDLE_SHARE || cfg.shareActivity || DEFAULT_SHARING,
  };
}

// The Claude Code (or Codex) process this hook / MCP server belongs to. Hooks and the MCP
// server are both descendants of it, so they agree on identity. CLAUDE_PID is
// only a fallback: an MCP server inherits it from whatever launched Claude, so
// it's wrong when Claude was started from inside another Claude session.
const DEFAULT_SHARING = 'tools'; // steps only until someone opts into sharing their conversation

function claudePid() {
  if (process.env.HUDDLE_SESSION) return process.env.HUDDLE_SESSION;
  if (process.platform === 'win32') return windowsAgentPid() || process.env.CLAUDE_PID || String(process.ppid);
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let comm = '', ppid = 0;
    try {
      if (process.platform === 'linux') {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      } else {
        const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        const m = out.match(/^(\d+)\s+(.*)$/);
        if (!m) break;
        ppid = Number(m[1]); comm = path.basename(m[2]);
      }
    } catch { break; }
    if (comm === 'claude' || /^codex/.test(comm)) return String(pid); // Claude Code or Codex
    pid = ppid;
  }
  return process.env.CLAUDE_PID || String(process.ppid);
}

// Windows has no /proc and no `ps`: ask PowerShell for the whole chain of parents in one go (a hook
// runs on every tool call, so the answer is remembered for as long as our parent process lives).
function windowsAgentPid() {
  const cache = path.join(os.tmpdir(), `huddle-agent-${process.ppid}.txt`);
  try { if (Date.now() - fs.statSync(cache).mtimeMs < 6 * 3600 * 1000) { const v = fs.readFileSync(cache, 'utf8').trim(); if (v) return v; } } catch {}
  const script = `$p=${process.ppid}; for($i=0;$i -lt 8 -and $p -gt 4;$i++){ $x=Get-CimInstance Win32_Process -Filter "ProcessId=$p"; if(-not $x){break}; "$p|$($x.Name)|$($x.CommandLine)"; $p=$x.ParentProcessId }`;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    for (const line of out.split(/\r?\n/)) {
      const [pid, name = '', cmd = ''] = line.split('|');
      if (/^(claude|codex)(\.exe)?$/i.test(name) || /@anthropic-ai[\\/]claude-code|[\\/]codex[\\/]/i.test(cmd)) {
        try { fs.writeFileSync(cache, pid); } catch {}
        return pid;
      }
    }
  } catch {}
  return null;
}

// key: what tells this agent apart from others in the same checkout (default: the Claude process)
function identity(cfg, kind = 'agent', key) {
  const host = os.hostname();
  const checkout = sha(host + ':' + cfg.root);
  key = key || (kind === 'agent' ? claudePid() : kind);
  return {
    id: `${cfg.name}#${sha(checkout + ':' + key).slice(0, 5)}`,
    name: cfg.name,
    host,
    checkout,
    kind,
  };
}

class Client {
  constructor(cfg, agent) {
    if (!cfg.server || !cfg.token || !cfg.project) throw new Error('huddle is not configured here (run `huddle join`)');
    this.cfg = cfg;
    this.agent = agent;
    this.base = `${cfg.server}/api/p/${encodeURIComponent(cfg.project)}`;
  }
  async req(method, ep, body, { timeout = 10000, query = '' } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(`${this.base}/${ep}${query}`, {
        method,
        headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify({ agent: this.agent, ...body }) : undefined,
        signal: ctl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(data.error || `HTTP ${res.status}`);
        e.status = res.status;
        throw e;
      }
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`huddle server timed out (${this.cfg.server})`);
      const code = e.cause && (e.cause.code || (e.cause.errors && e.cause.errors[0] && e.cause.errors[0].code));
      if (code || e.message === 'fetch failed') throw new Error(`can't reach huddle server ${this.cfg.server}${code ? ` (${code})` : ''}`);
      throw e;
    } finally { clearTimeout(t); }
  }
  post(ep, body, opts) { return this.req('POST', ep, body || {}, opts); }
  get(ep, params, opts) {
    const q = params ? '?' + new URLSearchParams(params) : '';
    return this.req('GET', ep, null, { ...opts, query: q });
  }
}

// path relative to the project root with forward slashes, or null if outside it
function relPath(root, file) {
  if (!file) return null;
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts[0] === CONFIG_DIR || parts[0] === '.git') return null;
  return parts.join('/');
}

function hashFile(abs) {
  try { return sha(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// which huddle this is: `huddle update` writes build.json next to src/ (sha and commit time)
function build() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build.json'), 'utf8')); } catch { return null; }
}

function formatMessages(msgs, me) {
  return msgs.map(m => {
    const to = m.to ? (m.to === me.id || m.to === me.name ? ' → you' : ` → ${m.to}`) : '';
    return `[${m.fromName}${to}, ${ago(m.at)}] ${m.text}`;
  }).join('\n');
}

// This person's approve key: it never leaves their machine except in the dashboard link `huddle open`
// makes, so only their own browser can approve commands for their Claude. The server keeps a hash.
function ownerKey(cfg) {
  if (cfg.ownerKey) return cfg.ownerKey;
  const file = path.join(cfg.root, CONFIG_DIR, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw.ownerKey) { raw.ownerKey = crypto.randomBytes(18).toString('base64url'); fs.writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 }); }
    return (cfg.ownerKey = raw.ownerKey);
  } catch { return null; }
}

// the person renamed themselves on the dashboard: take the new name into this folder's config, so the
// hooks, the MCP tools and the CLI use it too. Returns true when the name changed.
function adoptName(cfg, aliases) {
  const to = (aliases || {})[cfg.name];
  if (!to || to === cfg.name || process.env.HUDDLE_NAME) return false;
  const file = path.join(cfg.root, CONFIG_DIR, 'config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.name = to;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
  } catch {}
  cfg.name = to;
  return true;
}

module.exports = { loadConfig, identity, Client, relPath, hashFile, sha, ownerKey, ago, formatMessages, findRoot, build, adoptName, CONFIG_DIR };

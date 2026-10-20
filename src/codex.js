// OpenAI Codex support. Codex has the same kind of lifecycle hooks as Claude Code (SessionStart,
// UserPromptSubmit, PreToolUse, PostToolUse, Stop, SessionEnd) and reads MCP servers from
// .codex/config.toml, so a Codex session joins a huddle through the same hook handlers and MCP
// tools; this file holds what differs: where things are configured, how file edits look
// (apply_patch), what its transcript looks like, and how a background run is started.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const BEGIN = '# huddle-begin (written by huddle join; huddle leave removes it)';
const END = '# huddle-end';
const tomlStr = (s) => JSON.stringify(String(s)); // a TOML basic string has JSON's escapes

// the [mcp_servers.huddle] block in .codex/config.toml (project config, read once the folder is trusted)
function mcpBlock(dir, projectRoot) {
  return [BEGIN,
    '[mcp_servers.huddle]',
    `command = ${tomlStr(process.execPath)}`,
    `args = [${tomlStr(path.join(dir, 'src', 'cli.js'))}, "mcp"]`,
    `env = { HUDDLE_ROOT = ${tomlStr(projectRoot)}, HUDDLE_AGENT = "codex" }`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 600',
    END].join('\n');
}
function stripBlock(text) {
  const i = text.indexOf(BEGIN), j = text.indexOf(END);
  if (i < 0 || j < i) return text;
  return (text.slice(0, i) + text.slice(j + END.length)).replace(/\n{3,}/g, '\n\n').trim();
}

// .codex/hooks.json with huddle's handlers, keeping any hooks the project has of its own
function hooksJson(existing, cmd, mark) {
  let h = {};
  try { h = JSON.parse(existing || '{}'); } catch {}
  h.hooks = h.hooks || {};
  for (const ev of Object.keys(h.hooks)) {
    h.hooks[ev] = (h.hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(x => !String(x.command || '').includes(mark)) })).filter(g => g.hooks.length);
    if (!h.hooks[ev].length) delete h.hooks[ev];
  }
  const add = (ev, matcher, name, extra = {}) => {
    (h.hooks[ev] = h.hooks[ev] || []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd(name), timeout: 15, ...extra }] });
  };
  add('SessionStart', 'startup|resume|clear|compact', 'session-start', { additionalContextLimit: 6000, statusMessage: 'Joining the huddle' });
  add('UserPromptSubmit', null, 'prompt', { additionalContextLimit: 4000 });
  add('PreToolUse', '^(apply_patch|Bash)$', 'pre');
  add('PostToolUse', '*', 'post', { additionalContextLimit: 3000 });
  add('Stop', null, 'stop');
  add('SessionEnd', null, 'session-end', { timeout: 3 });
  if (!h.description) h.description = 'huddle: shared locks, live edits, team messages and activity';
  return JSON.stringify(h, null, 2) + '\n';
}

function install(root, dir, projectRoot, cmd, mark) {
  const cdir = path.join(root, '.codex');
  fs.mkdirSync(cdir, { recursive: true });
  const cfgFile = path.join(cdir, 'config.toml');
  let cur = '';
  try { cur = fs.readFileSync(cfgFile, 'utf8'); } catch {}
  fs.writeFileSync(cfgFile, (stripBlock(cur) ? stripBlock(cur) + '\n\n' : '') + mcpBlock(dir, projectRoot || root) + '\n');
  const hooksFile = path.join(cdir, 'hooks.json');
  let hj = '';
  try { hj = fs.readFileSync(hooksFile, 'utf8'); } catch {}
  fs.writeFileSync(hooksFile, hooksJson(hj, cmd, mark));
}
function uninstall(root, mark) {
  const cdir = path.join(root, '.codex');
  const cfgFile = path.join(cdir, 'config.toml');
  try {
    const left = stripBlock(fs.readFileSync(cfgFile, 'utf8'));
    if (left) fs.writeFileSync(cfgFile, left + '\n'); else fs.rmSync(cfgFile);
  } catch {}
  const hooksFile = path.join(cdir, 'hooks.json');
  try {
    const h = JSON.parse(hooksJson(fs.readFileSync(hooksFile, 'utf8'), () => mark, mark));
    // hooksJson put ours back; take every one of them out again
    for (const ev of Object.keys(h.hooks)) {
      h.hooks[ev] = h.hooks[ev].map(g => ({ ...g, hooks: g.hooks.filter(x => !String(x.command || '').includes(mark)) })).filter(g => g.hooks.length);
      if (!h.hooks[ev].length) delete h.hooks[ev];
    }
    if (Object.keys(h.hooks).length) fs.writeFileSync(hooksFile, JSON.stringify(h, null, 2) + '\n'); else fs.rmSync(hooksFile);
  } catch {}
  try { if (!fs.readdirSync(cdir).length) fs.rmdirSync(cdir); } catch {}
}

// the files an apply_patch call touches, relative to where Codex runs
function patchFiles(patch) {
  const out = [];
  for (const m of String(patch || '').matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) out.push((m[1] || m[2]).trim());
  return [...new Set(out)];
}

// Codex's session log (a "rollout" .jsonl): the assistant's messages, token use and rate limits.
// Not a stable format, so everything here is best effort and quietly skips what it doesn't know.
function rolloutLines(text) {
  const out = [];
  for (const line of text.split('\n')) { try { out.push(JSON.parse(line)); } catch {} }
  return out;
}
function assistantTexts(lines) {
  const texts = [];
  for (const d of lines) {
    const p = d && d.payload;
    if (d && d.type === 'response_item' && p && p.type === 'message' && p.role === 'assistant' && Array.isArray(p.content)) {
      const t = p.content.filter(c => c && (c.type === 'output_text' || c.type === 'text')).map(c => c.text).join('\n').trim();
      if (t) texts.push(t);
    }
  }
  return texts;
}
// { model: { input, output, cacheRead, cacheWrite, messages } } and the newest rate limits seen
function usageOf(lines, prevModel) {
  let model = prevModel || 'codex';
  const totals = {};
  let limits = null;
  for (const d of lines) {
    const p = d && d.payload;
    if (!p) continue;
    if (d.type === 'turn_context' && p.model) model = p.model;
    if (d.type === 'event_msg' && p.type === 'token_count') {
      const u = p.info && p.info.last_token_usage;
      if (u) {
        const t = totals[model] || (totals[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
        t.input += Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0));
        t.cacheRead += u.cached_input_tokens || 0;
        t.output += (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
        t.messages++;
      }
      if (p.rate_limits) limits = p.rate_limits;
    }
  }
  return { totals, limits, model };
}
// Codex's primary window is the 5-hour one and its secondary the weekly one, like Claude's
function usageReport(limits) {
  if (!limits) return null;
  const at = (w) => w && (w.resets_at ? Number(w.resets_at) * (w.resets_at < 1e12 ? 1000 : 1) : w.resets_in_seconds ? Date.now() + w.resets_in_seconds * 1000 : null);
  const pct = (w) => (w && typeof w.used_percent === 'number' ? w.used_percent : null);
  if (pct(limits.primary) == null && pct(limits.secondary) == null) return null;
  return { five: pct(limits.primary), week: pct(limits.secondary), fiveResets: at(limits.primary), weekResets: at(limits.secondary) };
}

// ---------- background runs ----------
// Commands the person approved, the project's allow list and its never-allowed list, as a Codex
// rules file in the run's worktree: approved ones run outside the sandbox, denied ones never run.
function rulesFile(allow, deny) {
  const words = (c) => String(c).trim().split(/\s+/).filter(w => w && w !== '*');
  const rule = (c, decision) => {
    const w = words(c);
    return w.length ? `prefix_rule(pattern = ${JSON.stringify(w)}, decision = "${decision}", justification = ${JSON.stringify(decision === 'forbidden' ? 'never allowed in this huddle project' : 'approved in huddle')})` : '';
  };
  return ['# written by huddle for one background run', ...allow.map(c => rule(c, 'allow')), ...deny.map(c => rule(c, 'forbidden'))].filter(Boolean).join('\n') + '\n';
}

// `codex exec` for one job. readOnly: a review; dir: the worktree (or the person's folder);
// gitDir: the main repository's .git, which a worktree's commits write into.
function execArgs({ dir, readOnly, model, gitDir, lastFile, mcpRoot, cli }) {
  const args = ['exec', '--skip-git-repo-check', '--color', 'never', '-C', dir,
    '-s', readOnly ? 'read-only' : 'workspace-write',
    '-c', 'approval_policy="never"',
    '-c', `projects.${tomlStr(dir)}.trust_level="trusted"`,
    '--dangerously-bypass-hook-trust',
    '-o', lastFile];
  if (gitDir && !readOnly) args.push('--add-dir', gitDir);
  if (model) args.push('-m', model);
  // its own huddle tools, pointed at the worktree it works in
  if (mcpRoot) args.push('-c', `mcp_servers.huddle.command=${tomlStr(process.execPath)}`, '-c', `mcp_servers.huddle.args=[${tomlStr(cli)}, "mcp"]`,
    '-c', `mcp_servers.huddle.env={ HUDDLE_ROOT = ${tomlStr(mcpRoot)}, HUDDLE_AGENT = "codex" }`);
  return args;
}

function installed() {
  const { spawnSync } = require('child_process');
  return require('./bin').spawnSync('codex', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
}
function tmpFile(name) { return path.join(os.tmpdir(), `huddle-${process.pid}-${Date.now()}-${name}`); }

module.exports = { install, uninstall, patchFiles, rolloutLines, assistantTexts, usageOf, usageReport, rulesFile, execArgs, installed, tmpFile, stripBlock, hooksJson };

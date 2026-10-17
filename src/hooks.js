// Claude Code hook handlers. Each runs as `huddle hook <event>` with the hook
// payload on stdin and answers with hook JSON on stdout.
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig, identity, Client, relPath, hashFile, sha, formatMessages, ago, CONFIG_DIR } = require('./client');
const shared = require('./shared');
const gitx = require('./git');
const board = require('./board');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const INBOX_EVERY_MS = 10 * 1000;

function withNotice(text, obj) { return { ...(obj || {}), systemMessage: text }; }
function out(obj) { if (obj) process.stdout.write(JSON.stringify(obj)); }
function ctx(event, text) { return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null; }
function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// Secrets and anything git ignores (.env files, build output, local config) stay on
// this machine: no lock, no live copy sent to the team.
function private_(root, rel) {
  if (/(^|\/)\.env(\.|$)|(^|\/)\.dev\.vars$|\.(pem|key)$/.test(rel)) return true;
  return gitx.isRepo(root) && gitx.git(root, ['check-ignore', '-q', '--', rel]).ok;
}

function targetOf(input) {
  const ti = input.tool_input || {};
  return ti.file_path || ti.notebook_path || null;
}

// small per-session scratch file so we don't hit the server for mail on every tool call
function sessionState(cfg, agent) {
  const file = path.join(cfg.root, CONFIG_DIR, 'sessions', agent.id.replace(/[^\w.-]/g, '_') + '.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  return {
    data,
    save() { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); },
  };
}

async function inbox(client, cfg, force) {
  const st = sessionState(cfg, client.agent);
  if (!force && Date.now() - (st.data.inboxAt || 0) < INBOX_EVERY_MS) return '';
  st.data.inboxAt = Date.now();
  st.save();
  const r = await client.post('inbox', {});
  const out = [];
  if (r.messages.length) out.push(`New huddle messages from other agents (reply with the huddle_send tool if useful):\n${formatMessages(r.messages, client.agent)}`);
  // someone changed PROJECT.md, a memory or a skill: refresh the files and tell the agent
  if (r.sharedVersion !== undefined && st.data.shared && r.sharedVersion !== st.data.shared.version) {
    const sh = await client.get('shared');
    shared.writeShared(cfg.root, sh);
    const change = shared.describeChanges(st.data.shared, sh);
    if (change) out.push(change);
    st.data.shared = shared.signature(sh);
    st.save();
  }
  if (r.boardVersion !== undefined && r.boardVersion !== st.data.boardVersion) {
    const b = await client.get('board');
    if (st.data.boardVersion !== undefined) {
      const note = board.describe(st.data.boardSeen || {}, b, client.agent.name);
      if (note) out.push(note);
    }
    st.data.boardVersion = b.version;
    st.data.boardSeen = board.signature(b);
    st.save();
  }
  return out.join('\n\n');
}

// Requests other people sent to this person's Claude that aren't finished, shown on every prompt.
// The request runner does them in the background unless the person turned it off; either way the
// Claude in front of the person should know about them.
async function openRequests(client) {
  const me = client.agent.name;
  const b = await client.get('board');
  const open = b.tasks.filter(t => t.direct && t.owner === me && t.status !== 'done');
  if (!open.length) return '';
  const settings = await client.get('settings').catch(() => ({ settings: {} }));
  const mode = ((settings.settings || {})[me] || {}).autopilot || 'requests';
  const how = mode === 'off'
    ? 'Your requests runner is off, so these wait for you: do them now if your user agrees, or tell your user they are waiting.'
    : 'Your request runner works through these in the background; don\'t redo them, but mention them to your user. A blocked one needs your user.';
  return `Requests sent to you (${me}'s Claude):\n` +
    open.map(t => `- [${t.id}] from ${t.by}, ${t.status}: ${t.title}${t.status === 'blocked' && t.notes && t.notes.length ? ` (${t.notes[t.notes.length - 1].text})` : ''}`).join('\n') +
    '\n' + how;
}

// After a turn, share the branch if it has new commits so others can merge it.
async function autoPublish(client, cfg, st) {
  if (cfg.shareGit === false || !gitx.isRepo(cfg.root)) return;
  const h = gitx.head(cfg.root);
  if (!h || st.data.publishedHead === h) return;
  try { await gitx.publish(client, cfg.root); st.data.publishedHead = h; st.save(); } catch {}
}

// One line saying what a tool call does, e.g. "Bash: npm test" or "Edit: src/app.js".
function toolSummary(name, input = {}) {
  const short = name.replace(/^mcp__huddle__/, '').replace(/^mcp__/, '');
  const root = process.env.CLAUDE_PROJECT_DIR || '';
  const rel = (f) => (root && f && f.startsWith(root + path.sep) ? f.slice(root.length + 1) : f);
  const detail = input.command || rel(input.file_path || input.notebook_path) || input.pattern || input.url ||
    input.query || input.description || input.text || input.path || input.prompt || '';
  return `${short}${detail ? ': ' + String(detail).replace(/\s+/g, ' ').slice(0, 300) : ''}`;
}

// New assistant text and tool calls since we last looked, read from the
// session transcript. Prompts come from the UserPromptSubmit hook instead.
function newActivity(input, st, level) {
  const file = input.transcript_path;
  if (!file || level === 'off') return [];
  let size;
  try { size = fs.statSync(file).size; } catch { return []; }
  if (st.data.transcript !== file || st.data.offset > size) { st.data.transcript = file; st.data.offset = size; return []; }
  if (size === st.data.offset) return [];
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(size - st.data.offset, 4 * 1024 * 1024));
  fs.readSync(fd, buf, 0, buf.length, st.data.offset);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return [];
  st.data.offset += Buffer.byteLength(text.slice(0, end + 1));
  const items = [];
  for (const line of text.slice(0, end).split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant' || d.isSidechain || !d.message || !Array.isArray(d.message.content)) continue;
    for (const c of d.message.content) {
      if (c.type === 'text' && c.text.trim() && level === 'full') {
        // the Stop hook already shared the final reply from last_assistant_message
        if (st.data.sentReply && c.text.trim() === st.data.sentReply) { delete st.data.sentReply; continue; }
        items.push({ kind: 'text', text: c.text.trim() });
      }
      else if (c.type === 'tool_use') items.push({ kind: 'tool', tool: c.name, text: toolSummary(c.name, c.input) });
    }
  }
  return items;
}

// Token usage since we last looked, per model, from the session transcript. Claude Code writes one
// line per content block, all carrying the same message id and usage, so each message counts once
// (the last line's numbers win); a message split across two reads only adds what's new.
function newUsage(input, st) {
  const file = input.transcript_path;
  let size;
  try { size = fs.statSync(file).size; } catch { return {}; }
  if (st.data.usageFile !== file || st.data.usageOffset > size) { st.data.usageFile = file; st.data.usageOffset = size; return {}; }
  if (size === st.data.usageOffset) return {};
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(Math.min(size - st.data.usageOffset, 8 * 1024 * 1024));
  fs.readSync(fd, buf, 0, buf.length, st.data.usageOffset);
  fs.closeSync(fd);
  const text = buf.toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return {};
  st.data.usageOffset += Buffer.byteLength(text.slice(0, end + 1));
  const byId = new Map();
  for (const line of text.slice(0, end).split('\n')) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.type === 'assistant' && d.message;
    if (!m || !m.usage || !m.model || m.model === '<synthetic>') continue;
    const u = m.usage;
    byId.set(m.id || line, { model: m.model, input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 });
  }
  const totals = {};
  for (const [id, u] of byId) {
    const prev = st.data.lastUsage && st.data.lastUsage.id === id ? st.data.lastUsage : null;
    const t = totals[u.model] || (totals[u.model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) t[k] += Math.max(0, u[k] - (prev ? prev[k] : 0));
    if (!prev) t.messages++;
    st.data.lastUsage = { id, ...u };
  }
  return totals;
}

// Counts for the stats page: conversations, turns, time spent with Claude and tokens. Numbers only;
// private turns count too, but nothing of what was said leaves the machine. shareStats: false stops it.
async function shareStats(input, client, cfg, st) {
  if (cfg.shareStats === false) return;
  const usage = newUsage(input, st);
  const started = st.data.turnStart;
  delete st.data.turnStart;
  const activeMs = started ? Math.min(Date.now() - started, 4 * 3600 * 1000) : 0;
  const conversation = !!st.data.newConversation;
  delete st.data.newConversation;
  st.save();
  if (!started && !Object.keys(usage).length) return;
  await client.post('stats', { conversation, turns: started ? 1 : 0, activeMs, usage, request: process.env.HUDDLE_AUTOPILOT === '1' });
}

// A prompt starting with "private:" (or "#private") keeps that whole turn, its
// prompt, replies and tool calls, out of the team's activity feed.
const PRIVATE_PROMPT = /^\s*(private\s*:|#private\b|\(private\))/i;

async function shareActivity(input, client, cfg, before = [], after = []) {
  if (cfg.shareActivity === 'off') return;
  const st = sessionState(cfg, client.agent);
  if (st.data.private) { newActivity(input, st, cfg.shareActivity); st.save(); return; } // read past it, share nothing
  const items = [...before, ...newActivity(input, st, cfg.shareActivity), ...after];
  st.save();
  if (items.length) await client.post('activity', { items });
}

// Claude Code writes the final reply to the transcript only after Stop hooks
// run, so take it from the hook input instead.
async function shareStop(input, client, cfg) {
  if (cfg.shareActivity === 'off') return;
  const st = sessionState(cfg, client.agent);
  if (st.data.private) { newActivity(input, st, cfg.shareActivity); st.save(); return; }
  const items = newActivity(input, st, cfg.shareActivity);
  const reply = String(input.last_assistant_message || '').trim();
  if (reply && cfg.shareActivity === 'full' && !items.some(it => it.kind === 'text' && it.text === reply)) {
    items.push({ kind: 'text', text: reply });
    st.data.sentReply = reply;
  }
  items.push({ kind: 'end', text: '' });
  st.save();
  await client.post('activity', { items });
}

function branchSummary(s, client, cfg) {
  if (!gitx.isRepo(cfg.root)) return 'This folder is not a git repository, so branches and merging are off (huddle_branches explains how to turn them on).';
  const mine = client.agent.branch;
  const others = s.agents.filter(a => a.online && a.id !== client.agent.id && a.kind === 'agent' && a.branch);
  const same = others.filter(a => a.branch === mine).map(a => a.name);
  const diff = others.filter(a => a.branch !== mine).map(a => `${a.name} on ${a.branch}`);
  return `You are on git branch ${mine || '(detached)'}.` +
    (same.length ? ` Same branch as you (live shared edits, locks apply): ${[...new Set(same)].join(', ')}.` : '') +
    (diff.length ? ` On other branches (no locks between you; merge later with huddle_merge): ${[...new Set(diff)].join(', ')}.` : '') +
    ' Commits you make are shared automatically at the end of each turn.';
}

function teamSummary(s, me) {
  const others = s.agents.filter(a => a.online && a.id !== me.id && a.kind !== 'watcher');
  const lines = [];
  lines.push(others.length
    ? 'Other agents online: ' + others.map(a => `${a.name}${a.host ? ' on ' + a.host : ''}${a.status ? ` ("${a.status}")` : ''}`).join('; ')
    : 'No other agents are online right now.');
  const theirs = s.locks.filter(l => l.holder !== me.id);
  if (theirs.length) lines.push('Files locked by others (read-only for you): ' + theirs.map(l => `${l.path} (${l.holderName}${l.note ? ': ' + l.note : ''})`).join(', '));
  return lines.join('\n');
}

const handlers = {
  async 'session-start'(input, client, cfg) {
    const s = await client.post('hello', {});
    const sh = await client.get('shared');
    shared.writeShared(cfg.root, sh);
    const here = input.cwd ? path.resolve(input.cwd) : cfg.root;
    const linked = here !== cfg.root && !path.relative(here, cfg.root).startsWith('..');
    if (linked) shared.writeSkills(here, sh); // skills are discovered from where Claude started
    const st = sessionState(cfg, client.agent);
    st.data.shared = shared.signature(sh);
    newActivity(input, st, cfg.shareActivity); // just positions us at the end of the transcript
    newUsage(input, st); // likewise: a resumed conversation's earlier usage was counted back then
    const b = await client.get('board');
    st.data.boardVersion = b.version;
    st.data.boardSeen = board.signature(b);
    st.save();
    if (gitx.isRepo(cfg.root)) gitx.fetchAll(client, cfg.root).catch(() => {});
    // shown to the person in their terminal, so they can see this session is in the huddle
    const others = [...new Set(s.agents.filter(a => a.online && a.name !== client.agent.name && a.kind !== 'human').map(a => a.name))];
    const settings = await client.get('settings').catch(() => ({ settings: {} }));
    const mode = (settings.settings[client.agent.name] || {}).autopilot || 'requests';
    const notice = `huddle: this session is in "${cfg.project.replace(/-[0-9a-f]{6,8}$/, '')}" as ${client.agent.name}` +
      ` · ${others.length ? others.join(', ') + ' online' : 'nobody else online'}` +
      ` · your Claude ${mode === 'full' ? 'is on full autopilot' : mode === 'off' ? 'does not take requests (/autopilot to change)' : 'takes requests (/autopilot to change)'}`;
    return withNotice(notice, ctx('SessionStart',
      `You are "${client.agent.name}" in huddle project "${client.cfg.project}", shared with other Claude agents working in the same codebase from other machines.\n` +
      (linked ? `The huddle project is the folder ./${path.relative(here, cfg.root)} (work and run git there). Only files inside it are shared with the team; other folders here are yours alone.\n` : '') +
      'Rules: before you edit a file it is locked for you automatically; files other agents are editing are read-only and edits to them will be refused. ' +
      'If that happens, work on something else, message the holder with huddle_send, look at their live copy with huddle_view, or block with huddle_wait. ' +
      'Set huddle_set_status to say what you are working on, and check huddle_status before starting larger changes so you do not overlap. ' +
      'Messages from other agents show up in your context automatically.\n' +
      'The team shares knowledge through huddle instead of git: the PROJECT.md brief (huddle_project), memory notes (huddle_remember / huddle_recall) and skills (huddle_save_skill). ' +
      'When you learn something another agent would otherwise have to rediscover (a gotcha, a decision, how to run or test something), save it.\n\n' +
      teamSummary(s, client.agent) + '\n' + branchSummary(s, client, cfg) + '\n\n' + board.briefing(b, client.agent.name) + '\n\n' + shared.briefing(sh)));
  },

  async pre(input, client, cfg) {
    if (!EDIT_TOOLS.has(input.tool_name)) return null;
    const rel = relPath(cfg.root, targetOf(input));
    if (!rel || private_(cfg.root, rel)) return null;
    const abs = path.join(cfg.root, ...rel.split('/'));
    const local = hashFile(abs);
    const branch = client.agent.branch;
    const r = await client.post('lock', { path: rel, branch, baseHash: local, wantContent: true });
    if (!r.ok) {
      const l = r.lock;
      return deny(`${rel} is locked by ${l.holderName} (since ${ago(l.since)}${l.note ? ', "' + l.note + '"' : ''}). ` +
        'It is read-only for you until they release it. Options: work on a different file, ask them via huddle_send, ' +
        'read their live version with huddle_view, or call huddle_wait to block until it is free.');
    }
    try {
      const st = fs.statSync(abs);
      if (!(st.mode & 0o200)) fs.chmodSync(abs, st.mode | 0o200); // we hold it now, even if sync hasn't caught up
    } catch {}
    if (r.content != null && r.latest && r.latest.hash !== local) {
      if (local === null || r.latest.known) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, r.content);
        return deny(`${r.latest.byName} changed ${rel} ${ago(r.latest.at)} and your copy was out of date. ` +
          'It has been updated on disk to their version and you now hold the lock. Read the file again, then redo your edit.');
      }
      return { systemMessage: `huddle: local ${rel} differs from the last shared version (by ${r.latest.byName}); this edit will replace it.` };
    }
    if (r.elsewhere && r.elsewhere.length) {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext:
        `Heads up: ${r.elsewhere.map(e => `${e.holderName} is also editing ${rel} on branch ${e.branch || '(none)'}`).join('; ')}. ` +
        'You are not blocked because you are on a different branch, but this will conflict when the branches are merged. Consider telling them with huddle_send.' } };
    }
    return null;
  },

  async post(input, client, cfg) {
    const notes = [];
    const rel = EDIT_TOOLS.has(input.tool_name) ? relPath(cfg.root, targetOf(input)) : null;
    if (rel && !private_(cfg.root, rel)) {
      const abs = path.join(cfg.root, ...rel.split('/'));
      try {
        const content = fs.readFileSync(abs, 'utf8');
        await client.post('content', { path: rel, branch: client.agent.branch, content, tool: input.tool_name });
      } catch (e) {
        if (e.code !== 'ENOENT') notes.push(`huddle could not share ${rel}: ${e.message}`);
      }
    }
    await shareActivity(input, client, cfg).catch(() => {});
    const mail = await inbox(client, cfg, false);
    if (mail) notes.push(mail);
    return ctx('PostToolUse', notes.join('\n\n'));
  },

  async prompt(input, client, cfg) {
    const prompt = String(input.prompt || '').trim();
    const isPrivate = PRIVATE_PROMPT.test(prompt);
    // whatever is left from the previous turn goes out (or is dropped) under that turn's privacy
    await shareActivity(input, client, cfg).catch(() => {});
    const st = sessionState(cfg, client.agent);
    st.data.private = isPrivate;
    st.data.turnStart = st.data.turnStart || Date.now();
    if (input.transcript_path && st.data.usageFile !== input.transcript_path) newUsage(input, st); // start counting from here
    if (input.session_id && st.data.conversation !== input.session_id) {
      st.data.conversation = input.session_id;
      st.data.newConversation = true;
    }
    st.save();
    // the status line's "📬 new" count is what arrived since the person last prompted
    try {
      fs.writeFileSync(path.join(cfg.root, CONFIG_DIR, 'seen.json'), JSON.stringify({ at: Date.now() }));
      fs.rmSync(path.join(cfg.root, CONFIG_DIR, 'statusline.json'), { force: true });
    } catch {}
    if (!isPrivate && cfg.shareActivity === 'full' && prompt) await client.post('activity', { items: [{ kind: 'prompt', text: prompt }] }).catch(() => {});
    const mail = await inbox(client, cfg, true);
    const s = await client.get('state');
    const theirs = s.locks.filter(l => l.holder !== client.agent.id);
    const lockLine = theirs.length ? 'huddle: files currently locked by other agents: ' + theirs.map(l => `${l.path} (${l.holderName})`).join(', ') : '';
    const privateNote = isPrivate ? 'This turn is private: huddle is not sharing your user\'s prompt, your replies or your tool calls with the team. Do not put what is discussed here into huddle messages, team memory or PROJECT.md unless the user asks you to. File edits and commits in the project still sync as usual.' : '';
    const asks = await openRequests(client).catch(() => '');
    // whatever the prompt is about, the team's messages and requests come first
    const team = [mail, asks].filter(Boolean).join('\n\n');
    const first = team ? `huddle: read this first, before your user's prompt, and tell your user about anything that needs them.\n\n${team}` : '';
    return ctx('UserPromptSubmit', [first, privateNote, lockLine].filter(Boolean).join('\n\n'));
  },

  async stop(input, client, cfg) {
    await shareStop(input, client, cfg).catch(() => {});
    await shareStats(input, client, cfg, sessionState(cfg, client.agent)).catch(() => {});
    await autoPublish(client, cfg, sessionState(cfg, client.agent));
    if (cfg.releaseOnStop) await client.post('unlock', { all: true, keepHeld: true, reason: 'turn finished' });
    if (input.stop_hook_active) return null;
    const peek = await client.post('inbox', { peek: true });
    const me = client.agent;
    const direct = peek.messages.filter(m => m.to === me.id || m.to === me.name);
    if (!direct.length) return null;
    const r = await client.post('inbox', {});
    return { decision: 'block', reason: `Before stopping: other agents sent you messages.\n${formatMessages(r.messages, me)}\nReply with huddle_send (or act on them), then you may stop.` };
  },

  async 'session-end'(input, client, cfg) {
    await autoPublish(client, cfg, sessionState(cfg, client.agent));
    await client.post('unlock', { all: true, reason: 'session ended' });
    await client.post('bye', {});
    return null;
  },
};

async function runHook(event) {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch {}
  const cfg = loadConfig(input.cwd || process.cwd());
  if (!cfg) return;
  const h = handlers[event];
  if (!h) { process.stderr.write(`huddle: unknown hook ${event}\n`); return; }
  try {
    const client = new Client(cfg, { ...identity(cfg), branch: gitx.currentBranch(cfg.root) });
    out(await h(input, client, cfg));
  } catch (e) {
    if (event === 'pre' && cfg.failClosed) out(deny(`huddle server unavailable, so edits are blocked (failClosed is on): ${e.message}`));
    else out({ systemMessage: `huddle: ${e.message}` });
  }
}

module.exports = { runHook, handlers, sha };

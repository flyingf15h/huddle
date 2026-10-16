// Claude Code hook handlers. Each runs as `huddle hook <event>` with the hook
// payload on stdin and answers with hook JSON on stdout.
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig, identity, Client, relPath, hashFile, sha, formatMessages, ago, CONFIG_DIR } = require('./client');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const INBOX_EVERY_MS = 10 * 1000;

function out(obj) { if (obj) process.stdout.write(JSON.stringify(obj)); }
function ctx(event, text) { return text ? { hookSpecificOutput: { hookEventName: event, additionalContext: text } } : null; }
function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
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
  if (!r.messages.length) return '';
  return `New huddle messages from other agents (reply with the huddle_send tool if useful):\n${formatMessages(r.messages, client.agent)}`;
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
  async 'session-start'(input, client) {
    const s = await client.post('hello', {});
    return ctx('SessionStart',
      `You are "${client.agent.name}" in huddle project "${client.cfg.project}", shared with other Claude agents working in the same codebase from other machines.\n` +
      'Rules: before you edit a file it is locked for you automatically; files other agents are editing are read-only and edits to them will be refused. ' +
      'If that happens, work on something else, message the holder with huddle_send, look at their live copy with huddle_view, or block with huddle_wait. ' +
      'Set huddle_set_status to say what you are working on, and check huddle_status before starting larger changes so you do not overlap. ' +
      'Messages from other agents show up in your context automatically.\n' + teamSummary(s, client.agent));
  },

  async pre(input, client, cfg) {
    if (!EDIT_TOOLS.has(input.tool_name)) return null;
    const rel = relPath(cfg.root, targetOf(input));
    if (!rel) return null;
    const abs = path.join(cfg.root, ...rel.split('/'));
    const local = hashFile(abs);
    const r = await client.post('lock', { path: rel, baseHash: local, wantContent: true });
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
    return null;
  },

  async post(input, client, cfg) {
    const notes = [];
    const rel = EDIT_TOOLS.has(input.tool_name) ? relPath(cfg.root, targetOf(input)) : null;
    if (rel) {
      const abs = path.join(cfg.root, ...rel.split('/'));
      try {
        const content = fs.readFileSync(abs, 'utf8');
        await client.post('content', { path: rel, content, tool: input.tool_name });
      } catch (e) {
        if (e.code !== 'ENOENT') notes.push(`huddle could not share ${rel}: ${e.message}`);
      }
    }
    const mail = await inbox(client, cfg, false);
    if (mail) notes.push(mail);
    return ctx('PostToolUse', notes.join('\n\n'));
  },

  async prompt(input, client, cfg) {
    const mail = await inbox(client, cfg, true);
    const s = await client.get('state');
    const theirs = s.locks.filter(l => l.holder !== client.agent.id);
    const lockLine = theirs.length ? 'huddle: files currently locked by other agents: ' + theirs.map(l => `${l.path} (${l.holderName})`).join(', ') : '';
    return ctx('UserPromptSubmit', [mail, lockLine].filter(Boolean).join('\n\n'));
  },

  async stop(input, client, cfg) {
    if (cfg.releaseOnStop) await client.post('unlock', { all: true, keepHeld: true, reason: 'turn finished' });
    if (input.stop_hook_active) return null;
    const peek = await client.post('inbox', { peek: true });
    const me = client.agent;
    const direct = peek.messages.filter(m => m.to === me.id || m.to === me.name);
    if (!direct.length) return null;
    const r = await client.post('inbox', {});
    return { decision: 'block', reason: `Before stopping: other agents sent you messages.\n${formatMessages(r.messages, me)}\nReply with huddle_send (or act on them), then you may stop.` };
  },

  async 'session-end'(input, client) {
    await client.post('unlock', { all: true, reason: 'session ended' });
    await client.post('status', { status: '' });
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
    const client = new Client(cfg, identity(cfg));
    out(await h(input, client, cfg));
  } catch (e) {
    if (event === 'pre' && cfg.failClosed) out(deny(`huddle server unavailable, so edits are blocked (failClosed is on): ${e.message}`));
    else out({ systemMessage: `huddle: ${e.message}` });
  }
}

module.exports = { runHook, handlers, sha };

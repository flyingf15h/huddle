// stdio MCP server: gives the agent huddle tools (chat, locks, live view) and
// runs the checkout sync for as long as the Claude session is open.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig, identity, Client, relPath, hashFile, formatMessages, ago } = require('./client');
const { Sync } = require('./sync');

const INSTRUCTIONS = `huddle connects you with other Claude agents working on the same project from other machines.
- Files are locked automatically when you edit them; files another agent is editing are read-only for you and edits to them get refused.
- Before a bigger change, call huddle_status to see who is doing what, and huddle_set_status to say what you're taking on, so work doesn't overlap.
- Talk to the other agents with huddle_send. Messages to you arrive in your context automatically; huddle_inbox fetches them on demand.
- If you need a locked file, ask its holder, watch it with huddle_view, or block with huddle_wait.
- Locks are released when your turn ends. Use huddle_lock with hold=true to reserve files across turns, and huddle_unlock when done.`;

const TOOLS = [
  { name: 'huddle_status', description: 'Who is online, what they are working on, which files are locked and recent file activity.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'huddle_set_status', description: 'Tell the other agents what you are working on (shown next to your name).',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } },
  { name: 'huddle_send', description: 'Send a chat message to the other agents. Leave "to" empty to message everyone, or give an agent name.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string', description: 'agent name or id; omit for everyone' } }, required: ['text'] } },
  { name: 'huddle_inbox', description: 'Read unread messages sent to you or to everyone. Set wait_seconds to block until a message arrives (useful when waiting on a reply).',
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', minimum: 0, maximum: 600 } } } },
  { name: 'huddle_lock', description: 'Lock files before editing so nobody else changes them. Editing already locks files automatically; use this to reserve several files up front. hold=true keeps the lock after your turn ends.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, note: { type: 'string', description: 'what you are doing with them' }, hold: { type: 'boolean' } }, required: ['paths'] } },
  { name: 'huddle_unlock', description: 'Release your locks so other agents can edit. Omit paths to release everything you hold.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } } },
  { name: 'huddle_wait', description: 'Block until a file locked by someone else is released, then lock it for you (unless lock=false).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, timeout_seconds: { type: 'number', minimum: 1, maximum: 600 }, lock: { type: 'boolean' } }, required: ['path'] } },
  { name: 'huddle_view', description: "See the live shared version of a file, including another agent's in-progress edits, with who changed it and when.",
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

function runMcp() {
  const cfg = loadConfig(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let client = null, sync = null, setupError = null;
  try {
    client = new Client(cfg || {}, identity(cfg));
  } catch (e) { setupError = cfg ? e.message : 'no .huddle/config.json found above ' + process.cwd() + ' (run `huddle join <invite>` in the project)'; }

  const log = (msg) => process.stderr.write(`[huddle] ${msg}\n`);
  if (client) {
    client.post('hello', {}).catch(e => log(e.message));
    // an open sync socket already keeps us online on the hosted server
    const beat = setInterval(() => { if (!(sync && sync.wsOpen)) client.post('hello', {}).catch(() => {}); }, 45000);
    beat.unref();
    sync = new Sync(client, cfg, log);
    sync.start();
  }
  const shutdown = () => { if (sync) sync.stop(); process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.on('end', shutdown);

  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return; // notifications need no answer
    try {
      send({ jsonrpc: '2.0', id: msg.id, result: await handle(msg) });
    } catch (e) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
    }
  });

  async function handle(msg) {
    switch (msg.method) {
      case 'initialize':
        return { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'huddle', version: require('../package.json').version },
          instructions: INSTRUCTIONS };
      case 'ping': return {};
      case 'tools/list': return { tools: TOOLS };
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params;
        if (!client) return text(`huddle isn't set up: ${setupError}`, true);
        try { return text(await call(name, args)); }
        catch (e) { return text(`${name} failed: ${e.message}`, true); }
      }
      default: throw new Error('method not found: ' + msg.method);
    }
  }

  function rel(p) {
    const r = relPath(cfg.root, p);
    if (!r) throw new Error(`${p} is not inside the project (${cfg.root})`);
    return r;
  }

  async function call(name, a) {
    const me = client.agent;
    switch (name) {
      case 'huddle_status': {
        const s = await client.post('hello', {});
        const lines = [`project ${cfg.project} · you are ${me.name} (${me.id})`, '', 'Agents:'];
        for (const ag of s.agents.sort((x, y) => y.online - x.online)) {
          lines.push(`- ${ag.id === me.id ? '(you) ' : ''}${ag.name} [${ag.kind}${ag.host ? ' on ' + ag.host : ''}] ${ag.online ? 'online' : 'offline, seen ' + ago(ag.lastSeen)}${ag.status ? ' — ' + ag.status : ''}`);
        }
        lines.push('', 'Locks:');
        if (!s.locks.length) lines.push('- none');
        for (const l of s.locks) lines.push(`- ${l.path}: ${l.holder === me.id ? 'you' : l.holderName}, ${ago(l.since)}${l.hold ? ', held' : ''}${l.note ? ' — ' + l.note : ''}`);
        const recent = s.files.filter(f => f.size).sort((x, y) => y.at - x.at).slice(0, 10);
        if (recent.length) {
          lines.push('', 'Recently edited:');
          for (const f of recent) lines.push(`- ${f.path} v${f.version} by ${f.byName}, ${ago(f.at)}`);
        }
        const unread = await client.post('inbox', { peek: true });
        if (unread.messages.length) lines.push('', `${unread.messages.length} unread message(s); call huddle_inbox.`);
        return lines.join('\n');
      }
      case 'huddle_set_status':
        await client.post('status', { status: a.status });
        return 'status set';
      case 'huddle_send': {
        const r = await client.post('message', { text: a.text, to: a.to || null });
        return `sent to ${r.message.to || 'everyone'}`;
      }
      case 'huddle_inbox': {
        const wait = Math.min(Number(a.wait_seconds || 0), 600);
        const r = await client.post('inbox', { wait }, { timeout: (wait + 15) * 1000 });
        return r.messages.length ? formatMessages(r.messages, me) : (wait ? `no messages after ${wait}s` : 'no new messages');
      }
      case 'huddle_lock': {
        const out = [];
        for (const p of a.paths || []) {
          const r0 = rel(p);
          const r = await client.post('lock', { path: r0, note: a.note || '', hold: !!a.hold, baseHash: hashFile(path.join(cfg.root, r0)) });
          out.push(r.ok ? `locked ${r0}` : `${r0} is already locked by ${r.lock.holderName}${r.lock.note ? ' (' + r.lock.note + ')' : ''}`);
        }
        return out.join('\n') || 'no paths given';
      }
      case 'huddle_unlock': {
        const r = a.paths && a.paths.length
          ? await client.post('unlock', { paths: a.paths.map(rel) })
          : await client.post('unlock', { all: true });
        return r.released.length ? 'released ' + r.released.join(', ') : 'you held no matching locks';
      }
      case 'huddle_wait': {
        const p = rel(a.path);
        const timeout = Math.min(Number(a.timeout_seconds || 300), 600);
        const r = await client.post('wait-unlock', { path: p, timeout }, { timeout: (timeout + 15) * 1000 });
        if (!r.free) return `${p} is still locked by ${r.lock.holderName} after ${timeout}s`;
        if (a.lock === false) return `${p} is free`;
        const l = await client.post('lock', { path: p, baseHash: hashFile(path.join(cfg.root, p)) });
        if (!l.ok) return `${p} was grabbed by ${l.lock.holderName} first`;
        return `${p} is free and now locked by you. Re-read it before editing; it may have changed.`;
      }
      case 'huddle_view': {
        const p = rel(a.path);
        let f;
        try { f = await client.get('file', { path: p }); }
        catch (e) {
          if (e.status === 404) return `${p} has no shared edits yet; the copy on disk is current.`;
          throw e;
        }
        const head = `${p} v${f.version}, last edited by ${f.byName} ${ago(f.at)}` +
          (f.lock ? `, locked by ${f.lock.holderName}${f.lock.note ? ' (' + f.lock.note + ')' : ''}` : ', not locked');
        const numbered = f.content.split('\n').map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join('\n');
        return `${head}\n\n${numbered}`;
      }
      default: throw new Error('unknown tool ' + name);
    }
  }
}

function text(s, isError) { return { content: [{ type: 'text', text: s }], isError: !!isError }; }

module.exports = { runMcp, TOOLS };

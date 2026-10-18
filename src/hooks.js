// Claude Code hook handlers. Each runs as `huddle hook <event>` with the hook
// payload on stdin and answers with hook JSON on stdout.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig, identity, Client, relPath, hashFile, sha, formatMessages, ago, build, CONFIG_DIR } = require('./client');
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

// One request for everything a hook needs from the server: share activity and status, read mail,
// and get back only what changed (team, board, shared knowledge, hand-offs) since this session last looked.
async function turn(client, st, body) {
  const ask = { ...body, teamVersion: st.data.teamVersion, boardVersion: st.data.boardVersion === undefined ? -1 : st.data.boardVersion,
    sharedVersion: st.data.shared ? st.data.shared.version : undefined, handoffsSince: st.data.handoffAt || 0 };
  try { return await client.post('turn', ask); }
  catch (e) { if (e.status !== 404) throw e; }
  // an older server: the same, a request at a time
  if (body.items && body.items.length) await client.post('activity', { items: body.items }).catch(() => {});
  if (body.status) await client.post('status', { status: body.status, auto: body.auto }).catch(() => {});
  const r = await client.post('inbox', {});
  if (body.state || r.teamVersion !== ask.teamVersion) r.state = await client.get('state');
  if (r.boardVersion !== ask.boardVersion || body.state) r.board = await client.get('board');
  if (ask.sharedVersion !== undefined && r.sharedVersion !== ask.sharedVersion) r.shared = await client.get('shared');
  if (r.board && r.board.version === ask.boardVersion) { r.tasks = r.board.tasks.filter(t => t.owner === client.agent.name && t.status !== 'done'); delete r.board; }
  else if (r.board) r.tasks = r.board.tasks.filter(t => t.owner === client.agent.name && t.status !== 'done');
  return r;
}

// What changed for this Claude, from a turn() answer: mail, the other Claudes' work, team
// knowledge, the board and where finished sessions left off. Moves the session's baselines along.
function digest(client, cfg, st, r) {
  const me = client.agent;
  const d = { mail: '', team: '', news: [] };
  if (r.messages.length) d.mail = `New huddle messages from other agents (reply with the huddle_send tool if useful):\n${formatMessages(r.messages, me)}`;
  if (r.state && st.data.team) d.team = teamDelta(r.state, me, st);
  if (r.shared) {
    shared.writeShared(cfg.root, r.shared);
    const change = st.data.shared && shared.describeChanges(st.data.shared, r.shared);
    if (change) d.news.push(change);
    st.data.shared = shared.signature(r.shared);
  }
  if (r.board) {
    const note = st.data.boardVersion !== undefined && board.describe(st.data.boardSeen || {}, r.board, me.name);
    if (note) d.news.push(note);
    st.data.boardVersion = r.board.version;
    st.data.boardSeen = board.signature(r.board);
  }
  if (r.handoffs && r.handoffs.length) {
    d.news.push('huddle: a session finished and left a hand-off note:\n' + handoffLines(r.handoffs, me.name));
    st.data.handoffAt = Math.max(...r.handoffs.map(h => h.at));
  }
  st.save();
  return d;
}

// mid-turn check (PostToolUse), at most every INBOX_EVERY_MS
async function inbox(client, cfg, items) {
  const st = sessionState(cfg, client.agent);
  if (Date.now() - (st.data.inboxAt || 0) < INBOX_EVERY_MS) {
    if (items.length) await client.post('activity', { items }).catch(() => {});
    return '';
  }
  st.data.inboxAt = Date.now();
  st.save();
  const d = digest(client, cfg, st, await turn(client, st, { items }));
  return [d.mail, d.team, ...d.news].filter(Boolean).join('\n\n');
}

function handoffLines(list, me) {
  return list.map(h => `- ${h.name === me ? 'you (an earlier session)' : h.name}, ${ago(h.at)}${h.branch ? ` on ${h.branch}` : ''}: ${h.text}` +
    (h.commits.length ? `\n  commits: ${h.commits.slice(0, 5).join('; ')}` : '') +
    (h.files.length ? `\n  files: ${h.files.slice(0, 8).join(', ')}${h.files.length > 8 ? ` +${h.files.length - 8}` : ''}` : '')).join('\n');
}
// the newest note per person from the last few days, for a session that's just starting
function recentHandoffs(list, me) {
  const per = new Map();
  for (const h of list) if (Date.now() - h.at < 3 * 86400000) per.set(h.name, h);
  const keep = [...per.values()].sort((x, y) => y.at - x.at).slice(0, 5);
  return keep.length ? 'Where people left off (hand-off notes, newest first):\n' + handoffLines(keep, me) : '';
}

// Requests other people sent to this person's Claude that aren't finished. When the request runner
// is on, each runs as its own background Claude and stays out of this conversation (the person just
// sees a line in their terminal); when it's off, this Claude is told so it can bring them up.
function openRequests(s, tasks, me) {
  const open = tasks.filter(t => t.direct && t.owner === me && t.status !== 'done');
  if (!open.length) return { context: '', notice: '' };
  const mode = ((s.settings || {})[me] || {}).autopilot || 'full';
  if (mode !== 'off') {
    return { context: '', notice: `huddle: ${open.length} request${open.length > 1 ? 's' : ''} running in the background, each as its own Claude: ` +
      open.slice(0, 3).map(t => `"${t.title.slice(0, 50)}" from ${t.by} (${t.status})`).join(', ') + (open.length > 3 ? ', …' : '') };
  }
  return { notice: '', context: `Requests sent to you (${aiNameOf(s, me) ? aiNameOf(s, me) + ', ' : ''}${me}'s Claude):\n` +
    open.map(t => `- [${t.id}] from ${t.by}, ${t.status}: ${t.title}${t.status === 'blocked' && t.notes && t.notes.length ? ` (${t.notes[t.notes.length - 1].text})` : ''}`).join('\n') +
    '\nYour requests runner is off, so these wait for you: do them now if your user agrees, or tell your user they are waiting.' };
}

// Board tasks this person's Claude has had in progress, brought up when it starts on something new
// so finished ones get closed instead of going stale.
function staleTasks(tasks, me) {
  const doing = tasks.filter(t => !t.direct && t.owner === me && t.status === 'doing');
  if (!doing.length) return '';
  return 'Board tasks you still have in progress: ' + doing.slice(0, 5).map(t => `[${t.id}] ${t.title}`).join('; ') +
    '. If one is finished, mark it done with huddle_update_task, or put "closes <id>" in the commit that finishes it.';
}

// commits this session made since it last looked: their messages can close board tasks
async function closeFromCommits(client, cfg, st) {
  if (!gitx.isRepo(cfg.root)) return;
  const h = gitx.head(cfg.root);
  if (!h || h === st.data.commitsSeen) return;
  const range = st.data.commitsSeen && gitx.hasCommit(cfg.root, st.data.commitsSeen) ? [`${st.data.commitsSeen}..${h}`] : ['-1', h];
  const log = gitx.git(cfg.root, ['log', '--no-merges', '--max-count=50', '--format=%H%x00%B%x1e', ...range]);
  st.data.commitsSeen = h;
  st.save();
  const commits = log.out.split('\x1e').map(x => x.trim()).filter(Boolean).map(x => { const [sha, message] = x.split('\0'); return { sha, message }; });
  if (!commits.some(c => /\b[0-9a-f]{8}\b/i.test(c.message))) return;
  const r = await client.post('commits', { commits });
  return r.closed && r.closed.length ? r.closed : null;
}

// where this session left off, written by huddle itself when Claude didn't write one (huddle_handoff)
async function autoHandoff(client, cfg, st, s) {
  const me = s && s.agents.find(a => a.id === client.agent.id);
  const status = me && me.status;
  const files = st.data.edited || [];
  const commits = st.data.sessionHead && gitx.isRepo(cfg.root) && gitx.hasCommit(cfg.root, st.data.sessionHead)
    ? gitx.git(cfg.root, ['log', '--max-count=10', '--format=%h %s', `${st.data.sessionHead}..HEAD`]).out.split('\n').filter(Boolean) : [];
  if (!status && !files.length && !commits.length) return;
  const said = cfg.shareActivity === 'full' && !st.data.private && st.data.lastReply ? st.data.lastReply : '';
  const text = `${status ? `Was on: ${status}.` : 'Worked on the files below.'}${said ? ` Last said: ${said}` : ''}`;
  await client.post('handoff', { text, files, commits, auto: true });
}

// After a turn, share the branch if it has new commits so others can merge it.
async function autoPublish(client, cfg, st) {
  if (cfg.shareGit === false || cfg.clone || !gitx.isRepo(cfg.root)) return;
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

// what the transcript gained since we last looked, ready to share (nothing for a private turn)
function pendingActivity(input, cfg, st) {
  if (cfg.shareActivity === 'off') return [];
  const items = newActivity(input, st, cfg.shareActivity);
  st.save();
  return st.data.private ? [] : items; // a private turn: read past it, share nothing
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

// what the person named their Claude, if anything; it's in the state snapshot's settings
function aiNameOf(s, person) { return ((s.settings || {})[person] || {}).aiName || null; }
function nameLine(s, me) {
  const n = aiNameOf(s, me);
  return n ? `${me} named you "${n}". Use that as your name: introduce yourself as ${n} and sign your huddle messages as ${n} (${me}'s Claude). Others can send you work with to="${n}".` : '';
}

// One line per other Claude: what it's on and the files it holds. Claudes are only told the lines
// that changed since they last heard (teamDelta), so everyone stays current for a few tokens.
function teamNow(s, me) {
  const now = {};
  for (const a of s.agents) {
    if (a.id === me.id || !a.online || !['agent', 'autopilot'].includes(a.kind)) continue;
    const ai = aiNameOf(s, a.name);
    const who = `${a.name === me.name ? 'your other session' : ai ? `${ai} (${a.name}'s Claude)` : `${a.name}'s Claude`}${a.kind === 'autopilot' ? ' [autopilot]' : ''}${a.branch ? ` on ${a.branch}` : ''}`;
    const files = s.locks.filter(l => l.holder === a.id).map(l => l.path);
    now[a.id] = { who, line: `${a.status || 'no status yet'}${files.length ? ' · editing ' + files.slice(0, 6).join(', ') + (files.length > 6 ? ` +${files.length - 6}` : '') : ''}` };
  }
  // locks left behind by someone who went away still make files read-only
  const away = s.locks.filter(l => l.holder !== me.id && !now[l.holder] && !s.agents.some(a => a.id === l.holder && a.online));
  for (const l of away) {
    const k = 'away:' + l.holder;
    now[k] = now[k] || { who: `${l.holderName} (away)`, line: 'still holds' };
    now[k].line += ' ' + l.path;
  }
  return now;
}
function teamDelta(s, me, st) {
  const now = teamNow(s, me), before = st.data.team;
  st.data.team = now;
  st.data.teamVersion = s.teamVersion;
  st.save();
  if (!before) {
    const all = Object.values(now).map(x => `- ${x.who}: ${x.line}`);
    return all.length ? 'huddle: what the other Claudes are doing:\n' + all.join('\n') : '';
  }
  const out = [];
  for (const [id, x] of Object.entries(now)) if (!before[id] || before[id].line !== x.line || before[id].who !== x.who) out.push(`- ${x.who}: ${x.line}`);
  for (const [id, x] of Object.entries(before)) if (!now[id]) out.push(`- ${x.who}: ${id.startsWith('away:') ? 'released its files' : 'stopped (went offline)'}`);
  return out.length ? 'huddle: what the other Claudes are doing changed:\n' + out.join('\n') : '';
}

// The prompt as a status is long and raw, so a quick Haiku run (in the background, never holding the
// prompt up) turns it into a short phrase like "Fixing the login redirect" and swaps it in, unless
// Claude has set a status of its own by then. "summarize": false in .huddle/config.json turns it off.
function summarizeLater(cfg, agent, prompt, seen) {
  try {
    spawn(process.execPath, [path.join(__dirname, 'cli.js'), '_summarize'], {
      detached: true, stdio: 'ignore',
      env: { ...process.env, HUDDLE_SUM_ROOT: cfg.root, HUDDLE_SUM_AGENT: JSON.stringify(agent), HUDDLE_SUM_PROMPT: prompt.slice(0, 3000), HUDDLE_SUM_SEEN: seen },
    }).unref();
  } catch {}
}

// A status straight from the person's prompt, so the team sees new work the moment it starts.
// Short follow-ups ("yes", "go ahead", "now push it") keep the current status.
function statusFromPrompt(prompt) {
  const line = prompt.split('\n').map(l => l.trim()).find(Boolean) || '';
  if (line.length < 25 || line.startsWith('/')) return null;
  const cut = line.length > 120 ? line.slice(0, 120).replace(/\s+\S*$/, '') + '…' : line;
  return `asked: “${cut}”`;
}

// One line for someone coming back: what happened since their last session here ended.
function catchUp(cfg, s, b, me) {
  let since = 0;
  try { since = JSON.parse(fs.readFileSync(path.join(cfg.root, CONFIG_DIR, 'last-seen.json'), 'utf8')).at; } catch {}
  const waiting = (s.approvals || []).filter(x => x.owner === me).length;
  if (!since || Date.now() - since < 30 * 60 * 1000) return waiting ? `huddle: ${waiting} command${waiting > 1 ? 's' : ''} waiting for your OK (huddle approve)` : '';
  const done = b.tasks.filter(t => t.status === 'done' && t.updated > since).length;
  const mine = b.tasks.filter(t => t.owner === me && t.status !== 'done' && t.updated > since).length;
  const asks = b.goals.filter(g => g.at > since && g.byName !== me).length;
  const bits = [done && `${done} task${done > 1 ? 's' : ''} done`, mine && `${mine} of yours changed`, asks && `${asks} new request${asks > 1 ? 's' : ''}`,
    waiting && `${waiting} command${waiting > 1 ? 's' : ''} waiting for your OK (huddle approve)`].filter(Boolean);
  return bits.length ? `huddle: since you were last here, ${bits.join(', ')}.` : '';
}

// Whether this person's session is mid-turn, for the request runner: it answers messages for an
// idle session only, because a busy one reads them before it stops.
function markTurn(cfg, agent, busy) {
  if (process.env.HUDDLE_AUTOPILOT) return;
  const file = path.join(cfg.root, CONFIG_DIR, 'turns.json');
  let t = {};
  try { t = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  t[agent.id] = { busy, at: Date.now() };
  for (const [k, v] of Object.entries(t)) if (Date.now() - v.at > 86400000) delete t[k];
  try { fs.writeFileSync(file, JSON.stringify(t)); } catch {}
}

// A prompt that's probably several jobs at once: long, or a list of asks. Claude makes the real call.
function looksBig(prompt) {
  if (process.env.HUDDLE_AUTOPILOT || prompt.length < 200) return false;
  const items = prompt.split('\n').filter(l => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;
  const asks = (prompt.match(/\b(also|and then|plus|as well as|additionally)\b|[.?!]\s+(?=[a-z]*\s*(add|make|fix|change|switch|have|set|allow|get rid|remove|build|update|create|move|let)\b)/gi) || []).length;
  return prompt.length > 700 || items >= 3 || asks >= 2;
}
function distributeNote(s, me) {
  const others = [...new Set(s.agents.filter(a => a.online && !a.clone && a.name !== me.name && ['agent', 'autopilot'].includes(a.kind)).map(a => a.name))];
  const u = (n) => { const x = (s.usage || {})[n]; return x && typeof x.five === 'number' ? ` (${x.five}% of 5-hour window used)` : ''; };
  return `huddle: this prompt looks like several pieces of work. ${others.length ? `Other Claudes online: ${others.map(n => n + u(n)).join(', ')}; you${u(me.name)}.` : 'Nobody else is online, but your own background Claudes can take parts in parallel.'} ` +
    'If it splits into parts that can be done independently (different files or areas), call huddle_distribute first: give each part a title, a detail with what "done" means, and an effort (light, medium or heavy). ' +
    'huddle hands the heavier parts to whoever has the most usage left, and their Claudes start right away. Keep the parts you\'re best placed to do with keep_for_me, then do those here. ' +
    'Skip this for one tightly connected change, or when your user wants to do it themselves.';
}

function teamSummary(s, me) {
  const others = s.agents.filter(a => a.online && a.id !== me.id && a.kind !== 'watcher');
  const lines = [];
  lines.push(others.length
    ? 'Other agents online: ' + others.map(a => `${a.name}${a.kind === 'agent' && aiNameOf(s, a.name) ? ` (their Claude is called ${aiNameOf(s, a.name)})` : ''}${a.host ? ' on ' + a.host : ''}${a.status ? ` ("${a.status}")` : ''}`).join('; ')
    : 'No other agents are online right now.');
  const theirs = s.locks.filter(l => l.holder !== me.id);
  if (theirs.length) lines.push('Files locked by others (read-only for you): ' + theirs.map(l => `${l.path} (${l.holderName}${l.note ? ': ' + l.note : ''})`).join(', '));
  return lines.join('\n');
}

const handlers = {
  async 'session-start'(input, client, cfg) {
    const s = await client.post('hello', { build: build(), handoffs: true });
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
    st.data.aiName = aiNameOf(s, client.agent.name);
    st.data.team = teamNow(s, client.agent);
    st.data.teamVersion = s.teamVersion;
    const handoffs = s.handoffs || [];
    st.data.handoffAt = Math.max(0, ...handoffs.map(h => h.at));
    st.data.sessionHead = st.data.commitsSeen = gitx.isRepo(cfg.root) ? gitx.head(cfg.root) : null;
    st.data.edited = [];
    st.save();
    if (gitx.isRepo(cfg.root)) gitx.fetchAll(client, cfg.root).catch(() => {});
    // shown to the person in their terminal, so they can see this session is in the huddle
    const others = [...new Set(s.agents.filter(a => a.online && a.name !== client.agent.name && a.kind !== 'human').map(a => a.name))];
    const mode = ((s.settings || {})[client.agent.name] || {}).autopilot || 'full';
    const mine = build();
    const newer = mine && s.agents.filter(a => a.online && a.build && a.build.at > mine.at).sort((x, y) => y.build.at - x.build.at)[0];
    const back = catchUp(cfg, s, b, client.agent.name);
    const notice = `huddle: this session is in "${cfg.project.replace(/-[0-9a-f]{6,8}$/, '')}" as ${client.agent.name}` +
      ` · ${others.length ? others.join(', ') + ' online' : 'nobody else online'}` +
      ` · your Claude ${mode === 'full' ? 'is active for the team (answers the other Claudes, takes its tasks)' : mode === 'off' ? 'does not take requests (/autopilot to change)' : 'takes requests only (/autopilot to change)'}` +
      (newer ? ` · ${newer.name} runs a newer huddle; run \`huddle update\` and restart Claude` : '') +
      (back ? `\n${back}` : '');
    return withNotice(notice, ctx('SessionStart',
      `You are "${client.agent.name}" in huddle project "${client.cfg.project}", shared with other Claude agents working in the same codebase from other machines.\n` +
      (nameLine(s, client.agent.name) ? nameLine(s, client.agent.name) + '\n' : '') +
      (linked ? `The huddle project is the folder ./${path.relative(here, cfg.root)} (work and run git there). Only files inside it are shared with the team; other folders here are yours alone.\n` : '') +
      'Rules: before you edit a file it is locked for you automatically; files other agents are editing are read-only and edits to them will be refused. ' +
      'For work that spans a whole folder, lock the folder with huddle_lock (e.g. "viewer/src/pages/"): nobody else can edit inside it until you release it, and nobody can lock a folder that overlaps one someone else holds. ' +
      'If an edit is refused, work on something else, message the holder with huddle_send, look at their live copy with huddle_view, or block with huddle_wait. ' +
      'When you start a new piece of work, call huddle_set_status once with a short summary of it (under 12 words, e.g. "adding search to the parts library"); huddle pre-fills it from your user\'s prompt, and other Claudes are told whenever it changes. Skip it for follow-ups on the same work. ' +
      'You are told when another Claude\'s work changes; check huddle_status before larger changes so you do not overlap. ' +
      'When you finish a board task, mark it done with huddle_update_task, or write "closes <task id>" in the commit that finishes it. ' +
      'When your user wraps up or you hand work over, leave a two-line note with huddle_handoff: where you left off and what comes next (huddle writes one from your status and commits if you don\'t). ' +
      'Messages from other agents show up in your context automatically.\n' +
      'The team shares knowledge through huddle instead of git: the PROJECT.md brief (huddle_project), memory notes (huddle_remember / huddle_recall) and skills (huddle_save_skill). ' +
      'When you learn something another agent would otherwise have to rediscover (a gotcha, a decision, how to run or test something), save it.\n\n' +
      teamSummary(s, client.agent) + '\n' + branchSummary(s, client, cfg) + '\n\n' +
      (recentHandoffs(handoffs, client.agent.name) ? recentHandoffs(handoffs, client.agent.name) + '\n\n' : '') +
      board.briefing(b, client.agent.name) + '\n\n' + shared.briefing(sh)));
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
      return deny(`${l.dir ? `${rel} is inside ${l.path}, a folder` : rel} locked by ${l.holderName} (since ${ago(l.since)}${l.note ? ', "' + l.note + '"' : ''}). ` +
        `It is read-only for you until they release it. Options: work on ${l.dir ? 'something outside that folder' : 'a different file'}, ask them via huddle_send, ` +
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
    // (a request clone's work reaches the team as a commit when it's done, not as live edits)
    if (rel && !private_(cfg.root, rel) && !cfg.clone) {
      const abs = path.join(cfg.root, ...rel.split('/'));
      try {
        const content = fs.readFileSync(abs, 'utf8');
        await client.post('content', { path: rel, branch: client.agent.branch, content, tool: input.tool_name });
        const st = sessionState(cfg, client.agent);
        st.data.edited = [...new Set([...(st.data.edited || []), rel])].slice(-50);
        st.save();
      } catch (e) {
        if (e.code !== 'ENOENT') notes.push(`huddle could not share ${rel}: ${e.message}`);
      }
    }
    const mail = await inbox(client, cfg, pendingActivity(input, cfg, sessionState(cfg, client.agent)));
    if (mail) notes.push(mail);
    return ctx('PostToolUse', notes.join('\n\n'));
  },

  async prompt(input, client, cfg) {
    const prompt = String(input.prompt || '').trim();
    const isPrivate = PRIVATE_PROMPT.test(prompt);
    const st = sessionState(cfg, client.agent);
    // whatever is left from the previous turn goes out (or is dropped) under that turn's privacy
    const items = pendingActivity(input, cfg, st);
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
    const full = (cfg.shareActivity || 'full') === 'full';
    if (!isPrivate && full && prompt) items.push({ kind: 'prompt', text: prompt });
    // a background request Claude gets its status from the runner, not from its long task prompt
    const auto = !isPrivate && full && !process.env.HUDDLE_AUTOPILOT ? statusFromPrompt(prompt) : null;
    const r = await turn(client, st, { items, status: auto, auto: true, state: true });
    if (auto && cfg.summarize !== false) summarizeLater(cfg, client.agent, prompt, auto);
    const d = digest(client, cfg, st, r);
    const s = r.state;
    const me = client.agent.name;
    const ai = aiNameOf(s, me);
    let renamed = '';
    if (ai !== (st.data.aiName || null)) {
      renamed = ai ? `huddle: ${nameLine(s, me)}` : `huddle: ${me} took your name away; you are ${me}'s Claude again.`;
      st.data.aiName = ai;
      st.save();
    }
    if (!st.data.team) d.team = teamDelta(s, client.agent, st);
    const privateNote = isPrivate ? 'This turn is private: huddle is not sharing your user\'s prompt, your replies or your tool calls with the team. Do not put what is discussed here into huddle messages, team memory or PROJECT.md unless the user asks you to. File edits and commits in the project still sync as usual.' : '';
    const asks = process.env.HUDDLE_AUTOPILOT ? { context: '', notice: '' } : openRequests(s, r.tasks || [], me);
    const stale = auto && auto !== st.data.lastAuto ? staleTasks(r.tasks || [], me) : '';
    const big = !isPrivate && looksBig(prompt) ? distributeNote(s, client.agent) : '';
    markTurn(cfg, client.agent, true);
    if (auto) { st.data.lastAuto = auto; st.save(); }
    // whatever the prompt is about, the team's messages and requests come first
    const team = [d.mail, asks.context].filter(Boolean).join('\n\n');
    const first = team ? `huddle: read this first, before your user's prompt, and tell your user about anything that needs them.\n\n${team}` : '';
    const out = ctx('UserPromptSubmit', [first, renamed, privateNote, ...d.news, stale, d.team, big].filter(Boolean).join('\n\n'));
    return asks.notice ? withNotice(asks.notice, out) : out;
  },

  async stop(input, client, cfg) {
    await shareStop(input, client, cfg).catch(() => {});
    const st = sessionState(cfg, client.agent);
    const reply = String(input.last_assistant_message || '').trim().replace(/\s+/g, ' ');
    if (reply && !st.data.private) { st.data.lastReply = reply.length > 300 ? reply.slice(0, 300) + '…' : reply; st.save(); }
    await shareStats(input, client, cfg, st).catch(() => {});
    await autoPublish(client, cfg, sessionState(cfg, client.agent));
    const closed = await closeFromCommits(client, cfg, sessionState(cfg, client.agent)).catch(() => null);
    if (cfg.releaseOnStop) await client.post('unlock', { all: true, keepHeld: true, reason: 'turn finished' });
    const note = closed ? { systemMessage: `huddle: your commit closed ${closed.map(t => `"${t.title}"`).join(', ')} on the board` } : null;
    const done = () => { markTurn(cfg, client.agent, false); return note; };
    // a background Claude's answer goes back by itself (the runner sends its final message)
    if (input.stop_hook_active || process.env.HUDDLE_AUTOPILOT) return done();
    const peek = await client.post('inbox', { peek: true });
    const me = client.agent;
    const direct = peek.messages.filter(m => m.to === me.id || m.to === me.name);
    if (!direct.length) return done();
    const r = await client.post('inbox', {});
    return { decision: 'block', reason: `Before stopping: other agents sent you messages.\n${formatMessages(r.messages, me)}\nReply with huddle_send (or act on them), then you may stop.` };
  },

  async 'session-end'(input, client, cfg) {
    const st = sessionState(cfg, client.agent);
    await autoPublish(client, cfg, st);
    await closeFromCommits(client, cfg, sessionState(cfg, client.agent)).catch(() => {});
    await autoHandoff(client, cfg, sessionState(cfg, client.agent), await client.get('state').catch(() => null)).catch(() => {});
    markTurn(cfg, client.agent, false);
    try { fs.writeFileSync(path.join(cfg.root, CONFIG_DIR, 'last-seen.json'), JSON.stringify({ at: Date.now() })); } catch {}
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
    // a request clone takes its locks on its person's branch, so it and everyone there stay out of each other's files
    const client = new Client(cfg, { ...identity(cfg), branch: cfg.clone ? cfg.clone.branch : gitx.currentBranch(cfg.root) });
    out(await h(input, client, cfg));
  } catch (e) {
    if (event === 'pre' && cfg.failClosed) out(deny(`huddle server unavailable, so edits are blocked (failClosed is on): ${e.message}`));
    else out({ systemMessage: `huddle: ${e.message}` });
  }
}

module.exports = { runHook, handlers, sha };

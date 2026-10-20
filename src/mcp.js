// stdio MCP server: gives the agent huddle tools (chat, locks, live view) and
// runs the checkout sync for as long as the Claude session is open.
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { loadConfig, identity, Client, relPath, hashFile, formatMessages, ago, build, ownerKey, sha } = require('./client');
const { Sync } = require('./sync');
const gitx = require('./git');
const board = require('./board');
const autopilot = require('./autopilot');
const { notify, noteFor } = require('./notify');

const INSTRUCTIONS = `huddle connects you with other Claude agents working on the same project from other machines.
- Files are locked automatically when you edit them; files another agent is editing are read-only for you and edits to them get refused.
- Before a bigger change, call huddle_status to see who is doing what, and huddle_set_status to say what you're taking on, so work doesn't overlap.
- Talk to the other agents with huddle_send. Messages to you arrive in your context automatically; huddle_inbox fetches them on demand.
- If you need a locked file, ask its holder, watch it with huddle_view, or block with huddle_wait.
- Locks are released when your turn ends. Use huddle_lock with hold=true to reserve files across turns, and huddle_unlock when done.
- Folder locks: huddle_lock on a folder ("src/pages/") gives you everything inside it until you release it; nobody else can edit there, and nobody can lock a folder or file that overlaps it.
- Hand-off: when your user wraps up or you pass work on, call huddle_handoff with where you left off and what comes next. The team and the next session see it.
- Autopilot: your person chooses whether other people can start you on things (huddle_autopilot): "full" (default, "active") means messages other Claudes send you are answered in the background while your person is away, requests and tasks assigned to you run as background Claudes, and team goals get planned; "requests" only runs what is sent to this person's Claude directly; "off" means everything waits. If your user asks to turn autopilot on/off, use huddle_autopilot.
- Big prompts: when your user asks for several independent pieces of work at once, split it with huddle_distribute. huddle gives heavier parts to the Claudes with the most usage left in their 5-hour window, and their Claudes start right away; you keep and do your own share.
- Your name: your person can name you (e.g. "Pip") so the team can tell the Claudes apart. If your user asks you to take a name, or what you are called, use huddle_name.
- Branches: people on the same git branch share a live working copy and locks; people on different branches work independently and merge later (huddle_branches, huddle_merge). Your commits are shared automatically at the end of each turn.
- Team board: people give the whole team goals (huddle_ask_team). The first free agent claims a goal (huddle_claim_goal), splits it into tasks for the online agents and records them with huddle_plan; each agent then works its own tasks and marks them with huddle_update_task. Prefer splitting so different people touch different files.
- Team knowledge lives in huddle, not git: PROJECT.md (goals, conventions, architecture, who owns what; huddle_project), memory notes (huddle_remember / huddle_recall / huddle_forget) and skills (huddle_save_skill). Save anything another agent would otherwise rediscover the hard way: gotchas, decisions and their reasons, how to build/run/test. Keep memories short and specific; put repeatable multi-step procedures in a skill.`;

const TOOLS = [
  { name: 'huddle_status', description: 'Who is online, what they are working on, which files are locked and recent file activity.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'huddle_set_status', description: 'Tell the other agents what you are working on (shown next to your name; every other Claude is told when it changes). Call it once when you start a new piece of work, with a summary under 12 words.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } },
  { name: 'huddle_send', description: 'Send a chat message to the other agents. Leave "to" empty to message everyone, or give an agent name.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, to: { type: 'string', description: 'agent name or id; omit for everyone' } }, required: ['text'] } },
  { name: 'huddle_inbox', description: 'Read unread messages sent to you or to everyone. Set wait_seconds to block until a message arrives (useful when waiting on a reply).',
    inputSchema: { type: 'object', properties: { wait_seconds: { type: 'number', minimum: 0, maximum: 600 } } } },
  { name: 'huddle_lock', description: 'Lock files or folders before editing so nobody else changes them. Editing already locks files automatically; use this to reserve several files up front, or a whole folder (end the path with "/", e.g. "src/pages/"): only you can edit inside it until you release it, and locks can never overlap. hold=true keeps a file lock after your turn ends (folder locks always stay until released or your session ends).',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, note: { type: 'string', description: 'what you are doing with them' }, hold: { type: 'boolean' } }, required: ['paths'] } },
  { name: 'huddle_handoff', description: 'Leave a short hand-off note for the team and your next session: where you left off and what comes next (two or three lines). Call it when your user wraps up or you hand work over. Your latest note replaces earlier ones from this session.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'huddle_unlock', description: 'Release your locks so other agents can edit. Omit paths to release everything you hold (folders too).',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } } },
  { name: 'huddle_wait', description: 'Block until a file locked by someone else is released, then lock it for you (unless lock=false).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, timeout_seconds: { type: 'number', minimum: 1, maximum: 600 }, lock: { type: 'boolean' } }, required: ['path'] } },
  { name: 'huddle_project', description: "Read the team's shared PROJECT.md (the project brief every agent starts with), or replace it by passing new_text. Pass the base_version you read to avoid overwriting someone else's edit.",
    inputSchema: { type: 'object', properties: { new_text: { type: 'string', description: 'full new contents; omit to just read' }, base_version: { type: 'number' } } } },
  { name: 'huddle_remember', description: 'Save a short note to the shared team memory so every agent (now and in future sessions) knows it. Same title updates the existing note.',
    inputSchema: { type: 'object', properties: { title: { type: 'string', description: 'short, specific, e.g. "tests need DATABASE_URL set"' }, text: { type: 'string', description: 'the fact, plus why it matters' } }, required: ['title', 'text'] } },
  { name: 'huddle_recall', description: 'Search the shared team memory. Omit query to list everything.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'huddle_search', description: "Search the team's history: requests and tasks, messages, what other agents were asked and replied, memory, hand-off notes and teammates' shared code. Use it to find past decisions (\"what did we decide about refunds\") or who worked on something.",
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, kinds: { type: 'string', description: 'optional, comma-separated: tasks, messages, activity, knowledge, code' } }, required: ['query'] } },
  { name: 'huddle_forget', description: 'Delete a shared memory that turned out wrong or outdated (by id or exact title).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'huddle_save_skill', description: "Share a skill with every agent: a reusable procedure installed into everyone's .claude/skills/. Same name updates it.",
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'kebab-case' }, description: { type: 'string', description: 'when an agent should use it' }, instructions: { type: 'string', description: 'the SKILL.md body (markdown)' } }, required: ['name', 'description', 'instructions'] } },
  { name: 'huddle_delete_skill', description: 'Remove a shared skill from every agent.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'huddle_activity', description: "See what the other agents' Claude sessions are doing: their prompts, replies and tool calls, newest last. Useful before starting work that might overlap, or to follow up on someone's progress.",
    inputSchema: { type: 'object', properties: { agent: { type: 'string', description: 'agent name; omit for everyone' }, limit: { type: 'number', minimum: 1, maximum: 200 } } } },
  { name: 'huddle_branches', description: "Everyone's published git branches, how each compares with yours (ahead/behind/diverged), and who is on which branch. Fetches the latest first.",
    inputSchema: { type: 'object', properties: {} } },
  { name: 'huddle_publish', description: 'Share your current branch (its commits) with the team right now, instead of waiting for the end of your turn.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'huddle_merge', description: "Merge someone's branch into your current branch, e.g. ref='alex/main' or 'alex' (their branch with the same name as yours, else their newest). On conflicts it lists the files; resolve them, then commit.",
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'person/branch or person' } }, required: ['ref'] } },
  { name: 'huddle_board', description: 'The team board: goals people gave the team and the tasks they were split into, with owners and status.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'huddle_ask_team', description: "Give the whole team (every agent) a goal, or one person's Claude a task with to=name. Use when your user wants to hand work to the team. title: 2 to 6 plain words naming the outcome, as the team will see it (no \"From …\" preamble, names, ids or parentheses). For a quick question to someone's Claude, use huddle_send instead.",
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, to: { type: 'string' } }, required: ['title', 'text'] } },
  { name: 'huddle_claim_goal', description: 'Claim the planning of a team goal. Only one agent wins; if you do, split the goal into tasks and call huddle_plan.',
    inputSchema: { type: 'object', properties: { goal_id: { type: 'string' } }, required: ['goal_id'] } },
  { name: 'huddle_plan', description: "Record the plan for a goal you claimed: tasks with owners (agent names; balance the work, include yourself, avoid two people editing the same files) and optional dependencies (after = indexes of earlier tasks in this list).",
    inputSchema: { type: 'object', properties: {
      goal_id: { type: 'string' }, title: { type: 'string', description: '2 to 5 plain words naming the whole request' }, summary: { type: 'string' },
      tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' }, owner: { type: 'string', description: 'leave empty (with an effort) to let huddle assign by remaining usage; empty without an effort leaves it for anyone' }, paths: { type: 'array', items: { type: 'string' }, description: 'files or folders ("src/ui/") it works in; locked for whoever does it from the start' }, effort: { type: 'string', enum: ['light', 'medium', 'heavy'] }, after: { type: 'array', items: { type: 'number' } } }, required: ['title'] } },
    }, required: ['goal_id', 'tasks'] } },
  { name: 'huddle_distribute', description: "Split your user's request into parts and hand them out across the team's Claudes in one step. Each part needs a title (under 7 plain words saying the outcome, like \"Fix login redirect\"; no names, ids or parentheses), a detail saying what to change and what done looks like, and an effort (light, medium, heavy). Parts without an owner are assigned by huddle: heavier ones go to whoever has the most of their 5-hour Claude window left. Set keep_for_me on the parts you will do yourself in this session. The others start on their own right away.",
    inputSchema: { type: 'object', properties: {
      title: { type: 'string', description: '2 to 5 plain words naming the whole request, like "Dashboard cleanup"' },
      summary: { type: 'string', description: 'one or two lines: what the whole request is' },
      tasks: { type: 'array', items: { type: 'object', properties: {
        title: { type: 'string' }, detail: { type: 'string' }, effort: { type: 'string', enum: ['light', 'medium', 'heavy'] },
        owner: { type: 'string', description: 'only when it has to be one person' }, keep_for_me: { type: 'boolean' }, paths: { type: 'array', items: { type: 'string' }, description: 'files or folders ("src/ui/") it works in; locked for whoever does it from the start' }, 
        after: { type: 'array', items: { type: 'number' }, description: 'indexes of earlier parts this one needs first' } }, required: ['title', 'effort'] } },
    }, required: ['summary', 'tasks'] } },
  { name: 'huddle_approve', description: "Commands your person's background Claudes needed but weren't allowed to run. Omit id to list the waiting ones. Approve one (by id) only when your user says so; the task then runs again with that exact command allowed. deny=true says no.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, deny: { type: 'boolean' } } } },
  { name: 'huddle_checks', description: "How finished background work is checked before it merges: the project's test command (run in the work's own worktree; Sonnet gets one try to fix failures, and failing work stays on its branch) and whether a Sonnet Claude reviews each change first. Omit both to see the current settings.",
    inputSchema: { type: 'object', properties: { test_command: { type: 'string', description: 'e.g. "npm test"; empty string to go back to guessing' }, review: { type: 'boolean' } } } },
  { name: 'huddle_claim_task', description: 'Take an unassigned task from the board (only one agent can win it).',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] } },
  { name: 'huddle_update_task', description: 'Update a task: status todo|doing|done|blocked, an optional note (what you did, or why blocked), reassign with owner, or rename it with title (2 to 6 plain words).',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] }, note: { type: 'string' }, owner: { type: 'string' }, title: { type: 'string' } }, required: ['task_id'] } },
  { name: 'huddle_autopilot', description: "See or change this person's autopilot setting: 'full' (default, active: answers messages from the other Claudes while the person is away, runs requests and assigned tasks as background Claudes, plans team goals), 'requests' (only what is sent to this person's Claude directly), or 'off' (everything waits for the person). Omit mode to see the current setting.",
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['off', 'requests', 'full', 'on'] } } } },
  { name: 'huddle_name', description: "See or change the name your person gave you (their Claude), e.g. \"Pip\". The team sees it on the dashboard and can send you work with to=<name>. Only change it when your user asks; an empty name removes it.",
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
  { name: 'huddle_view', description: "See the live shared version of a file, including another agent's in-progress edits, with who changed it and when.",
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

function runMcp() {
  const cfg = loadConfig(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let client = null, sync = null, setupError = null;
  try {
    client = new Client(cfg || {}, identity(cfg));
    // always report the branch we're on right now (people switch branches mid-session)
    Object.defineProperty(client.agent, 'branch', { get: () => cfg.clone ? cfg.clone.branch : gitx.currentBranch(cfg.root), enumerable: true });
  } catch (e) { setupError = cfg ? e.message : 'no .huddle/config.json found above ' + process.cwd() + ' (run `huddle join <invite>` in the project)'; }

  const log = (msg) => process.stderr.write(`[huddle] ${msg}\n`);
  if (client) {
    const key = cfg.clone ? null : ownerKey(cfg);
    client.post('hello', { build: build(), tool: ['codex', 'cursor'].includes(process.env.HUDDLE_AGENT) ? process.env.HUDDLE_AGENT : ['codex', 'cursor'].includes(cfg.agent) ? cfg.agent : 'claude', ...(key ? { keyHash: sha(key) } : {}) }).catch(e => log(e.message));
    // an open sync socket already keeps us online on the hosted server
    const beat = setInterval(() => { if (!(sync && sync.wsOpen)) client.post('hello', {}).catch(() => {}); }, 45000);
    beat.unref();
    sync = new Sync(client, cfg, log);
    // the session that syncs this folder also takes requests sent to this person's Claude
    // (never inside a Claude that autopilot itself started)
    let runner = null;
    sync.onActive = () => {
      if (runner || process.env.HUDDLE_AUTOPILOT || !autopilot.claimRunner(cfg.root)) return;
      runner = autopilot.createRunner({ cfg, client, log: (m) => log('autopilot: ' + m) });
      runner.refreshMode().then(() => runner.work()).catch(e => log('autopilot: ' + e.message));
    };
    sync.onEvent = (ev) => {
      if (!runner) return; // only the session that owns this folder's runner speaks up
      runner.onEvent(ev).catch(() => {});
      // tell the person now, not when they next type a prompt ("notify": false turns it off)
      const note = cfg.notify !== false && noteFor(ev, client.agent);
      if (note) notify(note.title, note.body);
    };
    process.on('exit', () => { if (runner) autopilot.releaseRunner(cfg.root); });
    if (!cfg.clone) sync.start(); // a request clone works alone in its worktree
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

  // "src/pages/" or an existing folder on disk
  function isDir(p, r0) {
    if (/[\\/]$/.test(p)) return true;
    try { return fs.statSync(path.join(cfg.root, r0)).isDirectory(); } catch { return false; }
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
          lines.push(`- ${ag.id === me.id ? '(you) ' : ''}${ag.name} [${ag.kind}${ag.host ? ' on ' + ag.host : ''}] ${ag.online ? 'online' : 'offline, seen ' + ago(ag.lastSeen)}${ag.status ? ' — ' + ag.status + (ag.statusAt ? ` (${ago(ag.statusAt)})` : '') : ''}`);
        }
        const hand = (await client.get('handoffs', { limit: 8 }).catch(() => ({ handoffs: [] }))).handoffs;
        if (hand.length) {
          lines.push('', 'Hand-off notes (where sessions left off, newest last):');
          for (const h of hand) lines.push(`- ${h.name}, ${ago(h.at)}${h.auto ? ' (auto)' : ''}: ${h.text}${h.commits.length ? ` [commits: ${h.commits.slice(0, 3).join('; ')}]` : ''}`);
        }
        const log = (await client.get('worklog', { limit: 12 }).catch(() => ({ worklog: [] }))).worklog;
        if (log.length) {
          lines.push('', 'Recently started work (newest last):');
          for (const w of log) lines.push(`- ${w.name}, ${ago(w.at)}: ${w.status}`);
        }
        lines.push('', 'Locks:');
        if (!s.locks.length) lines.push('- none');
        for (const l of s.locks) lines.push(`- ${l.path}${l.dir ? ' (whole folder)' : ''}: ${l.holder === me.id ? 'you' : l.holderName}, ${ago(l.since)}${l.hold ? ', held' : ''}${l.note ? ' — ' + l.note : ''}`);
        const recent = s.files.filter(f => f.size).sort((x, y) => y.at - x.at).slice(0, 10);
        if (recent.length) {
          lines.push('', 'Recently edited:');
          for (const f of recent) lines.push(`- ${f.path} v${f.version} by ${f.byName}, ${ago(f.at)}`);
        }
        const sh = await client.get('shared');
        lines.push('', `Team knowledge: PROJECT.md ${sh.doc ? 'v' + sh.doc.version : 'empty'}, ${sh.memories.length} memories, ${sh.skills.length} skills${sh.skills.length ? ' (' + sh.skills.map(x => x.name).join(', ') + ')' : ''}`);
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
          const dir = isDir(p, r0);
          const r = await client.post('lock', dir ? { path: r0 + '/', dir: true, branch: me.branch, note: a.note || '' }
            : { path: r0, branch: me.branch, note: a.note || '', hold: !!a.hold, baseHash: hashFile(path.join(cfg.root, r0)) });
          out.push(r.ok ? `locked ${r0}${dir ? '/ (the whole folder; huddle_unlock releases it)' : ''}`
            : `${r0}${dir ? '/' : ''} overlaps ${r.lock.path}${r.lock.dir ? ' (a folder)' : ''}, locked by ${r.lock.holderName}${r.lock.note ? ' (' + r.lock.note + ')' : ''}`);
        }
        return out.join('\n') || 'no paths given';
      }
      case 'huddle_handoff': {
        const files = gitx.isRepo(cfg.root) ? gitx.dirty(cfg.root).map(l => l.slice(3)).slice(0, 20) : [];
        await client.post('handoff', { text: a.text, files });
        return 'hand-off saved; the team sees it, and so does your next session here';
      }
      case 'huddle_unlock': {
        const r = a.paths && a.paths.length
          ? await client.post('unlock', { paths: a.paths.map(x => rel(x) + (isDir(x, rel(x)) ? '/' : '')), branch: me.branch })
          : await client.post('unlock', { all: true });
        return r.released.length ? 'released ' + r.released.join(', ') : 'you held no matching locks';
      }
      case 'huddle_wait': {
        const p = rel(a.path);
        const timeout = Math.min(Number(a.timeout_seconds || 300), 600);
        const r = await client.post('wait-unlock', { path: p, branch: me.branch, timeout }, { timeout: (timeout + 15) * 1000 });
        if (!r.free) return `${p} is still locked by ${r.lock.holderName}${r.lock.dir ? ` (the ${r.lock.path} folder)` : ''} after ${timeout}s`;
        if (a.lock === false) return `${p} is free`;
        const l = await client.post('lock', { path: p, branch: me.branch, baseHash: hashFile(path.join(cfg.root, p)) });
        if (!l.ok) return `${p} was grabbed by ${l.lock.holderName} first`;
        return `${p} is free and now locked by you. Re-read it before editing; it may have changed.`;
      }
      case 'huddle_project': {
        if (a.new_text === undefined) {
          const sh = await client.get('shared');
          if (!sh.doc || !sh.doc.text.trim()) return 'PROJECT.md is empty. Write one with new_text: goals, conventions, architecture, how to run/test, who is working on what.';
          return `PROJECT.md v${sh.doc.version}, last edited by ${sh.doc.byName} ${ago(sh.doc.at)} (pass base_version=${sh.doc.version} when you update it)\n\n${sh.doc.text}`;
        }
        const r = await client.post('doc', { text: a.new_text, baseVersion: a.base_version });
        return `PROJECT.md saved as v${r.version}; every agent sees the change.`;
      }
      case 'huddle_remember': {
        const r = await client.post('memory', { title: a.title, text: a.text });
        return `${r.action === 'add' ? 'saved' : 'updated'} shared memory ${r.id}`;
      }
      case 'huddle_recall': {
        const sh = await client.get('shared');
        const words = String(a.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = sh.memories.filter(m => words.every(w => (m.title + ' ' + m.text).toLowerCase().includes(w)));
        if (!hits.length) return words.length ? 'no matching memories' : 'shared memory is empty';
        return hits.map(m => `[${m.id}] ${m.title} (${m.byName}, ${ago(m.at)})\n${m.text}`).join('\n\n');
      }
      case 'huddle_search': {
        const r = await client.get('search', { q: String(a.query || ''), limit: 25, ...(a.kinds ? { kinds: a.kinds } : {}) });
        if (!r.results.length) return `nothing in the project mentions "${a.query}"`;
        return r.results.map(x => `${x.kind}: ${x.title}${x.who ? ` (${x.who}, ${ago(x.at)})` : ''}\n  ${x.snippet}`).join('\n') + (r.total > r.results.length ? `\n… ${r.total - r.results.length} more; narrow the query` : '');
      }
      case 'huddle_forget':
        await client.post('forget', { id: a.id });
        return 'forgotten';
      case 'huddle_save_skill': {
        const r = await client.post('skill', { name: a.name, description: a.description, body: a.instructions });
        return `skill "${r.name}" v${r.version} shared; it installs into everyone's .claude/skills/${r.name}/`;
      }
      case 'huddle_delete_skill':
        await client.post('skill-delete', { name: a.name });
        return `skill "${a.name}" removed for everyone`;
      case 'huddle_activity': {
        const q = { limit: String(a.limit || 40) };
        if (a.agent) q.agent = a.agent;
        const r = await client.get('activity', q);
        const items = r.activity.filter(it => it.agent !== me.id);
        if (!items.length) return a.agent ? `no recent activity from ${a.agent}` : 'no recent activity from other agents';
        return items.map(it => `[${it.name}, ${ago(it.at)}] ${formatItem(it)}`).join('\n');
      }
      case 'huddle_branches': {
        if (!gitx.isRepo(cfg.root)) return 'This folder is not a git repository. Run `git init`, commit, then `huddle publish` (or ask your user) to use branches and merging.';
        await gitx.fetchAll(client, cfg.root, () => {});
        const s = await client.get('state');
        const st = await client.get('git');
        const mine = gitx.currentBranch(cfg.root, 0);
        const lines = [`You are on ${mine || '(detached HEAD)'} at ${(gitx.head(cfg.root) || 'no commits').slice(0, 8)}${gitx.dirty(cfg.root).length ? ' with uncommitted changes' : ''}.`, '', 'Published branches:'];
        for (const r of Object.values(st.refs)) {
          const own = r.owner === me.name && r.checkout === me.checkout;
          let rel = '';
          if (!own && gitx.hasCommit(cfg.root, r.sha)) {
            const c = gitx.counts(cfg.root, r.sha);
            rel = gitx.relation(cfg.root, r.sha);
            rel = rel === 'same' ? 'same as yours' : `${rel}: you are ${c.ahead} ahead, ${c.behind} behind`;
          }
          lines.push(`- ${r.owner}/${r.branch}${own ? ' (yours)' : ''} at ${r.sha.slice(0, 8)} "${r.subject || ''}" ${ago(r.at)}${rel ? ' — ' + rel : ''}${own ? '' : `  [merge: huddle_merge ref=${r.owner}/${r.branch}]`}`);
        }
        if (!Object.keys(st.refs).length) lines.push('- none yet (huddle_publish shares yours)');
        const where = s.agents.filter(x => x.online && x.kind === 'agent' && x.id !== me.id);
        if (where.length) lines.push('', 'Online now: ' + [...new Set(where.map(x => `${x.name} on ${x.branch || '?'}`))].join(', '));
        return lines.join('\n');
      }
      case 'huddle_publish': {
        const r = await gitx.publish(client, cfg.root);
        if (r.skipped) return `nothing published: ${r.skipped}`;
        return r.unchanged ? `${r.branch} is already shared at ${r.tip.slice(0, 8)}` : `shared ${r.branch} at ${r.tip.slice(0, 8)}${r.bytes ? ` (${Math.ceil(r.bytes / 1024)} KB)` : ''}`;
      }
      case 'huddle_merge': {
        if (!gitx.isRepo(cfg.root)) return 'not a git repository';
        const f = await gitx.fetchAll(client, cfg.root, () => {});
        const refs = Object.values(f.refs || {}).filter(r => !(r.owner === me.name && r.checkout === me.checkout));
        const mine = gitx.currentBranch(cfg.root, 0);
        const r = gitx.resolveRef(f.refs, a.ref, { name: me.name, checkout: me.checkout, branch: mine });
        if (!r) return `no published branch matches "${a.ref}". Available: ${refs.map(x => x.owner + '/' + x.branch).join(', ') || 'none'}`;
        if (gitx.dirty(cfg.root).length) return 'You have uncommitted changes. Commit them first, then merge.';
        const m = gitx.merge(cfg.root, gitx.shortRef(r.owner, r.branch));
        if (m.ok) return `merged ${r.owner}/${r.branch} into ${mine}.\n${m.output}`;
        if (m.conflicts.length) return `merge of ${r.owner}/${r.branch} has conflicts in:\n${m.conflicts.map(c => '- ' + c).join('\n')}\nResolve the conflict markers in those files (keep both sides' intent), \`git add\` them and \`git commit --no-edit\`. Tell ${r.owner} with huddle_send if a choice affects their work.`;
        return `merge failed:\n${m.output}`;
      }
      case 'huddle_board': return board.format(await client.get('board'));
      case 'huddle_ask_team': {
        const r = await client.post('goal', { text: a.text, title: a.title, to: a.to || null });
        return a.to ? `sent to ${a.to}'s Claude as a task` : `posted team goal ${r.goal.id}; a free agent will claim and plan it`;
      }
      case 'huddle_claim_goal': {
        const r = await client.post('claim-goal', { id: a.goal_id });
        if (!r.ok) return `${r.planner} is already planning this goal; wait for their plan (it will show up in your context).`;
        const s = await client.get('state');
        const team = [...new Map(s.agents.filter(x => x.online && x.kind === 'agent').map(x => [x.name, x])).values()];
        return `You are planning goal ${r.goal.id}: ${r.goal.text}\n\nOnline agents you can assign to: ${team.map(x => `${x.name}${x.name === me.name ? ' (you)' : ''}${x.status ? ' — ' + x.status : ''}${x.branch ? ' [branch ' + x.branch + ']' : ''}`).join('; ')}\n` +
          'Look at the code first if you need to, then call huddle_plan with a 2 to 5 word title for the request and concrete tasks (titles under 7 plain words; details in detail) (what to change and where, done-criteria), each owned by one agent. Split by files/modules so people do not edit the same files. Then tell the team with huddle_send.';
      }
      case 'huddle_plan': {
        const r = await client.post('plan', { goalId: a.goal_id, title: a.title, summary: a.summary || '', tasks: a.tasks || [] });
        return `plan saved:\n${r.tasks.map(board.taskLine).join('\n')}\nEach owner sees their tasks automatically.`;
      }
      case 'huddle_distribute': {
        const parts = (a.tasks || []).filter(t => t && t.title);
        if (!parts.length) throw new Error('give at least one part');
        const g = await client.post('goal', { text: a.summary || parts.map(t => t.title).join('; '), claim: true });
        const r = await client.post('plan', { goalId: g.goal.id, title: a.title, summary: a.summary || '', tasks: parts.map(t => ({
          title: t.title, detail: t.detail, effort: t.effort, paths: t.paths, owner: t.keep_for_me ? me.name : (t.owner || null), keep: !!t.keep_for_me, after: t.after })) });
        // this session's own parts: their area is locked for it now, before anyone else starts there
        const taken = [];
        for (const t of r.tasks.filter(x => x.held)) for (const p of t.paths || []) {
          const l = await client.post('lock', { path: p, branch: me.branch, hold: true, note: t.title.slice(0, 80) }).catch(() => ({ ok: false }));
          if (l.ok) taken.push(p);
        }
        const mine = r.tasks.filter(t => t.owner === me.name);
        const others = r.tasks.filter(t => t.owner !== me.name);
        return `Handed out as goal ${g.goal.id}:\n${r.tasks.map(t => `- [${t.id}] ${t.title} (${t.effort || 'medium'}) → ${t.owner === me.name ? (t.held ? 'you, here' : 'you, as a background Claude') : t.owner}`).join('\n')}\n` +
          (others.length ? 'The other Claudes start on theirs right away and mark them done on the board; you are told when they finish. ' : '') +
          (taken.length ? `Locked for you: ${taken.join(', ')} (release with huddle_unlock when done). ` : '') +
          (mine.some(t => t.held) ? `Now do yours here (${mine.filter(t => t.held).map(t => t.id).join(', ')}) and mark each done with huddle_update_task.` : '');
      }
      case 'huddle_approve': {
        if (!a.id) {
          const w = (await client.get('approvals')).approvals.filter(x => x.status === 'waiting' && x.owner === me.name);
          return w.length ? w.map(x => `[${x.id}] ${x.command}${x.why ? ` (${x.why})` : ''} for "${x.title}"`).join('\n') : 'Nothing is waiting for your OK.';
        }
        const r = await client.post('approve', { id: a.id, allow: !a.deny });
        return r.approval.status === 'approved' ? `Approved: ${r.approval.command}. The task runs again with it allowed.` : `Said no to: ${r.approval.command}.`;
      }
      case 'huddle_checks': {
        const body = {};
        if (a.test_command !== undefined) body.testCommand = a.test_command;
        if (a.review !== undefined) body.review = a.review;
        const ps = Object.keys(body).length ? (await client.post('project-setting', body)).settings : ((await client.get('state')).projectSettings || {});
        return `Tests before merging: ${ps.testCommand || `guessed from the project (${autopilot.detectTests(cfg.root) || 'none found'})`}. Sonnet review: ${ps.review === false ? 'off' : 'on'}.`;
      }
      case 'huddle_claim_task': {
        const r = await client.post('claim-task', { id: a.task_id });
        return r.ok ? `task ${a.task_id} is yours: ${r.task.title}` : `${r.owner} already has that task`;
      }
      case 'huddle_update_task': {
        const r = await client.post('task-update', { id: a.task_id, status: a.status, note: a.note, owner: a.owner, title: a.title });
        return `task ${r.task.id} "${r.task.title}" is now ${r.task.status}${r.task.owner ? ' (' + r.task.owner + ')' : ''}`;
      }
      case 'huddle_autopilot': {
        if (a.mode) {
          const mode = autopilot.normMode(a.mode);
          if (!mode) throw new Error('mode must be off, requests or full');
          await client.post('setting', { autopilot: mode });
          return `autopilot is now ${autopilot.MODE_WORDS[mode]}. The team sees this on the dashboard.`;
        }
        const mode = await autopilot.getMode(client);
        return `autopilot is ${autopilot.MODE_WORDS[mode]}. Change it with mode=off|requests|full.`;
      }
      case 'huddle_name': {
        if (a.name !== undefined) {
          const r = await client.post('setting', { aiName: a.name });
          return r.settings.aiName
            ? `You are now "${r.settings.aiName}" (${me.name}'s Claude). Use that name for yourself and sign your huddle messages with it. The team sees it and can send you work with to="${r.settings.aiName}".`
            : `Your name is cleared; you are ${me.name}'s Claude again.`;
        }
        const st = await client.get('settings');
        const n = (st.settings[me.name] || {}).aiName;
        const others = Object.entries(st.settings).filter(([who, x]) => who !== me.name && x && x.aiName).map(([who, x]) => `${x.aiName} is ${who}'s Claude`);
        return (n ? `${me.name} named you "${n}".` : `${me.name} hasn't named you yet.`) + (others.length ? ' ' + others.join('; ') + '.' : '');
      }
      case 'huddle_view': {
        const p = rel(a.path);
        let f;
        try { f = await client.get('file', me.branch ? { path: p, branch: me.branch } : { path: p }); }
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

function formatItem(it) {
  if (it.kind === 'prompt') return `user asked: ${it.text}`;
  if (it.kind === 'tool') return `→ ${it.text}`;
  if (it.kind === 'end') return '(finished its turn)';
  return `said: ${it.text}`;
}

function text(s, isError) { return { content: [{ type: 'text', text: s }], isError: !!isError }; }

module.exports = { runMcp, TOOLS };

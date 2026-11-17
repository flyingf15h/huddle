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
const { RULES } = require('./rules');

const INSTRUCTIONS = RULES;

// Every description here is sent to the model in every session of every person on the
// team, so each one says what the tool is for and nothing the rules above already say.
const str = { type: 'string' }, bool = { type: 'boolean' };
const strs = { type: 'array', items: str };
const obj = (properties = {}, required) => ({ type: 'object', properties, ...(required ? { required } : {}) });
const EFFORT = { type: 'string', enum: ['light', 'medium', 'heavy'] };
const PATHS = { ...strs, description: 'files or folders ("src/ui/") it works in; locked for whoever does it' };

const TOOLS = [
  { name: 'huddle_status', description: 'Who is online, what they are working on, which files are locked and recent file activity.',
    inputSchema: obj() },
  { name: 'huddle_set_status', description: 'Tell the team what you are working on, in under 12 words. Call once per new piece of work.',
    inputSchema: obj({ status: str }, ['status']) },
  { name: 'huddle_send', description: 'Message the other agents: everyone, or one agent with "to".',
    inputSchema: obj({ text: str, to: { ...str, description: 'agent name; omit for everyone' } }, ['text']) },
  { name: 'huddle_inbox', description: 'Read unread messages. wait_seconds blocks until one arrives (for waiting on a reply).',
    inputSchema: obj({ wait_seconds: { type: 'number', minimum: 0, maximum: 600 } }) },
  { name: 'huddle_lock', description: 'Reserve files, or a whole folder (path ending in "/"), so only you can edit them. Editing already locks single files; locks cannot overlap. hold=true keeps file locks after your turn ends; folder locks stay until released.',
    inputSchema: obj({ paths: strs, note: { ...str, description: 'what you are doing with them' }, hold: bool }, ['paths']) },
  { name: 'huddle_handoff', description: 'Leave a two or three line note for the team and your next session: where you left off and what comes next. Replaces your earlier note from this session.',
    inputSchema: obj({ text: str }, ['text']) },
  { name: 'huddle_unlock', description: 'Release your locks. Omit paths to release everything you hold.',
    inputSchema: obj({ paths: strs }) },
  { name: 'huddle_wait', description: 'Block until a file someone else locked is released, then lock it for you (unless lock=false).',
    inputSchema: obj({ path: str, timeout_seconds: { type: 'number', minimum: 1, maximum: 600 }, lock: bool }, ['path']) },
  { name: 'huddle_project', description: "Read the team's shared PROJECT.md, or replace it with new_text. Pass the base_version you read so you don't overwrite someone else's edit.",
    inputSchema: obj({ new_text: { ...str, description: 'full new contents; omit to read' }, base_version: { type: 'number' } }) },
  { name: 'huddle_remember', description: 'Save a short note to the shared team memory. The same title updates the note.',
    inputSchema: obj({ title: { ...str, description: 'short and specific, e.g. "tests need DATABASE_URL set"' }, text: { ...str, description: 'the fact, and why it matters' } }, ['title', 'text']) },
  { name: 'huddle_recall', description: 'Search the shared team memory. Omit query to list everything.',
    inputSchema: obj({ query: str }) },
  { name: 'huddle_search', description: "Search the team's history: tasks, messages, what other agents were asked and replied, memory, hand-offs and teammates' shared code. For past decisions, or who worked on something.",
    inputSchema: obj({ query: str, kinds: { ...str, description: 'optional, comma-separated: tasks, messages, activity, knowledge, code' } }, ['query']) },
  { name: 'huddle_forget', description: 'Delete a shared memory that is wrong or outdated, by id or exact title.',
    inputSchema: obj({ id: str }, ['id']) },
  { name: 'huddle_save_skill', description: "Share a reusable procedure as a skill, installed into every agent's skills folder. The same name updates it.",
    inputSchema: obj({ name: { ...str, description: 'kebab-case' }, description: { ...str, description: 'when to use it' }, instructions: { ...str, description: 'the SKILL.md body' } }, ['name', 'description', 'instructions']) },
  { name: 'huddle_delete_skill', description: 'Remove a shared skill from every agent.',
    inputSchema: obj({ name: str }, ['name']) },
  { name: 'huddle_activity', description: "What the other agents' sessions are doing: prompts, replies and tool calls, newest last.",
    inputSchema: obj({ agent: { ...str, description: 'agent name; omit for everyone' }, limit: { type: 'number', minimum: 1, maximum: 200 } }) },
  { name: 'huddle_branches', description: "Everyone's published git branches, how each compares with yours, and who is on which. Fetches first.",
    inputSchema: obj() },
  { name: 'huddle_publish', description: 'Share your current branch with the team now instead of at the end of your turn.',
    inputSchema: obj() },
  { name: 'huddle_merge', description: "Merge someone's branch into yours. On conflicts it lists the files; resolve them, then commit.",
    inputSchema: obj({ ref: { ...str, description: '"alex/main", or "alex" for their branch named like yours' } }, ['ref']) },
  { name: 'huddle_board', description: 'The team board: goals and the tasks they were split into, with owners and status.',
    inputSchema: obj() },
  { name: 'huddle_ask_team', description: "Give the team a goal, or one person's Claude a task with to=name, when your user wants to hand work over. For a quick question use huddle_send.",
    inputSchema: obj({ title: { ...str, description: '2 to 6 plain words naming the outcome; no names or ids' }, text: str, to: str, start: { ...bool, description: 'true only if your user wants it built now; otherwise the plan waits for a go' } }, ['title', 'text']) },
  { name: 'huddle_claim_goal', description: 'Claim the planning of a team goal. Only one agent wins; if you do, split it into tasks with huddle_plan.',
    inputSchema: obj({ goal_id: str }, ['goal_id']) },
  { name: 'huddle_plan', description: 'Record the plan for a goal you claimed. Nothing runs until someone starts it; goal_id with start=true alone starts a saved plan. Give different people different files.',
    inputSchema: obj({
      goal_id: str, title: { ...str, description: '2 to 5 plain words naming the whole request' }, summary: str,
      start: { ...bool, description: 'true only if your user explicitly asked for the work to start now' },
      tasks: { type: 'array', items: obj({ title: str, detail: str, owner: { ...str, description: 'agent name; empty with an effort lets huddle assign by remaining usage' }, paths: PATHS, effort: EFFORT, after: { type: 'array', items: { type: 'number' }, description: 'indexes of earlier tasks it needs first' } }, ['title']) },
    }, ['goal_id']) },
  { name: 'huddle_distribute', description: "Only when your user asked for work to be done now. Split their request into parts and hand them to the team's Claudes in one step; the parts start right away. Parts without an owner go to whoever has the most Claude usage left.",
    inputSchema: obj({
      title: { ...str, description: '2 to 5 plain words naming the whole request' },
      summary: { ...str, description: 'one or two lines' },
      tasks: { type: 'array', items: obj({
        title: { ...str, description: 'under 7 plain words saying the outcome, e.g. "Fix login redirect"' },
        detail: { ...str, description: 'what to change and what done looks like' }, effort: EFFORT,
        owner: { ...str, description: 'only when it has to be one person' }, keep_for_me: { ...bool, description: 'you do this part yourself in this session' }, paths: PATHS,
        after: { type: 'array', items: { type: 'number' }, description: 'indexes of earlier parts it needs first' } }, ['title', 'effort']) },
    }, ['summary', 'tasks']) },
  { name: 'huddle_approve', description: "Commands your person's background Claudes were not allowed to run. Omit id to list them. Approve one only when your user says so; deny=true says no.",
    inputSchema: obj({ id: str, deny: bool }) },
  { name: 'huddle_checks', description: 'How background work is checked before it merges: the test command, and whether a Claude reviews each change. Omit both to see the settings.',
    inputSchema: obj({ test_command: { ...str, description: 'e.g. "npm test"; empty string to go back to guessing' }, review: bool }) },
  { name: 'huddle_claim_task', description: 'Take an unassigned task from the board (only one agent can win it).',
    inputSchema: obj({ task_id: str }, ['task_id']) },
  { name: 'huddle_update_task', description: 'Update a task: its status, a note (what you did, or why it is blocked), a new owner, or a new title (2 to 6 plain words).',
    inputSchema: obj({ task_id: str, status: { type: 'string', enum: ['todo', 'doing', 'done', 'blocked'] }, note: str, owner: str, title: str }, ['task_id']) },
  { name: 'huddle_autopilot', description: "See or change what this person's Claude does on its own: 'full' (default) answers other Claudes and runs requests and assigned tasks in the background, 'requests' runs only what is sent to this person directly, 'off' runs nothing.",
    inputSchema: obj({ mode: { type: 'string', enum: ['off', 'requests', 'full', 'on'] } }) },
  { name: 'huddle_name', description: 'See or change the name your person gave you, e.g. "Pip". Change it only when your user asks; an empty name removes it.',
    inputSchema: obj({ name: str }) },
  { name: 'huddle_view', description: "The live shared version of a file, including another agent's in-progress edits, with who changed it and when.",
    inputSchema: obj({ path: str }, ['path']) },
  { name: 'huddle_claim_feature', description: 'Claim the feature you are working on, e.g. "inventory: drag and drop", with the few files it touches; they stay locked for you until you release it. Keep it narrow: never a whole level, system or shared folder.',
    inputSchema: obj({ feature: str, paths: { ...strs, description: 'up to 12 files, or a small folder only this feature uses' } }, ['feature', 'paths']) },
  { name: 'huddle_release_feature', description: 'Release a feature you claimed. Omit feature to release all of them.',
    inputSchema: obj({ feature: str }) },
  { name: 'huddle_share_image', description: "Put an image in the team's gallery: a screenshot, render or concept art. Editor screenshots go there on their own.",
    inputSchema: obj({ path: { ...str, description: 'png, jpg, webp or gif, under 900 KB' }, caption: str }, ['path']) },
  { name: 'huddle_share_build', description: "Add a build people can try to the team's Builds page: a web build, an itch.io page, a download link.",
    inputSchema: obj({ url: str, title: { ...str, description: 'e.g. "Prototype 3, boss fight playable"' }, platform: str, notes: { ...str, description: 'what changed, what to try' } }, ['url', 'title']) },
  { name: 'huddle_timeline', description: "Read the team's timeline: goals with deadlines and the plan to reach them. plan replaces the plan; done marks a goal done.",
    inputSchema: obj({ plan: { ...str, description: 'the full new plan, plain lines under each goal' }, done: { ...str, description: "a goal's name" } }) },
];

// Tools only a studio project needs (game and art teams). Left out of the list for everyone
// else; they still work if called.
const STUDIO_TOOLS = new Set(['huddle_claim_feature', 'huddle_release_feature', 'huddle_share_image', 'huddle_share_build', 'huddle_timeline']);

function runMcp() {
  const cfg = loadConfig(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let client = null, sync = null, setupError = null, hello = null;
  try {
    client = new Client(cfg || {}, identity(cfg));
    // always report the branch we're on right now (people switch branches mid-session)
    Object.defineProperty(client.agent, 'branch', { get: () => cfg.clone ? cfg.clone.branch : gitx.currentBranch(cfg.root), enumerable: true });
  } catch (e) { setupError = cfg ? e.message : 'no .huddle/config.json found above ' + process.cwd() + ' (run `huddle join <invite>` in the project)'; }

  const log = (msg) => process.stderr.write(`[huddle] ${msg}\n`);
  if (client) {
    const key = cfg.clone ? null : ownerKey(cfg);
    hello = client.post('hello', { build: build(), tool: ['codex', 'cursor', 'pi'].includes(process.env.HUDDLE_AGENT) ? process.env.HUDDLE_AGENT : ['codex', 'cursor', 'pi'].includes(cfg.agent) ? cfg.agent : 'claude', ...(key ? { keyHash: sha(key) } : {}) }).catch(e => { log(e.message); return null; });
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

  // a project is a studio once it uses an editor (Unity, Blender…) or has a timeline; when we
  // can't tell (server unreachable, nothing cached), every tool is listed
  async function isStudio() {
    const s = hello && await Promise.race([hello, new Promise(r => setTimeout(r, 1500, null))]);
    const uses = (ps, tl) => !!((ps && ps.apps && ps.apps.length) || (tl && ((tl.milestones || []).length || tl.plan)));
    if (s) return uses(s.projectSettings, s.timeline);
    try { return uses(JSON.parse(fs.readFileSync(path.join(cfg.root, '.huddle', 'project-settings.json'), 'utf8'))); } catch { return true; }
  }

  async function handle(msg) {
    switch (msg.method) {
      case 'initialize':
        return { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'huddle', version: require('../package.json').version },
          instructions: INSTRUCTIONS };
      case 'ping': return {};
      case 'tools/list': return { tools: await isStudio() ? TOOLS : TOOLS.filter(t => !STUDIO_TOOLS.has(t.name)) };
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
      case 'huddle_claim_feature': {
        const feature = String(a.feature || '').trim().slice(0, 80);
        const paths = (a.paths || []).map(String).filter(Boolean);
        if (!feature || !paths.length) return 'name the feature and the files it touches';
        if (paths.length > 12) return 'that is more than a feature; claim at most 12 files, the ones you are changing now';
        const out = [];
        for (const x of paths) {
          const r0 = rel(x), dir = isDir(x, r0);
          if (dir) {
            let n = 0;
            const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (n > 25) return; if (e.isDirectory()) walk(path.join(d, e.name)); else n++; } };
            try { walk(path.join(cfg.root, r0)); } catch {}
            if (n > 25) { out.push(`${r0}/ has more than 25 files, which is more than one feature; claim the files you are changing instead`); continue; }
          }
          const r = await client.post('lock', dir ? { path: r0 + '/', dir: true, branch: me.branch, note: 'feature: ' + feature }
            : { path: r0, branch: me.branch, note: 'feature: ' + feature, hold: true, baseHash: hashFile(path.join(cfg.root, r0)) });
          out.push(r.ok ? `claimed ${r0}${dir ? '/' : ''}` : `${r0}${dir ? '/' : ''} overlaps ${r.lock.path}, held by ${r.lock.holderName}${/^feature: /.test(r.lock.note || '') ? ` for "${r.lock.note.slice(9)}"` : ''}; work around it or ask them`);
        }
        return `"${feature}":\n${out.join('\n')}`;
      }
      case 'huddle_release_feature': {
        const s = await client.get('state');
        const mine = s.locks.filter(l => l.holder === me.id && /^feature: /.test(l.note || '') && (!a.feature || l.note === 'feature: ' + String(a.feature).trim()));
        if (!mine.length) return 'no matching claim';
        const r = await client.post('unlock', { paths: mine.map(l => l.path), branch: me.branch });
        return 'released ' + r.released.join(', ');
      }
      case 'huddle_share_image': {
        const f = path.resolve(cfg.root, String(a.path || ''));
        const ext = path.extname(f).toLowerCase().slice(1);
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext];
        if (!mime) return 'png, jpg, webp or gif only';
        let buf;
        try { buf = fs.readFileSync(f); } catch { return `can't read ${a.path}`; }
        if (buf.length > 900 * 1024) return 'that image is over 900 KB; save a smaller version (a screenshot or a downscaled render) and share that';
        const r = await client.post('media', { data: buf.toString('base64'), mime, caption: a.caption || path.basename(f), source: 'shared', task: process.env.HUDDLE_TASK || null });
        return `in the gallery (${r.media.id})`;
      }
      case 'huddle_share_build': {
        const r = await client.post('build', { url: a.url, title: a.title, platform: a.platform, notes: a.notes });
        return `on the Builds page: ${r.build.title} (${r.build.url})`;
      }
      case 'huddle_timeline': {
        if (a.plan !== undefined) await client.post('timeline-plan', { text: a.plan });
        if (a.done) {
          const t = (await client.get('timeline')).timeline;
          const m = t.milestones.find(x => x.title.toLowerCase() === String(a.done).trim().toLowerCase());
          if (!m) return `no goal called "${a.done}"; goals: ${t.milestones.map(x => x.title).join(', ') || 'none yet'}`;
          await client.post('timeline-milestone', { id: m.id, done: true });
        }
        const r = await client.get('timeline');
        return r.briefing || 'No timeline yet. A person sets goals and deadlines in the dashboard (Timeline).';
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
        const r = await client.post('goal', { text: a.text, title: a.title, to: a.to || null, start: !!a.start });
        return a.to ? `sent to ${a.to}'s Claude as a task` : `posted team goal ${r.goal.id}; it gets planned${a.start ? ' and started' : ', then waits for someone to start it'}`;
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
        if (a.start && !(a.tasks || []).length) { await client.post('goal-start', { id: a.goal_id }); return 'Started: the tasks in this plan now run.'; }
        const r = await client.post('plan', { goalId: a.goal_id, title: a.title, summary: a.summary || '', tasks: a.tasks || [], start: !!a.start });
        return `plan saved:\n${r.tasks.map(board.taskLine).join('\n')}\n` + (a.start ? 'Started: owners run their tasks now.' : 'Nothing runs until someone starts it (Start in the dashboard, or huddle_plan with goal_id and start=true when your user says go).');
      }
      case 'huddle_distribute': {
        const parts = (a.tasks || []).filter(t => t && t.title);
        if (!parts.length) throw new Error('give at least one part');
        const g = await client.post('goal', { text: a.summary || parts.map(t => t.title).join('; '), claim: true });
        const r = await client.post('plan', { goalId: g.goal.id, title: a.title, summary: a.summary || '', start: true, tasks: parts.map(t => ({
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

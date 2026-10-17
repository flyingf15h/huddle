// Autopilot: lets this person's Claude take work from the team without them at
// the keyboard, by running `claude -p` in this folder with their own login.
//
// Modes (a per-person setting on the server, changeable from the dashboard,
// `huddle autopilot <mode>` or the huddle_autopilot tool):
//   requests  (default) do what someone sends to this person's Claude directly, without running
//             anything outside the allowed commands; the answer (and any command that needs this
//             person's OK) goes back to the sender as a message
//   full      also plan team goals and take unassigned tasks
//   off       nothing runs; requests wait for the person
//
// The runner lives inside the huddle MCP server of an open Claude session (so
// "requests" works whenever the person has Claude open), or in the foreground
// with `huddle autopilot`. Only one runner per folder at a time.
//
// Each request or task gets a Claude of its own, a new conversation in its own git worktree
// (~/.huddle/clones/), so several run at once and none of them lands in the conversation the
// person is having. When one finishes, its commits merge into the person's branch if that merges
// cleanly; otherwise they stay on huddle-request-<id> for the person to merge.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { identity, Client, sha, CONFIG_DIR } = require('./client');
const CLI = path.join(__dirname, 'cli.js');
const board = require('./board');
const gitx = require('./git');

const MODES = ['off', 'requests', 'full'];
const DEFAULT_MODE = 'requests';
const MODE_WORDS = { off: 'off (requests wait for you)', requests: 'takes requests (does what people send to your Claude)', full: 'full autopilot (also plans team goals and takes open tasks)' };

function normMode(m) {
  m = String(m || '').toLowerCase();
  if (['on', 'full', 'auto', 'autopilot'].includes(m)) return 'full';
  if (['requests', 'request', 'prompts', 'default'].includes(m)) return 'requests';
  if (['off', 'none', 'manual'].includes(m)) return 'off';
  return null;
}

function depsDone(b, t) { return (t.after || []).every(id => { const d = b.tasks.find(x => x.id === id); return !d || d.status === 'done'; }); }

function pick(b, me, skip, mode = 'full') {
  if (mode === 'off') return null;
  const mine = b.tasks.filter(t => t.owner === me && ['todo', 'doing'].includes(t.status) && !skip.has(t.id) && depsDone(b, t)
    && (mode === 'full' || t.direct));
  if (mine.length) return { kind: 'task', task: mine[0] };
  if (mode !== 'full') return null;
  const goal = b.goals.find(g => g.status === 'open' && !g.planner && !g.to && !skip.has(g.id));
  if (goal) return { kind: 'plan', goal };
  const free = b.tasks.find(t => !t.owner && t.status === 'todo' && !skip.has(t.id) && depsDone(b, t));
  if (free) return { kind: 'claim', task: free };
  return null;
}

// "Pip, tszfei's Claude" once the person has named it
function selfName(me, aiName) { return aiName ? `${aiName}, ${me}'s Claude` : `${me}'s Claude`; }

function planPrompt(goal, team, me, aiName) {
  return `You are ${selfName(me, aiName)}, coordinating a team of Claude agents through huddle (one per person, each on their own computer).
A person gave the team this goal [${goal.id}] (from ${goal.byName}):

${goal.text}

You won the right to plan it. Online agents: ${team.join(', ')}.
1. Look at the code as much as you need to understand what the goal involves.
2. Call huddle_plan with goal_id "${goal.id}": a short summary and concrete tasks (what to change, where, how to know it's done). Give each task an owner from the online agents, balance the work, include yourself, and split by files or modules so two agents don't edit the same files. Use "after" for real dependencies only.
3. Send the team a two-line summary with huddle_send.
Do not implement anything in this run; your own tasks come next.`;
}
function taskPrompt(t, b, me, canRun, aiName) {
  const goal = b.goals.find(g => g.id === t.goalId);
  const others = b.tasks.filter(x => x.goalId === t.goalId && x.id !== t.id).map(x => `- ${x.title} (${x.owner || 'unassigned'}, ${x.status})`);
  return `You are ${selfName(me, aiName)}, working with a team of Claude agents through huddle.
Your task [${t.id}]: ${t.title}
${t.detail ? '\n' + t.detail + '\n' : ''}${goal ? `\nIt is part of the team goal from ${goal.byName}: ${goal.text}\n${goal.plan ? 'Plan: ' + goal.plan + '\n' : ''}` : ''}${others.length ? '\nOther tasks in this goal:\n' + others.join('\n') + '\n' : ''}
Do the task in this repository. Stay inside its scope; if you need a file someone else is working on, message them with huddle_send instead of waiting silently.
Shell commands: ${canRun}. Don't try others; they will be refused and nobody is there to approve them. If you can't run a check, say what you couldn't verify in your note instead of blocking the task.
When it's done, commit it with git (one short message; anything left uncommitted is committed for you). Then call huddle_update_task with task_id "${t.id}", status "done" and a one-line note of what you did. Only use status "blocked" for a real problem in the work itself.${t.direct ? `
${t.by} sent you this directly, and your final message goes back to ${t.by} as your reply. Always answer, even if you can't finish: read what's needed, do what you can without the refused commands, then end with a short reply saying what you did or found. If a command you weren't allowed to run is needed, list it under "Needs ${me}'s OK:" so ${me} can approve and run it; don't treat that as blocked.` : ''}`;
}


// A worktree on a branch of its own for one request, set up as the same person in the same huddle.
// null when this isn't a git checkout with commits (the request then runs in the folder itself).
function makeClone(cfg, id) {
  const root = cfg.root;
  if (cfg.requestsIn === 'here' || !gitx.isRepo(root) || !gitx.head(root)) return null;
  // outside the project, so dev servers, watchers and test runners there never see it
  const dir = path.join(cfg.clonesDir || path.join(os.homedir(), '.huddle', 'clones'), `${path.basename(root)}-${sha(root).slice(0, 6)}`, id);
  const branch = `huddle-request-${id}`;
  const base = gitx.head(root);
  fs.rmSync(dir, { recursive: true, force: true });
  gitx.git(root, ['worktree', 'prune']);
  if (!gitx.git(root, ['worktree', 'add', '-q', '-B', branch, dir, base]).ok) return null;
  const person = gitx.currentBranch(root, 0);
  fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
  const own = JSON.parse(fs.readFileSync(path.join(root, CONFIG_DIR, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, CONFIG_DIR, 'config.json'), JSON.stringify({ ...own, clone: { id, branch: person, of: root } }, null, 2), { mode: 0o600 });
  const local = path.join(root, '.claude', 'settings.local.json');
  if (fs.existsSync(local)) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.copyFileSync(local, path.join(dir, '.claude', 'settings.local.json'));
  }
  return { id, dir, branch, base, person };
}

// Commit what the clone did and bring it into the person's branch when git can do that cleanly
// (it never touches files they have uncommitted changes in). Returns where the work ended up.
function landClone(cfg, c, title) {
  if (gitx.dirty(c.dir).length || gitx.git(c.dir, ['status', '--porcelain']).out) {
    gitx.git(c.dir, ['add', '-A']);
    gitx.git(c.dir, ['commit', '-q', '-m', title.slice(0, 72)]);
  }
  const count = Number(gitx.git(c.dir, ['rev-list', '--count', `${c.base}..HEAD`]).out) || 0;
  let landed = 'none';
  if (count && c.person && gitx.currentBranch(cfg.root, 0) === c.person) {
    const m = gitx.git(cfg.root, ['merge', '--no-edit', '-m', `merge ${c.branch}: ${title.slice(0, 60)}`, c.branch]);
    if (m.ok) landed = 'merged';
    else if (gitx.git(cfg.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) gitx.git(cfg.root, ['merge', '--abort']);
  }
  if (count && landed !== 'merged') landed = 'branch';
  gitx.git(cfg.root, ['worktree', 'remove', '--force', c.dir]);
  if (landed !== 'branch') gitx.git(cfg.root, ['branch', '-D', c.branch]);
  return { landed, count };
}

// one runner per folder: a pid file in .huddle/
function claimRunner(root) {
  const file = path.join(root, CONFIG_DIR, 'runner.pid');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); return false; } catch (e) { if (e.code === 'EPERM') return false; } }
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  return true;
}
function releaseRunner(root) {
  const file = path.join(root, CONFIG_DIR, 'runner.pid');
  try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file); } catch {}
}

async function myAiName(client) {
  const s = await client.get('settings');
  return ((s.settings || {})[client.agent.name] || {}).aiName || null;
}

async function getMode(client) {
  const s = await client.get('settings');
  const mine = s.settings && s.settings[client.agent.name];
  return (mine && normMode(mine.autopilot)) || DEFAULT_MODE;
}

// The work loop shared by the background runner and `huddle autopilot`.
// log: status lines; out: Claude's own output (null to discard).
function createRunner({ cfg, client, flags = {}, log = () => {}, out = null }) {
  const me = cfg.name;
  const permission = flags['permission-mode'] || cfg.autopilotPermissionMode || 'acceptEdits';
  const extraAllow = [].concat(flags.allow || cfg.autopilotAllow || []).flatMap(a => String(a).split(',')).map(a => a.trim()).filter(Boolean);
  // how many request Claudes may run at once (one when they'd share this folder)
  const max = Math.max(1, Number(flags.parallel || cfg.requestsParallel || 3));
  const skip = new Set();
  const running = new Map(); // task or goal id -> what it's doing
  let pumping = false, again = false, mode = DEFAULT_MODE, stopped = false;

  const runClaude = (prompt, { cwd = cfg.root, session, mcpRoot } = {}) => new Promise((resolve) => {
    const allowed = ['mcp__huddle', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', ...extraAllow];
    const args = ['-p', prompt, '--permission-mode', permission];
    // a worktree isn't the folder the huddle MCP server was registered for, so hand it over directly
    if (mcpRoot) args.push('--mcp-config', JSON.stringify({ mcpServers: { huddle: { type: 'stdio', command: process.execPath, args: [CLI, 'mcp'], env: { HUDDLE_ROOT: mcpRoot } } } }));
    if (flags.model || cfg.autopilotModel) args.push('--model', flags.model || cfg.autopilotModel);
    args.push('--allowedTools', ...allowed);
    // (the session's MCP server runs with HUDDLE_ROOT set to the person's folder; a clone has its own)
    const env = { ...process.env, HUDDLE_AUTOPILOT: '1', ...(session ? { HUDDLE_SESSION: session } : {}), ...(mcpRoot ? { HUDDLE_ROOT: mcpRoot } : {}) };
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    let text = '';
    child.stdout.on('data', d => { text += d; if (out) out(String(d)); });
    child.stderr.on('data', d => { if (out) out(String(d)); });
    child.on('error', e => { log('could not start claude: ' + e.message); resolve({ code: 1, out: text }); });
    child.on('close', code => resolve({ code, out: text }));
  });
  const canRun = () => permission === 'bypassPermissions' ? 'you may run any command'
    : `only git (status, diff, log, add, commit)${extraAllow.length ? ', ' + extraAllow.join(', ') : ''} and whatever the project's .claude/settings.json allows`;

  async function refreshMode() {
    mode = flags.mode ? normMode(flags.mode) : await getMode(client).catch(() => mode);
    await client.post('hello', { runner: mode }).catch(() => {});
    return mode;
  }

  // A request's answer goes back to whoever sent it, as a message. Messages never start runs, so
  // two Claudes can't end up answering each other forever.
  async function reply(t, res, now, where) {
    const answer = res.out.trim().slice(-1500) || (res.code === 0 ? 'Done.' : 'The run failed without saying why.');
    await client.post('message', { to: t.by, text: `Re your request "${t.title.slice(0, 80)}" (${now ? now.status : 'gone'}${where ? '; ' + where : ''}):\n${answer}` })
      .catch(e => log('could not send the reply: ' + e.message));
  }

  // the huddle identity a request's Claude has: its own, so the team sees each one and their locks
  // keep them out of each other's files
  function cloneClient(root, key, branch) {
    const ccfg = { ...cfg, root };
    return new Client(ccfg, { ...identity(ccfg, 'agent', key), branch });
  }

  async function plan(goal) {
    log(`planning goal ${goal.id}: ${goal.text.split('\n')[0]}`);
    const key = 'plan-' + goal.id;
    const who = cloneClient(cfg.root, key, gitx.currentBranch(cfg.root, 0));
    await who.post('hello', { clone: `planning a goal from ${goal.byName}` }).catch(() => {});
    await who.post('status', { status: `planning: ${goal.text.split('\n')[0].slice(0, 80)}` }).catch(() => {});
    const s = await client.get('state');
    const team = [...new Set(s.agents.filter(a => a.online && (a.kind === 'agent' || a.kind === 'autopilot')).map(a => a.name))];
    await runClaude(planPrompt(goal, team.length ? team : [me], me, await myAiName(client).catch(() => null)), { session: key });
    const after = (await client.get('board')).goals.find(g => g.id === goal.id);
    if (after && after.status !== 'planned' && after.status !== 'done') {
      log('Claude did not record a plan; taking the whole goal as one task');
      await client.post('plan', { goalId: goal.id, summary: '', tasks: [{ title: goal.text.split('\n')[0].slice(0, 200), detail: goal.text, owner: me }] });
    }
    await who.post('bye', {}).catch(() => {});
  }

  async function task(t, b) {
    log(`working on ${t.direct ? 'a request from ' + t.by : 'task'} ${t.id}: ${t.title}`);
    await client.post('task-update', { id: t.id, status: 'doing' });
    const c = makeClone(cfg, t.id);
    const key = 'clone-' + t.id;
    const who = cloneClient(c ? c.dir : cfg.root, key, c ? c.person : gitx.currentBranch(cfg.root, 0));
    await who.post('hello', { clone: t.direct ? `request from ${t.by}` : 'board task' }).catch(() => {});
    await who.post('status', { status: `${t.direct ? `request from ${t.by}` : 'task'}: ${t.title.slice(0, 80)}` }).catch(() => {});
    const res = await runClaude(taskPrompt(t, b, me, canRun(), await myAiName(client).catch(() => null)),
      { cwd: c ? c.dir : cfg.root, session: key, mcpRoot: c ? c.dir : null });
    let where = '';
    if (c) {
      const l = landClone(cfg, c, t.title);
      if (l.landed === 'merged') { where = `merged into ${me}'s ${c.person}`; log(`merged ${c.branch} into ${c.person}`); }
      if (l.landed === 'branch') {
        where = `on branch ${c.branch}: it didn't merge cleanly into ${me}'s ${c.person || 'checkout'}`;
        await gitx.publish(client, cfg.root, { branch: c.branch }).catch(() => {});
        log(`left the work on ${c.branch} (didn't merge cleanly)`);
      }
    } else if (gitx.isRepo(cfg.root) && gitx.dirty(cfg.root).length) {
      // finished work only reaches the others once it's committed
      gitx.ensureExcluded(cfg.root);
      gitx.git(cfg.root, ['add', '-A']);
      if (gitx.git(cfg.root, ['commit', '-q', '-m', t.title.slice(0, 72)]).ok) log("committed the task's changes");
    }
    if (gitx.isRepo(cfg.root)) {
      const pub = await gitx.publish(client, cfg.root).catch(e => ({ skipped: e.message }));
      if (pub.tip && !pub.unchanged) log(`shared ${pub.branch} at ${pub.tip.slice(0, 8)}`);
    }
    let now = (await client.get('board')).tasks.find(x => x.id === t.id);
    if (now && now.status === 'doing') {
      const last = res.out.trim().split('\n').pop() || '';
      now = (await client.post('task-update', { id: t.id, status: res.code === 0 ? 'done' : 'blocked', note: (res.code === 0 ? 'autopilot run finished: ' : 'autopilot run failed: ') + last.slice(0, 300) + (where ? ` (${where})` : '') })).task;
    }
    if (t.direct) await reply(t, res, now, where);
    if (now && now.status !== 'done') skip.add(t.id); // don't loop on a blocked task
    await who.post('bye', {}).catch(() => {});
    log(`${t.id} ${now ? now.status : 'gone'}`);
  }

  function start(id, what, job) {
    running.set(id, what);
    job().catch(e => log('autopilot: ' + e.message)).finally(() => { running.delete(id); work(); });
  }

  // hand out work until `max` Claudes are busy; each finished one makes room for the next
  async function work() {
    if (stopped) return;
    if (pumping) { again = true; return; }
    pumping = true;
    try {
      do {
        again = false;
        // without worktrees they'd share one folder and one git index, so one at a time
        const room = gitx.isRepo(cfg.root) && cfg.requestsIn !== 'here' ? max : 1;
        while (!stopped && mode !== 'off' && running.size < room) {
          const b = await client.get('board');
          const next = pick(b, me, new Set([...skip, ...running.keys()]), mode);
          if (!next) break;
          if (next.kind === 'plan') {
            const r = await client.post('claim-goal', { id: next.goal.id });
            if (!r.ok) { skip.add(next.goal.id); continue; }
            start(next.goal.id, 'plan', () => plan(next.goal));
            continue;
          }
          let t = next.task;
          if (next.kind === 'claim') {
            const r = await client.post('claim-task', { id: t.id });
            if (!r.ok) { skip.add(t.id); continue; }
            t = r.task;
          }
          start(t.id, t.title, () => task(t, b));
        }
      } while (again && !stopped);
    } catch (e) { log('autopilot: ' + e.message); }
    pumping = false;
  }

  return {
    get mode() { return mode; },
    get running() { return [...running.values()]; },
    refreshMode,
    work,
    // react to live events: board changes mean new work, setting changes may switch modes
    async onEvent(ev) {
      if (ev.type === 'setting' && ev.name === me) { await refreshMode(); log(`mode: ${MODE_WORDS[mode]}`); return work(); }
      if (ev.type === 'board') return work();
    },
    stop() { stopped = true; },
  };
}

// `huddle autopilot` with no mode: run here in the foreground (for when no
// Claude session is open in this folder)
async function runAutopilot(cfg, flags = {}) {
  const client = new Client(cfg, { ...identity(cfg, 'autopilot'), kind: 'autopilot' });
  const log = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);
  if (!claimRunner(cfg.root)) {
    console.log('Your Claude session in this folder is already taking requests in the background (one runner per folder).\nChange what it does with: huddle autopilot on|requests|off');
    return;
  }
  process.on('exit', () => releaseRunner(cfg.root));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const runner = createRunner({ cfg, client, flags, log, out: (d) => process.stdout.write(d.replace(/^/gm, '    ')) });
  await runner.refreshMode();
  log(`autopilot for ${cfg.name} in ${cfg.root}: ${MODE_WORDS[runner.mode]}`);
  if (runner.mode === 'off') log('nothing will run until you switch it on (huddle autopilot on, or from the dashboard)');
  log('waiting for work (ctrl-c to stop)');
  await runner.work();
  let seq = (await client.get('state')).seq;
  setInterval(() => client.post('hello', { runner: runner.mode }).catch(() => {}), 60000);
  for (;;) {
    const opened = await listenWs(client, seq, (ev) => runner.onEvent(ev));
    if (!opened) {
      try {
        const r = await client.get('events', { since: seq, wait: 25 }, { timeout: 35000 });
        for (const ev of r.events) { seq = ev.seq; await runner.onEvent(ev); }
        if (r.truncated) seq = r.seq;
      } catch { await new Promise(r => setTimeout(r, 5000)); }
    } else {
      seq = (await client.get('state').catch(() => ({ seq }))).seq;
      await runner.work();
    }
  }
}

function listenWs(client, since, onEvent) {
  return new Promise((resolve) => {
    if (typeof WebSocket !== 'function') return resolve(false);
    const q = new URLSearchParams({ token: client.cfg.token, since: String(since), agent: JSON.stringify(client.agent) });
    let ws, opened = false, ping;
    try { ws = new WebSocket(`${client.base.replace(/^http/, 'ws')}/ws?${q}`); } catch { return resolve(false); }
    ws.onopen = () => { opened = true; ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 30000); };
    ws.onmessage = (m) => { if (m.data === 'pong') return; try { const ev = JSON.parse(m.data); if (ev.type === 'board' || ev.type === 'setting') onEvent(ev); } catch {} };
    ws.onclose = () => { clearInterval(ping); setTimeout(() => resolve(opened), opened ? 1000 : 0); };
    ws.onerror = () => {};
  });
}

module.exports = { runAutopilot, createRunner, claimRunner, releaseRunner, pick, makeClone, landClone, normMode, getMode, MODES, MODE_WORDS, DEFAULT_MODE, planPrompt, taskPrompt, board };

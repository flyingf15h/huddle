// `huddle autopilot`: lets this person's Claude take team work on its own.
// It watches the board and runs `claude -p` in this folder (with this person's
// own Claude login) to plan unclaimed goals and do the tasks assigned to them.
'use strict';
const { spawn } = require('child_process');
const { identity, Client } = require('./client');
const board = require('./board');
const gitx = require('./git');

function depsDone(b, t) { return (t.after || []).every(id => { const d = b.tasks.find(x => x.id === id); return !d || d.status === 'done'; }); }

function pick(b, me, skip) {
  const mine = b.tasks.filter(t => t.owner === me && ['todo', 'doing'].includes(t.status) && !skip.has(t.id) && depsDone(b, t));
  if (mine.length) return { kind: 'task', task: mine[0] };
  const goal = b.goals.find(g => g.status === 'open' && !g.planner && !g.to && !skip.has(g.id));
  if (goal) return { kind: 'plan', goal };
  const free = b.tasks.find(t => !t.owner && t.status === 'todo' && !skip.has(t.id) && depsDone(b, t));
  if (free) return { kind: 'claim', task: free };
  return null;
}

function planPrompt(goal, team, me) {
  return `You are ${me}'s Claude, coordinating a team of Claude agents through huddle (one per person, each on their own computer).
A person gave the team this goal [${goal.id}] (from ${goal.byName}):

${goal.text}

You won the right to plan it. Online agents: ${team.join(', ')}.
1. Look at the code as much as you need to understand what the goal involves.
2. Call huddle_plan with goal_id "${goal.id}": a short summary and concrete tasks (what to change, where, how to know it's done). Give each task an owner from the online agents, balance the work, include yourself, and split by files or modules so two agents don't edit the same files. Use "after" for real dependencies only.
3. Send the team a two-line summary with huddle_send.
Do not implement anything in this run; your own tasks come next.`;
}

function taskPrompt(t, b, me, canRun) {
  const goal = b.goals.find(g => g.id === t.goalId);
  const others = b.tasks.filter(x => x.goalId === t.goalId && x.id !== t.id).map(x => `- ${x.title} (${x.owner || 'unassigned'}, ${x.status})`);
  return `You are ${me}'s Claude, working with a team of Claude agents through huddle.
Your task [${t.id}]: ${t.title}
${t.detail ? '\n' + t.detail + '\n' : ''}${goal ? `\nIt is part of the team goal from ${goal.byName}: ${goal.text}\n${goal.plan ? 'Plan: ' + goal.plan + '\n' : ''}` : ''}${others.length ? '\nOther tasks in this goal:\n' + others.join('\n') + '\n' : ''}
Do the task in this repository. Stay inside its scope; if you need a file someone else is working on, message them with huddle_send instead of waiting silently.
Shell commands: ${canRun}. Don't try others; they will be refused and nobody is there to approve them. If you can't run a check, say what you couldn't verify in your note instead of blocking the task.
When it's done, commit it with git (one short message; anything left uncommitted is committed for you). Then call huddle_update_task with task_id "${t.id}", status "done" and a one-line note of what you did. Only use status "blocked" for a real problem in the work itself.`;
}

async function runAutopilot(cfg, flags = {}) {
  const agent = { ...identity(cfg, 'autopilot'), kind: 'autopilot' };
  const client = new Client(cfg, agent);
  const me = cfg.name;
  const mode = flags['permission-mode'] || 'acceptEdits';
  const log = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);
  const skip = new Set();
  const extraAllow = [].concat(flags.allow || []).flatMap(a => String(a).split(',')).map(a => a.trim()).filter(Boolean);
  let busy = false;

  await client.post('hello', { status: 'autopilot: waiting for team work' });
  log(`autopilot for ${me} in ${cfg.root}`);
  log(`Claude runs with --permission-mode ${mode}${mode === 'acceptEdits' ? ' (it can edit files and commit, but not run other commands; add some with --allow "Bash(npm test:*)", or allow everything with --permission-mode bypassPermissions, only in a folder you trust)' : ''}`);
  log('waiting for team goals and tasks (ctrl-c to stop)');

  const runClaude = (prompt) => new Promise((resolve) => {
    // committing is how finished work reaches the others, so allow the safe git commands
    const allowed = ['Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)', 'Bash(git commit:*)', ...extraAllow];
    const args = ['-p', prompt, '--permission-mode', mode, '--allowedTools', ...allowed];
    if (flags.model) args.push('--model', flags.model);
    const child = spawn('claude', args, { cwd: cfg.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUDDLE_AUTOPILOT: '1' } });
    let out = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(String(d).replace(/^/gm, '    ')); });
    child.stderr.on('data', d => process.stderr.write(String(d).replace(/^/gm, '    ')));
    child.on('error', e => { log('could not start claude: ' + e.message); resolve({ code: 1, out }); });
    child.on('close', code => resolve({ code, out }));
  });

  async function work() {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const b = await client.get('board');
        const next = pick(b, me, skip);
        if (!next) break;
        if (next.kind === 'plan') {
          const r = await client.post('claim-goal', { id: next.goal.id });
          if (!r.ok) { skip.add(next.goal.id); continue; }
          log(`planning goal ${next.goal.id}: ${next.goal.text.split('\n')[0]}`);
          await client.post('status', { status: `planning: ${next.goal.text.split('\n')[0].slice(0, 80)}` });
          const s = await client.get('state');
          const team = [...new Set(s.agents.filter(a => a.online && (a.kind === 'agent' || a.kind === 'autopilot')).map(a => a.name))];
          await runClaude(planPrompt(next.goal, team.length ? team : [me], me));
          const after = (await client.get('board')).goals.find(g => g.id === next.goal.id);
          if (after && after.status !== 'planned' && after.status !== 'done') {
            log('Claude did not record a plan; taking the whole goal as one task');
            await client.post('plan', { goalId: next.goal.id, summary: '', tasks: [{ title: next.goal.text.split('\n')[0].slice(0, 200), detail: next.goal.text, owner: me }] });
          }
          continue;
        }
        let t = next.task;
        if (next.kind === 'claim') {
          const r = await client.post('claim-task', { id: t.id });
          if (!r.ok) { skip.add(t.id); continue; }
          t = r.task;
        }
        log(`working on task ${t.id}: ${t.title}`);
        await client.post('task-update', { id: t.id, status: 'doing' });
        await client.post('status', { status: `task: ${t.title.slice(0, 80)}` });
        const canRun = mode === 'bypassPermissions' ? 'you may run any command'
          : `only git (status, diff, log, add, commit)${extraAllow.length ? ' and ' + extraAllow.join(', ') : ''} are allowed`;
        const res = await runClaude(taskPrompt(t, b, me, canRun));
        // finished work only reaches the others once it's committed
        if (gitx.isRepo(cfg.root) && gitx.dirty(cfg.root).length) {
          gitx.ensureExcluded(cfg.root);
          gitx.git(cfg.root, ['add', '-A']);
          const c = gitx.git(cfg.root, ['commit', '-q', '-m', t.title.slice(0, 72)]);
          if (c.ok) log('committed the task\'s changes');
        }
        if (gitx.isRepo(cfg.root)) {
          const pub = await gitx.publish(client, cfg.root).catch(e => ({ skipped: e.message }));
          if (pub.tip && !pub.unchanged) log(`shared ${pub.branch} at ${pub.tip.slice(0, 8)}`);
        }
        const now = (await client.get('board')).tasks.find(x => x.id === t.id);
        if (now && now.status === 'doing') {
          const last = res.out.trim().split('\n').pop() || '';
          await client.post('task-update', { id: t.id, status: res.code === 0 ? 'done' : 'blocked', note: (res.code === 0 ? 'autopilot run finished: ' : 'autopilot run failed: ') + last.slice(0, 300) });
        }
        if (now && now.status !== 'done') skip.add(t.id); // don't loop on a blocked task
        log(`task ${t.id} ${now ? now.status : 'gone'}`);
      }
    } catch (e) { log('autopilot: ' + e.message); }
    await client.post('status', { status: 'autopilot: waiting for team work' }).catch(() => {});
    busy = false;
  }

  await work();
  // wake on board changes; WebSocket on the hosted server (free while idle), long-poll otherwise
  let seq = (await client.get('state')).seq;
  const onEvent = (ev) => { if (ev.type === 'board') work(); };
  setInterval(() => client.post('hello', {}).catch(() => {}), 60000);
  for (;;) {
    const opened = await listenWs(client, seq, onEvent);
    if (!opened) {
      try {
        const r = await client.get('events', { since: seq, wait: 25 }, { timeout: 35000 });
        for (const ev of r.events) { seq = ev.seq; onEvent(ev); }
        if (r.truncated) seq = r.seq;
      } catch { await new Promise(r => setTimeout(r, 5000)); }
    } else {
      seq = (await client.get('state').catch(() => ({ seq }))).seq;
      await work();
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
    ws.onmessage = (m) => { if (m.data === 'pong') return; try { const ev = JSON.parse(m.data); if (ev.type === 'board') onEvent(ev); } catch {} };
    ws.onclose = () => { clearInterval(ping); setTimeout(() => resolve(opened), opened ? 1000 : 0); };
    ws.onerror = () => {};
  });
}

module.exports = { runAutopilot, pick, planPrompt, taskPrompt, board };

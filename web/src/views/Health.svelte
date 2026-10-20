<script>
  // Health: is huddle working on everyone's computer: stuck work, approvals, outdated copies, errors,
  // and what agents did on their own in the last day.
  import { S, dn, toolOf } from '../lib/state.svelte.js';
  import { ago, fmtDur, bestTitle, stuckReason } from '../lib/words.js';
  import { RUN_WORD, runPill } from '../lib/tasks.js';
  import Avatar from '../components/Avatar.svelte';

  const DAY = 86400000;
  const people = $derived.by(() => {
    const by = new Map();
    for (const a of Object.values(S.agents)) {
      if (a.kind === 'human' || a.clone) continue;
      const p = by.get(a.name) || { name: a.name, online: false, runner: null, build: null, lastSeen: 0 };
      p.online = p.online || a.online;
      if (a.runner && a.online) p.runner = a.runner;
      if (a.build && (!p.build || a.build.at > p.build.at)) p.build = a.build;
      p.lastSeen = Math.max(p.lastSeen, a.lastSeen || 0);
      by.set(a.name, p);
    }
    return [...by.values()].sort((x, y) => (y.online - x.online) || x.name.localeCompare(y.name));
  });
  const newest = $derived(Math.max(0, ...people.map(p => (p.build && p.build.at) || 0)));
  const outdated = (p) => !p.build || p.build.at < newest - 60000;
  const tasks = $derived(S.board.tasks);
  const runs = $derived(tasks.flatMap(t => (t.runs || []).map(r => ({ ...r, task: t }))).filter(r => r.at > Date.now() - DAY).sort((a, b) => b.at - a.at));
  const problems = $derived(S.problems.filter(x => x.at > Date.now() - DAY).sort((a, b) => b.at - a.at));
  const title = (t) => bestTitle(t.title, t.detail).title;
  const todo = $derived([
    ...tasks.filter(t => t.status === 'blocked').map(t => ({ sev: 'blocked', html: `<b>“${esc(title(t))}”</b> is stuck${t.owner ? ` (${esc(t.owner)})` : ''}: ${esc((stuckReason(t) || 'its agent gave up').replace(/[\s.,;:]+$/, ''))}. Open it in Tasks to run it again or mark it done.` })),
    ...S.approvals.map(x => ({ sev: 'doing', html: `<b>${esc(x.owner)}'s ${esc(toolOf(x.owner))}</b> is waiting for ${esc(x.owner)} to OK <code>${esc(x.command)}</code>${x.title ? ` for “${esc(x.title)}”` : ''}.` })),
    ...S.conflicts.flatMap(c => c.items.map(x => ({ sev: 'doing', html: `<b>${esc(c.owner)}/${esc(c.branch)}</b> would conflict with <b>${esc(x.other)}</b> in ${x.files.length} file${x.files.length === 1 ? '' : 's'}. Resolve it in Code.` }))),
    ...people.filter(outdated).map(p => ({ sev: 'doing', html: `<b>${esc(p.name)}'s huddle is out of date</b>, so newer features (background work, usage counting) don't run for them. ${esc(p.name)} should run <code>npx -y github:flyingf15h/huddle update</code> and restart their agent.` })),
    ...people.filter(p => p.online && (!p.runner || p.runner === 'off')).map(p => ({ sev: 'todo', html: `<b>${esc(p.name)}'s background work is ${p.runner === 'off' ? 'turned off' : 'not running'}</b>, so requests sent to ${esc(p.name)} wait until they handle them.` })),
    ...(problems.length ? [{ sev: 'blocked', html: `<b>${problems.length} error${problems.length === 1 ? ' was' : 's were'} reported</b> from teammates' computers in the last day. Details below.` }] : []),
  ]);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
</script>

<main data-main style="display:flex;flex-direction:column;min-height:0;flex:1">
  <div class="pageview">
    <p class="muted" style="margin:0 0 14px;max-width:680px">Checks that huddle works on everyone's computer: their agent is connected, their huddle is up to date, and work their agents do on their own isn't failing.</p>
    <div class="panel"><div class="srow" style="border-top:0;min-height:56px">
      {#if todo.length}<span class="pill warn" style="font-size:13px">{todo.length} thing{todo.length === 1 ? ' needs' : 's need'} attention</span>
      {:else}<span class="pill ok" style="font-size:13px">Everything is working</span><span class="muted">Nobody is stuck, everyone is up to date, and nothing failed in the last day.</span>{/if}</div>
      {#each todo as x}<div class="srow"><span class="dot {x.sev}" aria-hidden="true"></span><span class="grow">{@html x.html}</span></div>{/each}</div>
    <div class="panel"><h3>Teammates</h3><p class="pdesc"><b>Background work</b>: whether their agent picks up requests and tasks on its own while they're away. <b>huddle</b>: whether their copy is the newest one on the team.</p>
      <div class="plist">{#each people as p}<div class="srow"><Avatar name={p.name} sm /><span class="grow"><b>{dn(p.name)}</b><span class="sub">{toolOf(p.name) === 'Claude' ? 'Claude Code' : toolOf(p.name)} · {p.online ? 'online now' : 'last seen ' + ago(p.lastSeen)}</span></span>
        <span class="small muted hide-sm">Background work</span>
        {#if !p.online}<span class="pill">Away</span>{:else if p.runner === 'full'}<span class="pill ok" title="Takes requests and team tasks on its own">On</span>{:else if p.runner === 'requests'}<span class="pill acc">Requests only</span>{:else}<span class="pill warn">Off</span>{/if}
        <span class="small muted hide-sm">huddle</span>{#if outdated(p)}<span class="pill warn">Needs update</span>{:else}<span class="pill ok">Up to date</span>{/if}</div>
      {:else}<div class="srow muted">Nobody has opened an agent in this project yet.</div>{/each}</div></div>
    <div class="panel"><h3>Errors in the last day</h3><p class="pdesc">Reported automatically when something breaks on a teammate's computer: an agent crashing, a huddle hook failing, a Slack, Discord or email alert not arriving.</p>
      <div class="plist">{#each problems.slice(0, 30) as x}<div class="problem"><div class="pm"><b>{x.name}</b><span class="grow">{x.message}</span><span class="small muted">{ago(x.at)}</span></div>
        {#if x.detail}<details><summary class="small muted" style="cursor:pointer;margin-top:4px">Technical details</summary><pre>{x.detail}</pre></details>{/if}</div>{:else}<div class="srow muted">None.</div>{/each}</div></div>
    <div class="panel"><h3>Work agents did on their own, last day</h3><p class="pdesc">Requests and tasks that ran in the background. If an agent crashes partway, huddle runs it again, up to three tries.</p>
      <div class="plist">{#each runs.slice(0, 25) as r}<div class="srow"><span class="pill {runPill(r.outcome)}">{({ ok: 'Finished', retrying: 'Crashed, tried again', crashed: 'Crashed', failed: 'Failed', limit: 'Out of usage', waiting: 'Waiting' })[r.outcome] || r.outcome}</span>
        <span class="grow">{title(r.task)}<span class="sub">{r.by}'s {r.agent === 'codex' ? 'Codex' : r.agent === 'cursor' ? 'Cursor' : 'Claude'}{r.attempt > 1 ? ` · try ${r.attempt}` : ''}{r.ms ? ' · took ' + fmtDur(r.ms) : ''}</span></span><span class="small muted">{ago(r.at)}</span></div>{:else}<div class="srow muted">None in the last day.</div>{/each}</div></div>
    <p class="small muted">Is the huddle server itself up? <a href="/status" target="_blank" rel="noopener">{location.host}/status</a></p>
  </div>
</main>

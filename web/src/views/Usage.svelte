<script>
  // Usage & cost: how much each person used their agent, and what those tokens would cost at API
  // prices (subscriptions aren't billed per token, so it's the equivalent value). Charts are single
  // series in one hue, with the numbers in tables beside them.
  import { onMount } from 'svelte';
  import { S, api, dn, isOwner, onLive } from '../lib/state.svelte.js';
  import { fmtDur, fmtNum, tokenSum, tokensAll, ago } from '../lib/words.js';
  import { money } from '../lib/tasks.js';
  import Avatar from '../components/Avatar.svelte';

  let stats = $state(null), since = $state(0), costs = $state(null), err = $state(''), range = $state(30), tip = $state(null);
  let budget = $state(''), alertPct = $state(80), prices = $state(''), msg = $state(''), showTable = $state(false);
  const SPARK = 14;

  async function load() {
    try {
      const [s, c] = await Promise.all([api('stats'), api('costs')]);
      stats = s.stats; since = s.since; costs = c;
      if (!budget && c.budget) { budget = String(c.budget.monthly); alertPct = c.budget.alertPct; }
      prices = Object.entries(c.custom || {}).map(([m, p]) => `${m}: ${p.join(', ')}`).join('\n');
    } catch (e) { err = e.message; }
  }
  onMount(() => { load(); let t; return onLive((ev) => { if (ev.type === 'stats' || ev.type === 'usage') { clearTimeout(t); t = setTimeout(load, 1500); } }); });

  const people = $derived(stats ? Object.entries(stats).map(([name, s]) => ({ name, s, own: s.activeMs - (s.requestMs || 0), all: tokensAll(s), cost: costs && costs.people[name] ? costs.people[name].cost : 0 })).sort((a, b) => b.cost - a.cost || b.own - a.own) : []);
  const sum = (f) => people.reduce((t, p) => t + f(p), 0);
  const days = $derived.by(() => {
    if (!costs) return [];
    const out = [];
    for (let i = range - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); out.push({ d, cost: (costs.days[d] || {}).cost || 0, by: (costs.days[d] || {}).by || {} }); }
    return out;
  });
  const maxDay = $derived(Math.max(0.01, ...days.map(d => d.cost)));
  const maxPerson = $derived(Math.max(0.01, ...people.map(p => p.cost)));
  const models = $derived(costs ? Object.entries(costs.models).sort((a, b) => b[1].cost - a[1].cost) : []);
  const missing = $derived.by(() => {
    if (!stats) return [];
    const newest = Math.max(0, ...Object.values(S.agents).map(a => (a.build && a.build.at) || 0));
    return [...new Set([...Object.values(S.agents).filter(a => a.kind !== 'human' && !a.clone).map(a => a.name), ...Object.keys(S.settings || {})])].filter(n => !stats[n]).map(n => {
      const builds = Object.values(S.agents).filter(a => a.name === n && a.build).map(a => a.build.at);
      return { name: n, why: !builds.length || Math.max(...builds) < newest - 60000 ? 'their huddle is too old to report usage; they need to run huddle update' : "they haven't finished a prompt in this project since usage counting started" };
    });
  });
  const spark = (days) => { const keys = [...Array(SPARK)].map((_, i) => new Date(Date.now() - (SPARK - 1 - i) * 864e5).toISOString().slice(0, 10)); const vals = keys.map(k => (days[k] || {}).activeMs || 0); const mx = Math.max(...vals, 1); return keys.map((k, i) => ({ k, v: vals[i], h: Math.round(vals[i] / mx * 100) })); };
  const topModel = (s) => Object.entries(s.models).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))[0];
  const budgetPct = $derived(costs && costs.budget ? Math.min(100, costs.monthSpend / costs.budget.monthly * 100) : 0);

  async function saveCost() {
    msg = '';
    try {
      const p = {};
      for (const line of prices.split('\n').map(l => l.trim()).filter(Boolean)) { const [m, rest] = line.split(':'); const n = (rest || '').split(',').map(Number); if (m && n.length >= 2 && n.every(isFinite)) p[m.trim()] = n; else throw new Error(`Couldn't read "${line}". Write: model: input, output, cache read, cache write (dollars per million tokens)`); }
      await api('cost-settings', { budget: Number(budget) > 0 ? { monthly: Number(budget), alertPct: Number(alertPct) } : null, prices: p });
      msg = 'Saved.'; await load();
    } catch (e) { msg = e.message; }
  }
  const showTip = (e, d) => { const r = e.currentTarget.getBoundingClientRect(); tip = { d, x: r.left + r.width / 2, y: r.top }; };
</script>

<main data-main style="display:flex;flex-direction:column;min-height:0;flex:1">
  <div id="statsview" style="flex:1;overflow-y:auto;padding:16px 20px 28px">
    {#if err}<p class="err">{err}</p>{:else if !stats || !costs}<p class="muted">Loading…</p>
    {:else}
      <p class="muted small" style="margin-top:0;max-width:760px">Counted by each person's huddle hooks since {new Date(since).toLocaleDateString()}: numbers only, nothing of what was said. Cost is what those tokens would cost at the API's list prices. People on a Claude or Cursor plan aren't billed per token, so treat it as the value of the work, not a bill.</p>
      <div class="tiles">
        <div class="tile"><div class="k">Cost this month</div><div class="v">{money(costs.monthSpend)}</div></div>
        <div class="tile"><div class="k">{costs.budget ? 'Monthly budget' : 'Cost, all time'}</div><div class="v">{costs.budget ? money(costs.budget.monthly) : money(costs.total)}</div>
          {#if costs.budget}<div class="progress" style="max-width:none;margin-top:6px" role="progressbar" aria-valuenow={Math.round(budgetPct)} aria-valuemin="0" aria-valuemax="100" aria-label="Budget used"><span style="width:{budgetPct}%;background:{budgetPct >= 100 ? 'var(--bad)' : budgetPct >= costs.budget.alertPct ? 'var(--warn)' : 'var(--ok)'}"></span></div>{/if}</div>
        <div class="tile"><div class="k">Time with agents</div><div class="v">{fmtDur(sum(p => p.own))}</div></div>
        <div class="tile"><div class="k">Prompts</div><div class="v">{fmtNum(sum(p => p.s.turns))}</div></div>
        <div class="tile"><div class="k">Tokens processed</div><div class="v">{fmtNum(sum(p => p.all))}</div></div>
        <div class="tile"><div class="k">Requests run for others</div><div class="v">{sum(p => p.s.requests || 0)}</div></div>
      </div>

      <div class="panel"><h3>Cost per day</h3>
        <p class="pdesc">Last <span class="seg sm" style="margin:0 4px"><button class:on={range === 14} onclick={() => (range = 14)}>14</button><button class:on={range === 30} onclick={() => (range = 30)}>30</button><button class:on={range === 60} onclick={() => (range = 60)}>60</button></span> days, API-equivalent dollars.</p>
        <div class="pbody">
          <div class="bars" role="img" aria-label="Daily cost, {money(days.reduce((t, d) => t + d.cost, 0))} over {range} days" style="height:140px">
            {#each days as d}<button class="bar" tabindex="-1" aria-label="{d.d}: {money(d.cost)}" onmouseenter={(e) => showTip(e, d)} onmouseleave={() => (tip = null)} onfocus={(e) => showTip(e, d)}><i style="height:{d.cost ? Math.max(2, d.cost / maxDay * 100) : 0}%"></i></button>{/each}
          </div>
          <div class="axis small faint"><span>{days[0] && days[0].d.slice(5)}</span><span>max {money(maxDay)}</span><span>{days.length && days[days.length - 1].d.slice(5)}</span></div>
          <button class="link small" onclick={() => (showTable = !showTable)}>{showTable ? 'Hide the table' : 'Show as a table'}</button>
          {#if showTable}<div style="max-height:240px;overflow:auto"><table class="stats" style="margin-top:8px"><thead><tr><th>Day</th><th>Cost</th></tr></thead><tbody>{#each days.slice().reverse().filter(d => d.cost) as d}<tr><td>{d.d}</td><td>{money(d.cost)}</td></tr>{/each}</tbody></table></div>{/if}
        </div></div>
      {#if tip}<div class="chartTip" style="left:{tip.x}px;top:{tip.y}px"><b>{tip.d.d}</b><br>{money(tip.d.cost)}{#each Object.entries(tip.d.by).filter(([, v]) => v) as [n, v]}<br><span class="faint">{dn(n)}</span> {money(v)}{/each}</div>{/if}

      <div class="hcols" style="margin-bottom:16px">
        <div class="panel" style="margin:0"><h3>By person</h3><div class="pbody">
          {#each people as p}<div class="hbar"><span class="who"><Avatar name={p.name} sm /><span>{dn(p.name)}</span></span><span class="track"><i style="width:{p.cost / maxPerson * 100}%"></i></span><span class="num">{money(p.cost)}</span></div>{/each}</div></div>
        <div class="panel" style="margin:0"><h3>By model</h3><div class="pbody">
          {#each models as [m, x]}<div class="hbar"><span class="who mono small">{m}</span><span class="track"><i style="width:{models[0][1].cost ? x.cost / models[0][1].cost * 100 : 0}%"></i></span><span class="num">{x.priced ? money(x.cost) : 'no price'}</span></div>{:else}<div class="quiet">No model usage yet.</div>{/each}
          {#if costs.unpriced.length}<p class="small muted" style="margin-bottom:0">No list price for {costs.unpriced.join(', ')}. {isOwner() ? 'Add one below.' : 'An owner can add one.'}</p>{/if}</div></div>
      </div>

      {#if costs.tasks.length}
        <div class="panel"><h3>Most expensive tasks</h3><div class="plist">
          {#each costs.tasks.slice(0, 8) as t}<button class="srow" style="width:100%;text-align:left;border-radius:0;background:none;border-left:0;border-right:0;border-bottom:0" data-nav onclick={() => { S.openTask = t.id; import('../lib/state.svelte.js').then(m => m.go('tasks', { task: t.id })); }}><span class="grow">{t.title}<span class="sub">{t.owner ? dn(t.owner) : 'Unassigned'} · {t.status}</span></span><span class="num">{money(t.cost)}</span><span class="small faint">{fmtNum(t.tokens)} tokens</span></button>{/each}</div></div>
      {/if}

      <div class="statswrap"><table class="stats">
        <thead><tr><th>Person</th><th>Cost</th><th>Conversations</th><th>Time with agents</th><th>Prompts</th><th>Tokens</th><th>Requests for others</th><th>Last {SPARK} days</th></tr></thead>
        <tbody>{#each people as { name, s, own, all, cost }}{@const m = topModel(s)}
          <tr><td><span class="who"><Avatar {name} sm /><span>{dn(name)}<span class="sub">{m ? m[0] : 'no model usage yet'} · {ago(s.last)}</span></span></span></td>
            <td>{money(cost)}</td><td>{s.conversations}</td><td>{fmtDur(own)}</td><td>{fmtNum(s.turns)}</td>
            <td title="input {fmtNum(tokenSum(s, 'input'))} · cache read {fmtNum(tokenSum(s, 'cacheRead'))} · cache write {fmtNum(tokenSum(s, 'cacheWrite'))} · output {fmtNum(tokenSum(s, 'output'))}">{fmtNum(all)}</td>
            <td title="{fmtDur(s.requestMs || 0)} on requests from others">{s.requests || 0}</td>
            <td><span class="spark" title="time with agents, last {SPARK} days">{#each spark(s.days) as b}<i style="height:{b.h}%" title="{b.k}: {fmtDur(b.v)}"></i>{/each}</span></td></tr>{/each}</tbody></table></div>

      {#if missing.length}<div class="panel" style="margin-top:16px"><h3>No usage from</h3><div class="plist">{#each missing as m}<div class="srow"><Avatar name={m.name} sm /><span class="grow"><b>{dn(m.name)}</b><span class="sub">{m.why}</span></span></div>{/each}</div></div>{/if}

      {#if isOwner()}
        <div class="panel" style="margin-top:16px"><h3>Budget and prices</h3><p class="pdesc">Owners get a notification when the month's cost passes the alert line and again at 100%. List prices for Claude models are built in; add your own for other models or a negotiated rate.</p>
          <div class="pbody fieldset">
            <div class="row" style="display:flex;gap:10px;align-items:end;flex-wrap:wrap"><div><label for="bud">Monthly budget ($)</label><input id="bud" type="number" min="0" step="10" bind:value={budget} placeholder="No budget"></div><div><label for="bpct">Alert at (%)</label><input id="bpct" type="number" min="10" max="99" bind:value={alertPct}></div></div>
            <div><label for="prc">Custom prices</label><textarea id="prc" bind:value={prices} placeholder="gpt-5.5-codex: 1.25, 10" spellcheck="false"></textarea><div class="hintline">One model per line: <code>name: input, output, cache read, cache write</code>, dollars per million tokens.</div></div>
          </div><div class="pactions"><span class="small" class:err={msg && msg !== 'Saved.'}>{msg}</span><button class="primary" onclick={saveCost}>Save</button></div></div>
      {/if}
    {/if}
  </div>
</main>

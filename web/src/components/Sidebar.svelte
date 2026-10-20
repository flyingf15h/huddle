<script>
  // Left rail: project switcher, the pages, the team and what each person's agent is on, and my agent's mode.
  // On phones it's a drawer opened from the header.
  import { S, auth, known, go, goHome, openProject, people, cardLine, usageOf, dn, myName, hasClaude, claudeOf, myTool, aiName, prettyProject, api } from '../lib/state.svelte.js';
  import Avatar from './Avatar.svelte';
  import Icon from './Icon.svelte';

  const NAV = [['activity', 'Activity'], ['tasks', 'Tasks'], ['code', 'Code'], ['brief', 'Brief & memory'], ['usage', 'Usage & cost'], ['health', 'Health'], ['settings', 'Team & settings']];
  const MODES = [['full', 'Active', 'Runs requests and answers messages sent to you, and takes on team tasks, even while you are away.'],
    ['requests', 'Requests only', 'Runs requests and answers messages sent to you. Leaves team tasks to others.'],
    ['off', 'Off', 'Nothing runs in the background. Requests and messages wait for you.']];
  let projMenu = $state(false), modeMenu = $state(false), modeErr = $state('');
  const team = $derived(people());
  const online = $derived(team.filter(p => p.online).length);
  const problems = $derived(S.problems.filter(x => x.at > Date.now() - 86400000).length);
  const openTasks = $derived(S.board.tasks.filter(t => t.status === 'blocked' || (t.owner === myName() && t.status !== 'done')).length);
  const myMode = $derived((S.settings[myName()] && S.settings[myName()].autopilot) || 'full');
  const doingCount = (n) => S.board.tasks.filter(t => t.owner === n && t.status === 'doing').length;

  function pickPerson(n) { S.who = S.who === n ? null : n; go('activity'); }
  async function setMode(m) {
    modeErr = '';
    try { const r = await api('setting', { autopilot: m }); S.settings[myName()] = r.settings; modeMenu = false; } catch (e) { modeErr = "Couldn't change it: " + e.message; }
  }
  function ask(n) { S.askTo = n; go('activity'); }
</script>

<nav id="rail" class:open={S.drawer} aria-label="Project">
  <div class="rail-top" style="position:relative">
    <button class="projbtn" aria-haspopup="menu" aria-expanded={projMenu} onclick={() => (projMenu = !projMenu)}>
      <svg class="plogo" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="var(--accent)"/><circle cx="11" cy="13" r="4.2" fill="var(--raised)"/><circle cx="21" cy="13" r="4.2" fill="var(--raised)" opacity=".85"/><circle cx="16" cy="21" r="4.2" fill="var(--raised)" opacity=".7"/></svg>
      <span class="pn"><span id="pnameText">{prettyProject(auth.project)}</span><span class="pk">{S.demo ? 'Demo project' : 'huddle project'}</span></span>
      <Icon name="chevron" size={14} />
    </button>
    {#if projMenu}
      <div class="menu" role="menu" style="position:absolute;top:52px;left:10px;right:10px">
        <button class="mi" role="menuitem" onclick={goHome}>← All projects</button>
        <hr><div class="mh">Switch project</div>
        {#each Object.keys(known) as n}
          <button class="mi" class:cur={n === auth.project} role="menuitem" onclick={() => n !== auth.project && openProject(n)}><Avatar name={prettyProject(n)} sm /><span>{prettyProject(n)}</span>{#if n === auth.project}<span class="check">✓</span>{/if}</button>
        {/each}
      </div>
    {/if}
  </div>
  <div class="navlist">
    {#each NAV as [v, label]}
      <button class:on={S.view === v} aria-current={S.view === v ? 'page' : undefined} onclick={() => go(v)}>
        <Icon name={v} /><span>{label}</span>
        {#if v === 'health' && problems}<span class="navbadge">{problems}</span>{/if}
        {#if v === 'tasks' && openTasks}<span class="navbadge" style="background:var(--accent)">{openTasks}</span>{/if}
      </button>
    {/each}
  </div>
  <div class="railhead"><span>Team</span><span class="count">{team.length ? online + ' online' : ''}</span>
    <button class="ghost iconbtn sm" aria-label="Invite people" title="Invite people" onclick={() => (S.invite = true)}><Icon name="plus" size={16} /></button></div>
  <div id="team">
    {#each team as p (p.name)}
      {@const c = cardLine(p)}
      {@const u = usageOf(p.name)}
      {@const t = doingCount(p.name)}
      <div class="prow">
        {#if hasClaude(p.name)}<button class="pask" onclick={() => ask(p.name)} title="Ask {p.name === myName() ? 'your ' + myTool() : claudeOf(p.name)} to do something">Ask</button>{/if}
        <button class="person" class:sel={S.who === p.name} class:away={!p.online} data-nav onclick={() => pickPerson(p.name)} title={S.who === p.name ? 'Show everyone' : `Show only ${p.name}'s activity`}>
          <span class="pav"><Avatar name={p.name} busy={c.busy} /><i class="pres {p.online ? (p.runner === 'full' ? 'auto' : 'on') : 'off'}"></i></span>
          <span class="pbd">
            <span class="top"><span class="name">{dn(p.name)}{#if p.name === myName()} <span class="faint" style="font-weight:500">(you)</span>{/if}</span>{#if u}<span class="use"><span class:usehigh={u.high} title={u.title}>{u.left}% left</span></span>{/if}</span>
            {#if c.main}<span class="doing">{c.main}</span>{/if}
            <span class="live">{c.live}{t ? ` · ${t} task${t === 1 ? '' : 's'} open` : ''}</span>
          </span>
        </button>
      </div>
    {:else}
      <div class="quiet">Nobody has joined yet. <button class="link" onclick={() => (S.invite = true)}>Invite your team</button></div>
    {/each}
  </div>
  <div class="mepanel" style="position:relative">
    <button class="you ghost" style="border:0;background:none" onclick={() => (S.profile = true)} title="Your profile">{#if auth.name}<Avatar name={auth.name} sm /><span>{dn(auth.name)}</span>{/if}</button>
    {#if auth.name && hasClaude(myName())}
      <button class="mybtn" aria-haspopup="menu" aria-expanded={modeMenu} onclick={() => (modeMenu = !modeMenu)}><span class="mydot" class:off={myMode === 'off'} class:full={myMode === 'full'}></span><span>{aiName(myName()) || myTool()} · {MODES.find(x => x[0] === myMode)[1]}</span><Icon name="chevron" size={12} /></button>
      {#if modeMenu}
        <div class="menu" role="menu" style="position:absolute;bottom:58px;left:10px;right:10px">
          <div class="mh">Your {myTool()}</div>
          {#each MODES as [k, l, d]}<label class="modeopt"><input type="radio" name="mode" checked={k === myMode} onchange={() => setMode(k)}><div><b>{l}</b><span>{d}</span></div></label>{/each}
          {#if modeErr}<div class="mh err">{modeErr}</div>{/if}
        </div>
      {/if}
    {/if}
  </div>
</nav>

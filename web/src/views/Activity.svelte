<script>
  // Activity: the live feed of everyone's prompts, agent steps and replies, messages and changes,
  // with the request box under it and the side panel (approvals, tasks, locks, recent files).
  import { tick } from 'svelte';
  import { S, dn, claudeOf, toolOf, myName } from '../lib/state.svelte.js';
  import { feedRows, visible } from '../lib/feed.js';
  import { clock, fullDate, shortTitle, summarize, md, toolWords } from '../lib/words.js';
  import Avatar from '../components/Avatar.svelte';
  import Icon from '../components/Icon.svelte';
  import Composer from '../components/Composer.svelte';
  import SidePanel from '../components/SidePanel.svelte';
  import FileDialog from '../components/FileDialog.svelte';

  let { focusComposer = $bindable() } = $props();
  let feed, open = $state({}), stepsOpen = $state({});
  const list = $derived(S.entries.filter(visible).slice(-700));
  const rows = $derived(feedRows(list));

  // stay at the bottom while new things arrive, unless the person scrolled up to read
  let stick = true;
  const onScroll = () => { stick = feed.scrollTop + feed.clientHeight > feed.scrollHeight - 90; };
  $effect(() => { rows.length; if (stick) tick().then(() => { if (feed) feed.scrollTop = feed.scrollHeight; }); });
  // a search result in the feed: scroll to the turn at that time
  $effect(() => {
    if (!S.feedJump) return;
    const at = S.feedJump; S.feedJump = null;
    tick().then(() => { const el = [...feed.querySelectorAll('[data-at]')].find(x => Number(x.dataset.at) >= at); if (el) { stick = false; el.scrollIntoView({ block: 'center' }); el.focus(); } });
  });

  const openFile = (path, branch) => { S.fileOpen = { path, branch: branch || null }; };
  const verbWord = (e) => { const w = toolWords(e.text); return { verb: w.verb, arg: w.arg, code: w.code }; };
</script>

<main data-main>
  <section id="left">
    <div id="feed" bind:this={feed} onscroll={onScroll} aria-live="polite">
      {#if !list.length}
        {#if S.who || S.filter !== 'all'}<div class="empty">{S.who ? `No activity from ${S.who} yet.` : 'No activity of this type yet.'}</div>
        {:else}<div class="empty"><h3>No activity yet</h3><p style="margin:0 auto;max-width:460px">Prompts, replies and changes from every teammate's agent session will appear here.</p>
          <div class="acts"><button class="primary" onclick={() => focusComposer && focusComposer()}>New request</button></div></div>{/if}
      {/if}
      {#each rows as r (r.rowKey || r.key)}
        {#if r.type === 'day'}<div class="day">{r.label}</div>
        {:else if r.type === 'card'}
          <div class="card handcard"><div class="kicker"><b>{dn(r.e.who)}</b> left a hand-off note{#if r.e.auto} <span class="faint">(noted by huddle)</span>{/if} · {clock(r.e.at)}</div>
            <div class="small" style="white-space:pre-wrap">{r.e.text}</div>{#if r.e.commits.length}<div class="small faint" style="margin-top:4px">{#each r.e.commits.slice(0, 4) as c}{c}<br>{/each}</div>{/if}</div>
        {:else if r.type === 'note'}
          {@const e = r.e}
          <div class="note">
            <span class="ic"><Icon name={e.kind === 'repo' ? 'github' : e.kind} size={16} /></span>
            <span>
              {#if e.kind === 'join'}<b>{dn(e.who)}</b> {e.agentKind === 'autopilot' ? 'turned on autopilot' : 'opened ' + toolOf(e.who)}
              {:else if e.kind === 'lock'}<b>{dn(e.who)}</b> {#if e.dir}locked the whole <b>{e.path}</b> folder{:else}started editing <button class="link" onclick={() => openFile(e.path, e.branch)}>{e.path}</button>{/if}{e.branch ? ` on ${e.branch}` : ''}
              {:else if e.kind === 'unlock'}<b>{dn(e.who)}</b> {e.stale ? 'went quiet, so huddle released' : 'is done with'} {e.path}
              {:else if e.kind === 'file'}<b>{dn(e.who)}</b> saved <button class="link" onclick={() => openFile(e.path, e.branch)}>{e.path}</button> <span class="faint">v{e.version}</span>
              {:else if e.kind === 'git'}<b>{dn(e.who)}</b> shared <b>{e.branch}</b>{e.subject ? `: “${e.subject}”` : ''}
              {:else if e.kind === 'knowledge'}<b>{dn(e.who)}</b> {e.action === 'delete' ? 'deleted' : e.action === 'add' ? 'added' : 'updated'} {e.what === 'doc' ? 'the project brief' : e.what === 'memory' ? `the memory “${e.title}”` : `the skill “${e.title}”`}
              {:else if e.kind === 'approve'}<b>{dn(e.who)}</b> {e.approval.status === 'approved' ? 'allowed' : 'said no to'} <code>{e.approval.command}</code> for “{shortTitle(e.approval.title, 70)}”
              {:else if e.kind === 'task'}<b>{claudeOf(e.who)}</b> {e.text}
              {:else if e.kind === 'repo'}
                {@const g = e.repo}
                {#if g.action === 'push'}<b>{g.person ? dn(g.person) : g.by}</b> pushed {g.count} commit{g.count === 1 ? '' : 's'} to <b>{g.branch}</b> on GitHub{g.commits && g.commits.length ? `: “${g.commits[g.commits.length - 1].message}”` : ''}
                {:else if g.action === 'pr'}Pull request <a href={g.url} target="_blank" rel="noopener">#{g.number}</a> {g.what === 'closed' ? (g.state === 'merged' ? 'merged' : 'closed') : g.what}: “{g.title}”
                {:else if g.action === 'checks'}Checks <b style="color:var({g.state === 'failing' ? '--bad' : '--ok'})">{g.state}</b> on {g.branch}
                {:else if g.action === 'issue'}New issue <a href={g.url} target="_blank" rel="noopener">#{g.number}</a>: “{g.title}”{/if}
              {/if}
            </span>
            {#if r.count > 1}<span class="ncount" title="Happened {r.count} times">+{r.count - 1}</span>{/if}
            <time class="nt" title={fullDate(r.at)}>{clock(r.at)}</time>
          </div>
        {:else}
          <div class="turn" class:isbot={r.bot} class:toyou={r.toYou} data-at={r.at0} tabindex="-1">
            {#if r.bot}<Avatar bot />{:else}<Avatar name={r.who} />{/if}
            <div class="tbody">
              <div class="thead"><b>{r.bot ? claudeOf(r.who) : dn(r.who)}</b>{#if r.bot}<span class="bottag">{toolOf(r.who)}</span>{/if}{#if r.ctx}<span class="ctx">{r.ctx}</span>{/if}<time title={fullDate(r.at0)}>{clock(r.at0)}</time></div>
              <div class="items">
                {#each r.items as it, i}
                  {#if it.kind === 'tools'}
                    {@const k = r.rowKey + i}
                    <div class="it tools"><ul class:long={it.steps.length > 4} class:open={stepsOpen[k]}>
                      {#each it.steps as s}{@const w = verbWord(s)}<li><span class="verb">{w.verb}</span><span>{#if w.arg}{#if w.code}<code>{w.arg}</code>{:else}{w.arg}{/if}{/if}</span></li>{/each}
                    </ul>{#if it.steps.length > 4}<button class="link moresteps" onclick={() => (stepsOpen[k] = !stepsOpen[k])}>{stepsOpen[k] ? 'Show fewer' : `Show all ${it.steps.length} steps`}</button>{/if}</div>
                  {:else if it.kind === 'prompt'}<div class="it prompt">{it.text}</div>
                  {:else if it.kind === 'reply'}
                    {@const sum = summarize(it.text)}
                    {@const k = r.rowKey + 'r' + i}
                    <div class="it reply">{#if open[k] || sum === it.text.trim()}<div class="doc" style="font-size:14px">{@html md(it.text)}</div>{#if sum !== it.text.trim()}<button class="link small" onclick={() => (open[k] = false)}>Show less</button>{/if}
                      {:else}<div class="sumline"><span class="st">{sum}</span><button class="link more" onclick={() => (open[k] = true)}>Full reply</button></div>{/if}</div>
                  {:else if it.kind === 'end'}<div class="it end">Turn completed</div>
                  {:else if it.kind === 'goal'}<div class="it goal">{it.goal.text}</div>
                  {:else if it.kind === 'plan'}<div class="it plan">Split into {it.tasks.length} task{it.tasks.length === 1 ? '' : 's'}{it.goal && it.goal.plan ? ': ' + it.goal.plan : ''}</div>
                    <div class="embed">{#each it.tasks as t}<div class="erow"><span class="tt" title={t.title}>{shortTitle(t.title, 80)}</span><span class="owner">{#if t.owner}<Avatar name={t.owner} sm /><span>{t.owner}</span>{:else}<span class="faint">anyone</span>{/if}</span></div>{/each}</div>
                  {:else if it.kind === 'msg'}<div class="it msg">{it.text}</div>{/if}
                {/each}
              </div>
            </div>
          </div>
        {/if}
      {/each}
    </div>
    <Composer bind:focus={focusComposer} />
  </section>
  <SidePanel />
</main>
<FileDialog />

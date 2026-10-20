<script>
  // Beside the feed: commands waiting for my OK, requests in progress, files being edited, recent changes.
  import { S, go, myName, myTool, dn, keys, auth } from '../lib/state.svelte.js';
  import { ago, shortTitle } from '../lib/words.js';
  import { titleOf, decide, stuckReason } from '../lib/tasks.js';
  import Avatar from './Avatar.svelte';

  const mine = $derived(S.approvals.filter(x => x.owner === myName()));
  const asks = $derived.by(() => { const g = new Map(); for (const x of mine) { const k = x.taskId || x.id; if (!g.has(k)) g.set(k, []); g.get(k).push(x); } return [...g.values()]; });
  const canHere = $derived(!!keys[auth.project]);
  let askErr = $state({});
  const live = $derived(S.board.tasks.filter(t => t.status !== 'done').sort((a, b) => ({ blocked: 0, doing: 1, todo: 2 }[a.status] - { blocked: 0, doing: 1, todo: 2 }[b.status]) || (b.updated || b.at) - (a.updated || a.at)).slice(0, 8));
  const locks = $derived(Object.values(S.locks));
  const files = $derived(Object.values(S.files).filter(f => f.size).sort((a, b) => b.at - a.at).slice(0, 8));
  const myConflicts = $derived(S.conflicts.filter(c => c.owner === myName() || c.items.some(x => x.other.startsWith(myName() + '/'))));
  async function choose(list, allow) {
    const k = list[0].id;
    try { await decide(list.map(x => x.id), allow); } catch (e) { askErr[k] = /huddle open/.test(e.message) ? 'Open the dashboard with huddle open on your computer to decide here.' : e.message; }
  }
</script>

<aside id="side">
  {#if asks.length}
    <div id="asks"><h3>Awaiting your approval</h3>
      {#each asks as list}
        {@const t = S.board.tasks.find(y => y.id === list[0].taskId)}
        <div class="ask">
          <div class="ahead">{t && t.by && t.by !== myName() ? `${t.by}'s request` : 'A task'}: <b>{shortTitle(list[0].title, 70)}</b></div>
          <div class="small muted">Your {myTool()} stopped short of {list.length > 1 ? 'these commands' : 'this command'}. Approving runs the request again with {list.length > 1 ? 'them' : 'it'} allowed.</div>
          <ul class="acmds">{#each list as x}<li><code>{x.command}</code>{#if x.why}<span class="why">{x.why}</span>{/if}</li>{/each}</ul>
          <div class="row"><button class="primary" disabled={!canHere} onclick={() => choose(list, true)}>{list.length > 1 ? 'Approve all' : 'Approve'}</button><button disabled={!canHere} onclick={() => choose(list, false)}>{list.length > 1 ? 'Decline all' : 'Decline'}</button><span class="err">{askErr[list[0].id] || ''}</span></div>
          {#if !canHere}<div class="small muted">To decide here, open the dashboard with <code>huddle open</code> on your computer, or run <code>huddle approve --all</code>.</div>{/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if myConflicts.length}
    <h2>Merge conflicts</h2>
    {#each myConflicts as c}{#each c.items as x}
      <button class="row-item" data-nav onclick={() => go('code')}><span class="grow"><span class="path">{c.owner}/{c.branch} ↔ {x.other}</span><br><span class="small muted">{x.files.slice(0, 3).join(', ')}{x.files.length > 3 ? ` +${x.files.length - 3}` : ''}</span></span></button>
    {/each}{/each}
  {/if}
  <h2>Tasks <button class="link small" style="margin-left:auto" onclick={() => go('tasks')}>Open board</button></h2>
  {#each live as t (t.id)}
    {@const tt = titleOf(t)}
    <button class="trow {t.status}" data-nav onclick={() => go('tasks', { task: t.id })} title={tt.title}>
      <span class="dot {t.status}" aria-hidden="true"></span>
      <span class="tmain"><span class="tt">{#if tt.tag}<span class="ttag">{tt.tag}</span>{/if}{tt.title}</span>
        {#if t.status === 'blocked'}<span class="twhy">{stuckReason(t)}</span>{:else if t.status === 'doing'}<span class="tmeta"><span class="st doing">Working on it</span><span>{ago(t.updated || t.at)}</span></span>{/if}</span>
      <span class="towner">{#if t.owner}<Avatar name={t.owner} sm /><span>{dn(t.owner)}</span>{:else}<span class="faint">Unassigned</span>{/if}</span>
    </button>
  {:else}<div class="quiet">Nothing in progress.</div>{/each}
  <h2>Being edited now <span class="count">{locks.length || ''}</span></h2>
  {#each locks as l}
    <button class="row-item" data-nav onclick={() => (S.fileOpen = { path: l.path, branch: l.branch || null })}><Avatar name={l.holderName} sm /><span class="grow"><span class="path">{l.path}{#if l.dir} <span class="faint">(whole folder)</span>{/if}</span><br><span class="small muted">{l.holderName} · {ago(l.since)}{l.branch ? ' · ' + l.branch : ''}</span></span><span aria-label="locked">🔒</span></button>
  {:else}<div class="quiet">No files are locked.</div>{/each}
  <h2>Recently changed</h2>
  {#each files as f}
    <button class="row-item" data-nav onclick={() => (S.fileOpen = { path: f.path, branch: f.branch || null })}><Avatar name={f.byName} sm /><span class="grow"><span class="path">{f.path}</span><br><span class="small muted">{f.byName} · {ago(f.at)}</span></span></button>
  {:else}<div class="quiet">No recent changes.</div>{/each}
</aside>

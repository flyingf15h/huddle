<script>
  // Tasks: every task as a card in To do / In progress / Stuck / Done, filtered by person and words.
  // Drag a card to another column, or open it for details, comments, runs, checks and cost.
  import { S, go, myName, dn, people, isOwner } from '../lib/state.svelte.js';
  import { ago, statusWord, EFFORT_WORD, fmtDur } from '../lib/words.js';
  import { COLUMNS, titleOf, goalOf, waitsOn, checks, stuckReason, money, RUN_WORD, runPill, setStatus, runAgain, markDone, editTask, comment, deleteTask } from '../lib/tasks.js';
  import Avatar from '../components/Avatar.svelte';
  import Icon from '../components/Icon.svelte';

  let who = $state('all'), q = $state(''), showDone = $state(false), dragging = $state(null), over = $state(null), note = $state(''), editing = $state(false), draft = $state({});
  const team = $derived(people().map(p => p.name));
  const shown = $derived(S.board.tasks.filter(t => (who === 'all' || (who === 'mine' ? t.owner === myName() : who === 'none' ? !t.owner : t.owner === who))
    && (!q || (t.title + ' ' + (t.detail || '')).toLowerCase().includes(q.toLowerCase()))));
  const byCol = $derived(Object.fromEntries(COLUMNS.map(([k]) => [k, shown.filter(t => t.status === k).sort((a, b) => (b.updated || b.at) - (a.updated || a.at)).slice(0, k === 'done' && !showDone ? 15 : 200)])));
  const open = $derived(S.board.tasks.find(t => t.id === S.openTask) || null);
  $effect(() => { S.openTask; editing = false; note = ''; });

  function select(t) { S.openTask = S.openTask === t.id ? null : t.id; }
  function drop(col) { if (dragging && dragging.status !== col) setStatus(dragging, col); dragging = over = null; }
  function startEdit() { draft = { title: open.title, detail: open.detail || '', effort: open.effort || '', owner: open.owner || '' }; editing = true; }
  async function saveEdit() { await editTask(open, { title: draft.title, detail: draft.detail, effort: draft.effort || null, owner: draft.owner || null }); editing = false; }
  async function send() { if (!note.trim()) return; await comment(open, note.trim()); note = ''; }
  function onKey(e) {
    // with a card focused: 1-4 move it to that column
    if (e.target.dataset && e.target.dataset.task && /^[1-4]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      const t = S.board.tasks.find(x => x.id === e.target.dataset.task);
      if (t) { e.preventDefault(); setStatus(t, COLUMNS[Number(e.key) - 1][0]); }
    }
  }
</script>

<main data-main class="tview" onkeydown={onKey} role="presentation">
  <div class="tbar">
    <div class="seg sm" role="group" aria-label="Whose">
      <button class:on={who === 'all'} onclick={() => (who = 'all')}>Everyone</button>
      <button class:on={who === 'mine'} onclick={() => (who = 'mine')}>Mine</button>
      <button class:on={who === 'none'} onclick={() => (who = 'none')}>Unassigned</button>
    </div>
    <select aria-label="Person" value={['all', 'mine', 'none'].includes(who) ? '' : who} onchange={(e) => (who = e.target.value || 'all')}>
      <option value="">Anyone</option>{#each team as n}<option value={n}>{dn(n)}</option>{/each}
    </select>
    <input type="search" placeholder="Filter tasks" bind:value={q} aria-label="Filter tasks">
    <span class="grow"></span>
    <span class="small muted hide-sm">Drag cards between columns, or focus one and press 1 to 4</span>
  </div>
  <div class="tbody2" class:nodetail={!open}>
    <div class="cols">
      {#each COLUMNS as [k, label]}
        <section class="col" class:drop={over === k} aria-label={label}
          ondragover={(e) => { e.preventDefault(); over = k; }} ondragleave={() => (over = over === k ? null : over)} ondrop={(e) => { e.preventDefault(); drop(k); }}>
          <h3><span class="dot {k}" aria-hidden="true"></span>{label}<span class="count">{shown.filter(t => t.status === k).length}</span></h3>
          {#each byCol[k] as t (t.id)}
            {@const tt = titleOf(t)}
            {@const g = goalOf(t)}
            <button class="tcard" class:sel={S.openTask === t.id} data-nav data-task={t.id} draggable="true" ondragstart={() => (dragging = t)} ondragend={() => (dragging = over = null)} onclick={() => select(t)}>
              <span class="tt">{#if tt.tag}<span class="ttag">{tt.tag}</span>{/if}{tt.title}</span>
              {#if t.status === 'blocked'}<span class="twhy" style="white-space:normal">{stuckReason(t)}</span>{/if}
              {#if g && !t.direct && g.title}<span class="small faint">Part of {g.title}</span>{/if}
              <span class="tm">
                {#if t.owner}<Avatar name={t.owner} sm /><span>{dn(t.owner)}</span>{:else}<span class="faint">Unassigned</span>{/if}
                <span class="grow"></span>
                {#each checks(t).filter(c => c.tone !== 'good') as c}<span class="ck {c.tone}">{c.text}</span>{/each}
                {#if t.usage && t.usage.cost}<span title="API-equivalent cost">{money(t.usage.cost)}</span>{/if}
                <span>{ago(t.updated || t.at).replace(' ago', '')}</span>
              </span>
            </button>
          {:else}<div class="quiet" style="padding:4px 12px 12px">{k === 'blocked' ? 'Nothing stuck.' : 'None.'}</div>{/each}
          {#if k === 'done' && !showDone && shown.filter(t => t.status === 'done').length > 15}<button class="link small" style="margin:0 12px 10px" onclick={() => (showDone = true)}>Show all</button>{/if}
        </section>
      {/each}
    </div>
    {#if open}
      {@const tt = titleOf(open)}
      {@const g = goalOf(open)}
      <aside class="tdpanel" aria-label="Task details">
        <div class="row" style="margin-top:0"><span class="pill {open.status === 'done' ? 'ok' : open.status === 'blocked' ? 'bad' : open.status === 'doing' ? 'acc' : ''}">{statusWord(open.status)}</span>
          {#if open.effort}<span class="pill">{EFFORT_WORD[open.effort]} job</span>{/if}<span class="grow"></span>
          <button class="ghost iconbtn sm" aria-label="Close" onclick={() => (S.openTask = null)}><Icon name="close" size={16} /></button></div>
        {#if editing}
          <div class="fieldset">
            <div><label for="tdt">Title</label><input id="tdt" type="text" bind:value={draft.title}></div>
            <div><label for="tdd">Details</label><textarea id="tdd" bind:value={draft.detail} style="min-height:120px"></textarea></div>
            <div class="row"><label for="tdo">Owner</label><select id="tdo" bind:value={draft.owner}><option value="">Unassigned</option>{#each team as n}<option value={n}>{dn(n)}</option>{/each}</select>
              <label for="tde">Size</label><select id="tde" bind:value={draft.effort}><option value="">Not sized</option><option value="light">Small</option><option value="medium">Medium</option><option value="heavy">Big</option></select></div>
            <div class="row"><button class="primary" onclick={saveEdit}>Save</button><button onclick={() => (editing = false)}>Cancel</button></div>
          </div>
        {:else}
          <h2>{tt.title}</h2>
          <div class="small muted">Asked by {dn(open.by)} {ago(open.at)}{g && g.title && !open.direct ? ` · part of “${g.title}”` : ''}</div>
          <div class="row">
            <select aria-label="Status" value={open.status} onchange={(e) => setStatus(open, e.target.value)}>{#each COLUMNS as [k, l]}<option value={k}>{l}</option>{/each}</select>
            {#if open.status !== 'done'}<button onclick={() => runAgain(open)}>Run again</button><button onclick={() => markDone(open)}>Mark done</button>{/if}
            <button class="ghost" onclick={startEdit}>Edit</button>
          </div>
          <div class="lbl">Owner</div>
          <div class="row" style="margin:0">{#if open.owner}<Avatar name={open.owner} sm /><span>{dn(open.owner)}</span><button class="link small" onclick={() => { S.who = open.owner; go('activity'); }}>See their work</button>{:else}<span class="muted">Unassigned: the next free agent takes it</span>{/if}</div>
          {#if open.detail && open.detail.trim() !== open.title.trim()}<div class="lbl">Details</div><div class="detail">{open.detail}</div>{/if}
          {#if waitsOn(open).length}<div class="lbl">Waiting for</div>{#each waitsOn(open) as w}<button class="link" onclick={() => (S.openTask = w.id)}>{titleOf(w).title}</button><br>{/each}{/if}
          {#if open.paths && open.paths.length}<div class="lbl">Works in</div><div class="mono small">{open.paths.join(', ')}</div>{/if}
          {#if checks(open).length || (open.checks && open.checks.pr)}
            <div class="lbl">Checks</div>
            <div class="tmeta">{#each checks(open) as c}<span class="ck {c.tone}" title={c.title || ''}>{c.text}</span>{/each}</div>
            {#if open.checks && open.checks.pr}<p class="small"><a href={open.checks.pr} target="_blank" rel="noopener">{open.checks.pr.replace(/^https:\/\/github\.com\//, '')}</a> <span class="pill {open.checks.prState === 'merged' ? 'ok' : open.checks.prState === 'closed' ? 'bad' : 'acc'}">{({ open: 'Open', merged: 'Merged', closed: 'Closed' })[open.checks.prState] || 'Open'}</span></p>{/if}
          {/if}
          {#if open.usage && open.usage.tokens}<div class="lbl">Cost</div><div class="small">{money(open.usage.cost)} at API prices · {Math.round(open.usage.tokens / 1000)}k tokens</div>{/if}
          {#if open.runs && open.runs.length}
            <div class="lbl">Background runs</div>
            <div class="runs">{#each open.runs.slice(-5) as r}<div><span class="pill {runPill(r.outcome)}">{RUN_WORD[r.outcome] || r.outcome}</span><span>Attempt {r.attempt} by {r.by}'s {r.agent === 'codex' ? 'Codex' : r.agent === 'cursor' ? 'Cursor' : 'Claude'}{r.ms ? ', ' + fmtDur(r.ms) : ''}, {ago(r.at)}{r.error ? ': ' + r.error.slice(0, 160) : ''}</span></div>{/each}</div>
          {/if}
          <div class="lbl">Notes and comments</div>
          <div class="notes">
            {#each (open.notes || []).slice().reverse() as n}<div class="noteitem"><b>{dn(n.by)}</b> <span class="faint small">{ago(n.at)}</span><div style="white-space:pre-wrap">{n.text}</div></div>{:else}<div class="quiet">None yet.</div>{/each}
          </div>
          <div style="margin-top:10px"><textarea bind:value={note} placeholder="Add a comment (the owner's agent sees it next time it runs this task)" aria-label="Comment" onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}></textarea>
            <div class="row"><button class="primary" disabled={!note.trim()} onclick={send}>Comment</button><span class="grow"></span>
              {#if open.by === myName() || isOwner()}<button class="danger" onclick={() => { if (confirm('Delete this task?')) { deleteTask(open); S.openTask = null; } }}>Delete</button>{/if}</div></div>
        {/if}
      </aside>
    {/if}
  </div>
</main>

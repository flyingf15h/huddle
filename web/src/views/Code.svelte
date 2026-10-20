<script>
  // Code: a person's shared branch file by file (committed or live), the connected GitHub repository
  // (branches with checks, pull requests, commits, issues) and merge conflicts between branches.
  import { onMount, tick } from 'svelte';
  import { S, api, onLive, go, myName, isOwner } from '../lib/state.svelte.js';
  import { esc, ago } from '../lib/words.js';
  import Icon from '../components/Icon.svelte';

  let tab = $state('files');            // files | github | conflicts
  let refs = $state([]), ref = $state(null), files = $state([]), branch = $state(null), skipped = $state([]);
  let path = $state(null), content = $state(''), label = $state(''), live = $state(false), liveCopy = $state(false), hlLine = $state(0), err = $state('');
  let repo = $state(null), repoErr = $state(''), loadingRepo = $state(false), msg = $state('');
  const lockOf = (p) => Object.values(S.locks).find(l => l.path === p && (l.branch || null) === (branch || null));
  const dirs = $derived.by(() => { const out = []; let last = null; for (const f of files) { const i = f.path.lastIndexOf('/'); const d = i < 0 ? '' : f.path.slice(0, i); if (d !== last) { if (d) out.push({ dir: d }); last = d; } out.push({ f, name: f.path.slice(i + 1), indent: d ? 26 : 14 }); } return out; });
  const myConflicts = $derived(S.conflicts);

  async function loadRefs() {
    const r = await api('git-tree');
    refs = r.refs.sort((a, b) => b.at - a.at);
    if (!refs.length) { files = []; return; }
    if (!ref || !refs.some(x => x.owner + '/' + x.branch === ref)) ref = refs[0].owner + '/' + refs[0].branch;
    await loadTree();
  }
  async function loadTree() {
    const t = await api('git-tree?ref=' + encodeURIComponent(ref));
    files = t.files; branch = t.branch; skipped = t.skipped || [];
    if (!path || !files.some(f => f.path === path)) path = (files.find(f => /^readme/i.test(f.path)) || files[0] || {}).path;
    if (path) await openFile(path, false);
  }
  async function openFile(p, wantLive, line = 0) {
    path = p; hlLine = line; err = '';
    liveCopy = !!Object.values(S.files).find(f => f.path === p && (f.branch || null) === (branch || null) && f.size);
    try {
      if (wantLive && liveCopy) { const f = await api('file?path=' + encodeURIComponent(p) + (branch ? '&branch=' + encodeURIComponent(branch) : '')); content = f.content; label = `live, saved by ${f.byName} ${ago(f.at)}`; live = true; }
      else { const f = await api('git-blob?ref=' + encodeURIComponent(ref) + '&path=' + encodeURIComponent(p)); content = f.content; label = `committed on ${ref} · ${f.sha.slice(0, 7)}`; live = false; }
    } catch (e) { content = ''; err = e.message; }
    if (line) { await tick(); document.querySelector('.codebox .hl')?.scrollIntoView({ block: 'center' }); }
  }
  async function loadRepo(fresh) {
    loadingRepo = true; repoErr = '';
    try { repo = await api('repo' + (fresh ? '?fresh=1' : '')); } catch (e) { repoErr = e.message; }
    loadingRepo = false;
  }
  async function toTeam(i) { try { await api('repo-issue', { number: i.number }); msg = `Sent #${i.number} to the team.`; go('tasks'); } catch (e) { msg = e.message; } }
  async function openPr(b) { try { const r = await api('repo-pr', { head: b }); msg = `Opened #${r.pr.number}.`; loadRepo(true); } catch (e) { msg = e.message; } }
  async function resolve(c, x) { try { await api('resolve-conflicts', { key: c.owner + '/' + c.branch, other: x.other }); msg = `${c.owner}'s agent is on it.`; go('tasks'); } catch (e) { msg = e.message; } }
  const checkTone = (c) => (!c ? '' : c.state === 'failing' ? 'bad' : c.state === 'passing' ? 'ok' : 'warn');
  const checkWord = (c) => (!c ? 'no checks' : c.state === 'failing' ? `${c.failed} failing` : c.state === 'passing' ? 'passing' : 'running');

  onMount(() => {
    loadRefs().catch(() => {}); loadRepo(false);
    return onLive((ev) => {
      if (ev.type === 'git' && ev.action === 'snapshot') loadRefs().catch(() => {});
      if (ev.type === 'file' && ev.file.path === path && (ev.file.branch || null) === (branch || null) && live) openFile(path, true);
      if (ev.type === 'repo' || (ev.type === 'project-setting' && S.projectSettings.repo)) loadRepo(false);
    });
  });
  // search hands over a file or code line to open
  $effect(() => {
    const o = S.codeOpen;
    if (!o) return;
    S.codeOpen = null; tab = 'files';
    if (o.ref && o.ref !== ref) { ref = o.ref; loadTree().then(() => openFile(o.path, false, o.line)); }
    else openFile(o.path || o.file, !!o.file, o.line || 0);
  });
</script>

<main data-main class="tview">
  <div class="tbar">
    <div class="seg sm" role="tablist">
      <button role="tab" aria-selected={tab === 'files'} class:on={tab === 'files'} onclick={() => (tab = 'files')}>Files</button>
      <button role="tab" aria-selected={tab === 'github'} class:on={tab === 'github'} onclick={() => (tab = 'github')}><Icon name="github" size={14} /> GitHub{#if repo && repo.pulls && repo.pulls.length}<span class="ct">{repo.pulls.length}</span>{/if}</button>
      <button role="tab" aria-selected={tab === 'conflicts'} class:on={tab === 'conflicts'} onclick={() => (tab = 'conflicts')}>Conflicts{#if myConflicts.length}<span class="ct" style="color:var(--bad)">{myConflicts.reduce((n, c) => n + c.items.length, 0)}</span>{/if}</button>
    </div>
    {#if msg}<span class="small muted">{msg}</span>{/if}
  </div>

  {#if tab === 'files'}
    <div id="codeview" class:none={!refs.length} style="flex:1;min-height:0">
      <div id="codeside">
        <div class="ref"><label for="coderef">Branch</label>
          <select id="coderef" bind:value={ref} onchange={() => { path = null; loadTree(); }}>{#each refs as x}<option value={x.owner + '/' + x.branch}>{x.owner}'s {x.branch} · {x.count} files · {ago(x.at)}</option>{/each}</select></div>
        <div class="tree">
          {#each dirs as d}
            {#if d.dir}<div class="dir">{d.dir}/</div>
            {:else}<button data-nav class:sel={d.f.path === path} style="padding-left:{d.indent}px" title={d.f.path} onclick={() => openFile(d.f.path, false)}>{lockOf(d.f.path) ? '🔒 ' : ''}{d.name}</button>{/if}
          {/each}
          {#if skipped.length}<div class="dir">not shown (binary or large)</div>{#each skipped.slice(0, 30) as p}<div class="small muted" style="padding:1px 14px 1px 26px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{p}</div>{/each}{/if}
        </div>
      </div>
      <div id="codemain">
        {#if !refs.length}<div class="empty"><h3>No code shared yet</h3><p style="margin:0 auto;max-width:420px">Branches appear here once a teammate commits. They are shared automatically at the end of each agent turn, or manually with <code>huddle publish</code>.</p></div>
        {:else if err}<div class="empty">{err}</div>
        {:else if path}
          <div class="crumb"><b class="mono" style="font-size:14px">{path}</b><span class="small muted">{label}</span>
            {#if lockOf(path)}<span class="livebar">🔒 {lockOf(path).holderName} is editing</span>{/if}
            {#if liveCopy}<button class="small" onclick={() => openFile(path, !live)}>{live ? 'Show committed version' : 'Show live version'}</button>{/if}</div>
          <pre class="codebox">{#each content.split('\n') as l, i}<div class="ln" class:hl={i + 1 === hlLine}><span>{i + 1}</span><span>{l || ' '}</span></div>{/each}</pre>
        {/if}
      </div>
    </div>

  {:else if tab === 'github'}
    <div class="viewpad">
      {#if !S.projectSettings.repo}
        <div class="empty"><h3>Connect your GitHub repository</h3><p style="margin:0 auto;max-width:480px">See branches with their checks, open pull requests, recent commits and issues here, get updates the moment someone pushes, and open pull requests from huddle.</p>
          <div class="acts">{#if isOwner()}<button class="primary" onclick={() => { S.settingsTab = 'integrations'; go('settings'); }}>Connect a repository</button>{:else}<span class="muted">An owner can connect one in Team &amp; settings.</span>{/if}</div></div>
      {:else}
        <div class="panel"><div class="srow" style="border-top:0"><Icon name="github" /><span class="grow"><b><a href={S.projectSettings.repo.url} target="_blank" rel="noopener">{S.projectSettings.repo.full}</a></b>
            <span class="sub">{S.projectSettings.repo.private ? 'Private' : 'Public'} · default branch {S.projectSettings.repo.defaultBranch} · {S.projectSettings.repo.webhook ? 'updates arrive as people push' : (S.projectSettings.repo.webhookError || 'read every minute')}</span></span>
            <button onclick={() => loadRepo(true)} disabled={loadingRepo}>{loadingRepo ? 'Reading…' : 'Refresh'}</button></div></div>
        {#if repoErr || (repo && repo.error)}<p class="err">{repoErr || repo.error}</p>{/if}
        {#if repo && repo.pulls}
          <div class="panel"><h3>Pull requests</h3><div class="plist">
            {#each repo.pulls as p}<div class="srow"><span class="pill {checkTone(p.checks)}">{checkWord(p.checks)}</span><span class="grow"><a href={p.url} target="_blank" rel="noopener">#{p.number} {p.title}</a>{#if p.draft} <span class="pill">Draft</span>{/if}<span class="sub">{p.head} → {p.base} · {p.author} · {ago(p.updated)}</span></span></div>
            {:else}<div class="srow muted">No open pull requests.</div>{/each}</div></div>
          <div class="panel"><h3>Branches</h3><p class="pdesc">Default branch checks: <span class="pill {checkTone(repo.defaultChecks)}">{checkWord(repo.defaultChecks)}</span></p><div class="plist">
            {#each repo.branches as b}<div class="srow"><span class="grow"><span class="mono">{b.name}</span>{#if b.protected} <span class="pill">Protected</span>{/if}</span>
              {#if b.name !== S.projectSettings.repo.defaultBranch && !repo.pulls.some(p => p.head === b.name)}<button class="ghost" onclick={() => openPr(b.name)}>Open pull request</button>{/if}</div>{/each}</div></div>
          <div class="panel"><h3>Recent commits</h3><div class="plist">
            {#each repo.commits as c}<div class="srow"><span class="mono small faint">{c.sha.slice(0, 7)}</span><span class="grow"><a href={c.url} target="_blank" rel="noopener">{c.message}</a><span class="sub">{c.author} · {ago(c.at)}</span></span></div>{/each}</div></div>
          <div class="panel"><h3>Open issues</h3><p class="pdesc">Send one to the team and an agent plans and does it.</p><div class="plist">
            {#each repo.issues as i}<div class="srow"><span class="grow"><a href={i.url} target="_blank" rel="noopener">#{i.number} {i.title}</a><span class="sub">{i.author} · {ago(i.updated)}{i.labels.length ? ' · ' + i.labels.join(', ') : ''}</span></span><button onclick={() => toTeam(i)}>Send to team</button></div>
            {:else}<div class="srow muted">No open issues.</div>{/each}</div></div>
        {/if}
      {/if}
    </div>

  {:else}
    <div class="viewpad">
      <p class="muted" style="margin-top:0;max-width:640px">Each person's huddle checks, after teammates share new commits, whether merging their branch into yours would conflict, without touching your files.</p>
      {#each myConflicts as c}{#each c.items as x}
        <div class="panel"><div class="srow" style="border-top:0;flex-wrap:wrap"><Icon name="conflict" /><span class="grow"><b>{c.owner}/{c.branch}</b> ↔ <b>{x.other}</b><span class="sub">{ago(c.at)} · {x.files.length} file{x.files.length === 1 ? '' : 's'} changed on both sides</span></span>
          <button class="primary" data-nav onclick={() => resolve(c, x)}>Resolve with {c.owner === myName() ? 'my agent' : c.owner + "'s agent"}</button></div>
          <div class="pbody"><ul style="margin:0;padding-left:20px">{#each x.files as f}<li class="mono small">{f}</li>{/each}</ul>
          <p class="small muted" style="margin-bottom:0">Or run <code>huddle merge {x.other}</code> yourself and ask your agent to settle the conflict markers.</p></div></div>
      {:else}<div class="empty"><h3>No conflicts</h3><p style="margin:0 auto;max-width:420px">Nobody's shared branch conflicts with another's right now.</p></div>{/each}{/each}
    </div>
  {/if}
</main>

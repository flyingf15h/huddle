<script>
  // A live shared file, updated as its holder edits it; changed lines are highlighted.
  import { S, api, onLive } from '../lib/state.svelte.js';
  import { ago } from '../lib/words.js';
  let f = $state(null), lines = $state([]), hl = $state([-1, -1]), error = $state(''), dlg;
  async function load(highlight) {
    const o = S.fileOpen;
    if (!o) return;
    try {
      const r = await api('file?path=' + encodeURIComponent(o.path) + (o.branch ? '&branch=' + encodeURIComponent(o.branch) : ''));
      const old = highlight && f ? f.content.split('\n') : null;
      const now = r.content.split('\n');
      if (old) { let a = 0, b = 0; while (a < now.length && a < old.length && now[a] === old[a]) a++; while (b < now.length - a && b < old.length - a && now[now.length - 1 - b] === old[old.length - 1 - b]) b++; hl = [a, now.length - b]; }
      f = r; lines = now; error = '';
    } catch { f = null; lines = []; error = 'No live copy of this file yet. It appears here once someone edits it with their agent.'; }
  }
  $effect(() => { if (S.fileOpen) { f = null; hl = [-1, -1]; load(false); if (!dlg.open) dlg.showModal(); } else if (dlg && dlg.open) dlg.close(); });
  $effect(() => onLive((ev) => { if (ev.type === 'file' && S.fileOpen && ev.file.path === S.fileOpen.path && (ev.file.branch || null) === (S.fileOpen.branch || null)) load(true); }));
</script>
<dialog bind:this={dlg} onclose={() => (S.fileOpen = null)} onclick={(e) => { if (e.target === dlg) dlg.close(); }}>
  <div class="dlg-head"><h3 class="mono">{S.fileOpen ? S.fileOpen.path : ''}</h3><span class="grow"></span>
    <span class="small muted">{#if f}v{f.version} · saved by {f.byName} {ago(f.at)}{f.lock ? ' · 🔒 ' + f.lock.holderName + ' is editing' : ''}{f.branch ? ' · ⎇ ' + f.branch : ''}{/if}</span>
    <button onclick={() => dlg.close()}>Close</button></div>
  <div class="dlg-body">{#if error}<div style="padding:12px">{error}</div>{:else}<pre class="codebox">{#each lines as l, i}<div class="ln" class:hl={i >= hl[0] && i < hl[1]}><span>{i + 1}</span><span>{l || ' '}</span></div>{/each}</pre>{/if}</div>
</dialog>

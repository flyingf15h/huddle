<script>
  import { S, go, readNotes } from '../lib/state.svelte.js';
  function open(t) { S.toasts = S.toasts.filter(x => x.id !== t.id); readNotes([t.id]); const l = t.link || {}; if (l.url) window.open(l.url, '_blank', 'noopener'); else go(l.view || 'activity', l.task ? { task: l.task } : {}); }
</script>
{#if S.toasts.length}
  <div id="toasts" role="status">
    {#each S.toasts as t (t.id)}<button class="toast" onclick={() => open(t)}><b>{t.title}</b><span>{t.body}</span></button>{/each}
  </div>
{/if}

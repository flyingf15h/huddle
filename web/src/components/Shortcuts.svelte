<script>
  import { S } from '../lib/state.svelte.js';
  import { SHORTCUTS } from '../lib/keys.js';
</script>
<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) S.shortcuts = false; }}>
  <div class="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
    <h3>Keyboard shortcuts</h3>
    <div class="sclist">{#each SHORTCUTS as [k, d]}<span>{#each k.split(' ') as part}<span class="kbdk">{part}</span> {/each}</span><span>{d}</span>{/each}</div>
    <p style="margin:16px 0 0;text-align:right"><button onclick={() => (S.shortcuts = false)}>Close</button></p>
  </div>
</div>

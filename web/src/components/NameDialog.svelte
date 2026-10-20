<script>
  // A dashboard visitor without a name picks one before sending anything.
  import { auth, setName } from '../lib/state.svelte.js';
  let v = $state(auth.name);
</script>
{#if !auth.name}
  <div class="overlay" role="presentation">
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Your name"><form onsubmit={(e) => { e.preventDefault(); setName(v); }}>
      <h3>Your name</h3>
      <p class="muted" style="margin-top:0">Use the name you joined with, so your agent's work shows up as yours.</p>
      <input bind:value={v} style="width:100%" autocomplete="name" aria-label="Your name">
      <p style="text-align:right;margin-bottom:0"><button class="primary" type="submit">Save</button></p>
    </form></div>
  </div>
{/if}

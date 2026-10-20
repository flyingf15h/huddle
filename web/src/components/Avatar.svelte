<script>
  // A person's picture if they set one, else their initial on their colour. bot: their agent.
  import { S } from '../lib/state.svelte.js';
  import { color } from '../lib/words.js';
  let { name = '', sm = false, big = false, busy = false, bot = false, settings = null } = $props();
  const st = $derived((settings || S.settings)[name] || {});
  const pal = $derived(color(name));
</script>
{#if bot}
  <span class="av bot" class:sm aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2.5l1.9 6.1 6.1 1.9-6.1 1.9L12 18.5l-1.9-6.1-6.1-1.9 6.1-1.9zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg></span>
{:else if st.avatar}
  <span class="av has-img" class:sm class:big class:busy aria-hidden="true"><img src={st.avatar} alt=""></span>
{:else}
  <span class="av" class:sm class:big class:busy style="background:{pal[0]};color:{pal[1]}" aria-hidden="true">{String(st.displayName || name || '?')[0].toUpperCase()}</span>
{/if}

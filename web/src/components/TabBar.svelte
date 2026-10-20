<script>
  // Phones: the main pages along the bottom; the rest are in the drawer.
  import { S, go, myName } from '../lib/state.svelte.js';
  import Icon from './Icon.svelte';
  const TABS = [['activity', 'Activity'], ['tasks', 'Tasks'], ['code', 'Code'], ['usage', 'Usage']];
  const mine = $derived(S.board.tasks.filter(t => t.status === 'blocked' || (t.owner === myName() && t.status !== 'done')).length);
</script>
<nav class="tabbar" aria-label="Pages">
  {#each TABS as [v, l]}
    <button class:on={S.view === v} aria-current={S.view === v ? 'page' : undefined} onclick={() => go(v)}><Icon name={v} size={20} /><span>{l}</span>{#if v === 'tasks' && mine}<span class="navbadge" style="background:var(--accent)">{mine}</span>{/if}</button>
  {/each}
  <button onclick={() => (S.drawer = true)}><Icon name="menu" size={20} /><span>More</span></button>
</nav>

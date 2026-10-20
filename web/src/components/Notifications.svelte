<script>
  // The bell: this person's notifications from the server (the same list email and desktop alerts come from).
  import { S, go, readNotes, api } from '../lib/state.svelte.js';
  import { ago, store } from '../lib/words.js';
  let { close } = $props();
  let dnd = $state(store.get('huddle.dnd') === '1');
  let perm = $state('Notification' in window ? Notification.permission : 'unsupported');
  const list = $derived(S.notes.slice().reverse());
  function open(n) {
    readNotes([n.id]);
    close();
    const l = n.link || {};
    if (l.url) window.open(l.url, '_blank', 'noopener');
    else go(l.view === 'tasks' ? 'tasks' : l.view || 'activity', l.task ? { task: l.task } : {});
  }
  function setDnd(v) { dnd = v; store.set('huddle.dnd', v ? '1' : '0'); }
  async function ask() { try { perm = await Notification.requestPermission(); } catch {} }
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }
</script>

<svelte:window onkeydown={onKey} />
<div class="menu npanel" role="menu" style="position:absolute;top:44px;right:0">
  <div class="nhead"><b>Notifications</b><button class="link small" disabled={!S.notes.some(n => !n.read)} onclick={() => readNotes()}>Mark all as read</button></div>
  <div class="nmode"><span>Status</span><div class="seg sm" role="group" aria-label="Status"><button class:on={!dnd} onclick={() => setDnd(false)}>Active</button><button class:on={dnd} onclick={() => setDnd(true)}>Do not disturb</button></div></div>
  <div class="nlist">
    {#each list as n (n.id)}
      <button class="nitem" class:unread={!n.read} data-nav onclick={() => open(n)}><span class="ndot"></span><span class="nb"><span class="nt"><b>{n.title}</b><time>{ago(n.at)}</time></span><span class="nx">{n.body}</span></span></button>
    {:else}
      <div class="nempty">Nothing yet. Messages to you, requests for your agent, approvals, stuck work and conflicts show up here.</div>
    {/each}
  </div>
  <div class="nfoot">
    <span>{perm === 'granted' ? 'Desktop alerts are on.' : perm === 'denied' ? 'Desktop alerts are blocked in your browser.' : perm === 'default' ? 'Desktop alerts are off.' : 'No desktop alerts in this browser.'}
      {S.contact && S.contact.email ? `Email: ${S.contact.email}.` : ''}</span>
    {#if perm === 'default'}<button class="small" onclick={ask}>Turn on</button>{/if}
    <button class="link small" onclick={() => { close(); S.settingsTab = 'notify'; go('settings'); }}>Settings</button>
  </div>
</div>

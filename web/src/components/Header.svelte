<script>
  // Page title, feed filters (Activity only), search, connection, notifications, theme and invite.
  import { S } from '../lib/state.svelte.js';
  import { store } from '../lib/words.js';
  import Icon from './Icon.svelte';
  import Notifications from './Notifications.svelte';
  let { dark, flipTheme } = $props();
  const TITLES = { activity: 'Activity', tasks: 'Tasks', code: 'Code', brief: 'Brief & memory', usage: 'Usage & cost', health: 'Health', settings: 'Team & settings' };
  const DESC = { tasks: 'Every request and task, who has it and how far along it is', brief: "Shared memory files between your team's agents", code: "Everyone's shared branches, the GitHub repository and conflicts",
    usage: 'Agent usage and what it would cost at API prices', health: "Whether huddle is working on everyone's computer", settings: 'People, access, rules, integrations and data' };
  let notesOpen = $state(false);
  const unread = $derived(S.notes.filter(n => !n.read).length);
  const dnd = $derived(store.get('huddle.dnd') === '1' && notesOpen !== null);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
</script>

<header>
  <button class="ghost iconbtn menubtn" aria-label="Open the menu" onclick={() => (S.drawer = true)}><Icon name="menu" /></button>
  <h1>{TITLES[S.view]}</h1>
  <span class="vdesc">{DESC[S.view] || ''}</span>
  {#if S.view === 'activity'}
    <div id="filters" class="seg sm" role="group" aria-label="Show">
      {#each [['all', 'Everything', 'Every prompt, step, reply, message and file change'], ['key', 'Highlights', 'Requests, prompts, replies, messages and hand-offs'], ['talk', 'Messages', 'Only messages and requests']] as [k, l, t]}
        <button class:on={S.filter === k} title={t} onclick={() => (S.filter = k)}>{l}</button>
      {/each}
    </div>
    {#if S.who}<span class="small muted">only <b>{S.who}</b> · <button class="link" onclick={() => (S.who = null)}>everyone</button></span>{/if}
  {/if}
  <span class="grow"></span>
  <button class="searchbtn" onclick={() => (S.search = true)} aria-label="Search the project"><Icon name="search" size={16} /><span class="label">Search</span><span class="kbdk">{mac ? '⌘K' : 'Ctrl K'}</span></button>
  <span class="conn" class:live={S.conn === 'live'}>{S.conn === 'live' ? 'Live' : S.conn === 'connecting' ? 'Connecting' : 'Reconnecting…'}</span>
  <div class="headbtns" style="position:relative">
    <button class="ghost iconbtn" id="btn-notify" aria-haspopup="menu" aria-expanded={notesOpen} aria-label="Notifications{unread ? ` (${unread} unread)` : ''}" onclick={() => (notesOpen = !notesOpen)}>
      <Icon name={dnd ? 'belloff' : 'bell'} size={19} />{#if unread}<span class="nbadge">{unread > 99 ? '99+' : unread}</span>{/if}
    </button>
    {#if notesOpen}<Notifications close={() => (notesOpen = false)} />{/if}
    <button class="ghost iconbtn hide-sm" aria-label={dark ? 'Switch to light' : 'Switch to dark'} title={dark ? 'Switch to light' : 'Switch to dark'} onclick={flipTheme}><Icon name={dark ? 'sun' : 'moon'} size={19} /></button>
    <button class="ghost iconbtn hide-sm" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onclick={() => (S.shortcuts = true)}><Icon name="keyboard" size={19} /></button>
    <button class="ghost iconbtn hide-sm" aria-label="How huddle works" title="How huddle works" onclick={() => (S.help = true)}><Icon name="help" size={19} /></button>
    <button class="hide-sm" onclick={() => (S.invite = true)}>Invite people</button>
  </div>
</header>

<script>
  // The app: the home screen (projects, sign in, join) or one project (sidebar, header, the current
  // view, and the overlays that work everywhere).
  import { onMount } from 'svelte';
  import { S, auth, boot, go, VIEWS } from './lib/state.svelte.js';
  import { installKeys } from './lib/keys.js';
  import { water } from './lib/water.js';
  import { store } from './lib/words.js';
  import Home from './Home.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import Header from './components/Header.svelte';
  import TabBar from './components/TabBar.svelte';
  import Search from './components/Search.svelte';
  import Shortcuts from './components/Shortcuts.svelte';
  import Toasts from './components/Toasts.svelte';
  import NameDialog from './components/NameDialog.svelte';
  import Activity from './views/Activity.svelte';
  import Tasks from './views/Tasks.svelte';
  import Code from './views/Code.svelte';
  import Brief from './views/Brief.svelte';
  import Usage from './views/Usage.svelte';
  import Health from './views/Health.svelte';
  import Settings from './views/Settings.svelte';
  import Profile from './components/Profile.svelte';
  import InviteDialog from './components/InviteDialog.svelte';
  import Help from './components/Help.svelte';
  import { stopDemo } from './lib/demo.js';
  import { goHome } from './lib/state.svelte.js';

  let screen = $state('loading');
  let composer = $state(null);   // the Activity view hands its composer's focus() up here

  // theme: follows the computer until the person picks one
  const darkQuery = matchMedia('(prefers-color-scheme: dark)');
  let theme = $state(store.get('huddle.theme') === 'cream' ? 'light' : store.get('huddle.theme'));
  const isDark = () => theme === 'dark' || (theme !== 'light' && darkQuery.matches);
  function applyTheme() {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    water.set(isDark());
  }
  function flipTheme() { theme = isDark() ? 'light' : 'dark'; store.set('huddle.theme', theme); applyTheme(); }

  onMount(() => {
    applyTheme();
    darkQuery.addEventListener('change', applyTheme);
    const off = installKeys({ focusComposer: () => { if (S.view !== 'activity') go('activity'); setTimeout(() => composer && composer(), 0); } });
    boot().then(s => { screen = s; if (s === 'project' && auth.name && !store.get('huddle.helpSeen')) S.help = true; });
    // another invite or #p= pasted into this tab only changes the hash
    const onHash = () => { const p = new URLSearchParams(location.hash.slice(1)); if (p.get('invite') || (p.get('p') && p.get('p') !== auth.project)) location.reload(); };
    addEventListener('hashchange', onHash);
    return () => { off(); removeEventListener('hashchange', onHash); };
  });
</script>

{#if screen === 'loading'}
  <div class="empty" style="padding-top:20vh">Loading…</div>
{:else if screen === 'home' || S.fatal && !auth.project}
  <Home />
{:else}
  <div id="app">
    <Sidebar />
    {#if S.drawer}<button class="scrim" aria-label="Close the menu" onclick={() => (S.drawer = false)}></button>{/if}
    <div class="maincol">
      <Header dark={isDark()} {flipTheme} />
      {#if S.demo}<div id="demobar" role="status"><b>Demo project.</b><span class="grow">maya, dev and sam are simulated teammates (Claude Code, Codex and Cursor). Click around: nothing here touches a real codebase.</span><button onclick={() => { stopDemo(); goHome(); }}>Leave demo</button></div>{/if}
      {#if S.fatal}<div id="catchup" role="alert"><span class="grow">{S.fatal}</span></div>{/if}
      {#if S.catchup}<div id="catchup" role="status"><span class="grow">{S.catchup}</span><button aria-label="Dismiss" onclick={() => (S.catchup = '')}>×</button></div>{/if}
      {#if S.view === 'activity'}<Activity bind:focusComposer={composer} />
      {:else if S.view === 'tasks'}<Tasks />
      {:else if S.view === 'code'}<Code />
      {:else if S.view === 'brief'}<Brief />
      {:else if S.view === 'usage'}<Usage />
      {:else if S.view === 'health'}<Health />
      {:else}<Settings />{/if}
    </div>
    <TabBar />
  </div>
  <NameDialog /><Profile /><InviteDialog />
{/if}
{#if S.search}<Search />{/if}
{#if S.shortcuts}<Shortcuts />{/if}
<Help />
<Toasts />

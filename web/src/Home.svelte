<script>
  // Home: the projects this browser and account know, sign in (email code or GitHub), join with an invite.
  import { onMount } from 'svelte';
  import { S, auth, known, decodeInvite, lookUpInvite, SHORT_INVITE, startProject, openProject, forgetProject, prettyProject, loadAccount } from './lib/state.svelte.js';
  import { store } from './lib/words.js';
  import Avatar from './components/Avatar.svelte';
  import Icon from './components/Icon.svelte';

  let infos = $state({}), invite = $state(''), name = $state(auth.name), err = $state(S.fatal), busy = $state(false);
  let email = $state(''), code = $state(''), sent = $state(false), signErr = $state(''), devCode = $state('');
  const names = $derived(Object.keys(known));

  async function info(n) {
    const get = (ep) => fetch(`/api/p/${encodeURIComponent(n)}/${ep}`, { headers: { authorization: 'Bearer ' + known[n] } }).then(r => { if (r.status === 401) throw new Error('gone'); return r.json(); });
    try { const [state, board] = await Promise.all([get('state'), get('board').catch(() => null)]); infos[n] = { state, board }; } catch { infos[n] = null; }
  }
  onMount(() => { for (const n of names) info(n); });

  async function join(e) {
    e.preventDefault();
    const typed = invite.trim();
    const short = (/[#&]invite=([\w-]+)/.exec(typed) || [])[1] || typed.split(/\s+/).find(w => SHORT_INVITE.test(w));
    busy = true; err = '';
    try {
      let inv = decodeInvite(typed);
      if (!inv && short) inv = await lookUpInvite(short, name.trim());
      if (!inv) throw new Error("That doesn't look like an invite code.");
      Object.assign(auth, inv);
      if (name.trim()) { auth.name = name.trim().replace(/\s+/g, '-'); store.set('huddle.name', auth.name); }
      if (await startProject() === 'project') location.reload();
      else err = S.fatal;
    } catch (e2) { err = e2.message; }
    busy = false;
  }
  async function sendCode(e) {
    e.preventDefault(); signErr = '';
    const r = await fetch('/auth/email/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, next: '/app' }) }).then(x => x.json().then(j => ({ ok: x.ok, ...j })));
    if (!r.ok) return (signErr = r.error);
    sent = true; devCode = r.dev ? r.dev.code : '';
  }
  async function checkCode(e) {
    e.preventDefault(); signErr = '';
    const r = await fetch('/auth/email/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) }).then(x => x.json().then(j => ({ ok: x.ok, ...j })));
    if (!r.ok) return (signErr = r.error);
    await loadAccount();
    location.reload();
  }
  async function demo() { busy = true; try { await (await import('./lib/demo.js')).openDemo((t) => (err = t)); } catch (e) { err = "Couldn't set up the demo: " + e.message; } busy = false; }
  const online = (i) => i ? [...new Set(i.state.agents.filter(a => a.online && a.kind !== 'human').map(a => a.name))].length : 0;
</script>

<div id="login" data-main>
  <div class="hhead"><div class="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="var(--accent)"/><circle cx="11" cy="13" r="4.2" fill="var(--raised)"/><circle cx="21" cy="13" r="4.2" fill="var(--raised)" opacity=".85"/><circle cx="16" cy="21" r="4.2" fill="var(--raised)" opacity=".7"/></svg>huddle</div>
    <span class="grow"></span>
    {#if S.account.user}<span class="small muted">Signed in as <b>{S.account.user.email || S.account.user.login}</b> · <a href="/auth/logout">Sign out</a></span>{/if}
    <a class="small muted" href="/?about">About</a></div>
  {#if S.demoStatus}<div class="muted" role="status">{S.demoStatus}</div>{/if}
  {#if err || S.fatal}<div class="err" role="alert">{err || S.fatal}</div>{/if}
  <section>
    <h1 class="htitle">Your projects</h1>
    <div class="hgrid">
      {#each names as n (n)}
        {@const i = infos[n]}
        <div class="pcard" style="padding:0">
          <button class="ghost" data-nav style="all:unset;cursor:pointer;display:flex;flex-direction:column;gap:10px;padding:16px;flex:1" onclick={() => openProject(n)}>
            <span class="pt"><Avatar name={prettyProject(n)} sm /><span>{prettyProject(n)}</span>{#if store.get('huddle.demo.' + n)}<span class="pill acc">Demo</span>{/if}</span>
            <span class="pm">{#if i === null}<span class="err">Your access to this project ended</span>{:else if !i}Loading…{:else}
              <span>{#if online(i)}<b style="color:var(--ok)">{online(i)} online</b>{:else}Nobody online{/if}</span>
              <span>{i.board ? i.board.tasks.filter(t => t.status !== 'done').length : 0} open tasks</span>
              {#if i.board && i.board.tasks.some(t => t.status === 'blocked')}<span style="color:var(--bad)">{i.board.tasks.filter(t => t.status === 'blocked').length} stuck</span>{/if}{/if}</span>
          </button>
          <button class="pforget" aria-label="Remove {prettyProject(n)} from this list" title="Remove from this list" onclick={() => { forgetProject(n); delete infos[n]; location.reload(); }}>×</button>
        </div>
      {:else}<div class="hempty">No projects yet. Join one with an invite below{S.account.user ? '' : ', or sign in to see the ones on your account'}.</div>{/each}
    </div>
  </section>
  <div class="hcols">
    <form class="hcard" onsubmit={join}>
      <h2>Join a project</h2>
      <p class="muted">Paste the invite code or link someone sent you.</p>
      <input bind:value={invite} placeholder="Invite code" autocomplete="off" aria-label="Invite code">
      <input bind:value={name} placeholder="Your name" autocomplete="name" aria-label="Your name">
      <div class="lrow"><button class="primary" disabled={busy}>Open project</button></div>
    </form>
    {#if !S.account.user && (S.account.email || S.account.github)}
      <div class="hcard">
        <h2>Sign in</h2>
        <p class="muted">Your projects follow you to any browser, and you can get notifications by email.</p>
        {#if S.account.email}
          {#if !sent}
            <form onsubmit={sendCode} style="display:flex;gap:8px"><input type="email" bind:value={email} placeholder="you@example.com" autocomplete="email" aria-label="Email" required style="flex:1"><button class="primary">Email me a code</button></form>
          {:else}
            <form onsubmit={checkCode} style="display:flex;gap:8px"><input bind:value={code} inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code" aria-label="Code from the email" style="flex:1"><button class="primary">Sign in</button></form>
            <p class="small muted" style="margin:0">Sent to {email}. Or click the link in the email. {#if devCode}(Local server, no mail set up: the code is {devCode}.){/if} <button class="link" onclick={() => (sent = false)}>Use another email</button></p>
          {/if}
        {/if}
        {#if S.account.email && S.account.github}<div class="lor"><span>or</span></div>{/if}
        {#if S.account.github}<a class="ghbtn" href="/auth/github/login?next=/app"><Icon name="github" size={16} />Sign in with GitHub</a>{/if}
        {#if signErr}<p class="err small" style="margin:0">{signErr}</p>{/if}
      </div>
    {/if}
    <div class="hcard">
      <h2>Start your own</h2>
      <p class="muted">In your project's folder, run:</p>
      <div class="cmd"><code>npx -y github:flyingf15h/huddle new</code></div>
      <button disabled={busy} onclick={demo}>Try a demo project</button>
    </div>
  </div>
</div>

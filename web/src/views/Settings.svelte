<script>
  // Team & settings: people and access, rules, integrations (GitHub), notifications, data, audit log.
  import { onMount } from 'svelte';
  import { S, auth, known, saveKnown, api, loadMe, loadNotes, isOwner, myName, dn, prettyProject, forgetProject, goHome } from '../lib/state.svelte.js';
  import { ago, store } from '../lib/words.js';
  import Avatar from '../components/Avatar.svelte';
  import Icon from '../components/Icon.svelte';

  const TABS = [['team', 'Team & access'], ['rules', 'Rules'], ['integrations', 'Integrations'], ['notify', 'Notifications'], ['data', 'Data & privacy'], ['audit', 'Audit log']];
  const ROLE = { owner: 'Owner', member: 'Member', viewer: 'Viewer' };
  const KINDS = { approval: 'Needs approval', stuck: 'Task stuck', done: 'Request done', failed: 'Something failed', member: 'Someone joined', budget: 'Budget alert' };
  let tab = $state(S.settingsTab || 'team'), members = $state([]), invites = $state([]), audit = $state([]), afilter = $state('all'), msg = $state({}), loading = $state(true);
  let pol = $state({ allow: '', deny: '', priv: '', sharing: 'full', delivery: 'merge', test: '' });
  let nUrl = $state(''), nEvents = $state(Object.fromEntries(Object.keys(KINDS).map(k => [k, k !== 'done']))), repoText = $state(''), repoToken = $state('');
  let ret = $state({ activityDays: '', messageDays: '', auditDays: '', taskDays: '' }), delName = $state('');
  const ps = $derived(S.projectSettings || {});
  const say = (k, t, bad) => { msg[k] = { t, bad }; };
  const run = (k, fn) => async () => { say(k, ''); try { await fn(); } catch (e) { say(k, "Couldn't save: " + e.message, true); } };

  $effect(() => { if (S.settingsTab) { tab = S.settingsTab; S.settingsTab = null; } });
  $effect(() => { tab; loadTab(); });
  $effect(() => {   // rules mirror what the server has, until the person edits
    const p = ps.policy || {};
    pol = { allow: (p.allow || []).join('\n'), deny: (p.deny || []).join('\n'), priv: (ps.privatePaths || ['.env', '.env.*', '**/.env', '**/.env.*', '.dev.vars', '*.pem', '*.key', 'secrets/']).join('\n'), sharing: ps.maxSharing || 'full', delivery: ps.delivery || 'merge', test: ps.testCommand || '' };
    const r = ps.retention || {};
    ret = { activityDays: r.activityDays || '', messageDays: r.messageDays || '', auditDays: r.auditDays || '', taskDays: r.taskDays || '' };
  });
  async function loadTab() {
    loading = true;
    try {
      await loadMe();
      if (tab === 'team' && S.me.accounts) { members = (await api('members')).members; invites = isOwner() ? (await api('invites')).invites : []; }
      if (tab === 'audit' && S.me.role !== 'viewer') audit = (await api('audit?limit=300')).audit;
      if (tab === 'notify') await loadNotes();
    } catch (e) { say('load', e.message, true); }
    loading = false;
  }

  // ---- team ----
  async function setup() { const r = await api('setup-owner', {}); auth.token = r.token; known[auth.project] = r.token; saveKnown(); await loadTab(); }
  const setRole = async (name, role) => { await api('member-role', { name, role }); await loadTab(); };
  const removeMember = async (name) => { if (confirm(`Remove ${name} from the project? Their access stops right away.`)) { await api('member-remove', { name }); await loadTab(); } };
  const revoke = async (id) => { await api('invite-revoke', { id }); await loadTab(); };
  async function toggle(key, on) {
    if (key === 'sharedToken' && !on && !confirm('Switch the shared invite off? Anyone still using it (including their agents) loses access until they join with a personal invite.')) return;
    await api('project-setting', { [key]: on }); await loadMe();
  }
  const linkAccount = run('acct', async () => { await api('link-account', {}); say('acct', 'Linked. This project now opens from your account, and you get its notifications by email.'); await loadTab(); });
  const iAmDemo = () => !!store.get('huddle.demo.' + auth.project);
  const soleOwner = $derived(S.me.accounts && S.me.via === 'member' && isOwner() && members.length > 1 && members.filter(m => m.role === 'owner').length < 2);
  async function leave() {
    if (!confirm(`Leave ${prettyProject(auth.project)}?`)) return;
    try { if (!iAmDemo()) await api('leave', {}); forgetProject(auth.project); goHome(); } catch (e) { say('leave', e.message, true); }
  }

  // ---- rules ----
  const lines = (t) => t.split('\n').map(x => x.trim()).filter(Boolean);
  const saveRules = run('rules', async () => {
    await api('policy', { allow: lines(pol.allow), deny: lines(pol.deny), privatePaths: lines(pol.priv), maxSharing: pol.sharing });
    await api('project-setting', { delivery: pol.delivery, testCommand: pol.test.trim() });
    say('rules', "Saved. Everyone's agents pick the rules up on their next prompt.");
  });

  // ---- integrations ----
  const connect = run('repo', async () => { const r = await api('repo-connect', { repo: repoText, token: repoToken.trim() || undefined }); repoText = repoToken = ''; say('repo', r.repo.webhook ? `Connected ${r.repo.full}, with a webhook.` : `Connected ${r.repo.full}. ${r.repo.webhookError || ''}`); });
  const disconnect = run('repo', async () => { if (confirm('Disconnect the repository? Branches, pull requests and checks stop showing.')) { await api('repo-disconnect', {}); say('repo', 'Disconnected.'); } });
  const ghLink = (scope) => `/auth/github/login?${scope ? 'scope=repo&' : ''}next=${encodeURIComponent('/app#p=' + auth.project + '&v=settings')}`;

  // ---- notifications ----
  const setPref = async (kind, how, on) => { try { const r = await api('note-prefs', { prefs: { [kind]: { [how]: on } } }); S.notePrefs = r.prefs; } catch (e) { say('prefs', e.message, true); } };
  const setEmailNotes = async (on) => { await api('note-prefs', { emailNotes: on }); await loadNotes(); };
  const addChannel = run('chan', async () => { const r = await api('notify-set', { url: nUrl.trim(), events: Object.keys(nEvents).filter(k => nEvents[k]) }); S.projectSettings.notify = r.notify; nUrl = ''; });
  const testChannel = run('chan', async () => { const r = await api('notify-test', {}); say('chan', `Sent to ${r.sent} channel${r.sent === 1 ? '' : 's'}.`); });

  // ---- data ----
  async function download(ep, name) { const j = await api(ep); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: 'application/json' })); a.download = name; a.click(); URL.revokeObjectURL(a.href); }
  const saveRetention = run('ret', async () => { await api('retention', ret); say('ret', 'Saved. Older items are removed now and as time goes on.'); });
  const eraseMe = run('erase', async () => { if (!confirm('Erase your prompts, replies, messages and usage from this project? Tasks you asked for stay.')) return; const r = await api('erase-me', {}); say('erase', `Erased ${r.activity} activity items and ${r.messages} messages.`); });
  const deleteProject = run('del', async () => { await api('delete-project', { confirm: delName }); forgetProject(auth.project); goHome(); });
  const deleteAccount = async () => { if (!confirm('Delete your huddle account? Projects keep the work you did in them.')) return; await fetch('/api/me/delete', { method: 'POST' }); location.href = '/'; };
  const groupOf = (e) => e.action === 'command' ? 'commands' : ['owner', 'invite', 'invite-revoke', 'join', 'remove', 'role', 'github', 'account'].includes(e.action) ? 'access' : 'changes';
  const auditRows = $derived(audit.filter(e => afilter === 'all' || groupOf(e) === afilter).reverse());
  const owner = $derived(isOwner());
</script>

{#snippet toggleRow(first, label, sub, key, on)}
  <div class="switchrow" style={first ? 'border-top:0' : ''}><span class="grow"><b>{label}</b><span>{sub}</span></span>
    <button class="toggle" role="switch" aria-checked={!!on} aria-label={label} disabled={!owner} onclick={() => toggle(key, !on)}></button></div>
{/snippet}

<main data-main style="display:flex;flex-direction:column;min-height:0;flex:1">
  <div class="pageview">
    <div class="seg ptabs" role="tablist" style="flex-wrap:wrap">{#each TABS as [k, l]}<button role="tab" aria-selected={tab === k} class:on={tab === k} onclick={() => (tab = k)}>{l}</button>{/each}</div>
    {#if msg.load}<p class="err">{msg.load.t}</p>{/if}

    {#if tab === 'team'}
      {#if !S.me.accounts}
        <div class="panel"><h3>Personal access</h3><p class="pdesc">Right now everyone joins with one shared invite, and anyone who has it is in. Set up accounts to give each person their own access with a role (owner, member or viewer) that you can change or take back at any time.</p>
          <div class="pbody"><button class="primary" onclick={run('setup', setup)}>Set up accounts</button> <span class="small muted" style="margin-left:8px">You become the owner. Everyone else keeps working until you switch the shared invite off.</span> <span class="err small">{msg.setup && msg.setup.t}</span></div></div>
      {:else}
        <div class="panel"><h3>People</h3><p class="pdesc">Removing someone stops their access at once, including any agent sessions they have open.</p>
          <div class="plist">{#each members as m (m.name)}<div class="srow"><Avatar name={m.name} sm /><span class="grow"><b>{dn(m.name)}</b>{#if m.name === S.me.name} <span class="muted">(you)</span>{/if}<span class="sub">{m.github ? 'GitHub ' + m.github + ' · ' : ''}{m.lastSeen ? 'active ' + ago(m.lastSeen) : 'not seen yet'}</span></span>
            {#if owner}<select aria-label="Role for {m.name}" value={m.role} onchange={(e) => setRole(m.name, e.target.value)}>{#each Object.entries(ROLE) as [r, l]}<option value={r}>{l}</option>{/each}</select>{#if m.name !== S.me.name}<button class="ghost" onclick={() => removeMember(m.name)}>Remove</button>{/if}{:else}<span class="pill">{ROLE[m.role]}</span>{/if}
            {#if m.name === S.me.name}<button class="ghost" onclick={() => (S.profile = true)}>Edit profile</button>{/if}</div>{/each}</div></div>
        {#if owner}
          <div class="panel"><h3>Open invites</h3><p class="pdesc">Each personal invite works for one person (unless you made it for more) and expires after a week.</p>
            <div class="plist">{#each invites as i}<div class="srow"><span class="pill">{ROLE[i.role]}</span><span class="grow">{i.maxUses - i.uses} use{i.maxUses - i.uses === 1 ? '' : 's'} left<span class="sub">made by {i.by} {ago(i.at)} · expires {new Date(i.expires).toLocaleDateString()}</span></span><button class="ghost" onclick={() => revoke(i.id)}>Take back</button></div>{:else}<div class="srow muted">No open invites. Make one with Invite people.</div>{/each}</div></div>
          <div class="panel"><h3>Access</h3>
            {@render toggleRow(true, 'The shared invite still works', 'Turn this off once everyone has their own access. Then only personal invites work.', 'sharedToken', S.me.sharedToken)}
            {@render toggleRow(false, 'Members can invite people', 'Members can invite other members and viewers. Only owners can invite owners.', 'membersCanInvite', S.me.membersCanInvite)}</div>
        {/if}
      {/if}
      {#if S.account.user && S.me.accounts}
        <div class="panel"><h3>Your account</h3><p class="pdesc">Signed in as <b>{S.account.user.email || S.account.user.login}</b>. Linking it opens this project from any browser and sends your notifications to your email.</p>
          <div class="pbody">{#if S.contact && S.contact.email}<span class="pill ok">Linked · {S.contact.email}</span>{:else}<button class="primary" onclick={linkAccount}>Link my account to this project</button>{/if} <span class="small" class:err={msg.acct && msg.acct.bad}>{msg.acct && msg.acct.t}</span></div></div>
      {:else if !S.account.user && (S.account.email || S.account.github)}
        <div class="panel"><h3>Sign in</h3><p class="pdesc">Sign in from the home screen to carry your projects between browsers and get email notifications.</p><div class="pbody"><button onclick={goHome}>Go to the home screen</button></div></div>
      {/if}
      <div class="panel"><h3>Leave this project</h3><p class="pdesc">{iAmDemo() ? 'The demo is removed from your projects. You can open a fresh one from the home screen any time.' : soleOwner ? "You're the only owner. Make someone else an owner above first, so the team still has one." : S.me.accounts && S.me.via === 'member' ? "Your access ends right away, and you'd need a new invite to come back. Your past work stays in the project." : 'This project is removed from this browser. Anyone with the shared invite, you included, can still open it again.'} To also disconnect your computer, run <code>huddle leave</code> in the project folder.</p>
        <div class="pactions" style="padding-top:12px"><span class="small err">{msg.leave && msg.leave.t}</span><button class="danger" disabled={soleOwner} onclick={leave}>Leave {prettyProject(auth.project)}</button></div></div>

    {:else if tab === 'rules'}
      <div class="panel"><h3>Commands</h3><p class="pdesc">One command per line, matched from the start (<code>npm test</code> also covers <code>npm test -- --watch</code>; end with <code>*</code> for any subcommand).</p>
        <div class="pbody fieldset">
          <div><label for="pa">Always allowed in background runs</label><textarea id="pa" bind:value={pol.allow} disabled={!owner} placeholder="npm test&#10;npm run build"></textarea><div class="hintline">Background agents run these without asking anyone.</div></div>
          <div><label for="pd">Never allowed, for anyone's agent</label><textarea id="pd" bind:value={pol.deny} disabled={!owner} placeholder="git push&#10;npx wrangler deploy"></textarea><div class="hintline">Refused in every teammate's own sessions too, and can't be approved.</div></div></div></div>
      <div class="panel"><h3>Privacy</h3><div class="pbody fieldset">
        <div><label for="pp">Private files</label><textarea id="pp" bind:value={pol.priv} disabled={!owner}></textarea><div class="hintline">Never locked, live-shared or shown in Code. A trailing <code>/</code> is a folder; <code>**/</code> matches any depth.</div></div>
        <div><span class="lbl2">Most a session may share</span><div class="seg sm" role="group" id="ms">{#each [['full', 'Everything'], ['tools', 'Steps only'], ['off', 'Nothing']] as [k, l]}<button class:on={pol.sharing === k} disabled={!owner} onclick={() => (pol.sharing = k)}>{l}</button>{/each}</div>
          <div class="hintline">Everything: prompts, replies and steps. Steps only: which tools ran, no prompts or replies. Each person can share less than this, never more. API keys and passwords are hidden either way.</div></div></div></div>
      <div class="panel"><h3>Finished background work</h3><div class="pbody fieldset">
        <div><div class="seg sm" role="group" aria-label="Delivery">{#each [['merge', "Merge into the person's branch"], ['pr', 'Open a GitHub pull request']] as [k, l]}<button class:on={pol.delivery === k} disabled={!owner} onclick={() => (pol.delivery = k)}>{l}</button>{/each}</div>
          <div class="hintline">Pull requests need the <code>gh</code> CLI, signed in, on each computer that runs background work. The review and test results go in the description.</div></div>
        <div><label for="pt">Test command</label><input type="text" id="pt" bind:value={pol.test} disabled={!owner} placeholder="Guessed from the project (npm test, pytest, …)"><div class="hintline">Runs before background work lands. Failing work stays on its branch.</div></div></div></div>
      {#if owner}<div class="pactions"><span class="small" class:err={msg.rules && msg.rules.bad}>{msg.rules && msg.rules.t}</span><button class="primary" onclick={saveRules}>Save rules</button></div>{:else}<p class="readonly-note">Only the project owner can change these.</p>{/if}

    {:else if tab === 'integrations'}
      <div class="panel"><h3><Icon name="github" size={16} /> GitHub repository</h3>
        <p class="pdesc">Connect the project's repository to see branches with their checks, pull requests, commits and issues in Code, get an update the moment someone pushes, close board tasks with commits that say "closes &lt;id&gt;", and open pull requests from huddle.</p>
        {#if ps.repo}
          <div class="srow"><span class="grow"><b><a href={ps.repo.url} target="_blank" rel="noopener">{ps.repo.full}</a></b><span class="sub">Connected by {ps.repo.by} {ago(ps.repo.at)} · {ps.repo.webhook ? 'webhook active: updates arrive as people push' : (ps.repo.webhookError || 'read every minute')}</span></span>{#if owner}<button class="ghost" onclick={disconnect}>Disconnect</button>{/if}</div>
        {:else if owner}
          <div class="pbody fieldset">
            <div><label for="rr">Repository</label><input id="rr" type="text" bind:value={repoText} placeholder="owner/name or https://github.com/owner/name"></div>
            <div><span class="lbl2">Access</span>
              {#if S.account.user && S.account.user.repoAccess}<div class="hintline" style="margin:0 0 6px">Using your signed-in GitHub account ({S.account.user.login}). Leave the token empty.</div>
              {:else if S.account.github}<a class="ghbtn" style="display:inline-flex" href={ghLink(true)}><Icon name="github" size={16} />{S.account.user ? 'Allow repository access' : 'Sign in with GitHub and allow repository access'}</a><div class="hintline">Or paste a token below.</div>{/if}
              <input id="rt" type="password" bind:value={repoToken} placeholder="Personal access token (repo scope), optional" autocomplete="off">
              <div class="hintline">The token stays on the server, is never shown to the team, and is used only to read the repository and open pull requests. A token with admin rights lets huddle add a webhook.</div></div></div>
          <div class="pactions"><span class="small" class:err={msg.repo && msg.repo.bad}>{msg.repo && msg.repo.t}</span><button class="primary" onclick={connect} disabled={!repoText.trim()}>Connect</button></div>
        {:else}<p class="readonly-note">Only the project owner can connect a repository.</p>{/if}
        {#if ps.repo && msg.repo}<p class="small" style="padding:0 16px 12px" class:err={msg.repo.bad}>{msg.repo.t}</p>{/if}
      </div>

    {:else if tab === 'notify'}
      <div class="panel"><h3>What you're told about</h3><p class="pdesc">Your own settings. Everything shows in the bell; choose what also goes to your email{S.contact && S.contact.email ? ` (${S.contact.email})` : ''} and your desktop. Several emails close together are sent as one.</p>
        {#if !(S.contact && S.contact.email)}<div class="srow" style="border-top:1px solid var(--line)"><span class="grow muted">No email linked. Sign in on the home screen, then link your account under Team &amp; access.</span></div>{/if}
        <div class="plist">{#each Object.entries(S.noteKinds) as [k, d]}{@const pr = S.notePrefs[k] || {}}
          <div class="srow"><span class="grow">{d.label}</span>
            <label class="checks" style="gap:6px"><input type="checkbox" checked={pr.email} disabled={!(S.contact && S.contact.email)} onchange={(e) => setPref(k, 'email', e.target.checked)}>Email</label>
            <label class="checks" style="gap:6px"><input type="checkbox" checked={pr.desktop} onchange={(e) => setPref(k, 'desktop', e.target.checked)}>Desktop</label></div>{/each}</div>
        <p class="small err" style="padding:0 16px">{msg.prefs && msg.prefs.t}</p></div>
      <div class="panel"><h3>Team channels</h3><p class="pdesc">Posts to Slack, Discord or any webhook when something needs a person. The address is kept on the server and never shown to the team.</p>
        <div class="plist">{#each ps.notify || [] as n}<div class="srow"><span class="pill acc">{({ slack: 'Slack', discord: 'Discord', generic: 'Webhook' })[n.kind] || n.kind}</span><span class="grow">{n.label}<span class="sub">{n.events.map(e => KINDS[e] || e).join(' · ')}</span></span>{#if owner}<button class="ghost" onclick={run('chan', async () => { const r = await api('notify-set', { remove: n.id }); S.projectSettings.notify = r.notify; })}>Remove</button>{/if}</div>{:else}<div class="srow muted">No channels yet.</div>{/each}</div>
        {#if (ps.notify || []).length && owner}<div class="pactions"><span class="small">{msg.chan && msg.chan.t}</span><button onclick={testChannel}>Send a test</button></div>{/if}</div>
      {#if owner}<div class="panel"><h3>Add a channel</h3><div class="pbody fieldset">
        <div><label for="nu">Webhook URL</label><input type="url" id="nu" bind:value={nUrl} placeholder="https://hooks.slack.com/services/…"><div class="hintline">Slack: an incoming webhook. Discord: Server settings → Integrations → Webhooks. Anything else gets JSON.</div></div>
        <div><span class="lbl2">Send when</span><div class="checks">{#each Object.entries(KINDS) as [k, l]}<label><input type="checkbox" bind:checked={nEvents[k]}>{l}</label>{/each}</div></div></div>
        <div class="pactions"><span class="small err">{msg.chan && msg.chan.bad ? msg.chan.t : ''}</span><button class="primary" onclick={addChannel} disabled={!nUrl.trim()}>Add channel</button></div></div>{/if}

    {:else if tab === 'data'}
      <div class="panel"><h3>What huddle keeps</h3><p class="pdesc">Per project: the board, messages, what agents were asked and replied (secrets are removed first), shared files and code snapshots, memory, usage counts, and the audit log. Nothing is used to train models or shared outside the project. API keys, tokens and webhook addresses are stored server-side and never exported.</p></div>
      {#if owner}
        <div class="panel"><h3>Export</h3><p class="pdesc">Everything the project holds, as one JSON file, without secrets.</p><div class="pbody"><button onclick={() => download('export', prettyProject(auth.project) + '-export.json')}>Download the project</button></div></div>
        <div class="panel"><h3>How long it's kept</h3><p class="pdesc">Leave a box empty to keep that kind of data until the project is deleted. Older items are removed automatically.</p><div class="pbody fieldset">
          <div class="row" style="display:flex;gap:12px;flex-wrap:wrap">
            {#each [['activityDays', 'Agent activity'], ['messageDays', 'Messages'], ['auditDays', 'Audit log'], ['taskDays', 'Finished tasks']] as [k, l]}<div><label for={'r' + k}>{l} (days)</label><input id={'r' + k} type="number" min="1" max="3650" bind:value={ret[k]} style="width:120px" placeholder="Forever"></div>{/each}</div></div>
          <div class="pactions"><span class="small" class:err={msg.ret && msg.ret.bad}>{msg.ret && msg.ret.t}</span><button class="primary" onclick={saveRetention}>Save</button></div></div>
      {/if}
      <div class="panel"><h3>Your data in this project</h3><p class="pdesc">Erase your prompts, replies, messages, hand-off notes, usage and notification settings. Tasks you asked for stay, and the audit log keeps its record of changes.</p>
        <div class="pactions" style="padding-top:12px"><span class="small" class:err={msg.erase && msg.erase.bad}>{msg.erase && msg.erase.t}</span><button class="danger" onclick={eraseMe}>Erase my activity</button></div></div>
      {#if S.account.user}<div class="panel"><h3>Your account</h3><p class="pdesc">{S.account.user.email || S.account.user.login}. Your projects' access tokens are kept on your account so they follow you between browsers.</p>
        <div class="pactions" style="padding-top:12px"><a href="/api/me/export" download>Download my account data</a><button class="danger" onclick={deleteAccount}>Delete my account</button></div></div>{/if}
      {#if owner}<div class="panel" style="border-color:var(--bad)"><h3>Delete this project</h3><p class="pdesc">Removes the board, messages, files, code snapshots and everything else from the server, for everyone, and cannot be undone. People's own folders keep their files. Type <b>{prettyProject(auth.project)}</b> to confirm.</p>
        <div class="pactions" style="padding-top:12px"><span class="small err">{msg.del && msg.del.t}</span><input bind:value={delName} placeholder={prettyProject(auth.project)} aria-label="Project name" style="width:200px"><button class="danger" disabled={delName !== prettyProject(auth.project) && delName !== auth.project} onclick={deleteProject}>Delete project</button></div></div>{/if}

    {:else if tab === 'audit'}
      {#if S.me.role === 'viewer'}<p class="muted">Viewers cannot see the audit log.</p>{:else}
        <div class="seg sm" style="margin-bottom:12px">{#each [['all', 'Everything'], ['commands', 'Background commands'], ['access', 'Access'], ['changes', 'Settings and approvals']] as [k, l]}<button class:on={afilter === k} onclick={() => (afilter = k)}>{l}</button>{/each}</div>
        <div class="panel" style="overflow-x:auto"><table class="audit"><tbody>{#each auditRows as e}<tr><td title={new Date(e.at).toLocaleString()}>{new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td><td>{e.by}</td><td>{#if e.action === 'command'}ran <code>{e.detail}</code>{#if e.agent} <span class="muted">({e.agent})</span>{/if}{:else}{e.detail}{/if}</td></tr>{:else}<tr><td colspan="3" class="muted" style="text-align:center;padding:24px">Nothing here yet.</td></tr>{/each}</tbody></table></div>
      {/if}
    {/if}
  </div>
</main>

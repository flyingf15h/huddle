<script>
  // Invite people: the command a teammate runs to join (personal, with a role, once accounts are on).
  import { S, api, auth } from '../lib/state.svelte.js';
  const ROLE_DESC = { member: 'Can send requests and edit through their agent.', viewer: 'Can watch everything, change nothing.' };
  let role = $state('member'), cmd = $state(''), note = $state(''), watch = $state(''), copied = $state(''), cached = null;
  const accounts = $derived(!!S.me.accounts);
  const long = () => btoa(JSON.stringify({ s: location.origin, t: auth.token, p: auth.project })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  async function fill() {
    cmd = 'Making an invite…'; note = '';
    if (!accounts) {
      cached = cached || await api('invite-code', {}).then(r => r.code).catch(() => long());
      cmd = `npx -y github:flyingf15h/huddle join ${cached}`;
      watch = `${location.origin}/app#invite=${cached}`;
      note = 'Anyone with the invite can join and see the project. For access you can take back, set up accounts in Team & settings.';
      return;
    }
    try { const r = await api('member-invite', { role }); cmd = `npx -y github:flyingf15h/huddle join ${r.code}`; note = `Works once, for one person, until ${new Date(r.invite.expires).toLocaleDateString()}. You can take it back in Team & settings.`; }
    catch (e) { cmd = ''; note = "Couldn't make an invite: " + e.message; }
  }
  $effect(() => { if (S.invite) { role; fill(); } });
  const copy = (text, k) => navigator.clipboard.writeText(text).then(() => { copied = k; setTimeout(() => (copied = ''), 1500); });
</script>
{#if S.invite}
  <div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) S.invite = false; }} onkeydown={(e) => e.key === 'Escape' && (S.invite = false)}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Invite people" style="width:min(640px,100%)">
      <div style="display:flex;align-items:center"><h3 style="margin:0;flex:1">Invite people</h3><button onclick={() => (S.invite = false)}>Close</button></div>
      <p>Send a teammate these steps. They need Claude Code, Codex or Cursor, Node 18+ and git, and use their own account.</p>
      {#if accounts}<div class="invrole"><div class="seg sm" role="group" aria-label="Role">{#each ['member', 'viewer'] as r}<button class:on={role === r} onclick={() => (role = r)}>{r === 'member' ? 'Member' : 'Viewer'}</button>{/each}</div><span class="small muted">{ROLE_DESC[role]}</span></div>{/if}
      <ol class="steps">
        <li>Open a terminal in their copy of the project, or an empty folder.</li>
        <li>Run this. It asks for their name; answer yes if it offers to set up git. Add <code>--agent cursor</code> or <code>--agent codex</code> if they don't use Claude Code.<div class="cmd"><code>{cmd}</code><button onclick={() => copy(cmd, 'cmd')}>{copied === 'cmd' ? 'Copied' : 'Copy'}</button></div></li>
        <li>Start their agent in that folder. It's in the huddle from the first prompt.</li>
      </ol>
      {#if !accounts && watch}<p class="small muted">To let someone watch without joining, <button class="link" onclick={() => copy(watch, 'w')}>{copied === 'w' ? 'copied' : 'copy the dashboard link'}</button>.</p>{/if}
      <p class="small muted">{note}</p>
    </div>
  </div>
{/if}

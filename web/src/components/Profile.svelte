<script>
  // Your profile: picture, display name, username (what teammates send work to) and your agent's name.
  import { S, auth, api, myName, dn, aiName, hasClaude, myTool } from '../lib/state.svelte.js';
  import { color, store } from '../lib/words.js';
  import Avatar from './Avatar.svelte';
  const mine = $derived(S.settings[myName()] || {});
  let display = $state(''), username = $state(''), agent = $state(''), picture = $state(null), err = $state(''), busy = $state(false);
  $effect(() => { if (S.profile) { display = mine.displayName || ''; username = myName(); agent = aiName(myName()); picture = mine.avatar || null; err = ''; } });
  // cropped square, shrunk to 128 px so it stays small on the server
  function shrink(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error('pick an image file'));
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const side = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
        URL.revokeObjectURL(img.src);
        let out = c.toDataURL('image/webp', 0.85);
        if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/jpeg', 0.85);
        resolve(out);
      };
      img.onerror = () => reject(new Error("couldn't read that image"));
      img.src = URL.createObjectURL(file);
    });
  }
  async function pick(e) { const f = e.target.files[0]; if (!f) return; try { picture = await shrink(f); err = ''; } catch (x) { err = x.message; } }
  async function save(e) {
    e.preventDefault(); err = ''; busy = true;
    try {
      const change = {};
      if (display.trim() !== (mine.displayName || '')) change.displayName = display.trim();
      if ((picture || null) !== (mine.avatar || null)) change.avatar = picture || '';
      if (hasClaude(myName()) && agent.trim() !== aiName(myName())) change.aiName = agent.trim();
      if (Object.keys(change).length) { const r = await api('setting', change); S.settings[myName()] = r.settings; }
      const n = username.trim().replace(/\s+/g, '-');
      if (n && n !== myName()) { await api('rename', { name: n }); auth.name = n; store.set('huddle.name', n); location.reload(); return; }
      S.profile = false;
    } catch (x) { err = x.message; }
    busy = false;
  }
  const pal = $derived(color(myName()));
</script>
{#if S.profile}
  <div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) S.profile = false; }} onkeydown={(e) => e.key === 'Escape' && (S.profile = false)}>
    <div class="sheet" role="dialog" aria-modal="true" aria-label="Your profile">
      <form onsubmit={save} style="display:grid;gap:10px">
        <div class="pichead">
          {#if picture}<span class="av has-img big"><img src={picture} alt=""></span>{:else}<span class="av big" style="background:{pal[0]};color:{pal[1]}">{(display.trim() || myName())[0].toUpperCase()}</span>{/if}
          <span class="picbtns"><label class="filebtn">Upload photo<input type="file" accept="image/*" hidden onchange={pick}></label>{#if picture}<button type="button" class="link small" onclick={() => (picture = null)}>Remove</button>{/if}</span></div>
        <div><label for="pf-d" class="small muted">Display name</label><input id="pf-d" bind:value={display} maxlength="40" placeholder={myName()} autocomplete="name" style="width:100%"></div>
        <div><label for="pf-u" class="small muted">Username · what teammates use to send you work</label><input id="pf-u" bind:value={username} maxlength="40" autocomplete="off" style="width:100%"></div>
        {#if hasClaude(myName())}<div><label for="pf-a" class="small muted">Your {myTool()}'s name</label><input id="pf-a" bind:value={agent} maxlength="32" placeholder="{dn(myName())}'s {myTool()}" autocomplete="off" style="width:100%"></div>{/if}
        {#if err}<div class="err small" role="alert">{err}</div>{/if}
        <div style="display:flex;gap:6px;justify-content:flex-end"><button type="button" onclick={() => (S.profile = false)}>Cancel</button><button class="primary" disabled={busy}>Save</button></div>
      </form>
    </div>
  </div>
{/if}

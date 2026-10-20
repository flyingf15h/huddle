<script>
  // Brief & memory: the project brief (a reader with a contents list, and an editor), shared memory
  // notes and skills, with search.
  import { tick } from 'svelte';
  import { S, api, loadShared } from '../lib/state.svelte.js';
  import { md, ago } from '../lib/words.js';

  let tab = $state('doc'), editing = $state(false), draft = $state(''), msg = $state(''), query = $state(''), adding = $state(false), mt = $state(''), mx = $state(''), body = $state();
  const sh = $derived(S.shared);
  const has = (q, ...parts) => !q || parts.join(' ').toLowerCase().includes(q.toLowerCase());
  const memories = $derived(sh ? sh.memories.slice().reverse().filter(m => has(query, m.title, m.text)) : []);
  const skills = $derived(sh ? sh.skills.filter(k => has(query, k.name, k.description, k.body)) : []);
  const doc = $derived(sh && sh.doc && sh.doc.text.trim() ? sh.doc : null);
  const slug = (t, i) => 'k-' + i + '-' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  let toc = $state([]);

  // the reader styles headings itself, and a paragraph that opens with "**Label:**" reads as a small heading
  $effect(() => {
    doc; tab; editing;
    tick().then(() => {
      if (!body) return;
      for (const x of body.querySelectorAll('[style]')) x.removeAttribute('style');
      for (const b of body.querySelectorAll('p > b:first-child')) if (/:$/.test(b.textContent.trim()) && b.parentElement.firstChild === b) b.classList.add('lead');
      const heads = [...body.querySelectorAll('h3, h4, h5, .lead')];
      heads.forEach((h, i) => { h.id = slug(h.textContent, i); });
      const list = heads.filter(h => h.tagName !== 'H5' && !h.classList.contains('lead'));
      toc = list.length >= 3 ? list.map(h => ({ id: h.id, text: h.textContent.replace(/:$/, ''), sub: h.tagName === 'H4' })) : [];
    });
  });
  // search hands over a memory, skill or the brief to look at
  let openId = $state(null);
  $effect(() => {
    const o = S.briefOpen;
    if (!o) return;
    S.briefOpen = null; query = '';
    tab = o.brief ? 'doc' : o.memory ? 'memory' : 'skills'; openId = o.memory || o.skill || null;
  });

  function edit() { draft = doc ? doc.text : ''; editing = true; msg = ''; }
  async function save() {
    try { await api('doc', { text: draft, baseVersion: sh.doc ? sh.doc.version : 0 }); editing = false; await loadShared(); }
    catch (e) { msg = e.message; }
  }
  async function addMemory() {
    if (!mt.trim() || !mx.trim()) return (msg = 'Give it a title and the detail.');
    try { await api('memory', { title: mt.trim(), text: mx.trim() }); adding = false; mt = mx = ''; msg = ''; await loadShared(); } catch (e) { msg = e.message; }
  }
  const forget = async (id) => { await api('forget', { id }).catch(() => {}); await loadShared(); };
  const delSkill = async (name) => { await api('skill-delete', { name }).catch(() => {}); await loadShared(); };
  const first = (t) => String(t).split('\n').map(l => l.replace(/[#*`>-]/g, '').trim()).find(Boolean) || '';
</script>

<main data-main style="display:flex;flex-direction:column;min-height:0;flex:1">
  <div id="briefview" style="flex:1;overflow-y:auto;padding:0 20px 32px">
    <div class="kbar">
      <div class="seg" role="tablist">
        <button class:on={tab === 'doc'} onclick={() => { tab = 'doc'; query = ''; }}>Project brief</button>
        <button class:on={tab === 'memory'} onclick={() => { tab = 'memory'; query = ''; }}>Memory<span class="ct">{sh && sh.memories.length || ''}</span></button>
        <button class:on={tab === 'skills'} onclick={() => { tab = 'skills'; query = ''; }}>Skills<span class="ct">{sh && sh.skills.length || ''}</span></button>
      </div>
      <span class="grow"></span>
      <span style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        {#if tab === 'doc' && !editing}<button class="primary" onclick={edit}>{doc ? 'Edit brief' : 'Write brief'}</button>{/if}
        {#if tab === 'memory'}<input type="search" placeholder="Search memory" bind:value={query} aria-label="Search memory"><button class="primary" onclick={() => (adding = true)}>New memory</button>{/if}
        {#if tab === 'skills' && sh && sh.skills.length}<input type="search" placeholder="Search skills" bind:value={query} aria-label="Search skills">{/if}
      </span>
    </div>
    {#if !sh}<p class="muted">Loading…</p>
    {:else if tab === 'doc'}
      {#if editing}
        <textarea class="big" bind:value={draft} aria-label="Project brief"></textarea>
        <div style="display:flex;gap:8px;margin-top:10px;align-items:center"><button class="primary" onclick={save}>Save</button><button onclick={() => (editing = false)}>Cancel</button><span class="err small">{msg}</span></div>
      {:else if !doc}
        <div class="empty"><h3>No project brief yet</h3><p style="margin:0 auto;max-width:460px">Every agent reads the brief first. Describe what the project is, how the code is organized, how to run and test it, and who owns which areas.</p></div>
      {:else}
        <p class="kintro">Edited by {doc.byName} {ago(doc.at)}</p>
        <div class="kwrap" class:solo={!toc.length}><article class="doc" bind:this={body}>{@html md(doc.text)}</article>
          {#if toc.length}<nav class="toc" aria-label="On this page"><b>On this page</b>{#each toc as t}<button style="padding-left:{t.sub ? 10 : 0}px" onclick={() => document.getElementById(t.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{t.text}</button>{/each}</nav>{/if}</div>
      {/if}
    {:else if tab === 'memory'}
      {#if adding}
        <div class="newmem"><b>Something everyone should know</b>
          <input bind:value={mt} placeholder="Short title, e.g. Tests need Docker running" maxlength="120" aria-label="Title">
          <textarea bind:value={mx} placeholder="The detail, and why it matters" style="min-height:90px" aria-label="Detail"></textarea>
          <div style="margin-top:10px;display:flex;gap:8px;align-items:center"><button class="primary" onclick={addMemory}>Save</button><button onclick={() => (adding = false)}>Cancel</button><span class="err small">{msg}</span></div></div>
      {/if}
      {#each memories as m (m.id)}
        <details class="mem" open={!!query || openId === m.id}><summary data-nav><svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="mt">{m.title}</span><span class="mw">{m.byName} · {ago(m.at)}</span><span class="mp">{first(m.text)}</span></summary>
          <div class="mb">{@html md(m.text)}<div class="macts"><button class="link small" onclick={() => forget(m.id)}>Delete</button></div></div></details>
      {:else}<p class="muted">{query ? `No memory mentions “${query}”.` : 'No memories yet.'}</p>{/each}
    {:else}
      {#each skills as k (k.name)}
        <details class="mem" open={!!query || openId === k.name}><summary data-nav><svg class="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="mt">{k.name}</span><span class="mw">{k.byName} · {ago(k.at)}</span><span class="mp">{k.description}</span></summary>
          <div class="mb"><p>{k.description}</p><pre>{k.body}</pre><div class="macts"><button class="link small" onclick={() => delSkill(k.name)}>Delete</button></div></div></details>
      {:else}<p class="muted">{query ? `No skill mentions “${query}”.` : 'No shared skills yet. An agent can save one with huddle_save_skill.'}</p>{/each}
    {/if}
  </div>
</main>

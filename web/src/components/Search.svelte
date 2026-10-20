<script>
  // Ctrl+K: search the whole project (tasks, messages, agent activity, memory, code) and jump around.
  import { onMount } from 'svelte';
  import { S, api, go } from '../lib/state.svelte.js';
  import { ago } from '../lib/words.js';
  import Icon from './Icon.svelte';

  const COMMANDS = [
    { title: 'Go to Activity', run: () => go('activity') }, { title: 'Go to Tasks', run: () => go('tasks') },
    { title: 'Go to Code', run: () => go('code') }, { title: 'Go to Brief & memory', run: () => go('brief') },
    { title: 'Go to Usage & cost', run: () => go('usage') }, { title: 'Go to Health', run: () => go('health') },
    { title: 'Go to Team & settings', run: () => go('settings') }, { title: 'Invite people', run: () => (S.invite = true) },
    { title: 'Keyboard shortcuts', run: () => (S.shortcuts = true) },
  ];
  const KIND = { request: 'Request', task: 'Task', message: 'Message', prompt: 'Prompt', reply: 'Reply', step: 'Step', brief: 'Brief', memory: 'Memory', skill: 'Skill', handoff: 'Hand-off', file: 'Live file', code: 'Code' };
  let q = $state(''), results = $state([]), sel = $state(0), busy = $state(false), input;
  let timer;
  const cmds = $derived(COMMANDS.filter(c => !q || c.title.toLowerCase().includes(q.toLowerCase())));
  const items = $derived([...cmds.map(c => ({ cmd: c })), ...results.map(r => ({ hit: r }))]);

  $effect(() => {
    const query = q.trim();
    clearTimeout(timer);
    if (query.length < 2) { results = []; return; }
    timer = setTimeout(async () => {
      busy = true;
      try { const r = await api('search?q=' + encodeURIComponent(query) + '&limit=40'); if (q.trim() === query) { results = r.results; sel = 0; } } catch { results = []; }
      busy = false;
    }, 160);
  });
  onMount(() => input.focus());

  function open(it) {
    S.search = false;
    if (it.cmd) return it.cmd.run();
    const r = it.hit, ref = r.ref || {};
    if (ref.task) return go('tasks', { task: ref.task });
    if (ref.goal) { const t = S.board.tasks.find(x => x.goalId === ref.goal); return go('tasks', { task: t ? t.id : null }); }
    if (ref.memory || ref.skill || ref.brief) { S.briefOpen = ref; return go('brief'); }
    if (ref.path || ref.file) { S.codeOpen = ref; return go('code'); }
    S.who = null; S.filter = 'all'; S.feedJump = r.at;
    go('activity');
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); scroll(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); scroll(); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); open(items[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); S.search = false; }
  }
  const scroll = () => setTimeout(() => document.querySelector('.palette .hit.sel')?.scrollIntoView({ block: 'nearest' }));
</script>

<div class="overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) S.search = false; }}>
  <div class="palette" role="dialog" aria-modal="true" aria-label="Search">
    <div class="pin"><Icon name="search" /><input bind:this={input} bind:value={q} onkeydown={onKey} placeholder="Search tasks, messages, memory, code… or type a page" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="presults" aria-activedescendant={'hit-' + sel} autocomplete="off"></div>
    <div class="plist2" id="presults" role="listbox">
      {#if cmds.length}<div class="phead">Go to</div>{/if}
      {#each items as it, i}
        {#if it.hit && i === cmds.length}<div class="phead">{busy ? 'Searching…' : 'In this project'}</div>{/if}
        <button id={'hit-' + i} class="hit" class:sel={i === sel} role="option" aria-selected={i === sel} onmouseenter={() => (sel = i)} onclick={() => open(it)}>
          {#if it.cmd}<span class="hb"><span class="ht" style="font-weight:500">{it.cmd.title}</span></span>
          {:else}<span class="hk">{KIND[it.hit.kind] || it.hit.kind}</span><span class="hb"><span class="ht">{it.hit.title}</span><span class="hs mono">{it.hit.snippet}</span></span><span class="small faint">{it.hit.who ? it.hit.who + ' · ' : ''}{it.hit.at ? ago(it.hit.at) : ''}</span>{/if}
        </button>
      {/each}
      {#if q.trim().length >= 2 && !busy && !results.length}<div class="nempty">Nothing in the project mentions “{q.trim()}”.</div>{/if}
    </div>
    <div class="pfoot"><span><span class="kbdk">↑</span> <span class="kbdk">↓</span> to move</span><span><span class="kbdk">Enter</span> to open</span><span><span class="kbdk">Esc</span> to close</span></div>
  </div>
</div>

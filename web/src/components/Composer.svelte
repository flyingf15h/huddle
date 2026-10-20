<script>
  // The request box: to the whole team (one agent splits it up), to one person's agent (runs in the
  // background), or a message to one open session. Short questions go as messages, not tasks.
  import { S, api, people, hasClaude, myName, myTool, claudeOf, toolOf, sessionsOf, sessionLabel, sessionName, sessionBusy, setName, auth } from '../lib/state.svelte.js';
  let { focus = $bindable() } = $props();
  let text = $state(''), to = $state(''), sending = $state(false), msg = $state(''), err = $state(''), box;
  focus = () => box && box.focus();

  const withAgent = $derived(people().filter(p => hasClaude(p.name)).sort((x, y) => (y.name === myName()) - (x.name === myName())));
  // the sidebar's "Ask" button aims the box at someone
  $effect(() => { if (S.askTo) { to = S.askTo; S.askTo = null; setTimeout(() => box && box.focus()); } });

  const hint = $derived.by(() => {
    if (to.startsWith('@')) { const a = S.agents[to.slice(1)]; return !a || !a.online ? 'That session has closed.' : sessionBusy(a) ? 'It is working now and reads this at its next step.' : `It's idle, so it reads this when ${a.name === myName() ? 'you use it' : a.name + ' next uses it'}.`; }
    if (!to) return 'One agent splits it into tasks for everyone.';
    const p = people().find(x => x.name === to), mode = (S.settings[to] || {}).autopilot;
    return !p || !p.online ? `${to} is away. It waits until their ${toolOf(to)} is back.` : mode === 'off' ? `${to} turned background work off. It waits for them.`
      : p.runner === 'full' || p.runner === 'requests' ? 'Starts right away in the background.' : p.outdated ? `${to}'s huddle needs an update before it can run background work.` : `${to}'s ${toolOf(to)} isn't running background work right now. It waits for them.`;
  });
  const placeholder = $derived(to.startsWith('@') ? `Message ${sessionName(to.slice(1))}. It replies to you here.` : !to ? 'Describe what the team should build or fix, and what done looks like.' : to === myName() ? `What should your ${myTool()} do?` : `What should ${claudeOf(to)} do? It replies to you here.`);
  const isQuick = (t) => t.length <= 160 && !/\n/.test(t) && (/\?\s*$/.test(t) || /^(are|is|did|do|does|have|has|was|were|what|why|how|when|where|which|who|status|any update)\b/i.test(t)) && !/^(can|could|would|will) (you|u)\b/i.test(t);
  const say = (t) => { msg = t; setTimeout(() => { if (msg === t) msg = ''; }, 4000); };

  async function send(e) {
    e && e.preventDefault();
    const t = text.trim();
    if (!t) return box.focus();
    if (!auth.name) return;
    sending = true; err = '';
    try {
      if (to.startsWith('@')) { await api('message', { to: to.slice(1), text: t }); say(`Sent to ${sessionName(to.slice(1))}.`); }
      else if (to && isQuick(t)) { await api('message', { to, text: t }); say(`Asked ${to === myName() ? 'your ' + myTool() : claudeOf(to)}. The answer will show up here.`); }
      else { await api('goal', { text: t, to: to || null }); say(!to ? 'Sent to the team' : to === myName() ? `Sent to your ${myTool()}` : `Sent to ${claudeOf(to)}. The reply will show up here.`); }
      text = '';
    } catch (e2) { err = "Couldn't send: " + e2.message; }
    sending = false;
  }
  const grow = (el) => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 240) + 'px'; };
</script>

<form id="composer" onsubmit={send}>
  <div class="cbox">
    <div class="ctop"><span class="clabel">New request</span><label class="tolabel" for="to">to</label>
      <select id="to" bind:value={to}>
        <option value="">The whole team</option>
        {#each withAgent as p (p.name)}
          {@const mine = p.name === myName()}
          <optgroup label={mine ? 'You' : p.name}>
            <option value={p.name}>{mine ? 'Your ' + myTool() : claudeOf(p.name)}, new background session{p.online ? '' : ' (away)'}</option>
            {#each sessionsOf(p.name) as a (a.id)}<option value={'@' + a.id}>{sessionLabel(a)}</option>{/each}
          </optgroup>
        {/each}
      </select></div>
    <textarea id="text" rows="2" bind:this={box} bind:value={text} {placeholder} aria-label="Request" oninput={(e) => grow(e.target)}
      onkeydown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); if (e.key === 'Escape') box.blur(); }}></textarea>
    <div class="cbottom"><span class="hint">{err ? '' : hint}</span><span class="kbd hide-sm">Ctrl+Enter to send</span>
      {#if err}<span class="small err">{err}</span>{:else if msg}<span class="small muted">{msg}</span>{/if}
      <button class="primary" disabled={sending}>Send</button></div>
  </div>
</form>

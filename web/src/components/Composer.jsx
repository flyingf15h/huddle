// The request box: to the whole team (one agent splits it up), to one person's agent (runs in the
// background), or a message to one open session. Short questions go as messages, not tasks.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { S, api, people, hasClaude, myName, myTool, claudeOf, toolOf, sessionsOf, sessionLabel, sessionName, sessionBusy, auth } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { sayLater } from '../lib/hooks.js';

const isQuick = (t) => t.length <= 160 && !/\n/.test(t) && (/\?\s*$/.test(t) || /^(are|is|did|do|does|have|has|was|were|what|why|how|when|where|which|who|status|any update)\b/i.test(t)) && !/^(can|could|would|will) (you|u)\b/i.test(t);

const Composer = forwardRef(function Composer(_, ref) {
  useS();
  const [text, setText] = useState(''), [to, setTo] = useState(''), [sending, setSending] = useState(false), [msg, setMsg] = useState(''), [err, setErr] = useState('');
  const box = useRef(null);
  useImperativeHandle(ref, () => ({ focus: () => box.current && box.current.focus() }));
  const withAgent = people().filter(p => hasClaude(p.name)).sort((x, y) => (y.name === myName()) - (x.name === myName()));
  // the sidebar's "Ask" button aims the box at someone
  useEffect(() => { if (S.askTo) { setTo(S.askTo); S.askTo = null; setTimeout(() => box.current && box.current.focus()); } });

  let hint;
  if (to.startsWith('@')) { const a = S.agents[to.slice(1)]; hint = !a || !a.online ? 'That session has closed.' : sessionBusy(a) ? 'It is working now and reads this at its next step.' : `It's idle, so it reads this when ${a.name === myName() ? 'you use it' : a.name + ' next uses it'}.`; }
  else if (!to) hint = 'One agent splits it into tasks for everyone.';
  else {
    const p = people().find(x => x.name === to), mode = (S.settings[to] || {}).autopilot;
    hint = !p || !p.online ? `${to} is away. It waits until their ${toolOf(to)} is back.` : mode === 'off' ? `${to} turned background work off. It waits for them.`
      : p.runner === 'full' || p.runner === 'requests' ? 'Starts right away in the background.' : p.outdated ? `${to}'s huddle needs an update before it can run background work.` : `${to}'s ${toolOf(to)} isn't running background work right now. It waits for them.`;
  }
  const placeholder = to.startsWith('@') ? `Message ${sessionName(to.slice(1))}. It replies to you here.` : !to ? 'Describe what the team should build or fix, and what done looks like.' : to === myName() ? `What should your ${myTool()} do?` : `What should ${claudeOf(to)} do? It replies to you here.`;

  async function send(e) {
    e && e.preventDefault();
    const t = text.trim();
    if (!t) return box.current.focus();
    if (!auth.name) return;
    setSending(true); setErr('');
    try {
      if (to.startsWith('@')) { await api('message', { to: to.slice(1), text: t }); sayLater(setMsg, `Sent to ${sessionName(to.slice(1))}.`); }
      else if (to && isQuick(t)) { await api('message', { to, text: t }); sayLater(setMsg, `Asked ${to === myName() ? 'your ' + myTool() : claudeOf(to)}. The answer will show up here.`); }
      else { await api('goal', { text: t, to: to || null }); sayLater(setMsg, !to ? 'Sent to the team' : to === myName() ? `Sent to your ${myTool()}` : `Sent to ${claudeOf(to)}. The reply will show up here.`); }
      setText('');
      if (box.current) box.current.style.height = 'auto';
    } catch (e2) { setErr("Couldn't send: " + e2.message); }
    setSending(false);
  }
  const grow = (el) => { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 240) + 'px'; };

  return (
    <form id="composer" onSubmit={send}>
      <div className="cbox">
        <div className="ctop"><span className="clabel">New request</span><label className="tolabel" htmlFor="to">to</label>
          <select id="to" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">The whole team</option>
            {withAgent.map(p => {
              const mine = p.name === myName();
              return (
                <optgroup key={p.name} label={mine ? 'You' : p.name}>
                  <option value={p.name}>{mine ? 'Your ' + myTool() : claudeOf(p.name)}, new background session{p.online ? '' : ' (away)'}</option>
                  {sessionsOf(p.name).map(a => <option key={a.id} value={'@' + a.id}>{sessionLabel(a)}</option>)}
                </optgroup>
              );
            })}
          </select></div>
        <textarea id="text" rows={2} ref={box} value={text} placeholder={placeholder} aria-label="Request" onChange={(e) => { setText(e.target.value); grow(e.target); }}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(e); if (e.key === 'Escape') box.current.blur(); }} />
        <div className="cbottom"><span className="hint">{err ? '' : hint}</span><span className="kbd hide-sm">Ctrl+Enter to send</span>
          {err ? <span className="small err">{err}</span> : msg ? <span className="small muted">{msg}</span> : null}
          <button className="primary" disabled={sending}>Send</button></div>
      </div>
    </form>
  );
});
export default Composer;

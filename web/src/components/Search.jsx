// Ctrl+K: search the whole project (tasks, messages, agent activity, memory, code) and jump around.
import { useEffect, useRef, useState } from 'react';
import { S, api, go } from '../lib/state.js';
import { ago } from '../lib/words.js';
import Icon from './Icon.jsx';

const COMMANDS = [
  { title: 'Go to Overview', run: () => go('overview') }, { title: 'Go to Activity', run: () => go('activity') }, { title: 'Go to Tasks', run: () => go('tasks') },
  { title: 'Go to the brief and memory', run: () => go('brief') }, { title: 'Go to the timeline', run: () => go('timeline') },
  { title: 'Go to the gallery', run: () => go('gallery') }, { title: 'Go to builds', run: () => go('builds') },
  { title: 'Go to usage and cost', run: () => go('usage') }, { title: 'Go to health', run: () => go('health') },
  { title: 'Go to settings', run: () => go('settings') }, { title: 'Invite people', run: () => (S.invite = true) },
  { title: 'Keyboard shortcuts', run: () => (S.shortcuts = true) },
];
const KIND = { request: 'Request', task: 'Task', message: 'Message', prompt: 'Prompt', reply: 'Reply', step: 'Step', brief: 'Brief', memory: 'Memory', skill: 'Skill', handoff: 'Hand-off', file: 'Live file', code: 'Code' };

export default function Search() {
  const [q, setQ] = useState(''), [results, setResults] = useState([]), [sel, setSel] = useState(0), [busy, setBusy] = useState(false);
  const input = useRef(null), listRef = useRef(null);
  const cmds = COMMANDS.filter(c => !q || c.title.toLowerCase().includes(q.toLowerCase()));
  const items = [...cmds.map(c => ({ cmd: c })), ...results.map(r => ({ hit: r }))];

  useEffect(() => { input.current && input.current.focus(); }, []);
  useEffect(() => {
    const query = q.trim();
    if (query.length < 2) { setResults([]); return; }
    let live = true;
    const t = setTimeout(async () => {
      setBusy(true);
      try { const r = await api('search?q=' + encodeURIComponent(query) + '&limit=40'); if (live) { setResults(r.results); setSel(0); } } catch { if (live) setResults([]); }
      if (live) setBusy(false);
    }, 160);
    return () => { live = false; clearTimeout(t); };
  }, [q]);
  useEffect(() => { listRef.current?.querySelector('.hit.sel')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const open = (it) => {
    S.search = false;
    if (it.cmd) return it.cmd.run();
    const r = it.hit, ref = r.ref || {};
    if (ref.task) return go('tasks', { task: ref.task });
    if (ref.goal) { const t = S.board.tasks.find(x => x.goalId === ref.goal); return go('tasks', { task: t ? t.id : null }); }
    if (ref.memory || ref.skill || ref.brief) { S.briefOpen = ref; return go('brief'); }
    if (ref.path || ref.file) { S.fileOpen = { path: ref.path || ref.file, branch: ref.branch || null }; return; }
    S.who = null; S.filter = 'all'; S.feedJump = r.at;
    go('activity');
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(Math.min(items.length - 1, sel + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(Math.max(0, sel - 1)); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); open(items[sel]); }
    else if (e.key === 'Escape') { e.preventDefault(); S.search = false; }
  };
  return (
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) S.search = false; }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="pin"><Icon name="search" /><input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} placeholder="Search tasks, messages, memory, code… or type a page" aria-label="Search" role="combobox" aria-expanded="true" aria-controls="presults" aria-activedescendant={'hit-' + sel} autoComplete="off" /></div>
        <div className="plist2" id="presults" role="listbox" ref={listRef}>
          {cmds.length > 0 && <div className="phead">Go to</div>}
          {items.map((it, i) => (
            <div key={i}>
              {it.hit && i === cmds.length && <div className="phead">{busy ? 'Searching…' : 'In this project'}</div>}
              <button id={'hit-' + i} className={'hit' + (i === sel ? ' sel' : '')} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => open(it)}>
                {it.cmd ? <span className="hb"><span className="ht" style={{ fontWeight: 500 }}>{it.cmd.title}</span></span>
                  : <><span className="hk">{KIND[it.hit.kind] || it.hit.kind}</span><span className="hb"><span className="ht">{it.hit.title}</span><span className="hs mono">{it.hit.snippet}</span></span><span className="small faint">{it.hit.who ? it.hit.who + ' · ' : ''}{it.hit.at ? ago(it.hit.at) : ''}</span></>}
              </button>
            </div>
          ))}
          {q.trim().length >= 2 && !busy && !results.length && <div className="nempty">Nothing in the project mentions “{q.trim()}”.</div>}
        </div>
        <div className="pfoot"><span><span className="kbdk">↑</span> <span className="kbdk">↓</span> to move</span><span><span className="kbdk">Enter</span> to open</span><span><span className="kbdk">Esc</span> to close</span></div>
      </div>
    </div>
  );
}

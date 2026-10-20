// "How huddle works" and the guided tour: a spotlight on one part of the page at a time, with an
// arrow to it. Steps whose part isn't visible (the sidebar on a phone) are skipped.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { S, go } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { store } from '../lib/words.js';
import Icon from './Icon.jsx';

const ITEMS = [
  ['join', 'See what everyone is doing', 'The team list shows what each person and their agent are working on. Every agent is told when someone starts something new.'],
  ['lock', 'No overwrites', 'A file an agent is editing is locked for everyone else. Whole folders can be locked for bigger changes.'],
  ['send', 'Hand off work', "Send a request to the team and one agent splits it into tasks, or send it to one person's agent. Each runs as its own agent in the background."],
  ['tasks', 'Track progress and cost', 'The Tasks board shows who owns what and how far along it is, and Usage shows what the tokens would cost.'],
  ['brief', 'Shared brief and memory', 'Every agent reads the project brief, team memory and skills when it starts. Search finds anything the team has said or done.'],
  ['git', 'Code, conflicts and GitHub', "Browse everyone's shared code, see merge conflicts before they happen, and connect your GitHub repository for branches, checks and pull requests."],
];
const TOUR = [
  { el: '#rail .navlist', t: 'Pages', p: 'Activity shows everything as it happens. Tasks is the board. Code, Brief & memory, Usage & cost, Health and settings are the rest.' },
  { el: '#team', t: 'Who is working', p: 'What each person and their agent are doing, and how much usage they have left. Click someone to see only their activity.' },
  { el: '#feed', t: 'Activity', p: 'Prompts, agent steps and replies, and messages, newest at the bottom.', view: 'activity' },
  { el: '#composer', t: 'New request', p: "Send work to the team, and one agent splits it up by remaining usage, or to one person's agent." },
  { el: '#side', t: 'Tasks and files', p: 'Requests in progress, files an agent is editing right now, and anything waiting for your OK.' },
  { el: '.searchbtn', t: 'Search and shortcuts', p: 'Search tasks, messages, memory and code. Press / to search, ? for every keyboard shortcut.' },
  { el: '.mybtn', t: 'Your agent', p: 'Choose what your agent does without you. Active runs requests, answers messages and takes team tasks. Requests only skips team tasks. Off runs nothing until you are back.' },
  { el: '.projbtn', t: 'Switch projects', p: 'Switch to another project, or go back to the home screen.' },
];
const seen = () => store.set('huddle.helpSeen', '1');
const shown = (el) => { if (!el || el.closest('[hidden]')) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; };

export default function Help() {
  useS();
  const [at, setAt] = useState(-1), [steps, setSteps] = useState([]), [tip, setTip] = useState(null), [shade, setShade] = useState(null), [arrow, setArrow] = useState('');
  const tipEl = useRef(null);

  const end = () => { setAt(-1); setTip(null); setShade(null); setArrow(''); seen(); };
  function start() {
    S.help = false; seen();
    if (S.view !== 'activity') go('activity');
    setTimeout(() => { const s = TOUR.filter(x => shown(document.querySelector(x.el))); setSteps(s); if (s.length) goTo(0, s); }, 60);
  }
  function goTo(i, list = steps) {
    if (i < 0) i = 0;
    if (i >= list.length) return end();
    const st = list[i];
    if (st.view && S.view !== st.view) go(st.view);
    const el = document.querySelector(st.el);
    if (!shown(el)) return goTo(i + 1, list);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setAt(i);
  }
  // place the spotlight, the card and the arrow whenever the step or the window changes
  const place = () => {
    if (at < 0 || !steps[at]) return;
    const el = document.querySelector(steps[at].el);
    if (!el) return;
    const W = innerWidth, H = innerHeight, pad = 6, gap = 58, r0 = el.getBoundingClientRect();
    const r = { left: Math.max(4, r0.left - pad), top: Math.max(4, r0.top - pad), right: Math.min(W - 4, r0.right + pad), bottom: Math.min(H - 4, r0.bottom + pad) };
    setShade(r);
    const tw = tipEl.current ? tipEl.current.offsetWidth : 320, th = tipEl.current ? tipEl.current.offsetHeight : 160;
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    const cX = (x) => Math.max(12, Math.min(x, W - tw - 12)), cY = (y) => Math.max(12, Math.min(y, H - th - 12));
    const spots = [{ ok: r.bottom + gap + th < H, x: cX(cx - tw / 2), y: r.bottom + gap, from: 'top' }, { ok: r.top - gap - th > 0, x: cX(cx - tw / 2), y: r.top - gap - th, from: 'bottom' },
      { ok: r.right + gap + tw < W, x: r.right + gap, y: cY(cy - th / 2), from: 'left' }, { ok: r.left - gap - tw > 0, x: r.left - gap - tw, y: cY(cy - th / 2), from: 'right' }];
    const s = spots.find(x => x.ok) || { x: cX(r.right - tw - 24), y: cY(r.bottom - th - 24), from: null };
    setTip({ x: s.x, y: s.y });
    if (!s.from) return setArrow('');
    const s0 = s.from === 'top' ? [s.x + tw / 2, s.y - 4] : s.from === 'bottom' ? [s.x + tw / 2, s.y + th + 4] : s.from === 'left' ? [s.x - 4, s.y + th / 2] : [s.x + tw + 4, s.y + th / 2];
    const tx = Math.max(r.left + 14, Math.min(s0[0], r.right - 14)), ty = Math.max(r.top + 10, Math.min(s0[1], r.bottom - 10));
    const e0 = s.from === 'top' ? [tx, r.bottom + 4] : s.from === 'bottom' ? [tx, r.top - 4] : s.from === 'left' ? [r.right + 4, ty] : [r.left - 4, ty];
    const mx = (s0[0] + e0[0]) / 2 + (s.from === 'top' || s.from === 'bottom' ? 18 : 0), my = (s0[1] + e0[1]) / 2 + (s.from === 'left' || s.from === 'right' ? -18 : 0);
    setArrow(`M${s0[0]},${s0[1]} Q${mx},${my} ${e0[0]},${e0[1]}`);
  };
  useLayoutEffect(() => { place(); }, [at, steps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (at < 0) return;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); end(); } else if (e.key === 'ArrowRight') goTo(at + 1); else if (e.key === 'ArrowLeft') goTo(at - 1); };
    addEventListener('keydown', onKey); addEventListener('resize', place);
    return () => { removeEventListener('keydown', onKey); removeEventListener('resize', place); };
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tip && tipEl.current) tipEl.current.querySelector('[data-next]')?.focus(); }, [at, !!tip]);
  useEffect(() => {
    if (!S.help) return;
    const h = (e) => { if (e.key === 'Escape') { S.help = false; seen(); } };
    addEventListener('keydown', h); return () => removeEventListener('keydown', h);
  }, [S.help]);

  return (
    <>
      {S.help && (
        <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) { S.help = false; seen(); } }}>
          <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="ovtitle" style={{ width: 'min(760px,100%)', maxHeight: '90vh', overflow: 'auto', padding: 0 }}>
            <div className="ovhead"><h3 id="ovtitle">How huddle works</h3><p>Everyone's coding agent (Claude Code, Codex or Cursor) works on the same project at the same time, each from their own computer, without overwriting each other.</p></div>
            <ul className="ovlist">{ITEMS.map(([ic, t, d]) => <li key={t}><span className="oi"><Icon name={ic} size={20} /></span><div><b>{t}</b><span>{d}</span></div></li>)}</ul>
            <div className="ovmodes"><b>What your agent does without you</b><table><tbody>
              <tr><th>Active</th><td>Runs requests and answers messages sent to your agent, and plans and takes team tasks. The default.</td></tr>
              <tr><th>Requests only</th><td>Runs requests and answers messages sent to your agent. Leaves team tasks to others.</td></tr>
              <tr><th>Off</th><td>Nothing runs in the background. Requests and messages wait until you open your agent in the project.</td></tr></tbody></table>
              <span className="small muted">Requests never need approval. Commands outside the allowed list always do, in every mode.</span></div>
            <div className="ovfoot"><button onClick={() => { S.help = false; seen(); }}>Close</button><button className="primary" onClick={start}>Take the tour</button></div>
          </div>
        </div>
      )}
      {at >= 0 && shade && steps[at] && (
        <>
          <div id="tour-block" role="presentation" onClick={() => goTo(at + 1)}></div>
          <div id="tour-shade" style={{ left: shade.left, top: shade.top, width: shade.right - shade.left, height: shade.bottom - shade.top }}></div>
          <svg id="tour-arrow" aria-hidden="true" style={{ left: 0, top: 0, width: innerWidth, height: innerHeight }}><defs><marker id="tour-head" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1l8 4-8 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></marker></defs><path d={arrow} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" markerEnd="url(#tour-head)" /></svg>
          <div id="tour-tip" ref={tipEl} role="dialog" aria-live="polite" aria-labelledby="tourt" style={{ left: tip ? tip.x : 12, top: tip ? tip.y : 12 }}>
            <h4 id="tourt">{steps[at].t}</h4><p>{steps[at].p}</p>
            <div className="tnav"><span className="tdots" aria-label={`Step ${at + 1} of ${steps.length}`}>{steps.map((_, k) => <i key={k} className={k === at ? 'on' : ''}></i>)}</span><span className="grow"></span>
              {at ? <button className="ghost" onClick={() => goTo(at - 1)}>Back</button> : <button className="ghost" onClick={end}>Skip</button>}
              <button className="primary" data-next onClick={() => goTo(at + 1)}>{at === steps.length - 1 ? 'Done' : 'Next'}</button></div>
          </div>
        </>
      )}
    </>
  );
}

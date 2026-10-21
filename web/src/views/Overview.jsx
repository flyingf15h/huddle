// Overview: today in numbers, everyone's usage window, what's being worked on, and what needs me.
// Drawn as terminal panes; each stat pane reads like the output of the huddle command that shows it.
import { useEffect, useRef, useState } from 'react';
import { S, api, go, myName, myTool, dn, keys, auth, people, usageOf, toolOf } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useLive } from '../lib/hooks.js';
import { ago } from '../lib/words.js';
import { titleOf, stuckReason, decide, runAgain } from '../lib/tasks.js';

const today = () => new Date().toISOString().slice(0, 10);
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const hm = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? [[m, 'm']] : [[Math.floor(m / 60), 'h'], [m % 60, 'm']]; };
const short = (t) => ago(t).replace(/ ago$/, '').replace(/^just now$/, 'now').replace(/ minutes?/, 'm').replace(/ hours?/, 'h').replace(/ days?/, 'd');
const STATUS = { doing: ['working', 'a'], todo: ['queued', ''], blocked: ['stuck', 'w'], done: ['done', 'g'] };

function Pane({ title, right, hot, className = '', children }) {
  return (
    <section className={'pane ' + className + (hot ? ' hot' : '')}>
      <header className="pt"><b>{title}</b>{right}</header>
      {children}
    </section>
  );
}
// a bracketed action: [ label ]
const Act = ({ main, disabled, onClick, children }) => <button className={'bact' + (main ? ' main' : '')} disabled={disabled} onClick={onClick}>{children}</button>;

export default function Overview() {
  useS();
  const [stats, setStats] = useState(null), [err, setErr] = useState({});
  const timer = useRef(null);
  const load = () => api('stats').then(r => setStats(r.stats)).catch(() => setStats({}));
  useEffect(() => { load(); }, []);
  useLive((ev) => { if (ev.type === 'stats') { clearTimeout(timer.current); timer.current = setTimeout(load, 1500); } });

  const me = myName();
  const since = midnight();
  const todays = S.board.tasks.filter(t => (t.at || 0) >= since);
  const count = (st) => todays.filter(t => t.status === st).length;

  // agent time today, from each person's counted active time
  const day = today();
  const time = Object.entries(stats || {}).map(([name, s]) => ({ name, ms: ((s.days || {})[day] || {}).activeMs || 0 })).filter(x => x.ms > 0).sort((a, b) => b.ms - a.ms);
  const totalMs = time.reduce((n, x) => n + x.ms, 0);

  const team = people();
  const RANK = { blocked: 0, doing: 1, todo: 2, done: 3 };
  const tasks = S.board.tasks.filter(t => t.status !== 'done' || (t.updated || t.at) > Date.now() - 864e5)
    .sort((a, b) => RANK[a.status] - RANK[b.status] || (b.updated || b.at) - (a.updated || a.at)).slice(0, 8);

  // needs you: commands waiting for my OK, stuck work that's mine or that I asked for, my merge conflicts
  const groups = new Map();
  for (const x of S.approvals.filter(a => a.owner === me)) { const k = x.taskId || x.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const canHere = !!keys[auth.project];
  const choose = (list, allow) => decide(list.map(x => x.id), allow).catch(e => setErr(m => ({ ...m, [list[0].id]: /huddle open/.test(e.message) ? 'open the dashboard with huddle open to decide here' : e.message })));
  const needs = [
    ...S.board.tasks.filter(t => t.status === 'blocked' && (t.owner === me || t.by === me)).map(t => ({
      key: t.id, shut: true, at: t.updated || t.at, title: 'Stuck, waiting on you',
      text: stuckReason(t) || titleOf(t).title, sub: titleOf(t).title + (t.owner && t.owner !== me ? ' · ' + dn(t.owner) : ''),
      acts: [['open', () => go('tasks', { task: t.id }), true], ['run again', () => runAgain(t)]],
    })),
    ...[...groups.values()].map(list => {
      const t = S.board.tasks.find(y => y.id === list[0].taskId);
      return {
        key: list[0].id, at: list[0].at, title: 'Needs your OK',
        text: <>your {myTool()} wants to run {list.map((x, i) => <span key={x.id}>{i ? ', ' : ''}<code>{x.command}</code></span>)}</>,
        sub: t ? titleOf(t).title : list[0].title,
        acts: [[list.length > 1 ? 'allow all' : 'allow', () => choose(list, true), true, !canHere], [list.length > 1 ? 'deny all' : 'deny', () => choose(list, false), false, !canHere]],
        note: err[list[0].id] || (!canHere ? 'to decide here, open the dashboard with huddle open, or run huddle approve --all' : ''),
      };
    }),
    ...S.conflicts.filter(c => c.owner === me || c.items.some(x => x.other.startsWith(me + '/'))).flatMap(c => c.items.map(x => ({
      key: c.owner + c.branch + x.other, at: c.at, title: 'Merge conflict',
      text: <>{c.owner}/{c.branch} and {x.other} both changed {x.files.slice(0, 2).map((f, i) => <span key={f}>{i ? ', ' : ''}<code>{f}</code></span>)}{x.files.length > 2 ? ` and ${x.files.length - 2} more` : ''}</>,
      sub: 'merge before more work piles up',
      acts: [[`ask ${c.owner === me ? 'your ' + myTool() : dn(c.owner)}`, () => { S.askTo = c.owner; go('activity'); }, true]],
    }))),
  ].sort((a, b) => (b.at || 0) - (a.at || 0));

  return (
    <main data-main className="overview">
      <div className="ogrid">
        <Pane title="requests" right={<span>today</span>} className="p-stat">
          <div className="cmdl"><span>$</span>huddle board</div>
          <div className="out"><b>{todays.length}</b>{todays.length === 1 ? 'request' : 'requests'}<br />
            <i className="g">{count('done')}</i> done  <i className="a">{count('doing')}</i> working  <i className="w">{count('blocked')}</i> stuck{count('todo') ? <>  <i>{count('todo')}</i> queued</> : null}</div>
        </Pane>
        <Pane title="agent time" right={<span>today</span>} className="p-stat">
          <div className="cmdl"><span>$</span>huddle cost</div>
          {stats === null ? <div className="out muted">counting…</div> : (
            <div className="out"><b>{totalMs ? hm(totalMs).map(([n, u]) => n + u).join(' ') : '0m'}</b>{time.length ? `across ${time.length} ${time.length === 1 ? 'agent' : 'agents'}` : 'no agent time yet today'}<br />
              {time.slice(0, 4).map(x => <span key={x.name} className="tper">{dn(x.name)} {hm(x.ms).map(([n, u]) => n + u).join(' ')}</span>)}</div>
          )}
        </Pane>
        <Pane title="usage" right={<span>5-hour window</span>} className="p-use">
          {team.map(p => {
            const u = usageOf(p.name), used = u ? 100 - u.left : null, on = used == null ? 0 : Math.round(used / 100 * 12);
            return (
              <div className={'u5' + (used != null && used >= 65 ? ' high' : '')} key={p.name} title={u ? u.title : `${dn(p.name)} hasn't reported usage`}>
                <i className={'sdot' + (p.online ? '' : ' off')}></i><span className="nm">{dn(p.name)}</span><span className="tool">{toolOf(p.name).toLowerCase()}</span>
                <span className="bar5" aria-hidden="true">[{[...Array(12)].map((_, i) => <i key={i} className={i < on ? 'on' : ''}></i>)}]</span>
                <b>{used == null ? '--' : used + '%'}</b>
              </div>
            );
          })}
          {!team.length && <div className="quiet">nobody has joined yet</div>}
        </Pane>

        <Pane title="current tasks" right={<button onClick={() => go('tasks')}>open board</button>} className="p-req">
          <div className="th5"><span>request</span><span>status</span><span>who</span><span>age</span></div>
          {tasks.map(t => {
            const tt = titleOf(t), [word, tone] = STATUS[t.status] || [t.status, ''];
            return (
              <button className="r5" key={t.id} data-nav onClick={() => go('tasks', { task: t.id })} title={tt.title}>
                <span className="t"><span className="tl">{tt.title}</span><small>{t.status === 'blocked' ? stuckReason(t) : t.by && t.by !== t.owner ? `asked by ${dn(t.by)}` : goalLine(t)}</small></span>
                <span className={'st ' + tone}><i></i>{word}</span>
                <span className="who">{t.owner ? dn(t.owner) : '--'}</span>
                <span className="tm">{short(t.updated || t.at)}</span>
              </button>
            );
          })}
          {!tasks.length && <div className="quiet">nothing on the board. <button className="link" onClick={() => { go('activity'); }}>send a request</button></div>}
        </Pane>

        <Pane title={`needs you (${needs.length})`} hot={needs.length > 0} className="p-needs">
          {needs.map(n => (
            <div className="n5" key={n.key}>
              <span className={'sh4' + (n.shut ? ' shut' : '')} title={n.title}></span>
              <div className="nb"><p>{n.text}</p><small>{n.sub}</small>
                <div className="do5">{n.acts.map(([l, fn, main, dis]) => <Act key={l} main={main} disabled={dis} onClick={fn}>{l}</Act>)}</div>
                {n.note && <small className="nnote">{n.note}</small>}</div>
              <span className="age">{n.at ? short(n.at) : ''}</span>
            </div>
          ))}
          {!needs.length && <div className="quiet">nothing needs you right now</div>}
        </Pane>
      </div>
    </main>
  );
}

function goalLine(t) {
  const g = S.board.goals.find(x => x.id === t.goalId);
  return g ? 'part of: ' + titleOf({ title: g.text || g.title || '' }).title : '';
}

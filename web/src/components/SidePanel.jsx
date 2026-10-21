// Beside the feed: commands waiting for my OK, requests in progress, files being edited, recent changes.
import { useState } from 'react';
import { S, go, myName, myTool, dn, keys, auth } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { ago, shortTitle } from '../lib/words.js';
import { titleOf, decide, stuckReason, canDecide } from '../lib/tasks.js';
import Icon from './Icon.jsx';
import Avatar from './Avatar.jsx';

export default function SidePanel() {
  useS();
  const [askErr, setAskErr] = useState({});
  const mine = S.approvals.filter(x => x.owner === myName());
  const groups = new Map();
  for (const x of mine) { const k = x.taskId || x.id; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
  const asks = [...groups.values()];
  const canHere = canDecide();
  const RANK = { blocked: 0, doing: 1, todo: 2 };
  const live = S.board.tasks.filter(t => t.status !== 'done').sort((a, b) => RANK[a.status] - RANK[b.status] || (b.updated || b.at) - (a.updated || a.at)).slice(0, 8);
  const locks = Object.values(S.locks);
  const files = Object.values(S.files).filter(f => f.size).sort((a, b) => b.at - a.at).slice(0, 8);
  const myConflicts = S.conflicts.filter(c => c.owner === myName() || c.items.some(x => x.other.startsWith(myName() + '/')));
  const choose = async (list, allow) => {
    try { await decide(list.map(x => x.id), allow); } catch (e) { setAskErr({ ...askErr, [list[0].id]: /huddle open/.test(e.message) ? 'Open the dashboard with huddle open on your computer to decide here.' : e.message }); }
  };
  return (
    <aside id="side">
      {asks.length > 0 && (
        <div id="asks"><h3>needs your ok ({asks.length})</h3>
          {asks.map(list => {
            const t = S.board.tasks.find(y => y.id === list[0].taskId);
            return (
              <div className="ask" key={list[0].id}>
                {list[0].title && <div className="ahead">{t && t.by && t.by !== myName() ? `${t.by}'s request: ` : ''}<b>{shortTitle(list[0].title, 70)}</b></div>}
                <div className="small faint">your {myTool().toLowerCase()} wants to run</div>
                <ul className="acmds">{list.map(x => <li key={x.id}><code>{x.command}</code>{x.why && <span className="why">{x.why}</span>}</li>)}</ul>
                <div className="row"><button className="bact main" disabled={!canHere} onClick={() => choose(list, true)}>{list.length > 1 ? 'allow all' : 'allow'}</button><button className="bact" disabled={!canHere} onClick={() => choose(list, false)}>{list.length > 1 ? 'deny all' : 'deny'}</button><span className="err">{askErr[list[0].id] || ''}</span></div>
                {!canHere && <div className="small faint">to decide here: <code>huddle open</code>, or turn on deciding in the dashboard (settings → rules)</div>}
              </div>
            );
          })}
        </div>
      )}
      {myConflicts.length > 0 && (
        <>
          <h2>Merge conflicts</h2>
          {myConflicts.flatMap(c => c.items.map(x => (
            <button key={c.owner + c.branch + x.other} className="row-item" data-nav onClick={() => go('code')}><span className="grow"><span className="path">{c.owner}/{c.branch} ↔ {x.other}</span><br /><span className="small muted">{x.files.slice(0, 3).join(', ')}{x.files.length > 3 ? ` +${x.files.length - 3}` : ''}</span></span></button>
          )))}
        </>
      )}
      <h2>Tasks <button className="link small" style={{ marginLeft: 'auto' }} onClick={() => go('tasks')}>Open board</button></h2>
      {live.map(t => {
        const tt = titleOf(t);
        return (
          <button key={t.id} className={'trow ' + t.status} data-nav onClick={() => go('tasks', { task: t.id })} title={tt.title}>
            <span className={'dot ' + t.status} aria-hidden="true"></span>
            <span className="tmain"><span className="tt">{tt.tag && <span className="ttag">{tt.tag}</span>}{tt.title}</span>
              {t.status === 'blocked' ? <span className="twhy">{stuckReason(t)}</span> : t.status === 'doing' ? <span className="tmeta"><span className="st doing">Working on it</span><span>{ago(t.updated || t.at)}</span></span> : null}</span>
            <span className="towner">{t.owner ? <><Avatar name={t.owner} sm /><span>{dn(t.owner)}</span></> : <span className="faint">Unassigned</span>}</span>
          </button>
        );
      })}
      {!live.length && <div className="quiet">Nothing in progress.</div>}
      <h2>Being edited now <span className="count">{locks.length || ''}</span></h2>
      {locks.map(l => (
        <button key={(l.branch || '') + l.path} className="row-item" data-nav onClick={() => (S.fileOpen = { path: l.path, branch: l.branch || null })}><Avatar name={l.holderName} sm /><span className="grow"><span className="path">{l.path}{l.dir && <> <span className="faint">(whole folder)</span></>}</span><br /><span className="small muted">{l.holderName} · {ago(l.since)}{l.branch ? ' · ' + l.branch : ''}</span></span><span className="lockic" aria-label="locked"><Icon name="lock" size={13} /></span></button>
      ))}
      {!locks.length && <div className="quiet">No files are locked.</div>}
      <h2>Recently changed</h2>
      {files.map(f => <button key={(f.branch || '') + f.path} className="row-item" data-nav onClick={() => (S.fileOpen = { path: f.path, branch: f.branch || null })}><Avatar name={f.byName} sm /><span className="grow"><span className="path">{f.path}</span><br /><span className="small muted">{f.byName} · {ago(f.at)}</span></span></button>)}
      {!files.length && <div className="quiet">No recent changes.</div>}
    </aside>
  );
}

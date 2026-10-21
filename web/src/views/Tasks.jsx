// Tasks: every task as a card in To do / In progress / Stuck / Done, filtered by person and words.
// Drag a card to another column, or open it for details, comments, runs, checks and cost.
import { useEffect, useState } from 'react';
import { S, go, myName, dn, people, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { ago, statusWord, EFFORT_WORD, fmtDur } from '../lib/words.js';
import { COLUMNS, titleOf, goalOf, waitsOn, checks, stuckReason, money, RUN_WORD, runPill, setStatus, runAgain, markDone, editTask, comment, deleteTask } from '../lib/tasks.js';
import Avatar from '../components/Avatar.jsx';
import Icon from '../components/Icon.jsx';
import Resizer from '../components/Resizer.jsx';

export default function Tasks() {
  useS();
  const [who, setWho] = useState('all'), [q, setQ] = useState(''), [showDone, setShowDone] = useState(false), [dragging, setDragging] = useState(null), [over, setOver] = useState(null);
  const [note, setNote] = useState(''), [editing, setEditing] = useState(false), [draft, setDraft] = useState({});
  const team = people().map(p => p.name);
  const shown = S.board.tasks.filter(t => (who === 'all' || (who === 'mine' ? t.owner === myName() : who === 'none' ? !t.owner : t.owner === who)) && (!q || (t.title + ' ' + (t.detail || '')).toLowerCase().includes(q.toLowerCase())));
  const byCol = Object.fromEntries(COLUMNS.map(([k]) => [k, shown.filter(t => t.status === k).sort((a, b) => (b.updated || b.at) - (a.updated || a.at)).slice(0, k === 'done' && !showDone ? 15 : 200)]));
  const open = S.board.tasks.find(t => t.id === S.openTask) || null;
  useEffect(() => { setEditing(false); setNote(''); }, [S.openTask]);

  const select = (t) => { S.openTask = S.openTask === t.id ? null : t.id; };
  const drop = (col) => { if (dragging && dragging.status !== col) setStatus(dragging, col); setDragging(null); setOver(null); };
  const startEdit = () => { setDraft({ title: open.title, detail: open.detail || '', effort: open.effort || '', owner: open.owner || '' }); setEditing(true); };
  const saveEdit = async () => { await editTask(open, { title: draft.title, detail: draft.detail, effort: draft.effort || null, owner: draft.owner || null }); setEditing(false); };
  const send = async () => { if (!note.trim()) return; await comment(open, note.trim()); setNote(''); };
  // with a card focused: 1-4 move it to that column
  const onKey = (e) => {
    if (e.target.dataset && e.target.dataset.task && /^[1-4]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
      const t = S.board.tasks.find(x => x.id === e.target.dataset.task);
      if (t) { e.preventDefault(); setStatus(t, COLUMNS[Number(e.key) - 1][0]); }
    }
  };
  const tt = open ? titleOf(open) : null, g = open ? goalOf(open) : null;

  return (
    <main data-main className="tview" onKeyDown={onKey}>
      <div className="tbar">
        <div className="seg sm" role="group" aria-label="Whose">{[['all', 'Everyone'], ['mine', 'Mine'], ['none', 'Unassigned']].map(([k, l]) => <button key={k} className={who === k ? 'on' : ''} onClick={() => setWho(k)}>{l}</button>)}</div>
        <select aria-label="Person" value={['all', 'mine', 'none'].includes(who) ? '' : who} onChange={(e) => setWho(e.target.value || 'all')}><option value="">Anyone</option>{team.map(n => <option key={n} value={n}>{dn(n)}</option>)}</select>
        <input type="search" placeholder="Filter tasks" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter tasks" />
        <span className="grow"></span>
        <span className="small muted hide-sm">Drag cards between columns, or focus one and press 1 to 4</span>
      </div>
      <div className={'tbody2' + (open ? '' : ' nodetail')}>
        {open && <Resizer which="detail" label="Resize the task details" />}
        <div className="cols">
          {COLUMNS.map(([k, label]) => (
            <section key={k} className={'col' + (over === k ? ' drop' : '')} aria-label={label}
              onDragOver={(e) => { e.preventDefault(); setOver(k); }} onDragLeave={() => setOver(over === k ? null : over)} onDrop={(e) => { e.preventDefault(); drop(k); }}>
              <h3><span className={'dot ' + k} aria-hidden="true"></span><span className="cl">{label}</span><span className="count">{shown.filter(t => t.status === k).length}</span></h3>
              {byCol[k].map(t => {
                const x = titleOf(t), gg = goalOf(t);
                return (
                  <button key={t.id} className={'tcard' + (S.openTask === t.id ? ' sel' : '')} data-nav data-task={t.id} draggable onDragStart={() => setDragging(t)} onDragEnd={() => { setDragging(null); setOver(null); }} onClick={() => select(t)}>
                    <span className="tt">{x.tag && <span className="ttag">{x.tag}</span>}{x.title}</span>
                    {t.status === 'blocked' && <span className="twhy" style={{ whiteSpace: 'normal' }}>{stuckReason(t)}</span>}
                    {gg && !t.direct && gg.title && <span className="small faint">Part of {gg.title}</span>}
                    <span className="tm">
                      {t.owner ? <><Avatar name={t.owner} sm /><span>{dn(t.owner)}</span></> : <span className="faint">Unassigned</span>}
                      <span className="grow"></span>
                      {checks(t).filter(c => c.tone !== 'good').map(c => <span key={c.text} className={'ck ' + c.tone}>{c.text}</span>)}
                      {t.usage && t.usage.cost > 0 && <span title="API-equivalent cost">{money(t.usage.cost)}</span>}
                      <span>{ago(t.updated || t.at).replace(' ago', '')}</span>
                    </span>
                  </button>
                );
              })}
              {!byCol[k].length && <div className="quiet" style={{ padding: '4px 12px 12px' }}>{k === 'blocked' ? 'nothing blocked' : 'none'}</div>}
              {k === 'done' && !showDone && shown.filter(t => t.status === 'done').length > 15 && <button className="link small" style={{ margin: '0 12px 10px' }} onClick={() => setShowDone(true)}>Show all</button>}
            </section>
          ))}
        </div>
        {open && (
          <aside className="tdpanel" aria-label="Task details">
            <div className="row" style={{ marginTop: 0 }}><span className={'pill ' + (open.status === 'done' ? 'ok' : open.status === 'blocked' ? 'bad' : open.status === 'doing' ? 'acc' : '')}>{statusWord(open.status)}</span>
              {open.effort && <span className="pill">{EFFORT_WORD[open.effort]} job</span>}<span className="grow"></span>
              <button className="ghost iconbtn sm" aria-label="Close" onClick={() => (S.openTask = null)}><Icon name="close" size={16} /></button></div>
            {editing ? (
              <div className="fieldset">
                <div><label htmlFor="tdt">Title</label><input id="tdt" type="text" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} /></div>
                <div><label htmlFor="tdd">Details</label><textarea id="tdd" value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} style={{ minHeight: 120 }} /></div>
                <div className="row"><label htmlFor="tdo">Owner</label><select id="tdo" value={draft.owner} onChange={(e) => setDraft({ ...draft, owner: e.target.value })}><option value="">Unassigned</option>{team.map(n => <option key={n} value={n}>{dn(n)}</option>)}</select>
                  <label htmlFor="tde">Size</label><select id="tde" value={draft.effort} onChange={(e) => setDraft({ ...draft, effort: e.target.value })}><option value="">Not sized</option><option value="light">Small</option><option value="medium">Medium</option><option value="heavy">Big</option></select></div>
                <div className="row"><button className="primary" onClick={saveEdit}>Save</button><button onClick={() => setEditing(false)}>Cancel</button></div>
              </div>
            ) : (
              <>
                <h2>{tt.title}</h2>
                <div className="small muted">Asked by {dn(open.by)} {ago(open.at)}{g && g.title && !open.direct ? ` · part of “${g.title}”` : ''}</div>
                <div className="row">
                  <select aria-label="Status" value={open.status} onChange={(e) => setStatus(open, e.target.value)}>{COLUMNS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                  {open.status !== 'done' && <><button onClick={() => runAgain(open)}>Run again</button><button onClick={() => markDone(open)}>Mark done</button></>}
                  <button className="ghost" onClick={startEdit}>Edit</button>
                </div>
                <div className="lbl">Owner</div>
                <div className="row" style={{ margin: 0 }}>{open.owner ? <><Avatar name={open.owner} sm /><span>{dn(open.owner)}</span><button className="link small" onClick={() => { S.who = open.owner; go('activity'); }}>See their work</button></> : <span className="muted">Unassigned: the next free agent takes it</span>}</div>
                {open.detail && open.detail.trim() !== open.title.trim() && <><div className="lbl">Details</div><div className="detail">{open.detail}</div></>}
                {waitsOn(open).length > 0 && <><div className="lbl">Waiting for</div>{waitsOn(open).map(w => <div key={w.id}><button className="link" onClick={() => (S.openTask = w.id)}>{titleOf(w).title}</button></div>)}</>}
                {open.waitsFor && open.waitsFor.length > 0 && open.status === 'todo' && <><div className="lbl">Held back</div><div className="small muted">Touches the same files as work in progress: {open.waitsFor.map(w => `${w.title} (${w.file})`).join('; ')}. It starts when that finishes.</div></>}
                {open.diff && open.diff.files && <><div className="lbl">Changes</div><div className="row" style={{ margin: 0 }}><button onClick={() => (S.diffOpen = open.id)}>Review changes ({open.diff.files.length} file{open.diff.files.length === 1 ? '' : 's'} <span className="dadd">+{open.diff.add}</span> <span className="ddel">−{open.diff.del}</span>)</button>
                  {open.diff.review && <span className={'pill ' + (open.diff.review.verdict === 'approved' ? 'ok' : 'warn')}>{open.diff.review.verdict === 'approved' ? 'Approved' : 'Changes requested'}</span>}
                  {open.diff.left && <span className="pill warn" title={open.diff.branch || ''}>Left on a branch</span>}</div></>}
                {open.paths && open.paths.length > 0 && <><div className="lbl">Works in</div><div className="mono small">{open.paths.join(', ')}</div></>}
                {(checks(open).length > 0 || (open.checks && open.checks.pr)) && (
                  <><div className="lbl">Checks</div>
                    <div className="tmeta">{checks(open).map(c => <span key={c.text} className={'ck ' + c.tone} title={c.title || ''}>{c.text}</span>)}</div>
                    {open.checks && open.checks.pr && <p className="small"><a href={open.checks.pr} target="_blank" rel="noopener noreferrer">{open.checks.pr.replace(/^https:\/\/github\.com\//, '')}</a> <span className={'pill ' + (open.checks.prState === 'merged' ? 'ok' : open.checks.prState === 'closed' ? 'bad' : 'acc')}>{({ open: 'Open', merged: 'Merged', closed: 'Closed' })[open.checks.prState] || 'Open'}</span></p>}</>
                )}
                {open.usage && open.usage.tokens > 0 && <><div className="lbl">Cost</div><div className="small">{money(open.usage.cost)} at API prices · {Math.round(open.usage.tokens / 1000)}k tokens</div></>}
                {open.runs && open.runs.length > 0 && (
                  <><div className="lbl">Background runs</div>
                    <div className="runs">{open.runs.slice(-5).map((r, i) => <div key={i}><span className={'pill ' + runPill(r.outcome)}>{RUN_WORD[r.outcome] || r.outcome}</span><span>Attempt {r.attempt} by {r.by}'s {r.agent === 'codex' ? 'Codex' : r.agent === 'cursor' ? 'Cursor' : 'Claude'}{r.ms ? ', ' + fmtDur(r.ms) : ''}, {ago(r.at)}{r.error ? ': ' + r.error.slice(0, 160) : ''}</span></div>)}</div></>
                )}
                <div className="lbl">Notes and comments</div>
                <div className="notes">
                  {(open.notes || []).slice().reverse().map((n, i) => <div className="noteitem" key={i}><b>{dn(n.by)}</b> <span className="faint small">{ago(n.at)}</span><div style={{ whiteSpace: 'pre-wrap' }}>{n.text}</div></div>)}
                  {!(open.notes || []).length && <div className="quiet">None yet.</div>}
                </div>
                <div style={{ marginTop: 10 }}><textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a comment (the owner's agent sees it next time it runs this task)" aria-label="Comment" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
                  <div className="row"><button className="primary" disabled={!note.trim()} onClick={send}>Comment</button><span className="grow"></span>
                    {(open.by === myName() || isOwner()) && <button className="danger" onClick={() => { if (confirm('Delete this task?')) { deleteTask(open); S.openTask = null; } }}>Delete</button>}</div></div>
              </>
            )}
          </aside>
        )}
      </div>
    </main>
  );
}

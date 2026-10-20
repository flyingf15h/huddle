// Review what an agent changed: the files with +/- counts, the diff, click a line to comment on it.
// Approve, or send the comments back (the agent runs the task again), or merge work left on a branch.
import { useEffect, useMemo, useRef, useState } from 'react';
import { S, api, dn, loadBoard } from '../lib/state.js';
import { ago } from '../lib/words.js';

// unified diff text -> [{ path, lines: [{ kind: 'add' | 'del' | 'ctx' | 'hunk', n, text }] }]
export function parseDiff(text) {
  const files = [];
  let cur = null, n = 0;
  for (const raw of String(text || '').split('\n')) {
    if (raw.startsWith('diff --git ')) { cur = { path: (raw.match(/ b\/(.+)$/) || [])[1] || raw, lines: [] }; files.push(cur); continue; }
    if (!cur) continue;
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(raw)) { if (raw.startsWith('+++ ') && raw.slice(4) !== '/dev/null') cur.path = raw.slice(4).replace(/^b\//, ''); continue; }
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (h) { n = Number(h[1]); cur.lines.push({ kind: 'hunk', text: raw }); continue; }
    if (raw.startsWith('+')) cur.lines.push({ kind: 'add', n: n++, text: raw.slice(1) });
    else if (raw.startsWith('-')) cur.lines.push({ kind: 'del', n: 0, text: raw.slice(1) });
    else if (raw.startsWith('\\')) continue;
    else if (raw !== '' || cur.lines.length) cur.lines.push({ kind: 'ctx', n: n++, text: raw.slice(1) });
  }
  return files;
}

export default function DiffDialog() {
  const dlg = useRef(null);
  const id = S.diffOpen;
  const [d, setD] = useState(null), [error, setError] = useState(''), [sel, setSel] = useState(0), [comments, setComments] = useState([]), [at, setAt] = useState(null), [draft, setDraft] = useState(''), [note, setNote] = useState(''), [busy, setBusy] = useState(false), [msg, setMsg] = useState('');
  const files = useMemo(() => parseDiff(d && d.diff), [d]);
  const task = S.board.tasks.find(t => t.id === id);
  const meta = (task && task.diff) || (d && d.meta) || {};

  useEffect(() => {
    const el = dlg.current;
    if (id) {
      setD(null); setError(''); setSel(0); setComments([]); setAt(null); setDraft(''); setNote(''); setMsg('');
      api('task-diff?id=' + encodeURIComponent(id)).then(setD).catch(e => setError(e.message));
      if (!el.open) el.showModal();
    } else if (el.open) el.close();
  }, [id]);

  const f = files[sel];
  const mine = (path) => comments.filter(c => c.file === path);
  const addComment = () => { if (!draft.trim()) return; setComments([...comments, { file: f.path, line: at, text: draft.trim() }]); setAt(null); setDraft(''); };
  const act = async (fn, done) => { setBusy(true); setMsg(''); try { await fn(); await loadBoard(); setMsg(done); } catch (e) { setMsg(e.message); } setBusy(false); };
  const approve = () => act(() => api('task-review', { id, verdict: 'approve', note: note.trim() }), 'Approved.');
  const changes = () => act(() => api('task-review', { id, verdict: 'changes', note: note.trim(), comments }).then(() => dlg.current.close()), 'Sent back.');
  const merge = () => act(() => api('task-merge', { id }), 'Asked for the branch to be merged. It lands the next time the owner\'s agent is running.');
  const rv = meta.review;

  return (
    <dialog ref={dlg} className="diffdlg" onClose={() => (S.diffOpen = null)} onClick={(e) => { if (e.target === dlg.current) dlg.current.close(); }}>
      <div className="dlg-head"><h3>{d ? d.task.title : 'Changes'}</h3><span className="grow"></span>
        <span className="small muted">{meta.files ? `${meta.files.length} file${meta.files.length === 1 ? '' : 's'} · +${meta.add || 0} −${meta.del || 0}` : ''}{meta.at ? ` · ${ago(meta.at)}` : ''}{d ? ` · by ${dn(d.task.owner || '')}'s agent` : ''}</span>
        <button onClick={() => dlg.current.close()}>Close</button></div>
      <div className="dlg-body" style={{ display: 'flex', minHeight: 0 }}>
        {error ? <div style={{ padding: 12 }}>{error}</div> : !d ? <div style={{ padding: 12 }} className="muted">Loading…</div> : !files.length ? <div style={{ padding: 12 }} className="muted">{d.diff ? 'Nothing to show.' : 'The changes were not kept on the server.'}</div> : (
          <>
            <div className="difffiles" role="listbox" aria-label="Files">
              {files.map((x, i) => { const m = (meta.files || []).find(y => y.path === x.path) || {}; return (
                <button key={x.path} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onClick={() => { setSel(i); setAt(null); }}><span className="mono">{x.path}</span><span className="small"><span className="dadd">+{m.add ?? x.lines.filter(l => l.kind === 'add').length}</span> <span className="ddel">−{m.del ?? x.lines.filter(l => l.kind === 'del').length}</span>{mine(x.path).length > 0 && ` · ${mine(x.path).length} 💬`}</span></button>); })}
            </div>
            <div className="diffmain">
              {meta.truncated && <p className="small muted" style={{ margin: 8 }}>This diff was cut short because it is large.</p>}
              {f && <pre className="codebox diff">{f.lines.map((l, i) => (
                <div key={i}>
                  <div className={'ln ' + l.kind} onClick={() => l.kind !== 'hunk' && l.n && (setAt(l.n), setDraft(''))} title={l.n ? 'Click to comment on this line' : ''}>
                    <span>{l.kind === 'hunk' ? '' : l.n || ''}</span><span>{l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : l.kind === 'hunk' ? '' : '  '}{l.text || ' '}</span></div>
                  {mine(f.path).filter(c => c.line === l.n && l.n).map((c, j) => <div className="dcomment" key={j}>💬 {c.text} <button className="link small" onClick={() => setComments(comments.filter(x => x !== c))}>remove</button></div>)}
                  {at === l.n && l.n && <div className="dcomment edit"><textarea autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={`Comment on line ${at}`} aria-label="Comment" onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) addComment(); }} /><div className="row"><button className="primary" disabled={!draft.trim()} onClick={addComment}>Add comment</button><button onClick={() => setAt(null)}>Cancel</button></div></div>}
                </div>))}</pre>}
            </div>
          </>
        )}
      </div>
      {d && (
        <div className="diffbar">
          {rv && <span className={'pill ' + (rv.verdict === 'approved' ? 'ok' : 'warn')}>{rv.verdict === 'approved' ? 'Approved' : 'Changes requested'} by {dn(rv.by)} {ago(rv.at)}</span>}
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" aria-label="Note" style={{ flex: 1, minWidth: 140 }} />
          <span className="small">{msg}</span>
          {meta.left && <button disabled={busy} onClick={merge} title={meta.branch ? 'Branch ' + meta.branch : ''}>Merge now</button>}
          <button disabled={busy || (!comments.length && !note.trim())} onClick={changes}>Request changes{comments.length ? ` (${comments.length})` : ''}</button>
          <button className="primary" disabled={busy} onClick={approve}>Approve</button>
        </div>
      )}
    </dialog>
  );
}

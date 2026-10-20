// A live shared file, updated as its holder edits it; changed lines are highlighted.
import { useEffect, useRef, useState } from 'react';
import { S, api } from '../lib/state.js';
import { useS } from '../lib/store.js';
import Icon from './Icon.jsx';
import { useLive } from '../lib/hooks.js';
import { ago } from '../lib/words.js';

export default function FileDialog() {
  useS();
  const [f, setF] = useState(null), [lines, setLines] = useState([]), [hl, setHl] = useState([-1, -1]), [error, setError] = useState('');
  const dlg = useRef(null), prev = useRef(null);
  const o = S.fileOpen;
  async function load(highlight) {
    if (!S.fileOpen) return;
    const { path, branch } = S.fileOpen;
    try {
      const r = await api('file?path=' + encodeURIComponent(path) + (branch ? '&branch=' + encodeURIComponent(branch) : ''));
      const now = r.content.split('\n');
      if (highlight && prev.current) { const old = prev.current; let a = 0, b = 0; while (a < now.length && a < old.length && now[a] === old[a]) a++; while (b < now.length - a && b < old.length - a && now[now.length - 1 - b] === old[old.length - 1 - b]) b++; setHl([a, now.length - b]); }
      prev.current = now; setF(r); setLines(now); setError('');
    } catch { setF(null); setLines([]); setError('No live copy of this file yet. It appears here once someone edits it with their agent.'); }
  }
  useEffect(() => {
    const d = dlg.current;
    if (o) { prev.current = null; setF(null); setHl([-1, -1]); load(false); if (!d.open) d.showModal(); }
    else if (d.open) d.close();
  }, [o && o.path, o && o.branch]); // eslint-disable-line react-hooks/exhaustive-deps
  useLive((ev) => { if (ev.type === 'file' && S.fileOpen && ev.file.path === S.fileOpen.path && (ev.file.branch || null) === (S.fileOpen.branch || null)) load(true); });
  return (
    <dialog ref={dlg} onClose={() => (S.fileOpen = null)} onClick={(e) => { if (e.target === dlg.current) dlg.current.close(); }}>
      <div className="dlg-head"><h3 className="mono">{o ? o.path : ''}</h3><span className="grow"></span>
        <span className="small muted">{f && <>v{f.version} · saved by {f.byName} {ago(f.at)}{f.lock && <> · <Icon name="lock" size={12} /> {f.lock.holderName} is editing</>}{f.branch ? ' · ⎇ ' + f.branch : ''}</>}</span>
        <button onClick={() => dlg.current.close()}>Close</button></div>
      <div className="dlg-body">{error ? <div style={{ padding: 12 }}>{error}</div> : <pre className="codebox">{lines.map((l, i) => <div key={i} className={'ln' + (i >= hl[0] && i < hl[1] ? ' hl' : '')}><span>{i + 1}</span><span>{l || ' '}</span></div>)}</pre>}</div>
    </dialog>
  );
}

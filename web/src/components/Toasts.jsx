import { S, go, readNotes } from '../lib/state.js';
import { useS } from '../lib/store.js';

export default function Toasts() {
  useS();
  if (!S.toasts.length) return null;
  const open = (t) => { S.toasts = S.toasts.filter(x => x.id !== t.id); readNotes([t.id]); const l = t.link || {}; if (l.url) window.open(l.url, '_blank', 'noopener'); else go(l.view || 'activity', l.task ? { task: l.task } : {}); };
  return <div id="toasts" role="status">{S.toasts.map(t => <button key={t.id} className="toast" onClick={() => open(t)}><b>{t.title}</b><span>{t.body}</span></button>)}</div>;
}

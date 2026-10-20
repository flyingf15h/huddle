// The daily digest as a pop-up: what the team's agents did, what needs a person, what it cost.
import { S, markDigestSeen, myName } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useEscape } from '../lib/hooks.js';
import { money } from '../lib/tasks.js';

const TONE = { bad: 'var(--bad)', ok: 'var(--ok)' };
export default function DigestDialog() {
  useS();
  const d = S.digestShow;
  const close = () => { if (d && !d.preview) markDigestSeen(d.id); S.digestShow = null; };
  useEscape(close, !!d);
  if (!d) return null;
  const day = new Date(d.at).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const older = S.digests.filter(x => x.id !== d.id).slice(-6).reverse();
  return (
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Daily digest" style={{ width: 'min(600px,100%)', maxHeight: '88vh', overflow: 'auto' }}>
        <div className="small muted">{d.project} · {day}{d.preview && <> · <b>Preview</b>, only you see this</>}</div>
        <h3 style={{ margin: '4px 0 14px', fontSize: 20 }}>{d.headline}</h3>
        <div className="tiles" style={{ marginBottom: 6 }}>
          <div className="tile"><div className="k">Finished</div><div className="v">{d.stats.done}</div></div>
          <div className="tile"><div className="k">In progress</div><div className="v">{d.stats.inProgress}</div></div>
          <div className="tile"><div className="k">Stuck</div><div className="v" style={d.stats.stuck ? { color: 'var(--bad)' } : undefined}>{d.stats.stuck}</div></div>
          <div className="tile"><div className="k">Usage</div><div className="v">{money(d.stats.cost)}</div></div>
        </div>
        {d.sections.map(s => (
          <div key={s.title}>
            <h4 style={{ margin: '16px 0 6px', fontSize: 14, color: TONE[s.tone] || 'inherit' }}>{s.title}</h4>
            <ul style={{ margin: 0, paddingLeft: 20 }}>{s.items.map((i, k) => <li key={k} style={{ marginBottom: 3 }}>{i.text}</li>)}</ul>
          </div>
        ))}
        {d.stats.active.length > 0 && <p className="small muted" style={{ marginTop: 16 }}>Active: {d.stats.active.join(', ')}</p>}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 18 }}>
          {older.length > 0 && <select aria-label="Earlier digests" value="" onChange={(e) => { const x = S.digests.find(y => y.id === e.target.value); if (x) S.digestShow = x; }}>
            <option value="">Earlier digests</option>{older.map(x => <option key={x.id} value={x.id}>{new Date(x.at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</option>)}</select>}
          <span className="grow" style={{ flex: 1 }}></span>
          <button className="primary" onClick={close}>Got it</button>
        </div>
      </div>
    </div>
  );
}

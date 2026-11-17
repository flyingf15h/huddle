// A dashboard visitor without a name picks one before sending anything.
import { useState } from 'react';
import { S, auth, setName } from '../lib/state.js';
import { useS } from '../lib/store.js';

export default function NameDialog() {
  useS();
  const [v, setV] = useState(auth.name);
  if (auth.name) return null;
  // the people already here: one click instead of retyping the name you joined with
  const names = [...new Set([...Object.values(S.agents).filter(a => a.kind !== 'watcher').map(a => a.name), ...Object.keys(S.settings || {})])].filter(Boolean).sort().slice(0, 12);
  return (
    <div className="overlay" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Your name">
        <form onSubmit={(e) => { e.preventDefault(); setName(v); }}>
          <h3>Your name</h3>
          <p className="muted" style={{ marginTop: 0 }}>{names.length ? 'Pick yours if you already joined from a terminal, so your agent\'s work shows up as yours. Or type a new one.' : 'This is how the team sees you.'}</p>
          {names.length > 0 && <p style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 0 }}>{names.map(n => <button type="button" key={n} onClick={() => setName(n)}>{n}</button>)}</p>}
          <input value={v} onChange={(e) => setV(e.target.value)} style={{ width: '100%' }} autoComplete="name" aria-label="Your name" autoFocus />
          <p style={{ textAlign: 'right', marginBottom: 0 }}><button className="primary" type="submit">Save</button></p>
        </form>
      </div>
    </div>
  );
}

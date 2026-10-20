// A dashboard visitor without a name picks one before sending anything.
import { useState } from 'react';
import { auth, setName } from '../lib/state.js';
import { useS } from '../lib/store.js';

export default function NameDialog() {
  useS();
  const [v, setV] = useState(auth.name);
  if (auth.name) return null;
  return (
    <div className="overlay" role="presentation">
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Your name">
        <form onSubmit={(e) => { e.preventDefault(); setName(v); }}>
          <h3>Your name</h3>
          <p className="muted" style={{ marginTop: 0 }}>Use the name you joined with, so your agent's work shows up as yours.</p>
          <input value={v} onChange={(e) => setV(e.target.value)} style={{ width: '100%' }} autoComplete="name" aria-label="Your name" autoFocus />
          <p style={{ textAlign: 'right', marginBottom: 0 }}><button className="primary" type="submit">Save</button></p>
        </form>
      </div>
    </div>
  );
}

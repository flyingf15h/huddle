import { S } from '../lib/state.js';
import { SHORTCUTS } from '../lib/keys.js';

export default function Shortcuts() {
  return (
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) S.shortcuts = false; }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <h3>Keyboard shortcuts</h3>
        <div className="sclist">{SHORTCUTS.map(([k, d]) => <><span key={k}>{k.split(' ').map((part, i) => <span key={i}><span className="kbdk">{part}</span> </span>)}</span><span key={k + 'd'}>{d}</span></>)}</div>
        <p style={{ margin: '16px 0 0', textAlign: 'right' }}><button onClick={() => (S.shortcuts = false)}>Close</button></p>
      </div>
    </div>
  );
}

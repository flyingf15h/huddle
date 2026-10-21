// The project name as a prompt path (~/acme-shop) that opens the project switcher. Used at the top of the
// sidebar, and in the header when the sidebar is folded away.
import { useState } from 'react';
import { S, auth, known, goHome, openProject, prettyProject } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useEscape } from '../lib/hooks.js';
import Icon from './Icon.jsx';

export default function ProjectMenu({ up }) {
  useS();
  const [open, setOpen] = useState(false);
  useEscape(() => setOpen(false), open);
  return (
    <div className="projwrap">
      <button className="projT" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title={S.demo ? 'Demo project' : 'Switch project'}>
        <span className="tilde">~/</span><span id="pnameText">{prettyProject(auth.project)}</span><Icon name="chevron" size={13} />
      </button>
      {open && (
        <>
          <button className="clickaway" aria-label="Close" onClick={() => setOpen(false)} />
          <div className="menu" role="menu" style={{ position: 'absolute', top: up ? undefined : 'calc(100% + 6px)', left: 0, minWidth: 240 }}>
            <button className="mi" role="menuitem" onClick={goHome}>← all projects</button>
            <hr /><div className="mh">switch project</div>
            {Object.keys(known).map(n => (
              <button key={n} className={'mi' + (n === auth.project ? ' cur' : '')} role="menuitem" onClick={() => n !== auth.project && openProject(n)}>
                <span className="tilde">~/</span><span>{prettyProject(n)}</span>{n === auth.project && <span className="check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

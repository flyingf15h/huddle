// A tmux-style status line along the bottom: the project and my branch, what's running and waiting,
// whether the live connection is up, and the time.
import { useEffect, useState } from 'react';
import { S, auth, myName, people, prettyProject } from '../lib/state.js';
import { useS } from '../lib/store.js';

export default function StatusLine() {
  useS();
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick(x => x + 1), 30000); return () => clearInterval(i); }, []);
  const me = myName();
  const mine = people().find(p => p.name === me);
  const running = S.board.tasks.filter(t => t.status === 'doing').length;
  const waiting = S.approvals.filter(a => a.owner === me).length + S.board.tasks.filter(t => t.status === 'blocked' && (t.owner === me || t.by === me)).length;
  return (
    <footer id="statusline" aria-label="Status">
      <span className="mode">huddle</span>
      <span><b>{prettyProject(auth.project)}</b>{mine && mine.branch ? ' ' + mine.branch : ''}</span>
      <span>{running} running{waiting ? <> · <em>{waiting} waiting on you</em></> : ''}</span>
      <span className="grow"></span>
      <span className={'sconn ' + S.conn}>{S.conn === 'live' ? 'live' : S.conn === 'connecting' ? 'connecting' : 'reconnecting'}</span>
      <span>{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </footer>
  );
}

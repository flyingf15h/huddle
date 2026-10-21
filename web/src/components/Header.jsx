// The header. With the sidebar open: the page name, its description and (on Activity) the feed filters.
// With the sidebar folded away it carries what the sidebar did: the project, the team's status lights and
// invite. Either way: search, the inbox, help (which has the keyboard shortcuts) and [ new request ].
import { useState } from 'react';
import { S, go, people, dn, myName } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { store } from '../lib/words.js';
import { teamState } from '../lib/team.js';
import Icon from './Icon.jsx';
import Notifications from './Notifications.jsx';
import ProjectMenu from './ProjectMenu.jsx';
import { toggleRail, toggleSide, layout } from '../lib/layout.js';

const TITLES = { overview: 'overview', activity: 'activity', tasks: 'tasks', studio: 'studio', settings: 'settings' };
const DESC = { overview: "what's running and what needs you", activity: 'every prompt, reply and message as it happens', studio: 'manage your project', settings: 'people, integrations, rules and appearance' };
const FILTERS = [['all', 'everything', 'Every prompt, step, reply, message and file change'], ['key', 'conversation', 'Requests, prompts, replies, messages and hand-offs, without the tool steps and file changes'], ['talk', 'messages', 'Only messages and requests']];
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
export const newRequest = () => { if (S.view !== 'activity') go('activity'); setTimeout(() => dispatchEvent(new Event('huddle:compose')), 0); };

export default function Header() {
  useS();
  const [notesOpen, setNotesOpen] = useState(false);
  const unread = S.notes.filter(n => !n.read).length;
  const dnd = store.get('huddle.dnd') === '1';
  const mini = layout().railMini;
  const pick = (n) => { S.who = S.who === n ? null : n; go('activity'); };
  return (
    <header className={mini ? 'wide' : ''}>
      <button className="ghost iconbtn menubtn" aria-label="Open the menu" onClick={() => (S.drawer = true)}><Icon name="menu" /></button>
      <button className="hbtn hide-sm" aria-label={mini ? 'Show the sidebar' : 'Fold the sidebar away and show the pages as tabs'} title={mini ? 'Show the sidebar' : 'Fold the sidebar away (pages move to tabs)'} onClick={toggleRail}>{mini ? '»' : '«'}</button>
      {mini ? (
        <>
          <ProjectMenu />
          <div className="chans hide-sm">
            {people().map(p => { const st = teamState(p); return (
              <button key={p.name} className={'chan ' + st.tone + (S.who === p.name ? ' sel' : '')} title={`${dn(p.name)}${p.name === myName() ? ' (you)' : ''}: ${st.word}. Click to show only their activity.`} onClick={() => pick(p.name)}><i></i>{dn(p.name)}</button>
            ); })}
          </div>
          <button className="tbtn hide-sm" onClick={() => (S.invite = true)}>+ invite</button>
        </>
      ) : (
        <><h1>{TITLES[S.view]}</h1>{S.view !== 'activity' && <span className="vdesc">{DESC[S.view] || ''}</span>}</>
      )}
      {S.view === 'activity' && (
        <>
          <div id="filters" className="seg sm" role="group" aria-label="Show">
            {FILTERS.map(([k, l, t]) => <button key={k} className={S.filter === k ? 'on' : ''} title={t} onClick={() => (S.filter = k)}>{l}</button>)}
          </div>
          {S.who && <span className="small muted">only <b>{dn(S.who)}</b> · <button className="link" onClick={() => (S.who = null)}>everyone</button></span>}
        </>
      )}
      <span className="grow"></span>
      <button className="searchbtn" onClick={() => (S.search = true)} aria-label="Search the project"><span className="slash">/</span><span className="label">search</span><span className="kbdk">{mac ? '⌘K' : 'ctrl k'}</span></button>
      <div className="headbtns" style={{ position: 'relative' }}>
        <button className="hbtn" id="btn-notify" aria-haspopup="menu" aria-expanded={notesOpen} aria-label={'Notifications' + (unread ? ` (${unread} unread)` : '')} title={dnd ? 'Notifications (do not disturb is on)' : 'Notifications'} onClick={() => setNotesOpen(!notesOpen)}>
          {dnd ? 'inbox (muted)' : 'inbox'}{unread > 0 && <span className="hcount">({unread > 99 ? '99+' : unread})</span>}
        </button>
        {notesOpen && <Notifications close={() => setNotesOpen(false)} />}
        {S.view === 'activity' && <button className="hbtn hide-sm" aria-label="Show or hide the side panel" title="Show or hide the side panel" onClick={toggleSide}>panel</button>}
        <button className="hbtn hide-sm" aria-label="How huddle works" title="How huddle works" onClick={() => (S.help = true)}>help</button>
      </div>
      <button className="newreq" onClick={newRequest} title="New request (c)"><span className="br">[</span>new<span className="nrl"> request</span> <span className="key">(c)</span><span className="br">]</span></button>
    </header>
  );
}

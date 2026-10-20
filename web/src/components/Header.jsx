// Page title, feed filters (Activity only), search, connection, notifications, theme and invite.
import { useState } from 'react';
import { S } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { store } from '../lib/words.js';
import Icon from './Icon.jsx';
import Notifications from './Notifications.jsx';

const TITLES = { activity: 'Activity', tasks: 'Tasks', code: 'Code', brief: 'Brief & memory', usage: 'Usage & cost', health: 'Health', settings: 'Team & settings' };
const DESC = { tasks: 'Every request and task, who has it and how far along it is', brief: "Shared memory files between your team's agents", code: "Everyone's shared branches, the GitHub repository and conflicts",
  usage: 'Agent usage and what it would cost at API prices', health: "Whether huddle is working on everyone's computer", settings: 'People, access, rules, integrations and data' };
const FILTERS = [['all', 'Everything', 'Every prompt, step, reply, message and file change'], ['key', 'Highlights', 'Requests, prompts, replies, messages and hand-offs'], ['talk', 'Messages', 'Only messages and requests']];
const mac = /Mac|iPhone|iPad/.test(navigator.platform);

export default function Header({ dark, flipTheme }) {
  useS();
  const [notesOpen, setNotesOpen] = useState(false);
  const unread = S.notes.filter(n => !n.read).length;
  const dnd = store.get('huddle.dnd') === '1';
  return (
    <header>
      <button className="ghost iconbtn menubtn" aria-label="Open the menu" onClick={() => (S.drawer = true)}><Icon name="menu" /></button>
      <h1>{TITLES[S.view]}</h1>
      <span className="vdesc">{DESC[S.view] || ''}</span>
      {S.view === 'activity' && (
        <>
          <div id="filters" className="seg sm" role="group" aria-label="Show">
            {FILTERS.map(([k, l, t]) => <button key={k} className={S.filter === k ? 'on' : ''} title={t} onClick={() => (S.filter = k)}>{l}</button>)}
          </div>
          {S.who && <span className="small muted">only <b>{S.who}</b> · <button className="link" onClick={() => (S.who = null)}>everyone</button></span>}
        </>
      )}
      <span className="grow"></span>
      <button className="searchbtn" onClick={() => (S.search = true)} aria-label="Search the project"><Icon name="search" size={16} /><span className="label">Search</span><span className="kbdk">{mac ? '⌘K' : 'Ctrl K'}</span></button>
      <span className={'conn' + (S.conn === 'live' ? ' live' : '')}>{S.conn === 'live' ? 'Live' : S.conn === 'connecting' ? 'Connecting' : 'Reconnecting…'}</span>
      <div className="headbtns" style={{ position: 'relative' }}>
        <button className="ghost iconbtn" id="btn-notify" aria-haspopup="menu" aria-expanded={notesOpen} aria-label={'Notifications' + (unread ? ` (${unread} unread)` : '')} onClick={() => setNotesOpen(!notesOpen)}>
          <Icon name={dnd ? 'belloff' : 'bell'} size={19} />{unread > 0 && <span className="nbadge">{unread > 99 ? '99+' : unread}</span>}
        </button>
        {notesOpen && <Notifications close={() => setNotesOpen(false)} />}
        <button className="ghost iconbtn hide-sm" aria-label={dark ? 'Switch to light' : 'Switch to dark'} title={dark ? 'Switch to light' : 'Switch to dark'} onClick={flipTheme}><Icon name={dark ? 'sun' : 'moon'} size={19} /></button>
        <button className="ghost iconbtn hide-sm" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => (S.shortcuts = true)}><Icon name="keyboard" size={19} /></button>
        <button className="ghost iconbtn hide-sm" aria-label="How huddle works" title="How huddle works" onClick={() => (S.help = true)}><Icon name="help" size={19} /></button>
        <button className="hide-sm" onClick={() => (S.invite = true)}>Invite people</button>
      </div>
    </header>
  );
}

// The header. With the sidebar open: the page name, its description and (on Activity) the feed filters.
// With the sidebar folded away it carries what the sidebar did: the project, the team's status lights and
// invite. Either way: search, notifications, theme, shortcuts, help and [ new request ].
import { useState } from 'react';
import { S, go, people, dn, myName } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { store } from '../lib/words.js';
import { teamState } from '../lib/team.js';
import Icon from './Icon.jsx';
import Notifications from './Notifications.jsx';
import ThemePicker from './ThemePicker.jsx';
import ProjectMenu from './ProjectMenu.jsx';
import { useEscape } from '../lib/hooks.js';
import { toggleRail, toggleSide, layout } from '../lib/layout.js';

const TITLES = { overview: 'overview', activity: 'activity', tasks: 'tasks', studio: 'studio', settings: 'settings' };
const DESC = { overview: "what's running and what needs you", activity: 'every prompt, reply and message as it happens', tasks: 'every request and task, who has it and how far along it is',
  studio: 'the brief, timeline, gallery, builds and github', settings: 'people, usage, health, integrations and rules' };
const FILTERS = [['all', 'everything', 'Every prompt, step, reply, message and file change'], ['key', 'highlights', 'Requests, prompts, replies, messages and hand-offs'], ['talk', 'messages', 'Only messages and requests']];
const mac = /Mac|iPhone|iPad/.test(navigator.platform);
// the return key, drawn in square pixels like a terminal font
const ENTER = [[6, 0], [6, 1], [2, 2], [6, 2], [1, 3], [2, 3], [6, 3], [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [1, 5], [2, 5], [2, 6]];
export const EnterKey = () => <svg className="enterkey" viewBox="0 0 14 14" aria-hidden="true">{ENTER.map(([x, y]) => <rect key={x + '-' + y} x={x * 2} y={y * 2} width="2" height="2" />)}</svg>;
export const newRequest = () => { if (S.view !== 'activity') go('activity'); setTimeout(() => dispatchEvent(new Event('huddle:compose')), 0); };

export default function Header() {
  useS();
  const [notesOpen, setNotesOpen] = useState(false), [themeOpen, setThemeOpen] = useState(false);
  useEscape(() => setThemeOpen(false), themeOpen);
  const unread = S.notes.filter(n => !n.read).length;
  const dnd = store.get('huddle.dnd') === '1';
  const mini = layout().railMini;
  const pick = (n) => { S.who = S.who === n ? null : n; go('activity'); };
  return (
    <header className={mini ? 'wide' : ''}>
      <button className="ghost iconbtn menubtn" aria-label="Open the menu" onClick={() => (S.drawer = true)}><Icon name="menu" /></button>
      <button className="ghost iconbtn hide-sm" aria-label={mini ? 'Show the sidebar' : 'Fold the sidebar away and show the pages as tabs'} title={mini ? 'Show the sidebar' : 'Fold the sidebar away (pages move to tabs)'} onClick={toggleRail}><Icon name="panelLeft" size={18} /></button>
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
        <button className="ghost iconbtn" id="btn-notify" aria-haspopup="menu" aria-expanded={notesOpen} aria-label={'Notifications' + (unread ? ` (${unread} unread)` : '')} onClick={() => setNotesOpen(!notesOpen)}>
          <Icon name={dnd ? 'belloff' : 'bell'} size={18} />{unread > 0 && <span className="nbadge">{unread > 99 ? '99+' : unread}</span>}
        </button>
        {notesOpen && <Notifications close={() => setNotesOpen(false)} />}
        {S.view === 'activity' && <button className="ghost iconbtn hide-sm" aria-label="Show or hide the side panel" title="Show or hide the side panel" onClick={toggleSide}><Icon name="panelRight" size={18} /></button>}
        <button className="ghost iconbtn hide-sm" aria-haspopup="dialog" aria-expanded={themeOpen} aria-label="Theme" title="Theme" onClick={() => { setThemeOpen(!themeOpen); setNotesOpen(false); }}><Icon name="palette" size={18} /></button>
        {themeOpen && <><button className="clickaway" aria-label="Close" onClick={() => setThemeOpen(false)} /><div className="menu" role="dialog" aria-label="Theme" style={{ position: 'absolute', top: 44, right: 0, maxWidth: 'none' }}><div className="mh">theme</div><ThemePicker compact /></div></>}
        <button className="ghost iconbtn hide-sm" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => (S.shortcuts = true)}><Icon name="keyboard" size={18} /></button>
        <button className="ghost iconbtn hide-sm" aria-label="How huddle works" title="How huddle works" onClick={() => (S.help = true)}><Icon name="help" size={18} /></button>
      </div>
      <button className="newreq" onClick={newRequest} title="New request (c)"><span className="br">[</span>new<span className="nrl"> request</span> <EnterKey /><span className="br">]</span></button>
    </header>
  );
}

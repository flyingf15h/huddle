// Left rail: project switcher, the pages, the team and what each person's agent is on, and my agent's mode.
// On phones it's a drawer opened from the header.
import { useState } from 'react';
import { S, auth, known, go, goHome, openProject, people, cardLine, usageOf, dn, myName, hasClaude, claudeOf, myTool, aiName, prettyProject, api } from '../lib/state.js';
import { useS } from '../lib/store.js';
import Avatar from './Avatar.jsx';
import Icon from './Icon.jsx';

const NAV = [['activity', 'Activity'], ['tasks', 'Tasks'], ['code', 'Code'], ['brief', 'Brief & memory'], ['usage', 'Usage & cost'], ['health', 'Health'], ['settings', 'Team & settings']];
const MODES = [['full', 'Active', 'Runs requests and answers messages sent to you, and takes on team tasks, even while you are away.'],
  ['requests', 'Requests only', 'Runs requests and answers messages sent to you. Leaves team tasks to others.'],
  ['off', 'Off', 'Nothing runs in the background. Requests and messages wait for you.']];

export default function Sidebar() {
  useS();
  const [projMenu, setProjMenu] = useState(false), [modeMenu, setModeMenu] = useState(false), [modeErr, setModeErr] = useState('');
  const team = people();
  const online = team.filter(p => p.online).length;
  const problems = S.problems.filter(x => x.at > Date.now() - 86400000).length;
  const openTasks = S.board.tasks.filter(t => t.status === 'blocked' || (t.owner === myName() && t.status !== 'done')).length;
  const myMode = (S.settings[myName()] && S.settings[myName()].autopilot) || 'full';
  const doingCount = (n) => S.board.tasks.filter(t => t.owner === n && t.status === 'doing').length;
  const pickPerson = (n) => { S.who = S.who === n ? null : n; go('activity'); };
  const setMode = async (m) => { setModeErr(''); try { const r = await api('setting', { autopilot: m }); S.settings[myName()] = r.settings; setModeMenu(false); } catch (e) { setModeErr("Couldn't change it: " + e.message); } };
  const ask = (n) => { S.askTo = n; go('activity'); };

  return (
    <nav id="rail" className={S.drawer ? 'open' : ''} aria-label="Project">
      <div className="rail-top" style={{ position: 'relative' }}>
        <button className="projbtn" aria-haspopup="menu" aria-expanded={projMenu} onClick={() => setProjMenu(!projMenu)}>
          <svg className="plogo" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="var(--accent)" /><circle cx="11" cy="13" r="4.2" fill="var(--raised)" /><circle cx="21" cy="13" r="4.2" fill="var(--raised)" opacity=".85" /><circle cx="16" cy="21" r="4.2" fill="var(--raised)" opacity=".7" /></svg>
          <span className="pn"><span id="pnameText">{prettyProject(auth.project)}</span><span className="pk">{S.demo ? 'Demo project' : 'huddle project'}</span></span>
          <Icon name="chevron" size={14} />
        </button>
        {projMenu && (
          <div className="menu" role="menu" style={{ position: 'absolute', top: 52, left: 10, right: 10 }}>
            <button className="mi" role="menuitem" onClick={goHome}>← All projects</button>
            <hr /><div className="mh">Switch project</div>
            {Object.keys(known).map(n => (
              <button key={n} className={'mi' + (n === auth.project ? ' cur' : '')} role="menuitem" onClick={() => n !== auth.project && openProject(n)}>
                <Avatar name={prettyProject(n)} sm /><span>{prettyProject(n)}</span>{n === auth.project && <span className="check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="navlist">
        {NAV.map(([v, label]) => (
          <button key={v} className={S.view === v ? 'on' : ''} aria-current={S.view === v ? 'page' : undefined} onClick={() => go(v)}>
            <Icon name={v} /><span>{label}</span>
            {v === 'health' && problems > 0 && <span className="navbadge">{problems}</span>}
            {v === 'tasks' && openTasks > 0 && <span className="navbadge" style={{ background: 'var(--accent)' }}>{openTasks}</span>}
          </button>
        ))}
      </div>
      <div className="railhead"><span>Team</span><span className="count">{team.length ? online + ' online' : ''}</span>
        <button className="ghost iconbtn sm" aria-label="Invite people" title="Invite people" onClick={() => (S.invite = true)}><Icon name="plus" size={16} /></button></div>
      <div id="team">
        {team.map(p => {
          const c = cardLine(p), u = usageOf(p.name), t = doingCount(p.name);
          return (
            <div className="prow" key={p.name}>
              {hasClaude(p.name) && <button className="pask" onClick={() => ask(p.name)} title={`Ask ${p.name === myName() ? 'your ' + myTool() : claudeOf(p.name)} to do something`}>Ask</button>}
              <button className={'person' + (S.who === p.name ? ' sel' : '') + (p.online ? '' : ' away')} data-nav onClick={() => pickPerson(p.name)} title={S.who === p.name ? 'Show everyone' : `Show only ${p.name}'s activity`}>
                <span className="pav"><Avatar name={p.name} busy={c.busy} /><i className={'pres ' + (p.online ? (p.runner === 'full' ? 'auto' : 'on') : 'off')}></i></span>
                <span className="pbd">
                  <span className="top"><span className="name">{dn(p.name)}{p.name === myName() && <> <span className="faint" style={{ fontWeight: 500 }}>(you)</span></>}</span>{u && <span className="use"><span className={u.high ? 'usehigh' : ''} title={u.title}>{u.left}% left</span></span>}</span>
                  {c.main && <span className="doing">{c.main}</span>}
                  <span className="live">{c.live}{t ? ` · ${t} task${t === 1 ? '' : 's'} open` : ''}</span>
                </span>
              </button>
            </div>
          );
        })}
        {!team.length && <div className="quiet">Nobody has joined yet. <button className="link" onClick={() => (S.invite = true)}>Invite your team</button></div>}
      </div>
      <div className="mepanel" style={{ position: 'relative' }}>
        <button className="you ghost" style={{ border: 0, background: 'none' }} onClick={() => (S.profile = true)} title="Your profile">{auth.name && <><Avatar name={auth.name} sm /><span>{dn(auth.name)}</span></>}</button>
        {auth.name && hasClaude(myName()) && (
          <>
            <button className="mybtn" aria-haspopup="menu" aria-expanded={modeMenu} onClick={() => setModeMenu(!modeMenu)}>
              <span className={'mydot' + (myMode === 'off' ? ' off' : myMode === 'full' ? ' full' : '')}></span><span>{aiName(myName()) || myTool()} · {MODES.find(x => x[0] === myMode)[1]}</span><Icon name="chevron" size={12} />
            </button>
            {modeMenu && (
              <div className="menu" role="menu" style={{ position: 'absolute', bottom: 58, left: 10, right: 10 }}>
                <div className="mh">Your {myTool()}</div>
                {MODES.map(([k, l, d]) => <label className="modeopt" key={k}><input type="radio" name="mode" checked={k === myMode} onChange={() => setMode(k)} /><div><b>{l}</b><span>{d}</span></div></label>)}
                {modeErr && <div className="mh err">{modeErr}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </nav>
  );
}

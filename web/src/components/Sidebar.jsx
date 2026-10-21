// Left rail: the project, the pages, the team and what each person's agent is on, and my agent's mode.
// Folding it away (the header button) moves the pages to tabs under the header. On phones it's a drawer.
import { useState } from 'react';
import { S, auth, go, people, cardLine, usageOf, dn, myName, hasClaude, claudeOf, myTool, aiName, api, toolOf } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { teamState, openTaskCount } from '../lib/team.js';
import { PAGES } from './TopTabs.jsx';
import ProjectMenu from './ProjectMenu.jsx';
import Icon from './Icon.jsx';

const MODES = [['full', 'active', 'Runs requests and answers messages sent to you, and takes on team tasks, even while you are away.'],
  ['requests', 'requests only', 'Runs requests and answers messages sent to you. Leaves team tasks to others.'],
  ['off', 'off', 'Nothing runs in the background. Requests and messages wait for you.']];

export default function Sidebar() {
  useS();
  const [modeMenu, setModeMenu] = useState(false), [modeErr, setModeErr] = useState('');
  const team = people();
  const me = myName();
  const online = team.filter(p => p.online).length;
  const problems = S.problems.filter(x => x.at > Date.now() - 86400000).length;
  const openTasks = openTaskCount(me);
  const myMode = (S.settings[me] && S.settings[me].autopilot) || 'full';
  const pickPerson = (n) => { S.who = S.who === n ? null : n; go('activity'); };
  const setMode = async (m) => { setModeErr(''); try { const r = await api('setting', { autopilot: m }); S.settings[me] = r.settings; setModeMenu(false); } catch (e) { setModeErr("Couldn't change it: " + e.message); } };
  const ask = (n) => { S.askTo = n; go('activity'); };

  return (
    <nav id="rail" className={S.drawer ? 'open' : ''} aria-label="Project">
      <div className="rail-top"><ProjectMenu /></div>
      <div className="navlist">
        {PAGES.map(([v, label], i) => (
          <button key={v} className={S.view === v ? 'on' : ''} aria-current={S.view === v ? 'page' : undefined} onClick={() => go(v)} title={`${label} (${i + 1})`}>
            <span className="l">{label}</span>
            {v === 'tasks' && openTasks > 0 && <span className="n">({openTasks})</span>}
            {v === 'studio' && problems > 0 && <span className="n bad" title={`${problems} health problem${problems === 1 ? '' : 's'}`}>({problems})</span>}
          </button>
        ))}
      </div>
      <div className="railhead"><span>team</span><span className="count">{team.length ? online + ' online' : ''}</span></div>
      <div id="team">
        {team.map(p => {
          const c = cardLine(p), u = usageOf(p.name), st = teamState(p);
          return (
            <div className="prow" key={p.name}>
              {hasClaude(p.name) && <button className="pask" onClick={() => ask(p.name)} title={`Ask ${p.name === me ? 'your ' + myTool() : claudeOf(p.name)} to do something`}>ask</button>}
              <button className={'person ' + st.tone + (S.who === p.name ? ' sel' : '')} data-nav onClick={() => pickPerson(p.name)} title={S.who === p.name ? 'Show everyone' : `Show only ${dn(p.name)}'s activity`}>
                <i className="sdot" aria-hidden="true"></i>
                <span className="pbd">
                  <span className="top"><span className="name">{dn(p.name)}{p.name === me && <span className="faint"> (you)</span>}</span><span className="tool">{toolOf(p.name).toLowerCase()}</span>{u && <span className={'use' + (u.high ? ' usehigh' : '')} title={u.title}>{u.left}% left</span>}</span>
                  <span className="doing">{st.tone === 'w' ? st.word : c.main || c.live}</span>
                </span>
              </button>
            </div>
          );
        })}
        {!team.length && <div className="quiet">nobody has joined yet</div>}
        <button className="tbtn" onClick={() => (S.invite = true)}>+ invite</button>
      </div>
      <div className="mepanel" style={{ position: 'relative' }}>
        {auth.name && hasClaude(me) ? (
          <>
            <button className="mybtn" aria-haspopup="menu" aria-expanded={modeMenu} onClick={() => setModeMenu(!modeMenu)} title="What your agent does with work from the team">
              <i className={'mydot' + (myMode === 'off' ? ' off' : myMode === 'full' ? ' full' : '')}></i><span>{(aiName(me) || 'your ' + myTool()).toLowerCase()} · {MODES.find(x => x[0] === myMode)[1]}</span><Icon name="chevron" size={12} />
            </button>
            {modeMenu && (
              <div className="menu" role="menu" style={{ position: 'absolute', bottom: 46, left: 10, right: 10 }}>
                <div className="mh">your {myTool().toLowerCase()}</div>
                {MODES.map(([k, l, d]) => <label className="modeopt" key={k}><input type="radio" name="mode" checked={k === myMode} onChange={() => setMode(k)} /><div><b>{l}</b><span>{d}</span></div></label>)}
                {modeErr && <div className="mh err">{modeErr}</div>}
              </div>
            )}
          </>
        ) : <span className="faint small">no agent of yours here yet</span>}
        {auth.name && <button className="you" onClick={() => (S.profile = true)} title="Your profile">{dn(auth.name)}</button>}
      </div>
    </nav>
  );
}

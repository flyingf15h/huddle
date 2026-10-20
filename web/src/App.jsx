// The app: the home screen (projects, sign in, join) or one project (sidebar, header, the current
// view, and the overlays that work everywhere).
import { useEffect, useRef, useState } from 'react';
import { S, auth, boot, go, goHome } from './lib/state.js';
import { useS } from './lib/store.js';
import { installKeys } from './lib/keys.js';
import { water } from './lib/water.js';
import { store } from './lib/words.js';
import { stopDemo } from './lib/demo.js';
import Home from './Home.jsx';
import Sidebar from './components/Sidebar.jsx';
import Header from './components/Header.jsx';
import TabBar from './components/TabBar.jsx';
import Search from './components/Search.jsx';
import Shortcuts from './components/Shortcuts.jsx';
import Toasts from './components/Toasts.jsx';
import NameDialog from './components/NameDialog.jsx';
import Profile from './components/Profile.jsx';
import InviteDialog from './components/InviteDialog.jsx';
import Help from './components/Help.jsx';
import DigestDialog from './components/DigestDialog.jsx';
import Activity from './views/Activity.jsx';
import Tasks from './views/Tasks.jsx';
import Code from './views/Code.jsx';
import Brief from './views/Brief.jsx';
import Usage from './views/Usage.jsx';
import Health from './views/Health.jsx';
import Settings from './views/Settings.jsx';

const darkQuery = matchMedia('(prefers-color-scheme: dark)');

export default function App() {
  useS();
  const [screen, setScreen] = useState('loading');
  const [theme, setTheme] = useState(store.get('huddle.theme') === 'cream' ? 'light' : store.get('huddle.theme'));
  const composer = useRef(null);
  const isDark = theme === 'dark' || (theme !== 'light' && darkQuery.matches);

  useEffect(() => {
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    water.set(isDark);
    const h = () => { if (theme !== 'light' && theme !== 'dark') water.set(darkQuery.matches); };
    darkQuery.addEventListener('change', h);
    return () => darkQuery.removeEventListener('change', h);
  }, [theme, isDark]);
  const flipTheme = () => { const t = isDark ? 'light' : 'dark'; store.set('huddle.theme', t); setTheme(t); };

  useEffect(() => {
    const off = installKeys({ focusComposer: () => { if (S.view !== 'activity') go('activity'); setTimeout(() => composer.current && composer.current.focus(), 0); } });
    boot().then(s => { setScreen(s); if (s === 'project' && auth.name && !store.get('huddle.helpSeen')) S.help = true; });
    // another invite or #p= pasted into this tab only changes the hash
    const onHash = () => { const p = new URLSearchParams(location.hash.slice(1)); if (p.get('invite') || (p.get('p') && p.get('p') !== auth.project)) location.reload(); };
    addEventListener('hashchange', onHash);
    return () => { off(); removeEventListener('hashchange', onHash); };
  }, []);

  if (screen === 'loading') return <div className="empty" style={{ paddingTop: '20vh' }}>Loading…</div>;
  if (screen === 'home' || (S.fatal && !auth.project)) return <><Home /><Toasts /></>;
  return (
    <>
      <div id="app">
        <Sidebar />
        {S.drawer && <button className="scrim" aria-label="Close the menu" onClick={() => (S.drawer = false)}></button>}
        <div className="maincol">
          <Header dark={isDark} flipTheme={flipTheme} />
          {S.demo && <div id="demobar" role="status"><b>Demo project.</b><span className="grow">maya, dev and sam are simulated teammates (Claude Code, Codex and Cursor). Click around: nothing here touches a real codebase.</span><button onClick={() => { stopDemo(); goHome(); }}>Leave demo</button></div>}
          {S.fatal && <div id="catchup" role="alert"><span className="grow">{S.fatal}</span></div>}
          {S.catchup && <div id="catchup" role="status"><span className="grow">{S.catchup}</span><button aria-label="Dismiss" onClick={() => (S.catchup = '')}>×</button></div>}
          {S.view === 'activity' ? <Activity ref={composer} />
            : S.view === 'tasks' ? <Tasks />
            : S.view === 'code' ? <Code />
            : S.view === 'brief' ? <Brief />
            : S.view === 'usage' ? <Usage />
            : S.view === 'health' ? <Health />
            : <Settings />}
        </div>
        <TabBar />
      </div>
      <NameDialog /><Profile /><InviteDialog />
      {S.search && <Search />}
      {S.shortcuts && <Shortcuts />}
      <Help />
      <DigestDialog />
      <Toasts />
    </>
  );
}

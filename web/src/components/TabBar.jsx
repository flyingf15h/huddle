// Phones: the main pages along the bottom; the rest are in the drawer.
import { S, go, myName } from '../lib/state.js';
import { useS } from '../lib/store.js';
import Icon from './Icon.jsx';

const TABS = [['activity', 'Activity'], ['tasks', 'Tasks'], ['code', 'Code'], ['usage', 'Usage']];
export default function TabBar() {
  useS();
  const mine = S.board.tasks.filter(t => t.status === 'blocked' || (t.owner === myName() && t.status !== 'done')).length;
  return (
    <nav className="tabbar" aria-label="Pages">
      {TABS.map(([v, l]) => (
        <button key={v} className={S.view === v ? 'on' : ''} aria-current={S.view === v ? 'page' : undefined} onClick={() => go(v)}>
          <Icon name={v} size={20} /><span>{l}</span>{v === 'tasks' && mine > 0 && <span className="navbadge" style={{ background: 'var(--accent)' }}>{mine}</span>}
        </button>
      ))}
      <button onClick={() => (S.drawer = true)}><Icon name="menu" size={20} /><span>More</span></button>
    </nav>
  );
}

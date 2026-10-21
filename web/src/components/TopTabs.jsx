// The pages as a row of mono tabs under the header, used when the sidebar is folded away. The current
// page gets a > in front; 1 to 5 jump to them.
import { S, go, myName } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { openTaskCount } from '../lib/team.js';

export const PAGES = [['overview', 'overview'], ['activity', 'activity'], ['tasks', 'tasks'], ['studio', 'studio'], ['settings', 'settings']];

export default function TopTabs() {
  useS();
  const n = openTaskCount(myName());
  return (
    <nav className="toptabs" aria-label="Pages">
      {PAGES.map(([v, l], i) => (
        <button key={v} className={S.view === v ? 'on' : ''} aria-current={S.view === v ? 'page' : undefined} onClick={() => go(v)} title={`${l} (${i + 1})`}>
          <span className="l">{l}</span>{v === 'tasks' && n > 0 && <span className="n">({n})</span>}
        </button>
      ))}
    </nav>
  );
}

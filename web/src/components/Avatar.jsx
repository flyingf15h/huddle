// A person's picture if they set one, else their initial on their colour. bot: their agent.
import { S } from '../lib/state.js';
import { color } from '../lib/words.js';

export default function Avatar({ name = '', sm, big, busy, bot, settings }) {
  const st = (settings || S.settings)[name] || {};
  const cls = (extra = '') => `av${extra}${sm ? ' sm' : ''}${big ? ' big' : ''}${busy ? ' busy' : ''}`;
  if (bot) return <span className={`av bot${sm ? ' sm' : ''}`} aria-hidden="true"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2.5l1.9 6.1 6.1 1.9-6.1 1.9L12 18.5l-1.9-6.1-6.1-1.9 6.1-1.9zM18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></svg></span>;
  if (st.avatar) return <span className={cls(' has-img')} aria-hidden="true"><img src={st.avatar} alt="" /></span>;
  const [bg, fg] = color(name);
  return <span className={cls()} style={{ background: bg, color: fg }} aria-hidden="true">{String(st.displayName || name || '?')[0].toUpperCase()}</span>;
}

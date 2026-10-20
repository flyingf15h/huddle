// The bell: this person's notifications from the server (the same list email and desktop alerts come from).
import { useState } from 'react';
import { S, go, readNotes } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useEscape } from '../lib/hooks.js';
import { ago, store } from '../lib/words.js';

export default function Notifications({ close }) {
  useS();
  const [dnd, setDndState] = useState(store.get('huddle.dnd') === '1');
  const [perm, setPerm] = useState('Notification' in window ? Notification.permission : 'unsupported');
  useEscape(close);
  const list = S.notes.slice().reverse();
  const open = (n) => {
    readNotes([n.id]); close();
    const l = n.link || {};
    if (l.url) window.open(l.url, '_blank', 'noopener');
    else go(l.view || 'activity', l.task ? { task: l.task } : {});
  };
  const setDnd = (v) => { setDndState(v); store.set('huddle.dnd', v ? '1' : '0'); };
  const ask = async () => { try { setPerm(await Notification.requestPermission()); } catch { /* ignore */ } };
  return (
    <div className="menu npanel" role="menu" style={{ position: 'absolute', top: 44, right: 0 }}>
      <div className="nhead"><b>Notifications</b><button className="link small" disabled={!S.notes.some(n => !n.read)} onClick={() => readNotes()}>Mark all as read</button></div>
      <div className="nmode"><span>Status</span><div className="seg sm" role="group" aria-label="Status"><button className={dnd ? '' : 'on'} onClick={() => setDnd(false)}>Active</button><button className={dnd ? 'on' : ''} onClick={() => setDnd(true)}>Do not disturb</button></div></div>
      <div className="nlist">
        {list.map(n => <button key={n.id} className={'nitem' + (n.read ? '' : ' unread')} data-nav onClick={() => open(n)}><span className="ndot"></span><span className="nb"><span className="nt"><b>{n.title}</b><time>{ago(n.at)}</time></span><span className="nx">{n.body}</span></span></button>)}
        {!list.length && <div className="nempty">Nothing yet. Messages to you, requests for your agent, approvals, stuck work and conflicts show up here.</div>}
      </div>
      <div className="nfoot">
        <span>{perm === 'granted' ? 'Desktop alerts are on.' : perm === 'denied' ? 'Desktop alerts are blocked in your browser.' : perm === 'default' ? 'Desktop alerts are off.' : 'No desktop alerts in this browser.'} {S.contact && S.contact.email ? `Email: ${S.contact.email}.` : ''}</span>
        {perm === 'default' && <button className="small" onClick={ask}>Turn on</button>}
        <button className="link small" onClick={() => { close(); S.settingsTab = 'notify'; go('settings'); }}>Settings</button>
      </div>
    </div>
  );
}

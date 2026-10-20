// Invite people: a link that shows a teammate what to run to join, and the command itself (personal,
// with a role, once accounts are on).
import { useEffect, useRef, useState } from 'react';
import { S, api, auth } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useEscape } from '../lib/hooks.js';

const SHORT = /^[A-Za-z0-9][\w-]{11}$/;
// the /j/ page shows the right one-liner for their computer; a long invite (no short code) only works as a command
const linkFor = (code) => (SHORT.test(code) ? `${location.origin}/j/${code}` : '');
const cmdFor = (code) => (SHORT.test(code) ? `curl -fsSL ${location.origin}/install.sh | sh -s -- ${code}` : `npx -y github:flyingf15h/huddle join ${code}`);
const ROLE_DESC = { member: 'Can send requests and edit through their agent.', viewer: 'Can watch everything, change nothing.' };
export default function InviteDialog() {
  useS();
  const [role, setRole] = useState('member'), [cmd, setCmd] = useState(''), [link, setLink] = useState(''), [note, setNote] = useState(''), [watch, setWatch] = useState(''), [copied, setCopied] = useState('');
  const cached = useRef(null);
  const accounts = !!S.me.accounts;
  useEscape(() => (S.invite = false), S.invite);
  useEffect(() => {
    if (!S.invite) return;
    let live = true;
    (async () => {
      setCmd('Making an invite…'); setLink(''); setNote('');
      if (!accounts) {
        const long = () => btoa(JSON.stringify({ s: location.origin, t: auth.token, p: auth.project })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        cached.current = cached.current || await api('invite-code', {}).then(r => r.code).catch(() => long());
        if (!live) return;
        setCmd(cmdFor(cached.current)); setLink(linkFor(cached.current)); setWatch(`${location.origin}/app#invite=${cached.current}`);
        setNote('Anyone with the invite can join and see the project. For access you can take back, set up accounts in Team & settings.');
        return;
      }
      try { const r = await api('member-invite', { role }); if (live) { setCmd(cmdFor(r.code)); setLink(linkFor(r.code)); setNote(`Works once, for one person, until ${new Date(r.invite.expires).toLocaleDateString()}. You can take it back in Team & settings.`); } }
      catch (e) { if (live) { setCmd(''); setNote("Couldn't make an invite: " + e.message); } }
    })();
    return () => { live = false; };
  }, [S.invite, role, accounts]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!S.invite) return null;
  const copy = (text, k) => navigator.clipboard.writeText(text).then(() => { setCopied(k); setTimeout(() => setCopied(''), 1500); });
  return (
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) S.invite = false; }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Invite people" style={{ width: 'min(640px,100%)' }}>
        <div style={{ display: 'flex', alignItems: 'center' }}><h3 style={{ margin: 0, flex: 1 }}>Invite people</h3><button onClick={() => (S.invite = false)}>Close</button></div>
        {accounts && <div className="invrole"><div className="seg sm" role="group" aria-label="Role">{['member', 'viewer'].map(r => <button key={r} className={role === r ? 'on' : ''} onClick={() => setRole(r)}>{r === 'member' ? 'Member' : 'Viewer'}</button>)}</div><span className="small muted">{ROLE_DESC[role]}</span></div>}
        {link ? (
          <>
            <p>Send a teammate this link. It shows them the one command to run in their copy of the project, for their computer.</p>
            <div className="cmd"><code>{link}</code><button className="primary" onClick={() => copy(link, 'link')}>{copied === 'link' ? 'Copied' : 'Copy link'}</button></div>
            <p className="small muted" style={{ marginTop: 14 }}>Or send the command directly (Mac and Linux):</p>
            <div className="cmd"><code>{cmd}</code><button onClick={() => copy(cmd, 'cmd')}>{copied === 'cmd' ? 'Copied' : 'Copy'}</button></div>
          </>
        ) : (
          <>
            <p>Have a teammate run this in their copy of the project:</p>
            <div className="cmd"><code>{cmd}</code><button onClick={() => copy(cmd, 'cmd')}>{copied === 'cmd' ? 'Copied' : 'Copy'}</button></div>
          </>
        )}
        <p className="small muted">They need Claude Code, Codex or Cursor, Node 18 or newer and git, and use their own account. Then they start their agent in that folder as usual.</p>
        {!accounts && watch && <p className="small muted">To let someone watch without joining, <button className="link" onClick={() => copy(watch, 'w')}>{copied === 'w' ? 'copied' : 'copy the dashboard link'}</button>.</p>}
        <p className="small muted">{note}</p>
      </div>
    </div>
  );
}

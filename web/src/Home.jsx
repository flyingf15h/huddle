// Home: the projects this browser and account know, sign in (email code or GitHub), join with an invite.
import { useEffect, useState } from 'react';
import { S, auth, known, decodeInvite, lookUpInvite, SHORT_INVITE, startProject, openProject, forgetProject, prettyProject, loadAccount } from './lib/state.js';
import { useS } from './lib/store.js';
import { store } from './lib/words.js';
import Avatar from './components/Avatar.jsx';
import Icon from './components/Icon.jsx';

const online = (i) => (i ? new Set(i.state.agents.filter(a => a.online && a.kind !== 'human').map(a => a.name)).size : 0);

export default function Home() {
  useS();
  const [infos, setInfos] = useState({}), [invite, setInvite] = useState(''), [name, setName] = useState(auth.name), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [sent, setSent] = useState(false), [signErr, setSignErr] = useState(''), [devCode, setDevCode] = useState('');
  const names = Object.keys(known);

  useEffect(() => {
    for (const n of names) {
      const get = (ep) => fetch(`/api/p/${encodeURIComponent(n)}/${ep}`, { headers: { authorization: 'Bearer ' + known[n] } }).then(r => { if (r.status === 401) throw new Error('gone'); return r.json(); });
      Promise.all([get('state'), get('board').catch(() => null)]).then(([state, board]) => setInfos(i => ({ ...i, [n]: { state, board } }))).catch(() => setInfos(i => ({ ...i, [n]: null })));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function join(e) {
    e.preventDefault();
    const typed = invite.trim();
    const short = (/[#&]invite=([\w-]+)/.exec(typed) || [])[1] || typed.split(/\s+/).find(w => SHORT_INVITE.test(w));
    setBusy(true); setErr('');
    try {
      let inv = decodeInvite(typed);
      if (!inv && short) inv = await lookUpInvite(short, name.trim());
      if (!inv) throw new Error("That doesn't look like an invite code.");
      Object.assign(auth, inv);
      if (name.trim()) { auth.name = name.trim().replace(/\s+/g, '-'); store.set('huddle.name', auth.name); }
      if (await startProject() === 'project') location.reload(); else setErr(S.fatal);
    } catch (e2) { setErr(e2.message); }
    setBusy(false);
  }
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json().then(j => ({ ok: x.ok, ...j })));
  async function sendCode(e) { e.preventDefault(); setSignErr(''); const r = await post('/auth/email/start', { email, next: '/app' }); if (!r.ok) return setSignErr(r.error); setSent(true); setDevCode(r.dev ? r.dev.code : ''); }
  async function checkCode(e) { e.preventDefault(); setSignErr(''); const r = await post('/auth/email/code', { email, code }); if (!r.ok) return setSignErr(r.error); await loadAccount(); location.reload(); }
  async function demo() { setBusy(true); try { await (await import('./lib/demo.js')).openDemo((t) => (S.demoStatus = t)); } catch (e) { setErr("Couldn't set up the demo: " + e.message); } setBusy(false); }

  return (
    <div id="login" data-main>
      <div className="hhead"><div className="brand"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="var(--accent)" /><circle cx="11" cy="13" r="4.2" fill="var(--raised)" /><circle cx="21" cy="13" r="4.2" fill="var(--raised)" opacity=".85" /><circle cx="16" cy="21" r="4.2" fill="var(--raised)" opacity=".7" /></svg>huddle</div>
        <span className="grow"></span>
        {S.account.user && <span className="small muted">Signed in as <b>{S.account.user.email || S.account.user.login}</b> · <a href="/auth/logout">Sign out</a></span>}
        <a className="small muted" href="/?about">About</a></div>
      {S.demoStatus && <div className="muted" role="status">{S.demoStatus}</div>}
      {(err || S.fatal) && <div className="err" role="alert">{err || S.fatal}</div>}
      <section>
        <h1 className="htitle">Your projects</h1>
        <div className="hgrid">
          {names.map(n => {
            const i = infos[n];
            return (
              <div className="pcard" style={{ padding: 0 }} key={n}>
                <button className="ghost" data-nav style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 10, padding: 16, flex: 1 }} onClick={() => openProject(n)}>
                  <span className="pt"><Avatar name={prettyProject(n)} sm /><span>{prettyProject(n)}</span>{store.get('huddle.demo.' + n) && <span className="pill acc">Demo</span>}</span>
                  <span className="pm">{i === null ? <span className="err">Your access to this project ended</span> : !i ? 'Loading…' : (
                    <>
                      <span>{online(i) ? <b style={{ color: 'var(--ok)' }}>{online(i)} online</b> : 'Nobody online'}</span>
                      <span>{i.board ? i.board.tasks.filter(t => t.status !== 'done').length : 0} open tasks</span>
                      {i.board && i.board.tasks.some(t => t.status === 'blocked') && <span style={{ color: 'var(--bad)' }}>{i.board.tasks.filter(t => t.status === 'blocked').length} stuck</span>}
                    </>
                  )}</span>
                </button>
                <button className="pforget" aria-label={`Remove ${prettyProject(n)} from this list`} title="Remove from this list" onClick={() => { forgetProject(n); location.reload(); }}>×</button>
              </div>
            );
          })}
          {!names.length && <div className="hempty">No projects yet. Join one with an invite below{S.account.user ? '' : ', or sign in to see the ones on your account'}.</div>}
        </div>
      </section>
      <div className="hcols">
        <form className="hcard" onSubmit={join}>
          <h2>Join a project</h2>
          <p className="muted">Paste the invite code or link someone sent you.</p>
          <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="Invite code" autoComplete="off" aria-label="Invite code" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" autoComplete="name" aria-label="Your name" />
          <div className="lrow"><button className="primary" disabled={busy}>Open project</button></div>
        </form>
        {!S.account.user && (S.account.email || S.account.github) && (
          <div className="hcard">
            <h2>Sign in</h2>
            <p className="muted">Your projects follow you to any browser, and you can get notifications by email.</p>
            {S.account.email && (!sent
              ? <form onSubmit={sendCode} style={{ display: 'flex', gap: 8 }}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" aria-label="Email" required style={{ flex: 1 }} /><button className="primary">Email me a code</button></form>
              : <>
                <form onSubmit={checkCode} style={{ display: 'flex', gap: 8 }}><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" aria-label="Code from the email" style={{ flex: 1 }} /><button className="primary">Sign in</button></form>
                <p className="small muted" style={{ margin: 0 }}>Sent to {email}. Or click the link in the email. {devCode && `(Local server, no mail set up: the code is ${devCode}.)`} <button className="link" onClick={() => setSent(false)}>Use another email</button></p>
              </>)}
            {S.account.email && S.account.github && <div className="lor"><span>or</span></div>}
            {S.account.github && <a className="ghbtn" href="/auth/github/login?next=/app"><Icon name="github" size={16} />Sign in with GitHub</a>}
            {signErr && <p className="err small" style={{ margin: 0 }}>{signErr}</p>}
          </div>
        )}
        <div className="hcard">
          <h2>Start your own</h2>
          <p className="muted">In your project's folder, run:</p>
          <div className="cmd"><code>curl -fsSL {location.origin}/install.sh | sh</code></div>
          <button disabled={busy} onClick={demo}>Try a demo project</button>
        </div>
      </div>
    </div>
  );
}

// Home: the projects this browser and account know, sign in (email code or GitHub), join with an invite.
import { useEffect, useState } from 'react';
import { S, auth, known, decodeInvite, lookUpInvite, SHORT_INVITE, startProject, openProject, forgetProject, prettyProject, loadAccount } from './lib/state.js';
import { useS } from './lib/store.js';
import { store } from './lib/words.js';

const agoShort = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? 'now' : s < 3600 ? Math.round(s / 60) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };
import Icon from './components/Icon.jsx';
import Avatar from './components/Avatar.jsx';

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

  const people = (i) => {
    const by = {};
    for (const a of i.state.agents) if (a.kind !== 'human') { const b = by[a.name] || (by[a.name] = { name: a.name, online: false, seen: 0 }); b.online = b.online || a.online; b.seen = Math.max(b.seen, a.lastSeen || 0); }
    return Object.values(by).sort((a, b) => (b.online - a.online) || (b.seen - a.seen));
  };
  const latest = (i) => i.state.agents.filter(a => a.status && a.kind !== 'human').sort((a, b) => (b.statusAt || 0) - (a.statusAt || 0))[0];
  const rows = names.map(n => ({ n, i: infos[n] }));
  const total = (f) => rows.reduce((sum, r) => sum + (r.i ? f(r.i) : 0), 0);
  const blocked = (i) => i.board ? i.board.tasks.filter(t => t.status === 'blocked').length : 0;
  const open = (i) => i.board ? i.board.tasks.filter(t => t.status !== 'done').length : 0;
  const cmd = `curl -fsSL ${location.origin}/install.sh | sh`;
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {});

  return (
    <div id="login" className="home" data-main>
      <div className="hhead">
        <div className="brand"><span className="tilde">~/</span>huddle</div>
        <span className="grow"></span>
        {S.account.user && <span className="hwho">{S.account.user.email || S.account.user.login} · <a href="/auth/logout">sign out</a></span>}
        <a href="/?about">about</a>
        <button className="primary" disabled={busy} onClick={demo}>try the demo</button>
      </div>
      {S.demoStatus && <div className="hnote" role="status">{S.demoStatus}</div>}
      {(err || S.fatal) && <div className="hnote err" role="alert">{err || S.fatal}</div>}

      <div className="hbody">
        <div className="hhero"><h1 className="htitle"><span className="prompt">$</span> huddle projects</h1><p>Open one to see every teammate's agent at work.</p></div>

        <section className="pane hlist">
          <div className="pt"><b>projects <span className="cnt">{names.length}</span></b></div>
          {names.length > 0 && <div className="hrow hth"><span>project</span><span>latest</span><span>team</span><span>open</span><span>blocked</span><span>active</span></div>}
          {rows.map(({ n, i }) => {
            const team = i ? people(i) : [], last = i && latest(i), on = team.filter(p => p.online).length, seen = Math.max(0, ...team.map(p => p.seen));
            const b = i ? blocked(i) : 0;
            return (
              <div className={'hrow' + (i === null ? ' gone' : '')} key={n}>
                <button className="hopen" data-nav onClick={() => openProject(n)} aria-label={`Open ${prettyProject(n)}`}></button>
                <span className="hname"><i className={'dot' + (on ? ' full' : '')} />{prettyProject(n)}{store.get('huddle.demo.' + n) && <em>demo</em>}</span>
                <span className="hlast">{i === null ? <span className="bad">your access to this project ended</span> : !i ? <span className="faint">loading…</span> : last ? <><b>{last.name}</b> {last.status}</> : <span className="faint">nothing yet</span>}</span>
                <span className="hteam">{team.slice(0, 5).map(p => <span key={p.name} className={p.online ? 'on' : ''} title={`${p.name}${p.online ? ', online' : ''}`}><Avatar name={p.name} sm settings={i.state.settings} /></span>)}{team.length > 5 && <small>+{team.length - 5}</small>}</span>
                <span className="hnum">{i ? open(i) : '--'}</span>
                <span className={'hnum' + (b ? ' bad' : '')}>{i ? b : '--'}</span>
                <span className="hnum faint">{seen ? agoShort(seen) : '--'}</span>
                <button className="hforget" aria-label={`Remove ${prettyProject(n)} from this list`} title="Remove from this list" onClick={() => { forgetProject(n); location.reload(); }}>×</button>
              </div>
            );
          })}
          {!names.length && <div className="hempty">No projects in this browser yet. Join one with an invite{S.account.user ? '' : ', sign in to bring yours over'}, or start one in a repo.</div>}
        </section>

        <div className="hcols">
          <form className="pane hcard" onSubmit={join}>
            <div className="pt"><b>join with an invite</b></div>
            <div className="hfields">
              <input value={invite} onChange={(e) => setInvite(e.target.value)} placeholder="invite code or link" autoComplete="off" aria-label="Invite code" />
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="your name" autoComplete="name" aria-label="Your name" className="hname-in" />
              <button className="primary" disabled={busy}>join</button>
            </div>
          </form>
          <div className="pane hcard">
            <div className="pt"><b>start a project</b><span>in the repo's folder</span></div>
            <div className="hcmd"><code><span className="prompt">$</span> {cmd}</code><button type="button" onClick={copy}>{copied ? 'copied' : 'copy'}</button></div>
          </div>
          {!S.account.user && (S.account.email || S.account.github) && (
            <div className="pane hcard hsign">
              <div className="pt"><b>sign in</b><span>your projects in any browser</span></div>
              {S.account.email && (!sent
                ? <form onSubmit={sendCode} className="hfields"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" aria-label="Email" required /><button className="primary">email me a code</button></form>
                : <>
                  <form onSubmit={checkCode} className="hfields"><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" aria-label="Code from the email" /><button className="primary">sign in</button></form>
                  <p className="hsmall">Sent to {email}. {devCode && `(Local server, no mail set up: the code is ${devCode}.)`} <button className="link" onClick={() => setSent(false)}>use another email</button></p>
                </>)}
              {S.account.github && <a className="ghbtn" href="/auth/github/login?next=/app"><Icon name="github" size={14} />sign in with GitHub</a>}
              {signErr && <p className="err hsmall">{signErr}</p>}
            </div>
          )}
        </div>
      </div>

      <footer id="statusline" className="hstatus" aria-label="Status">
        <span className="mode">huddle</span>
        <span>{names.length} project{names.length === 1 ? '' : 's'}</span>
        <span><b>{total(i => people(i).filter(p => p.online).length)}</b> online</span>
        <span><b>{total(open)}</b> open</span>
        {total(blocked) > 0 && <span><em>{total(blocked)} blocked</em></span>}
        <span className="grow"></span>
        <span>{location.host}</span>
      </footer>
    </div>
  );
}

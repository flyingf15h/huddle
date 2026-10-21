// GitHub, a Studio tab: the connected repository (pull requests with checks, branches, recent commits, open
// issues) and merge conflicts between people's shared branches.
import { useEffect, useState } from 'react';
import { S, api, go, myName, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useLive } from '../lib/hooks.js';
import { ago } from '../lib/words.js';

const checkTone = (c) => (!c ? '' : c.state === 'failing' ? 'bad' : c.state === 'passing' ? 'ok' : 'warn');
const checkWord = (c) => (!c ? 'no checks' : c.state === 'failing' ? `${c.failed} failing` : c.state === 'passing' ? 'passing' : 'running');

export default function GitHub() {
  useS();
  const [repo, setRepo] = useState(null), [repoErr, setRepoErr] = useState(''), [loading, setLoading] = useState(false), [msg, setMsg] = useState('');
  async function loadRepo(fresh) {
    setLoading(true); setRepoErr('');
    try { setRepo(await api('repo' + (fresh ? '?fresh=1' : ''))); } catch (e) { setRepoErr(e.message); }
    setLoading(false);
  }
  useEffect(() => { if (S.projectSettings.repo) loadRepo(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive((ev) => { if (ev.type === 'repo' || (ev.type === 'project-setting' && S.projectSettings.repo)) loadRepo(false); });
  const toTeam = async (i) => { try { await api('repo-issue', { number: i.number }); go('tasks'); } catch (e) { setMsg(e.message); } };
  const openPr = async (b) => { try { const r = await api('repo-pr', { head: b }); setMsg(`Opened #${r.pr.number}.`); loadRepo(true); } catch (e) { setMsg(e.message); } };
  const resolve = async (c, x) => { try { await api('resolve-conflicts', { key: c.owner + '/' + c.branch, other: x.other }); go('tasks'); } catch (e) { setMsg(e.message); } };
  const rs = S.projectSettings.repo;
  const conflicts = S.conflicts.flatMap(c => c.items.map(x => ({ c, x })));

  return (
    <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="pageview formpage">
        {msg && <p className="small muted">{msg}</p>}
        {!rs ? (
          <div className="panel"><h3>repository</h3><p className="pdesc">Connect one to see pull requests, branches and issues here.</p>
            <div className="pactions" style={{ justifyContent: 'flex-start', paddingTop: 12 }}>{isOwner() ? <button className="primary" onClick={() => go('integrations')}>connect a repository</button> : <span className="muted small">an owner can connect one in settings → integrations</span>}</div></div>
        ) : (
          <>
            <div className="panel"><h3>repository</h3><div className="srow" style={{ borderTop: 0, marginTop: 8 }}><span className="grow"><b><a href={rs.url} target="_blank" rel="noopener noreferrer">{rs.full}</a></b>
              <span className="sub">{rs.private ? 'private' : 'public'} · default branch {rs.defaultBranch} · {rs.webhook ? 'updates arrive as people push' : (rs.webhookError || 'read every minute')}</span></span>
              <button onClick={() => loadRepo(true)} disabled={loading}>{loading ? 'reading…' : 'refresh'}</button></div></div>
            {(repoErr || (repo && repo.error)) && <p className="err">{repoErr || repo.error}</p>}
            {repo && repo.pulls && (
              <>
                <div className="panel"><h3>pull requests ({repo.pulls.length})</h3><div className="plist" style={{ borderTop: 0, marginTop: 8 }}>
                  {repo.pulls.map(p => <div className="srow" key={p.number}><span className={'pill ' + checkTone(p.checks)}>{checkWord(p.checks)}</span><span className="grow"><a href={p.url} target="_blank" rel="noopener noreferrer">#{p.number} {p.title}</a>{p.draft && <> <span className="pill">draft</span></>}<span className="sub">{p.head} → {p.base} · {p.author} · {ago(p.updated)}</span></span></div>)}
                  {!repo.pulls.length && <div className="srow muted">no open pull requests</div>}</div></div>
                <div className="panel"><h3>branches</h3><p className="pdesc">default branch checks: <span className={'pill ' + checkTone(repo.defaultChecks)}>{checkWord(repo.defaultChecks)}</span></p><div className="plist">
                  {repo.branches.map(b => <div className="srow" key={b.name}><span className="grow"><span className="mono">{b.name}</span>{b.protected && <> <span className="pill">protected</span></>}</span>
                    {b.name !== rs.defaultBranch && !repo.pulls.some(p => p.head === b.name) && <button className="ghost" onClick={() => openPr(b.name)}>open pull request</button>}</div>)}</div></div>
                <div className="panel"><h3>recent commits</h3><div className="plist" style={{ borderTop: 0, marginTop: 8 }}>
                  {repo.commits.map(c => <div className="srow" key={c.sha}><span className="mono small faint">{c.sha.slice(0, 7)}</span><span className="grow"><a href={c.url} target="_blank" rel="noopener noreferrer">{c.message}</a><span className="sub">{c.author} · {ago(c.at)}</span></span></div>)}</div></div>
                <div className="panel"><h3>open issues ({repo.issues.length})</h3><p className="pdesc">Send one to the team and an agent plans and does it.</p><div className="plist">
                  {repo.issues.map(i => <div className="srow" key={i.number}><span className="grow"><a href={i.url} target="_blank" rel="noopener noreferrer">#{i.number} {i.title}</a><span className="sub">{i.author} · {ago(i.updated)}{i.labels.length ? ' · ' + i.labels.join(', ') : ''}</span></span><button onClick={() => toTeam(i)}>send to team</button></div>)}
                  {!repo.issues.length && <div className="srow muted">no open issues</div>}</div></div>
              </>
            )}
          </>
        )}
        <div className="panel"><h3>merge conflicts ({conflicts.length})</h3><p className="pdesc">Branches that would conflict if merged.</p>
          <div className="plist">
            {conflicts.map(({ c, x }) => (
              <div className="srow" key={c.owner + c.branch + x.other} style={{ flexWrap: 'wrap' }}><span className="grow"><b>{c.owner}/{c.branch}</b> and <b>{x.other}</b><span className="sub">{x.files.join(', ')} · {ago(c.at)}</span></span>
                <button className="primary" data-nav onClick={() => resolve(c, x)}>resolve with {c.owner === myName() ? 'my agent' : c.owner + "'s agent"}</button></div>
            ))}
            {!conflicts.length && <div className="srow muted">no conflicts between shared branches</div>}
          </div></div>
      </div>
    </main>
  );
}

// Code: a person's shared branch file by file (committed or live), the connected GitHub repository
// (branches with checks, pull requests, commits, issues) and merge conflicts between branches.
import { useEffect, useRef, useState } from 'react';
import { S, api, go, myName, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useLive } from '../lib/hooks.js';
import { ago } from '../lib/words.js';
import Icon from '../components/Icon.jsx';

const checkTone = (c) => (!c ? '' : c.state === 'failing' ? 'bad' : c.state === 'passing' ? 'ok' : 'warn');
const checkWord = (c) => (!c ? 'no checks' : c.state === 'failing' ? `${c.failed} failing` : c.state === 'passing' ? 'passing' : 'running');

export default function Code() {
  useS();
  const [tab, setTab] = useState('files');
  const [refs, setRefs] = useState([]), [ref, setRef] = useState(null), [files, setFiles] = useState([]), [branch, setBranch] = useState(null), [skipped, setSkipped] = useState([]);
  const [path, setPath] = useState(null), [content, setContent] = useState(''), [label, setLabel] = useState(''), [live, setLive] = useState(false), [liveCopy, setLiveCopy] = useState(false), [hlLine, setHlLine] = useState(0), [err, setErr] = useState('');
  const [repo, setRepo] = useState(null), [repoErr, setRepoErr] = useState(''), [loadingRepo, setLoadingRepo] = useState(false), [msg, setMsg] = useState('');
  // the latest values, for the async loaders below
  const cur = useRef({}); cur.current = { ref, path, branch, live };
  const lockOf = (p) => Object.values(S.locks).find(l => l.path === p && (l.branch || null) === (branch || null));

  async function openFile(p, wantLive, line = 0, useRef_ = cur.current.ref, useBranch = cur.current.branch) {
    setPath(p); setHlLine(line); setErr('');
    const lc = !!Object.values(S.files).find(f => f.path === p && (f.branch || null) === (useBranch || null) && f.size);
    setLiveCopy(lc);
    try {
      if (wantLive && lc) { const f = await api('file?path=' + encodeURIComponent(p) + (useBranch ? '&branch=' + encodeURIComponent(useBranch) : '')); setContent(f.content); setLabel(`live, saved by ${f.byName} ${ago(f.at)}`); setLive(true); }
      else { const f = await api('git-blob?ref=' + encodeURIComponent(useRef_) + '&path=' + encodeURIComponent(p)); setContent(f.content); setLabel(`committed on ${useRef_} · ${f.sha.slice(0, 7)}`); setLive(false); }
    } catch (e) { setContent(''); setErr(e.message); }
    if (line) setTimeout(() => document.querySelector('.codebox .hl')?.scrollIntoView({ block: 'center' }), 50);
  }
  async function loadTree(r, keepPath) {
    const t = await api('git-tree?ref=' + encodeURIComponent(r));
    setFiles(t.files); setBranch(t.branch); setSkipped(t.skipped || []);
    let p = keepPath;
    if (!p || !t.files.some(f => f.path === p)) p = (t.files.find(f => /^readme/i.test(f.path)) || t.files[0] || {}).path;
    if (p) await openFile(p, false, 0, r, t.branch);
    return t;
  }
  async function loadRefs() {
    const r = await api('git-tree');
    const sorted = r.refs.sort((a, b) => b.at - a.at);
    setRefs(sorted);
    if (!sorted.length) { setFiles([]); return; }
    const k = cur.current.ref && sorted.some(x => x.owner + '/' + x.branch === cur.current.ref) ? cur.current.ref : sorted[0].owner + '/' + sorted[0].branch;
    setRef(k);
    await loadTree(k, cur.current.path);
  }
  async function loadRepo(fresh) {
    setLoadingRepo(true); setRepoErr('');
    try { setRepo(await api('repo' + (fresh ? '?fresh=1' : ''))); } catch (e) { setRepoErr(e.message); }
    setLoadingRepo(false);
  }
  useEffect(() => { loadRefs().catch(() => {}); loadRepo(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive((ev) => {
    const c = cur.current;
    if (ev.type === 'git' && ev.action === 'snapshot') loadRefs().catch(() => {});
    if (ev.type === 'file' && ev.file.path === c.path && (ev.file.branch || null) === (c.branch || null) && c.live) openFile(c.path, true);
    if (ev.type === 'repo' || (ev.type === 'project-setting' && S.projectSettings.repo)) loadRepo(false);
  });
  // search hands over a file or code line to open
  useEffect(() => {
    const o = S.codeOpen;
    if (!o) return;
    S.codeOpen = null; setTab('files');
    if (o.ref && o.ref !== cur.current.ref) { setRef(o.ref); loadTree(o.ref, o.path).then(() => openFile(o.path, false, o.line, o.ref)); }
    else openFile(o.path || o.file, !!o.file, o.line || 0);
  }, [S.codeOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  const toTeam = async (i) => { try { await api('repo-issue', { number: i.number }); go('tasks'); } catch (e) { setMsg(e.message); } };
  const openPr = async (b) => { try { const r = await api('repo-pr', { head: b }); setMsg(`Opened #${r.pr.number}.`); loadRepo(true); } catch (e) { setMsg(e.message); } };
  const resolve = async (c, x) => { try { await api('resolve-conflicts', { key: c.owner + '/' + c.branch, other: x.other }); go('tasks'); } catch (e) { setMsg(e.message); } };

  const tree = [];
  { let last = null; for (const f of files) { const i = f.path.lastIndexOf('/'); const d = i < 0 ? '' : f.path.slice(0, i); if (d !== last) { if (d) tree.push({ dir: d }); last = d; } tree.push({ f, name: f.path.slice(i + 1), indent: d ? 26 : 14 }); } }
  const conflictCount = S.conflicts.reduce((n, c) => n + c.items.length, 0);
  const rs = S.projectSettings.repo;

  return (
    <main data-main className="tview">
      <div className="tbar">
        <div className="seg sm" role="tablist">
          <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>Files</button>
          <button role="tab" aria-selected={tab === 'github'} className={tab === 'github' ? 'on' : ''} onClick={() => setTab('github')}><Icon name="github" size={14} /> GitHub{repo && repo.pulls && repo.pulls.length > 0 && <span className="ct">{repo.pulls.length}</span>}</button>
          <button role="tab" aria-selected={tab === 'conflicts'} className={tab === 'conflicts' ? 'on' : ''} onClick={() => setTab('conflicts')}>Conflicts{conflictCount > 0 && <span className="ct" style={{ color: 'var(--bad)' }}>{conflictCount}</span>}</button>
        </div>
        {msg && <span className="small muted">{msg}</span>}
      </div>

      {tab === 'files' && (
        <div id="codeview" className={refs.length ? '' : 'none'} style={{ flex: 1, minHeight: 0 }}>
          <div id="codeside">
            <div className="ref"><label htmlFor="coderef">Branch</label>
              <select id="coderef" value={ref || ''} onChange={(e) => { setRef(e.target.value); setPath(null); loadTree(e.target.value, null); }}>{refs.map(x => <option key={x.owner + x.branch} value={x.owner + '/' + x.branch}>{x.owner}'s {x.branch} · {x.count} files · {ago(x.at)}</option>)}</select></div>
            <div className="tree">
              {tree.map((d, i) => d.dir ? <div className="dir" key={'d' + i}>{d.dir}/</div>
                : <button key={d.f.path} data-nav className={d.f.path === path ? 'sel' : ''} style={{ paddingLeft: d.indent }} title={d.f.path} onClick={() => openFile(d.f.path, false)}>{lockOf(d.f.path) ? '🔒 ' : ''}{d.name}</button>)}
              {skipped.length > 0 && <><div className="dir">not shown (binary or large)</div>{skipped.slice(0, 30).map(p => <div key={p} className="small muted" style={{ padding: '1px 14px 1px 26px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p}</div>)}</>}
            </div>
          </div>
          <div id="codemain">
            {!refs.length ? <div className="empty"><h3>No code shared yet</h3><p style={{ margin: '0 auto', maxWidth: 420 }}>Branches appear here once a teammate commits. They are shared automatically at the end of each agent turn, or manually with <code>huddle publish</code>.</p></div>
              : err ? <div className="empty">{err}</div>
              : path ? (
                <>
                  <div className="crumb"><b className="mono" style={{ fontSize: 14 }}>{path}</b><span className="small muted">{label}</span>
                    {lockOf(path) && <span className="livebar">🔒 {lockOf(path).holderName} is editing</span>}
                    {liveCopy && <button className="small" onClick={() => openFile(path, !live)}>{live ? 'Show committed version' : 'Show live version'}</button>}</div>
                  <pre className="codebox">{content.split('\n').map((l, i) => <div key={i} className={'ln' + (i + 1 === hlLine ? ' hl' : '')}><span>{i + 1}</span><span>{l || ' '}</span></div>)}</pre>
                </>
              ) : null}
          </div>
        </div>
      )}

      {tab === 'github' && (
        <div className="viewpad">
          {!rs ? (
            <div className="empty"><h3>Connect your GitHub repository</h3><p style={{ margin: '0 auto', maxWidth: 480 }}>See branches with their checks, open pull requests, recent commits and issues here, get updates the moment someone pushes, and open pull requests from huddle.</p>
              <div className="acts">{isOwner() ? <button className="primary" onClick={() => { S.settingsTab = 'integrations'; go('settings'); }}>Connect a repository</button> : <span className="muted">An owner can connect one in Team &amp; settings.</span>}</div></div>
          ) : (
            <>
              <div className="panel"><div className="srow" style={{ borderTop: 0 }}><Icon name="github" /><span className="grow"><b><a href={rs.url} target="_blank" rel="noopener noreferrer">{rs.full}</a></b>
                <span className="sub">{rs.private ? 'Private' : 'Public'} · default branch {rs.defaultBranch} · {rs.webhook ? 'updates arrive as people push' : (rs.webhookError || 'read every minute')}</span></span>
                <button onClick={() => loadRepo(true)} disabled={loadingRepo}>{loadingRepo ? 'Reading…' : 'Refresh'}</button></div></div>
              {(repoErr || (repo && repo.error)) && <p className="err">{repoErr || repo.error}</p>}
              {repo && repo.pulls && (
                <>
                  <div className="panel"><h3>Pull requests</h3><div className="plist">
                    {repo.pulls.map(p => <div className="srow" key={p.number}><span className={'pill ' + checkTone(p.checks)}>{checkWord(p.checks)}</span><span className="grow"><a href={p.url} target="_blank" rel="noopener noreferrer">#{p.number} {p.title}</a>{p.draft && <> <span className="pill">Draft</span></>}<span className="sub">{p.head} → {p.base} · {p.author} · {ago(p.updated)}</span></span></div>)}
                    {!repo.pulls.length && <div className="srow muted">No open pull requests.</div>}</div></div>
                  <div className="panel"><h3>Branches</h3><p className="pdesc">Default branch checks: <span className={'pill ' + checkTone(repo.defaultChecks)}>{checkWord(repo.defaultChecks)}</span></p><div className="plist">
                    {repo.branches.map(b => <div className="srow" key={b.name}><span className="grow"><span className="mono">{b.name}</span>{b.protected && <> <span className="pill">Protected</span></>}</span>
                      {b.name !== rs.defaultBranch && !repo.pulls.some(p => p.head === b.name) && <button className="ghost" onClick={() => openPr(b.name)}>Open pull request</button>}</div>)}</div></div>
                  <div className="panel"><h3>Recent commits</h3><div className="plist">
                    {repo.commits.map(c => <div className="srow" key={c.sha}><span className="mono small faint">{c.sha.slice(0, 7)}</span><span className="grow"><a href={c.url} target="_blank" rel="noopener noreferrer">{c.message}</a><span className="sub">{c.author} · {ago(c.at)}</span></span></div>)}</div></div>
                  <div className="panel"><h3>Open issues</h3><p className="pdesc">Send one to the team and an agent plans and does it.</p><div className="plist">
                    {repo.issues.map(i => <div className="srow" key={i.number}><span className="grow"><a href={i.url} target="_blank" rel="noopener noreferrer">#{i.number} {i.title}</a><span className="sub">{i.author} · {ago(i.updated)}{i.labels.length ? ' · ' + i.labels.join(', ') : ''}</span></span><button onClick={() => toTeam(i)}>Send to team</button></div>)}
                    {!repo.issues.length && <div className="srow muted">No open issues.</div>}</div></div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'conflicts' && (
        <div className="viewpad">
          <p className="muted" style={{ marginTop: 0, maxWidth: 640 }}>Each person's huddle checks, after teammates share new commits, whether merging their branch into yours would conflict, without touching your files.</p>
          {S.conflicts.flatMap(c => c.items.map(x => (
            <div className="panel" key={c.owner + c.branch + x.other}><div className="srow" style={{ borderTop: 0, flexWrap: 'wrap' }}><Icon name="conflict" /><span className="grow"><b>{c.owner}/{c.branch}</b> ↔ <b>{x.other}</b><span className="sub">{ago(c.at)} · {x.files.length} file{x.files.length === 1 ? '' : 's'} changed on both sides</span></span>
              <button className="primary" data-nav onClick={() => resolve(c, x)}>Resolve with {c.owner === myName() ? 'my agent' : c.owner + "'s agent"}</button></div>
              <div className="pbody"><ul style={{ margin: 0, paddingLeft: 20 }}>{x.files.map(f => <li key={f} className="mono small">{f}</li>)}</ul>
                <p className="small muted" style={{ marginBottom: 0 }}>Or run <code>huddle merge {x.other}</code> yourself and ask your agent to settle the conflict markers.</p></div></div>
          )))}
          {!conflictCount && <div className="empty"><h3>No conflicts</h3><p style={{ margin: '0 auto', maxWidth: 420 }}>Nobody's shared branch conflicts with another's right now.</p></div>}
        </div>
      )}
    </main>
  );
}

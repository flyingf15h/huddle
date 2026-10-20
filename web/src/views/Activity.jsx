// Activity: the live feed of everyone's prompts, agent steps and replies, messages and changes,
// with the request box under it and the side panel (approvals, tasks, locks, recent files).
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { S, dn, claudeOf, toolOf } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { feedRows, visible } from '../lib/feed.js';
import { clock, fullDate, shortTitle, summarize, md, toolWords } from '../lib/words.js';
import Avatar from '../components/Avatar.jsx';
import Icon from '../components/Icon.jsx';
import Composer from '../components/Composer.jsx';
import SidePanel from '../components/SidePanel.jsx';
import FileDialog from '../components/FileDialog.jsx';

const openFile = (path, branch) => { S.fileOpen = { path, branch: branch || null }; };

function Note({ r }) {
  const e = r.e;
  const FileBtn = ({ p, b }) => <button className="link" onClick={() => openFile(p, b)}>{p}</button>;
  let body = null;
  if (e.kind === 'join') body = <><b>{dn(e.who)}</b> {e.agentKind === 'autopilot' ? 'turned on autopilot' : 'opened ' + toolOf(e.who)}</>;
  else if (e.kind === 'lock') body = <><b>{dn(e.who)}</b> {e.dir ? <>locked the whole <b>{e.path}</b> folder</> : <>started editing <FileBtn p={e.path} b={e.branch} /></>}{e.branch ? ` on ${e.branch}` : ''}</>;
  else if (e.kind === 'unlock') body = <><b>{dn(e.who)}</b> {e.stale ? 'went quiet, so huddle released' : 'is done with'} {e.path}</>;
  else if (e.kind === 'file') body = <><b>{dn(e.who)}</b> saved <FileBtn p={e.path} b={e.branch} /> <span className="faint">v{e.version}</span></>;
  else if (e.kind === 'git') body = <><b>{dn(e.who)}</b> shared <b>{e.branch}</b>{e.subject ? `: “${e.subject}”` : ''}</>;
  else if (e.kind === 'knowledge') body = <><b>{dn(e.who)}</b> {e.action === 'delete' ? 'deleted' : e.action === 'add' ? 'added' : 'updated'} {e.what === 'doc' ? 'the project brief' : e.what === 'memory' ? `the memory “${e.title}”` : `the skill “${e.title}”`}</>;
  else if (e.kind === 'approve') body = <><b>{dn(e.who)}</b> {e.approval.status === 'approved' ? 'allowed' : 'said no to'} <code>{e.approval.command}</code> for “{shortTitle(e.approval.title, 70)}”</>;
  else if (e.kind === 'task') body = <><b>{claudeOf(e.who)}</b> {e.text}</>;
  else if (e.kind === 'repo') {
    const g = e.repo;
    body = g.action === 'push' ? <><b>{g.person ? dn(g.person) : g.by}</b> pushed {g.count} commit{g.count === 1 ? '' : 's'} to <b>{g.branch}</b> on GitHub{g.commits && g.commits.length ? `: “${g.commits[g.commits.length - 1].message}”` : ''}</>
      : g.action === 'pr' ? <>Pull request <a href={g.url} target="_blank" rel="noopener noreferrer">#{g.number}</a> {g.what === 'closed' ? (g.state === 'merged' ? 'merged' : 'closed') : g.what}: “{g.title}”</>
      : g.action === 'checks' ? <>Checks <b style={{ color: g.state === 'failing' ? 'var(--bad)' : 'var(--ok)' }}>{g.state}</b> on {g.branch}</>
      : g.action === 'issue' ? <>New issue <a href={g.url} target="_blank" rel="noopener noreferrer">#{g.number}</a>: “{g.title}”</> : null;
  }
  return (
    <div className="note">
      <span className="ic"><Icon name={e.kind === 'repo' ? 'github' : e.kind} size={16} /></span>
      <span>{body}</span>
      {r.count > 1 && <span className="ncount" title={`Happened ${r.count} times`}>+{r.count - 1}</span>}
      <time className="nt" title={fullDate(r.at)}>{clock(r.at)}</time>
    </div>
  );
}

function Turn({ r }) {
  const [open, setOpen] = useState({}), [stepsOpen, setStepsOpen] = useState({});
  return (
    <div className={'turn' + (r.bot ? ' isbot' : '') + (r.toYou ? ' toyou' : '')} data-at={r.at0} tabIndex={-1}>
      {r.bot ? <Avatar bot /> : <Avatar name={r.who} />}
      <div className="tbody">
        <div className="thead"><b>{r.bot ? claudeOf(r.who) : dn(r.who)}</b>{r.bot && <span className="bottag">{toolOf(r.who)}</span>}{r.ctx && <span className="ctx">{r.ctx}</span>}<time title={fullDate(r.at0)}>{clock(r.at0)}</time></div>
        <div className="items">
          {r.items.map((it, i) => {
            const k = r.rowKey + ':' + i;
            if (it.kind === 'tools') return (
              <div className="it tools" key={k}><ul className={(it.steps.length > 4 ? 'long' : '') + (stepsOpen[k] ? ' open' : '')}>
                {it.steps.map((s, j) => { const w = toolWords(s.text); return <li key={j}><span className="verb">{w.verb}</span><span>{w.arg ? (w.code ? <code>{w.arg}</code> : w.arg) : null}</span></li>; })}
              </ul>{it.steps.length > 4 && <button className="link moresteps" onClick={() => setStepsOpen({ ...stepsOpen, [k]: !stepsOpen[k] })}>{stepsOpen[k] ? 'Show fewer' : `Show all ${it.steps.length} steps`}</button>}</div>);
            if (it.kind === 'prompt') return <div className="it prompt" key={k}>{it.text}</div>;
            if (it.kind === 'reply') {
              const sum = summarize(it.text), whole = sum === it.text.trim();
              return <div className="it reply" key={k}>{open[k] || whole
                ? <><div className="doc" style={{ fontSize: 14 }} dangerouslySetInnerHTML={{ __html: md(it.text) }} />{!whole && <button className="link small" onClick={() => setOpen({ ...open, [k]: false })}>Show less</button>}</>
                : <div className="sumline"><span className="st">{sum}</span><button className="link more" onClick={() => setOpen({ ...open, [k]: true })}>Full reply</button></div>}</div>;
            }
            if (it.kind === 'end') return <div className="it end" key={k}>Turn completed</div>;
            if (it.kind === 'goal') return <div className="it goal" key={k}>{it.goal.text}</div>;
            if (it.kind === 'plan') return (
              <div key={k}><div className="it plan">Split into {it.tasks.length} task{it.tasks.length === 1 ? '' : 's'}{it.goal && it.goal.plan ? ': ' + it.goal.plan : ''}</div>
                <div className="embed">{it.tasks.map(t => <div className="erow" key={t.id}><span className="tt" title={t.title}>{shortTitle(t.title, 80)}</span><span className="owner">{t.owner ? <><Avatar name={t.owner} sm /><span>{t.owner}</span></> : <span className="faint">anyone</span>}</span></div>)}</div></div>);
            if (it.kind === 'msg') return <div className="it msg" key={k}>{it.text}</div>;
            return null;
          })}
        </div>
      </div>
    </div>
  );
}

export default forwardRef(function Activity(_, composerRef) {
  useS();
  const feed = useRef(null), stick = useRef(true);
  const list = S.entries.filter(visible).slice(-700);
  const rows = feedRows(list);
  const onScroll = () => { const f = feed.current; stick.current = f.scrollTop + f.clientHeight > f.scrollHeight - 90; };
  // stay at the bottom while new things arrive, unless the person scrolled up to read
  useLayoutEffect(() => { if (stick.current && feed.current) feed.current.scrollTop = feed.current.scrollHeight; });
  // a search result in the feed: scroll to the turn at that time
  useEffect(() => {
    if (!S.feedJump) return;
    const at = S.feedJump; S.feedJump = null;
    setTimeout(() => { const el = [...feed.current.querySelectorAll('[data-at]')].find(x => Number(x.dataset.at) >= at); if (el) { stick.current = false; el.scrollIntoView({ block: 'center' }); el.focus(); } });
  }, [S.feedJump]);

  return (
    <main data-main>
      <section id="left">
        <div id="feed" ref={feed} onScroll={onScroll} aria-live="polite">
          {!list.length && (S.who || S.filter !== 'all'
            ? <div className="empty">{S.who ? `No activity from ${S.who} yet.` : 'No activity of this type yet.'}</div>
            : <div className="empty"><h3>No activity yet</h3><p style={{ margin: '0 auto', maxWidth: 460 }}>Prompts, replies and changes from every teammate's agent session will appear here.</p>
              <div className="acts"><button className="primary" onClick={() => composerRef.current && composerRef.current.focus()}>New request</button></div></div>)}
          {rows.map(r => r.type === 'day' ? <div className="day" key={r.key}>{r.label}</div>
            : r.type === 'card' ? (
              <div className="card handcard" key={r.key}><div className="kicker"><b>{dn(r.e.who)}</b> left a hand-off note{r.e.auto && <> <span className="faint">(noted by huddle)</span></>} · {clock(r.e.at)}</div>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.e.text}</div>{r.e.commits.length > 0 && <div className="small faint" style={{ marginTop: 4 }}>{r.e.commits.slice(0, 4).map((c, i) => <div key={i}>{c}</div>)}</div>}</div>)
            : r.type === 'note' ? <Note key={r.key} r={r} /> : <Turn key={r.rowKey} r={r} />)}
        </div>
        <Composer ref={composerRef} />
      </section>
      <SidePanel />
      <FileDialog />
    </main>
  );
});

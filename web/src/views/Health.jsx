// Health: is huddle working on everyone's computer: stuck work, approvals, outdated copies, errors,
// and what agents did on their own in the last day.
import { S, dn, toolOf } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { ago, fmtDur, bestTitle, stuckReason } from '../lib/words.js';
import { RUN_WORD, runPill } from '../lib/tasks.js';
import Avatar from '../components/Avatar.jsx';

const DAY = 86400000;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export default function Health() {
  useS();
  const by = new Map();
  for (const a of Object.values(S.agents)) {
    if (a.kind === 'human' || a.clone) continue;
    const p = by.get(a.name) || { name: a.name, online: false, runner: null, build: null, lastSeen: 0 };
    p.online = p.online || a.online;
    if (a.runner && a.online) p.runner = a.runner;
    if (a.build && (!p.build || a.build.at > p.build.at)) p.build = a.build;
    p.lastSeen = Math.max(p.lastSeen, a.lastSeen || 0);
    by.set(a.name, p);
  }
  const people = [...by.values()].sort((x, y) => (y.online - x.online) || x.name.localeCompare(y.name));
  const newest = Math.max(0, ...people.map(p => (p.build && p.build.at) || 0));
  const outdated = (p) => !p.build || p.build.at < newest - 60000;
  const tasks = S.board.tasks;
  const runs = tasks.flatMap(t => (t.runs || []).map(r => ({ ...r, task: t }))).filter(r => r.at > Date.now() - DAY).sort((a, b) => b.at - a.at);
  const problems = S.problems.filter(x => x.at > Date.now() - DAY).sort((a, b) => b.at - a.at);
  const title = (t) => bestTitle(t.title, t.detail).title;
  const todo = [
    ...tasks.filter(t => t.status === 'blocked').map(t => ({ sev: 'blocked', html: `<b>“${esc(title(t))}”</b> is stuck${t.owner ? ` (${esc(t.owner)})` : ''}: ${esc((stuckReason(t) || 'its agent gave up'))}. Open it in Tasks to run it again or mark it done.` })),
    ...S.approvals.map(x => ({ sev: 'doing', html: `<b>${esc(x.owner)}'s ${esc(toolOf(x.owner))}</b> is waiting for ${esc(x.owner)} to OK <code>${esc(x.command)}</code>${x.title ? ` for “${esc(x.title)}”` : ''}.` })),
    ...S.conflicts.flatMap(c => c.items.map(x => ({ sev: 'doing', html: `<b>${esc(c.owner)}/${esc(c.branch)}</b> would conflict with <b>${esc(x.other)}</b> in ${x.files.length} file${x.files.length === 1 ? '' : 's'}. Resolve it in Code.` }))),
    ...people.filter(outdated).map(p => ({ sev: 'doing', html: `<b>${esc(p.name)}'s huddle is out of date</b>, so newer features (background work, usage counting) don't run for them. ${esc(p.name)} should run <code>npx -y github:flyingf15h/huddle update</code> and restart their agent.` })),
    ...people.filter(p => p.online && (!p.runner || p.runner === 'off')).map(p => ({ sev: 'todo', html: `<b>${esc(p.name)}'s background work is ${p.runner === 'off' ? 'turned off' : 'not running'}</b>, so requests sent to ${esc(p.name)} wait until they handle them.` })),
    ...(problems.length ? [{ sev: 'blocked', html: `<b>${problems.length} error${problems.length === 1 ? ' was' : 's were'} reported</b> from teammates' computers in the last day. Details below.` }] : []),
  ];
  return (
    <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="pageview">
        <p className="muted" style={{ margin: '0 0 14px', maxWidth: 680 }}>Checks that huddle works on everyone's computer: their agent is connected, their huddle is up to date, and work their agents do on their own isn't failing.</p>
        <div className="panel"><div className="srow" style={{ borderTop: 0, minHeight: 56 }}>
          {todo.length ? <span className="pill warn" style={{ fontSize: 13 }}>{todo.length} thing{todo.length === 1 ? ' needs' : 's need'} attention</span>
            : <><span className="pill ok" style={{ fontSize: 13 }}>Everything is working</span><span className="muted">Nobody is stuck, everyone is up to date, and nothing failed in the last day.</span></>}</div>
          {todo.map((x, i) => <div className="srow" key={i}><span className={'dot ' + x.sev} aria-hidden="true"></span><span className="grow" dangerouslySetInnerHTML={{ __html: x.html }} /></div>)}</div>
        <div className="panel"><h3>Teammates</h3><p className="pdesc"><b>Background work</b>: whether their agent picks up requests and tasks on its own while they're away. <b>huddle</b>: whether their copy is the newest one on the team.</p>
          <div className="plist">{people.map(p => (
            <div className="srow" key={p.name}><Avatar name={p.name} sm /><span className="grow"><b>{dn(p.name)}</b><span className="sub">{toolOf(p.name) === 'Claude' ? 'Claude Code' : toolOf(p.name)} · {p.online ? 'online now' : 'last seen ' + ago(p.lastSeen)}</span></span>
              <span className="small muted hide-sm">Background work</span>
              {!p.online ? <span className="pill">Away</span> : p.runner === 'full' ? <span className="pill ok" title="Takes requests and team tasks on its own">On</span> : p.runner === 'requests' ? <span className="pill acc">Requests only</span> : <span className="pill warn">Off</span>}
              <span className="small muted hide-sm">huddle</span>{outdated(p) ? <span className="pill warn">Needs update</span> : <span className="pill ok">Up to date</span>}</div>))}
            {!people.length && <div className="srow muted">Nobody has opened an agent in this project yet.</div>}</div></div>
        <div className="panel"><h3>Errors in the last day</h3><p className="pdesc">Reported automatically when something breaks on a teammate's computer: an agent crashing, a huddle hook failing, a Slack, Discord or email alert not arriving.</p>
          <div className="plist">{problems.slice(0, 30).map(x => <div className="problem" key={x.id}><div className="pm"><b>{x.name}</b><span className="grow">{x.message}</span><span className="small muted">{ago(x.at)}</span></div>
            {x.detail && <details><summary className="small muted" style={{ cursor: 'pointer', marginTop: 4 }}>Technical details</summary><pre>{x.detail}</pre></details>}</div>)}
            {!problems.length && <div className="srow muted">None.</div>}</div></div>
        <div className="panel"><h3>Work agents did on their own, last day</h3><p className="pdesc">Requests and tasks that ran in the background. If an agent crashes partway, huddle runs it again, up to three tries.</p>
          <div className="plist">{runs.slice(0, 25).map((r, i) => <div className="srow" key={i}><span className={'pill ' + runPill(r.outcome)}>{({ ...RUN_WORD, retrying: 'Crashed, tried again', limit: 'Out of usage' })[r.outcome] || r.outcome}</span>
            <span className="grow">{title(r.task)}<span className="sub">{r.by}'s {r.agent === 'codex' ? 'Codex' : r.agent === 'cursor' ? 'Cursor' : 'Claude'}{r.attempt > 1 ? ` · try ${r.attempt}` : ''}{r.ms ? ' · took ' + fmtDur(r.ms) : ''}</span></span><span className="small muted">{ago(r.at)}</span></div>)}
            {!runs.length && <div className="srow muted">None in the last day.</div>}</div></div>
        <p className="small muted">Is the huddle server itself up? <a href="/status" target="_blank" rel="noopener noreferrer">{location.host}/status</a></p>
      </div>
    </main>
  );
}

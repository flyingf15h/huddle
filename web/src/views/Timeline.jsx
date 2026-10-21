// Timeline: the team's goals with deadlines, and the plan to reach them. Agents are told about both
// (studio.js briefing) and steer their work by it; an agent can draft the plan from the goals.
import { useEffect, useState } from 'react';
import { S, api, dn } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useLive } from '../lib/hooks.js';
import { ago } from '../lib/words.js';
import Avatar from '../components/Avatar.jsx';

const pad = (n) => String(n).padStart(2, '0');
const toInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const when = (ms) => new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
function left(ms) {
  const m = Math.round((ms - Date.now()) / 60000);
  if (m < 0) return { t: `${-m < 120 ? -m + ' min' : Math.round(-m / 60) + ' h'} overdue`, late: true };
  return { t: m < 120 ? `in ${m} min` : m < 2880 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} days`, soon: m < 180 };
}

export default function Timeline() {
  useS();
  const [t, setT] = useState(S.timeline || { milestones: [], plan: null });
  const [form, setForm] = useState({ title: '', due: toInput(Date.now() + 864e5), detail: '' });
  const [editPlan, setEditPlan] = useState(null), [msg, setMsg] = useState(''), [, tick] = useState(0);
  const load = () => api('timeline').then(r => setT(r.timeline)).catch(e => setMsg(e.message));
  useEffect(() => { load(); const i = setInterval(() => tick(x => x + 1), 30000); return () => clearInterval(i); }, []);
  useLive((ev) => { if (ev.type === 'timeline') setT(ev.timeline); });
  const run = (fn) => async () => { setMsg(''); try { await fn(); } catch (e) { setMsg(e.message); } };
  const add = run(async () => { const r = await api('timeline-milestone', { title: form.title, due: new Date(form.due).getTime(), detail: form.detail }); setT(r.timeline); setForm({ ...form, title: '', detail: '' }); });
  const toggle = (m) => run(async () => setT((await api('timeline-milestone', { id: m.id, done: !m.done })).timeline))();
  const remove = (m) => run(async () => { if (confirm(`Remove "${m.title}"?`)) setT((await api('timeline-milestone', { id: m.id, remove: true })).timeline); })();
  const savePlan = run(async () => { setT((await api('timeline-plan', { text: editPlan })).timeline); setEditPlan(null); });
  const draft = run(async () => { const r = await api('timeline-draft', {}); setMsg(`Sent to ${r.task.owner ? dn(r.task.owner) + "'s agent" : 'the team'}. The plan appears here when it's done.`); });
  const claims = Object.values(S.locks).filter(l => /^feature: /.test(l.note || ''));
  const byFeature = {};
  for (const l of claims) (byFeature[l.holderName + '\u0000' + l.note] = byFeature[l.holderName + '\u0000' + l.note] || { who: l.holderName, name: l.note.slice(9), paths: [], since: l.since }).paths.push(l.path);
  const open = t.milestones.filter(m => !m.done);
  const viewer = S.me.role === 'viewer';

  return (
    <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="pageview">
        <div className="panel"><h3>Goals</h3><p className="pdesc">What the team has to reach, and by when. Every agent is told the next goals and how much time is left, and steers its work by them. Close to a deadline they favour finishing and fixing over starting new things.</p>
          <div className="plist">
            {t.milestones.map(m => { const l = left(m.due); return (
              <div className="srow" key={m.id}>
                <input type="checkbox" checked={m.done} disabled={viewer} onChange={() => toggle(m)} aria-label={`${m.title} done`} />
                <span className="grow"><b style={m.done ? { textDecoration: 'line-through', fontWeight: 500 } : undefined}>{m.title}</b>
                  <span className="sub">{when(m.due)}{m.done ? ` · done ${m.doneBy ? 'by ' + dn(m.doneBy) + ' ' : ''}${ago(m.doneAt)}` : ''}{m.detail ? ' · ' + m.detail : ''}</span></span>
                {!m.done && <span className={'pill' + (l.late ? ' bad' : l.soon ? ' warn' : '')}>{l.t}</span>}
                {!viewer && <button className="ghost" onClick={() => remove(m)}>Remove</button>}
              </div>); })}
            {!t.milestones.length && <div className="srow"><span className="grow muted">No goals yet. A hackathon might have "Playable prototype" Saturday noon, "Art and sound in" Saturday night and "Submit" Sunday 9am.</span></div>}
          </div>
          {!viewer && <div className="pbody fieldset">
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 10 }}>
              <div><label htmlFor="tl-t">Goal</label><input id="tl-t" type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Playable prototype" /></div>
              <div><label htmlFor="tl-d">Due</label><input id="tl-d" type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} /></div></div>
            <div><label htmlFor="tl-x">What it means (optional)</label><input id="tl-x" type="text" value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} placeholder="One level start to finish, placeholder art is fine" /></div>
            <div className="pactions" style={{ padding: 0 }}><button className="primary" disabled={!form.title.trim() || !form.due} onClick={add}>Add goal</button></div></div>}
        </div>

        <div className="panel"><h3>Plan</h3><p className="pdesc">How the team gets to each goal. An agent can draft it from the goals, the brief and the board; edit it however you like. Agents read it at the start of every session.</p>
          {editPlan !== null ? (
            <div className="pbody"><textarea className="big" style={{ minHeight: 220 }} value={editPlan} onChange={(e) => setEditPlan(e.target.value)} aria-label="Plan" autoFocus />
              <div className="pactions" style={{ padding: '10px 0 0' }}><button onClick={() => setEditPlan(null)}>Cancel</button><button className="primary" onClick={savePlan}>Save plan</button></div></div>
          ) : (
            <div className="pbody">
              {t.plan ? <><pre className="plantext">{t.plan.text}</pre><p className="hintline">By {dn(t.plan.by)} {ago(t.plan.at)}</p></> : <p className="muted" style={{ margin: 0 }}>No plan yet.</p>}
              {!viewer && <div className="pactions" style={{ padding: '10px 0 0' }}>
                <button onClick={() => setEditPlan(t.plan ? t.plan.text : open.map(m => `${m.title}\n- `).join('\n\n'))}>{t.plan ? 'Edit' : 'Write it myself'}</button>
                <button className="primary" disabled={!t.milestones.length} onClick={draft}>{t.plan ? 'Redraft with an agent' : 'Draft with an agent'}</button></div>}
            </div>
          )}
          {msg && <p className="small" style={{ padding: '0 16px 12px' }}>{msg}</p>}
        </div>

        <div className="panel"><h3>Features being built</h3><p className="pdesc">What each agent has claimed right now. A claim locks only the few files of one feature, so the rest of a level or system stays open to everyone.</p>
          <div className="plist">
            {Object.values(byFeature).map(f => (
              <div className="srow" key={f.who + f.name}><Avatar name={f.who} sm /><span className="grow"><b>{f.name}</b><span className="sub">{dn(f.who)} · {ago(f.since)} · {f.paths.join(', ')}</span></span></div>))}
            {!claims.length && <div className="srow"><span className="grow muted">Nothing claimed right now.</span></div>}
          </div></div>
      </div>
    </main>
  );
}

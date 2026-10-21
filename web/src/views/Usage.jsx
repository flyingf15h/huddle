// Usage & cost: how much each person used their agent, and what those tokens would cost at API
// prices (subscriptions aren't billed per token, so it's the equivalent value). Charts are single
// series in one hue, with the numbers in tables beside them.
import { useEffect, useRef, useState } from 'react';
import { S, api, dn, go, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useLive } from '../lib/hooks.js';
import { fmtDur, fmtNum, tokenSum, tokensAll, ago } from '../lib/words.js';
import { money } from '../lib/tasks.js';
import { spanWord, inSpan } from '../lib/span.js';
import Avatar from '../components/Avatar.jsx';

const SPARK = 14;
const spark = (days) => { const keys = [...Array(SPARK)].map((_, i) => new Date(Date.now() - (SPARK - 1 - i) * 864e5).toISOString().slice(0, 10)); const vals = keys.map(k => (days[k] || {}).activeMs || 0); const mx = Math.max(...vals, 1); return keys.map((k, i) => ({ k, v: vals[i], h: Math.round(vals[i] / mx * 100) })); };
const topModel = (s) => Object.entries(s.models).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))[0];

export default function Usage() {
  useS();
  const [stats, setStats] = useState(null), [since, setSince] = useState(0), [costs, setCosts] = useState(null), [err, setErr] = useState(''), [range, setRange] = useState(30), [tip, setTip] = useState(null);
  const [budget, setBudget] = useState(''), [alertPct, setAlertPct] = useState(80), [prices, setPrices] = useState(''), [msg, setMsg] = useState(''), [showTable, setShowTable] = useState(false), [al, setAl] = useState(null);
  const budgetSet = useRef(false);

  async function load() {
    try {
      const [s, c] = await Promise.all([api('stats'), api('costs')]);
      setStats(s.stats); setSince(s.since); setCosts(c);
      if (!budgetSet.current && c.budget) { setBudget(String(c.budget.monthly)); setAlertPct(c.budget.alertPct); budgetSet.current = true; }
      setAl(a => a || c.alerts);
      setPrices(Object.entries(c.custom || {}).map(([m, p]) => `${m}: ${p.join(', ')}`).join('\n'));
    } catch (e) { setErr(e.message); }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const timer = useRef(null);
  useLive((ev) => { if (ev.type === 'stats' || ev.type === 'usage') { clearTimeout(timer.current); timer.current = setTimeout(load, 1500); } });

  async function saveCost() {
    setMsg('');
    try {
      const p = {};
      for (const line of prices.split('\n').map(l => l.trim()).filter(Boolean)) { const [m, rest] = line.split(':'); const n = (rest || '').split(',').map(Number); if (m && n.length >= 2 && n.every(isFinite)) p[m.trim()] = n; else throw new Error(`Couldn't read "${line}". Write: model: input, output, cache read, cache write (dollars per million tokens)`); }
      await api('cost-settings', { budget: Number(budget) > 0 ? { monthly: Number(budget), alertPct: Number(alertPct) } : null, prices: p, alerts: al });
      setMsg('Saved.'); await load();
    } catch (e) { setMsg(e.message); }
  }
  if (err) return <main data-main style={{ flex: 1 }}><div className="viewpad"><p className="err">{err}</p></div></main>;
  if (!stats || !costs) return <main data-main style={{ flex: 1 }}><div className="viewpad"><p className="muted">Loading…</p></div></main>;

  const people = Object.entries(stats).map(([name, s]) => ({ name, s, own: s.activeMs - (s.requestMs || 0), all: tokensAll(s), cost: costs.people[name] ? costs.people[name].cost : 0 })).sort((a, b) => b.cost - a.cost || b.own - a.own);
  const sum = (f) => people.reduce((t, p) => t + f(p), 0);
  const days = [];
  for (let i = range - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); days.push({ d, cost: (costs.days[d] || {}).cost || 0, by: (costs.days[d] || {}).by || {} }); }
  const maxDay = Math.max(0.01, ...days.map(d => d.cost)), maxPerson = Math.max(0.01, ...people.map(p => p.cost));
  const models = Object.entries(costs.models).sort((a, b) => b[1].cost - a[1].cost);
  const newest = Math.max(0, ...Object.values(S.agents).map(a => (a.build && a.build.at) || 0));
  const missing = [...new Set([...Object.values(S.agents).filter(a => a.kind !== 'human' && !a.clone).map(a => a.name), ...Object.keys(S.settings || {})])].filter(n => !stats[n]).map(n => {
    const builds = Object.values(S.agents).filter(a => a.name === n && a.build).map(a => a.build.at);
    return { name: n, why: !builds.length || Math.max(...builds) < newest - 60000 ? 'their huddle is too old to report usage; they need to run huddle update' : "they haven't finished a prompt in this project since usage counting started" };
  });
  const budgetPct = costs.budget ? Math.min(100, costs.monthSpend / costs.budget.monthly * 100) : 0;
  const showTip = (e, d) => { const r = e.currentTarget.getBoundingClientRect(); setTip({ d, x: r.left + r.width / 2, y: r.top }); };

  return (
    <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div id="statsview" style={{ flex: 1, overflowY: 'auto', padding: '16px 20px 28px' }}>
        <p className="small faint" style={{ marginTop: 0 }} title="Counted by each person's huddle hooks: numbers only, nothing of what was said. People on a plan aren't billed per token, so this is the value of the work, not a bill.">API-equivalent cost, counted since {new Date(since).toLocaleDateString()}.</p>
        <div className="tiles">
          <div className="tile"><div className="k">cost this month</div><div className="v">{money(costs.monthSpend)}</div></div>
          <div className="tile"><div className="k">{costs.budget ? 'monthly budget' : 'cost, all time'}</div><div className="v">{costs.budget ? money(costs.budget.monthly) : money(costs.total)}</div>
            {costs.budget && <div className="progress" style={{ maxWidth: 'none', marginTop: 6 }} role="progressbar" aria-valuenow={Math.round(budgetPct)} aria-valuemin={0} aria-valuemax={100} aria-label="Budget used"><span style={{ width: budgetPct + '%', background: budgetPct >= 100 ? 'var(--bad)' : budgetPct >= costs.budget.alertPct ? 'var(--warn)' : 'var(--ok)' }}></span></div>}</div>
          {costs.trend && costs.trend.projected != null && <div className="tile"><div className="k">month on course for</div><div className="v">{money(costs.trend.projected)}</div>{costs.budget && costs.trend.projected > costs.budget.monthly && <div className="small" style={{ color: 'var(--bad)' }}>over budget</div>}</div>}
          {costs.trend && costs.trend.avg > 0 && <div className="tile"><div className="k">cost today</div><div className="v">{money(costs.trend.today)}</div><div className="small faint">usually {money(costs.trend.avg)}{costs.trend.today > costs.trend.avg * 1.5 ? ', running high' : ''}</div></div>}
          <div className="tile"><div className="k">agent time {spanWord()}</div><div className="v">{fmtDur(sum(p => inSpan(p.s.days, 'activeMs')))}</div></div>
          <div className="tile"><div className="k">prompts {spanWord()}</div><div className="v">{fmtNum(sum(p => inSpan(p.s.days, 'turns')))}</div></div>
          <div className="tile"><div className="k">tokens {spanWord()}</div><div className="v">{fmtNum(sum(p => inSpan(p.s.days, 'tokens')))}</div></div>
        </div>

        <div className="panel"><h3>Cost per day</h3>
          <p className="pdesc">Last <span className="seg sm" style={{ margin: '0 4px' }}>{[14, 30, 60].map(n => <button key={n} className={range === n ? 'on' : ''} onClick={() => setRange(n)}>{n}</button>)}</span> days, API-equivalent dollars.</p>
          <div className="pbody">
            <div className="bars" role="img" aria-label={`Daily cost, ${money(days.reduce((t, d) => t + d.cost, 0))} over ${range} days`} style={{ height: 140 }}>
              {days.map(d => <button key={d.d} className="bar" tabIndex={-1} aria-label={`${d.d}: ${money(d.cost)}`} onMouseEnter={(e) => showTip(e, d)} onMouseLeave={() => setTip(null)} onFocus={(e) => showTip(e, d)}><i style={{ height: (d.cost ? Math.max(2, d.cost / maxDay * 100) : 0) + '%' }}></i></button>)}
            </div>
            <div className="axis small faint"><span>{days[0] && days[0].d.slice(5)}</span><span>max {money(maxDay)}</span><span>{days.length && days[days.length - 1].d.slice(5)}</span></div>
            <button className="link small" onClick={() => setShowTable(!showTable)}>{showTable ? 'Hide the table' : 'Show as a table'}</button>
            {showTable && <div style={{ maxHeight: 240, overflow: 'auto' }}><table className="stats" style={{ marginTop: 8 }}><thead><tr><th>Day</th><th>Cost</th></tr></thead><tbody>{days.slice().reverse().filter(d => d.cost).map(d => <tr key={d.d}><td>{d.d}</td><td>{money(d.cost)}</td></tr>)}</tbody></table></div>}
          </div></div>
        {tip && <div className="chartTip" style={{ left: tip.x, top: tip.y }}><b>{tip.d.d}</b><br />{money(tip.d.cost)}{Object.entries(tip.d.by).filter(([, v]) => v).map(([n, v]) => <span key={n}><br /><span className="faint">{dn(n)}</span> {money(v)}</span>)}</div>}

        <div className="hcols" style={{ marginBottom: 16 }}>
          <div className="panel" style={{ margin: 0 }}><h3>By person</h3><div className="pbody">
            {people.map(p => <div className="hbar" key={p.name}><span className="who"><Avatar name={p.name} sm /><span>{dn(p.name)}</span></span><span className="track"><i style={{ width: p.cost / maxPerson * 100 + '%' }}></i></span><span className="num">{money(p.cost)}</span></div>)}</div></div>
          <div className="panel" style={{ margin: 0 }}><h3>By model</h3><div className="pbody">
            {models.map(([m, x]) => <div className="hbar" key={m}><span className="who mono small">{m}</span><span className="track"><i style={{ width: (models[0][1].cost ? x.cost / models[0][1].cost * 100 : 0) + '%' }}></i></span><span className="num">{x.priced ? money(x.cost) : 'no price'}</span></div>)}
            {!models.length && <div className="quiet">No model usage yet.</div>}
            {costs.unpriced.length > 0 && <p className="small muted" style={{ marginBottom: 0 }}>No list price for {costs.unpriced.join(', ')}. {isOwner() ? 'Add one below.' : 'An owner can add one.'}</p>}</div></div>
        </div>

        {costs.tasks.length > 0 && (
          <div className="panel"><h3>Most expensive tasks</h3><div className="plist">
            {costs.tasks.slice(0, 8).map(t => <button key={t.id} className="srow" style={{ width: '100%', textAlign: 'left', borderRadius: 0, background: 'none', borderLeft: 0, borderRight: 0, borderBottom: 0 }} data-nav onClick={() => go('tasks', { task: t.id })}><span className="grow">{t.title}<span className="sub">{t.owner ? dn(t.owner) : 'Unassigned'} · {t.status}</span></span><span className="num">{money(t.cost)}</span><span className="small faint">{fmtNum(t.tokens)} tokens</span></button>)}</div></div>
        )}

        <div className="statswrap"><table className="stats">
          <thead><tr><th>Person</th><th>Cost</th><th>Conversations</th><th>Time with agents</th><th>Prompts</th><th>Tokens</th><th>Requests for others</th><th>Last {SPARK} days</th></tr></thead>
          <tbody>{people.map(({ name, s, own, all, cost }) => { const m = topModel(s); return (
            <tr key={name}><td><span className="who"><Avatar name={name} sm /><span>{dn(name)}<span className="sub">{m ? m[0] : 'no model usage yet'} · {ago(s.last)}</span></span></span></td>
              <td>{money(cost)}</td><td>{s.conversations}</td><td>{fmtDur(own)}</td><td>{fmtNum(s.turns)}</td>
              <td title={`input ${fmtNum(tokenSum(s, 'input'))} · cache read ${fmtNum(tokenSum(s, 'cacheRead'))} · cache write ${fmtNum(tokenSum(s, 'cacheWrite'))} · output ${fmtNum(tokenSum(s, 'output'))}`}>{fmtNum(all)}</td>
              <td title={`${fmtDur(s.requestMs || 0)} on requests from others`}>{s.requests || 0}</td>
              <td><span className="spark" title={`time with agents, last ${SPARK} days`}>{spark(s.days).map(b => <i key={b.k} style={{ height: b.h + '%' }} title={`${b.k}: ${fmtDur(b.v)}`}></i>)}</span></td></tr>); })}</tbody></table></div>

        {missing.length > 0 && <div className="panel" style={{ marginTop: 16 }}><h3>No usage from</h3><div className="plist">{missing.map(m => <div className="srow" key={m.name}><Avatar name={m.name} sm /><span className="grow"><b>{dn(m.name)}</b><span className="sub">{m.why}</span></span></div>)}</div></div>}

        {isOwner() && (
          <div className="panel" style={{ marginTop: 16 }}><h3>Budget and prices</h3><p className="pdesc">Owners get a notification when the month's cost passes the alert line and again at 100%. List prices for Claude models are built in; add your own for other models or a negotiated rate.</p>
            <div className="pbody fieldset">
              <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap' }}><div><label htmlFor="bud">Monthly budget ($)</label><input id="bud" type="number" min="0" step="10" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="No budget" /></div><div><label htmlFor="bpct">Alert at (%)</label><input id="bpct" type="number" min="10" max="99" value={alertPct} onChange={(e) => setAlertPct(e.target.value)} /></div></div>
              <div><label htmlFor="prc">Custom prices</label><textarea id="prc" value={prices} onChange={(e) => setPrices(e.target.value)} placeholder="gpt-5.5-codex: 1.25, 10" spellCheck={false} /><div className="hintline">One model per line: <code>name: input, output, cache read, cache write</code>, dollars per million tokens.</div></div>
              {al && <div><span className="lbl2">Cost alerts</span>
                <div className="checks" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 8 }}>
                  <label><input type="checkbox" checked={!!al.spike} onChange={(e) => setAl({ ...al, spike: e.target.checked })} />A day costs <input type="number" min="1.2" step="0.1" style={{ width: 70, margin: '0 4px' }} value={al.spikeMultiple} onChange={(e) => setAl({ ...al, spikeMultiple: e.target.value })} aria-label="Spike multiple" />times the usual and at least $<input type="number" min="0" style={{ width: 70, margin: '0 4px' }} value={al.spikeMinUsd} onChange={(e) => setAl({ ...al, spikeMinUsd: e.target.value })} aria-label="Spike minimum dollars" /></label>
                  <label><input type="checkbox" checked={!!al.forecast} onChange={(e) => setAl({ ...al, forecast: e.target.checked })} />The month is on course to pass the budget</label>
                  <label><input type="checkbox" checked={!!al.task} onChange={(e) => setAl({ ...al, task: e.target.checked })} />One task costs more than $<input type="number" min="0.5" style={{ width: 70, margin: '0 4px' }} value={al.taskUsd} onChange={(e) => setAl({ ...al, taskUsd: e.target.value })} aria-label="Task dollars" /></label></div>
                <div className="hintline">Owners are told in the bell, by email and in any Slack or webhook channel that listens for cost alerts.</div></div>}
            </div><div className="pactions"><span className={'small' + (msg && msg !== 'Saved.' ? ' err' : '')}>{msg}</span><button className="primary" onClick={saveCost}>Save</button></div></div>
        )}
      </div>
    </main>
  );
}

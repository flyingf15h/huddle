// Owners and members: schedules that start a request at a set time, and GitHub issues that start requests.
import { useEffect, useState } from 'react';
import { S, api, isOwner, dn, people, myName } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { ago } from '../lib/words.js';

const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
const DAYS = { daily: 'every day', weekdays: 'weekdays', weekly: 'every week' };
const tzNow = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
const blank = () => ({ name: '', text: '', hour: 9, days: 'weekdays', to: '', tz: tzNow() });

export default function Automations() {
  useS();
  const [d, setD] = useState(null), [f, setF] = useState(null), [msg, setMsg] = useState(null), [tmsg, setTmsg] = useState(null), [label, setLabel] = useState('');
  const owner = isOwner(), team = people().map(p => p.name);
  const say = (t, bad) => setMsg(t ? { t, bad } : null);
  const load = () => api('automations').then(r => { setD(r); setLabel(r.trigger.label); }).catch(e => say(e.message, true));
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const wrap = (fn) => async (...a) => { say(''); try { await fn(...a); await load(); } catch (e) { say(e.message, true); } };
  const save = wrap(async () => { await api('automation-set', { ...f, to: f.to || null }); setF(null); });
  const toggle = wrap((x) => api('automation-set', { ...x, enabled: !x.enabled }));
  const remove = wrap((x) => confirm(`Remove “${x.name}”?`) && api('automation-set', { remove: x.id }));
  const runNow = wrap(async (x) => { const r = await api('automation-set', { run: x.id }); say(r.started ? 'Started. It shows up on the board.' : 'Nothing started (is the last run still going?).'); });
  const trig = async (patch) => { setTmsg(null); try { await api('trigger-settings', patch); await load(); } catch (e) { setTmsg(e.message); } };
  const t = d.trigger;
  return (
    <>
      <div className="panel"><h3>Schedules</h3>
        <p className="pdesc">A request that starts by itself at a set time, like “update the changelog” every weekday morning or “look for flaky tests” on Fridays. The next free agent picks it up, and it asks for approval the same as any request.</p>
        <div className="plist">{d.automations.map(x => (
          <div className="srow" key={x.id}><span className="grow"><b>{x.name}</b><span className="sub">{DAYS[x.days]} at {hourLabel(x.hour)} ({x.tz}){x.to ? ' · for ' + dn(x.to) : ' · whoever is free'}{x.lastDate ? ' · last ran ' + x.lastDate : ''}</span></span>
            {owner || x.by === myName() ? <>
              <button className="toggle" role="switch" aria-checked={!!x.enabled} aria-label={`${x.name} on`} onClick={() => toggle(x)}></button>
              <button onClick={() => runNow(x)}>Run now</button><button className="ghost" onClick={() => setF({ ...x, to: x.to || '' })}>Edit</button><button className="ghost" onClick={() => remove(x)}>Remove</button></> : null}</div>))}
          {!d.automations.length && <div className="srow muted">No schedules yet.</div>}</div>
        {f ? (
          <div className="pbody fieldset">
            <div><label htmlFor="as-n">Name</label><input id="as-n" type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Morning changelog" /></div>
            <div><label htmlFor="as-t">What should it do</label><textarea id="as-t" value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} placeholder="Update CHANGELOG.md from yesterday's merged work." /></div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
              <div><label htmlFor="as-d">When</label><select id="as-d" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })}>{Object.entries(DAYS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div><label htmlFor="as-h">At</label><select id="as-h" value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })}>{[...Array(24)].map((_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></div>
              <div className="small muted" style={{ paddingBottom: 8 }}>{f.tz}</div>
              <div><label htmlFor="as-p">For</label><select id="as-p" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}><option value="">Whoever is free</option>{team.map(n => <option key={n} value={n}>{dn(n)}</option>)}</select></div></div>
            <div className="row"><button className="primary" disabled={!f.text.trim()} onClick={save}>Save schedule</button><button onClick={() => setF(null)}>Cancel</button></div>
          </div>
        ) : <div className="pactions"><span className={'small' + (msg && msg.bad ? ' err' : '')}>{msg && msg.t}</span><button className="primary" onClick={() => setF(blank())}>Add a schedule</button></div>}
      </div>

      <div className="panel"><h3>Start requests from GitHub</h3>
        <p className="pdesc">Label an issue, or comment <code>/huddle</code> on one, and it becomes a request on the board. {d.repo ? '' : 'Connect a repository first (above).'}</p>
        <div className="switchrow" style={{ borderTop: 0 }}><span className="grow"><b>Let GitHub start requests</b><span>Only people who can write to the repository can trigger it.</span></span>
          <button className="toggle" role="switch" aria-checked={!!t.github} aria-label="Let GitHub start requests" disabled={!owner || !d.repo} onClick={() => trig({ github: !t.github })}></button></div>
        {t.github && <div className="pbody fieldset">
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
            <div><label htmlFor="tr-l">Label</label><input id="tr-l" type="text" value={label} disabled={!owner} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== t.label && trig({ label })} /></div>
            <div><label htmlFor="tr-t">Who gets them</label><select id="tr-t" value={t.to || ''} disabled={!owner} onChange={(e) => trig({ to: e.target.value || null })}><option value="">Whoever is free</option>{team.map(n => <option key={n} value={n}>{dn(n)}</option>)}</select></div></div>
          <label className="checks" style={{ gap: 6 }}><input type="checkbox" checked={!!t.ack} disabled={!owner} onChange={(e) => trig({ ack: e.target.checked })} />Reply on the issue when the request is picked up</label></div>}
        {!owner && <p className="readonly-note">Only the project owner can change this.</p>}
        {tmsg && <p className="small err" style={{ padding: '0 16px 12px' }}>{tmsg}</p>}
      </div>
    </>
  );
}

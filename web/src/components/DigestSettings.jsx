// Owners: whether there's a daily digest, who gets it, and how (email, a pop-up in the dashboard, or both).
import { useEffect, useState } from 'react';
import { S, api, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';

const hourLabel = (h) => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
const browserTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

export default function DigestSettings() {
  useS();
  const [cfg, setCfg] = useState(null), [counts, setCounts] = useState({ recipients: 0, everyone: 0 }), [msg, setMsg] = useState(null), [busy, setBusy] = useState(false);
  const owner = isOwner();
  useEffect(() => { api('digests').then(r => { setCfg(r.settings); setCounts({ recipients: r.recipients, everyone: r.everyone }); }).catch(() => {}); }, [S.projectSettings.digest]);
  if (!cfg) return null;
  const say = (t, bad) => setMsg({ t, bad });
  const set = (k, v) => setCfg({ ...cfg, [k]: v });
  const save = async () => {
    setBusy(true); say('');
    try {
      // the first time it's switched on, use this computer's time zone
      const tz = !(S.projectSettings.digest && S.projectSettings.digest.tz) ? browserTz() : cfg.tz;
      const r = await api('digest-settings', { ...cfg, tz }); setCfg(r.settings); say('Saved.');
    } catch (e) { say(e.message, true); }
    setBusy(false);
  };
  const preview = async () => { setBusy(true); say(''); try { const r = await api('digest-now', {}); S.digestShow = { ...r.digest, preview: true }; } catch (e) { say(e.message, true); } setBusy(false); };
  const sendNow = async () => {
    if (!confirm(`Send today's digest now to ${cfg.to === 'everyone' ? 'everyone' : 'the owners'}?`)) return;
    setBusy(true); say('');
    try { const r = await api('digest-now', { deliver: true }); say(`Sent: ${r.sent.popup} pop-up${r.sent.popup === 1 ? '' : 's'}, ${r.sent.email} email${r.sent.email === 1 ? '' : 's'}.`); } catch (e) { say(e.message, true); }
    setBusy(false);
  };
  const noOwners = !S.me.accounts;
  return (
    <div className="panel"><h3>Daily digest</h3>
      <p className="pdesc">A short summary once a day: what finished, what's stuck and needs a person, and what the agents cost. A day with nothing to report sends nothing.</p>
      <div className="switchrow" style={{ borderTop: 0 }}><span className="grow"><b>Send a daily digest</b><span>Off by default.</span></span><button className="toggle" role="switch" aria-checked={!!cfg.enabled} aria-label="Send a daily digest" disabled={!owner} onClick={() => set('enabled', !cfg.enabled)}></button></div>
      {cfg.enabled && (
        <div className="pbody fieldset">
          <div><span className="lbl2">Who gets it</span>
            <div className="seg sm" role="group" aria-label="Who gets it">{[['owners', 'Owners only'], ['everyone', 'Everyone']].map(([k, l]) => <button key={k} className={cfg.to === k ? 'on' : ''} disabled={!owner} onClick={() => set('to', k)}>{l}</button>)}</div>
            <div className="hintline">{noOwners ? 'Accounts aren\'t set up, so everyone gets it until there are owners (Team & access).' : `${cfg.to === 'everyone' ? counts.everyone : counts.recipients} ${(cfg.to === 'everyone' ? counts.everyone : counts.recipients) === 1 ? 'person' : 'people'} right now. Owners are the managers; members and viewers get it only if you pick Everyone.`}</div></div>
          <div><span className="lbl2">How</span>
            <div className="checks"><label><input type="checkbox" checked={!!cfg.email} disabled={!owner} onChange={(e) => set('email', e.target.checked)} />Email</label><label><input type="checkbox" checked={!!cfg.popup} disabled={!owner} onChange={(e) => set('popup', e.target.checked)} />Pop-up in the dashboard</label><label><input type="checkbox" checked={!!cfg.slack} disabled={!owner} onChange={(e) => set('slack', e.target.checked)} />Slack channel</label></div>
            <div className="hintline">Email goes to people who linked their account to the project. Everyone also gets it in the bell. Each person can turn their own digest email off under What you're told about.</div></div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
            <div><label htmlFor="dg-h">Time</label><select id="dg-h" value={cfg.hour} disabled={!owner} onChange={(e) => set('hour', Number(e.target.value))}>{[...Array(24)].map((_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></div>
            <div className="small muted" style={{ paddingBottom: 8 }}>{(S.projectSettings.digest && S.projectSettings.digest.tz) || browserTz()}</div>
            <label className="checks" style={{ gap: 6, paddingBottom: 6 }}><input type="checkbox" checked={!!cfg.weekdaysOnly} disabled={!owner} onChange={(e) => set('weekdaysOnly', e.target.checked)} />Weekdays only</label>
          </div>
        </div>
      )}
      <div className="pactions">{msg && <span className={'small' + (msg.bad ? ' err' : '')}>{msg.t}</span>}
        {owner && <><button disabled={busy} onClick={preview}>Preview</button><button disabled={busy} onClick={sendNow}>Send now</button><button className="primary" disabled={busy} onClick={save}>Save</button></>}
        {!owner && <span className="small muted">Only the project owner can change this.</span>}</div>
    </div>
  );
}

// Slack: create the app from a ready-made manifest, paste two values, link a channel, and say who is who.
import { useEffect, useState } from 'react';
import { api, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';

export default function SlackSetup() {
  useS();
  const [d, setD] = useState(null), [secret, setSecret] = useState(''), [hook, setHook] = useState(''), [code, setCode] = useState(null), [msg, setMsg] = useState(null), [man, setMan] = useState(false);
  const owner = isOwner();
  const say = (t, bad) => setMsg(t ? { t, bad } : null);
  const load = () => api('slack').then(setD).catch(e => say(e.message, true));
  useEffect(() => { load(); }, []);
  if (!d) return null;
  const wrap = (fn) => async (...a) => { say(''); try { await fn(...a); await load(); } catch (e) { say(e.message, true); } };
  const saveKeys = wrap(async () => { const b = {}; if (secret.trim()) b.signingSecret = secret.trim(); if (hook.trim()) b.webhook = hook.trim(); await api('slack-setup', b); setSecret(''); setHook(''); say('Saved.'); });
  const getCode = wrap(async (kind) => { setCode({ kind, ...(await api('slack-code', { kind })) }); });
  const anyone = wrap((v) => api('slack-setup', { anyone: v }));
  const remove = wrap(async () => { if (confirm('Disconnect Slack from this project?')) { await api('slack-setup', { remove: true }); setCode(null); } });
  return (
    <div className="panel"><h3>slack</h3>
      <p className="pdesc"><code>/huddle</code> commands and approve buttons in a channel.</p>
      {!owner && !d.configured && <p className="readonly-note">Only the project owner can set this up.</p>}
      {owner && !d.configured && (
        <div className="pbody fieldset">
          <div><span className="lbl2">1. Create the app</span>
            {d.createUrl ? <><a className="ghbtn" style={{ display: 'inline-flex' }} href={d.createUrl} target="_blank" rel="noopener noreferrer">Create the Slack app</a>
              <div className="hintline">opens Slack pre-filled; install it to a channel after.{' '}<button className="link small" onClick={() => setMan(!man)}>{man ? 'Hide' : 'Show'} the manifest</button></div>
              {man && <pre className="codebox" style={{ maxHeight: 200, padding: 8, fontSize: 12 }}>{typeof d.manifest === 'string' ? d.manifest : JSON.stringify(d.manifest, null, 2)}</pre>}</>
              : <div className="hintline">Open this page from the hosted dashboard to get the one-click link.</div>}</div>
          <div><label htmlFor="sl-s">2. Signing secret</label><input id="sl-s" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="Basic Information → App Credentials" /></div>
          <div><label htmlFor="sl-w">3. Incoming webhook URL</label><input id="sl-w" type="password" autoComplete="off" value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://hooks.slack.com/services/…" /></div>
          <div className="row"><button className="primary" disabled={!secret.trim() && !hook.trim()} onClick={saveKeys}>Save</button></div>
        </div>
      )}
      {d.configured && (
        <div className="pbody fieldset">
          <div className="small">{d.linked ? <>Linked to {d.channelName ? <b>#{d.channelName.replace(/^#/, '')}</b> : 'a channel'}.</> : 'Not linked to a channel yet.'}{d.webhook ? '' : ' No webhook yet, so nothing is posted.'}</div>
          {owner && <div><button onClick={() => getCode('link')}>{d.linked ? 'Link a different channel' : 'Link a channel'}</button>
            <div className="hintline">run the code it gives you in that channel</div></div>}
          <div><button onClick={() => getCode('me')}>{d.mine ? 'Re-link my Slack account' : 'This is me in Slack'}</button>
            <div className="hintline">so only you can press your approve buttons{d.people.length ? ` · linked: ${d.people.join(', ')}` : ''}</div></div>
          {code && <div className="srow" style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)' }}><span className="grow">In Slack, run:<span className="sub mono" style={{ userSelect: 'all' }}>{code.command}</span></span><button className="ghost" onClick={() => navigator.clipboard && navigator.clipboard.writeText(code.command)}>Copy</button></div>}
          {owner && <label className="checks" style={{ gap: 6 }}><input type="checkbox" checked={d.anyone} onChange={(e) => anyone(e.target.checked)} />Anyone in the linked channel can send requests (otherwise only linked accounts)</label>}
          {owner && <div><button className="danger" onClick={remove}>Disconnect Slack</button></div>}
        </div>
      )}
      {msg && <p className={'small' + (msg.bad ? ' err' : '')} style={{ padding: '0 16px 12px' }}>{msg.t}</p>}
    </div>
  );
}

// Shown to someone who has the project open in the browser but hasn't connected a computer yet:
// the exact steps to join, with their own invite and name filled in. Gone once their computer shows up.
import { useEffect, useState } from 'react';
import { S, api, auth, prettyProject } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { store } from '../lib/words.js';

const PKG = 'npx -y github:flyingf15h/huddle';
const quote = (s) => (/^[\w.-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`);

export default function ConnectPanel() {
  useS();
  const [code, setCode] = useState(''), [copied, setCopied] = useState(''), [hidden, setHidden] = useState(() => store.get('huddle.connect.hide.' + auth.project) === '1');
  const me = auth.name;
  const connected = Object.values(S.agents).some(a => a.name === me && (a.kind !== 'human' || a.checkout));
  const show = !S.demo && !!me && !connected && !hidden;
  useEffect(() => {
    if (!show || code) return;
    const long = () => btoa(JSON.stringify({ s: location.origin, t: auth.token, p: auth.project })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    api('invite-code', {}).then(r => r.code, () => long()).then(setCode);
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!show) return null;
  const server = location.origin === 'https://huddle.sage-hill.workers.dev' ? '' : ` --server ${location.origin}`;
  const join = code ? `${PKG} join ${code} --name ${quote(me)}${server}` : 'Making your invite…';
  const doctor = `${PKG} doctor`;
  const repo = S.projectSettings.repo && S.projectSettings.repo.full;
  const copy = (text, k) => navigator.clipboard.writeText(text).then(() => { setCopied(k); setTimeout(() => setCopied(''), 1500); });
  const hide = () => { store.set('huddle.connect.hide.' + auth.project, '1'); setHidden(true); };
  const Cmd = ({ text, k }) => <div className="cmd"><code>{text}</code><button onClick={() => copy(text, k)} disabled={!code && k === 'join'}>{copied === k ? 'Copied' : 'Copy'}</button></div>;
  return (
    <div className="panel" id="connect" style={{ margin: '16px 20px 0', padding: '16px 20px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>Connect your computer to {prettyProject(auth.project)}</h3>
        <button className="ghost" onClick={hide}>Hide</button>
      </div>
      <p className="small muted" style={{ marginTop: 6 }}>You're watching in the browser. To work with your own Claude, do this once on your computer. You need Node 18 or newer, git and Claude Code.</p>
      <ol style={{ paddingLeft: 20, margin: '12px 0 0' }}>
        <li>Open a terminal in your copy of the project{repo ? <> (no copy yet? <code>git clone https://github.com/{repo}</code>, then <code>cd</code> into it)</> : ' (the folder you normally start Claude in)'}.</li>
        <li>Join the huddle from that folder:<Cmd text={join} k="join" /></li>
        <li>Check it worked. Every line should have a tick:<Cmd text={doctor} k="doctor" /></li>
        <li>Start Claude in that same folder with <code>claude</code>. This box goes away once your computer shows up.</li>
      </ol>
    </div>
  );
}

// A popup with the steps to connect your computer, with your own invite and name filled in.
// It opens by itself when someone arrives from an invite link, and from "connect your computer" in
// the sidebar. It closes for good once their computer shows up.
import { useEffect, useState } from 'react';
import { S, api, auth, prettyProject } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useEscape } from '../lib/hooks.js';

const PKG = 'npx -y github:flyingf15h/huddle';
const quote = (s) => (/^[\w.-]+$/.test(s) ? s : `"${s.replace(/"/g, '')}"`);

export const isConnected = () => Object.values(S.agents).some(a => a.name === auth.name && (a.kind !== 'human' || a.checkout));

export default function ConnectPanel() {
  useS();
  const [code, setCode] = useState(''), [copied, setCopied] = useState('');
  const show = !!S.connectOpen && !S.demo && !!auth.name && !isConnected();
  useEscape(() => (S.connectOpen = false), show);
  useEffect(() => {
    if (!show || code) return;
    const long = () => btoa(JSON.stringify({ s: location.origin, t: auth.token, p: auth.project })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    api('invite-code', {}).then(r => r.code, () => long()).then(setCode);
  }, [show]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!show) return null;
  const close = () => (S.connectOpen = false);
  const server = location.origin === 'https://huddle.sage-hill.workers.dev' ? '' : ` --server ${location.origin}`;
  const join = code ? `${PKG} join ${code} --name ${quote(auth.name)}${server}` : 'Making your invite…';
  const repo = S.projectSettings.repo && S.projectSettings.repo.full;
  const copy = (text, k) => navigator.clipboard.writeText(text).then(() => { setCopied(k); setTimeout(() => setCopied(''), 1500); });
  const Cmd = ({ text, k }) => <div className="cmd"><code>{text}</code><button className="primary" onClick={() => copy(text, k)} disabled={!code && k === 'join'}>{copied === k ? 'Copied' : 'Copy'}</button></div>;
  const steps = [
    ['Get the tools', <>You need <b>Node 18 or newer</b>, <b>git</b> and <b>Claude Code</b> on your computer. Skip this if you have them.</>],
    ['Open a terminal in the project folder', repo
      ? <>Use your copy of the project. No copy yet? Run <code>git clone https://github.com/{repo}</code> and <code>cd</code> into it.</>
      : <>Use your copy of the project, or make a new empty folder. Huddle brings the team's code.</>],
    ['Join the team', <>Paste this into that terminal and press Enter.<Cmd text={join} k="join" /></>],
    ['Check it worked', <>Every line should show a tick.<Cmd text={`${PKG} doctor`} k="doctor" /></>],
    ['Start Claude', <>In the same folder, run <code>claude</code>. You'll show up in the team list and this goes away.</>],
  ];
  return (
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="sheet connect" role="dialog" aria-modal="true" aria-label="Connect your computer">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}><h3 style={{ margin: 0, flex: 1 }}>Connect your computer to {prettyProject(auth.project)}</h3><button onClick={close}>Close</button></div>
        <p className="small muted" style={{ margin: '6px 0 14px' }}>Do this once so your own Claude can work with the team. Takes about two minutes.</p>
        <ol className="csteps">{steps.map(([t, body], i) => <li key={t}><span className="cnum">Step {i + 1}</span><b>{t}</b><div>{body}</div></li>)}</ol>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}><button className="link small" onClick={close}>I'll do it later</button></div>
      </div>
    </div>
  );
}

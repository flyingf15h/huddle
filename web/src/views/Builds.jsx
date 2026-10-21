// Builds: playable versions of the project, newest first, each with its full link. Web builds can be
// played right here. Agents add them with huddle_share_build; people can add links too.
import { useEffect, useState } from 'react';
import { S, api, dn, myName, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';
import Shell from '../components/Shell.jsx';
import { useLive } from '../lib/hooks.js';
import { ago } from '../lib/words.js';

const isWeb = (b) => /^web/i.test(b.platform || '') || /itch\.io\/embed|\.html?($|\?)|github\.io|netlify\.app|vercel\.app|pages\.dev/i.test(b.url);

export default function Builds({ bare }) {
  useS();
  const [adding, setAdding] = useState(false), [builds, setBuilds] = useState([]), [playing, setPlaying] = useState(null), [form, setForm] = useState({ url: '', title: '', platform: 'web', notes: '' }), [msg, setMsg] = useState(''), [copied, setCopied] = useState(null);
  const load = () => api('builds').then(r => setBuilds(r.builds.slice().reverse())).catch(e => setMsg(e.message));
  useEffect(() => { load(); }, []);
  useLive((ev) => { if (ev.type === 'build') load(); });
  const add = async () => { setMsg(''); try { await api('build', form); setForm({ url: '', title: '', platform: form.platform, notes: '' }); load(); } catch (e) { setMsg(e.message); } };
  const del = async (b) => { if (confirm(`Remove "${b.title}" from the list?`)) { await api('build-delete', { id: b.id }).catch(e => setMsg(e.message)); load(); } };
  const copy = (b) => navigator.clipboard.writeText(b.url).then(() => { setCopied(b.id); setTimeout(() => setCopied(null), 1500); }).catch(() => {});
  const viewer = S.me.role === 'viewer';

  return (
    <Shell bare={bare}>
        {builds.map((b, i) => (
          <div className="panel" key={b.id}>
            <div className="srow" style={{ borderTop: 0, flexWrap: 'wrap' }}>
              <span className="grow"><b>{b.title}</b>{i === 0 && <> <span className="pill acc">Latest</span></>}
                <span className="sub">{dn(b.by)}{b.bg ? "'s agent" : ''} · {ago(b.at)}{b.platform ? ' · ' + b.platform : ''}</span></span>
              {isWeb(b) && <button className={playing === b.id ? '' : 'primary'} onClick={() => setPlaying(playing === b.id ? null : b.id)}>{playing === b.id ? 'Stop' : 'Play here'}</button>}
              <a className="btn" href={b.url} target="_blank" rel="noopener noreferrer">Open</a>
              {(b.by === myName() || isOwner()) && <button className="ghost" onClick={() => del(b)}>Remove</button>}
            </div>
            <div className="buildlink"><code>{b.url}</code><button className="link small" onClick={() => copy(b)}>{copied === b.id ? 'Copied' : 'Copy link'}</button></div>
            {b.notes && <p className="pdesc" style={{ marginTop: 0 }}>{b.notes}</p>}
            {playing === b.id && <div className="player"><iframe src={b.url} title={b.title} allow="fullscreen; autoplay; gamepad; pointer-lock" allowFullScreen sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-forms" /></div>}
          </div>
        ))}
        {!builds.length && <p className="small faint">No builds yet. Agents share them with huddle_share_build, and web builds play right here.</p>}
        {!viewer && !adding && <div className="pactions" style={{ justifyContent: 'flex-start', padding: '4px 0 0' }}><button className="primary" onClick={() => setAdding(true)}>add a build</button></div>}
        {!viewer && adding && <div className="panel"><h3>add a build</h3><div className="pbody fieldset">
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', gap: 10 }}>
            <div><label htmlFor="b-u">Link</label><input id="b-u" type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://yourteam.itch.io/game" /></div>
            <div><label htmlFor="b-p">Platform</label><input id="b-p" type="text" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} placeholder="web, windows, mac…" /></div></div>
          <div><label htmlFor="b-t">Name</label><input id="b-t" type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Prototype 3, boss fight playable" /></div>
          <div><label htmlFor="b-n">What to try (optional)</label><input id="b-n" type="text" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="New jump feel, second level" /></div>
          <div className="pactions" style={{ padding: 0 }}>{msg && <span className="small err">{msg}</span>}<button className="ghost" onClick={() => setAdding(false)}>cancel</button><button className="primary" disabled={!form.url.trim() || !form.title.trim()} onClick={async () => { await add(); setAdding(false); }}>add build</button></div></div></div>}
    </Shell>
  );
}

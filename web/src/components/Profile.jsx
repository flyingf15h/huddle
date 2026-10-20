// Your profile: picture, display name, username (what teammates send work to) and your agent's name.
import { useEffect, useState } from 'react';
import { S, auth, api, myName, dn, aiName, hasClaude, myTool } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useEscape } from '../lib/hooks.js';
import { color, store } from '../lib/words.js';

// cropped square, shrunk to 128 px so it stays small on the server
function shrink(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error('pick an image file'));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = 128;
      const side = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 128, 128);
      URL.revokeObjectURL(img.src);
      let out = c.toDataURL('image/webp', 0.85);
      if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/jpeg', 0.85);
      resolve(out);
    };
    img.onerror = () => reject(new Error("couldn't read that image"));
    img.src = URL.createObjectURL(file);
  });
}

export default function Profile() {
  useS();
  const [display, setDisplay] = useState(''), [username, setUsername] = useState(''), [agent, setAgent] = useState(''), [picture, setPicture] = useState(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const mine = S.settings[myName()] || {};
  useEffect(() => { if (S.profile) { setDisplay(mine.displayName || ''); setUsername(myName()); setAgent(aiName(myName())); setPicture(mine.avatar || null); setErr(''); } }, [S.profile]); // eslint-disable-line react-hooks/exhaustive-deps
  useEscape(() => (S.profile = false), S.profile);
  if (!S.profile) return null;
  const pick = async (e) => { const f = e.target.files[0]; if (!f) return; try { setPicture(await shrink(f)); setErr(''); } catch (x) { setErr(x.message); } };
  async function save(e) {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const change = {};
      if (display.trim() !== (mine.displayName || '')) change.displayName = display.trim();
      if ((picture || null) !== (mine.avatar || null)) change.avatar = picture || '';
      if (hasClaude(myName()) && agent.trim() !== aiName(myName())) change.aiName = agent.trim();
      if (Object.keys(change).length) { const r = await api('setting', change); S.settings[myName()] = r.settings; }
      const n = username.trim().replace(/\s+/g, '-');
      if (n && n !== myName()) { await api('rename', { name: n }); auth.name = n; store.set('huddle.name', n); location.reload(); return; }
      S.profile = false;
    } catch (x) { setErr(x.message); }
    setBusy(false);
  }
  const pal = color(myName());
  return (
    <div className="overlay" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) S.profile = false; }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Your profile">
        <form onSubmit={save} style={{ display: 'grid', gap: 10 }}>
          <div className="pichead">
            {picture ? <span className="av has-img big"><img src={picture} alt="" /></span> : <span className="av big" style={{ background: pal[0], color: pal[1] }}>{(display.trim() || myName())[0].toUpperCase()}</span>}
            <span className="picbtns"><label className="filebtn">Upload photo<input type="file" accept="image/*" hidden onChange={pick} /></label>{picture && <button type="button" className="link small" onClick={() => setPicture(null)}>Remove</button>}</span></div>
          <div><label htmlFor="pf-d" className="small muted">Display name</label><input id="pf-d" value={display} onChange={(e) => setDisplay(e.target.value)} maxLength={40} placeholder={myName()} autoComplete="name" style={{ width: '100%' }} /></div>
          <div><label htmlFor="pf-u" className="small muted">Username · what teammates use to send you work</label><input id="pf-u" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={40} autoComplete="off" style={{ width: '100%' }} /></div>
          {hasClaude(myName()) && <div><label htmlFor="pf-a" className="small muted">Your {myTool()}'s name</label><input id="pf-a" value={agent} onChange={(e) => setAgent(e.target.value)} maxLength={32} placeholder={`${dn(myName())}'s ${myTool()}`} autoComplete="off" style={{ width: '100%' }} /></div>}
          {err && <div className="err small" role="alert">{err}</div>}
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}><button type="button" onClick={() => (S.profile = false)}>Cancel</button><button className="primary" disabled={busy}>Save</button></div>
        </form>
      </div>
    </div>
  );
}

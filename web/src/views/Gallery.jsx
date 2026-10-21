// Gallery: screenshots and images from the team, kept out of the activity feed. Viewport and Figma
// screenshots arrive by themselves (hooks.js); agents add any image with huddle_share_image, and
// people upload here.
import { useEffect, useRef, useState } from 'react';
import { S, api, dn, myName, isOwner } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { useLive, useEscape } from '../lib/hooks.js';
import { ago } from '../lib/words.js';

const cache = new Map();   // id -> data URL, for this tab
async function src(id) {
  if (!cache.has(id)) cache.set(id, api('media-file?id=' + id).then(r => `data:${r.mime};base64,${r.data}`));
  return cache.get(id);
}
function Thumb({ m, onOpen }) {
  const [url, setUrl] = useState(null), ref = useRef(null);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { src(m.id).then(setUrl).catch(() => {}); io.disconnect(); } }, { rootMargin: '200px' });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, [m.id]);
  return (
    <button className="gthumb" ref={ref} onClick={() => onOpen(m)} aria-label={m.caption || 'Image'}>
      <span className="gimg">{url ? <img src={url} alt="" /> : null}</span>
      <span className="gcap"><b>{m.caption || 'Image'}</b><span>{dn(m.by)}{m.source ? ' · ' + m.source : ''} · {ago(m.at)}</span></span>
    </button>
  );
}

// fit an uploaded picture under the server's 900 KB limit
async function shrink(file) {
  const img = await createImageBitmap(file);
  for (const max of [2400, 1800, 1400, 1000, 800]) {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const type = file.type === 'image/png' && max >= 1400 ? 'image/png' : 'image/jpeg';
    const url = c.toDataURL(type, 0.86);
    if (url.length * 0.75 < 880 * 1024) return { mime: type, data: url.split(',')[1] };
  }
  throw new Error('That image is too large even after shrinking it.');
}

export default function Gallery() {
  useS();
  const [items, setItems] = useState([]), [open, setOpen] = useState(null), [big, setBig] = useState(null), [msg, setMsg] = useState(''), [filter, setFilter] = useState('all');
  const file = useRef(null);
  const load = () => api('media').then(r => setItems(r.media)).catch(e => setMsg(e.message));
  useEffect(() => { load(); }, []);
  useLive((ev) => { if (ev.type === 'media') load(); });
  useEffect(() => { setBig(null); if (open) src(open.id).then(setBig); }, [open]);
  useEscape(() => setOpen(null), !!open);
  const upload = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    setMsg('');
    try { const s = await shrink(f); await api('media', { ...s, caption: f.name.replace(/\.[^.]+$/, ''), source: 'uploaded' }); load(); } catch (er) { setMsg(er.message); }
  };
  const del = async (m) => { if (!confirm('Delete this image for everyone?')) return; await api('media-delete', { id: m.id }).catch(e => setMsg(e.message)); setOpen(null); load(); };
  const sources = [...new Set(items.map(m => m.source).filter(Boolean))];
  const shown = items.filter(m => filter === 'all' || m.source === filter).slice().reverse();

  return (
    <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="pageview">
        <div className="kbar">
          <div className="seg sm" role="group" aria-label="Show">{['all', ...sources].map(s => <button key={s} className={filter === s ? 'on' : ''} onClick={() => setFilter(s)}>{s === 'all' ? 'Everything' : s[0].toUpperCase() + s.slice(1)}</button>)}</div>
          <span className="grow"></span>
          {S.me.role !== 'viewer' && <><input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={upload} /><button className="primary" onClick={() => file.current.click()}>Add an image</button></>}
        </div>
        {msg && <p className="err small">{msg}</p>}
        {shown.length ? <div className="ggrid">{shown.map(m => <Thumb key={m.id} m={m} onOpen={setOpen} />)}</div>
          : <div className="empty"><h3>No images yet</h3><p style={{ margin: '0 auto', maxWidth: 460 }}>Screenshots agents take in Unity, Godot, Blender or Figma show up here by themselves. Agents can share any other image with huddle_share_image, and you can add your own.</p></div>}
      </div>
      {open && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label={open.caption || 'Image'} onClick={() => setOpen(null)}>
          <div className="glight" onClick={(e) => e.stopPropagation()}>
            {big ? <img src={big} alt={open.caption || ''} /> : <div className="muted" style={{ padding: 40 }}>Loading…</div>}
            <div className="srow" style={{ borderTop: 0 }}><span className="grow"><b>{open.caption || 'Image'}</b><span className="sub">{dn(open.by)}{open.source ? ' · ' + open.source : ''} · {new Date(open.at).toLocaleString()}</span></span>
              {big && <a className="btn ghost" href={big} download={(open.caption || 'image').replace(/[^\w.-]+/g, '-') + '.' + open.mime.split('/')[1]}>Download</a>}
              {(open.by === myName() || isOwner()) && <button className="ghost" onClick={() => del(open)}>Delete</button>}
              <button onClick={() => setOpen(null)}>Close</button></div>
          </div>
        </div>
      )}
    </main>
  );
}

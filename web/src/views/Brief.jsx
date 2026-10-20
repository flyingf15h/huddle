// Brief & memory: the project brief (a reader with a contents list, and an editor), shared memory
// notes and skills, with search.
import { useEffect, useRef, useState } from 'react';
import { S, api, loadShared } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { md, ago } from '../lib/words.js';

const has = (q, ...parts) => !q || parts.join(' ').toLowerCase().includes(q.toLowerCase());
const slug = (t, i) => 'k-' + i + '-' + t.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
const first = (t) => String(t).split('\n').map(l => l.replace(/[#*`>-]/g, '').trim()).find(Boolean) || '';
const Chev = () => <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export default function Brief() {
  useS();
  const [tab, setTab] = useState('doc'), [editing, setEditing] = useState(false), [draft, setDraft] = useState(''), [msg, setMsg] = useState(''), [query, setQuery] = useState(''), [adding, setAdding] = useState(false), [mt, setMt] = useState(''), [mx, setMx] = useState('');
  const [toc, setToc] = useState([]), [openId, setOpenId] = useState(null);
  const body = useRef(null);
  const sh = S.shared;
  const memories = sh ? sh.memories.slice().reverse().filter(m => has(query, m.title, m.text)) : [];
  const skills = sh ? sh.skills.filter(k => has(query, k.name, k.description, k.body)) : [];
  const doc = sh && sh.doc && sh.doc.text.trim() ? sh.doc : null;

  // the reader styles headings itself, and a paragraph that opens with "**Label:**" reads as a small heading
  useEffect(() => {
    const el = body.current;
    if (!el) { setToc([]); return; }
    for (const x of el.querySelectorAll('[style]')) x.removeAttribute('style');
    for (const b of el.querySelectorAll('p > b:first-child')) if (/:$/.test(b.textContent.trim()) && b.parentElement.firstChild === b) b.classList.add('lead');
    const heads = [...el.querySelectorAll('h3, h4, h5, .lead')];
    heads.forEach((h, i) => { h.id = slug(h.textContent, i); });
    const list = heads.filter(h => h.tagName !== 'H5' && !h.classList.contains('lead'));
    setToc(list.length >= 3 ? list.map(h => ({ id: h.id, text: h.textContent.replace(/:$/, ''), sub: h.tagName === 'H4' })) : []);
  }, [doc && doc.version, tab, editing]); // eslint-disable-line react-hooks/exhaustive-deps
  // search hands over a memory, skill or the brief to look at
  useEffect(() => {
    const o = S.briefOpen;
    if (!o) return;
    S.briefOpen = null; setQuery('');
    setTab(o.brief ? 'doc' : o.memory ? 'memory' : 'skills'); setOpenId(o.memory || o.skill || null);
  }, [S.briefOpen]);

  const save = async () => { try { await api('doc', { text: draft, baseVersion: sh.doc ? sh.doc.version : 0 }); setEditing(false); await loadShared(); } catch (e) { setMsg(e.message); } };
  const addMemory = async () => {
    if (!mt.trim() || !mx.trim()) return setMsg('Give it a title and the detail.');
    try { await api('memory', { title: mt.trim(), text: mx.trim() }); setAdding(false); setMt(''); setMx(''); setMsg(''); await loadShared(); } catch (e) { setMsg(e.message); }
  };
  const forget = async (id) => { await api('forget', { id }).catch(() => {}); await loadShared(); };
  const delSkill = async (name) => { await api('skill-delete', { name }).catch(() => {}); await loadShared(); };
  const pick = (t) => { setTab(t); setQuery(''); };

  return (
    <main data-main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div id="briefview" style={{ flex: 1, overflowY: 'auto', padding: '0 20px 32px' }}>
        <div className="kbar">
          <div className="seg" role="tablist">
            <button className={tab === 'doc' ? 'on' : ''} onClick={() => pick('doc')}>Project brief</button>
            <button className={tab === 'memory' ? 'on' : ''} onClick={() => pick('memory')}>Memory<span className="ct">{(sh && sh.memories.length) || ''}</span></button>
            <button className={tab === 'skills' ? 'on' : ''} onClick={() => pick('skills')}>Skills<span className="ct">{(sh && sh.skills.length) || ''}</span></button>
          </div>
          <span className="grow"></span>
          <span style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {tab === 'doc' && !editing && <button className="primary" onClick={() => { setDraft(doc ? doc.text : ''); setEditing(true); setMsg(''); }}>{doc ? 'Edit brief' : 'Write brief'}</button>}
            {tab === 'memory' && <><input type="search" placeholder="Search memory" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search memory" /><button className="primary" onClick={() => setAdding(true)}>New memory</button></>}
            {tab === 'skills' && sh && sh.skills.length > 0 && <input type="search" placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search skills" />}
          </span>
        </div>
        {!sh ? <p className="muted">Loading…</p> : tab === 'doc' ? (
          editing ? (
            <>
              <textarea className="big" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Project brief" autoFocus />
              <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}><button className="primary" onClick={save}>Save</button><button onClick={() => setEditing(false)}>Cancel</button><span className="err small">{msg}</span></div>
            </>
          ) : !doc ? <div className="empty"><h3>No project brief yet</h3><p style={{ margin: '0 auto', maxWidth: 460 }}>Every agent reads the brief first. Describe what the project is, how the code is organized, how to run and test it, and who owns which areas.</p></div>
          : (
            <>
              <p className="kintro">Edited by {doc.byName} {ago(doc.at)}</p>
              <div className={'kwrap' + (toc.length ? '' : ' solo')}><article className="doc" ref={body} dangerouslySetInnerHTML={{ __html: md(doc.text) }} />
                {toc.length > 0 && <nav className="toc" aria-label="On this page"><b>On this page</b>{toc.map(t => <button key={t.id} style={{ paddingLeft: t.sub ? 10 : 0 }} onClick={() => document.getElementById(t.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{t.text}</button>)}</nav>}</div>
            </>
          )
        ) : tab === 'memory' ? (
          <>
            {adding && (
              <div className="newmem"><b>Something everyone should know</b>
                <input value={mt} onChange={(e) => setMt(e.target.value)} placeholder="Short title, e.g. Tests need Docker running" maxLength={120} aria-label="Title" />
                <textarea value={mx} onChange={(e) => setMx(e.target.value)} placeholder="The detail, and why it matters" style={{ minHeight: 90 }} aria-label="Detail" />
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}><button className="primary" onClick={addMemory}>Save</button><button onClick={() => setAdding(false)}>Cancel</button><span className="err small">{msg}</span></div></div>
            )}
            {memories.map(m => (
              <details className="mem" key={m.id} open={!!query || openId === m.id}><summary data-nav><Chev /><span className="mt">{m.title}</span><span className="mw">{m.byName} · {ago(m.at)}</span><span className="mp">{first(m.text)}</span></summary>
                <div className="mb"><div dangerouslySetInnerHTML={{ __html: md(m.text) }} /><div className="macts"><button className="link small" onClick={() => forget(m.id)}>Delete</button></div></div></details>
            ))}
            {!memories.length && <p className="muted">{query ? `No memory mentions “${query}”.` : 'No memories yet.'}</p>}
          </>
        ) : (
          <>
            {skills.map(k => (
              <details className="mem" key={k.name} open={!!query || openId === k.name}><summary data-nav><Chev /><span className="mt">{k.name}</span><span className="mw">{k.byName} · {ago(k.at)}</span><span className="mp">{k.description}</span></summary>
                <div className="mb"><p>{k.description}</p><pre>{k.body}</pre><div className="macts"><button className="link small" onClick={() => delSkill(k.name)}>Delete</button></div></div></details>
            ))}
            {!skills.length && <p className="muted">{query ? `No skill mentions “${query}”.` : 'No shared skills yet. An agent can save one with huddle_save_skill.'}</p>}
          </>
        )}
      </div>
    </main>
  );
}

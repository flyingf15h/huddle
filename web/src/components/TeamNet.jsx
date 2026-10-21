// The team as a small live network: one node per person, slowly turning in 3D, linked to everyone
// else. A message between two people's agents sends a pulse along their link; agents that are working
// send each other faint ambient pulses, so a busy team looks busy at a glance.
import { useEffect, useRef } from 'react';
import { S, people, cardLine, dn } from '../lib/state.js';
import { useS } from '../lib/store.js';
import { color } from '../lib/words.js';

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function TeamNet() {
  useS();
  const ref = useRef(null), data = useRef({ nodes: [], msgs: [] });
  // the latest people and messages, read by the animation loop
  data.current.nodes = people().map(p => ({ name: p.name, label: dn(p.name), online: p.online, busy: !!cardLine(p).busy, col: color(p.name)[0] }));
  data.current.msgs = S.entries.filter(e => e.kind === 'msg' && Date.now() - e.at < 30000);

  useEffect(() => {
    const cv = ref.current, ctx = cv.getContext('2d');
    if (!ctx) return;
    let w = 0, h = 0, raf = 0, visible = true, gone = false, colors = {}, lastAmbient = 0, frames = 0;
    const seen = new Set(), pulses = [], t0 = performance.now();
    const size = () => { const dpr = Math.min(2, devicePixelRatio || 1); w = cv.clientWidth; h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    const read = () => { const cs = getComputedStyle(cv); colors = { signal: cs.getPropertyValue('--signal').trim(), line: cs.getPropertyValue('--line-strong').trim(), ink: cs.getPropertyValue('--ink').trim(), muted: cs.getPropertyValue('--muted').trim(), page: cs.getPropertyValue('--raised').trim() }; };
    function frame(now) {
      raf = 0;
      if (frames++ % 60 === 0) read();
      const t = (now - t0) / 1000, { nodes, msgs } = data.current, n = nodes.length;
      ctx.clearRect(0, 0, w, h);
      // faint lattice behind, like graph paper for the network
      ctx.fillStyle = colors.line; ctx.globalAlpha = .5;
      for (let x = 8; x < w; x += 16) for (let y = 8; y < h; y += 16) ctx.fillRect(x, y, 1, 1);
      ctx.globalAlpha = 1;
      if (!n) { if (visible && !gone && !still()) raf = requestAnimationFrame(frame); return; }
      // positions: an ellipse turning slowly, tipped back so it has depth
      const rx = w * .34, ry = h * .26, cx = w / 2, cy = h / 2 - 8;
      const pos = nodes.map((p, i) => {
        const a = (i / n) * Math.PI * 2 + t * .12, z = Math.sin(a);
        return { ...p, x: cx + Math.cos(a) * rx, y: cy + z * ry + Math.sin(t * .8 + i) * 2, z };
      });
      const at = Object.fromEntries(pos.map(p => [p.name, p]));
      // links between everyone online
      ctx.lineWidth = 1;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = pos[i], b = pos[j]; if (!a.online || !b.online) continue;
        ctx.strokeStyle = colors.signal; ctx.globalAlpha = .12 + .1 * ((a.z + b.z) / 2 + 1) / 2;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // new messages become pulses; busy agents trade ambient ones now and then
      for (const m of msgs) {
        const key = m.who + m.at; if (seen.has(key)) continue; seen.add(key);
        const targets = m.to ? [m.to] : pos.filter(p => p.name !== m.who && p.online).map(p => p.name);
        for (const to of targets) if (at[m.who] && at[to]) pulses.push({ from: m.who, to, start: now, dur: 1400, strong: true });
      }
      const busy = pos.filter(p => p.busy && p.online);
      if (busy.length && now - lastAmbient > 900) {
        lastAmbient = now;
        const a = busy[Math.floor(Math.random() * busy.length)], others = pos.filter(p => p.online && p.name !== a.name);
        if (others.length) pulses.push({ from: a.name, to: others[Math.floor(Math.random() * others.length)].name, start: now, dur: 1800, strong: false });
      }
      for (let k = pulses.length - 1; k >= 0; k--) {
        const q = pulses[k], a = at[q.from], b = at[q.to], f = (now - q.start) / q.dur;
        if (f >= 1 || !a || !b) { pulses.splice(k, 1); continue; }
        for (let s = 0; s < 6; s++) { // a short comet: head and fading tail
          const g = Math.max(0, f - s * .03), x = a.x + (b.x - a.x) * g, y = a.y + (b.y - a.y) * g;
          ctx.fillStyle = colors.signal; ctx.globalAlpha = (q.strong ? .95 : .45) * (1 - s / 6);
          ctx.beginPath(); ctx.arc(x, y, (q.strong ? 3 : 2) - s * .3, 0, 6.283); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      // nodes, back to front
      for (const p of pos.slice().sort((a, b) => a.z - b.z)) {
        const s = 22 + p.z * 3, depth = .7 + .3 * (p.z + 1) / 2;
        if (p.busy && p.online) { // a ring that breathes while their agent works
          ctx.strokeStyle = colors.signal; ctx.globalAlpha = .35 + .35 * Math.sin(t * 3 + p.x);
          ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(p.x, p.y, s * .78 + 2 * Math.sin(t * 3), 0, 6.283); ctx.stroke();
        }
        ctx.globalAlpha = (p.online ? 1 : .35) * depth;
        ctx.fillStyle = p.col; ctx.beginPath(); ctx.roundRect(p.x - s / 2, p.y - s / 2, s, s, 6); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.round(s * .45)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(p.label[0].toUpperCase(), p.x, p.y + 1);
        ctx.fillStyle = colors.muted; ctx.font = '10.5px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'top';
        ctx.fillText(p.label.length > 10 ? p.label.slice(0, 9) + '…' : p.label, p.x, p.y + s / 2 + 4);
      }
      ctx.globalAlpha = 1;
      if (visible && !gone && !still()) raf = requestAnimationFrame(frame);
    }
    size(); read();
    raf = requestAnimationFrame(frame);
    const io = new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame); });
    io.observe(cv);
    const ro = new ResizeObserver(() => size()); ro.observe(cv);
    return () => { gone = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); };
  }, []);

  return (
    <div className="teamnet">
      <h2>Agent network <span className="count">{data.current.nodes.filter(p => p.online).length} online</span></h2>
      <canvas ref={ref} aria-label="The team's agents and the messages between them" role="img" />
    </div>
  );
}

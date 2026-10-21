// The dot clouds from the landing page: a few thousand points that turn in 3D and drift between
// abstract shapes. mountCloud(canvas, opts) starts one and returns a function that stops it.
// Colours come from the theme (--signal, --accent, --ink), so they follow theme changes.
const TAU = Math.PI * 2, GOLD = Math.PI * (3 - Math.sqrt(5));

const MAKERS = {
  sphere: (i, N) => { const y = 1 - 2 * (i + .5) / N, r = Math.sqrt(1 - y * y), a = i * GOLD; return [Math.cos(a) * r, y, Math.sin(a) * r]; },
  torus: (i, N) => { const u = (i / N) * TAU * 23, v = i * GOLD * 7, R = .72, r = .32 + .08 * Math.sin(3 * u);
    return [(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v) + .18 * Math.sin(2 * u), (R + r * Math.cos(v)) * Math.sin(u)]; },
  wave: (i, N) => { const side = Math.ceil(Math.sqrt(N)), x = (i % side) / side * 2.6 - 1.3, z = Math.floor(i / side) / side * 2.6 - 1.3;
    return [x, .32 * Math.sin(2.6 * x + 1) * Math.cos(2.2 * z) + .12 * Math.sin(5 * (x + z)), z]; },
  knot: (i, N) => { const t = (i / N) * TAU, k = i * GOLD * 3, r = .5;
    const cx = Math.sin(t) + 2 * Math.sin(2 * t), cy = Math.cos(t) - 2 * Math.cos(2 * t), cz = -Math.sin(3 * t);
    return [(cx + r * Math.cos(k)) / 3.2, (cy + r * Math.sin(k)) / 3.2, (cz + r * Math.cos(k + 1)) / 3.2]; },
  blob: (i, N) => { const p = MAKERS.sphere(i, N), th = Math.acos(p[1]), ph = Math.atan2(p[2], p[0]);
    const m = (1 + .32 * Math.sin(3 * th) * Math.cos(4 * ph) + .18 * Math.sin(5 * ph + th)) * .85; return [p[0] * m, p[1] * m, p[2] * m]; },
};

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (x) => (x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

export function mountCloud(canvas, { n = 1400, shapes = ['sphere', 'torus', 'knot', 'blob'], every = 7, scale = .42, dot = 1.4 } = {}) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const N = n;
  const SHAPES = shapes.map(name => { const a = new Float32Array(N * 3); for (let i = 0; i < N; i++) { const p = MAKERS[name](i, N); a.set(p, i * 3); } return a; });
  const seed = new Float32Array(N).map(() => Math.random() * TAU);
  let w = 0, h = 0, raf = 0, visible = true, stopped = false, colors = null, frames = 0;
  const t0 = performance.now() - Math.random() * every * 1000;
  const readColors = () => { const cs = getComputedStyle(canvas); colors = [cs.getPropertyValue('--signal').trim() || '#2f6bff', cs.getPropertyValue('--accent').trim() || '#24365e', cs.getPropertyValue('--faint').trim() || '#868c98']; };
  const size = () => { const dpr = Math.min(2, devicePixelRatio || 1); w = canvas.clientWidth; h = canvas.clientHeight; canvas.width = w * dpr; canvas.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
  function frame(now) {
    raf = 0;
    if (frames++ % 60 === 0) readColors();
    const t = (now - t0) / 1000, L = SHAPES.length;
    const stage = t / every, k = Math.floor(stage), hold = stage - k, f = ease(Math.min(1, Math.max(0, (hold - .55) / .45)));
    const A = SHAPES[k % L], B = SHAPES[(k + 1) % L];
    const ry = t * .25, rx = .4 + Math.sin(t * .3) * .15, cy = Math.cos(ry), sy = Math.sin(ry), cx = Math.cos(rx), sx = Math.sin(rx);
    const S = Math.min(w, h) * scale, ox = w / 2, oy = h / 2;
    ctx.clearRect(0, 0, w, h);
    for (let i = 0; i < N; i++) {
      const j = i * 3, wob = 1 + .03 * Math.sin(t * 1.4 + seed[i]);
      const x = (A[j] + (B[j] - A[j]) * f) * wob, y = (A[j + 1] + (B[j + 1] - A[j + 1]) * f) * wob, z = (A[j + 2] + (B[j + 2] - A[j + 2]) * f) * wob;
      const x1 = x * cy - z * sy, z1 = x * sy + z * cy, y1 = y * cx - z1 * sx, z2 = y * sx + z1 * cx;
      const persp = 2.6 / (2.6 + z2), d = Math.min(1, Math.max(0, (1 - z2) / 2)), r = (.6 + d * 1.4) * dot;
      ctx.fillStyle = d > .6 ? colors[0] : d > .33 ? colors[1] : colors[2];
      ctx.globalAlpha = .14 + d * .66;
      ctx.fillRect(ox + x1 * S * persp - r / 2, oy + y1 * S * persp - r / 2, r, r);
    }
    ctx.globalAlpha = 1;
    if (visible && !stopped && !still()) raf = requestAnimationFrame(frame);
  }
  const go = () => { if (!raf && !stopped) raf = requestAnimationFrame(frame); };
  size(); readColors(); frame(performance.now());
  const io = new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) go(); });
  io.observe(canvas);
  const ro = new ResizeObserver(() => { size(); frame(performance.now()); });
  ro.observe(canvas);
  return () => { stopped = true; cancelAnimationFrame(raf); io.disconnect(); ro.disconnect(); };
}

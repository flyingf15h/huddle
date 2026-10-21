// The home screen's backdrop: a dot grid whose dots light up blue around the cursor, and drift
// slowly on their own when the cursor is still.
import { useEffect, useRef } from 'react';

export default function DotField() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current, t0 = performance.now();
    let last = 0, raf = 0;
    const set = (x, y) => { el.style.setProperty('--mx', x + 'px'); el.style.setProperty('--my', y + 'px'); };
    const move = (e) => { last = performance.now(); set(e.clientX, e.clientY); };
    const drift = (now) => {
      if (now - last > 3000) { const t = (now - t0) / 1000; set(innerWidth * (.5 + .35 * Math.sin(t * .2)), innerHeight * (.45 + .3 * Math.sin(t * .27 + 1))); }
      raf = requestAnimationFrame(drift);
    };
    addEventListener('pointermove', move, { passive: true });
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) raf = requestAnimationFrame(drift);
    return () => { removeEventListener('pointermove', move); cancelAnimationFrame(raf); };
  }, []);
  return <div className="dotfield" ref={ref} aria-hidden="true" />;
}

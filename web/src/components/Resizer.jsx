// A drag handle on a column's edge. Drag to resize, double-click to go back to the usual width,
// arrow keys when focused.
import { setWidth, resetWidth, layout } from '../lib/layout.js';

// how wide the column is for a pointer at x: the rail grows from the left edge, the others from the right
const widthAt = (which, x) => (which === 'rail' ? x : innerWidth - x);

export default function Resizer({ which, label }) {
  const down = (e) => {
    e.preventDefault();
    const el = e.currentTarget; el.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('resizing');
    const move = (ev) => setWidth(which, widthAt(which, ev.clientX));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); document.documentElement.classList.remove('resizing'); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  };
  const key = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const grow = (e.key === 'ArrowRight') === (which === 'rail');
    setWidth(which, layout()[which] + (grow ? 16 : -16)); e.preventDefault();
  };
  return <div className={'resizer r-' + which} role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0} onPointerDown={down} onDoubleClick={() => resetWidth(which)} onKeyDown={key} title="Drag to resize, double-click to reset" />;
}

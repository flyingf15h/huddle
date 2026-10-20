// Small React hooks shared by the views.
import { useEffect, useRef } from 'react';
import { onLive } from './state.js';

// run fn for every live event while the component is mounted (always the latest fn)
export function useLive(fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => onLive((ev) => ref.current(ev)), []);
}
// Escape closes things
export function useEscape(fn, on = true) {
  useEffect(() => {
    if (!on) return;
    const h = (e) => { if (e.key === 'Escape') fn(e); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [fn, on]);
}
// a message that clears itself
export const sayLater = (set, t, ms = 4000) => { set(t); setTimeout(() => set((cur) => (cur === t ? '' : cur)), ms); };

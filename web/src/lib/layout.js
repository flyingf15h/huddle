// Column widths and which panels are open, remembered per browser. Applied as CSS variables on
// <html> (--rail-w, --side-w, --detail-w) and two classes (rail-mini, side-closed).
import { store } from './words.js';

const LIMITS = { rail: [200, 420, 264], side: [260, 600, 340], detail: [300, 680, 380] };
const KEY = 'huddle.layout';
let L = { rail: 264, side: 340, detail: 380, railMini: false, sideClosed: false };
try { L = { ...L, ...JSON.parse(store.get(KEY) || '{}') }; } catch {}

function apply() {
  const r = document.documentElement;
  r.style.setProperty('--rail-w', (L.railMini ? 60 : L.rail) + 'px');
  r.style.setProperty('--side-w', L.side + 'px');
  r.style.setProperty('--detail-w', L.detail + 'px');
  r.classList.toggle('rail-mini', !!L.railMini);
  r.classList.toggle('side-closed', !!L.sideClosed);
}
const save = () => { store.set(KEY, JSON.stringify(L)); apply(); };
apply();

export const layout = () => L;
export function setWidth(which, px) { const [lo, hi] = LIMITS[which]; L[which] = Math.round(Math.min(hi, Math.max(lo, px))); if (which === 'rail') L.railMini = false; save(); }
export function resetWidth(which) { L[which] = LIMITS[which][2]; save(); }
export function toggleRail() { L.railMini = !L.railMini; save(); }
export function toggleSide() { L.sideClosed = !L.sideClosed; save(); }

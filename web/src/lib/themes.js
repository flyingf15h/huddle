// Colour themes, the way Slack does them: each one sets the sidebar, the page and the accent, and is
// either light or dark underneath (app.css holds the light and dark bases). "system" follows the
// computer: Navy by day, Night after dark (the same colours as the landing page).
import { store } from './words.js';

export const THEMES = [
  { id: 'cream', name: 'Cream', dark: false, page: '#faf7f0', raised: '#fffdf8', rail: '#f2ede2', railInk: '#24211c', railActive: 'rgba(36, 33, 28, .08)', accent: '#2f5d62' },
  { id: 'navy', name: 'Navy', dark: false, page: '#f8f7f3', raised: '#ffffff', rail: '#e9edf3', railInk: '#1b2333', railActive: 'rgba(27, 35, 51, .08)', accent: '#24365e' },
  { id: 'oat', name: 'Oat', dark: false, page: '#f8f5ee', raised: '#fffdf9', rail: '#e9e2d4', railInk: '#2a251e', railActive: 'rgba(42, 37, 30, .09)', accent: '#8a5a3c' },
  { id: 'matcha', name: 'Matcha', dark: false, page: '#f8f8f1', raised: '#fffffa', rail: '#e3e8d6', railInk: '#232a1c', railActive: 'rgba(35, 42, 28, .09)', accent: '#4c6b38' },
  { id: 'blush', name: 'Blush', dark: false, page: '#fbf7f3', raised: '#fffdfb', rail: '#f2e2dc', railInk: '#2e2220', railActive: 'rgba(46, 34, 32, .08)', accent: '#a04a58' },
  { id: 'mist', name: 'Mist', dark: false, page: '#f7f8f6', raised: '#ffffff', rail: '#e3e9ec', railInk: '#1e262b', railActive: 'rgba(30, 38, 43, .08)', accent: '#33688f' },
  { id: 'lilac', name: 'Lilac', dark: false, page: '#f9f7f6', raised: '#ffffff', rail: '#e8e3ef', railInk: '#25212d', railActive: 'rgba(37, 33, 45, .08)', accent: '#6650a0' },
  { id: 'espresso', name: 'Espresso', dark: false, page: '#faf7f0', raised: '#fffdf8', rail: '#2c2521', railInk: '#efe6da', railActive: 'rgba(239, 230, 218, .12)', accent: '#9a5b34' },
  { id: 'night', name: 'Night', dark: true, page: '#0f1729', raised: '#18223a', rail: '#0a101e', railInk: '#e6ebf5', railActive: 'rgba(143, 176, 255, .12)', accent: '#8fb0ff' },
  { id: 'evening', name: 'Evening', dark: true, page: '#1d1b18', raised: '#272420', rail: '#161412', railInk: '#ece5da', railActive: 'rgba(236, 229, 218, .09)', accent: '#d9a066' },
  { id: 'tide', name: 'Tide', dark: true, page: '#141b1e', raised: '#1c2529', rail: '#0e1416', railInk: '#dfeae9', railActive: 'rgba(223, 234, 233, .09)', accent: '#62b5ad' },
  { id: 'dusk', name: 'Dusk', dark: true, page: '#1c1820', raised: '#26212b', rail: '#151118', railInk: '#ebe3f0', railActive: 'rgba(235, 227, 240, .09)', accent: '#c4a0e0' },
];
const byId = Object.fromEntries(THEMES.map(t => [t.id, t]));
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

// what the person picked: a theme id or "system" (old saved values "light"/"dark" map onto Cream/Evening)
export function themePref() {
  const v = store.get('huddle.theme');
  if (v === 'light' || v === 'paper') return 'navy';
  if (v === 'dark' || v === 'ink') return 'night';
  return byId[v] ? v : 'system';
}
export const resolveTheme = (pref) => byId[pref] || (darkQuery.matches ? byId.night : byId.navy);

export function applyTheme(pref) {
  const t = resolveTheme(pref);
  const root = document.documentElement;
  root.dataset.theme = t.dark ? 'dark' : 'light';
  root.dataset.palette = t.id;
  const vars = { '--page': t.page, '--raised': t.raised, '--rail': t.rail, '--rail-ink': t.railInk, '--rail-active': t.railActive, '--accent': t.accent };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t.rail;
  return t;
}

export function setThemePref(pref) { store.set('huddle.theme', pref); return applyTheme(pref); }
export const onSystemTheme = (fn) => { darkQuery.addEventListener('change', fn); return () => darkQuery.removeEventListener('change', fn); };

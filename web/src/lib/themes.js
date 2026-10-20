// Colour themes, the way Slack does them: each one sets the sidebar, the page and the accent, and is
// either light or dark underneath (app.css holds the light and dark bases). "system" follows the
// computer: Paper by day, Ink by night.
import { store } from './words.js';

export const THEMES = [
  { id: 'paper', name: 'Paper', dark: false, page: '#faf9f7', raised: '#ffffff', rail: '#f1f0ed', railInk: '#1d1c1a', railActive: 'rgba(29, 28, 26, .08)', accent: '#2d5b8a' },
  { id: 'slate', name: 'Slate', dark: false, page: '#f8f8f8', raised: '#ffffff', rail: '#2b2d31', railInk: '#ececee', railActive: '#45484e', accent: '#3366cc' },
  { id: 'sage', name: 'Sage', dark: false, page: '#f7f8f6', raised: '#ffffff', rail: '#2e4a40', railInk: '#eef3f0', railActive: '#46665a', accent: '#2f6b53' },
  { id: 'harbour', name: 'Harbour', dark: false, page: '#f7f9fa', raised: '#ffffff', rail: '#1f3a56', railInk: '#eaf1f8', railActive: '#335677', accent: '#2266a8' },
  { id: 'plum', name: 'Plum', dark: false, page: '#faf9fa', raised: '#ffffff', rail: '#3f1d44', railInk: '#f3ecf4', railActive: '#5c3963', accent: '#1d5fa0' },
  { id: 'clay', name: 'Clay', dark: false, page: '#faf8f6', raised: '#ffffff', rail: '#6b3a2c', railInk: '#f8eee9', railActive: '#87533f', accent: '#a24f2c' },
  { id: 'ink', name: 'Ink', dark: true, page: '#1b1b1a', raised: '#252524', rail: '#141413', railInk: '#e8e6e3', railActive: 'rgba(232, 230, 227, .09)', accent: '#8db3e2' },
  { id: 'midnight', name: 'Midnight', dark: true, page: '#12161c', raised: '#1b2129', rail: '#0c1015', railInk: '#e3e9f0', railActive: 'rgba(227, 233, 240, .09)', accent: '#6ea8fe' },
  { id: 'forest', name: 'Forest', dark: true, page: '#141a17', raised: '#1d2521', rail: '#0e1311', railInk: '#e2ebe5', railActive: 'rgba(226, 235, 229, .09)', accent: '#6fbf95' },
];
const byId = Object.fromEntries(THEMES.map(t => [t.id, t]));
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

// what the person picked: a theme id or "system" (old saved values "light"/"dark" map onto Paper/Ink)
export function themePref() {
  const v = store.get('huddle.theme');
  if (v === 'light' || v === 'cream') return 'paper';
  if (v === 'dark') return 'ink';
  return byId[v] ? v : 'system';
}
export const resolveTheme = (pref) => byId[pref] || (darkQuery.matches ? byId.ink : byId.paper);

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

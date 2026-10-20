// Keyboard navigation for the whole dashboard. Lists opt in by putting data-nav on each item (a
// button or link); j/k (or the arrow keys) move focus through the visible ones in the main area,
// Enter opens one. Views don't need any code of their own for this.
//   /  or Ctrl+K   search          ?   all shortcuts
//   g then a t c b u h s           go to Activity, Tasks, Code, Brief, Usage, Health, Settings
//   c              new request     j / k   next / previous item     Esc   close what's open
import { S, go } from './state.svelte.js';

export const SHORTCUTS = [
  ['/', 'Search the project'], ['Ctrl K', 'Search the project'], ['c', 'New request'], ['j / k', 'Next / previous item'],
  ['Enter', 'Open the item'], ['g a', 'Go to Activity'], ['g t', 'Go to Tasks'], ['g c', 'Go to Code'], ['g b', 'Go to Brief & memory'],
  ['g u', 'Go to Usage'], ['g h', 'Go to Health'], ['g s', 'Go to Settings'], ['?', 'Show these shortcuts'], ['Esc', 'Close'],
];
const GO = { a: 'activity', t: 'tasks', c: 'code', b: 'brief', u: 'usage', h: 'health', s: 'settings' };

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
function visibleItems() {
  const root = document.querySelector('[data-main]') || document;
  return [...root.querySelectorAll('[data-nav]')].filter(el => el.offsetParent !== null && !el.closest('[hidden]'));
}
function move(step) {
  const items = visibleItems();
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = items[i < 0 ? (step > 0 ? 0 : items.length - 1) : Math.max(0, Math.min(items.length - 1, i + step))];
  next.focus();
  next.scrollIntoView({ block: 'nearest' });
}

export function installKeys({ focusComposer }) {
  let pendingG = 0;
  const onKey = (e) => {
    if (e.defaultPrevented) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); S.search = !S.search; return; }
    if (e.key === 'Escape') {
      if (S.search || S.shortcuts || S.drawer) { S.search = S.shortcuts = S.drawer = false; e.preventDefault(); }
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target) || S.search) return;
    if (pendingG && Date.now() - pendingG < 1200 && GO[e.key]) { pendingG = 0; e.preventDefault(); go(GO[e.key]); return; }
    pendingG = 0;
    switch (e.key) {
      case 'g': pendingG = Date.now(); return;
      case '/': e.preventDefault(); S.search = true; return;
      case '?': e.preventDefault(); S.shortcuts = true; return;
      case 'c': case 'n': e.preventDefault(); focusComposer(); return;
      case 'j': case 'ArrowDown': if (e.key === 'ArrowDown' && !document.activeElement.matches('[data-nav]')) return; e.preventDefault(); move(1); return;
      case 'k': case 'ArrowUp': if (e.key === 'ArrowUp' && !document.activeElement.matches('[data-nav]')) return; e.preventDefault(); move(-1); return;
    }
  };
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

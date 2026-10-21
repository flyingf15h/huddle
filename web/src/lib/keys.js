// Keyboard navigation for the whole dashboard. Lists opt in by putting data-nav on each item (a
// button or link); j/k (or the arrow keys) move focus through the visible ones in the main area,
// Enter opens one. Views don't need any code of their own for this.
//   /  or Ctrl+K   search          ?   all shortcuts
//   1 to 5         go to Overview, Activity, Tasks, Studio, Settings
//   g then o a t b l u h s         go to Overview, Activity, Tasks, the brief, timeline, Usage, Health, Settings
//   c              new request     j / k   next / previous item     Esc   close what's open
import { S, go } from './state.js';

export const SHORTCUTS = [
  ['/', 'Search the project'], ['Ctrl K', 'Search the project'], ['c', 'New request'], ['j / k', 'Next / previous item'],
  ['Enter', 'Open the item'], ['1 to 5', 'Overview, Activity, Tasks, Studio, Settings'], ['g o', 'Go to Overview'], ['g a', 'Go to Activity'], ['g t', 'Go to Tasks'],
  ['g b', 'Go to the brief'], ['g l', 'Go to the timeline'], ['g u', 'Go to Usage'], ['g h', 'Go to Health'], ['g s', 'Go to Settings'], ['?', 'Show these shortcuts'], ['Esc', 'Close'],
];
const GO = { o: 'overview', a: 'activity', t: 'tasks', b: 'brief', l: 'timeline', u: 'usage', h: 'health', s: 'settings' };
const PAGE_KEYS = ['overview', 'activity', 'tasks', 'studio', 'settings'];

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
      case '1': case '2': case '3': case '4': case '5': e.preventDefault(); go(PAGE_KEYS[Number(e.key) - 1]); return;
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

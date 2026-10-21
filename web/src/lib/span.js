// Whether stats across the dashboard cover today or the last seven days. Picked in the status line,
// remembered in this browser.
import { S } from './state.js';
import { store } from './words.js';

S.span = store.get('huddle.span') === 'week' ? 'week' : 'day';
export const setSpan = (v) => { S.span = v; store.set('huddle.span', v); };
export const spanWord = () => (S.span === 'week' ? 'this week' : 'today');
// the usage counters' day keys (UTC dates) inside the span
export const spanDays = () => [...Array(S.span === 'week' ? 7 : 1)].map((_, i) => new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
// local midnight at the start of the span
export const spanStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() - (S.span === 'week' ? 6 * 864e5 : 0); };
// one counter summed over the span, from a person's stats.days
export const inSpan = (days, key) => spanDays().reduce((n, k) => n + (((days || {})[k] || {})[key] || 0), 0);

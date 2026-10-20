// A tiny reactive store: wrap an object with reactive() and any change anywhere inside it (a set, a
// delete, an array push) schedules one re-render of every component that called useS(). The state
// module mutates plain-looking objects, and components just read them.
import { useSyncExternalStore } from 'react';

let version = 0, queued = false;
const listeners = new Set();
const cache = new WeakMap();
function bump() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; version++; for (const l of [...listeners]) l(); });
}
const handler = {
  get(t, k, r) {
    const v = Reflect.get(t, k, r);
    return v && typeof v === 'object' && !(v instanceof Node) ? wrap(v) : v;
  },
  set(t, k, v, r) { const raw = v && v.__raw ? v.__raw : v; const same = Object.is(t[k], raw); const ok = Reflect.set(t, k, raw, r); if (!same || k === 'length') bump(); return ok; },
  deleteProperty(t, k) { const ok = Reflect.deleteProperty(t, k); bump(); return ok; },
};
function wrap(o) {
  let p = cache.get(o);
  if (!p) { p = new Proxy(o, { ...handler, get(t, k, r) { return k === '__raw' ? t : handler.get(t, k, r); } }); cache.set(o, p); }
  return p;
}
export const reactive = (o) => wrap(o);
// components call this once at the top and re-render whenever anything in the state changes
export function useS() {
  useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
}
export const touch = bump;

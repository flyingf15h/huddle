// Everything the dashboard knows about the open project, as one reactive object (S), plus the calls
// that change it: the API, the live event stream, sign-in and the list of projects this browser and
// account know. Views read S and call these functions; they never fetch on their own except for
// view-specific data (code trees, stats), which they keep locally.
import { reactive } from './store.js';
import { store, shortTitle, cleanStatus, toolWords, summarize, ago, clock, setTeamNames, statusWord } from './words.js';

// ---------- where we are: project, token, name ----------
const params = new URLSearchParams(location.hash.slice(1));
export const SHORT_INVITE = /^[A-Za-z0-9][\w-]{11}$/;
export function decodeInvite(code) {
  try {
    code = code.trim().split(/\s+/).find(w => w.length > 40) || code.trim();
    const j = JSON.parse(atob(code.replace(/^huddle:/, '').replace(/-/g, '+').replace(/_/g, '/')));
    return { token: j.t, project: j.p };
  } catch { return null; }
}
const readJson = (k, d) => { try { return JSON.parse(store.get(k) || '') || d; } catch { return d; } };
// every project this browser has opened: { project: token }
export const known = readJson('huddle.projects', {});
// `huddle open` adds this person's approve key; kept per project, never put back in the address bar
export const keys = readJson('huddle.keys', {});
export const prettyProject = (p) => String(p || '').replace(/-[0-9a-f]{6,8}$/, '');
export const saveKnown = () => store.set('huddle.projects', JSON.stringify(known));

export const auth = reactive({ token: null, project: null, name: store.get('huddle.name') === 'human' ? '' : (store.get('huddle.name') || '') });
export const VIEWS = ['activity', 'tasks', 'code', 'brief', 'usage', 'health', 'settings'];

export const S = reactive({
  view: VIEWS.includes(params.get('v')) ? params.get('v') : 'activity',
  conn: 'connecting',            // 'live' | 'reconnecting' | 'connecting'
  agents: {}, locks: {}, files: {}, settings: {}, aliases: {}, usage: {}, approvals: [], projectSettings: {}, problems: [], members: [],
  board: { goals: [], tasks: [], version: 0 }, shared: null, entries: [], conflicts: [],
  me: { role: 'member' },        // whoami: role, accounts, via
  notes: [], notePrefs: {}, noteKinds: {}, toasts: [],
  account: { checked: false, github: false, email: false, user: null },
  filter: 'all', who: null,      // activity feed filter and person
  openTask: null,                // task shown in the details panel (Tasks view and side panel)
  search: false, shortcuts: false, invite: false, help: false, drawer: false, profile: false,
  demo: false, fatal: '', contact: null, settingsTab: null, askTo: null, fileOpen: null, codeOpen: null, briefOpen: null, feedJump: null, catchup: '', demoStatus: '', digestShow: null, digests: [], digestRecipient: false,
});

// the name I go by in this project, after any merge ("Fei" -> "tszfei")
export const myName = () => (S.aliases && S.aliases[auth.name]) || auth.name;
const me = () => ({ id: 'human:' + (auth.name || 'guest'), name: auth.name || 'guest', kind: 'human', host: 'dashboard' });

export function api(ep, body) {
  return fetch(`/api/p/${encodeURIComponent(auth.project)}/${ep}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(auth.token && auth.token !== 'account' ? { authorization: 'Bearer ' + auth.token } : {}), 'content-type': 'application/json' },
    body: body ? JSON.stringify({ agent: me(), ...body }) : undefined,
  }).then(r => r.json().then(j => { if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status }); return j; }));
}

// ---------- the address bar: #p=<project>&v=<view> ----------
export function go(view, extra = {}) {
  if (!VIEWS.includes(view)) view = 'activity';
  S.view = view;
  S.drawer = false;
  if (extra.task !== undefined) S.openTask = extra.task;
  setHash();
}
export function setHash() {
  const h = new URLSearchParams();
  if (auth.project) h.set('p', auth.project);
  if (auth.project && S.view !== 'activity') h.set('v', S.view);
  history.replaceState(null, '', h.toString() ? '#' + h : location.pathname);
}
export function goHome() { store.del('huddle.last'); history.replaceState(null, '', location.pathname); location.reload(); }
export function openProject(p) { store.set('huddle.last', p); location.hash = '#p=' + encodeURIComponent(p); location.reload(); }
export function forgetProject(n) {
  delete known[n]; saveKnown();
  delete keys[n]; store.set('huddle.keys', JSON.stringify(keys));
  store.del('huddle.demo.' + n);
  if (store.get('huddle.last') === n) store.del('huddle.last');
  if (S.account.user) fetch('/api/me/forget-project', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: n }) }).catch(() => {});
}

// ---------- people ----------
export const hasClaude = (name) => Object.values(S.agents).some(x => x.name === name && x.kind !== 'human');
export const aiName = (n) => (S.settings[n] && S.settings[n].aiName) || '';
export const toolOf = (n) => ({ codex: 'Codex', cursor: 'Cursor' }[S.settings[n] && S.settings[n].tool] || 'Claude');
export const myTool = () => toolOf(myName());
export const dn = (n) => (S.settings[n] && S.settings[n].displayName) || n;
export const claudeOf = (n) => aiName(n) || `${dn(n)}'s ${toolOf(n)}`;
export const isOwner = () => S.me.role === 'owner';

// one row per person (their sessions folded together), online first
export function people() {
  const by = {};
  for (const a of Object.values(S.agents)) {
    if (a.kind === 'human' && !hasClaude(a.name)) continue;
    const p = by[a.name] = by[a.name] || { name: a.name, online: false, lastSeen: 0, status: '', statusAt: 0, statusRank: 0, branch: null, runner: null, clones: [] };
    if (a.clone) { if (a.online) p.clones.push(a); continue; }
    p.online = p.online || a.online;
    if (a.online && a.runner && a.runner !== 'off' && p.runner !== 'full') p.runner = a.runner;
    if (a.lastSeen > p.lastSeen) { p.lastSeen = a.lastSeen; if (a.branch) p.branch = a.branch; }
    const at = a.statusAt || a.lastSeen || 0;
    const rank = (a.online ? 2 : 0) + (a.statusAuto ? 0 : 1);
    if (a.status && (rank > (p.statusRank || 0) || (rank === p.statusRank && at > p.statusAt))) { p.status = a.status; p.statusAt = at; p.statusRank = rank; }
  }
  const newest = Math.max(0, ...Object.values(S.agents).filter(a => a.online && a.build && a.build.at).map(a => a.build.at));
  for (const p of Object.values(by)) {
    const ss = Object.values(S.agents).filter(a => a.name === p.name && a.online && !a.clone && a.kind !== 'human');
    p.outdated = !!newest && ss.length > 0 && !p.runner && ss.every(a => !a.build || !a.build.at || a.build.at < newest - 60000);
  }
  return Object.values(by).sort((x, y) => y.online - x.online || y.lastSeen - x.lastSeen);
}
export function sessionsOf(name) {
  return Object.values(S.agents).filter(a => a.name === name && a.online && !a.clone && a.kind !== 'human').sort((x, y) => (y.joined || y.lastSeen) - (x.joined || x.lastSeen));
}
export function sessionBusy(a) {
  for (let i = S.entries.length - 1; i >= 0; i--) { const e = S.entries[i]; if (e.agent === a.id) return e.kind !== 'end' && Date.now() - e.at < 2 * 60 * 1000; }
  return false;
}
export function sessionLabel(a) {
  let what = a.status && Date.now() - (a.statusAt || 0) < 3 * 3600 * 1000 ? cleanStatus(a.status) : '';
  if (!what) for (let i = S.entries.length - 1; i >= 0; i--) { const e = S.entries[i]; if (e.agent === a.id && e.kind === 'prompt') { what = cleanStatus(e.text); break; } }
  return `${shortTitle(what, 48) || 'New session, nothing yet'}${a.joined ? ' · since ' + clock(a.joined) : ''}`;
}
export function sessionName(id) {
  const a = S.agents[id];
  const who = a ? a.name : String(id).split('#')[0];
  const what = a ? sessionLabel(a).replace(/ · since .*$/, '') : '';
  return `${who === myName() ? 'your' : who + "'s"} session${what && !/^New session/.test(what) ? ` “${what}”` : ''}`;
}
const TURN_KINDS = new Set(['msg', 'prompt', 'reply', 'tool', 'end']);
export function lastOf(name) { for (let i = S.entries.length - 1; i >= 0; i--) if (S.entries[i].who === name) return S.entries[i]; return null; }
// the team list's two lines: what they're on, and what's happening right now
export function cardLine(p) {
  let main = p.status && Date.now() - p.statusAt < 3 * 3600 * 1000 ? cleanStatus(p.status) : '';
  let e = null;
  for (let i = S.entries.length - 1; i >= 0 && !e; i--) if (S.entries[i].who === p.name && TURN_KINDS.has(S.entries[i].kind) && S.entries[i].kind !== 'msg') e = S.entries[i];
  const bits = [];
  if (p.online) {
    const recent = e && Date.now() - e.at < 2 * 60 * 1000;
    if (recent && e.kind === 'tool') bits.push(stepWordsOf(e.text));
    else if (recent && e.kind !== 'end') bits.push(`${toolOf(p.name)} is working`);
    else if (!p.clones.length) bits.push(e && Date.now() - e.at > 60000 ? `Idle for ${ago(e.at).replace(' ago', '')}` : 'Idle');
  } else bits.push(`Away${p.lastSeen ? ', last active ' + ago(p.lastSeen) : ''}`);
  if (p.outdated) bits.push('Needs a huddle update');
  if (p.clones.length) {
    const first = p.clones.map(c => cleanStatus(c.status || c.clone || '')).find(Boolean);
    bits.push(p.clones.length === 1 ? `In the background: ${first || '1 request'}` : `${p.clones.length} running in the background`);
  }
  const busy = p.online && e && ['tool', 'prompt'].includes(e.kind) && Date.now() - e.at < 90 * 1000;
  return { main, live: bits.join(' · '), busy };
}
function stepWordsOf(text) {
  const w = toolWords(text);
  const arg = w.code ? w.arg.split('\n')[0].slice(0, 40) : w.arg.split('/').pop();
  const verbs = { edited: 'Editing', wrote: 'Writing', read: 'Reading', ran: 'Running', searched: 'Searching', 'looked for': 'Looking for', opened: 'Reading', 'searched web': 'Searching the web' };
  return verbs[w.verb] ? `${verbs[w.verb]} ${arg}`.trim() : `${w.verb.charAt(0).toUpperCase()}${w.verb.slice(1)} ${arg}`.trim();
}
// how much of someone's plan window is left, from their status line
export function usageOf(n) {
  const u = (S.usage || {})[n];
  if (!u || typeof u.five !== 'number' || Date.now() - u.at > 6 * 3600 * 1000) return null;
  return { left: 100 - u.five, high: u.five >= 85, title: `${u.five}% of ${n}'s 5-hour ${toolOf(n)} window used${typeof u.week === 'number' ? `, ${u.week}% of the week` : ''}${u.fiveResets ? ` · resets ${clock(u.fiveResets * 1000)}` : ''}` };
}

// ---------- the activity feed: entries from history and live events ----------
// A background Claude's prompt used to be posted whole; keep only the request it was about.
function backgroundAsk(text) {
  let m = /^You are .{1,80}?, working with a team of (?:Claude agents|AI coding agents \(Claude Code and Codex\)) through huddle\.\nYour task \[\w+\]: (.*)\n([\s\S]*?)(?:\nIt is part of the team goal|\nOther tasks in this goal|\nDo the task in this repository)/.exec(text);
  if (m) return (m[2].trim() || m[1]).trim();
  if ((m = /^You are .{1,80}?, one of a team of (?:Claude|AI coding) agents[\s\S]*? (\S+) sent you this message:\n\n([\s\S]*?)\n\nAnswer it\./.exec(text))) return `Reply to ${m[1]}: ${m[2].trim()}`;
  if ((m = /^You are .{1,80}?, coordinating a team of Claude agents[\s\S]*?this goal \[\w+\] \(from [^)]*\):\n\n([\s\S]*?)\nYou won the right/.exec(text))) return `Plan: ${m[1].trim()}`;
  if ((m = /^You are reviewing work another Claude just finished for the task "(.*?)"/.exec(text))) return `Review the work on: ${m[1]}`;
  if ((m = /^You are finishing the task "(.*?)" in this repository\. (.*?):/.exec(text))) return `${m[2]}: fix it in ${m[1]}`;
  return null;
}
export function fromActivity(it) {
  if (it.kind === 'prompt') { const ask = backgroundAsk(it.text); return { kind: 'prompt', who: it.name, at: it.at, text: ask || it.text, bg: !!(it.bg || ask), agent: it.agent }; }
  if (it.kind === 'text') return { kind: 'reply', who: it.name, at: it.at, text: it.text, agent: it.agent };
  if (it.kind === 'tool') return { kind: 'tool', who: it.name, at: it.at, text: it.text, agent: it.agent };
  return { kind: 'end', who: it.name, at: it.at, agent: it.agent };
}
export function fromEvent(ev) {
  switch (ev.type) {
    case 'message': return [{ kind: 'msg', who: ev.message.fromName, at: ev.message.at, to: ev.message.to, text: ev.message.text }];
    case 'activity': return ev.items.map(fromActivity);
    case 'join': return ev.agent.kind === 'human' ? [] : [{ kind: 'join', who: ev.agent.name, at: ev.at, agentKind: ev.agent.kind }];
    case 'lock': return [{ kind: 'lock', who: ev.lock.holderName, at: ev.at, path: ev.lock.path, branch: ev.lock.branch, dir: !!ev.lock.dir }];
    case 'handoff': return [{ kind: 'handoff', who: ev.handoff.name, at: ev.at, text: ev.handoff.text, commits: ev.handoff.commits || [], auto: ev.handoff.auto }];
    case 'unlock': return [{ kind: 'unlock', who: ev.holderName, at: ev.at, path: ev.path, stale: ev.reason === 'stale' }];
    case 'file': return [{ kind: 'file', who: ev.file.byName, at: ev.at, path: ev.file.path, branch: ev.file.branch, version: ev.file.version }];
    case 'shared': return [{ kind: 'knowledge', who: ev.byName, at: ev.at, what: ev.kind, action: ev.action, title: ev.title || ev.name }];
    case 'git': return ev.ref && ev.action !== 'snapshot' ? [{ kind: 'git', who: ev.ref.owner, at: ev.at, branch: ev.ref.branch, subject: ev.ref.subject }] : [];
    case 'repo': return [{ kind: 'repo', who: ev.person || ev.by || 'GitHub', at: ev.at, repo: ev }];
    case 'board': {
      if (ev.action === 'goal') return [{ kind: 'goal', who: ev.byName, at: ev.at, goal: ev.goal }];
      if (ev.action === 'plan') return [{ kind: 'plan', who: ev.byName, at: ev.at, goal: ev.goal, tasks: ev.tasks || [] }];
      if (ev.action === 'claim-goal') return [{ kind: 'task', who: ev.byName, at: ev.at, text: `is splitting up “${shortTitle(ev.goal.text, 90)}”` }];
      if (ev.action === 'reassign' && ev.task) return [{ kind: 'task', who: ev.task.owner, at: ev.at, text: `took over “${shortTitle(ev.task.title, 90)}” from ${ev.from} (${ev.why})` }];
      if (ev.action === 'approve' && ev.approval) return [{ kind: 'approve', who: ev.byName, at: ev.at, approval: ev.approval }];
      if (ev.task && ev.action !== 'task-delete') return [{ kind: 'task', who: ev.byName, at: ev.at, text: ev.action === 'claim-task' ? `took “${shortTitle(ev.task.title, 90)}”` : `marked “${shortTitle(ev.task.title, 90)}” ${statusWord(ev.task.status).toLowerCase()}` }];
      return [];
    }
  }
  return [];
}
function addEntries(list) {
  if (!list.length) return;
  S.entries.push(...list);
  if (S.entries.length > 2000) S.entries.splice(0, S.entries.length - 2000);
}

// ---------- loading and live updates ----------
export const loadBoard = async () => { S.board = await api('board'); };
export const loadShared = async () => { S.shared = await api('shared'); };
export const loadMe = async () => {
  S.me = await api('whoami').catch(() => ({ role: 'member' }));
  if (S.me.name && S.me.name !== auth.name) { auth.name = S.me.name; store.set('huddle.name', auth.name); }
};
export const loadNotes = async () => {
  if (!auth.name) return;
  const r = await api('notes?name=' + encodeURIComponent(auth.name)).catch(() => null);
  if (r) { S.notes = r.notes; S.notePrefs = r.prefs; S.noteKinds = r.kinds; S.contact = r.contact || null; }
};
// ---------- the daily digest ----------
const digestSeenKey = () => 'huddle.digestSeen.' + auth.project;
export const markDigestSeen = (id) => { if (id) store.set(digestSeenKey(), id); };
export async function loadDigests() {
  const r = await api('digests');
  S.digests = r.digests; S.digestRecipient = r.recipient;
  return r;
}
export async function openDigest(id) {
  if (!S.digests.some(d => d.id === id)) await loadDigests().catch(() => {});
  const d = S.digests.find(x => x.id === id);
  if (d) S.digestShow = d;
}
// a pop-up the first time someone opens the project after a new digest, when the owner chose pop-ups
export async function checkDigest() {
  const r = await loadDigests();
  const latest = r.digests[r.digests.length - 1];
  if (r.settings.enabled && r.settings.popup && r.recipient && latest && store.get(digestSeenKey()) !== latest.id) S.digestShow = latest;
}
export const loadConflicts = async () => { S.conflicts = (await api('conflicts').catch(() => ({ conflicts: [] }))).conflicts; };

function applySnapshot(s) {
  S.agents = Object.fromEntries(s.agents.map(a => [a.id, a]));
  S.locks = Object.fromEntries(s.locks.map(l => [(l.branch || '') + '::' + l.path, l]));
  S.files = Object.fromEntries(s.files.map(f => [(f.branch || '') + '::' + f.path, f]));
  S.settings = s.settings || {}; S.aliases = s.aliases || {}; S.usage = s.usage || {};
  S.approvals = s.approvals || []; S.projectSettings = s.projectSettings || {}; S.problems = s.problems || []; S.members = s.members || [];
  setTeamNames(Object.keys(S.settings));
}

// the views that care subscribe here (the code view reloads a file that changed, stats refresh)
const listeners = new Set();
export const onLive = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function onEvent(ev) {
  switch (ev.type) {
    case 'join': case 'leave': case 'status': case 'activity': S.agents[ev.agent.id] = ev.agent; break;
    case 'lock': S.locks[(ev.lock.branch || '') + '::' + ev.lock.path] = ev.lock; break;
    case 'unlock': delete S.locks[(ev.branch || '') + '::' + ev.path]; break;
    case 'file': S.files[(ev.file.branch || '') + '::' + ev.file.path] = ev.file; break;
    case 'board': loadBoard().catch(() => {}); break;
    case 'shared': loadShared().catch(() => {}); break;
    case 'setting': S.settings[ev.name] = ev.settings; break;
    case 'usage': S.usage[ev.name] = ev.usage; break;
    case 'approval': S.approvals = [...S.approvals.filter(x => x.id !== ev.approval.id), ev.approval].filter(x => x.status === 'waiting'); break;
    case 'project-setting': S.projectSettings = ev.settings || {}; break;
    case 'problem': S.problems = [...S.problems, ev.problem].slice(-100); break;
    case 'conflicts': loadConflicts(); break;
    case 'digest': if (S.digestRecipient || S.me.role === 'owner') loadDigests().catch(() => {}); break;
    case 'note': if (ev.to === myName()) { S.notes = [...S.notes, ev.note].slice(-80); toast(ev.note); } break;
    case 'notes-read': if (ev.to === myName()) loadNotes(); break;
    case 'members':
      if (ev.removed && ev.removed === myName()) { S.fatal = 'You were removed from this project. Ask the owner for a new invite.'; return; }
      loadMe().catch(() => {});
      break;
    case 'deleted': S.fatal = 'This project was deleted.'; return;
    case 'merge': location.reload(); return;
    case 'forget': if (!ev.name) { location.reload(); return; } for (const [id, x] of Object.entries(S.agents)) if (x.name === ev.name) delete S.agents[id]; break;
  }
  if (!['leave', 'status', 'usage', 'approval', 'project-setting', 'problem', 'members', 'note', 'notes-read', 'conflicts', 'digest'].includes(ev.type)) addEntries(fromEvent(ev));
  for (const fn of listeners) { try { fn(ev); } catch {} }
}

// a notification while the page is open: a toast, and a desktop alert when the tab is in the background
const dnd = () => store.get('huddle.dnd') === '1';
function toast(n) {
  if (dnd()) return;
  const t = { id: n.id, title: n.title, body: n.body, link: n.link };
  S.toasts = [...S.toasts, t].slice(-4);
  setTimeout(() => { S.toasts = S.toasts.filter(x => x.id !== t.id); }, 15000);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification('huddle: ' + n.title, { body: String(n.body || '').slice(0, 300), tag: 'huddle-' + n.id }); } catch {}
  }
}
export const readNotes = (ids) => api('notes-read', ids ? { ids } : {}).then(() => { for (const n of S.notes) if (!ids || ids.includes(n.id)) n.read = true; }).catch(() => {});

let wsWorks = null;
function connect() {
  const qs = `${auth.token && auth.token !== 'account' ? 'token=' + encodeURIComponent(auth.token) + '&' : ''}since=999999999`;
  const live = (on) => { S.conn = on ? 'live' : 'reconnecting'; };
  if (wsWorks !== false && 'WebSocket' in window) {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/p/${encodeURIComponent(auth.project)}/ws?${qs}`);
    let opened = false, ping;
    ws.onopen = () => { opened = wsWorks = true; live(true); ping = setInterval(() => ws.send('ping'), 30000); };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      const ev = JSON.parse(e.data);
      if (ev.type === 'snapshot') applySnapshot(ev); else if (ev.type !== 'truncated') onEvent(ev);
    };
    ws.onclose = (e) => {
      clearInterval(ping); live(false);
      if (e.code === 4004) { S.fatal = 'This project was deleted.'; return; }
      if (!opened && wsWorks === null) { wsWorks = false; return connect(); }
      setTimeout(connect, 2000);
    };
    return;
  }
  const es = new EventSource(`/api/p/${encodeURIComponent(auth.project)}/events?${qs}`);
  es.addEventListener('snapshot', (e) => applySnapshot(JSON.parse(e.data)));
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  es.onopen = () => live(true);
  es.onerror = () => live(false);
}

// ---------- accounts ----------
export async function loadAccount() {
  const r = await fetch('/auth/me').then(x => x.json()).catch(() => ({}));
  S.account = { checked: true, github: !!r.github, email: !!r.email, user: r.user || null };
  if (!r.user) return;
  // the account's projects join this browser's, and this browser's go up to the account
  const mine = await fetch('/api/me/projects').then(x => x.json()).catch(() => ({ projects: [] }));
  for (const p of mine.projects || []) if (!known[p.project]) known[p.project] = p.token;
  saveKnown();
  const up = Object.entries(known).filter(([p, t]) => !(mine.projects || []).some(x => x.project === p && x.token === t)).map(([project, token]) => ({ project, token }));
  if (up.length) fetch('/api/me/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projects: up }) }).catch(() => {});
}
async function rememberProject() {
  known[auth.project] = auth.token; saveKnown();
  store.set('huddle.last', auth.project);
  if (auth.name) store.set('huddle.name', auth.name);
  if (S.account.user) fetch('/api/me/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: auth.project, token: auth.token, name: auth.name }) }).catch(() => {});
}

// ---------- invites ----------
export async function lookUpInvite(code, name) {
  const res = await fetch('/api/invite/' + encodeURIComponent(code));
  const r = await res.json().catch(() => ({}));
  if (!res.ok || !(r.token || r.personal)) throw new Error(r.error || 'no such invite');
  if (!r.personal) return { token: r.token, project: r.project };
  name = name || auth.name;
  if (!name) throw new Error('type your name first, then open the invite');
  const rr = await fetch(`/api/p/${encodeURIComponent(r.project)}/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name }) });
  const j = await rr.json().catch(() => ({}));
  if (!rr.ok) throw new Error(j.error || 'that invite did not work');
  auth.name = j.name;
  return { token: j.token, project: r.project };
}

// ---------- start ----------
// What the address bar asks for: an invite (long or short), a project this browser knows, or home.
// Returns 'home' or 'project'; App shows the matching screen.
export async function boot() {
  await loadAccount();
  // /app#demo (the landing page's "Try the live demo"): a fresh demo project, straight away
  if (params.has('demo')) {
    history.replaceState(null, '', location.pathname);
    S.demoStatus = 'Setting up a demo project with a simulated team…';
    import('./demo.js').then(m => m.openDemo((t) => { S.demoStatus = t; })).catch(e => { S.demoStatus = ''; S.fatal = "Couldn't set up the demo: " + e.message; });
    return 'home';
  }
  const fromInvite = params.get('invite') && decodeInvite(params.get('invite'));
  if (fromInvite && params.get('k')) { keys[fromInvite.project] = params.get('k'); store.set('huddle.keys', JSON.stringify(keys)); }
  if (params.get('name')) auth.name = params.get('name');
  const short = !fromInvite && SHORT_INVITE.test(String(params.get('invite') || '').trim()) ? params.get('invite').trim() : null;
  if (fromInvite) Object.assign(auth, fromInvite);
  else if (short) {
    try { Object.assign(auth, await lookUpInvite(short)); if (params.get('k')) { keys[auth.project] = params.get('k'); store.set('huddle.keys', JSON.stringify(keys)); } }
    catch { S.fatal = "That invite didn't work. Ask for a new one."; return 'home'; }
  } else if (params.get('token')) { auth.token = params.get('token'); auth.project = params.get('project'); }
  else {
    const want = params.get('p');
    if (want && known[want]) { auth.project = want; auth.token = known[want]; }
    // signed in, and the project is on the account through membership rather than a stored token
    else if (want && S.account.user) { auth.project = want; auth.token = 'account'; }
  }
  if (!auth.project) return 'home';
  return startProject();
}
export async function startProject() {
  try { await (auth.name ? api('hello', {}) : api('state')); }
  catch (e) {
    if (known[auth.project] === auth.token) forgetProject(auth.project);
    S.fatal = e.status === 401 ? "That invite didn't work, or your access ended. Ask for a new one." : e.message;
    auth.project = null;
    return 'home';
  }
  await rememberProject();
  S.demo = !!store.get('huddle.demo.' + auth.project);
  setHash();
  await loadMe();
  document.title = `${prettyProject(auth.project)} · huddle`;
  const [msgs, act, board, hand] = await Promise.all([api('messages?limit=200'), api('activity?limit=500'), api('board'), api('handoffs?limit=30').catch(() => ({ handoffs: [] }))])
    .catch(() => [{ messages: [] }, { activity: [] }, null, { handoffs: [] }]);
  if (board) S.board = board;
  S.entries = [
    ...msgs.messages.map(m => ({ kind: 'msg', who: m.fromName, at: m.at, to: m.to, text: m.text })),
    ...act.activity.map(fromActivity),
    ...(board ? board.goals.map(g => ({ kind: 'goal', who: g.byName, at: g.at, goal: g })) : []),
    ...hand.handoffs.map(h => fromEvent({ type: 'handoff', at: h.at, handoff: h })[0]),
  ].sort((a, b) => a.at - b.at);
  connect();
  loadShared().catch(() => {});
  loadNotes();
  loadConflicts();
  checkDigest().catch(() => {});
  // back from signing in to link the account to this project
  if (/[#&](gh|acct)=link/.test(location.hash) && S.account.user) api('link-account', {}).catch(() => {});
  catchUp();
  if (S.demo) import('./demo.js').then(m => m.runDemo());
  setInterval(() => { if (auth.name) api('hello', {}).catch(() => {}); }, 60000);
  return 'project';
}

export function setName(n) {
  n = n.trim().replace(/\s+/g, '-');
  if (!n) return;
  auth.name = n; store.set('huddle.name', n);
  api('hello', {}).catch(() => {});
  loadNotes();
}

// ---------- a one-line catch-up when someone comes back ----------
const seenKey = () => 'huddle.seen.' + auth.project;
export function catchUp() {
  const since = Number(store.get(seenKey())) || 0, me = myName();
  if (since && Date.now() - since > 30 * 60 * 1000 && me) {
    const tasks = S.board.tasks;
    const n = {
      'task done': tasks.filter(t => t.status === 'done' && t.updated > since).length,
      'new request': S.board.goals.filter(g => g.at > since && g.byName !== me).length,
      message: S.entries.filter(e => e.kind === 'msg' && e.at > since && e.who !== me && (!e.to || e.to === me)).length,
      'failed test run': tasks.filter(t => t.updated > since && t.checks && t.checks.tests === 'failed').length,
      'command waiting for your OK': S.approvals.filter(x => x.owner === me).length,
    };
    const bits = Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${v} ${k}${v > 1 && !k.startsWith('command') ? 's' : v > 1 ? 's' : ''}`);
    if (bits.length) S.catchup = `Since ${ago(since).replace(' ago', '')} ago: ${bits.join(' · ')}`;
  }
  const mark = () => { if (!document.hidden) store.set(seenKey(), String(Date.now())); };
  mark(); setInterval(mark, 60000); document.addEventListener('visibilitychange', mark);
}

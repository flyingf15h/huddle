// Environment-agnostic heart of the relay: project state and the API routes.
// Used by the Node server (server.js) and the Cloudflare Worker (worker/).
'use strict';
const path = require('path');
const crypto = require('crypto');
const { redact, cleanRules, isPrivatePath, deniedBy } = require('./policy');

const ONLINE_MS = 2 * 60 * 1000;          // agent counts as online if seen this recently
const LOCK_STALE_MS = 5 * 60 * 1000;      // locks of agents unseen this long are dropped
const FORGET_MS = 24 * 60 * 60 * 1000;   // offline agents drop off the list after a day
const MAX_EVENTS = 2000;
const MAX_MESSAGES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const HASH_HISTORY = 100;
const MAX_FILES = 2000;                    // per project
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;
const OPEN_MAX_PROJECTS = 5000;            // open mode limits, so a public server can't be filled up
const OPEN_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const OPEN_CREATES_PER_HOUR = 20;

const DEFAULT_LIMITS = { fileBytes: MAX_FILE_BYTES, files: MAX_FILES, projectBytes: MAX_PROJECT_BYTES,
  sharedBytes: 1536 * 1024, gitBytes: 200 * 1024 * 1024 };
const DOC_BYTES = 64 * 1024;        // PROJECT.md and each skill
const MEMORY_BYTES = 4 * 1024;      // each memory note
const MAX_MEMORIES = 300;
const MAX_SKILLS = 40;
const MAX_ACTIVITY = 600;
const GIT_CHUNK = 900 * 1024;       // raw bytes per uploaded bundle piece
const MAX_TASKS = 400;
const SNAP_PART = 900 * 1024;       // JSON bytes per uploaded piece of a branch's file listing           // per project, newest kept
const ACTIVITY_TEXT = 4000;
const STATS_DAYS = 60;              // daily buckets kept per person
const STATS_MODELS = 20;            // models tracked per person
const MAX_WORKLOG = 80;             // recent "now working on" changes, newest kept
const MAX_HANDOFFS = 60;            // "where I left off" notes, newest kept
// events that change who's doing what; hooks only re-read the team when this count moves
const TEAM_EVENTS = new Set(['status', 'lock', 'unlock', 'join', 'leave', 'setting']);

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function now() { return Date.now(); }
function httpError(code, msg) { const e = new Error(msg); e.code = code; return e; }
function sameSecret(x, y) {
  const a = Buffer.from(String(x)), b = Buffer.from(String(y));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Locks and live file copies are per git branch: people on the same branch
// share a working copy, people on different branches only see each other.
function fileKey(branch, fp) { return branch ? `${branch}::${fp}` : fp; }

// "Pip (tszfei's Claude)", or just "tszfei's Claude" when the person hasn't named it
function aiLabel(settings, person) {
  const s = (settings || {})[person] || {};
  const tool = s.tool === 'codex' ? 'Codex' : s.tool === 'cursor' ? 'Cursor' : 'Claude';
  return s.aiName ? `${s.aiName} (${person}'s ${tool})` : `${person}'s ${tool}`;
}
// lets people address someone's Claude by the name they gave it: "Pip" -> "tszfei"
function personFor(p, name) {
  if (!name) return null;
  const want = String(name).toLowerCase();
  for (const [person, s] of Object.entries(p.settings || {})) if (s && s.aiName && s.aiName.toLowerCase() === want) return person;
  return name;
}

// The lock of someone else's Claude that stops `who` locking fp (a folder when dir is set). A folder
// lock covers everything inside it, and two Claudes' locks never overlap: no file in someone's
// folder, no folder around someone's file or folder.
function blockingLock(p, who, branch, fp, dir) {
  const mine = dir ? fp + '/' : fp;
  for (const l of Object.values(p.locks)) {
    if (l.holder === who || (l.branch || null) !== branch) continue;
    if (l.path === mine || (l.dir && (fp + '/').startsWith(l.path)) || (dir && l.path.startsWith(fp + '/'))) return l;
  }
  return null;
}
// Commands that really need a person to say yes: anything that reaches outside the project or this
// computer, can't be undone, or acts on the person's own checkout. Everything else (tests, local git,
// project scripts) a background Claude may just run, in its own worktree.
const NEEDS_A_PERSON = /\b(push|deploy|publish|release|wrangler|vercel|netlify|heroku|gh\s+(pr|release|repo|api)|npm\s+(publish|login)|sudo|pkexec|su\s|ssh|scp|rsync|curl|wget|docker\s+(push|login)|kubectl|terraform|rm\s+-[a-z]*r|reset\s+--hard|clean\s+-[a-z]*f|kill(all)?\b|systemctl|shutdown|reboot|chmod\s+-R|chown|mkfs|dd\s+if=)|main checkout|your checkout|outside (the|this) (project|folder|repo)|(^|\s)~\/|\/etc\/|\/usr\//i;
function needsAPerson(command) { return NEEDS_A_PERSON.test(command); }

// A short invite: 12 characters from letters, digits, "-" and "_" (about 4.7e21 possibilities), starting
// with a letter or digit so it can't be mistaken for a command-line flag. The server keeps which project
// (and token) it stands for.
const INVITE_FIRST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const INVITE_REST = INVITE_FIRST + '-_';
const SHORT_INVITE = /^[A-Za-z0-9][\w-]{11}$/;
function shortInviteCode() {
  const b = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) { const set = i ? INVITE_REST : INVITE_FIRST; s += set[b[i] % set.length]; }
  return s;
}

// A request's first line as a title: "can you / please" and the like dropped, cut at the end of the first
// sentence, at most ~60 characters. Its Claude renames it to a few plain words when it starts.
function requestTitle(text) {
  // look past what a Claude passing work on puts first: "From Kelly (Kelly asked her Claude to send this):",
  // "Re:", "[NON-DEMO]", "NON-DEMO, do not start before …", "Finish request 1a2b3c4d ("the real ask")"
  const handed = /^\s*from\b/i.test(String(text || ''));
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  let t = lines.shift() || '';
  for (let k = 0; k < 8; k++) {
    const before = t;
    t = t.replace(/^from [\w .'-]{1,40}?(\s*\([^)]{0,400}\))?\s*[:,.;—–-]\s*/i, '')
      .replace(/^[\w .'-]{1,30} asked (her|his|their|my|your) claude to [^:]{0,40}:\s*/i, '')
      .replace(/^(re|fwd?|task|request|todo|note)\s*:\s*/i, '')
      .replace(/^\[[^\]]{1,30}\]\s*/, '')
      .replace(/^[A-Z][A-Z0-9-]{2,20}\s*[,:—–-]\s*/, '')
      .replace(/^(do not|don'?t) start (before|until)[^.;]*[.;]\s*/i, '')
      .replace(/^(task|part|step)\s*\d+\s*[,:.)-]\s*|^(\(?\d+[.)]|[-*•])\s+/i, '')
      .replace(/^finish request [0-9a-f]{6,10}\s*\(["“]?([^"”)]+)["”]?\)[.:]?\s*/i, '$1. ');
    // "Fei asked. …", "Fei asked me to pass this on: …" from a Claude passing work on
    if (handed) t = t.replace(/^[\w '-]{1,30}? asked( me)?( to [^.:;]{0,160})?\s*[.:;,]\s*/i, '');
    // an intro to a list ("Fei's decisions:") is named by its first item
    if ((!t.trim() || /:\s*$/.test(t)) && lines.length && /^(\(?\d+[.)]|[-*•]|(task|part|step)\s*\d)/i.test(lines[0])) t = lines.shift();
    if (!t.trim() && lines.length) t = lines.shift();
    if (t === before) break;
  }
  t = t.replace(/^(hey|hi|ok(ay)?|so|also|and|now)[,!.]?\s+/i, '')
    .replace(/^(can|could|would|will) (you|u)\s+(please\s+)?|^please\s+|^i (want|need|would like) (you )?to\s+|^(let'?s|go ahead and)\s+/i, '');
  const end = t.search(/[.?!;](\s|$)/);
  if (end > 12) t = t.slice(0, end);
  t = t.replace(/\s*\([^)]*(\)|$)/g, '').replace(/,?\s*(continuing|for|from|on top of)?\s*(goal|task|request|commit)\s+[0-9a-f]{7,40}\b/gi, '').trim();
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// a person's canonical name: aliases first, then a name that only differs in capitals ("kelly" -> "Kelly")
function canonicalName(p, name) {
  name = (p.aliases || {})[name] || name;
  if (!name) return name;
  const known = new Set([...Object.values(p.agents).map(a => a.name), ...Object.keys(p.settings || {}), ...Object.keys(p.stats || {})]);
  if (known.has(name)) return name;
  for (const k of known) if (k && k.toLowerCase() === name.toLowerCase()) return k;
  return name;
}
// board tasks a commit message says it finishes: "[1a2b3c4d]", "#1a2b3c4d", "closes 1a2b3c4d", "done: task 1a2b3c4d"
const CLOSES = /(?:\[|#|\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|done|finish(?:e[sd])?|complete[sd]?)\b[\s:]*(?:task\s*)?\[?#?)([0-9a-f]{8})\b/gi;
function taskIdsIn(text) { return [...new Set([...String(text || '').matchAll(CLOSES)].map(m => m[1].toLowerCase()))]; }

function normPath(p) {
  if (typeof p !== 'string' || !p) throw httpError(400, 'path required');
  const n = path.posix.normalize(p.replace(/\\/g, '/')).replace(/(.)\/+$/, '$1'); // folders are passed as "dir/"; we keep the slash ourselves
  if (n.startsWith('../') || n === '..' || path.posix.isAbsolute(n)) throw httpError(400, 'path must be relative to the project root');
  return n;
}

class Project {
  constructor(name, saved) {
    this.name = name;
    this.agents = {};   // id -> {id,name,host,checkout,kind,status,lastSeen,readSeq,joined}
    this.locks = {};    // path -> {path,holder,holderName,checkout,since,note,hold}
    this.files = {};    // path -> {path,hash,content,by,byName,at,version,hashes,checkout}
    this.messages = [];
    this.events = [];
    this.seq = 0;
    this.tokenHash = null;   // set for projects created in open mode; their own token unlocks them
    this.lastActive = now();
    // knowledge every agent in the project shares: a brief, notes and skills
    this.shared = { version: 0, doc: null, memories: [], skills: [] };
    this.activity = [];   // what each agent's Claude is doing: prompts, replies, tool calls
    // git history people published, as bundles; refs are "<person>/<branch>"
    this.git = { refs: {}, bundles: [], bytes: 0, uploads: {}, snapshots: {} };
    // team prompts ("goals") and the tasks the agents split them into
    this.board = { version: 0, goals: [], tasks: [] };
    this.settings = {};   // per person: { autopilot: 'off' | 'requests' | 'full', aiName: what they call their Claude }
    this.aliases = {};    // other names a person has used ("Kelly-Wang" -> "Kelly")
    this.stats = {};      // per person: conversations, turns, time with Claude, tokens (see 'POST stats')
    this.usage = {};      // per person: how much of their Claude plan's windows is used, from their status line
    this.approvals = [];  // commands a background Claude wasn't allowed to run, waiting for its person's OK
    this.keys = {};       // per person: hash of the key their own machine holds, so only they can approve from a browser
    this.projectSettings = {}; // { testCommand, review }: how background work is checked before it merges
    this.teamVersion = 0; // bumped by TEAM_EVENTS
    this.worklog = [];    // [{name, status, at}]: what each Claude said it started on
    this.handoffs = [];   // [{name, ai, text, files, commits, at}]: where a session left off, for whoever comes next
    this.members = {};    // name -> {role, tokenHash, at, by, github}: personal accounts, once the owner sets them up
    this.invites = {};    // id -> {codeHash, role, by, at, expires, uses, maxUses, revoked}: personal invites
    this.audit = [];      // [{at, by, action, detail}]: who changed what, and what background Claudes ran
    this.problems = [];   // [{at, name, kind, message, detail}]: crashes and failures from people's machines
    this.secretHooks = []; // notification webhooks; their URLs never leave the server
    this.waiters = new Set();
    if (saved) Object.assign(this, saved);
    this.waiters = new Set();
    this.dirty = false;
    this.changedFiles = new Set();     // paths whose content changed since the last save
    this.sharedChanged = false;
    this.activityChanged = false;
    this.boardChanged = false;
    this.isConnected = () => false;    // servers with live sockets count those agents as online
    this.limits = { ...DEFAULT_LIMITS };
  }
  toJSON() {
    const { waiters, dirty, changedFiles, sharedChanged, activityChanged, boardChanged, isConnected, limits, outbox, auditChanged, problemsChanged, repoCache, _nd, _na, ...rest } = this;
    return rest;
  }
  // events after `since`, or null if they've been dropped and the client must resync
  eventsSince(since) {
    if (since >= this.seq) return [];
    if (!this.events.length || this.events[0].seq > since + 1) return since === 0 && !this.events.length ? [] : null;
    return this.events.filter(ev => ev.seq > since);
  }
  sharedSize() { return JSON.stringify(this.shared).length; }
  changeShared(kind, action, info, by) {
    if (this.sharedSize() > this.limits.sharedBytes) throw httpError(413, 'shared knowledge is full; delete some memories or skills');
    this.shared.version++;
    this.sharedChanged = true;
    return this.emit('shared', { kind, action, ...info, byName: by.name, version: this.shared.version });
  }
  online(a) { return now() - a.lastSeen < ONLINE_MS || this.isConnected(a.id); }
  emit(type, data) {
    const ev = { seq: ++this.seq, type, at: now(), ...data };
    if (TEAM_EVENTS.has(type)) this.teamVersion = (this.teamVersion || 0) + 1;
    this.dirty = true;
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const w of [...this.waiters]) w(ev);
    return ev;
  }
  // commands still waiting for someone's OK
  liveApprovals() {
    const out = [];
    for (const x of this.approvals || []) {
      if (x.status !== 'waiting') continue;
      const t = x.taskId && this.board.tasks.find(y => y.id === x.taskId);
      // (a finished task can still need a person for something like a deploy; anything else has expired)
      if (x.taskId && (!t || (t.status === 'done' && !needsAPerson(x.command)))) { x.status = 'expired'; this.dirty = true; continue; }
      out.push(x);
    }
    return out;
  }
  publicAgent(a) {
    return { id: a.id, name: a.name, host: a.host, checkout: a.checkout, kind: a.kind, branch: a.branch || null, runner: a.runner || null,
      status: a.status, statusAuto: !!a.statusAuto, tool: a.tool || null, statusAt: a.statusAt || null, lastSeen: a.lastSeen, joined: a.joined || null, online: this.online(a), build: a.build || null, clone: a.clone || null };
  }
  fileMeta(f) {
    return { path: f.path, branch: f.branch || null, hash: f.hash, by: f.by, byName: f.byName, at: f.at,
      version: f.version, size: f.content == null ? 0 : f.content.length, checkout: f.checkout };
  }
  snapshot() {
    return {
      project: this.name,
      seq: this.seq,
      agents: Object.values(this.agents).map(a => this.publicAgent(a)),
      locks: Object.values(this.locks),
      files: Object.values(this.files).map(f => this.fileMeta(f)),
      settings: this.settings || {},
      aliases: this.aliases || {},
      usage: this.usage || {},
      approvals: this.liveApprovals(),
      projectSettings: this.projectSettings || {},
      teamVersion: this.teamVersion || 0,
      members: Object.entries(this.members || {}).map(([name, m]) => ({ name, role: m.role, github: m.github || null })),
      accounts: Object.values(this.members || {}).some(m => m.role === 'owner'),
      problems: (this.problems || []).slice(-20),
    };
  }
  touch(agent) {
    if (!agent || !agent.id) throw httpError(400, 'agent.id required');
    // a dashboard tab that never set a name is a visitor, not a teammate
    if (agent.kind === 'human' && agent.host === 'dashboard' && ['human', 'guest'].includes(agent.name)) {
      return { id: agent.id, name: agent.name, kind: 'human', status: '', lastSeen: now(), readSeq: this.seq, transient: true };
    }
    let a = this.agents[agent.id];
    // the name a session gives resolves once (aliases, capitals), not on every request
    const name = a && a.rawName === agent.name ? a.name : canonicalName(this, agent.name);
    const fresh = !a || !this.online(a);
    if (!a) {
      a = this.agents[agent.id] = { id: agent.id, readSeq: this.seq, joined: now(), status: '' };
    }
    a.rawName = agent.name;
    a.name = name || a.name || agent.id;
    a.host = agent.host || a.host || '';
    a.checkout = agent.checkout || a.checkout || '';
    a.kind = agent.kind || a.kind || 'agent';
    if (agent.branch !== undefined) a.branch = agent.branch || null;
    a.lastSeen = now();
    this.lastActive = a.lastSeen;
    if (fresh) this.emit('join', { agent: this.publicAgent(a) });
    return a;
  }
  relevant(m, a) {
    if (m.from === a.id) return false;
    return !m.to || m.to === a.id || m.to === a.name || m.to === '*';
  }
  sweep() {
    const t = now();
    // (locks are keyed by branch and path, so delete by the key: deleting by path left branch locks in
    // place, and every sweep announced the same release again)
    for (const [key, l] of Object.entries(this.locks)) {
      const a = this.agents[l.holder];
      if (!a || (t - a.lastSeen > LOCK_STALE_MS && !this.isConnected(a.id))) {
        delete this.locks[key];
        this.dirty = true;
        this.emit('unlock', { path: l.path, holder: l.holder, holderName: l.holderName, reason: 'stale' });
      }
    }
    const held = new Set(Object.values(this.locks).map(l => l.holder));
    // each person keeps one offline row per kind (the newest): old sessions are noise, not people
    const newest = {};
    for (const a of Object.values(this.agents)) {
      const k = a.name + '\0' + a.kind;
      if (!this.online(a) && !held.has(a.id) && (!newest[k] || newest[k].lastSeen < a.lastSeen)) newest[k] = a;
    }
    for (const a of Object.values(this.agents)) {
      const k = a.name + '\0' + a.kind;
      if (newest[k] && newest[k] !== a && !this.online(a) && !held.has(a.id) && !a.wasOnline) { delete this.agents[a.id]; continue; }
      if (t - a.lastSeen > FORGET_MS && !held.has(a.id) && !this.isConnected(a.id)) { delete this.agents[a.id]; continue; }
      const on = this.online(a);
      if (a.wasOnline && !on) {
        a.wasOnline = false;
        this.emit('leave', { agent: this.publicAgent(a) });
      } else if (on) a.wasOnline = true;
    }
    handOn(this);
    X.applyRetention(this);
    X.flushMail(this);
    X.maybeDigest(this);
    X.maybeAutomations(this);
  }
}

// Tasks stuck with someone who can't do them go back to the team: their Claude window is nearly
// used up, or they've been offline a while (their machine runs their Claudes). Requests sent to one
// person and parts a session kept for itself stay put. Only moved when someone else can take it.
const AWAY_MS = 10 * 60 * 1000, AWAY_DOING_MS = 20 * 60 * 1000;
function handOn(p) {
  const t0 = now();
  const seen = {};
  for (const a of Object.values(p.agents)) if (a.kind !== 'human') seen[a.name] = Math.max(seen[a.name] || 0, p.online(a) ? t0 : a.lastSeen);
  const low = (n) => { const u = (p.usage || {})[n]; return !!(u && t0 - u.at < 3600 * 1000 && u.five >= 90); };
  for (const t of p.board.tasks) {
    if (!t.owner || t.direct || t.held || t.status === 'done') continue;
    const away = t0 - (seen[t.owner] || 0);
    const why = t.limitHit ? `${t.owner}'s Claude hit its usage limit`
      : t.status === 'todo' && low(t.owner) ? `${t.owner} has under 10% of their Claude window left`
      : t.status === 'todo' && away > AWAY_MS ? `${t.owner} is offline`
      : t.status === 'doing' && away > AWAY_DOING_MS ? `${t.owner} went offline in the middle of it` : null;
    if (!why) continue;
    const to = assignByUsage(p, [{ title: t.title, effort: t.effort || 'medium' }], null, t.owner)[0];
    if (!to || to === t.owner) continue;
    const from = t.owner;
    t.owner = to; t.status = 'todo'; t.limitHit = false; t.updated = t0;
    t.notes = [...(t.notes || []), { by: 'huddle', at: t0, text: `Moved from ${from} to ${to}: ${why}.` }].slice(-20);
    boardChanged(p, 'reassign', { task: t, from, why }, { name: 'huddle' });
  }
}


const routes = {
  'POST hello': (p, b) => {
    const a = p.touch(b.agent);
    if (b.build !== undefined) a.build = b.build && typeof b.build === 'object' ? { sha: String(b.build.sha || '').slice(0, 40), at: Number(b.build.at) || 0 } : null;
    if (b.clone !== undefined) a.clone = b.clone ? String(b.clone).slice(0, 200) : null;
    if (b.status !== undefined && a.clone) a.statusAt = now();
    if (b.runner !== undefined) a.runner = ['off', 'requests', 'full'].includes(b.runner) ? b.runner : null;
    // Claude Code or Codex: remembered per person too, so the team knows whose is whose while they're away
    if (b.tool !== undefined && !a.clone && a.kind !== 'human') {
      a.tool = ['codex', 'cursor'].includes(b.tool) ? b.tool : 'claude';
      p.settings = p.settings || {};
      if ((p.settings[a.name] || {}).tool !== a.tool) { p.settings[a.name] = { ...(p.settings[a.name] || {}), tool: a.tool }; p.emit('setting', { name: a.name, settings: p.settings[a.name] }); }
    }
    if (b.status !== undefined) a.status = String(b.status).slice(0, 300);
    // the person's own huddle (not a dashboard tab) says which approve key is theirs
    if (b.keyHash && a.kind !== 'human' && !a.clone) { p.keys = p.keys || {}; p.keys[a.name] = String(b.keyHash).slice(0, 64); }
    // background work is on (Active) for everyone unless they turned it off: older runners fall back to
    // "requests only" when nothing is stored, so store the default the first time a runner shows up
    if (a.runner && a.kind !== 'human' && !a.clone && !((p.settings || {})[a.name] || {}).autopilot) {
      p.settings = p.settings || {};
      p.settings[a.name] = { ...(p.settings[a.name] || {}), autopilot: 'full' };
      p.emit('setting', { name: a.name, settings: p.settings[a.name] });
    }
    nudgeUpdate(p, a);
    p.dirty = true;
    return { ...p.snapshot(), you: p.publicAgent(a), ...(b.handoffs ? { handoffs: (p.handoffs || []).slice(-20) } : {}) };
  },
  'GET state': (p) => p.snapshot(),
  // this project's short invite (the same one every time); the server records what it stands for
  'POST invite-code': (p) => {
    if (!p.inviteCode) { p.inviteCode = shortInviteCode(); p.emit('invite-code', {}); }
    return { code: p.inviteCode };
  },
  'GET worklog': (p, b, q) => ({ worklog: (p.worklog || []).slice(-Math.min(Number(q.get('limit')) || 20, MAX_WORKLOG)) }),
  // one call per prompt instead of five: share the prompt, set the status, read mail, and get the
  // team's state and this person's open tasks back
  'POST turn': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    if (Array.isArray(b.items) && b.items.length) routes['POST activity'](p, { agent: b.agent, items: b.items });
    if (b.status) routes['POST status'](p, { agent: b.agent, status: b.status, auto: b.auto });
    const out = await routes['POST inbox'](p, { agent: b.agent }, q, ctx);
    // the rest only when it changed since the versions the caller last saw
    if (b.state || (b.teamVersion !== undefined && b.teamVersion !== out.teamVersion)) out.state = p.snapshot();
    if (b.boardVersion !== undefined && b.boardVersion !== p.board.version) out.board = p.board;
    if (b.sharedVersion !== undefined && b.sharedVersion !== p.shared.version) out.shared = p.shared;
    if (b.handoffsSince !== undefined) out.handoffs = (p.handoffs || []).filter(h => h.at > b.handoffsSince && h.agent !== a.id);
    out.tasks = p.board.tasks.filter(t => t.owner === a.name && t.status !== 'done');
    return out;
  },
  // where a session left off, for the team and the next session: one note per session, newest wins
  'POST handoff': (p, b) => {
    const a = p.touch(b.agent);
    const text = redact(String(b.text || '').trim().slice(0, 2000));
    if (!text) throw httpError(400, 'say where you left off');
    const h = { id: crypto.randomBytes(4).toString('hex'), name: a.name, agent: a.id, text, branch: a.branch || null,
      files: (Array.isArray(b.files) ? b.files : []).slice(0, 20).map(x => String(x).slice(0, 200)),
      commits: (Array.isArray(b.commits) ? b.commits : []).slice(0, 10).map(x => String(x).slice(0, 160)),
      at: now(), auto: !!b.auto };
    const prev = (p.handoffs || []).find(x => x.agent === a.id);
    if (b.auto && prev && !prev.auto) return { ok: true, handoff: prev, kept: true }; // Claude's own note beats a generated one
    p.handoffs = (p.handoffs || []).filter(x => x.agent !== a.id);
    p.handoffs.push(h);
    if (p.handoffs.length > MAX_HANDOFFS) p.handoffs.splice(0, p.handoffs.length - MAX_HANDOFFS);
    p.emit('handoff', { handoff: h });
    return { ok: true, handoff: h };
  },
  'GET handoffs': (p, b, q) => ({ handoffs: (p.handoffs || []).slice(-Math.min(Number(q.get('limit')) || 10, MAX_HANDOFFS)) }),
  // new commits from someone's checkout: tasks their messages say are finished get closed
  'POST commits': (p, b) => {
    const a = p.touch(b.agent);
    const closed = [];
    for (const c of (Array.isArray(b.commits) ? b.commits : []).slice(0, 50)) {
      for (const id of taskIdsIn(c.message)) {
        const t = p.board.tasks.find(x => x.id === id);
        if (!t || t.status === 'done') continue;
        t.status = 'done';
        t.owner = t.owner || a.name;
        t.updated = now();
        t.notes = [...(t.notes || []), { by: a.name, at: now(), text: `closed by commit ${String(c.sha || '').slice(0, 8)}: ${String(c.message).split('\n')[0].slice(0, 200)}` }].slice(-20);
        goalDone(p, t);
        closed.push(t);
      }
    }
    if (closed.length) boardChanged(p, 'task-update', { task: closed[0], tasks: closed }, a);
    return { ok: true, closed: closed.map(t => ({ id: t.id, title: t.title })) };
  },
  'POST bye': (p, b) => {
    const a = p.agents[b.agent && b.agent.id];
    if (a) {
      a.lastSeen = now() - ONLINE_MS; // shows as just gone offline
      a.runner = null;
      a.wasOnline = false;
      a.status = '';
      p.emit('leave', { agent: p.publicAgent(a) });
      // parts a session kept for itself and didn't finish go to its person's background Claudes
      const left = p.board.tasks.filter(t => t.held === a.id && t.status !== 'done');
      for (const t of left) { t.held = null; t.status = 'todo'; t.updated = now(); }
      if (left.length) boardChanged(p, 'release', { tasks: left }, a);
      p.dirty = true;
    }
    return { ok: true };
  },
  // two names are the same person: fold "from" into "into" everywhere, and keep it that way
  'POST merge-person': (p, b) => {
    p.touch(b.agent);
    const from = String(b.from || ''), into = String(b.into || '');
    if (!from || !into || from === into) throw httpError(400, 'from and into required');
    if (!Object.values(p.agents).some(a => a.name === from) && !p.messages.some(m => m.fromName === from)) throw httpError(404, `nobody called ${from}`);
    mergePerson(p, from, into);
    return { ok: true };
  },
  // change your own name: everything you did moves to the new one, and sessions still using the old
  // name are shown under the new one (they pick it up into their own config the next time they look)
  'POST rename': (p, b) => {
    const a = p.touch(b.agent);
    const into = String(b.name || '').trim().replace(/\s+/g, '-').slice(0, 40);
    if (!into) throw httpError(400, 'a name is required');
    const from = a.name;
    if (into === from) return { ok: true, name: into };
    const taken = [...Object.values(p.agents).map(x => x.name), ...Object.keys(p.settings || {}), ...Object.keys(p.stats || {}), ...Object.keys(p.members || {})];
    if (taken.some(n => n !== from && n.toLowerCase() === into.toLowerCase())) throw httpError(409, `someone on the team is already called ${into}`);
    mergePerson(p, from, into);
    p.dirty = true;
    return { ok: true, name: into };
  },
  // tidy the team list: names that only differ in capitals become one person (the one used most
  // recently wins), and each person keeps a single offline row
  'POST tidy': (p, b) => {
    p.touch(b.agent);
    const seen = {};
    for (const a of Object.values(p.agents)) {
      const k = a.name.toLowerCase();
      seen[k] = seen[k] || {};
      seen[k][a.name] = Math.max(seen[k][a.name] || 0, a.lastSeen);
    }
    for (const n of [...Object.keys(p.settings || {}), ...Object.keys(p.stats || {})]) {
      const k = n.toLowerCase();
      seen[k] = seen[k] || {};
      seen[k][n] = seen[k][n] || 0;
    }
    const merged = [];
    for (const names of Object.values(seen)) {
      const list = Object.entries(names).sort((x, y) => y[1] - x[1]).map(x => x[0]);
      for (const from of list.slice(1)) { mergePerson(p, from, list[0]); merged.push({ from, into: list[0] }); }
    }
    const before = Object.keys(p.agents).length;
    p.sweep();
    p.emit('forget', { name: '' });
    return { ok: true, merged, removed: before - Object.keys(p.agents).length };
  },
  // drop someone who isn't around any more (test runs, a name typo); never someone online or holding files
  'POST forget-agent': (p, b) => {
    p.touch(b.agent);
    const name = String(b.name || '');
    const theirs = Object.values(p.agents).filter(x => x.name === name && x.id !== b.agent.id);
    if (!theirs.length) throw httpError(404, `nobody called ${name}`);
    if (theirs.some(x => p.online(x))) throw httpError(409, `${name} is online right now`);
    if (Object.values(p.locks).some(l => theirs.some(x => x.id === l.holder))) throw httpError(409, `${name} still holds files`);
    for (const x of theirs) delete p.agents[x.id];
    p.emit('forget', { name });
    return { ok: true, removed: theirs.length };
  },
  'POST status': (p, b) => {
    const a = p.touch(b.agent);
    const status = redact(String(b.status || '').replace(/\s+/g, ' ').trim().slice(0, 300));
    if (status === a.status) return { ok: true };
    // only replace the status the caller saw (a late summary never overwrites a newer status)
    if (b.ifStatus !== undefined && a.status !== b.ifStatus) return { ok: false, status: a.status };
    // a status guessed from a prompt is only a stand-in: it doesn't replace the summary the Claude itself
    // set for the work it's on (follow-up prompts on the same work would otherwise overwrite it)
    if (b.auto && a.status && !a.statusAuto && now() - (a.statusAt || 0) < 30 * 60 * 1000) return { ok: true, kept: true };
    a.status = status;
    a.statusAuto = !!b.auto;
    a.statusAt = now();
    if (status) {
      p.worklog = p.worklog || [];
      p.worklog.push({ name: a.name, status, at: a.statusAt, auto: !!b.auto });
      if (p.worklog.length > MAX_WORKLOG) p.worklog.splice(0, p.worklog.length - MAX_WORKLOG);
    }
    p.emit('status', { agent: p.publicAgent(a) });
    p.dirty = true;
    return { ok: true };
  },
  'POST lock': (p, b) => {
    const a = p.touch(b.agent);
    const dir = !!b.dir || /[\\/]$/.test(String(b.path || ''));
    const fp = normPath(b.path);
    if (dir && fp === '.') throw httpError(400, 'lock a folder inside the project, not the whole project');
    const branch = b.branch || null;
    const key = fileKey(branch, dir ? fp + '/' : fp);
    const cur = p.locks[key];
    const f = dir ? null : p.files[key];
    const blocker = blockingLock(p, a.id, branch, fp, dir);
    // same file held on another branch: not a block, but a merge conflict in the making
    const elsewhere = Object.values(p.locks).filter(l => l.path === fp && (l.branch || null) !== branch && l.holder !== a.id)
      .map(l => ({ branch: l.branch, holderName: l.holderName }));
    const latest = f ? { hash: f.hash, version: f.version, byName: f.byName, at: f.at,
      known: b.baseHash ? f.hashes.includes(b.baseHash) : false } : null;
    if (blocker) {
      p.dirty = true;
      return { ok: false, lock: blocker, latest, elsewhere };
    }
    // a folder is a deliberate claim, so it stays until released or the session ends
    const lock = p.locks[key] = {
      path: dir ? fp + '/' : fp, branch, holder: a.id, holderName: a.name, checkout: a.checkout,
      since: cur ? cur.since : now(), note: b.note || (cur && cur.note) || '',
      hold: !!(b.hold || dir || (cur && cur.hold)), ...(dir ? { dir: true } : {}),
    };
    if (!cur) p.emit('lock', { lock });
    if (b.baseHash && !f) {
      // first time anyone locks this file: remember its starting point
      p.files[key] = { path: fp, branch, hash: b.baseHash, content: null, by: a.id, byName: a.name,
        at: now(), version: 0, hashes: [b.baseHash], checkout: a.checkout };
    }
    p.dirty = true;
    const withContent = f && f.content != null && b.baseHash !== f.hash && b.wantContent;
    return { ok: true, lock, latest, elsewhere, content: withContent ? f.content : undefined };
  },
  'POST unlock': (p, b) => {
    const a = p.touch(b.agent);
    const released = [];
    const keys = b.all ? Object.keys(p.locks) : (b.paths || [b.path]).map(x => fileKey(b.branch || null, normPath(x) + (/[\\/]$/.test(x) ? '/' : '')));
    for (const key of keys) {
      const l = p.locks[key];
      if (!l || l.holder !== a.id) continue;
      if (b.all && b.keepHeld && l.hold) continue;
      delete p.locks[key];
      released.push(l.path);
      p.emit('unlock', { path: l.path, branch: l.branch || null, holder: a.id, holderName: a.name, reason: b.reason || 'released' });
    }
    p.dirty = true;
    return { ok: true, released };
  },
  'POST content': (p, b) => {
    const a = p.touch(b.agent);
    const fp = normPath(b.path);
    if (isPrivatePath(p.projectSettings, fp)) throw httpError(403, `${fp} is private in this project, so it isn't shared`);
    if (typeof b.content !== 'string') throw httpError(400, 'content must be a string');
    if (Buffer.byteLength(b.content) > p.limits.fileBytes) throw httpError(413, 'file too large to share');
    const branch = b.branch || null;
    const key = fileKey(branch, fp);
    const blocker = blockingLock(p, a.id, branch, fp, false);
    if (blocker) throw httpError(409, `locked by ${blocker.holderName}${blocker.dir ? ` (the whole ${blocker.path} folder)` : ''}`);
    const l = p.locks[key];
    if (!l) {
      p.locks[key] = { path: fp, branch, holder: a.id, holderName: a.name, checkout: a.checkout,
        since: now(), note: '', hold: false };
      p.emit('lock', { lock: p.locks[key] });
    }
    const hash = sha(b.content);
    const prev = p.files[key];
    if (!prev && Object.keys(p.files).length >= p.limits.files) throw httpError(413, 'project has too many shared files');
    const total = Object.values(p.files).reduce((n, f) => n + (f.content ? f.content.length : 0), 0);
    if (total - (prev && prev.content ? prev.content.length : 0) + b.content.length > p.limits.projectBytes) throw httpError(413, 'project storage is full');
    if (prev && prev.hash === hash && prev.content != null) return { ok: true, version: prev.version, unchanged: true };
    p.changedFiles.add(key);
    const f = p.files[key] = {
      path: fp, branch, hash, content: b.content, by: a.id, byName: a.name, at: now(),
      version: (prev ? prev.version : 0) + 1,
      hashes: [...(prev ? prev.hashes : []), hash].slice(-HASH_HISTORY),
      checkout: a.checkout,
    };
    p.emit('file', { file: p.fileMeta(f), prevHash: prev ? prev.hash : null, tool: b.tool || '' });
    p.dirty = true;
    return { ok: true, version: f.version, hash };
  },
  'GET file': (p, b, q) => {
    const fp = normPath(q.get('path'));
    const key = fileKey(q.get('branch') || null, fp);
    const f = p.files[key];
    if (!f || f.content == null) throw httpError(404, 'no shared content for ' + fp);
    return { ...p.fileMeta(f), content: f.content, hashes: f.hashes, lock: p.locks[key] || null };
  },
  'POST message': (p, b) => {
    const a = p.touch(b.agent);
    const text = String(b.text || '').trim();
    if (!text) throw httpError(400, 'text required');
    const m = { id: crypto.randomBytes(6).toString('hex'), from: a.id, fromName: a.name,
      to: personFor(p, b.to) || null, text: text.slice(0, 20000), at: now() };
    // a Claude's automatic answer: it never starts another background run, so two Claudes can't loop
    if (b.auto) m.auto = true;
    p.messages.push(m);
    if (p.messages.length > MAX_MESSAGES) p.messages.splice(0, p.messages.length - MAX_MESSAGES);
    m.seq = p.emit('message', { message: m }).seq;
    // the person it's for hears about it; a team message tells whoever it @mentions
    const toName = m.to && !String(m.to).includes('#') ? m.to : m.to ? (p.agents[m.to] || {}).name : null;
    if (toName && toName !== a.name && a.kind !== 'human') X.notePerson(p, toName, 'message', `${aiLabel(p.settings, a.name)} messaged you`, m.text, { view: 'activity' });
    else if (toName && toName !== a.name) X.notePerson(p, toName, 'message', `${a.name} messaged you`, m.text, { view: 'activity' });
    if (!m.to) for (const [, who] of m.text.matchAll(/(?:^|\s)@([\w.-]{2,40})/g)) { const n = canonicalName(p, who); if (n !== a.name && (p.settings[n] || p.stats[n] || (p.members || {})[n])) X.notePerson(p, n, 'mention', `${a.name} mentioned you`, m.text, { view: 'activity' }); }
    p.dirty = true;
    return { ok: true, message: m };
  },
  'GET messages': (p, b, q) => {
    const since = Number(q.get('since') || 0);
    const limit = Math.min(Number(q.get('limit') || 200), 1000);
    return { messages: p.messages.filter(m => m.seq > since).slice(-limit) };
  },
  // unread messages for an agent; advances its read pointer unless peek=1
  'POST inbox': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const unread = () => p.messages.filter(m => m.seq > a.readSeq && p.relevant(m, a));
    let msgs = unread();
    if (!msgs.length && b.wait > 0) {
      await ctx.waitFor(ev => ev.type === 'message' && p.relevant(ev.message, a), b.wait * 1000);
      msgs = unread();
    }
    if (!b.peek && msgs.length) { a.readSeq = msgs[msgs.length - 1].seq; p.dirty = true; }
    return { messages: msgs, sharedVersion: p.shared.version, boardVersion: p.board.version, teamVersion: p.teamVersion || 0 };
  },
  'GET shared': (p) => p.shared,
  // ---- git: people publish branches as bundles, everyone fetches them ----
  'GET git': (p) => ({ refs: p.git.refs, bundles: p.git.bundles, bytes: p.git.bytes, limit: p.limits.gitBytes,
    snapshots: Object.fromEntries(Object.entries(p.git.snapshots || {}).map(([k, v]) => [k, { sha: v.sha, at: v.at }])) }),
  // a bundle arrives in pieces (requests are size-limited); the last piece registers it
  'POST git-upload': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const id = String(b.id || '');
    if (!/^[a-f0-9]{8,32}$/.test(id)) throw httpError(400, 'bad bundle id');
    const n = Number(b.n), i = Number(b.i);
    if (!(n >= 1 && n <= 64 && i >= 0 && i < n)) throw httpError(400, 'bad chunk index');
    const data = String(b.data || '');
    const size = Math.floor(data.length * 3 / 4);
    if (size > GIT_CHUNK + 4) throw httpError(413, 'chunk too large');
    if (p.git.bytes + size > p.limits.gitBytes) throw httpError(413, `the project's git storage is full (${Math.round(p.limits.gitBytes / 1048576)} MB); share history through a normal git remote instead`);
    await ctx.blobs.put(`git:${id}:${i}`, data);
    const up = p.git.uploads[id] = p.git.uploads[id] || { got: [], bytes: 0, at: now() };
    if (!up.got.includes(i)) { up.got.push(i); up.bytes += size; }
    if (up.got.length < n) { p.dirty = true; return { ok: true, pending: n - up.got.length }; }
    delete p.git.uploads[id];
    const branch = String(b.branch || '').slice(0, 200);
    const sha40 = /^[0-9a-f]{40}$/;
    if (!branch || !sha40.test(b.tip || '')) throw httpError(400, 'branch and tip required');
    const bundle = { id, owner: a.name, branch, tip: b.tip, prereqs: (b.prereqs || []).filter(x => sha40.test(x)).slice(0, 200),
      n, size: up.bytes, at: now(), checkout: a.checkout };
    p.git.bundles.push(bundle);
    p.git.bytes += up.bytes;
    const ref = p.git.refs[`${a.name}/${branch}`] = { owner: a.name, branch, sha: b.tip, at: now(), checkout: a.checkout, subject: String(b.subject || '').slice(0, 200) };
    p.emit('git', { action: 'publish', ref, bundle: bundle.id });
    return { ok: true, id };
  },
  // a branch moved to a commit the server already has (no new objects to send)
  'POST git-ref': (p, b) => {
    const a = p.touch(b.agent);
    if (!/^[0-9a-f]{40}$/.test(b.tip || '') || !b.branch) throw httpError(400, 'branch and tip required');
    const ref = p.git.refs[`${a.name}/${b.branch}`] = { owner: a.name, branch: String(b.branch).slice(0, 200), sha: b.tip, at: now(), checkout: a.checkout, subject: String(b.subject || '').slice(0, 200) };
    p.emit('git', { action: 'publish', ref });
    return { ok: true };
  },
  // take back a branch you published (only your own); its bundles go too
  'POST git-forget': (p, b) => {
    const a = p.touch(b.agent);
    const drop = Object.values(p.git.refs).filter(r => r.owner === a.name && (!b.branch || r.branch === b.branch));
    if (!drop.length) throw httpError(404, 'you have no published branch by that name');
    for (const r of drop) {
      delete p.git.refs[`${r.owner}/${r.branch}`];
      for (const x of p.git.bundles.filter(x => x.owner === r.owner && x.branch === r.branch)) p.git.bytes -= x.size;
      p.git.bundles = p.git.bundles.filter(x => !(x.owner === r.owner && x.branch === r.branch));
      p.emit('git', { action: 'forget', owner: r.owner, branch: r.branch });
    }
    return { ok: true, removed: drop.map(r => `${r.owner}/${r.branch}`) };
  },
  // a readable copy of a published branch's files, so the dashboard can show the project
  'POST git-snapshot': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const branch = String(b.branch || '');
    if (!branch || !/^[0-9a-f]{40}$/.test(b.sha || '')) throw httpError(400, 'branch and sha required');
    const n = Number(b.n), i = Number(b.i);
    if (!(n >= 1 && n <= 32 && i >= 0 && i < n)) throw httpError(400, 'bad part index');
    const files = (Array.isArray(b.files) ? b.files : []).map(f => ({ path: normPath(f.path), content: String(f.content || '') })).filter(f => !isPrivatePath(p.projectSettings, f.path));
    const data = JSON.stringify(files);
    if (data.length > SNAP_PART + 4096) throw httpError(413, 'snapshot part too large');
    const key = `${a.name}/${branch}`;
    await ctx.blobs.put(`snap:${key}:${b.sha}:${i}`, data);
    p.git.snapshots = p.git.snapshots || {};
    const up = p.git.uploads['snap:' + key] = (p.git.uploads['snap:' + key] && p.git.uploads['snap:' + key].sha === b.sha) ? p.git.uploads['snap:' + key] : { sha: b.sha, got: [], files: {} };
    if (!up.got.includes(i)) up.got.push(i);
    for (const f of files) up.files[f.path] = { i, size: f.content.length };
    if (up.got.length < n) { p.dirty = true; return { ok: true, pending: n - up.got.length }; }
    delete p.git.uploads['snap:' + key];
    const old = p.git.snapshots[key];
    p.git.snapshots[key] = { owner: a.name, branch, sha: b.sha, n, at: now(), files: up.files, skipped: (b.skipped || []).slice(0, 200).map(String) };
    if (old && old.sha !== b.sha && ctx.blobs.del) for (let j = 0; j < old.n; j++) await ctx.blobs.del(`snap:${key}:${old.sha}:${j}`);
    p.emit('git', { action: 'snapshot', ref: p.git.refs[key] || { owner: a.name, branch, sha: b.sha } });
    return { ok: true };
  },
  'GET git-tree': (p, b, q) => {
    const snaps = p.git.snapshots || {};
    if (!q.get('ref')) return { refs: Object.values(snaps).map(x => ({ owner: x.owner, branch: x.branch, sha: x.sha, at: x.at, count: Object.keys(x.files).length })) };
    const sn = snaps[q.get('ref')];
    if (!sn) throw httpError(404, 'no snapshot for ' + q.get('ref'));
    return { owner: sn.owner, branch: sn.branch, sha: sn.sha, at: sn.at, skipped: sn.skipped,
      files: Object.entries(sn.files).map(([path, f]) => ({ path, size: f.size })).sort((x, y) => x.path.localeCompare(y.path)) };
  },
  'GET git-blob': async (p, b, q, ctx) => {
    const sn = (p.git.snapshots || {})[q.get('ref')];
    const fp = normPath(q.get('path'));
    if (!sn || !sn.files[fp]) throw httpError(404, 'no such file in ' + q.get('ref'));
    const part = await ctx.blobs.get(`snap:${q.get('ref')}:${sn.sha}:${sn.files[fp].i}`);
    const f = part && JSON.parse(part).find(x => x.path === fp);
    if (!f) throw httpError(404, 'file content missing');
    return { path: fp, content: f.content, sha: sn.sha, owner: sn.owner, branch: sn.branch };
  },
  'GET git-chunk': async (p, b, q, ctx) => {
    const data = await ctx.blobs.get(`git:${q.get('id')}:${Number(q.get('i'))}`);
    if (data == null) throw httpError(404, 'no such bundle piece');
    return { data };
  },

  // ---- team board: a person gives the team a goal, one Claude plans it, everyone works it ----
  'GET board': (p) => p.board,
  'GET settings': (p) => ({ settings: p.settings || {} }),
  // project-wide: the command that tests the project, and whether a second Claude reviews work first
  'POST project-setting': (p, b) => {
    const a = p.touch(b.agent);
    p.projectSettings = p.projectSettings || {};
    if (b.testCommand !== undefined) p.projectSettings.testCommand = String(b.testCommand || '').trim().slice(0, 300) || null;
    if (b.review !== undefined) p.projectSettings.review = b.review !== false;
    if (b.crossReview !== undefined) p.projectSettings.crossReview = b.crossReview !== false;
    // false: only personal invites work; the shared token everyone first joined with stops working
    if (b.sharedToken !== undefined) {
      if (b.sharedToken === false && !hasOwner(p)) throw httpError(409, 'set up accounts before switching the shared invite off');
      p.projectSettings.sharedToken = b.sharedToken !== false;
    }
    if (b.membersCanInvite !== undefined) p.projectSettings.membersCanInvite = b.membersCanInvite !== false;
    // how finished background work arrives: merged into the person's branch, or as a GitHub pull request
    if (b.delivery !== undefined) p.projectSettings.delivery = b.delivery === 'pr' ? 'pr' : 'merge';
    const said = { testCommand: (v) => v ? `test command: ${v}` : 'test command: guessed', crossReview: (v) => `review by another vendor: ${v === false ? 'off' : 'on'}`, review: (v) => `review before merging: ${v === false ? 'off' : 'on'}`,
      sharedToken: (v) => v === false ? 'switched the shared invite off' : 'switched the shared invite on', membersCanInvite: (v) => `members can invite: ${v === false ? 'no' : 'yes'}`,
      delivery: (v) => v === 'pr' ? 'finished work opens a pull request' : "finished work merges into its person's branch" };
    audit(p, a.name, 'settings', Object.keys(b).filter(k => said[k]).map(k => said[k](b[k])).join('; '));
    p.emit('project-setting', { settings: p.projectSettings, byName: a.name });
    return { ok: true, settings: p.projectSettings };
  },
  // a background Claude needed commands it isn't allowed to run; they wait for its person's OK
  'POST approval-request': (p, b) => {
    const a = p.touch(b.agent);
    const t = p.board.tasks.find(x => x.id === b.taskId);
    p.approvals = p.approvals || [];
    const made = [];
    for (const c of (Array.isArray(b.commands) ? b.commands : []).slice(0, 5)) {
      const command = String(c.command || '').trim().slice(0, 500);
      if (command && deniedBy((p.projectSettings || {}).policy, command)) { made.push({ command, status: 'denied', why: 'never allowed in this project' }); continue; }
      if (!command || p.approvals.some(x => x.status === 'waiting' && x.owner === a.name && x.command === command && x.taskId === b.taskId)) continue;
      const x = { id: crypto.randomBytes(4).toString('hex'), taskId: t ? t.id : null, title: t ? t.title : '', owner: a.name,
        command, why: String(c.why || '').slice(0, 300), status: 'waiting', at: now() };
      p.approvals.push(x);
      made.push(x);
      p.emit('approval', { approval: x });
      { const line = `${a.name}'s Claude needs ${a.name}'s OK to run \`${command.slice(0, 120)}\`${x.title ? ` for "${x.title}"` : ''}`; notify(p, 'approval', line, { slack: X.slackApprovalBlocks(line, x.id) }); }
      X.notePerson(p, a.name, 'approval', 'Your agent needs your OK', `${command.slice(0, 200)}${x.title ? ` (for "${x.title}")` : ''}`, { view: 'activity', approval: x.id });
    }
    if (p.approvals.length > 100) p.approvals.splice(0, p.approvals.length - 100);
    p.dirty = true;
    return { ok: true, approvals: made };
  },
  'GET approvals': (p) => { p.liveApprovals(); return { approvals: (p.approvals || []).slice(-50) }; },
  // Only the person whose Claude asked can say yes: from their own huddle (CLI or Claude), or from a
  // browser holding the key their machine gave it (huddle open). Saying yes lets the task run again
  // with that exact command allowed. Several can be decided at once (ids), so a task that needs a few
  // commands runs again once with all of them, not once per command.
  'POST approve': (p, b) => {
    const a = p.touch(b.agent);
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 20) : [b.id];
    const list = ids.map(id => {
      const x = (p.approvals || []).find(y => y.id === id);
      if (!x) throw httpError(404, 'no such approval');
      return x;
    });
    const fromBrowser = a.kind === 'human';
    for (const x of list) {
      const keyOk = b.key && p.keys && p.keys[x.owner] && sha(String(b.key)) === p.keys[x.owner];
      if (a.name !== x.owner || (fromBrowser && !keyOk)) {
        throw httpError(403, fromBrowser && a.name === x.owner ? 'open the dashboard with `huddle open` on your computer to approve from here' : `only ${x.owner} can approve commands for their Claude`);
      }
    }
    const touched = new Map();
    for (const x of list) {
      if (x.status !== 'waiting') continue;
      const rule = b.allow !== false && deniedBy((p.projectSettings || {}).policy, x.command);
      if (rule) throw httpError(403, `\`${x.command}\` is never allowed in this project (rule: ${rule})`);
      x.status = b.allow === false ? 'denied' : 'approved';
      audit(p, a.name, 'approve', `${x.status === 'approved' ? 'allowed' : 'refused'} \`${x.command}\`${x.title ? ` for "${x.title}"` : ''}`);
      x.by = a.name; x.decidedAt = now();
      const t = p.board.tasks.find(y => y.id === x.taskId);
      if (t) {
        if (x.status === 'approved') { t.allow = [...new Set([...(t.allow || []), x.command])].slice(-10); t.status = 'todo'; t.held = null; }
        t.notes = [...(t.notes || []), { by: a.name, at: now(), text: `${x.status === 'approved' ? 'Allowed' : 'Said no to'}: ${x.command}` }].slice(-20);
        t.updated = now();
        touched.set(t.id, { t, x });
      }
      p.emit('approval', { approval: x });
    }
    for (const { t, x } of touched.values()) boardChanged(p, 'approve', { task: t, approval: x }, a);
    p.dirty = true;
    return { ok: true, approval: list[0], approvals: list };
  },
  // the status line reports how much of the person's 5-hour and weekly windows is used, so plans
  // can hand heavier work to whoever has more left. Numbers only; it doesn't count as being online.
  'POST usage': (p, b) => {
    const name = canonicalName(p, b.agent && b.agent.name);
    if (!name) throw httpError(400, 'agent.name required');
    const pct = (v) => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null);
    const u = { five: pct(b.five), week: pct(b.week), fiveResets: Number(b.fiveResets) || null, weekResets: Number(b.weekResets) || null, at: now() };
    p.usage = p.usage || {};
    const old = p.usage[name];
    p.usage[name] = u;
    p.dirty = true;
    if (!old || old.five !== u.five || old.week !== u.week) p.emit('usage', { name, usage: u });
    return { ok: true };
  },
  // your own settings only: whether others can start your Claude on things
  // and the name you gave your Claude ("" clears it)
  'POST setting': (p, b) => {
    const a = p.touch(b.agent);
    p.settings = p.settings || {};
    const change = {};
    if (b.autopilot !== undefined) {
      const mode = String(b.autopilot || '');
      if (!['off', 'requests', 'full'].includes(mode)) throw httpError(400, 'autopilot must be off, requests or full');
      change.autopilot = mode;
    }
    if (b.aiName !== undefined) {
      const n = String(b.aiName || '').replace(/[\s"'`<>]+/g, ' ').trim().slice(0, 32);
      const taken = n && (Object.values(p.agents).some(x => x.name.toLowerCase() === n.toLowerCase() && x.name !== a.name) ||
        Object.entries(p.settings).some(([who, s]) => who !== a.name && s && s.aiName && s.aiName.toLowerCase() === n.toLowerCase()));
      if (taken) throw httpError(409, `"${n}" is already someone on this team; pick another name`);
      change.aiName = n || null;
    }
    // how the team sees them: a display name (spaces and all) and a small profile picture
    if (b.displayName !== undefined) change.displayName = String(b.displayName || '').replace(/[<>\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || null;
    if (b.avatar !== undefined) {
      const img = String(b.avatar || '');
      if (img && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(img)) throw httpError(400, 'the picture has to be a PNG, JPEG or WebP image');
      if (img.length > 60000) throw httpError(413, 'that picture is too big; pick a smaller one');
      change.avatar = img || null;
    }
    if (!Object.keys(change).length) throw httpError(400, 'nothing to change: give autopilot, aiName, displayName or avatar');
    p.settings[a.name] = { ...(p.settings[a.name] || {}), ...change, at: now() };
    if (change.autopilot) audit(p, a.name, 'mode', `background work: ${change.autopilot}`);
    p.emit('setting', { name: a.name, settings: p.settings[a.name] });
    return { ok: true, settings: p.settings[a.name] };
  },
  'POST goal': (p, b) => {
    const a = p.touch(b.agent);
    const text = String(b.text || '').trim().slice(0, 8000);
    if (!text) throw httpError(400, 'what should the team do?');
    const to = personFor(p, b.to);
    const goal = { id: crypto.randomBytes(4).toString('hex'), text, by: a.id, byName: a.name, at: now(), status: 'open', planner: null, to: to || null };
    // a short title from whoever sent it (a Claude handing work on gives one), else one made from the text
    const given = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (given) goal.title = given;
    p.board.goals.push(goal);
    if (p.board.goals.length > 100) p.board.goals.splice(0, p.board.goals.length - 100);
    // aimed at one person's Claude: skip planning, it's simply their task
    // huddle_distribute plans its own prompt, so nobody else may claim it in between
    if (!to && b.claim) { goal.planner = a.name; goal.status = 'planning'; }
    if (to) {
      goal.status = 'planned';
      goal.planner = to;
      const t = pushTask(p, { goalId: goal.id, title: given || requestTitle(text), detail: text, owner: to, direct: true }, a);
      if (to !== a.name) X.notePerson(p, to, 'request', `${a.name} sent your agent a request`, text, { view: 'tasks', task: t.id });
    }
    boardChanged(p, 'goal', { goal }, a);
    return { ok: true, goal };
  },
  // first agent to claim a goal gets to split it into tasks; everyone else waits for the plan
  'POST claim-goal': (p, b) => {
    const a = p.touch(b.agent);
    const g = p.board.goals.find(x => x.id === b.id);
    if (!g) throw httpError(404, 'no such goal');
    if (g.planner && g.planner !== a.name) return { ok: false, planner: g.planner, goal: g };
    g.planner = a.name;
    g.status = g.status === 'open' ? 'planning' : g.status;
    boardChanged(p, 'claim-goal', { goal: g }, a);
    return { ok: true, goal: g };
  },
  'POST plan': (p, b) => {
    const a = p.touch(b.agent);
    const g = p.board.goals.find(x => x.id === b.goalId);
    if (!g) throw httpError(404, 'no such goal');
    if (g.planner && g.planner !== a.name) throw httpError(409, `${g.planner} is planning this goal`);
    const tasks = (Array.isArray(b.tasks) ? b.tasks : []).slice(0, 30);
    if (!tasks.length) throw httpError(400, 'a plan needs at least one task');
    g.planner = a.name;
    g.status = 'planned';
    g.plan = String(b.summary || '').slice(0, 4000);
    if (b.title) g.title = String(b.title).replace(/\s+/g, ' ').trim().slice(0, 80);
    // "keep": the planner's own session does it (so its background runner leaves it alone)
    const owners = assignByUsage(p, tasks.map(t => (t.keep ? { ...t, owner: a.name } : t)), a.name);
    const made = tasks.map((t, i) => {
      const task = pushTask(p, { goalId: g.id, title: t.title, detail: t.detail, owner: owners[i], effort: t.effort, paths: t.paths }, a);
      if (t.keep) { task.held = a.id; task.status = 'doing'; }
      return task;
    });
    // "after" refers to earlier tasks in this same list by index
    tasks.forEach((t, i) => { made[i].after = (Array.isArray(t.after) ? t.after : []).map(j => made[j] && made[j].id).filter(Boolean); });
    // tasks that change the same files wait for each other instead of colliding later
    X.conflictAware(p, made, tasks);
    boardChanged(p, 'plan', { goal: g, tasks: made }, a);
    return { ok: true, tasks: made };
  },
  'POST task': (p, b) => {
    const a = p.touch(b.agent);
    const t = pushTask(p, { goalId: b.goalId || null, title: b.title, detail: b.detail, owner: b.owner || null }, a);
    boardChanged(p, 'task', { task: t }, a);
    return { ok: true, task: t };
  },
  // take an unowned task (atomic, so two Claudes can't both grab it)
  'POST claim-task': (p, b) => {
    const a = p.touch(b.agent);
    const t = p.board.tasks.find(x => x.id === b.id);
    if (!t) throw httpError(404, 'no such task');
    if (t.owner && t.owner !== a.name) return { ok: false, owner: t.owner, task: t };
    t.owner = a.name;
    if (t.status === 'todo') t.status = 'doing';
    t.updated = now();
    boardChanged(p, 'claim-task', { task: t }, a);
    return { ok: true, task: t };
  },
  'POST task-update': (p, b) => {
    const a = p.touch(b.agent);
    const t = p.board.tasks.find(x => x.id === b.id);
    if (!t) throw httpError(404, 'no such task');
    const was = t.status;
    if (b.status) {
      if (!['todo', 'doing', 'done', 'blocked'].includes(b.status)) throw httpError(400, 'status must be todo, doing, done or blocked');
      t.status = b.status;
    }
    if (b.owner !== undefined) t.owner = b.owner || null;
    // each background attempt: how it ended, so retries and crashes are visible instead of silent
    if (b.run && typeof b.run === 'object') {
      const r = b.run;
      t.runs = [...(t.runs || []), { at: now(), by: a.name, attempt: Math.max(1, Math.min(Number(r.attempt) || 1, 20)),
        outcome: ['ok', 'failed', 'crashed', 'limit', 'retrying', 'waiting'].includes(r.outcome) ? r.outcome : 'failed',
        ms: Math.max(0, Number(r.ms) || 0), error: redact(String(r.error || '').slice(0, 600)), agent: r.agent === 'codex' ? 'codex' : 'claude' }].slice(-10);
    }
    if (b.status === 'blocked' && was !== 'blocked') {
      { const line = `Stuck: "${t.title}" (${t.owner || 'unassigned'})${b.note ? ': ' + redact(String(b.note)).slice(0, 200) : ''}`; notify(p, 'stuck', line, { slack: X.slackStuckBlocks(line, t.id) }); }
      for (const n of new Set([t.owner, t.by].filter(Boolean))) X.notePerson(p, n, 'stuck', `Stuck: ${t.title}`, b.note ? redact(String(b.note)).slice(0, 300) : `${t.owner || 'Its agent'} couldn't finish it.`, { view: 'tasks', task: t.id });
    }
    if (a.kind === 'human' && b.status && b.status !== was) audit(p, a.name, 'task', `${b.status === 'done' ? 'marked done' : b.status === 'todo' ? 'asked to run again' : 'set to ' + b.status}: ${t.title}`);
    // its Claude names it properly: a few plain words for the outcome (a request to one Claude names its goal too)
    if (b.title && String(b.title).trim()) {
      t.title = String(b.title).replace(/\s+/g, ' ').trim().slice(0, 80);
      const g = t.direct && p.board.goals.find(x => x.id === t.goalId);
      if (g) g.title = t.title;
    }
    if (b.limitHit !== undefined) t.limitHit = !!b.limitHit;
    // what checked the work before it merged: { review: 'ok'|'fixed'|'issues', tests: 'passed'|'failed'|'none', merged }
    if (b.checks && typeof b.checks === 'object') t.checks = { ...(t.checks || {}), ...b.checks };
    if (b.note) t.notes = [...(t.notes || []), { by: a.name, at: now(), text: String(b.note).slice(0, 2000) }].slice(-20);
    t.updated = now();
    goalDone(p, t);
    boardChanged(p, 'task-update', { task: t }, a);
    return { ok: true, task: t };
  },

  'POST activity': (p, b) => {
    const a = p.touch(b.agent);
    const cap = (p.projectSettings || {}).maxSharing || 'full';
    const items = (Array.isArray(b.items) ? b.items : []).slice(0, 50).filter(it => cap === 'full' || (cap === 'tools' && (it.kind === 'tool' || it.kind === 'end'))).map(it => ({
      kind: ['prompt', 'text', 'tool', 'end'].includes(it.kind) ? it.kind : 'text',
      text: redact(String(it.text || '').slice(0, ACTIVITY_TEXT)),
      tool: it.tool ? String(it.tool).slice(0, 80) : undefined,
      bg: a.clone ? true : undefined,   // from a background Claude doing a request, not the person's own session
      at: now(), agent: a.id, name: a.name,
    })).filter(it => it.text || it.kind === 'end');
    // what background Claudes ran is kept apart from the feed, so it can't be scrolled away or turned off
    for (const it of items) if (it.bg && it.kind === 'tool' && /^(Bash|exec_command|shell)$/i.test(it.tool || '')) audit(p, a.name, 'command', it.text.replace(/^\w+:\s*/, ''), { bg: true, agent: a.clone ? String(a.clone).slice(0, 80) : null });
    if (!items.length) return { ok: true };
    p.activity.push(...items);
    if (p.activity.length > MAX_ACTIVITY) p.activity.splice(0, p.activity.length - MAX_ACTIVITY);
    p.activityChanged = true;
    p.emit('activity', { agent: p.publicAgent(a), items });
    return { ok: true };
  },
  // usage counts from each person's hooks at the end of a turn: numbers only, never content
  'POST stats': (p, b) => {
    const a = p.touch(b.agent);
    if (a.transient) return { ok: true };
    const n = (v, max) => Math.max(0, Math.min(Number(v) || 0, max));
    const add = {
      conversations: b.conversation && !b.request ? 1 : 0,
      requests: b.conversation && b.request ? 1 : 0,
      turns: n(b.turns, 1), activeMs: n(b.activeMs, 4 * 3600 * 1000),
      requestMs: b.request ? n(b.activeMs, 4 * 3600 * 1000) : 0,
      models: {},
    };
    for (const [model, u] of Object.entries(b.usage && typeof b.usage === 'object' ? b.usage : {}).slice(0, 5)) {
      if (!u || typeof u !== 'object') continue;
      add.models[String(model).slice(0, 60)] = { input: n(u.input, 5e7), output: n(u.output, 5e7), cacheRead: n(u.cacheRead, 5e8),
        cacheWrite: n(u.cacheWrite, 5e8), messages: n(u.messages, 1e4) };
    }
    const day = new Date().toISOString().slice(0, 10);
    // what it would cost at API prices, for the day and for the task a background run was doing
    add.cost = X.chargeUsage(p, a.name, add.models, b.task ? String(b.task).slice(0, 16) : null);
    p.stats = p.stats || {};
    p.stats[a.name] = addStats(p.stats[a.name] || newStats(), { ...add, days: { [day]: { ...dayOf(add), cost: add.cost } } });
    p.emit('stats', { name: a.name });
    return { ok: true };
  },
  'GET stats': (p) => ({ stats: p.stats || {}, since: Math.min(...Object.values(p.stats || {}).map(s => s.since || now()), now()) }),
  'GET activity': (p, b, q) => {
    const who = q.get('agent');
    const limit = Math.min(Number(q.get('limit') || 200), MAX_ACTIVITY);
    const mine = who ? p.activity.filter(it => it.agent === who || it.name === who) : p.activity;
    return { activity: mine.slice(-limit) };
  },
  // the project brief; base_version guards against overwriting someone else's edit
  'POST doc': (p, b) => {
    const a = p.touch(b.agent);
    const text = String(b.text == null ? '' : b.text);
    if (Buffer.byteLength(text) > DOC_BYTES) throw httpError(413, 'PROJECT.md is limited to 64 KB');
    const cur = p.shared.doc;
    if (!b.force && b.baseVersion !== undefined && (cur ? cur.version : 0) !== b.baseVersion) {
      throw httpError(409, `PROJECT.md changed since you read it (now v${cur ? cur.version : 0} by ${cur ? cur.byName : '?'}); read it again and reapply your change`);
    }
    const prev = cur ? cur.text : '';
    p.shared.doc = { text, version: (cur ? cur.version : 0) + 1, by: a.id, byName: a.name, at: now() };
    p.changeShared('doc', 'update', { docVersion: p.shared.doc.version, summary: diffSummary(prev, text) }, a);
    return { ok: true, version: p.shared.doc.version };
  },
  'POST memory': (p, b) => {
    const a = p.touch(b.agent);
    const title = String(b.title || '').trim().slice(0, 120);
    const text = String(b.text || '').trim();
    if (!title || !text) throw httpError(400, 'title and text required');
    if (Buffer.byteLength(text) > MEMORY_BYTES) throw httpError(413, 'keep a memory under 4 KB; split it or put details in PROJECT.md');
    const list = p.shared.memories;
    let m = b.id ? list.find(x => x.id === b.id) : list.find(x => x.title.toLowerCase() === title.toLowerCase());
    const action = m ? 'update' : 'add';
    if (!m) {
      if (list.length >= MAX_MEMORIES) throw httpError(413, 'too many memories; forget some first');
      m = { id: crypto.randomBytes(4).toString('hex'), created: now() };
      list.push(m);
    }
    Object.assign(m, { title, text, by: a.id, byName: a.name, at: now() });
    p.changeShared('memory', action, { id: m.id, title, text }, a);
    return { ok: true, id: m.id, action };
  },
  'POST forget': (p, b) => {
    const a = p.touch(b.agent);
    const i = p.shared.memories.findIndex(x => x.id === b.id || x.title.toLowerCase() === String(b.id || '').toLowerCase());
    if (i < 0) throw httpError(404, 'no such memory');
    const [m] = p.shared.memories.splice(i, 1);
    p.changeShared('memory', 'delete', { id: m.id, title: m.title }, a);
    return { ok: true };
  },
  // a skill is a whole SKILL.md (frontmatter + instructions), synced into .claude/skills/
  'POST skill': (p, b) => {
    const a = p.touch(b.agent);
    const name = String(b.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
    if (!name) throw httpError(400, 'skill name required');
    let body = String(b.body || '');
    if (Buffer.byteLength(body) > DOC_BYTES) throw httpError(413, 'a skill is limited to 64 KB');
    const fm = parseFrontmatter(body);
    const description = String(b.description || fm.description || '').trim().slice(0, 1000);
    if (!description) throw httpError(400, 'a skill needs a description saying when to use it');
    if (!fm.name) body = `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\n---\n\n${body.trim()}\n`;
    const list = p.shared.skills;
    let sk = list.find(x => x.name === name);
    const action = sk ? 'update' : 'add';
    if (!sk) {
      if (list.length >= MAX_SKILLS) throw httpError(413, 'too many shared skills');
      sk = { name, version: 0 };
      list.push(sk);
    }
    Object.assign(sk, { description, body, version: sk.version + 1, by: a.id, byName: a.name, at: now() });
    p.changeShared('skill', action, { name, description }, a);
    return { ok: true, name, version: sk.version };
  },
  'POST skill-delete': (p, b) => {
    const a = p.touch(b.agent);
    const i = p.shared.skills.findIndex(x => x.name === b.name);
    if (i < 0) throw httpError(404, 'no such skill');
    p.shared.skills.splice(i, 1);
    p.changeShared('skill', 'delete', { name: b.name }, a);
    return { ok: true };
  },
  'POST wait-unlock': async (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const fp = normPath(b.path);
    const dir = /[\\/]$/.test(String(b.path || ''));
    const blocker = () => blockingLock(p, a.id, b.branch || null, fp, dir);
    if (blocker()) await ctx.waitFor(ev => ev.type === 'unlock' && !blocker(), (b.timeout || 300) * 1000);
    return { free: !blocker(), lock: blocker() };
  },
  // long-poll; servers stream the same events over SSE / WebSocket themselves
  'GET events': async (p, b, q, ctx) => {
    const since = Number(q.get('since') || 0);
    const pending = () => p.eventsSince(since);
    let evs = pending();
    const wait = Number(q.get('wait') || 0);
    if (evs && !evs.length && wait > 0) { await ctx.waitFor(() => true, wait * 1000); evs = pending(); }
    return { events: evs || [], seq: p.seq, truncated: !evs };
  },
};

// One person's usage totals, plus daily buckets for the last STATS_DAYS days.
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'messages'];
function newStats() {
  return { since: now(), last: 0, conversations: 0, requests: 0, turns: 0, activeMs: 0, requestMs: 0, models: {}, days: {} };
}
function dayOf(s) {
  const tokens = Object.values(s.models || {}).reduce((t, u) => t + u.input + u.output + u.cacheRead + u.cacheWrite, 0);
  const output = Object.values(s.models || {}).reduce((t, u) => t + u.output, 0);
  return { conversations: s.conversations || 0, turns: s.turns || 0, activeMs: s.activeMs || 0, tokens, output, cost: s.cost || 0 };
}
function addStats(into, add) {
  for (const k of ['conversations', 'requests', 'turns', 'activeMs', 'requestMs']) into[k] = (into[k] || 0) + (add[k] || 0);
  for (const [m, u] of Object.entries(add.models || {})) {
    if (!into.models[m] && Object.keys(into.models).length >= STATS_MODELS) continue;
    const t = into.models[m] || (into.models[m] = Object.fromEntries(TOKEN_KEYS.map(k => [k, 0])));
    for (const k of TOKEN_KEYS) t[k] += u[k] || 0;
  }
  for (const [d, v] of Object.entries(add.days || {})) {
    const t = into.days[d] || (into.days[d] = { conversations: 0, turns: 0, activeMs: 0, tokens: 0, output: 0, cost: 0 });
    for (const k of ['conversations', 'turns', 'activeMs', 'tokens', 'output', 'cost']) t[k] = (t[k] || 0) + (v[k] || 0);
  }
  const keep = Object.keys(into.days).sort().slice(-STATS_DAYS);
  into.days = Object.fromEntries(keep.map(d => [d, into.days[d]]));
  into.since = Math.min(into.since || now(), add.since || now());
  into.last = Math.max(into.last || 0, add.last || now());
  return into;
}

// A Claude session running an older huddle than the newest one on the team (or one that doesn't know
// its version, from an old `npx … join`) can miss whole features, like background work. Its Claude is
// told once per newer version, through the inbox every huddle version reads, to have its person update.
function nudgeUpdate(p, a) {
  if (a.kind === 'human' || a.clone) return;
  const newest = Object.values(p.agents).filter(x => x.build && x.build.at && p.online(x)).sort((x, y) => y.build.at - x.build.at)[0];
  if (!newest || (a.build && a.build.at && a.build.at >= newest.build.at - 60 * 1000)) return;
  p.nudged = p.nudged || {};
  if (p.nudged[a.name] === newest.build.sha) return;
  p.nudged[a.name] = newest.build.sha;
  const m = { id: crypto.randomBytes(6).toString('hex'), from: 'huddle', fromName: 'huddle', to: a.name, auto: true, at: now(),
    text: `huddle on ${a.name}'s computer is out of date, so some team features (like background work for the team's requests) don't run there. ` +
      `Ask ${a.name} to run \`npx -y github:flyingf15h/huddle update\` in a terminal and then restart Claude Code. Don't run it yourself unless ${a.name} says to.` };
  p.messages.push(m);
  if (p.messages.length > MAX_MESSAGES) p.messages.splice(0, p.messages.length - MAX_MESSAGES);
  m.seq = p.emit('message', { message: m }).seq;
}

// two names are the same person: fold `from` into `into` everywhere, and keep it that way
function mergePerson(p, from, into) {
  p.aliases = p.aliases || {};
  for (const [k, v] of Object.entries(p.aliases)) if (v === from) p.aliases[k] = into;
  p.aliases[from] = into;
  const fix = (o, k) => { if (o && o[k] === from) o[k] = into; };
  for (const a of Object.values(p.agents)) fix(a, 'name');
  for (const m of p.messages) { fix(m, 'fromName'); fix(m, 'to'); }
  for (const it of p.activity) fix(it, 'name');
  for (const w of p.worklog || []) fix(w, 'name');
  for (const h of p.handoffs || []) fix(h, 'name');
  for (const g of p.board.goals) { fix(g, 'byName'); fix(g, 'to'); fix(g, 'planner'); }
  for (const t of p.board.tasks) { fix(t, 'owner'); fix(t, 'by'); for (const n of t.notes || []) fix(n, 'by'); }
  for (const l of Object.values(p.locks)) fix(l, 'holderName');
  for (const f of Object.values(p.files)) fix(f, 'byName');
  for (const m of p.shared.memories) fix(m, 'byName');
  if (p.settings && p.settings[from]) { p.settings[into] = p.settings[into] || p.settings[from]; delete p.settings[from]; }
  if (p.stats && p.stats[from]) { p.stats[into] = addStats(p.stats[into] || newStats(), p.stats[from]); delete p.stats[from]; }
  if (p.keys && p.keys[from]) { p.keys[into] = p.keys[into] || p.keys[from]; delete p.keys[from]; }
  // an account follows its person's new name (their token keeps working)
  if (p.members && p.members[from] && !p.members[into]) { p.members[into] = p.members[from]; delete p.members[from]; }
  p.activityChanged = p.sharedChanged = true;
  p.board.version++;
  p.emit('merge', { from, into });
}

function pushTask(p, t, a) {
  const title = String(t.title || '').trim().slice(0, 200);
  if (!title) throw httpError(400, 'every task needs a title');
  if (p.board.tasks.length >= MAX_TASKS) p.board.tasks.splice(0, p.board.tasks.findIndex(x => x.status === 'done') + 1 || 1);
  const task = { id: crypto.randomBytes(4).toString('hex'), goalId: t.goalId, title, detail: String(t.detail || '').slice(0, 6000),
    owner: t.owner || null, status: 'todo', by: a.name, at: now(), updated: now(), after: Array.isArray(t.after) ? t.after.slice(0, 10) : [],
    direct: !!t.direct, effort: EFFORT[t.effort] ? t.effort : null,
    // the files or folders ("src/ui/") it works in: locked for whoever runs it, from the start
    paths: (Array.isArray(t.paths) ? t.paths : []).map(x => String(x).trim()).filter(Boolean).slice(0, 10) };
  p.board.tasks.push(task);
  return task;
}

// Who gets each task a plan sized but left unassigned. Heavier tasks go first, each to whoever has the most of
// their Claude plan's 5-hour window left after what they've been handed already (a rough guess of
// what each size of task uses). Only Claudes that start on their own (active) and the planner are
// picked, unless nobody is.
const EFFORT = { light: 5, medium: 12, heavy: 25 };
function assignByUsage(p, tasks, planner, exclude) {
  const runners = new Set(), online = new Set(planner ? [planner] : []);
  for (const a of Object.values(p.agents)) {
    if (!p.online(a) || a.clone || !['agent', 'autopilot'].includes(a.kind)) continue;
    online.add(a.name);
    if (a.runner === 'full') runners.add(a.name);
  }
  let team = [...new Set([planner, ...runners])].filter(n => n && n !== exclude);
  if (team.length < 2) team = [...online].filter(n => n !== exclude);
  if (!team.length) return tasks.map(t => t.owner || null);
  const left = (n) => {
    const u = (p.usage || {})[n];
    return u && now() - u.at < 6 * 3600 * 1000 && typeof u.five === 'number' ? Math.max(2, 100 - u.five) : 50;
  };
  const roomy = team.filter(n => left(n) > 10);
  if (roomy.length) team = roomy;
  const load = Object.fromEntries(team.map(n => [n, 0]));
  const owners = tasks.map(t => (t.owner ? personFor(p, t.owner) || String(t.owner) : null));
  // (a task with no effort and no owner stays open for whoever takes it)
  const order = tasks.map((t, i) => i).filter(i => !owners[i] && EFFORT[tasks[i].effort]).sort((x, y) => (EFFORT[tasks[y].effort] || EFFORT.medium) - (EFFORT[tasks[x].effort] || EFFORT.medium));
  const cost = (t) => EFFORT[t.effort] || EFFORT.medium;
  tasks.forEach((t, i) => { if (owners[i] && load[owners[i]] !== undefined) load[owners[i]] += cost(t); });
  for (const i of order) {
    const best = team.slice().sort((x, y) => (left(y) - load[y]) - (left(x) - load[x]) || load[x] - load[y])[0];
    owners[i] = best;
    load[best] += cost(tasks[i]);
  }
  return owners;
}

function goalDone(p, t) {
  const g = p.board.goals.find(x => x.id === t.goalId);
  if (g && g.status !== 'done' && p.board.tasks.filter(x => x.goalId === g.id).every(x => x.status === 'done')) {
    g.status = 'done';
    notify(p, 'done', `Done: ${g.title || requestTitle(g.text)} (asked by ${g.byName})`);
    X.githubDone(p, g, t);
    X.notePerson(p, g.byName, 'done', `Done: ${g.title || requestTitle(g.text)}`, t.notes && t.notes.length ? t.notes[t.notes.length - 1].text : 'Every task in it is finished.', { view: 'tasks', task: t.id });
  }
}

function boardChanged(p, action, info, a) {
  p.board.version++;
  p.boardChanged = true;
  p.emit('board', { action, byName: a.name, version: p.board.version, ...info });
}

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (m) for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// "+3 -1 lines" style summary so other agents know roughly what changed
function diffSummary(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  let i = 0, j = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  while (j < x.length - i && j < y.length - i && x[x.length - 1 - j] === y[y.length - 1 - j]) j++;
  const added = y.slice(i, y.length - j).filter(l => l.trim());
  const removed = x.length - i - j;
  return { added: y.length - i - j, removed, firstAdded: added.slice(0, 6).join('\n').slice(0, 600) };
}

// ---------- accounts: who may do what ----------
// A project starts with one shared token (the invite everyone joined with). Its first owner sets up
// accounts: everyone then gets a token of their own from a personal invite, with a role, that the
// owner can take back at any time. Until then whoever holds the shared token can do everything, as
// before; afterwards the shared token is a member (or switched off by the owner).
const ROLES = ['owner', 'member', 'viewer'];
const MAX_AUDIT = 500;
const MAX_PROBLEMS = 100;
const OWNER_ROUTES = new Set(['POST member-role', 'POST member-remove', 'POST invite-revoke', 'GET invites', 'POST project-setting',
  'POST notify-set', 'POST notify-test', 'POST policy', 'POST merge-person', 'POST tidy', 'POST forget-agent',
  'POST cost-settings', 'POST slack-setup', 'POST automation-set', 'POST trigger-settings', 'POST digest-settings', 'POST digest-now', 'POST retention', 'POST delete-project', 'POST repo-connect', 'POST repo-disconnect', 'GET export']);
// a viewer reads everything (dashboard, feed, code) and changes nothing
const VIEWER_POSTS = new Set(['hello', 'inbox', 'link-github', 'link-account', 'redeem', 'leave', 'notes-read', 'note-prefs', 'erase-me']);
// GitHub's webhook proves itself with a signature the route checks; a personal invite is its own proof
const NO_AUTH_ROUTES = new Set(['POST redeem', 'POST github-webhook', 'POST slack-command', 'POST slack-interact']);
const hasOwner = (p) => Object.values(p.members || {}).some(m => m.role === 'owner');
const newMemberToken = () => 'hm_' + crypto.randomBytes(24).toString('base64url');

// who's asking, from what the server checked: { kind: 'admin' | 'project' | 'member' | 'github' | 'none', token, github }
function authorize(p, cred = {}) {
  const ps = p.projectSettings || {};
  if (cred.kind === 'admin') return { role: 'owner', name: null, via: 'admin' };
  if (cred.kind === 'member' || cred.kind === 'github' || cred.kind === 'user') {
    const h = cred.kind === 'member' ? sha('member:' + cred.token) : null;
    const lower = (x) => String(x || '').toLowerCase();
    const hit = Object.entries(p.members || {}).find(([, m]) => (h && m.tokenHash === h) ||
      (!h && ((cred.user && m.user === cred.user) || (cred.github && m.github && lower(m.github) === lower(cred.github)) || (cred.email && m.email && lower(m.email) === lower(cred.email)))));
    if (!hit) throw httpError(401, cred.kind === 'member' ? 'this invite was taken back or is no longer valid; ask the project owner for a new one' : 'your account is not on this project; open it once with an invite and link your account');
    const [name, m] = hit;
    if (now() - (m.lastSeen || 0) > 60 * 1000) { m.lastSeen = now(); p.dirty = true; }
    return { role: m.role, name, via: cred.kind, github: cred.github || m.github || null };
  }
  if (cred.kind === 'project') {
    if (ps.sharedToken === false) throw httpError(401, 'this project only takes personal invites now; ask the owner for one');
    return { role: hasOwner(p) ? 'member' : 'owner', name: null, via: 'project', github: cred.github || null };
  }
  return { role: 'none', name: null, via: 'none' };
}

// every route goes through here, on both servers: the caller's role decides what they may do, and a
// personal token always speaks as its own person, whatever name the request carries
async function dispatch(p, method, ep, body, q, ctx, cred) {
  const key = `${method} ${ep}`;
  const route = routes[key];
  if (!route) throw httpError(404, 'no such endpoint');
  const auth = authorize(p, cred);
  if (auth.role === 'none' && !NO_AUTH_ROUTES.has(key)) throw httpError(401, 'bad token or no such project');
  if (auth.role === 'viewer' && method !== 'GET' && !VIEWER_POSTS.has(ep)) throw httpError(403, 'you can view this project but not change it');
  if (auth.role === 'viewer' && key === 'GET audit') throw httpError(403, 'viewers cannot see the audit log');
  if (auth.role !== 'owner' && OWNER_ROUTES.has(key)) throw httpError(403, 'only the project owner can do that');
  // once there are accounts, the shared invite only goes to owners; everyone else makes personal ones
  if (key === 'POST invite-code' && hasOwner(p) && auth.role !== 'owner') throw httpError(403, 'this project uses personal invites: huddle members invite, or Invite people on the dashboard');
  if (auth.name && body && body.agent && typeof body.agent === 'object') {
    // and only as its own sessions: an id that belongs to someone else's session gets one of its own
    const id = String(body.agent.id || '');
    const held = p.agents[id];
    body.agent = { ...body.agent, name: auth.name, ...(held && held.name !== auth.name ? { id: `${auth.name}#${sha('as:' + id).slice(0, 6)}` } : {}) };
  }
  ctx.auth = auth;
  ctx.cred = cred;
  return route(p, body, q, ctx);
}

function audit(p, by, action, detail, extra) {
  p.audit = p.audit || [];
  const e = { at: now(), by: by || 'someone', action, detail: String(detail || '').slice(0, 500), ...(extra || {}) };
  p.audit.push(e);
  if (p.audit.length > MAX_AUDIT) p.audit.splice(0, p.audit.length - MAX_AUDIT);
  p.auditChanged = true;
  p.dirty = true;
  return e;
}

function publicMembers(p) {
  return Object.entries(p.members || {}).map(([name, m]) => ({ name, role: m.role, at: m.at, by: m.by, github: m.github || null, lastSeen: m.lastSeen || null }));
}
function inviteCodeFor(p) {
  let code;
  do code = shortInviteCode(); while (Object.values(p.invites || {}).some(i => i.codeHash === sha('invite:' + code)));
  return code;
}
function liveInvites(p) {
  return Object.values(p.invites || {}).filter(i => !i.revoked && i.expires > now() && i.uses < i.maxUses);
}

// ---------- notifications: Slack, Discord or any webhook ----------
// The URLs are secrets (anyone with one can post to the channel), so they live apart from the
// settings everyone can read; the team only sees which kinds are set up and for what.
const NOTIFY_EVENTS = ['approval', 'stuck', 'done', 'failed', 'member', 'budget', 'cost', 'digest'];
function notify(p, event, text, extra) {
  const hooks = (p.secretHooks || []).filter(h => !h.events || h.events.includes(event));
  if (!hooks.length) return;
  const link = p.origin ? `${p.origin}/app#p=${encodeURIComponent(p.name)}` : '';
  const title = p.name.replace(/-[0-9a-f]{6,8}$/, '');
  for (const h of hooks) {
    const line = `[${title}] ${text}${link ? `\n${link}` : ''}`;
    const body = h.kind === 'slack' ? { text: line, ...(extra && extra.slack ? { blocks: extra.slack } : {}) } : h.kind === 'discord' ? { content: line.slice(0, 1900), username: 'huddle' }
      : { event, project: p.name, text, link, at: now() };
    p.outbox = p.outbox || [];
    p.outbox.push({ url: h.url, body, hook: h.id });
    if (p.outbox.length > 50) p.outbox.shift();
  }
}
// what the server should send now (it posts them after answering)
function takeOutbox(p) { const o = p.outbox || []; p.outbox = []; return o; }
function hookLabel(url) {
  try { const u = new URL(url); return `${u.host}/…${url.slice(-4)}`; } catch { return 'webhook'; }
}
function kindOf(url) { return /hooks\.slack\.com/.test(url) ? 'slack' : /discord(app)?\.com\/api\/webhooks/.test(url) ? 'discord' : 'generic'; }

function problem(p, a, kind, message, extra = {}) {
  p.problems = p.problems || [];
  const x = { id: crypto.randomBytes(4).toString('hex'), at: now(), name: a ? a.name : 'huddle', kind: String(kind || 'error').slice(0, 40),
    message: redact(String(message || '').slice(0, 500)), detail: redact(String(extra.detail || '').slice(-2000)), taskId: extra.taskId || null };
  p.problems.push(x);
  if (p.problems.length > MAX_PROBLEMS) p.problems.splice(0, p.problems.length - MAX_PROBLEMS);
  p.problemsChanged = true;
  p.emit('problem', { problem: x });
  notify(p, 'failed', `${x.name}: ${x.message}`);
  return x;
}

Object.assign(routes, {
  'GET whoami': (p, b, q, ctx) => {
    const auth = ctx.auth || {};
    return { name: auth.name, role: auth.role, via: auth.via, github: auth.github || null, accounts: hasOwner(p),
      sharedToken: (p.projectSettings || {}).sharedToken !== false, membersCanInvite: (p.projectSettings || {}).membersCanInvite !== false };
  },
  // the first owner: whoever holds the shared token sets up accounts and gets a token of their own
  'POST setup-owner': (p, b, q, ctx) => {
    if (hasOwner(p)) throw httpError(409, 'this project already has an owner');
    const a = p.touch(b.agent);
    if (a.transient) throw httpError(400, 'pick a name first');
    const token = newMemberToken();
    p.members = p.members || {};
    p.members[a.name] = { role: 'owner', tokenHash: sha('member:' + token), at: now(), by: a.name, github: ctx.auth && ctx.auth.github || null };
    audit(p, a.name, 'owner', `${a.name} set up accounts and became the owner`);
    p.emit('members', { members: publicMembers(p) });
    return { ok: true, token, name: a.name, role: 'owner' };
  },
  'GET members': (p) => ({ members: publicMembers(p), invites: [] }),
  'GET invites': (p) => ({ invites: liveInvites(p).map(({ codeHash, ...i }) => i) }),
  // a personal invite: one person (or `uses` people), one role, for `days` days
  'POST member-invite': (p, b, q, ctx) => {
    const a = p.touch(b.agent);
    const auth = ctx.auth || {};
    if (!hasOwner(p)) throw httpError(409, 'set up accounts first (the owner runs `huddle members setup`, or uses Team & access on the dashboard)');
    const role = ROLES.includes(b.role) ? b.role : 'member';
    if (auth.role !== 'owner' && (role === 'owner' || (p.projectSettings || {}).membersCanInvite === false)) throw httpError(403, 'only the project owner can invite people');
    const code = inviteCodeFor(p);
    const inv = { id: crypto.randomBytes(4).toString('hex'), codeHash: sha('invite:' + code), role, by: a.name, at: now(),
      expires: now() + Math.min(Math.max(Number(b.days) || 7, 1), 30) * 86400000, uses: 0, maxUses: Math.min(Math.max(Number(b.uses) || 1, 1), 50),
      note: String(b.note || '').slice(0, 80) };
    p.invites = p.invites || {};
    p.invites[inv.id] = inv;
    for (const [id, i] of Object.entries(p.invites)) if (i.expires < now() - 7 * 86400000) delete p.invites[id];
    audit(p, a.name, 'invite', `invited ${inv.maxUses === 1 ? 'one person' : inv.maxUses + ' people'} as ${role}${inv.note ? ` (${inv.note})` : ''}`);
    p.dirty = true;
    return { ok: true, code, invite: { id: inv.id, role, expires: inv.expires, maxUses: inv.maxUses }, inviteCode: code };
  },
  'POST invite-revoke': (p, b) => {
    const a = p.touch(b.agent);
    const inv = (p.invites || {})[b.id];
    if (!inv) throw httpError(404, 'no such invite');
    inv.revoked = true;
    audit(p, a.name, 'invite-revoke', `took back an invite (${inv.role}, made by ${inv.by})`);
    return { ok: true };
  },
  // a personal invite becomes the person's own token
  'POST redeem': (p, b) => {
    const code = String(b.code || '').trim();
    const inv = Object.values(p.invites || {}).find(i => i.codeHash === sha('invite:' + code));
    if (!inv || inv.revoked) throw httpError(404, 'that invite was taken back or never existed');
    if (inv.expires < now()) throw httpError(410, 'that invite has expired; ask for a new one');
    if (inv.uses >= inv.maxUses) throw httpError(410, 'that invite has been used already; ask for a new one');
    const name = String(b.name || '').trim().replace(/[#\s]+/g, '-').slice(0, 40);
    if (!name) throw httpError(400, 'what should the team call you?');
    p.members = p.members || {};
    const taken = Object.keys(p.members).find(n => n.toLowerCase() === name.toLowerCase());
    if (taken) throw httpError(409, `"${taken}" is already on this project; pick another name`);
    const token = newMemberToken();
    p.members[name] = { role: inv.role, tokenHash: sha('member:' + token), at: now(), by: inv.by };
    inv.uses++;
    audit(p, name, 'join', `joined as ${inv.role} with ${inv.by}'s invite`);
    notify(p, 'member', `${name} joined as ${inv.role}`);
    p.emit('members', { members: publicMembers(p) });
    return { ok: true, token, name, role: inv.role, project: p.name };
  },
  'POST member-role': (p, b) => {
    const a = p.touch(b.agent);
    const m = (p.members || {})[b.name];
    if (!m) throw httpError(404, 'no such member');
    if (!ROLES.includes(b.role)) throw httpError(400, 'role must be owner, member or viewer');
    if (m.role === 'owner' && b.role !== 'owner' && Object.values(p.members).filter(x => x.role === 'owner').length < 2) throw httpError(409, 'a project needs at least one owner');
    audit(p, a.name, 'role', `${b.name}: ${m.role} → ${b.role}`);
    m.role = b.role;
    p.emit('members', { members: publicMembers(p) });
    return { ok: true, members: publicMembers(p) };
  },
  // their token stops working at once; their locks go, their open sessions are disconnected
  'POST member-remove': (p, b) => {
    const a = p.touch(b.agent);
    const m = (p.members || {})[b.name];
    if (!m) throw httpError(404, 'no such member');
    if (m.role === 'owner' && Object.values(p.members).filter(x => x.role === 'owner').length < 2) throw httpError(409, "you can't remove the last owner");
    delete p.members[b.name];
    for (const [k, l] of Object.entries(p.locks)) if (l.holderName === b.name) { delete p.locks[k]; p.emit('unlock', { path: l.path, holder: l.holder, holderName: l.holderName, reason: 'removed from the project' }); }
    audit(p, a.name, 'remove', `removed ${b.name} (${m.role})`);
    p.emit('members', { members: publicMembers(p), removed: b.name });
    return { ok: true };
  },
  // leaving on your own: your personal access ends (with no accounts there's nothing to end here;
  // the browser just stops listing the project)
  'POST leave': (p, b, q, ctx) => {
    const name = (ctx.auth || {}).name;
    if (!name || !(p.members || {})[name]) return { ok: true, accountRemoved: false };
    const m = p.members[name];
    if (m.role === 'owner' && Object.values(p.members).filter(x => x.role === 'owner').length < 2 && Object.keys(p.members).length > 1) throw httpError(409, 'make someone else an owner first, so the project still has one');
    delete p.members[name];
    for (const [k, l] of Object.entries(p.locks)) if (l.holderName === name) { delete p.locks[k]; p.emit('unlock', { path: l.path, holder: l.holder, holderName: l.holderName, reason: 'left the project' }); }
    audit(p, name, 'remove', `${name} left the project`);
    p.emit('members', { members: publicMembers(p) });
    return { ok: true, accountRemoved: true };
  },
  // a person signed in with GitHub on the dashboard can open the project with that from then on
  'POST link-github': (p, b, q, ctx) => {
    const auth = ctx.auth || {};
    if (!auth.github) throw httpError(400, 'sign in with GitHub first');
    if (!auth.name || !(p.members || {})[auth.name]) throw httpError(409, 'link GitHub from your own invite (set up accounts first)');
    p.members[auth.name].github = auth.github;
    audit(p, auth.name, 'github', `linked GitHub account ${auth.github}`);
    p.emit('members', { members: publicMembers(p) });
    return { ok: true, linked: auth.github, name: auth.name, role: p.members[auth.name].role };
  },
  'GET audit': (p, b, q) => {
    const limit = Math.min(Number(q.get('limit')) || 200, MAX_AUDIT);
    return { audit: (p.audit || []).slice(-limit) };
  },
  // a project's rules for every Claude: commands always fine to run in the background, commands
  // never allowed (not even with someone's OK), files that stay private, how much of a session may be shared
  'POST policy': (p, b) => {
    const a = p.touch(b.agent);
    const ps = p.projectSettings = p.projectSettings || {};
    const was = JSON.stringify({ policy: ps.policy, privatePaths: ps.privatePaths, maxSharing: ps.maxSharing });
    if (b.allow !== undefined || b.deny !== undefined) ps.policy = { allow: cleanRules(b.allow !== undefined ? b.allow : (ps.policy || {}).allow), deny: cleanRules(b.deny !== undefined ? b.deny : (ps.policy || {}).deny) };
    if (b.privatePaths !== undefined) ps.privatePaths = b.privatePaths === null ? undefined : cleanRules(b.privatePaths);
    if (b.maxSharing !== undefined) ps.maxSharing = ['full', 'tools', 'off'].includes(b.maxSharing) ? b.maxSharing : 'full';
    const changed = JSON.stringify({ policy: ps.policy, privatePaths: ps.privatePaths, maxSharing: ps.maxSharing });
    if (changed !== was) {
      const pol = ps.policy || {};
      audit(p, a.name, 'policy', `set the project rules. Always allowed: ${(pol.allow || []).join(', ') || 'nothing extra'}. Never allowed: ${(pol.deny || []).join(', ') || 'nothing'}. ` +
        `Private files: ${(ps.privatePaths || ['the defaults']).join(', ')}. Sessions share at most: ${{ full: 'everything', tools: 'steps only', off: 'nothing' }[ps.maxSharing || 'full']}.`);
    }
    p.emit('project-setting', { settings: ps, byName: a.name });
    return { ok: true, settings: ps };
  },
  'POST notify-set': (p, b) => {
    const a = p.touch(b.agent);
    p.secretHooks = p.secretHooks || [];
    if (b.remove) {
      p.secretHooks = p.secretHooks.filter(h => h.id !== b.remove);
      audit(p, a.name, 'notify', 'removed a notification channel');
    } else {
      const url = String(b.url || '').trim();
      if (!/^https:\/\/[^\s]+$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw httpError(400, 'give the https:// webhook URL from Slack, Discord or your own service');
      const events = (Array.isArray(b.events) ? b.events : NOTIFY_EVENTS).filter(e => NOTIFY_EVENTS.includes(e));
      const h = { id: crypto.randomBytes(4).toString('hex'), kind: b.kind && ['slack', 'discord', 'generic'].includes(b.kind) ? b.kind : kindOf(url), url, events, by: a.name, at: now() };
      p.secretHooks.push(h);
      if (p.secretHooks.length > 10) p.secretHooks.shift();
      audit(p, a.name, 'notify', `added a ${h.kind} notification channel for ${events.join(', ')}`);
    }
    const ps = p.projectSettings = p.projectSettings || {};
    ps.notify = p.secretHooks.map(h => ({ id: h.id, kind: h.kind, events: h.events, label: hookLabel(h.url), by: h.by }));
    p.emit('project-setting', { settings: ps, byName: a.name });
    return { ok: true, notify: ps.notify };
  },
  'POST notify-test': (p, b) => {
    const a = p.touch(b.agent);
    if (!(p.secretHooks || []).length) throw httpError(409, 'add a channel first');
    const before = (p.outbox || []).length;
    for (const h of p.secretHooks) {
      const body = h.kind === 'slack' ? { text: `huddle test from ${a.name}: notifications work.` } : h.kind === 'discord' ? { content: `huddle test from ${a.name}: notifications work.`, username: 'huddle' } : { event: 'test', project: p.name, text: 'notifications work', at: now() };
      (p.outbox = p.outbox || []).push({ url: h.url, body, hook: h.id });
    }
    return { ok: true, sent: (p.outbox || []).length - before };
  },
  // something went wrong on someone's machine: a background run crashed, a hook failed, a tool is missing
  'POST problem': (p, b) => {
    const a = p.touch(b.agent);
    const x = problem(p, a, b.kind, b.message, { detail: b.detail, taskId: b.taskId });
    return { ok: true, problem: x };
  },
  'GET problems': (p, b, q) => ({ problems: (p.problems || []).slice(-Math.min(Number(q.get('limit')) || 50, MAX_PROBLEMS)) }),
});

// notifications, search, cost, tasks, data, GitHub and conflicts (features.js)
const X = require('./features')({ httpError, now, audit, hasOwner, boardChanged, pushTask, requestTitle, goalDone, normPath, notify, canonicalName, personFor, publicMembers, taskIdsIn, routes });
Object.assign(routes, X.routes);

function waitOn(p, pred, timeoutMs, onAbort) {
  return new Promise(resolve => {
    const done = (v) => { clearTimeout(timer); p.waiters.delete(w); resolve(v); };
    const w = (ev) => { if (pred(ev)) done(ev); };
    const timer = setTimeout(() => done(null), Math.min(timeoutMs, 10 * 60 * 1000));
    p.waiters.add(w);
    if (onAbort) onAbort(() => done(null));
  });
}

module.exports = { features: X, dispatch, authorize, takeOutbox, notify, audit, hasOwner, NOTIFY_EVENTS, ROLES, needsAPerson, requestTitle, SHORT_INVITE, handOn, assignByUsage, Project, routes, waitOn, parseFrontmatter, fileKey, GIT_CHUNK, sha, now, httpError, sameSecret, normPath, aiLabel, taskIdsIn, blockingLock,
  ONLINE_MS, MAX_FILE_BYTES, OPEN_IDLE_MS, OPEN_MAX_PROJECTS, OPEN_CREATES_PER_HOUR };

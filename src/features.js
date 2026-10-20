// Routes added on top of core.js: per-person notifications (in the app, by email, on the desktop),
// search across the whole project, tasks you can edit, what the agents' tokens cost, a project's
// data (export, retention, deletion), its GitHub repository, and merge conflicts between branches.
// core.js hands in the helpers it shares (audit, notify, the board functions) so both servers get
// the same routes.
'use strict';
const crypto = require('crypto');
const pricing = require('./pricing');
const githost = require('./githost');

const MAX_NOTES = 80;            // per person, newest kept
const NOTE_TEXT = 400;
const MAIL_BATCH_MS = Number((typeof process !== 'undefined' && process.env && process.env.HUDDLE_MAIL_BATCH_MS) || 0) || 2 * 60 * 1000;   // notes for one person within this go out as one email
const REPO_CACHE_MS = 60 * 1000;
const SEARCH_LIMIT = 60;
const SEARCH_CODE_BYTES = 6 * 1024 * 1024;
// what a person is told about, and where by default; each person can change their own
const NOTE_KINDS = {
  message: { label: 'Messages to you', email: false, desktop: true },
  mention: { label: 'Mentions of you', email: true, desktop: true },
  request: { label: 'Requests for your agent', email: true, desktop: true },
  approval: { label: 'Commands waiting for your OK', email: true, desktop: true },
  stuck: { label: 'Your work got stuck', email: true, desktop: true },
  done: { label: 'Your requests finished', email: false, desktop: false },
  conflict: { label: 'Merge conflicts with your branch', email: true, desktop: true },
  ci: { label: 'Checks failing on your pull requests', email: true, desktop: true },
  budget: { label: 'Budget alerts (owners)', email: true, desktop: false },
};

module.exports = function features(h) {
  const { httpError, now, audit, hasOwner, boardChanged, pushTask, requestTitle, goalDone, normPath } = h;
  const id = () => crypto.randomBytes(4).toString('hex');
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const prettyProject = (p) => p.name.replace(/-[0-9a-f]{6,8}$/, '');
  const people = (p) => [...new Set([...Object.values(p.agents).map(a => a.name), ...Object.keys(p.settings || {}), ...Object.keys(p.members || {})])].filter(n => n && !/^(human|guest)$/.test(n));

  // ---------- notifications ----------
  function prefsOf(p, name) {
    const mine = ((p.notePrefs || {})[name]) || {};
    const out = {};
    for (const [k, d] of Object.entries(NOTE_KINDS)) out[k] = { app: true, email: mine[k] && mine[k].email !== undefined ? !!mine[k].email : d.email, desktop: mine[k] && mine[k].desktop !== undefined ? !!mine[k].desktop : d.desktop };
    return out;
  }
  // tell one person about something; their notification list, then email (batched) and the desktop
  // alert their own huddle shows, as they chose
  function notePerson(p, to, kind, title, body, link) {
    if (!to || !NOTE_KINDS[kind]) return null;
    to = h.canonicalName(p, to);
    p.notes = p.notes || {};
    const list = p.notes[to] = p.notes[to] || [];
    const n = { id: id(), at: now(), kind, title: clip(title, 140), body: clip(body, NOTE_TEXT), link: link || null, read: false };
    list.push(n);
    if (list.length > MAX_NOTES) list.splice(0, list.length - MAX_NOTES);
    const prefs = prefsOf(p, to)[kind];
    n.desktop = !!prefs.desktop;
    p.emit('note', { to, note: n });
    const contact = (p.contacts || {})[to];
    if (prefs.email && contact && contact.email && contact.emailNotes !== false) {
      p.mailQueue = p.mailQueue || {};
      (p.mailQueue[to] = p.mailQueue[to] || []).push(n);
    }
    p.dirty = true;
    return n;
  }
  // after a short wait, one email per person with everything that came up
  function flushMail(p, force) {
    for (const [to, items] of Object.entries(p.mailQueue || {})) {
      const contact = (p.contacts || {})[to];
      if (!items.length || !contact || !contact.email) { delete p.mailQueue[to]; continue; }
      if (!force && now() - items[0].at < MAIL_BATCH_MS) continue;
      // anything they already read in the dashboard doesn't need an email
      const unread = items.filter(n => { const cur = ((p.notes || {})[to] || []).find(x => x.id === n.id); return !cur || !cur.read; });
      delete p.mailQueue[to];
      if (!unread.length) continue;
      const link = p.origin ? `${p.origin}/app#p=${encodeURIComponent(p.name)}` : '';
      const subject = unread.length === 1 ? `[${prettyProject(p)}] ${unread[0].title}` : `[${prettyProject(p)}] ${unread.length} things need you`;
      const text = unread.map(n => `${n.title}\n${n.body}`).join('\n\n') + (link ? `\n\nOpen the project: ${link}` : '') + '\n\nChange what you get emailed about in the project, under your notification settings.';
      const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#0d1a33;max-width:560px">${unread.map(n => `<p style="margin:0 0 14px"><b>${esc(n.title)}</b><br><span style="color:#42537a">${esc(n.body)}</span></p>`).join('')}${link ? `<p><a href="${esc(link)}" style="background:#2a5fe0;color:#fff;padding:9px 14px;border-radius:8px;text-decoration:none;font-weight:600">Open ${esc(prettyProject(p))}</a></p>` : ''}<p style="color:#5a6a8e;font-size:12px">You can change what you get emailed about in the project's notification settings.</p></div>`;
      (p.outbox = p.outbox || []).push({ email: { to: contact.email, subject, text, html } });
    }
  }

  // ---------- cost ----------
  const monthKey = (t = now()) => new Date(t).toISOString().slice(0, 7);
  function monthSpend(p, month = monthKey()) {
    let total = 0;
    for (const s of Object.values(p.stats || {})) for (const [d, v] of Object.entries(s.days || {})) if (d.startsWith(month)) total += v.cost || 0;
    return total;
  }
  // after usage comes in: the task it was for, and the owners told when the month's budget runs low
  function chargeUsage(p, name, models, taskId) {
    const prices = (p.projectSettings || {}).prices;
    const { total } = pricing.costOfModels(models, prices);
    const tokens = Object.values(models).reduce((t, u) => t + (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0), 0);
    if (taskId) {
      const t = p.board.tasks.find(x => x.id === taskId);
      if (t) {
        t.usage = { tokens: (t.usage ? t.usage.tokens : 0) + tokens, cost: (t.usage ? t.usage.cost : 0) + total, by: { ...(t.usage && t.usage.by || {}), [name]: ((t.usage && t.usage.by || {})[name] || 0) + total } };
        p.boardChanged = true;
      }
    }
    const b = (p.projectSettings || {}).budget;
    if (b && b.monthly > 0 && total > 0) {
      // (called before this usage is added to the person's stats)
      const before = monthSpend(p);
      const spent = before + total;
      for (const pct of [b.alertPct || 80, 100]) {
        const line = b.monthly * pct / 100;
        if (before < line && spent >= line) {
          const msg = `${pct >= 100 ? 'Over' : `${pct}% of`} this month's budget: about $${spent.toFixed(2)} of $${Number(b.monthly).toFixed(2)} in API-equivalent agent usage.`;
          for (const [n, m] of Object.entries(p.members || {})) if (m.role === 'owner') notePerson(p, n, 'budget', pct >= 100 ? 'Agent usage is over budget' : 'Agent usage is nearing the budget', msg, { view: 'usage' });
          if (!hasOwner(p)) for (const n of people(p)) notePerson(p, n, 'budget', 'Agent usage is nearing the budget', msg, { view: 'usage' });
          h.notify(p, 'budget', msg);
        }
      }
    }
    return total;
  }
  function costReport(p) {
    const prices = (p.projectSettings || {}).prices || {};
    const out = { people: {}, models: {}, days: {}, unpriced: [], month: monthKey(), monthSpend: monthSpend(p), budget: (p.projectSettings || {}).budget || null, prices: { ...pricing.CLAUDE, ...prices }, custom: prices };
    for (const [name, s] of Object.entries(p.stats || {})) {
      const per = { cost: 0, tokens: 0, models: {}, requestCost: 0 };
      for (const [m, u] of Object.entries(s.models || {})) {
        const c = pricing.costOf(m, u, prices);
        const tokens = u.input + u.output + u.cacheRead + u.cacheWrite;
        per.models[m] = { cost: c, tokens, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite };
        per.tokens += tokens;
        if (c == null) { if (tokens && !out.unpriced.includes(m)) out.unpriced.push(m); } else per.cost += c;
        const om = out.models[m] = out.models[m] || { cost: 0, tokens: 0, priced: c != null };
        om.cost += c || 0; om.tokens += tokens;
      }
      for (const [d, v] of Object.entries(s.days || {})) {
        const day = out.days[d] = out.days[d] || { cost: 0, tokens: 0, by: {} };
        day.cost += v.cost || 0; day.tokens += v.tokens || 0; day.by[name] = (day.by[name] || 0) + (v.cost || 0);
      }
      out.people[name] = per;
    }
    out.total = Object.values(out.people).reduce((t, x) => t + x.cost, 0);
    out.tasks = p.board.tasks.filter(t => t.usage && t.usage.tokens).map(t => ({ id: t.id, title: t.title, owner: t.owner, status: t.status, cost: t.usage.cost, tokens: t.usage.tokens, goalId: t.goalId }))
      .sort((a, b) => b.cost - a.cost).slice(0, 100);
    return out;
  }

  // ---------- search ----------
  function snippet(text, q, n = 160) {
    const t = String(text || '').replace(/\s+/g, ' ');
    const i = t.toLowerCase().indexOf(q);
    if (i < 0) return t.slice(0, n);
    const start = Math.max(0, i - 50);
    return (start ? '…' : '') + t.slice(start, start + n) + (start + n < t.length ? '…' : '');
  }
  async function search(p, q, kinds, ctx) {
    const want = (k) => !kinds || kinds.includes(k);
    const hits = [];
    const add = (x) => { if (hits.length < 400) hits.push(x); };
    const has = (...parts) => parts.some(s => s && String(s).toLowerCase().includes(q));
    if (want('tasks')) {
      for (const g of p.board.goals) if (has(g.title, g.text)) add({ kind: 'request', title: g.title || requestTitle(g.text), snippet: snippet(g.text, q), at: g.at, who: g.byName, ref: { goal: g.id } });
      for (const t of p.board.tasks) if (has(t.title, t.detail, ...(t.notes || []).map(n => n.text))) add({ kind: 'task', title: t.title, snippet: snippet([t.detail, ...(t.notes || []).map(n => n.text)].join(' '), q), at: t.updated || t.at, who: t.owner, status: t.status, ref: { task: t.id } });
    }
    if (want('messages')) for (const m of p.messages) if (has(m.text)) add({ kind: 'message', title: `${m.fromName}${m.to ? ' → ' + m.to : ' → everyone'}`, snippet: snippet(m.text, q), at: m.at, who: m.fromName, ref: { message: m.id } });
    if (want('activity')) for (const a of p.activity) if (has(a.text)) add({ kind: a.kind === 'prompt' ? 'prompt' : a.kind === 'tool' ? 'step' : 'reply', title: a.kind === 'prompt' ? `${a.name}'s prompt` : a.kind === 'tool' ? `${a.name}'s agent: ${a.tool || 'step'}` : `${a.name}'s agent replied`, snippet: snippet(a.text, q), at: a.at, who: a.name, ref: { activity: a.at } });
    if (want('knowledge')) {
      const d = p.shared.doc;
      if (d && has(d.text)) add({ kind: 'brief', title: 'Project brief', snippet: snippet(d.text, q), at: d.at, who: d.byName, ref: { brief: true } });
      for (const m of p.shared.memories) if (has(m.title, m.text)) add({ kind: 'memory', title: m.title, snippet: snippet(m.text, q), at: m.at, who: m.byName, ref: { memory: m.id } });
      for (const s of p.shared.skills) if (has(s.name, s.description, s.body)) add({ kind: 'skill', title: s.name, snippet: snippet(s.description + ' ' + s.body, q), at: s.at, who: s.byName, ref: { skill: s.name } });
      for (const hd of p.handoffs || []) if (has(hd.text)) add({ kind: 'handoff', title: `${hd.name}'s hand-off note`, snippet: snippet(hd.text, q), at: hd.at, who: hd.name, ref: { handoff: hd.id } });
    }
    if (want('code')) {
      // file names first, then the lines inside files: live copies, then each branch's newest snapshot
      const seen = new Set();
      for (const f of Object.values(p.files)) {
        if (f.content == null) continue;
        const pathHit = f.path.toLowerCase().includes(q);
        const lines = String(f.content).split('\n');
        const at = lines.findIndex(l => l.toLowerCase().includes(q));
        if (pathHit || at >= 0) { seen.add(f.path); add({ kind: 'file', title: f.path, snippet: at >= 0 ? `${at + 1}: ${lines[at].trim().slice(0, 160)}` : 'live copy', at: f.at, who: f.byName, ref: { file: f.path, branch: f.branch || null, line: at + 1 } }); }
      }
      let budget = SEARCH_CODE_BYTES;
      const snaps = Object.entries((p.git && p.git.snapshots) || {}).sort((a, b) => b[1].at - a[1].at).slice(0, 4);
      for (const [key, sn] of snaps) {
        for (const fp of Object.keys(sn.files)) if (fp.toLowerCase().includes(q) && !seen.has(fp)) { seen.add(fp); add({ kind: 'code', title: fp, snippet: `${sn.owner}'s ${sn.branch}`, at: sn.at, who: sn.owner, ref: { ref: key, path: fp, line: 0 } }); }
        if (!ctx.blobs || budget <= 0) continue;
        for (let i = 0; i < sn.n && budget > 0; i++) {
          const part = await ctx.blobs.get(`snap:${key}:${sn.sha}:${i}`).catch(() => null);
          if (!part) continue;
          budget -= part.length;
          if (!part.toLowerCase().includes(q)) continue;
          let files = [];
          try { files = JSON.parse(part); } catch {}
          for (const f of files) {
            const lines = String(f.content || '').split('\n');
            let shown = 0;
            for (let j = 0; j < lines.length && shown < 3; j++) {
              if (!lines[j].toLowerCase().includes(q)) continue;
              shown++;
              add({ kind: 'code', title: f.path, snippet: `${j + 1}: ${lines[j].trim().slice(0, 160)}`, at: sn.at, who: sn.owner, ref: { ref: key, path: f.path, line: j + 1 } });
            }
          }
        }
      }
    }
    // exact title matches first, then newest
    const rank = (x) => (String(x.title).toLowerCase() === q ? 3 : String(x.title).toLowerCase().includes(q) ? 2 : 1);
    hits.sort((a, b) => rank(b) - rank(a) || (b.at || 0) - (a.at || 0));
    return hits;
  }

  // ---------- data ----------
  const RETENTION_KEYS = { activityDays: 'activity', messageDays: 'messages', auditDays: 'audit', handoffDays: 'handoffs' };
  function applyRetention(p) {
    const r = (p.projectSettings || {}).retention;
    if (!r) return;
    const t = now();
    for (const [k, field] of Object.entries(RETENTION_KEYS)) {
      const days = Number(r[k]);
      if (!days) continue;
      const cut = t - days * 86400000;
      const list = field === 'audit' ? p.audit : p[field];
      if (!Array.isArray(list) || !list.length || list[0].at >= cut) continue;
      const keep = list.filter(x => x.at >= cut);
      if (field === 'audit') { p.audit = keep; p.auditChanged = true; }
      else { p[field] = keep; if (field === 'activity') p.activityChanged = true; }
      p.dirty = true;
    }
    // finished tasks older than the activity window go too
    const days = Number(r.taskDays);
    if (days) {
      const cut = t - days * 86400000;
      const before = p.board.tasks.length;
      p.board.tasks = p.board.tasks.filter(x => x.status !== 'done' || (x.updated || x.at) >= cut);
      p.board.goals = p.board.goals.filter(g => g.status !== 'done' || g.at >= cut || p.board.tasks.some(x => x.goalId === g.id));
      if (p.board.tasks.length !== before) { p.board.version++; p.boardChanged = true; }
    }
  }
  // everything the project holds, without anything secret (tokens, webhook URLs, key hashes)
  function exportOf(p) {
    const j = JSON.parse(JSON.stringify(p));
    delete j.tokenHash; delete j.secretHooks; delete j.secretRepo; delete j.keys; delete j.outbox; delete j.mailQueue; delete j.events; delete j.nudged; delete j.repoCache;
    for (const m of Object.values(j.members || {})) delete m.tokenHash;
    for (const i of Object.values(j.invites || {})) delete i.codeHash;
    for (const c of Object.values(j.contacts || {})) delete c.user;
    if (j.git) { delete j.git.uploads; j.git.bundles = (j.git.bundles || []).map(({ id, owner, branch, tip, size, at }) => ({ id, owner, branch, tip, size, at })); }
    return { format: 'huddle-project-export', version: 1, exported: new Date().toISOString(), project: p.name, data: j };
  }
  // a person's own trail: their prompts, replies, messages, notes, usage and settings (tasks stay, unassigned)
  function eraseFrom(p, name) {
    const n = { activity: 0, messages: 0 };
    const before = p.activity.length;
    p.activity = p.activity.filter(a => a.name !== name);
    n.activity = before - p.activity.length;
    const mb = p.messages.length;
    p.messages = p.messages.filter(m => m.fromName !== name && m.to !== name);
    n.messages = mb - p.messages.length;
    p.handoffs = (p.handoffs || []).filter(x => x.name !== name);
    p.worklog = (p.worklog || []).filter(x => x.name !== name);
    for (const k of ['stats', 'usage', 'settings', 'notes', 'notePrefs', 'contacts', 'keys']) if (p[k]) delete p[k][name];
    for (const t of p.board.tasks) if (t.owner === name && t.status !== 'done') { t.owner = null; t.status = 'todo'; }
    p.activityChanged = true; p.board.version++; p.boardChanged = true; p.dirty = true;
    return n;
  }

  // ---------- GitHub ----------
  const repoOf = (p) => (p.projectSettings || {}).repo || null;
  const repoToken = (p) => (p.secretRepo || {}).token || null;
  async function repoOverview(p, force) {
    const r = repoOf(p), tok = repoToken(p);
    if (!r || !tok) return null;
    if (!force && p.repoCache && now() - p.repoCache.at < REPO_CACHE_MS) return p.repoCache;
    try {
      p.repoCache = { ...(await githost.overview(tok, r.full, r.defaultBranch)), webhookEvents: (p.repoCache || {}).webhookEvents || [] };
      p.repoCache.error = null;
    } catch (e) {
      p.repoCache = { ...(p.repoCache || { branches: [], pulls: [], commits: [], issues: [] }), at: now(), error: e.message };
    }
    // a task's pull request: its state from here, not only from the runner's gh polling
    for (const t of p.board.tasks) {
      const pr = t.checks && t.checks.pr && (p.repoCache.pulls || []).find(x => x.url === t.checks.pr);
      if (pr && pr.checks) t.checks.ci = pr.checks.state;
    }
    return p.repoCache;
  }
  function repoEvent(p, ev) {
    p.repoCache = p.repoCache || { branches: [], pulls: [], commits: [], issues: [], at: 0 };
    p.repoCache.webhookEvents = [...(p.repoCache.webhookEvents || []), { ...ev, at: now() }].slice(-30);
    p.repoCache.at = 0;   // read fresh next time someone looks
    p.emit('repo', ev);
  }
  // a GitHub user to the person on the team who linked that login
  function personForGithub(p, login) {
    if (!login) return null;
    const l = login.toLowerCase();
    for (const [n, m] of Object.entries(p.members || {})) if (m.github && m.github.toLowerCase() === l) return n;
    for (const [n, c] of Object.entries(p.contacts || {})) if (c.github && c.github.toLowerCase() === l) return n;
    return null;
  }
  function onWebhook(p, event, b) {
    if (event === 'ping') return { ok: true, pong: true };
    const r = repoOf(p);
    if (!r || !b || !b.repository || b.repository.full_name.toLowerCase() !== r.full.toLowerCase()) return { ok: true, ignored: 'another repository' };
    if (event === 'push') {
      const branch = String(b.ref || '').replace(/^refs\/heads\//, '');
      if (!branch || b.deleted) return { ok: true };
      repoEvent(p, { action: 'push', branch, by: b.pusher && b.pusher.name, person: personForGithub(p, b.sender && b.sender.login),
        commits: (b.commits || []).slice(-5).map(c => ({ sha: c.id, message: String(c.message).split('\n')[0].slice(0, 160) })), count: (b.commits || []).length, url: b.compare });
      // a commit on GitHub can finish board tasks too ("closes 1a2b3c4d")
      const closed = [];
      for (const c of b.commits || []) for (const tid of h.taskIdsIn(c.message)) {
        const t = p.board.tasks.find(x => x.id === tid);
        if (t && t.status !== 'done') { t.status = 'done'; t.updated = now(); t.notes = [...(t.notes || []), { by: 'github', at: now(), text: `closed by ${String(c.id).slice(0, 8)} on GitHub: ${String(c.message).split('\n')[0].slice(0, 160)}` }].slice(-20); goalDone(p, t); closed.push(t); }
      }
      if (closed.length) boardChanged(p, 'task-update', { task: closed[0], tasks: closed }, { name: 'github' });
    } else if (event === 'pull_request') {
      const pr = b.pull_request || {};
      const state = pr.merged ? 'merged' : pr.state;
      repoEvent(p, { action: 'pr', what: b.action, number: pr.number, title: pr.title, url: pr.html_url, state, by: pr.user && pr.user.login, person: personForGithub(p, pr.user && pr.user.login), head: pr.head && pr.head.ref, base: pr.base && pr.base.ref });
      const tasks = p.board.tasks.filter(t => t.checks && t.checks.pr === pr.html_url);
      for (const t of tasks) { t.checks.prState = state; t.checks.merged = !!pr.merged; t.updated = now(); }
      if (tasks.length) boardChanged(p, 'task-update', { task: tasks[0] }, { name: 'github' });
    } else if (event === 'check_suite' && b.check_suite && b.check_suite.status === 'completed') {
      const cs = b.check_suite;
      const failing = ['failure', 'timed_out', 'cancelled', 'action_required'].includes(cs.conclusion);
      repoEvent(p, { action: 'checks', branch: cs.head_branch, sha: cs.head_sha, state: failing ? 'failing' : 'passing', app: cs.app && cs.app.name });
      if (failing) {
        for (const prRef of cs.pull_requests || []) {
          const url = `https://github.com/${r.full}/pull/${prRef.number}`;
          const t = p.board.tasks.find(x => x.checks && x.checks.pr === url);
          const who = t ? t.owner : null;
          if (t) { t.checks.ci = 'failing'; p.boardChanged = true; }
          if (who) notePerson(p, who, 'ci', `Checks failing on PR #${prRef.number}`, `${cs.app ? cs.app.name : 'CI'} failed on ${cs.head_branch}${t ? ` for "${t.title}"` : ''}.`, { url });
        }
      }
    } else if (event === 'issues' && ['opened', 'reopened'].includes(b.action)) {
      const i = b.issue || {};
      repoEvent(p, { action: 'issue', number: i.number, title: i.title, url: i.html_url, by: i.user && i.user.login });
    } else return { ok: true, ignored: event };
    return { ok: true };
  }

  // ---------- routes ----------
  return {
    NOTE_KINDS, notePerson, flushMail, applyRetention, chargeUsage, prefsOf, monthSpend,
    routes: {
      // my notifications: newest last
      'GET notes': (p, b, q, ctx) => {
        const name = h.canonicalName(p, (ctx.auth && ctx.auth.name) || q.get('name'));
        if (!name) return { notes: [], prefs: prefsOf(p, ''), kinds: NOTE_KINDS };
        return { notes: ((p.notes || {})[name] || []).slice(-MAX_NOTES), prefs: prefsOf(p, name), kinds: NOTE_KINDS, contact: (({ email, emailNotes, github }) => ({ email: email || null, emailNotes: emailNotes !== false, github: github || null }))((p.contacts || {})[name] || {}) };
      },
      'POST notes-read': (p, b) => {
        const a = p.touch(b.agent);
        const list = (p.notes || {})[a.name] || [];
        const ids = Array.isArray(b.ids) ? new Set(b.ids) : null;
        let n = 0;
        for (const x of list) if (!x.read && (!ids || ids.has(x.id))) { x.read = true; n++; }
        if (b.clear) { if (p.notes) p.notes[a.name] = []; }
        p.dirty = true;
        p.emit('notes-read', { to: a.name, ids: ids ? [...ids] : null, clear: !!b.clear });
        return { ok: true, read: n };
      },
      'POST note-prefs': (p, b) => {
        const a = p.touch(b.agent);
        p.notePrefs = p.notePrefs || {};
        const mine = p.notePrefs[a.name] = p.notePrefs[a.name] || {};
        for (const [k, v] of Object.entries(b.prefs || {})) {
          if (!NOTE_KINDS[k] || !v || typeof v !== 'object') continue;
          mine[k] = { ...(mine[k] || {}), ...(v.email !== undefined ? { email: !!v.email } : {}), ...(v.desktop !== undefined ? { desktop: !!v.desktop } : {}) };
        }
        if (b.emailNotes !== undefined && p.contacts && p.contacts[a.name]) p.contacts[a.name].emailNotes = !!b.emailNotes;
        p.dirty = true;
        return { ok: true, prefs: prefsOf(p, a.name) };
      },
      // the signed-in account behind this person: their email (for notifications) and GitHub login
      'POST link-account': (p, b, q, ctx) => {
        const a = p.touch(b.agent);
        const u = ctx.cred && ctx.cred.user;
        if (!u) throw httpError(400, 'sign in first (email or GitHub), then link your account');
        if (a.transient) throw httpError(400, 'pick a name first');
        p.contacts = p.contacts || {};
        p.contacts[a.name] = { ...(p.contacts[a.name] || {}), user: u, email: ctx.cred.email || null, github: ctx.cred.github || null, at: now() };
        const m = (p.members || {})[a.name];
        if (m) { m.user = u; if (ctx.cred.github) m.github = ctx.cred.github; if (ctx.cred.email) m.email = ctx.cred.email; }
        audit(p, a.name, 'account', `linked their account${ctx.cred.email ? ' (' + ctx.cred.email + ')' : ''}${ctx.cred.github ? ' and GitHub ' + ctx.cred.github : ''}`);
        p.emit('members', { members: h.publicMembers(p) });
        return { ok: true, name: a.name, email: ctx.cred.email || null, github: ctx.cred.github || null };
      },

      'GET search': async (p, b, q, ctx) => {
        const query = String(q.get('q') || '').trim().toLowerCase().slice(0, 200);
        if (query.length < 2) return { results: [], query };
        const kinds = q.get('kinds') ? q.get('kinds').split(',') : null;
        const results = await search(p, query, kinds, ctx);
        return { results: results.slice(0, Math.min(Number(q.get('limit')) || SEARCH_LIMIT, 200)), total: results.length, query };
      },

      // ---- tasks you can change from the dashboard ----
      'POST task-edit': (p, b) => {
        const a = p.touch(b.agent);
        const t = p.board.tasks.find(x => x.id === b.id);
        if (!t) throw httpError(404, 'no such task');
        const said = [];
        if (b.title !== undefined) { const v = clip(b.title, 200); if (!v) throw httpError(400, 'a task needs a title'); if (v !== t.title) { t.title = v; said.push('renamed'); } }
        if (b.detail !== undefined) { t.detail = String(b.detail || '').slice(0, 6000); said.push('edited the details'); }
        if (b.effort !== undefined) t.effort = ['light', 'medium', 'heavy'].includes(b.effort) ? b.effort : null;
        if (b.owner !== undefined) { const o = b.owner ? h.personFor(p, b.owner) : null; if (o !== t.owner) { said.push(o ? `gave it to ${o}` : 'unassigned it'); t.owner = o; t.held = null; if (t.status === 'doing') t.status = 'todo'; } }
        if (b.paths !== undefined) t.paths = (Array.isArray(b.paths) ? b.paths : []).map(x => String(x).trim()).filter(Boolean).slice(0, 10);
        if (b.status !== undefined) {
          if (!['todo', 'doing', 'done', 'blocked'].includes(b.status)) throw httpError(400, 'status must be todo, doing, done or blocked');
          if (b.status !== t.status) said.push(`moved it to ${b.status}`);
          t.status = b.status;
        }
        t.updated = now();
        if (said.length) t.notes = [...(t.notes || []), { by: a.name, at: now(), text: `${a.name} ${said.join(', ')}` }].slice(-20);
        if (a.kind === 'human' && said.length) audit(p, a.name, 'task', `${said.join(', ')}: ${t.title}`);
        goalDone(p, t);
        boardChanged(p, 'task-update', { task: t }, a);
        if (b.owner && t.owner && t.owner !== a.name) notePerson(p, t.owner, 'request', `${a.name} gave your agent a task`, t.title, { view: 'tasks', task: t.id });
        return { ok: true, task: t };
      },
      'POST task-comment': (p, b) => {
        const a = p.touch(b.agent);
        const t = p.board.tasks.find(x => x.id === b.id);
        if (!t) throw httpError(404, 'no such task');
        const text = String(b.text || '').trim().slice(0, 2000);
        if (!text) throw httpError(400, 'say something');
        t.notes = [...(t.notes || []), { by: a.name, at: now(), text, comment: true }].slice(-20);
        t.updated = now();
        boardChanged(p, 'task-update', { task: t }, a);
        if (t.owner && t.owner !== a.name) notePerson(p, t.owner, 'message', `${a.name} commented on "${clip(t.title, 60)}"`, text, { view: 'tasks', task: t.id });
        return { ok: true, task: t };
      },
      // only whoever asked for it, or an owner
      'POST task-delete': (p, b, q, ctx) => {
        const a = p.touch(b.agent);
        const t = p.board.tasks.find(x => x.id === b.id);
        if (!t) throw httpError(404, 'no such task');
        if (t.by !== a.name && (ctx.auth || {}).role !== 'owner') throw httpError(403, `only ${t.by}, who asked for it, or a project owner can delete it`);
        if (t.status === 'doing' && !b.force) throw httpError(409, 'an agent is working on it right now; stop it first or mark it done');
        p.board.tasks = p.board.tasks.filter(x => x.id !== t.id);
        for (const x of p.board.tasks) if (x.after) x.after = x.after.filter(i => i !== t.id);
        const g = p.board.goals.find(x => x.id === t.goalId);
        if (g && !p.board.tasks.some(x => x.goalId === g.id)) p.board.goals = p.board.goals.filter(x => x.id !== g.id);
        audit(p, a.name, 'task', `deleted the task "${t.title}"`);
        boardChanged(p, 'task-delete', { taskId: t.id, goalId: t.goalId }, a);
        return { ok: true };
      },

      // ---- what it costs ----
      'GET costs': (p) => costReport(p),
      'POST cost-settings': (p, b) => {
        const a = p.touch(b.agent);
        const ps = p.projectSettings = p.projectSettings || {};
        if (b.budget !== undefined) {
          const m = Number(b.budget && b.budget.monthly);
          ps.budget = m > 0 ? { monthly: Math.min(m, 1e7), alertPct: Math.max(10, Math.min(Number(b.budget.alertPct) || 80, 99)) } : null;
        }
        if (b.prices !== undefined) ps.prices = pricing.cleanPrices(b.prices);
        audit(p, a.name, 'settings', `cost settings: ${ps.budget ? `budget $${ps.budget.monthly}/month, alert at ${ps.budget.alertPct}%` : 'no budget'}${ps.prices && Object.keys(ps.prices).length ? `; custom prices for ${Object.keys(ps.prices).join(', ')}` : ''}`);
        p.emit('project-setting', { settings: ps, byName: a.name });
        return { ok: true, settings: ps };
      },

      // ---- the project's data ----
      'GET export': (p) => exportOf(p),
      'POST retention': (p, b) => {
        const a = p.touch(b.agent);
        const ps = p.projectSettings = p.projectSettings || {};
        const r = {};
        for (const k of [...Object.keys(RETENTION_KEYS), 'taskDays']) { const v = Number(b[k]); if (v > 0) r[k] = Math.max(1, Math.min(Math.round(v), 3650)); }
        ps.retention = Object.keys(r).length ? r : null;
        applyRetention(p);
        audit(p, a.name, 'settings', `data kept: ${ps.retention ? Object.entries(r).map(([k, v]) => `${k.replace('Days', '')} ${v} days`).join(', ') : 'until the project is deleted (no limit)'}`);
        p.emit('project-setting', { settings: ps, byName: a.name });
        return { ok: true, settings: ps };
      },
      'POST erase-me': (p, b, q, ctx) => {
        const a = p.touch(b.agent);
        if (a.transient) throw httpError(400, 'pick a name first');
        const n = eraseFrom(p, a.name);
        audit(p, a.name, 'erase', `erased their activity (${n.activity} items) and messages (${n.messages})`);
        p.emit('forget', { name: '' });
        return { ok: true, ...n };
      },
      'POST delete-project': async (p, b, q, ctx) => {
        p.touch(b.agent);
        if (String(b.confirm || '') !== p.name && String(b.confirm || '') !== prettyProject(p)) throw httpError(400, `type the project's name (${prettyProject(p)}) to confirm`);
        if (!ctx.deleteProject) throw httpError(501, 'this server cannot delete projects');
        const r = repoOf(p);
        if (r && r.webhookId && repoToken(p)) await githost.deleteWebhook(repoToken(p), r.full, r.webhookId);
        p.emit('deleted', { by: b.agent && b.agent.name });
        await ctx.deleteProject();
        return { ok: true, deleted: p.name };
      },

      // ---- GitHub ----
      'POST repo-connect': async (p, b, q, ctx) => {
        const a = p.touch(b.agent);
        const repo = githost.parseRepo(b.repo);
        if (!repo) throw httpError(400, 'give the repository as owner/name or its GitHub URL');
        const token = String(b.token || '').trim() || (ctx.cred && ctx.cred.githubToken) || '';
        if (!token) throw httpError(400, 'sign in with GitHub (with repository access) or paste a token that can read the repository');
        const info = await githost.repoInfo(token, repo.full);
        const old = repoOf(p);
        if (old && old.webhookId && repoToken(p)) await githost.deleteWebhook(repoToken(p), old.full, old.webhookId);
        const secret = crypto.randomBytes(20).toString('hex');
        p.secretRepo = { token, secret, by: a.name, at: now() };
        const r = { full: info.full, url: info.url, defaultBranch: info.defaultBranch, private: info.private, by: a.name, at: now(), webhook: false };
        // a webhook needs admin rights on the repository and a public address for this server
        if (info.admin && p.origin && /^https:/.test(p.origin)) {
          try { r.webhookId = await githost.createWebhook(token, info.full, `${p.origin}/api/hooks/github/${encodeURIComponent(p.name)}`, secret); r.webhook = true; }
          catch (e) { r.webhookError = e.message; }
        } else r.webhookError = !info.admin ? "the token isn't an admin of the repository, so updates are read every minute instead of pushed" : 'this server has no public https address, so updates are read every minute instead of pushed';
        p.projectSettings = { ...(p.projectSettings || {}), repo: r };
        p.repoCache = null;
        audit(p, a.name, 'repo', `connected the GitHub repository ${info.full}${r.webhook ? ' with a webhook' : ''}`);
        p.emit('project-setting', { settings: p.projectSettings, byName: a.name });
        await repoOverview(p, true);
        return { ok: true, repo: r };
      },
      'POST repo-disconnect': async (p, b) => {
        const a = p.touch(b.agent);
        const r = repoOf(p);
        if (!r) return { ok: true };
        if (r.webhookId && repoToken(p)) await githost.deleteWebhook(repoToken(p), r.full, r.webhookId);
        delete p.secretRepo;
        p.repoCache = null;
        p.projectSettings = { ...(p.projectSettings || {}), repo: null };
        audit(p, a.name, 'repo', `disconnected ${r.full}`);
        p.emit('project-setting', { settings: p.projectSettings, byName: a.name });
        return { ok: true };
      },
      'GET repo': async (p, b, q) => {
        const r = repoOf(p);
        if (!r) return { repo: null };
        return { repo: r, ...(await repoOverview(p, q.get('fresh') === '1')) };
      },
      // a branch someone pushed, as a pull request; a task's PR is remembered on the task
      'POST repo-pr': async (p, b) => {
        const a = p.touch(b.agent);
        const r = repoOf(p), tok = repoToken(p);
        if (!r || !tok) throw httpError(409, 'connect a GitHub repository first');
        const t = b.taskId && p.board.tasks.find(x => x.id === b.taskId);
        const head = clip(b.head, 200);
        if (!head) throw httpError(400, 'which branch?');
        const pr = await githost.createPull(tok, r.full, { head, base: clip(b.base, 200) || r.defaultBranch, title: clip(b.title, 250) || (t ? t.title : head), body: (b.body || (t ? `${t.detail || t.title}\n\nTask \`${t.id}\` on huddle, asked by ${t.by}.` : '')) + `\n\nOpened by ${a.name} from huddle.`, draft: !!b.draft });
        if (t) { t.checks = { ...(t.checks || {}), pr: pr.url, prState: 'open' }; boardChanged(p, 'task-update', { task: t }, a); }
        audit(p, a.name, 'repo', `opened pull request #${pr.number} from ${head}`);
        p.repoCache = null;
        return { ok: true, pr };
      },
      // an issue on GitHub as a request to the team (or to one person's agent)
      'POST repo-issue': async (p, b, q, ctx) => {
        const a = p.touch(b.agent);
        const ov = await repoOverview(p, false);
        const i = ov && (ov.issues || []).find(x => x.number === Number(b.number));
        if (!i) throw httpError(404, 'no open issue with that number');
        const text = `${i.title} (GitHub issue #${i.number})\n\n${i.body || ''}\n\n${i.url}`.slice(0, 8000);
        return h.routes['POST goal'](p, { agent: b.agent, text, to: b.to || null, title: clip(i.title, 80) }, q, ctx);
      },
      // GitHub calls this (the servers check nothing; the signature is checked here)
      'POST github-webhook': async (p, b, q, ctx) => {
        const s = (p.secretRepo || {}).secret;
        const req = ctx.request || {};
        if (!s || !(await githost.verifySignature(s, req.raw || '', req.header('x-hub-signature-256')))) throw httpError(401, 'bad signature');
        return onWebhook(p, req.header('x-github-event'), b);
      },

      // ---- merge conflicts between branches, found by each person's huddle with git merge-tree ----
      'POST conflicts': (p, b) => {
        const a = p.touch(b.agent);
        const branch = clip(b.branch, 200);
        if (!branch) throw httpError(400, 'branch required');
        const key = `${a.name}/${branch}`;
        p.conflicts = p.conflicts || {};
        const prev = p.conflicts[key] || { items: [] };
        const items = (Array.isArray(b.items) ? b.items : []).slice(0, 30).map(x => ({ other: clip(x.other, 200), files: (Array.isArray(x.files) ? x.files : []).slice(0, 50).map(f => normPath(String(f))), sha: clip(x.sha, 40), otherSha: clip(x.otherSha, 40) })).filter(x => x.other && x.files.length);
        p.conflicts[key] = { owner: a.name, branch, sha: clip(b.sha, 40), items, at: now() };
        // new trouble: both people hear about it once
        for (const x of items) {
          const was = prev.items.find(y => y.other === x.other);
          if (was && x.files.every(f => was.files.includes(f))) continue;
          const other = x.other.split('/')[0];
          const files = x.files.slice(0, 4).join(', ') + (x.files.length > 4 ? ` +${x.files.length - 4}` : '');
          notePerson(p, a.name, 'conflict', `Your ${branch} conflicts with ${x.other}`, `Both changed ${files}. Your agent can merge it and settle the differences.`, { view: 'code', conflict: key });
          if (other !== a.name) notePerson(p, other, 'conflict', `${a.name}'s ${branch} conflicts with your branch`, `Both changed ${files}.`, { view: 'code', conflict: key });
        }
        if (JSON.stringify(prev.items) !== JSON.stringify(items)) p.emit('conflicts', { key, conflicts: p.conflicts[key] });
        for (const [k, v] of Object.entries(p.conflicts)) if (now() - v.at > 7 * 86400000) delete p.conflicts[k];
        p.dirty = true;
        return { ok: true, count: items.length };
      },
      'GET conflicts': (p) => ({ conflicts: Object.values(p.conflicts || {}).filter(c => c.items.length) }),
      // hand the merge to an agent: a request to the branch owner's agent to merge and resolve
      'POST resolve-conflicts': (p, b) => {
        const a = p.touch(b.agent);
        const c = (p.conflicts || {})[String(b.key || '')];
        if (!c) throw httpError(404, 'no such conflict');
        const x = c.items.find(y => y.other === b.other) || c.items[0];
        if (!x) throw httpError(404, 'nothing conflicts there any more');
        const goal = { id: id(), text: `Merge ${x.other} into ${c.branch} and resolve the conflicts in ${x.files.join(', ')}.`, by: a.id, byName: a.name, at: now(), status: 'planned', planner: c.owner, to: c.owner, title: `Merge ${x.other} into ${c.branch}` };
        p.board.goals.push(goal);
        const task = pushTask(p, { goalId: goal.id, title: `Resolve conflicts with ${x.other}`, owner: c.owner, direct: true, effort: x.files.length > 5 ? 'heavy' : 'medium',
          detail: `Run \`huddle merge ${x.other}\` (or merge refs/remotes/huddle/${x.other} with git) into ${c.branch}. git will stop with conflicts in:\n${x.files.map(f => '- ' + f).join('\n')}\n\nFor each file, read both sides and the commits that changed it (git log --merge -p -- <file>), keep what each side meant to do, and remove every conflict marker. Run the tests if there are any. Commit the merge with a message that says how you settled each file. If a choice changes what ${x.other.split('/')[0]} built, tell them with huddle_send.` }, a);
        task.conflict = { key: c.owner + '/' + c.branch, other: x.other, files: x.files };
        boardChanged(p, 'goal', { goal }, a);
        notePerson(p, c.owner, 'request', `${a.name} asked your agent to resolve a merge conflict`, goal.text, { view: 'tasks', task: task.id });
        return { ok: true, task };
      },
    },
  };
};
module.exports.NOTE_KINDS = NOTE_KINDS;

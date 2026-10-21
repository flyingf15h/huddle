// Routes added on top of core.js: per-person notifications (in the app, by email, on the desktop),
// search across the whole project, tasks you can edit, what the agents' tokens cost, a project's
// data (export, retention, deletion), its GitHub repository, and merge conflicts between branches.
// core.js hands in the helpers it shares (audit, notify, the board functions) so both servers get
// the same routes.
'use strict';
const crypto = require('crypto');
const pricing = require('./pricing');
const githost = require('./githost');
const slack = require('./slack');
const { deniedBy } = require('./policy');

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
  stuck: { label: 'Your work is blocked', email: true, desktop: true },
  done: { label: 'Your requests finished', email: false, desktop: false },
  conflict: { label: 'Merge conflicts with your branch', email: true, desktop: true },
  ci: { label: 'Checks failing on your pull requests', email: true, desktop: true },
  budget: { label: 'Budget alerts (owners)', email: true, desktop: false },
  digest: { label: 'Daily digest', email: true, desktop: false },
  cost: { label: 'Cost spikes and forecasts (owners)', email: true, desktop: false },
};

module.exports = function features(h) {
  const { httpError, now, audit, hasOwner, boardChanged, pushTask, requestTitle, goalDone, normPath } = h;
  const id = () => crypto.randomBytes(4).toString('hex');
  const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  const prettyProject = (p) => p.name.replace(/-[0-9a-f]{6,8}$/, '');
  const people = (p) => [...new Set([...Object.values(p.agents).map(a => a.name), ...Object.keys(p.settings || {}), ...Object.keys(p.members || {})])].filter(n => n && !/^(human|guest)$/.test(n));


  // ---------- conflict-aware planning ----------
  // Two tasks that change the same files shouldn't run at the same time on different branches: the
  // second would conflict with the first. When a plan is made, tasks that touch the same files wait for
  // each other (and, if nobody was chosen for the second one, go to whoever has the first), while tasks
  // in different parts of the code still run in parallel. A task's files are the ones its planner listed,
  // or, failing that, the paths and file names mentioned in its text.
  const FILE_WORD = /(?:^|[\s("'`])((?:[\w.@-]+\/)+[\w.@-]*|[\w-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|rb|java|kt|swift|php|css|scss|html|vue|svelte|md|json|ya?ml|toml|sql|sh))(?=$|[\s)"'`,;:.!?])/g;
  function guessPaths(t) {
    const out = new Set();
    for (const m of `${t.title || ''}\n${t.detail || ''}`.matchAll(FILE_WORD)) {
      const w = m[1].replace(/^\.\//, '');
      if (/^(https?|ftp):/i.test(w) || w.length < 3 || /^\d+(\/\d+)+$/.test(w)) continue;
      out.add(w);
    }
    return [...out].slice(0, 12);
  }
  const normPathList = (list) => (list || []).map(x => String(x).trim().replace(/^\.\//, '').replace(/\*\*?.*$/, '').replace(/\/+$/, '/')).filter(Boolean);
  function pathsOverlap(a, b) {
    for (const x of normPathList(a)) for (const y of normPathList(b)) {
      const xd = x.endsWith('/'), yd = y.endsWith('/');
      if (x === y) return x;
      if (xd && y.startsWith(x)) return y;
      if (yd && x.startsWith(y)) return x;
      // a bare file name ("cart.ts") matches the same name anywhere
      if (!x.includes('/') && (y === x || y.endsWith('/' + x))) return y;
      if (!y.includes('/') && (x === y || x.endsWith('/' + y))) return x;
    }
    return null;
  }
  const filesOf = (t) => (t.paths && t.paths.length ? t.paths : t.guess || []);
  // after a plan's tasks are made: order the ones that overlap, and keep unowned ones with whoever has the files
  function conflictAware(p, made, asked) {
    const open = p.board.tasks.filter(t => t.status !== 'done' && !made.includes(t));
    for (const t of made) { if (!(t.paths && t.paths.length)) t.guess = guessPaths(t); }
    made.forEach((t, i) => {
      const mine = filesOf(t);
      if (!mine.length) return;
      const before = [...open, ...made.slice(0, i)];
      const hits = [];
      for (const o of before) { const f = pathsOverlap(mine, filesOf(o)); if (f) hits.push({ task: o, file: f }); }
      if (!hits.length) return;
      t.after = [...new Set([...(t.after || []), ...hits.map(h => h.task.id)])].slice(0, 10);
      // nobody was picked for it by name: keep it with the person who has the files
      const explicit = asked && asked[i] && asked[i].owner;
      const holder = hits.map(h => h.task.owner).find(Boolean);
      if (!explicit && holder && t.owner !== holder) t.owner = holder;
      const first = hits[0];
      t.waitsFor = hits.slice(0, 3).map(h => ({ id: h.task.id, title: h.task.title, file: h.file }));
      t.notes = [...(t.notes || []), { by: 'huddle', at: now(), text: `Waits for “${clip(first.task.title, 60)}”${hits.length > 1 ? ` and ${hits.length - 1} more` : ''}: both change ${first.file}. They run one after the other so their work doesn't conflict.` }].slice(-20);
    });
  }

  // ---------- notifications ----------
  function prefsOf(p, name) {
    const mine = ((p.notePrefs || {})[name]) || {};
    const out = {};
    for (const [k, d] of Object.entries(NOTE_KINDS)) out[k] = { app: true, email: mine[k] && mine[k].email !== undefined ? !!mine[k].email : d.email, desktop: mine[k] && mine[k].desktop !== undefined ? !!mine[k].desktop : d.desktop };
    return out;
  }
  // tell one person about something; their notification list, then email (batched) and the desktop
  // alert their own huddle shows, as they chose
  function notePerson(p, to, kind, title, body, link, opts = {}) {
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
    if (prefs.email && opts.email !== false && contact && contact.email && contact.emailNotes !== false) {
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
      const html = `<div style="font:15px/1.5 system-ui,sans-serif;color:#24211c;max-width:560px">${unread.map(n => `<p style="margin:0 0 14px"><b>${esc(n.title)}</b><br><span style="color:#5f5b53">${esc(n.body)}</span></p>`).join('')}${link ? `<p><a href="${esc(link)}" style="background:#2f5d62;color:#fff;padding:9px 14px;border-radius:6px;text-decoration:none;font-weight:600">Open ${esc(prettyProject(p))}</a></p>` : ''}<p style="color:#8a857b;font-size:12px">You can change what you get emailed about in the project's notification settings.</p></div>`;
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

  // ---------- cost trends ----------
  // Beyond the monthly budget line: a day that costs far more than usual, a month on course to go over
  // budget, and a single task that costs far more than tasks usually do. Each alert fires once, to the
  // owners (everyone when there are no owners yet) and any Slack or Discord channel that wants cost news.
  const COST_ALERTS = { spike: true, spikeMultiple: 2.5, spikeMinUsd: 5, forecast: true, task: true, taskUsd: 15 };
  const costAlertCfg = (p) => ({ ...COST_ALERTS, ...(((p.projectSettings || {}).costAlerts) || {}) });
  const dayKey = (t = now()) => new Date(t).toISOString().slice(0, 10);
  function dayTotals(p) {
    const out = {};
    for (const st of Object.values(p.stats || {})) for (const [d, v] of Object.entries(st.days || {})) out[d] = (out[d] || 0) + (v.cost || 0);
    return out;
  }
  // today, the usual active day, and where the month is heading
  function costTrend(p, extraToday = 0) {
    const days = dayTotals(p), today = dayKey(), t = now();
    const prior = [];
    for (let i = 1; i <= 14; i++) { const v = days[dayKey(t - i * 86400000)] || 0; if (v > 0) prior.push(v); }
    const avg = prior.length >= 3 ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
    const d = new Date(t), dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(), elapsed = d.getUTCDate() - 1 + (d.getUTCHours() + d.getUTCMinutes() / 60) / 24;
    const mtd = monthSpend(p) + extraToday;
    const projected = elapsed >= 4 ? mtd / elapsed * dim : null;
    const series = [];
    for (let i = 13; i >= 0; i--) { const k = dayKey(t - i * 86400000); series.push({ d: k, cost: (days[k] || 0) + (k === today ? extraToday : 0) }); }
    return { today: (days[today] || 0) + extraToday, avg, mtd, projected, daysInMonth: dim, series };
  }
  function costAlert(p, key, title, msg) {
    for (const [n, m] of Object.entries(p.members || {})) if (m.role === 'owner') notePerson(p, n, 'cost', title, msg, { view: 'usage' });
    if (!hasOwner(p)) for (const n of people(p)) notePerson(p, n, 'cost', title, msg, { view: 'usage' });
    h.notify(p, 'cost', msg);
  }
  function checkCostTrends(p, total, taskId, name) {
    const c = costAlertCfg(p);
    p.costAlerts = p.costAlerts || {};
    const st = p.costAlerts, trend = costTrend(p, total), today = dayKey();
    if (c.spike && trend.avg > 0 && st.spikeDay !== today && trend.today >= Math.max(c.spikeMinUsd, trend.avg * c.spikeMultiple)) {
      st.spikeDay = today;
      const days = dayTotals(p);
      const who = Object.entries(p.stats || {}).map(([n, s2]) => [n, ((s2.days || {})[today] || {}).cost || 0]).sort((a, b) => b[1] - a[1])[0];
      costAlert(p, 'spike', 'Agent usage is high today', `About ${money(trend.today)} so far today, ${(trend.today / trend.avg).toFixed(1)}x the usual ${money(trend.avg)} a day${who && who[1] > 0 ? ` (${who[0]} has used the most)` : ''}.`);
    }
    const b = (p.projectSettings || {}).budget;
    if (c.forecast && b && b.monthly > 0 && trend.projected && trend.projected > b.monthly && (!st.forecastAt || now() - st.forecastAt > 7 * 86400000)) {
      st.forecastAt = now();
      costAlert(p, 'forecast', 'On course to go over budget', `At this pace the month ends around ${money(trend.projected)}, over the ${money(b.monthly)} budget (${money(trend.mtd)} so far).`);
    }
    if (c.task && taskId) {
      const t = p.board.tasks.find(x => x.id === taskId);
      if (t && t.usage && !t.costAlerted) {
        const costs = p.board.tasks.filter(x => x.id !== t.id && x.usage && x.usage.cost > 0).map(x => x.usage.cost).sort((a, b) => a - b);
        const median = costs.length >= 5 ? costs[Math.floor(costs.length / 2)] : 0;
        if (t.usage.cost >= c.taskUsd || (median > 0 && t.usage.cost >= Math.max(3, median * 5))) {
          t.costAlerted = true;
          costAlert(p, 'task', 'A task is costing a lot', `“${clip(t.title, 70)}”${t.owner ? ` (${t.owner})` : ''} has used about ${money(t.usage.cost)} of agent usage${median ? `, against about ${money(median)} for a typical task` : ''}. It may be looping.`);
        }
      }
    }
  }

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
    if (total > 0) checkCostTrends(p, total, taskId, name);
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
    out.trend = costTrend(p);
    out.alerts = costAlertCfg(p);
    out.tasks = p.board.tasks.filter(t => t.usage && t.usage.tokens).map(t => ({ id: t.id, title: t.title, owner: t.owner, status: t.status, cost: t.usage.cost, tokens: t.usage.tokens, goalId: t.goalId }))
      .sort((a, b) => b.cost - a.cost).slice(0, 100);
    return out;
  }


  // ---------- the daily digest ----------
  // Once a day (at the owner's chosen hour, in their time zone) the project writes a short summary of
  // what its agents did, what's stuck and what it cost, and sends it to the owners or to everyone, by
  // email, as a pop-up in the dashboard, or both. A day with nothing to report sends nothing.
  const DIGEST_DEFAULT = { enabled: false, to: 'owners', email: true, popup: true, slack: false, hour: 8, tz: 'UTC', weekdaysOnly: true };
  const digestCfg = (p) => ({ ...DIGEST_DEFAULT, ...((p.projectSettings || {}).digest || {}) });
  const fmts = new Map();
  function localParts(t, tz) {
    try {
      let f = fmts.get(tz);
      if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }); fmts.set(tz, f); }
      const o = Object.fromEntries(f.formatToParts(new Date(t)).map(x => [x.type, x.value]));
      return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), weekday: o.weekday };
    } catch { return tz === 'UTC' ? { date: new Date(t).toISOString().slice(0, 10), hour: new Date(t).getUTCHours(), weekday: 'Mon' } : localParts(t, 'UTC'); }
  }
  const validTz = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
  function digestDueAt(p, t) {
    const c = digestCfg(p);
    if (!c.enabled) return false;
    const lp = localParts(t, c.tz);
    if (c.weekdaysOnly && (lp.weekday === 'Sat' || lp.weekday === 'Sun')) return false;
    return lp.hour >= c.hour && (p.digestState || {}).lastDate !== lp.date;
  }
  // when the next one is due (the Worker sets an alarm for it); null when it's off
  function nextDigestAt(p) {
    const c = digestCfg(p);
    if (!c.enabled) return null;
    const key = JSON.stringify([c, (p.digestState || {}).lastDate]);
    if (p._nd && p._nd.key === key && p._nd.at > now()) return p._nd.at;
    let at = null;
    for (let t = now(); t < now() + 9 * 86400000; t += 15 * 60000) if (digestDueAt(p, t)) { at = t; break; }
    p._nd = { key, at };
    return at;
  }
  function digestRecipients(p) {
    const c = digestCfg(p);
    if (c.to === 'everyone' || !hasOwner(p)) return people(p);
    return Object.entries(p.members || {}).filter(([, m]) => m.role === 'owner').map(([n]) => n);
  }
  const cumulativeCost = (p) => Object.fromEntries(Object.entries(p.stats || {}).map(([n, st]) => [n, pricing.costOfModels(st.models, (p.projectSettings || {}).prices).total]));

  function buildDigest(p, until = now()) {
    const st = p.digestState || {};
    const since = Math.max(st.at || 0, until - 48 * 3600000) || until - 24 * 3600000;
    const title = (t) => t.title;
    const done = p.board.tasks.filter(t => t.status === 'done' && (t.updated || t.at) >= since);
    const newGoals = p.board.goals.filter(g => g.at >= since);
    const stuck = p.board.tasks.filter(t => t.status === 'blocked');
    const doing = p.board.tasks.filter(t => t.status === 'doing');
    const prs = p.board.tasks.filter(t => t.checks && t.checks.pr && (t.updated || t.at) >= since);
    const conflicts = Object.values(p.conflicts || {}).reduce((n, c) => n + c.items.length, 0);
    const problems = (p.problems || []).filter(x => x.at >= since);
    const approvals = p.liveApprovals();
    const now_ = cumulativeCost(p), before = st.cost || {};
    const costBy = Object.entries(now_).map(([n, v]) => [n, Math.max(0, v - (before[n] || 0))]).filter(([, v]) => v >= 0.005).sort((a, b) => b[1] - a[1]);
    const cost = costBy.reduce((t, [, v]) => t + v, 0);
    const active = [...new Set([...p.activity.filter(a => a.at >= since).map(a => a.name), ...done.map(t => t.owner).filter(Boolean)])];
    const budget = (p.projectSettings || {}).budget;
    const month = monthSpend(p);
    const sections = [];
    if (stuck.length || approvals.length || problems.length || conflicts) {
      const items = [
        ...stuck.map(t => ({ text: `“${title(t)}” is stuck${t.owner ? ` (${t.owner})` : ''}${t.notes && t.notes.length ? ': ' + clip(t.notes[t.notes.length - 1].text, 140) : ''}` })),
        ...approvals.slice(0, 5).map(x => ({ text: `${x.owner}'s agent is waiting for an OK to run ${clip(x.command, 80)}` })),
        ...(conflicts ? [{ text: `${conflicts} branch conflict${conflicts === 1 ? '' : 's'} between teammates` }] : []),
        ...(problems.length ? [{ text: `${problems.length} error${problems.length === 1 ? ' was' : 's were'} reported from teammates' computers` }] : []),
      ];
      sections.push({ title: 'Needs a person', tone: 'bad', items });
    }
    if (done.length) sections.push({ title: 'Finished', tone: 'ok', items: done.slice(0, 10).map(t => ({ text: `${title(t)}${t.owner ? ` (${t.owner})` : ''}${t.checks && t.checks.tests === 'passed' ? ', tests pass' : ''}` })).concat(done.length > 10 ? [{ text: `and ${done.length - 10} more` }] : []) });
    if (doing.length) sections.push({ title: 'In progress', items: doing.slice(0, 6).map(t => ({ text: `${title(t)}${t.owner ? ` (${t.owner})` : ''}` })) });
    if (prs.length) sections.push({ title: 'Pull requests', items: prs.slice(0, 6).map(t => ({ text: `${title(t)}: ${t.checks.prState || 'open'}${t.checks.ci ? `, checks ${t.checks.ci}` : ''}` })) });
    if (cost > 0 || (budget && month > 0)) {
      const items = costBy.slice(0, 6).map(([n, v]) => ({ text: `${n}: ${money(v)}` }));
      if (budget) items.push({ text: `This month so far: ${money(month)} of a ${money(budget.monthly)} budget (${Math.round(month / budget.monthly * 100)}%)` });
      else items.push({ text: `This month so far: ${money(month)}` });
      const tr = costTrend(p);
      if (tr.avg > 0 && cost > tr.avg * 1.8) items.push({ text: `That is ${(cost / tr.avg).toFixed(1)}x the usual ${money(tr.avg)} a day` });
      if (budget && tr.projected) items.push({ text: `On course for ${money(tr.projected)} this month` });
      sections.push({ title: `Agent usage, about ${money(cost)} at API prices`, items });
    }
    const bits = [done.length && `${done.length} task${done.length === 1 ? '' : 's'} finished`, newGoals.length && `${newGoals.length} new request${newGoals.length === 1 ? '' : 's'}`, stuck.length && `${stuck.length} stuck`, cost >= 0.005 && `${money(cost)} of agent usage`].filter(Boolean);
    const quiet = !done.length && !newGoals.length && !stuck.length && cost < 0.005 && !problems.length && !conflicts;
    return { id: id(), at: until, since, project: prettyProject(p), quiet,
      headline: bits.length ? bits.join(', ') : 'A quiet day: nothing finished, nothing stuck.',
      stats: { done: done.length, newRequests: newGoals.length, stuck: stuck.length, inProgress: doing.length, cost, month, budget: budget || null, active }, sections, _cost: now_ };
  }
  const money = (n) => (n < 0.01 && n > 0 ? '<$0.01' : '$' + Number(n || 0).toFixed(n < 10 ? 2 : 0));
  const stripDigest = ({ _cost, ...d }) => d;

  function digestEmail(p, d) {
    const link = p.origin ? `${p.origin}/app#p=${encodeURIComponent(p.name)}` : '';
    const esc = (x) => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const day = new Date(d.at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: digestCfg(p).tz });
    const text = `${d.project}, ${day}\n${d.headline}\n\n` + d.sections.map(s => `${s.title}\n${s.items.map(i => '  - ' + i.text).join('\n')}`).join('\n\n') + (link ? `\n\nOpen the project: ${link}` : '') + '\n\nChange what you get in the project\'s notification settings.';
    const html = `<div style="font:15px/1.55 system-ui,sans-serif;color:#171717;max-width:560px"><p style="margin:0 0 2px;color:#626268;font-size:13px">${esc(d.project)} · ${esc(day)}</p><h2 style="margin:0 0 14px;font-size:20px;letter-spacing:-.01em">${esc(d.headline)}</h2>` +
      d.sections.map(s => `<h3 style="margin:18px 0 6px;font-size:14px;color:${s.tone === 'bad' ? '#cf222e' : s.tone === 'ok' ? '#1a7f4b' : '#171717'}">${esc(s.title)}</h3><ul style="margin:0;padding-left:18px;color:#3d3d42">${s.items.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul>`).join('') +
      (link ? `<p style="margin-top:22px"><a href="${esc(link)}" style="background:#171717;color:#fff;padding:9px 14px;border-radius:7px;text-decoration:none;font-weight:600">Open ${esc(d.project)}</a></p>` : '') +
      `<p style="color:#8b8b93;font-size:12px;margin-top:20px">You can turn this off in the project's notification settings.</p></div>`;
    return { subject: `[${d.project}] ${d.headline}`, text, html };
  }
  function deliverDigest(p, d) {
    const c = digestCfg(p), to = digestRecipients(p);
    const sent = { email: 0, popup: 0, people: to.length };
    p.digests = p.digests || [];
    p.digests.push(stripDigest(d));
    if (p.digests.length > 30) p.digests.splice(0, p.digests.length - 30);
    const mail = c.email ? digestEmail(p, d) : null;
    for (const who of to) {
      if (c.popup) { notePerson(p, who, 'digest', `Daily digest: ${d.headline}`, d.sections.slice(0, 2).map(s => s.title).join(' · '), { digest: d.id }, { email: false }); sent.popup++; }
      const contact = (p.contacts || {})[who];
      if (mail && contact && contact.email && prefsOf(p, who).digest.email !== false) { (p.outbox = p.outbox || []).push({ email: { to: contact.email, ...mail } }); sent.email++; }
    }
    if (c.slack) h.notify(p, 'digest', `${d.project}: ${d.headline}`, { slack: slack.digestBlocks(d, p.origin ? `${p.origin}/app#p=${encodeURIComponent(p.name)}` : '') });
    p.digestState = { at: d.at, lastDate: localParts(d.at, c.tz).date, cost: d._cost };
    p.emit('digest', { id: d.id, popup: c.popup });
    p.dirty = true;
    return sent;
  }
  function maybeDigest(p) {
    if (!digestDueAt(p, now())) return;
    const d = buildDigest(p);
    if (d.quiet) { p.digestState = { at: d.at, lastDate: localParts(d.at, digestCfg(p).tz).date, cost: d._cost }; p.emit('digest', { quiet: true }); return; }
    deliverDigest(p, d);
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
    delete j.tokenHash; delete j.secretHooks; delete j.secretRepo; delete j.secretSlack; delete j.slackCodes; delete j.slackUsers; delete j.keys; delete j.outbox; delete j.mailQueue; delete j.events; delete j.nudged; delete j.repoCache;
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


  // ---------- automations: things that start by themselves ----------
  // A schedule starts a request at the same time on chosen days ("every weekday at 9: triage the new
  // issues"). GitHub can start one too: put the trigger label (default "huddle") on an issue, or comment
  // "/huddle <what to do>" on an issue or pull request. Whoever's agent gets it runs it; point them at an
  // always-on worker (huddle worker) and it runs with every laptop closed.
  const MAX_AUTOMATIONS = 20;
  const triggerCfg = (p) => ({ github: false, label: 'huddle', to: null, ack: true, ...(((p.projectSettings || {}).trigger) || {}) });
  function scheduleDue(a, t) {
    if (!a.enabled) return false;
    const lp = localParts(t, a.tz || 'UTC');
    if (a.days === 'weekdays' && (lp.weekday === 'Sat' || lp.weekday === 'Sun')) return false;
    if (a.days === 'weekly' && lp.weekday !== 'Mon') return false;
    return lp.hour >= a.hour && a.lastDate !== lp.date;
  }
  function startFrom(p, who, text, to, title, extra = {}) {
    const r = h.routes['POST goal'](p, { agent: { id: 'auto#' + who.id, name: who.name, kind: 'human', host: who.host || 'automation' }, text, to: to || null, title });
    Object.assign(r.goal, extra);
    p.dirty = true; p.board.version++;
    return r.goal;
  }
  function runSchedule(p, a) {
    a.lastDate = localParts(now(), a.tz || 'UTC').date; a.lastRun = now();
    // last time's request is still open: don't pile another on top
    if (p.board.goals.some(g => g.automation === a.id && g.status !== 'done')) { a.skipped = (a.skipped || 0) + 1; p.emit('automation', { id: a.id, skipped: true }); return null; }
    const g = startFrom(p, { id: a.id, name: `${clip(a.name, 30)} (scheduled)` }, a.text, a.to, clip(a.name, 80), { automation: a.id });
    audit(p, 'schedule', 'automation', `started “${a.name}”${a.to ? ' for ' + a.to : ' for the team'}`);
    p.emit('automation', { id: a.id });
    return g;
  }
  function maybeAutomations(p) {
    for (const a of p.automations || []) if (scheduleDue(a, now())) runSchedule(p, a);
  }
  function nextAutomationAt(p) {
    const list = (p.automations || []).filter(a => a.enabled);
    if (!list.length) return null;
    const key = JSON.stringify(list.map(a => [a.id, a.hour, a.tz, a.days, a.lastDate]));
    if (p._na && p._na.key === key && p._na.at > now()) return p._na.at;
    let best = null;
    for (const a of list) for (let t = now(); t < now() + 9 * 86400000; t += 15 * 60000) if (scheduleDue(a, t)) { best = best === null ? t : Math.min(best, t); break; }
    p._na = { key, at: best };
    return best;
  }
  const nextWakeAt = (p) => { const a = nextDigestAt(p), b = nextAutomationAt(p); return a && b ? Math.min(a, b) : a || b; };
  // "/huddle fix the login redirect" on a GitHub issue or pull request, or the trigger label on an issue
  function githubStart(p, ev) {
    const t = triggerCfg(p), r = repoOf(p);
    if (!t.github || !r) return null;
    const issue = ev.issue || {};
    const num = issue.number;
    if (!num || p.board.goals.some(g => g.source && g.source.repo === r.full && g.source.number === num && g.status !== 'done')) return null;
    let text = '', by = ev.sender && ev.sender.login || 'github';
    if (ev.kind === 'label') {
      text = `${issue.title}\n\n${clip(issue.body, 3000) || ''}`.trim();
    } else {
      const c = ev.comment || {};
      if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(c.author_association)) return null;
      const m = /^\s*\/huddle\b\s*([\s\S]*)$/i.exec(c.body || '');
      if (!m) return null;
      text = m[1].trim() || `${issue.title}\n\n${clip(issue.body, 3000) || ''}`.trim();
      by = (c.user && c.user.login) || by;
    }
    const person = personForGithub(p, by) || null;
    const isPr = !!issue.pull_request;
    const goalText = `${text}\n\n(From GitHub ${isPr ? 'pull request' : 'issue'} #${num}${issue.html_url ? ': ' + issue.html_url : ''})`.slice(0, 8000);
    const g = startFrom(p, { id: 'gh-' + by, name: person || by, host: 'github' }, goalText, t.to, clip(issue.title, 80), { source: { kind: 'github', repo: r.full, number: num, url: issue.html_url, isPr } });
    audit(p, by, 'automation', `started a request from GitHub #${num}`);
    const tok = repoToken(p);
    if (t.ack && tok) (p.outbox = p.outbox || []).push({ url: `https://api.github.com/repos/${r.full}/issues/${num}/comments`, headers: { authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json', 'user-agent': 'huddle' },
      body: { body: `Picked up by huddle${t.to ? `, assigned to ${t.to}'s agent` : ''}. ${p.origin ? p.origin + '/app#p=' + encodeURIComponent(p.name) : ''}`.trim() } });
    return g;
  }
  // a request that came from GitHub says so back there when it's finished
  function githubDone(p, g, t) {
    const s2 = g.source, tok = repoToken(p), cfg = triggerCfg(p);
    if (!s2 || s2.kind !== 'github' || !tok || !cfg.ack) return;
    const pr = (p.board.tasks.filter(x => x.goalId === g.id).map(x => x.checks && x.checks.pr).filter(Boolean))[0];
    const last = t && t.notes && t.notes.length ? t.notes[t.notes.length - 1].text : '';
    (p.outbox = p.outbox || []).push({ url: `https://api.github.com/repos/${s2.repo}/issues/${s2.number}/comments`, headers: { authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json', 'user-agent': 'huddle' },
      body: { body: `Done.${pr ? ' Pull request: ' + pr : ''}${last ? '\n\n' + clip(last, 400) : ''}` } });
  }


  // ---------- Slack ----------
  const hookLabelOf = (url) => { try { const u = new URL(url); return `${u.host}/…${url.slice(-4)}`; } catch { return 'webhook'; } };
  const slackOn = (p) => !!(p.secretSlack && p.secretSlack.signingSecret);
  const hashCode = async (code) => { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('slack:' + code)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 24); };
  const newCode = () => crypto.randomBytes(5).toString('hex').toUpperCase();
  const slackRequest = async (p, ctx) => {
    const sl = p.secretSlack, req = ctx.request || {};
    if (!sl || !sl.signingSecret) throw httpError(404, 'Slack is not set up for this project');
    if (!(await slack.verify(sl.signingSecret, req.raw || '', req.header('x-slack-request-timestamp'), req.header('x-slack-signature')))) throw httpError(401, 'bad Slack signature');
  };
  const eph = (text) => ({ response_type: 'ephemeral', text });
  const channelOk = (p, teamId, channelId) => !!(p.slack && p.slack.channelId && p.slack.channelId === channelId && p.slack.teamId === teamId);
  const slackWho = (p, f) => { const mapped = (p.slackUsers || {})[f.user_id]; return mapped ? { name: mapped, mapped: true } : { name: `${clip(f.user_name, 30) || 'someone'} (Slack)`, mapped: false }; };
  function slackStatus(p) {
    const tasks = p.board.tasks, stuck = tasks.filter(t => t.status === 'blocked'), doing = tasks.filter(t => t.status === 'doing'), todo = tasks.filter(t => t.status === 'todo');
    const online = [...new Set(Object.values(p.agents).filter(a => p.online(a) && a.kind !== 'human' && !a.clone).map(a => a.name))];
    const lines = [`*${prettyProject(p)}*: ${doing.length} in progress, ${todo.length} waiting, ${stuck.length} stuck. ${online.length ? 'Online: ' + online.join(', ') + '.' : 'Nobody online.'}`];
    for (const t of stuck.slice(0, 4)) lines.push(`• Stuck: ${slack.esc(clip(t.title, 80))}${t.owner ? ` (${t.owner})` : ''}`);
    for (const t of doing.slice(0, 4)) lines.push(`• ${slack.esc(clip(t.title, 80))}${t.owner ? ` (${t.owner})` : ''}`);
    const approvals = p.liveApprovals().length;
    if (approvals) lines.push(`${approvals} command${approvals === 1 ? '' : 's'} waiting for an OK.`);
    return lines.join('\n');
  }
  async function slackCommand(p, f) {
    const text = String(f.text || '').trim(), first = text.split(/\s+/)[0].toLowerCase();
    if (first === 'link') {
      const code = text.split(/\s+/)[1] || '';
      const rec = (p.slackCodes || {})[await hashCode(code)];
      if (!rec || rec.kind !== 'link' || rec.exp < now()) return eph("That link code didn't work or has expired. Make a new one in huddle: Team & settings, Integrations, Slack.");
      delete p.slackCodes[await hashCode(code)];
      p.slack = { ...(p.slack || {}), teamId: f.team_id, channelId: f.channel_id, channelName: clip(f.channel_name, 60), linkedAt: now(), by: rec.by };
      audit(p, rec.by, 'settings', `linked Slack channel #${p.slack.channelName || f.channel_id}`);
      p.emit('project-setting', { settings: p.projectSettings, byName: rec.by });
      return { response_type: 'in_channel', text: `Linked. Anyone here can now use /huddle to start requests and see status. Try \`/huddle status\`.` };
    }
    if (first === 'iam') {
      const code = text.split(/\s+/)[1] || '';
      const rec = (p.slackCodes || {})[await hashCode(code)];
      if (!rec || rec.kind !== 'me' || rec.exp < now()) return eph("That code didn't work or has expired. Get a new one in huddle: Team & settings, Integrations, Slack.");
      delete p.slackCodes[await hashCode(code)];
      p.slackUsers = { ...(p.slackUsers || {}), [f.user_id]: rec.name };
      p.dirty = true;
      return eph(`You're ${rec.name} in huddle now. You can approve your agent's commands from Slack.`);
    }
    if (!channelOk(p, f.team_id, f.channel_id)) return eph(p.slack && p.slack.channelId ? `huddle only works in the linked channel${p.slack.channelName ? ' (#' + p.slack.channelName + ')' : ''}.` : 'This project is not linked to a channel yet. In huddle: Team & settings, Integrations, Slack. Then run /huddle link CODE here.');
    if (!text || first === 'help') return eph('`/huddle <what to do>` starts a request for the team. `/huddle @maya <what to do>` sends it to one person\'s agent. `/huddle status` shows where things stand. `/huddle iam CODE` links your Slack account to your huddle name, so you can approve from here.');
    if (first === 'status') return { response_type: 'in_channel', text: slackStatus(p) };
    const who = slackWho(p, f);
    if (who.mapped && ((p.members || {})[who.name] || {}).role === 'viewer') return eph("You're a viewer in this project, so you can't start requests.");
    if (!who.mapped && (p.slack || {}).anyone === false) return eph('Link your Slack account first: /huddle iam CODE (get a code in huddle under Team & settings, Integrations).');
    const { to, text: ask } = slack.parseRequest(text, people(p));
    const g = startFrom(p, { id: 'slack-' + (f.user_id || who.name), name: who.name, host: 'slack' }, ask, to, requestTitle(ask), { source: { kind: 'slack', user: f.user_id } });
    audit(p, who.name, 'automation', `started a request from Slack${to ? ' for ' + to : ''}`);
    return { response_type: 'in_channel', text: `${who.name} asked ${to ? to + "'s agent" : 'the team'}: ${slack.esc(clip(ask, 300))}` };
  }
  // a button pressed in a Slack message
  async function slackInteract(p, payload) {
    const act = (payload.actions || [])[0] || {}, uid = (payload.user || {}).id, name = (p.slackUsers || {})[uid];
    const reply = (text, replace = true) => { if (payload.response_url && /^https:\/\/hooks\.slack\.com\//.test(payload.response_url)) (p.outbox = p.outbox || []).push({ url: payload.response_url, body: replace ? { replace_original: true, text } : { response_type: 'ephemeral', replace_original: false, text } }); };
    if (!name) { reply("Link your Slack account first: run /huddle iam CODE (get a code in huddle under Team & settings, Integrations, Slack).", false); return {}; }
    const role = ((p.members || {})[name] || {}).role;
    if (role === 'viewer') { reply("Viewers can't do that.", false); return {}; }
    if (['approve', 'decline'].includes(act.action_id)) {
      const x = (p.approvals || []).find(y => y.id === act.value);
      if (!x) { reply('That approval is gone.', false); return {}; }
      if (x.owner !== name) { reply(`Only ${x.owner} can approve their agent's commands.`, false); return {}; }
      if (x.status !== 'waiting') { reply(`Already ${x.status}.`); return {}; }
      const allow = act.action_id === 'approve';
      const rule = allow && deniedBy((p.projectSettings || {}).policy, x.command);
      if (rule) { reply(`\`${x.command}\` is never allowed in this project (rule: ${rule}).`, false); return {}; }
      x.status = allow ? 'approved' : 'denied'; x.by = name; x.decidedAt = now();
      audit(p, name, 'approve', `${allow ? 'allowed' : 'refused'} \`${x.command}\`${x.title ? ` for "${x.title}"` : ''} (from Slack)`);
      const t = p.board.tasks.find(y => y.id === x.taskId);
      if (t) {
        if (allow) { t.allow = [...new Set([...(t.allow || []), x.command])].slice(-10); t.status = 'todo'; t.held = null; }
        t.notes = [...(t.notes || []), { by: name, at: now(), text: `${allow ? 'Allowed' : 'Said no to'}: ${x.command}` }].slice(-20); t.updated = now();
        boardChanged(p, 'approve', { task: t, approval: x }, { name });
      }
      p.emit('approval', { approval: x });
      reply(`${allow ? ':white_check_mark: Approved' : ':no_entry: Declined'} by ${name}: \`${x.command}\``);
      return {};
    }
    if (['rerun', 'done'].includes(act.action_id)) {
      const t = p.board.tasks.find(y => y.id === act.value);
      if (!t) { reply('That task is gone.', false); return {}; }
      t.status = act.action_id === 'done' ? 'done' : 'todo'; t.updated = now(); if (act.action_id === 'rerun') t.limitHit = false;
      t.notes = [...(t.notes || []), { by: name, at: now(), text: act.action_id === 'done' ? `${name} marked it done from Slack` : `${name} asked for it to run again from Slack` }].slice(-20);
      goalDone(p, t); boardChanged(p, 'task-update', { task: t }, { name });
      reply(`${act.action_id === 'done' ? ':white_check_mark: Marked done' : ':repeat: Running again'} by ${name}: ${slack.esc(clip(t.title, 80))}`);
      return {};
    }
    return {};
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
    } else if (event === 'issues' && b.action === 'labeled' && b.label && String(b.label.name).toLowerCase() === String(triggerCfg(p).label).toLowerCase()) {
      const g = githubStart(p, { kind: 'label', issue: b.issue, sender: b.sender });
      repoEvent(p, { action: 'issue', number: (b.issue || {}).number, title: (b.issue || {}).title, url: (b.issue || {}).html_url, by: b.sender && b.sender.login, started: !!g });
    } else if (event === 'issue_comment' && b.action === 'created') {
      const g = githubStart(p, { kind: 'comment', issue: b.issue, comment: b.comment, sender: b.sender });
      if (!g) return { ok: true, ignored: 'comment' };
    } else if (event === 'issues' && ['opened', 'reopened'].includes(b.action)) {
      const i = b.issue || {};
      repoEvent(p, { action: 'issue', number: i.number, title: i.title, url: i.html_url, by: i.user && i.user.login });
    } else return { ok: true, ignored: event };
    return { ok: true };
  }

  // ---------- routes ----------
  return {
    NOTE_KINDS, notePerson, flushMail, applyRetention, chargeUsage, prefsOf, monthSpend, maybeDigest, nextDigestAt, nextWakeAt, slackApprovalBlocks: slack.approvalBlocks, slackStuckBlocks: slack.stuckBlocks, maybeAutomations, githubDone, conflictAware, guessPaths, pathsOverlap,
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
        if (b.alerts && typeof b.alerts === 'object') {
          const al = b.alerts, cur = costAlertCfg(p), n = (v, lo, hi, d) => { const x = Number(v); return isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
          ps.costAlerts = { spike: al.spike !== undefined ? !!al.spike : cur.spike, forecast: al.forecast !== undefined ? !!al.forecast : cur.forecast, task: al.task !== undefined ? !!al.task : cur.task,
            spikeMultiple: n(al.spikeMultiple, 1.2, 20, cur.spikeMultiple), spikeMinUsd: n(al.spikeMinUsd, 0, 100000, cur.spikeMinUsd), taskUsd: n(al.taskUsd, 0.5, 100000, cur.taskUsd) };
        }
        audit(p, a.name, 'settings', `cost settings: ${ps.budget ? `budget $${ps.budget.monthly}/month, alert at ${ps.budget.alertPct}%` : 'no budget'}${ps.prices && Object.keys(ps.prices).length ? `; custom prices for ${Object.keys(ps.prices).join(', ')}` : ''}`);
        p.emit('project-setting', { settings: ps, byName: a.name });
        return { ok: true, settings: ps };
      },



      // ---- reviewing what an agent changed ----
      // The runner uploads the diff of each background task (base to head, before it lands), so anyone can
      // read it afterwards, comment on lines, approve it, ask for changes (the task runs again with the
      // comments) or merge work that was left on its own branch.
      'POST task-diff': async (p, b, q, ctx) => {
        const a = p.touch(b.agent);
        const t = p.board.tasks.find(x => x.id === b.taskId);
        if (!t) throw httpError(404, 'no such task');
        if (t.owner !== a.name && (ctx.auth || {}).role !== 'owner') throw httpError(403, 'only the agent that did the task can share its changes');
        t.diff = t.diff || { at: now() };
        if (typeof b.diff === 'string') {
          const text = b.diff.slice(0, 500 * 1024);
          if (ctx.blobs) await ctx.blobs.put(`diff:${t.id}`, text);
          const files = (Array.isArray(b.files) ? b.files : []).slice(0, 300).map(f => ({ path: clip(f.path, 300), add: Number(f.add) || 0, del: Number(f.del) || 0, binary: !!f.binary }));
          t.diff = { ...t.diff, at: now(), base: clip(b.base, 40), head: clip(b.head, 40), files, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0), truncated: !!b.truncated || b.diff.length > text.length, review: null };
        }
        if (b.branch !== undefined) t.diff.branch = clip(b.branch, 200);
        if (b.left !== undefined) t.diff.left = !!b.left;
        p.boardChanged = true;
        boardChanged(p, 'task-update', { task: t }, a);
        return { ok: true };
      },
      'GET task-diff': async (p, b, q, ctx) => {
        const t = p.board.tasks.find(x => x.id === q.get('id'));
        if (!t || !t.diff) throw httpError(404, 'that task has no changes to show');
        const diff = ctx.blobs ? await ctx.blobs.get(`diff:${t.id}`) : null;
        return { diff: diff || '', meta: t.diff, task: { id: t.id, title: t.title, owner: t.owner, status: t.status } };
      },
      // approve, or send comments back: the agent runs the task again with them
      'POST task-review': (p, b) => {
        const a = p.touch(b.agent);
        const t = p.board.tasks.find(x => x.id === b.id);
        if (!t || !t.diff) throw httpError(404, 'that task has no changes to review');
        const comments = (Array.isArray(b.comments) ? b.comments : []).slice(0, 40).map(c => ({ file: clip(c.file, 300), line: Number(c.line) || 0, text: clip(c.text, 600) })).filter(c => c.text);
        const note = String(b.note || '').trim().slice(0, 1500);
        if (b.verdict === 'approve') {
          t.diff.review = { verdict: 'approved', by: a.name, at: now() };
          t.notes = [...(t.notes || []), { by: a.name, at: now(), text: `${a.name} approved the changes${note ? ': ' + note : ''}` }].slice(-20);
        } else if (b.verdict === 'changes') {
          if (!comments.length && !note) throw httpError(400, 'say what should change');
          t.diff.review = { verdict: 'changes', by: a.name, at: now(), count: comments.length };
          t.feedback = [...(t.feedback || []), { by: a.name, at: now(), note, comments }].slice(-5);
          t.notes = [...(t.notes || []), { by: a.name, at: now(), text: `${a.name} asked for changes: ${note || comments.slice(0, 3).map(c => `${c.file}${c.line ? ':' + c.line : ''} ${c.text}`).join('; ')}` }].slice(-20);
          t.status = 'todo'; t.held = null; t.limitHit = false;
        } else throw httpError(400, 'verdict must be approve or changes');
        t.updated = now();
        audit(p, a.name, 'task', `${b.verdict === 'approve' ? 'approved' : 'asked for changes to'} the work on "${t.title}"`);
        boardChanged(p, 'task-update', { task: t }, a);
        if (t.owner && t.owner !== a.name) notePerson(p, t.owner, 'request', `${a.name} ${b.verdict === 'approve' ? 'approved' : 'asked for changes to'} your agent's work`, clip(t.title + (note ? ': ' + note : ''), 200), { view: 'tasks', task: t.id });
        return { ok: true, task: t };
      },
      // work that was left on its own branch (tests failed, or it didn't merge cleanly): merge it from the dashboard
      'POST task-merge': (p, b) => {
        const a = p.touch(b.agent);
        const t = p.board.tasks.find(x => x.id === b.id);
        if (!t || !t.diff || !t.diff.left) throw httpError(409, 'that work is not waiting on a branch');
        t.mergeRequested = now(); t.updated = now();
        t.notes = [...(t.notes || []), { by: a.name, at: now(), text: `${a.name} asked for the branch to be merged` }].slice(-20);
        boardChanged(p, 'merge-request', { task: t }, a);
        return { ok: true, task: t };
      },


      // ---- automations ----
      'GET automations': (p) => ({ automations: (p.automations || []).map(a => ({ ...a })), trigger: triggerCfg(p), repo: !!repoOf(p) }),
      'POST automation-set': (p, b) => {
        const a = p.touch(b.agent);
        p.automations = p.automations || [];
        if (b.remove) { p.automations = p.automations.filter(x => x.id !== b.remove); p._na = null; audit(p, a.name, 'automation', 'removed a schedule'); p.emit('automation', {}); return { ok: true, automations: p.automations }; }
        if (b.run) { const x = p.automations.find(y => y.id === b.run); if (!x) throw httpError(404, 'no such schedule'); x.lastDate = null; const g = runSchedule(p, x); return { ok: true, started: !!g, automations: p.automations }; }
        const text = String(b.text || '').trim().slice(0, 6000), name = clip(b.name || text.split('\n')[0], 80);
        if (!text) throw httpError(400, 'say what it should do');
        const hour = Number(b.hour); if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw httpError(400, 'hour must be 0 to 23');
        const tz = String(b.tz || 'UTC'); if (!validTz(tz)) throw httpError(400, 'unknown time zone');
        const days = ['daily', 'weekdays', 'weekly'].includes(b.days) ? b.days : 'weekdays';
        const to = b.to ? h.personFor(p, b.to) : null;
        let x = b.id && p.automations.find(y => y.id === b.id);
        if (!x) { if (p.automations.length >= MAX_AUTOMATIONS) throw httpError(413, 'that is a lot of schedules; remove some first'); x = { id: id(), kind: 'schedule', by: a.name, at: now(), lastDate: null }; p.automations.push(x); }
        Object.assign(x, { name, text, hour, tz, days, to, enabled: b.enabled !== false });
        p._na = null;
        audit(p, a.name, 'automation', `${b.id ? 'changed' : 'added'} the schedule “${name}”: ${days}, ${hour}:00 ${tz}${to ? ', for ' + to : ''}`);
        p.emit('automation', { id: x.id });
        return { ok: true, automation: x, automations: p.automations };
      },
      'POST trigger-settings': (p, b) => {
        const a = p.touch(b.agent);
        const cur = triggerCfg(p), next = { ...cur };
        if (b.github !== undefined) next.github = !!b.github;
        if (b.label !== undefined) { const l = clip(b.label, 40).replace(/[^\w .:-]/g, ''); if (!l) throw httpError(400, 'give the label a name'); next.label = l; }
        if (b.to !== undefined) next.to = b.to ? h.personFor(p, b.to) : null;
        if (b.ack !== undefined) next.ack = !!b.ack;
        if (next.github && !repoOf(p)) throw httpError(409, 'connect a GitHub repository first (Integrations)');
        p.projectSettings = { ...(p.projectSettings || {}), trigger: next };
        audit(p, a.name, 'settings', next.github ? `GitHub can start requests: label “${next.label}” or /huddle in a comment${next.to ? ', for ' + next.to : ''}` : 'GitHub no longer starts requests');
        p.emit('project-setting', { settings: p.projectSettings, byName: a.name });
        return { ok: true, trigger: next };
      },


      // ---- Slack ----
      'POST slack-command': async (p, b, q, ctx) => { await slackRequest(p, ctx); return slackCommand(p, Object.fromEntries(new URLSearchParams((ctx.request || {}).raw || ''))); },
      'POST slack-interact': async (p, b, q, ctx) => {
        await slackRequest(p, ctx);
        let payload = {};
        try { payload = JSON.parse(new URLSearchParams((ctx.request || {}).raw || '').get('payload') || '{}'); } catch { throw httpError(400, 'bad payload'); }
        return slackInteract(p, payload);
      },
      'GET slack': (p, b, q, ctx) => {
        const origin = p.origin || '';
        return { configured: slackOn(p), webhook: !!(p.secretHooks || []).find(x => x.slackApp), linked: !!(p.slack && p.slack.channelId), channelName: (p.slack || {}).channelName || null, anyone: (p.slack || {}).anyone !== false,
          people: Object.values(p.slackUsers || {}), mine: Object.values(p.slackUsers || {}).includes((ctx.auth || {}).name), createUrl: origin ? slack.createUrl(origin, p.name) : null, manifest: origin ? slack.manifest(origin, p.name) : null };
      },
      'POST slack-setup': (p, b) => {
        const a = p.touch(b.agent);
        if (b.remove) {
          delete p.secretSlack; p.slack = null; p.slackUsers = {}; p.slackCodes = {};
          p.secretHooks = (p.secretHooks || []).filter(x => !x.slackApp);
          audit(p, a.name, 'settings', 'disconnected Slack');
        } else {
          if (b.signingSecret !== undefined) { const v = String(b.signingSecret).trim(); if (!/^[0-9a-f]{20,64}$/i.test(v)) throw httpError(400, "that doesn't look like a Slack signing secret (Basic Information, App Credentials)"); p.secretSlack = { ...(p.secretSlack || {}), signingSecret: v }; }
          if (b.webhook !== undefined) {
            const url = String(b.webhook).trim();
            if (!/^https:\/\/hooks\.slack\.com\/services\/[\w/-]+$/.test(url)) throw httpError(400, 'give the Incoming Webhook URL (it starts with https://hooks.slack.com/services/)');
            p.secretHooks = (p.secretHooks || []).filter(x => !x.slackApp);
            p.secretHooks.push({ id: crypto.randomBytes(4).toString('hex'), kind: 'slack', url, events: ['approval', 'stuck', 'done', 'failed', 'budget', 'cost', 'digest'], by: a.name, at: now(), slackApp: true });
            const ps0 = p.projectSettings = p.projectSettings || {};
            ps0.notify = p.secretHooks.map(x => ({ id: x.id, kind: x.kind, events: x.events, label: x.slackApp ? 'Slack app' : hookLabelOf(x.url), by: x.by }));
          }
          if (b.anyone !== undefined) p.slack = { ...(p.slack || {}), anyone: !!b.anyone };
          audit(p, a.name, 'settings', 'changed the Slack connection');
        }
        p.emit('project-setting', { settings: p.projectSettings, byName: a.name });
        return { ok: true };
      },
      'POST slack-code': async (p, b, q, ctx) => {
        const a = p.touch(b.agent);
        const kind = b.kind === 'link' ? 'link' : 'me';
        if (kind === 'link' && (ctx.auth || {}).role !== 'owner') throw httpError(403, 'only the project owner can link a channel');
        if (kind === 'me' && a.transient) throw httpError(400, 'pick a name first');
        const code = newCode();
        p.slackCodes = p.slackCodes || {};
        for (const [k, v] of Object.entries(p.slackCodes)) if (v.exp < now()) delete p.slackCodes[k];
        p.slackCodes[await hashCode(code)] = { kind, name: a.name, by: a.name, exp: now() + 15 * 60000 };
        return { ok: true, code, expires: now() + 15 * 60000, command: `/huddle ${kind === 'link' ? 'link' : 'iam'} ${code}` };
      },

      // ---- the daily digest ----
      'GET digests': (p, b, q, ctx) => {
        const me = (ctx.auth || {}).name, cfg = digestCfg(p);
        const recipient = (ctx.auth || {}).role === 'owner' || (!!me && digestRecipients(p).includes(me));
        return { settings: cfg, recipient, recipients: digestRecipients(p).length, everyone: people(p).length, digests: recipient ? (p.digests || []).slice(-14) : [] };
      },
      'POST digest-settings': (p, b) => {
        const a = p.touch(b.agent);
        const cur = digestCfg(p), next = { ...cur };
        if (b.enabled !== undefined) next.enabled = !!b.enabled;
        if (b.to !== undefined) { if (!['owners', 'everyone'].includes(b.to)) throw httpError(400, 'send to owners or everyone'); next.to = b.to; }
        if (b.email !== undefined) next.email = !!b.email;
        if (b.popup !== undefined) next.popup = !!b.popup;
        if (b.slack !== undefined) next.slack = !!b.slack;
        if (b.weekdaysOnly !== undefined) next.weekdaysOnly = !!b.weekdaysOnly;
        if (b.hour !== undefined) { const h = Number(b.hour); if (!Number.isInteger(h) || h < 0 || h > 23) throw httpError(400, 'hour must be 0 to 23'); next.hour = h; }
        if (b.tz !== undefined) { if (!validTz(String(b.tz))) throw httpError(400, 'unknown time zone'); next.tz = String(b.tz); }
        if (next.enabled && !next.email && !next.popup && !next.slack) throw httpError(400, 'choose email, a dashboard pop-up, Slack, or a mix');
        p.projectSettings = { ...(p.projectSettings || {}), digest: next };
        p._nd = null;
        audit(p, a.name, 'settings', next.enabled ? `daily digest on: to ${next.to}, ${[next.email && 'email', next.popup && 'pop-up'].filter(Boolean).join(' and ')}, at ${next.hour}:00 ${next.tz}${next.weekdaysOnly ? ', weekdays' : ''}` : 'daily digest off');
        p.emit('project-setting', { settings: p.projectSettings, byName: a.name });
        return { ok: true, settings: next };
      },
      // a preview only the owner sees, or send today's digest to its recipients right now
      'POST digest-now': (p, b) => {
        const a = p.touch(b.agent);
        const d = buildDigest(p);
        if (!b.deliver) return { ok: true, preview: true, digest: stripDigest(d) };
        const sent = deliverDigest(p, d);
        audit(p, a.name, 'settings', `sent the daily digest now to ${sent.people} ${sent.people === 1 ? 'person' : 'people'}`);
        return { ok: true, digest: stripDigest(d), sent };
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

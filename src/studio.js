// Routes for making things together, games especially: a gallery of screenshots and images (kept out
// of the activity feed), playable builds with their full links, a timeline of goals with a plan every
// agent works from, and hand-offs when an asset saved in one tool (Blender) is ready for the engine
// (Unity, Godot). core.js hands in the helpers it shares, like features.js.
'use strict';
const crypto = require('crypto');

const MAX_MEDIA = 200;                 // newest kept; older images are deleted with their data
const MEDIA_BYTES = 900 * 1024;        // one image, raw (stored as one blob piece)
const MAX_BUILDS = 100;
const MAX_MILESTONES = 40;
const PLAN_BYTES = 16 * 1024;
const ENGINES = ['unity', 'godot'];
const LABEL = { unity: 'Unity', godot: 'Godot', blender: 'Blender', figma: 'Figma' };
const IMAGE = /^image\/(png|jpeg|webp|gif)$/;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// what the agents are told about the timeline: the next deadlines, how long is left, and the plan. It's
// information so everyone knows where things stand; it doesn't change how agents work.
function briefing(p, at = Date.now()) {
  const t = p.timeline;
  if (!t || (!t.milestones.length && !t.plan)) return '';
  const open = t.milestones.filter(m => !m.done).sort((a, b) => a.due - b.due);
  const left = (ms) => { const m = Math.round((ms - at) / 60000); return m < 0 ? `${-m < 120 ? -m + ' min' : Math.round(-m / 60) + ' h'} overdue` : m < 120 ? `${m} min left` : m < 2880 ? `${Math.round(m / 60)} h left` : `${Math.round(m / 1440)} days left`; };
  const lines = ['Team deadlines (set in the huddle dashboard, so everyone knows where things stand):'];
  for (const m of open.slice(0, 5)) lines.push(`- ${m.title}: due ${new Date(m.due).toISOString().slice(0, 16).replace('T', ' ')} UTC (${left(m.due)})${m.detail ? ', ' + clip(m.detail, 160) : ''}`);
  const done = t.milestones.filter(m => m.done).length;
  if (done) lines.push(`(${done} deadline${done === 1 ? '' : 's'} already met)`);
  if (t.plan && t.plan.text) lines.push('Plan:\n' + t.plan.text.slice(0, 1600));
  return lines.join('\n');
}


function studio(h) {
  const { httpError, now, pushTask, boardChanged, assignByUsage, notify } = h;
  const id = () => crypto.randomBytes(4).toString('hex');
  const timeline = (p) => (p.timeline = p.timeline || { milestones: [], plan: null, version: 0 });

  const routes = {
    // ---- gallery ----
    'GET media': (p) => ({ media: p.media || [] }),
    'GET media-file': async (p, b, q, ctx) => {
      const m = (p.media || []).find(x => x.id === q.get('id'));
      if (!m) throw httpError(404, 'no such image');
      return { id: m.id, mime: m.mime, data: await ctx.blobs.get('media:' + m.id) };
    },
    'POST media': async (p, b, q, ctx) => {
      const a = p.touch(b.agent);
      const mime = String(b.mime || '');
      if (!IMAGE.test(mime)) throw httpError(400, 'png, jpeg, webp or gif only');
      const data = String(b.data || '').replace(/^data:[^,]*,/, '');
      if (Math.floor(data.length * 3 / 4) > MEDIA_BYTES) throw httpError(413, 'keep an image under 900 KB');
      const m = { id: id(), by: a.name, at: now(), mime, size: Math.floor(data.length * 3 / 4), caption: clip(b.caption, 300),
        source: clip(b.source, 60), task: b.task ? String(b.task).slice(0, 20) : null, bg: !!a.clone };
      await ctx.blobs.put('media:' + m.id, data);
      p.media = [...(p.media || []), m];
      while (p.media.length > MAX_MEDIA) { const old = p.media.shift(); if (ctx.blobs.del) await ctx.blobs.del('media:' + old.id); }
      p.emit('media', { media: m });
      p.dirty = true;
      return { ok: true, media: m };
    },
    'POST media-delete': async (p, b, q, ctx) => {
      const a = p.touch(b.agent);
      const m = (p.media || []).find(x => x.id === b.id);
      if (!m) throw httpError(404, 'no such image');
      p.media = p.media.filter(x => x !== m);
      if (ctx.blobs.del) await ctx.blobs.del('media:' + m.id);
      p.emit('media', { removed: m.id, byName: a.name });
      p.dirty = true;
      return { ok: true };
    },

    // ---- builds ----
    'GET builds': (p) => ({ builds: p.builds || [] }),
    'POST build': (p, b) => {
      const a = p.touch(b.agent);
      const url = String(b.url || '').trim();
      if (!/^https?:\/\/[^\s]+$/i.test(url) || url.length > 1000) throw httpError(400, 'a build needs an http(s) link');
      const x = { id: id(), url, title: clip(b.title, 120) || 'Build', platform: clip(b.platform, 30), notes: clip(b.notes, 600), by: a.name, at: now(), bg: !!a.clone };
      p.builds = [...(p.builds || []), x].slice(-MAX_BUILDS);
      p.emit('build', { build: x });
      notify(p, 'done', `New build from ${a.name}: ${x.title} ${x.url}`);
      p.dirty = true;
      return { ok: true, build: x };
    },
    'POST build-delete': (p, b) => {
      const a = p.touch(b.agent);
      if (!(p.builds || []).some(x => x.id === b.id)) throw httpError(404, 'no such build');
      p.builds = p.builds.filter(x => x.id !== b.id);
      p.emit('build', { removed: b.id, byName: a.name });
      p.dirty = true;
      return { ok: true };
    },

    // ---- timeline ----
    'GET timeline': (p) => ({ timeline: timeline(p), briefing: briefing(p) }),
    'POST timeline-milestone': (p, b) => {
      const a = p.touch(b.agent);
      const t = timeline(p);
      if (b.remove) t.milestones = t.milestones.filter(m => m.id !== b.id);
      else {
        let m = b.id && t.milestones.find(x => x.id === b.id);
        if (!m) {
          if (t.milestones.length >= MAX_MILESTONES) throw httpError(413, `keep it to ${MAX_MILESTONES} goals`);
          m = { id: id(), done: false, by: a.name, at: now() };
          t.milestones.push(m);
        }
        if (b.title !== undefined) m.title = clip(b.title, 140);
        if (!m.title) { t.milestones = t.milestones.filter(x => x !== m); throw httpError(400, 'a goal needs a name'); }
        if (b.due !== undefined) { const d = Number(b.due); if (!(d > 0)) throw httpError(400, 'a goal needs a date and time'); m.due = d; }
        if (!m.due) { t.milestones = t.milestones.filter(x => x !== m); throw httpError(400, 'a goal needs a date and time'); }
        if (b.detail !== undefined) m.detail = clip(b.detail, 600);
        if (b.done !== undefined) { m.done = !!b.done; m.doneAt = m.done ? now() : null; m.doneBy = m.done ? a.name : null; }
      }
      t.milestones.sort((x, y) => x.due - y.due);
      t.version++;
      p.emit('timeline', { timeline: t, byName: a.name });
      p.dirty = true;
      return { ok: true, timeline: t };
    },
    'POST timeline-plan': (p, b) => {
      const a = p.touch(b.agent);
      const t = timeline(p);
      const text = String(b.text || '').trim();
      if (Buffer.byteLength(text) > PLAN_BYTES) throw httpError(413, 'keep the plan under 16 KB');
      t.plan = text ? { text, by: a.name, at: now() } : null;
      t.version++;
      p.emit('timeline', { timeline: t, byName: a.name });
      p.dirty = true;
      return { ok: true, timeline: t };
    },
    // an agent drafts the plan from the goals, the brief and the board; it arrives as a request
    'POST timeline-draft': (p, b) => {
      const a = p.touch(b.agent);
      const t = timeline(p);
      if (!t.milestones.length) throw httpError(400, 'add a goal with a date first');
      const task = pushTask(p, { title: 'Draft the team timeline plan', effort: 'light', owner: b.to || null,
        detail: 'Read the team timeline with huddle_timeline, the project brief, and the board. Write a short plan that gets the team to each goal in time: ' +
          'for each goal, what has to be true by then, in what order to build it, and roughly who (by area, not by name unless the brief says). ' +
          'Keep it to plain lines under the goal names, cut anything that won\'t fit the time, and leave the last stretch before each deadline for fixing and a build. ' +
          'Save it with huddle_timeline (plan). Do not change any code.' + (b.note ? `\n\nFrom ${a.name}: ${clip(b.note, 400)}` : '') }, a);
      if (!task.owner) assignByUsage(p, [task], null);
      boardChanged(p, 'task', { task }, a);
      return { ok: true, task };
    },

    // ---- asset hand-off: saved in one tool, wanted in the engine ----
    'POST asset': (p, b) => {
      const a = p.touch(b.agent);
      const from = String(b.from || '');
      const paths = (Array.isArray(b.paths) ? b.paths : []).map(x => String(x).slice(0, 300)).filter(Boolean).slice(0, 20);
      if (!paths.length) throw httpError(400, 'which files?');
      p.assets = [...(p.assets || []), ...paths.map(x => ({ path: x, from, by: a.name, at: now() }))].slice(-200);
      const engines = ((p.projectSettings || {}).apps || []).filter(x => ENGINES.includes(x));
      if (!engines.length || ENGINES.includes(from)) { p.dirty = true; return { ok: true, task: null }; }
      const engine = engines[0];
      // the same file already waiting: note the new save there instead of opening another task
      const open = p.board.tasks.find(t => t.asset && t.status !== 'done' && paths.some(x => t.asset.includes(x)));
      if (open) { open.updated = now(); p.dirty = true; return { ok: true, task: open, again: true }; }
      const use = (p.editorUse || {})[engine] || {};
      const owner = Object.entries(use).filter(([n]) => n !== a.name).sort((x, y) => y[1] - x[1]).map(x => x[0])[0] || null;
      const names = paths.map(x => x.split('/').pop());
      const task = pushTask(p, { title: `Bring ${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''} into ${LABEL[engine]}`, effort: 'light', owner,
        detail: `${a.name}'s agent saved ${paths.join(', ')} in ${LABEL[from] || from}. Import ${paths.length > 1 ? 'them' : 'it'} into the ${LABEL[engine]} project ` +
          `(export to a format ${LABEL[engine]} reads if needed, keep the folder layout the project already uses), set up materials and scale, ` +
          `and place ${paths.length > 1 ? 'them' : 'it'} where the brief or the request says. Ask ${a.name} with huddle_send if it's unclear where it goes.`,
        paths: [] }, a);
      task.asset = paths;
      task.editor = engine;   // needs the editor, so a person's own session does it, not a background run
      if (!owner) assignByUsage(p, [task], null);
      boardChanged(p, 'task', { task }, a);
      return { ok: true, task };
    },
    // who works in which editor, so hand-offs reach someone with it open
    'POST editor-use': (p, b) => {
      const a = p.touch(b.agent);
      const app = String(b.app || '');
      if (!LABEL[app]) throw httpError(400, 'unknown editor');
      p.editorUse = p.editorUse || {};
      (p.editorUse[app] = p.editorUse[app] || {})[a.name] = now();
      p.dirty = true;
      return { ok: true };
    },
  };
  return { routes, briefing };
}
studio.briefing = briefing;
module.exports = studio;

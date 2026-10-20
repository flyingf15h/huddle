// Words, times and markdown, carried over from the old single-file dashboard (web/legacy).
// Pure functions only; anything that reads project state lives in state.js.
let teamNames = [];
export const setTeamNames = (n) => { teamNames = n; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 45 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fullDate = (t) => new Date(t).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} }, del(k) { try { localStorage.removeItem(k); } catch {} } };
// distinct, white-text-safe colours so people are easy to tell apart
// light pinks, each with its own deep letter colour, so people are still easy to tell apart
const color = (name) => { let h = 2166136261; for (const c of String(name)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return [(h >>> 0) % 360]; };
function shortTitle(text, n = 62) {
  let t = String(text || '').split('\n').map(l => l.trim()).find(Boolean) || '';
  for (let k = 0; k < 3; k++) {
    t = t.replace(/^(hey|hi|ok(ay)?|so|alright|also)[,!\s]+/i, '').replace(/^(can|could|would|will) you( please)?\s+/i, '')
      .replace(/^(i want|i'd like|i would like|i need)( you)? to\s+/i, '').replace(/^(please|pls|go ahead and|let's|lets)\s+/i, '')
      .replace(/^(check|look at) my [\w-]+ (tool|app|project|repo)[.,]?\s+/i, '').replace(/^set it (up )?so (that )?/i, '').replace(/^make it so (that )?/i, '');
  }
  const cut = t.match(/^.{14,}?(?=[.;!?](\s|$)|,\s+(and|then|also|but|so|plus)\b|\s+(and then|and also|as well as)\s)/i);
  if (cut) t = cut[0];
  t = t.replace(/[\s,:;-]+$/, '');
  if (t.length > 40) {
    const m = t.match(/^(.{16,}?)\s+(so( that| they| it)?|with|for|by|using|in order to|which|that|because|instead of)\s/i);
    if (m) t = m[1];
  }
  if (t.length > n) t = t.slice(0, n).replace(/\s+\S*$/, '') + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}
const EFFORT_WORD = { light: 'Small', medium: 'Medium', heavy: 'Big' };
const statusWord = (s) => ({ todo: 'To do', doing: 'In progress', done: 'Done', blocked: 'Blocked', open: 'Waiting for a plan', planning: 'Being planned', planned: 'In progress' }[s] || s);
// what a tool call means, in plain words
function toolWords(text) {
  const m = /^([\w-]+)(?::\s*([\s\S]*))?$/.exec(text || '');
  const tool = m ? m[1] : '', arg = m && m[2] ? m[2] : '';
  const verbs = { Edit: 'edited', MultiEdit: 'edited', Write: 'wrote', NotebookEdit: 'edited', Read: 'read', Bash: 'ran',
    Grep: 'searched', Glob: 'looked for', WebFetch: 'opened', WebSearch: 'searched web', Task: 'helper', Agent: 'helper',
    TodoWrite: 'planned', Skill: 'skill' };
  if (tool.startsWith('huddle_')) {
    const h = { huddle_send: 'messaged the team', huddle_status: 'checked the team', huddle_set_status: 'set its status', huddle_activity: "checked others' work",
      huddle_lock: 'locked', huddle_unlock: 'released its files', huddle_wait: 'waited for', huddle_view: 'looked at', huddle_board: 'checked tasks',
      huddle_plan: 'planned the tasks', huddle_claim_goal: 'took on planning', huddle_claim_task: 'took a task', huddle_update_task: 'updated a task',
      huddle_remember: 'saved a memory', huddle_recall: 'checked team memory', huddle_project: 'read the brief', huddle_merge: 'merged',
      huddle_publish: 'shared its branch', huddle_branches: 'checked branches', huddle_ask_team: 'asked the team', huddle_save_skill: 'shared a skill', huddle_autopilot: 'autopilot' }[tool] || tool.replace('huddle_', '');
    return { verb: h, arg: ['huddle_lock', 'huddle_wait', 'huddle_view', 'huddle_merge', 'huddle_remember', 'huddle_ask_team'].includes(tool) ? arg : '' };
  }
  return { verb: verbs[tool] || tool, arg, code: tool === 'Bash' };
}
// one line: the reply's first sentence or line, without markdown
function summarize(text) {
  const t = String(text || '').trim();
  const first = (t.split('\n').map(l => l.replace(/^#+\s*|^[-*]\s+|\*\*|`/g, '').trim()).find(Boolean) || '');
  const sentence = (first.match(/^.{20,}?[.!?](\s|$)/) || [first])[0].trim();
  return sentence.length > 160 ? sentence.slice(0, 157).replace(/\s+\S*$/, '') + '…' : sentence;
}
// small markdown renderer for briefs, memories and replies
function md(text) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  const out = [];
  let list = null, code = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of String(text).split('\n')) {
    if (code !== null) { if (/^```/.test(line)) { out.push(`<pre class="codebox" style="padding:8px 12px">${esc(code)}</pre>`); code = null; } else code += (code ? '\n' : '') + line; continue; }
    if (/^```/.test(line)) { close(); code = ''; continue; }
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) { close(); const n = Math.min(h[1].length + 2, 6); out.push(`<h${n} style="margin:16px 0 6px">${inline(h[2])}</h${n}>`); continue; }
    const li = /^\s*([-*]|\d+\.)\s+(.*)/.exec(line);
    if (li) { const k = /\d/.test(li[1]) ? 'ol' : 'ul'; if (list !== k) { close(); out.push(`<${k} style="margin:4px 0;padding-left:22px">`); list = k; } out.push(`<li>${inline(li[2])}</li>`); continue; }
    close();
    if (line.trim()) out.push(`<p style="margin:6px 0">${inline(line)}</p>`);
  }
  close();
  if (code !== null) out.push(`<pre class="codebox">${esc(code)}</pre>`);
  return out.join('');
}
const SHOUT_KEEP = /^(?:\d\w*|[A-Z]{1,3}\d*)$/, SHOUT_WORDS = /^(THE|AND|FOR|NOT|ALL|ADD|USE|GET|SET|RUN|NEW|OLD|TOP|FIX|BUG|OUT|OFF|TWO|ONE|KEY|TAB|ON|TO|OF|IN|IT|IS|AT|BY|OR|A|AN|MY|NO|UP)$/;
function tidyTitle(t) {
  t = String(t || '');
  const names = teamNames.filter(Boolean).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (names.length) t = t.replace(new RegExp(`^(${names.join('|')})\\s*:\\s*`, 'i'), '');
  t = t.replace(/\s*\([^)]*(\)|$)/g, '').replace(/,?\s*(continuing|for|from|on top of)?\s*(goal|task|request|commit)\s+[0-9a-f]{7,40}\b/gi, '').replace(/\s+(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, '');
  // three or more capitalised words in a row read as shouting; acronyms like MCP or 2D stay
  t = t.replace(/\b[A-Z0-9][A-Z0-9'-]*(?:\s+[A-Z0-9][A-Z0-9'-]*)+\b/g, (run) => /[A-Z]{4}/.test(run) ? run.split(/\s+/).map(w => SHOUT_KEEP.test(w) && !SHOUT_WORDS.test(w) ? w : w.toLowerCase()).join(' ') : run)
    .replace(/\b(THE|AND|FOR|NOT|ALL)\b(?=\s+[a-z])/g, (w) => w.toLowerCase());
  t = t.replace(/\b(do|does|did|is|are|was|were|ca|wo|could|would|should|have|has)nt\b/gi, (w, a) => a + "n't");
  t = t.replace(/\s{2,}/g, ' ').replace(/[\s,:;-]+$/, '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function titleParts(raw) {
  const text = String(raw || '');
  const tag = ((/^\s*\[([^\]]{1,20})\]/.exec(text) || [])[1] || (/^\s*([A-Z][A-Z0-9-]{2,20})\s*[,:—–]/.exec(text) || [])[1] || '').trim();
  const handed = /^\s*from\b/i.test(text);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  let t = lines.shift() || '';
  for (let k = 0; k < 8; k++) {
    const before = t;
    t = t.replace(/^from [\w .'-]{1,40}?(\s*\([^)]{0,400}\))?\s*[:,.;—–-]\s*/i, '')
      .replace(/^[\w .'-]{1,30} asked (her|his|their|my|your) claude to [^:]{0,40}:\s*/i, '')
      .replace(/^(re|fwd?|task|request|todo|note)\s*:\s*/i, '')
      .replace(/^\[[^\]]{1,30}\]\s*/, '')
      .replace(/^[A-Z][A-Z0-9-]{2,20}\s*[,:—–-]\s*/, '')
      .replace(/^(task|part|step)\s*\d+\s*[,:.)-]\s*|^(\(?\d+[.)]|[-*•])\s+/i, '')
      .replace(/^(do not|don'?t) start (before|until)[^.;]*[.;]\s*/i, '')
      .replace(/^finish request [0-9a-f]{6,10}\s*\(["“]?([^"”)]+)["”]?\)[.:]?\s*/i, '$1. ');
    // what a Claude passing work on says about who asked: "Fei asked. …", "Fei asked me to pass this on: …"
    if (handed) t = t.replace(/^[\w '-]{1,30}? asked( me)?( to [^.:;]{0,160})?\s*[.:;,]\s*/i, '');
    // an intro to a list ("two things for Kelly's Claude:", "Fei's decisions:") is named by its first item
    if ((!t.trim() || /:\s*$/.test(t)) && lines.length && /^(\(?\d+[.)]|[-*•]|(task|part|step)\s*\d)/i.test(lines[0])) t = lines.shift();
    if (!t.trim() && lines.length) t = lines.shift();
    if (t === before) break;
  }
  const end = t.search(/[.?!;](\s|$)/);
  if (end > 12) t = t.slice(0, end);
  t = tidyTitle(t);
  return { title: shortTitle(t, 64) || shortTitle(tidyTitle(text), 64), tag: tag && !/^(RE|FWD|TODO|NOTE)$/i.test(tag) ? tag : '' };
}
// the first of these that still says something once cleaned (a stored title can be cut off right after
// its preamble; the request's full text then has the real ask)
function bestTitle(...texts) {
  let first = null;
  for (const x of texts) {
    if (!x) continue;
    const r = titleParts(x);
    first = first || r;
    if ((r.title.match(/[A-Za-z0-9]/g) || []).length >= 4) return { title: r.title, tag: r.tag || first.tag };
  }
  return first || { title: '', tag: '' };
}
function goalTitle(g) {
  const r = bestTitle(g.title, g.text);
  const m = /^([^:]{3,32}):\s+(.{6,})$/.exec(r.title);
  return m && m[1].split(' ').length <= 4 ? { ...r, title: m[1], sub: m[2].charAt(0).toUpperCase() + m[2].slice(1) } : r;
}
const agoShort = (t) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 3600 ? Math.max(1, Math.round(s / 60)) + 'm' : s < 86400 ? Math.round(s / 3600) + 'h' : Math.round(s / 86400) + 'd'; };
const tagChip = (tag) => tag ? `<span class="ttag">${esc(tag)}</span>` : '';
// why a stuck task is stuck, in one line (its latest note, without huddle's prefixes)
function stuckReason(t) {
  const n = t.notes && t.notes.length ? t.notes[t.notes.length - 1].text : '';
  return shortTitle(String(n).replace(/^(autopilot run (failed|finished)|tests failed \([^)]*\))\s*:\s*/i, '').split('\n')[0], 90);
}
const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const fmtNum = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n));
const tokenSum = (s, k) => Object.values(s.models).reduce((t, u) => t + u[k], 0);
const tokensAll = (s) => tokenSum(s, 'input') + tokenSum(s, 'output') + tokenSum(s, 'cacheRead') + tokenSum(s, 'cacheWrite');
function cleanStatus(st) {
  let t = String(st || '').trim().replace(/^asked:\s*/i, '').replace(/^(answering|request from|task) [^:]{0,40}:\s*/i, '');
  t = t.replace(/^[“"]|[”"]$/g, '');
  // one sentence: cut at the end of the first one when it's long enough to stand alone
  const end = t.search(/[.?!;](\s|$)/);
  if (end > 12) t = t.slice(0, end);
  return shortTitle(t.replace(/\.$/, ''), 72);
}
// what a tool step was, in a few words: "Editing routes.py", "Running uv run pytest"
function stepWords(text) {
  const w = toolWords(text);
  const arg = w.code ? w.arg.split('\n')[0].slice(0, 40) : w.arg.split('/').pop();
  const verbs = { edited: 'Editing', wrote: 'Writing', read: 'Reading', ran: 'Running', searched: 'Searching', 'looked for': 'Looking for', opened: 'Reading', 'searched web': 'Searching the web' };
  return verbs[w.verb] ? `${verbs[w.verb]} ${arg}`.trim() : `${w.verb.charAt(0).toUpperCase()}${w.verb.slice(1)} ${arg}`.trim();
}

export { esc, ago, clock, fullDate, store, color, shortTitle, EFFORT_WORD, statusWord, toolWords, summarize, md,
  tidyTitle, titleParts, bestTitle, goalTitle, agoShort, stuckReason, fmtDur, fmtNum, tokenSum, tokensAll, cleanStatus, stepWords };

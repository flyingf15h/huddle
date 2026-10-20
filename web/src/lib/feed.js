// The activity feed as rows to draw: day dividers, one-line notes (the same note repeated in a
// stretch shows once with a count), and Slack-style turns that group what one author did within
// ten minutes. A person and their agent are separate authors.
import { S, myName, claudeOf, aiName, toolOf, sessionName } from './state.js';

export const TURN_KINDS = new Set(['msg', 'prompt', 'reply', 'tool', 'end']);
const ROW_KINDS = new Set([...TURN_KINDS, 'goal', 'plan']);
const BOT_KINDS = new Set(['reply', 'tool', 'end', 'plan']);
const group = { approve: 'tasks', handoff: 'claude', msg: 'talk', prompt: 'claude', reply: 'claude', tool: 'claude', end: 'claude', goal: 'talk', plan: 'claude', task: 'tasks', lock: 'files', unlock: 'files', file: 'files', git: 'files', repo: 'files', knowledge: 'talk', join: 'talk' };
const KEY_KINDS = new Set(['msg', 'goal', 'prompt', 'reply', 'plan', 'handoff', 'task', 'approve', 'repo']);
export const visible = (e) => (S.filter === 'all' || (S.filter === 'key' ? KEY_KINDS.has(e.kind) : group[e.kind] === S.filter)) && (!S.who || e.who === S.who);

// what the header line says the author did, e.g. "requested from the team"
function rowContext(e) {
  if (e.kind === 'goal') return 'requested from ' + (e.goal.to ? claudeOf(e.goal.to) : 'the team');
  if (e.kind === 'prompt') return e.bg ? 'started on a request in the background' : 'prompted ' + (aiName(e.who) || 'their ' + toolOf(e.who));
  if (e.kind === 'msg') return e.to ? 'messaged ' + (String(e.to).includes('#') ? sessionName(e.to) : e.to.toLowerCase() === String(myName()).toLowerCase() ? 'you' : e.to) : 'messaged everyone';
  if (e.kind === 'plan') return 'posted a plan';
  return '';
}

export function feedRows(entries) {
  const rows = [];
  let lastDay = '', turn = null, notes = null;
  for (const e of entries) {
    const d = new Date(e.at).toDateString();
    if (d !== lastDay) {
      lastDay = d; turn = null; notes = null;
      rows.push({ type: 'day', key: 'd' + e.at, label: d === new Date().toDateString() ? 'Today' : new Date(e.at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) });
    }
    if (!ROW_KINDS.has(e.kind)) {
      turn = null;
      const sig = JSON.stringify([e.kind, e.who, e.path, e.text, e.branch, e.title, e.approval && e.approval.id, e.repo && [e.repo.action, e.repo.number, e.repo.branch]]);
      notes = notes || new Map();
      const seen = notes.get(sig);
      if (seen) { seen.count++; seen.at = e.at; continue; }
      const row = { type: e.kind === 'handoff' ? 'card' : 'note', key: 'n' + e.at + e.kind + rows.length, e, count: 1, at: e.at };
      notes.set(sig, row);
      rows.push(row);
      continue;
    }
    notes = null;
    const bot = BOT_KINDS.has(e.kind) || !!e.bg, ctx = rowContext(e), key = (bot ? 'c:' : 'h:') + e.who + '|' + ctx;
    const sameRun = bot && !ctx && turn && turn.key.startsWith('c:' + e.who + '|') && e.at - turn.at <= 10 * 60 * 1000;
    if (!sameRun && (!turn || turn.key !== key || e.at - turn.at > 10 * 60 * 1000)) {
      turn = { type: 'turn', key, rowKey: 't' + e.at + rows.length, who: e.who, bot, ctx, at0: e.at, at: e.at, toYou: e.kind === 'msg' && ctx === 'messaged you', items: [] };
      rows.push(turn);
    }
    turn.at = e.at;
    const last = turn.items[turn.items.length - 1];
    // tool steps in a row go in one list
    if (e.kind === 'tool' && last && last.kind === 'tools') last.steps.push(e);
    else turn.items.push(e.kind === 'tool' ? { kind: 'tools', steps: [e] } : e);
  }
  return rows;
}

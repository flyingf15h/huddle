// Tasks as people read them, and what can be done to them; shared by the side panel and the Tasks view.
import { S, api, loadBoard, myName, keys, auth } from './state.js';
import { bestTitle, stuckReason as stuckReasonRaw } from './words.js';

export const COLUMNS = [['todo', 'queued'], ['doing', 'working'], ['blocked', 'blocked'], ['done', 'merged']];
export const RUN_WORD = { ok: 'Finished', retrying: 'Retried', crashed: 'Crashed', failed: 'Failed', limit: 'Usage limit', waiting: 'Waiting' };
export const runPill = (o) => (o === 'ok' ? 'ok' : o === 'retrying' ? 'warn' : o === 'limit' ? 'acc' : 'bad');
export const titleOf = (t) => bestTitle(t.title, t.detail);
export const goalOf = (t) => S.board.goals.find(g => g.id === t.goalId) || null;
export const waitsOn = (t) => (t.after || []).map(id => S.board.tasks.find(x => x.id === id)).filter(x => x && x.status !== 'done');
export const stuckReason = (t) => stuckReasonRaw(t).replace(/[\s.,;:]+$/, '');

// what checked the work, and what it's waiting on: [{ text, tone: 'good' | 'bad' | 'wait' | '', title }]
export function checks(t) {
  const c = t.checks || {}, out = [];
  if (S.approvals.some(x => x.taskId === t.id)) out.push({ text: `Needs ${t.owner === myName() ? 'your' : t.owner + "'s"} OK`, tone: 'wait' });
  if (c.tests === 'passed') out.push({ text: 'Tests pass', tone: 'good', title: c.testCommand });
  if (c.tests === 'failed') out.push({ text: 'Tests failed', tone: 'bad', title: c.testOutput });
  if (c.review === 'fixed') out.push({ text: c.reviewer ? `Review by ${c.reviewer} fixed` : 'Review fixed', tone: '', title: 'A second agent found problems and they were fixed' });
  else if (c.review === 'ok') out.push({ text: c.reviewer ? `Reviewed by ${c.reviewer}` : 'Reviewed', tone: 'good' });
  if (c.conflicts === 'resolved') out.push({ text: 'Conflicts resolved', tone: 'good' });
  if (c.conflicts === 'unresolved') out.push({ text: 'Conflicts left', tone: 'bad' });
  if (c.ci === 'failing') out.push({ text: 'CI failing', tone: 'bad' });
  if (c.ci === 'passing') out.push({ text: 'CI passing', tone: 'good' });
  return out;
}
export const money = (n) => (n == null ? '' : n < 0.01 && n > 0 ? '<$0.01' : '$' + n.toFixed(n < 10 ? 2 : 0));

const after = (p) => p.then(() => loadBoard()).catch(e => { alert(e.message); });
export const setStatus = (t, status) => after(api('task-edit', { id: t.id, status }));
export const runAgain = (t) => after(api('task-update', { id: t.id, status: 'todo', note: `${myName()} asked for it to run again` }));
export const markDone = (t) => after(api('task-update', { id: t.id, status: 'done', note: `${myName()} marked it done from the dashboard` }));
export const editTask = (t, change) => after(api('task-edit', { id: t.id, ...change }));
export const comment = (t, text) => after(api('task-comment', { id: t.id, text }));
export const deleteTask = (t) => after(api('task-delete', { id: t.id }));
// can this browser say yes or no to my agent's commands: it has my huddle open key, or the project lets
// people decide in the dashboard and I'm signed in as myself (not through the shared invite)
export const canDecide = () => !!keys[auth.project] || !!(S.projectSettings.dashboardApprovals && S.me.via && S.me.via !== 'project' && S.me.name && S.me.name === myName());
export async function decide(ids, allow) {
  await api('approve', { ids, allow, key: keys[auth.project] });
  S.approvals = S.approvals.filter(x => !ids.includes(x.id));
}

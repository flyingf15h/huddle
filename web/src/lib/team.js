// One word and one colour for where each teammate's agent is: waiting for an OK, blocked, working, idle or away.
import { S, cardLine, myName } from './state.js';

export function teamState(p) {
  if (S.approvals.some(a => a.owner === p.name)) return { tone: 'w', word: p.name === myName() ? 'waiting on you' : `waiting on ${p.name}` };
  if (S.board.tasks.some(t => t.owner === p.name && t.status === 'blocked')) return { tone: 'w', word: 'blocked' };
  if (!p.online) return { tone: 'off', word: 'away' };
  if (cardLine(p).busy || S.board.tasks.some(t => t.owner === p.name && t.status === 'doing') || p.clones.length) return { tone: 'a', word: 'working' };
  return { tone: 'idle', word: 'idle' };
}
export const openTaskCount = (me) => S.board.tasks.filter(t => t.status === 'blocked' || (t.owner === me && t.status !== 'done')).length;

// The team board (goals people give the team, and the tasks the agents split
// them into), phrased for an agent's context.
'use strict';

function oneLine(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function signature(b) {
  return {
    goals: Object.fromEntries(b.goals.map(g => [g.id, `${g.status}:${g.planner || ''}`])),
    tasks: Object.fromEntries(b.tasks.map(t => [t.id, `${t.status}:${t.owner || ''}:${t.updated}`])),
  };
}

function taskLine(t) {
  return `[${t.id}] ${t.title} (${t.owner ? 'owner ' + t.owner : 'unassigned'}, ${t.status}${t.after && t.after.length ? ', after ' + t.after.join(',') : ''})`;
}

// What changed that this agent should know or act on.
function describe(seen, b, me) {
  const out = [];
  for (const g of b.goals) {
    if (seen.goals && seen.goals[g.id]) continue;
    if (g.to && g.to !== me) out.push(`${g.byName} asked ${g.to}'s Claude: ${oneLine(g.text, 400)}`);
    else if (g.to === me) out.push(`${g.byName} gave you (your Claude) a task directly: ${oneLine(g.text, 800)}`);
    else out.push(`New team goal from ${g.byName} [${g.id}]: ${oneLine(g.text, 800)}\n  Nobody has planned it yet. If you're free (and your user hasn't given you something else), claim it with huddle_claim_goal, split it into tasks for the online agents and call huddle_plan.`);
  }
  for (const t of b.tasks) {
    const before = seen.tasks && seen.tasks[t.id];
    const now = `${t.status}:${t.owner || ''}:${t.updated}`;
    if (before === now) continue;
    if (t.owner === me && (!before || !before.includes(`:${me}:`)) && t.status !== 'done') {
      out.push(`Task assigned to you [${t.id}]: ${t.title}${t.detail ? '\n  ' + oneLine(t.detail, 600) : ''}\n  Work on it when you can (tell your user if they asked for something else), and mark it with huddle_update_task.`);
    } else if (!before && !t.owner) {
      out.push(`New unassigned task [${t.id}]: ${t.title} (take it with huddle_claim_task)`);
    } else if (before && t.status === 'done' && !before.startsWith('done')) {
      out.push(`${t.owner || 'someone'} finished task [${t.id}]: ${t.title}${t.notes && t.notes.length ? ' (' + oneLine(t.notes[t.notes.length - 1].text, 200) + ')' : ''}`);
    }
  }
  return out.length ? 'Team board:\n' + out.map(l => '- ' + l).join('\n') : '';
}

function briefing(b, me) {
  // assets saved in Blender that wait for someone with the engine open (see studio.js)
  const hand = b.tasks.filter(t => t.editor && t.status !== 'done' && (t.owner === me || !t.owner));
  const handLines = hand.length ? ['', 'Asset hand-offs that need the game editor open (a background run can\'t do these):',
    ...hand.map(t => `- [${t.id}] ${t.title}${t.owner === me ? '  ← yours' : ' (anyone with it open)'}: ${oneLine(t.detail, 240)}`)] : [];
  const open = b.goals.filter(g => g.status !== 'done').slice(-5);
  if (!open.length) return ['Team board: no open goals. People can give the whole team a goal from the dashboard or with `huddle ask`.', ...handLines].join('\n');
  const lines = ['Team board (open goals and their tasks; huddle_board for details):'];
  for (const g of open) {
    lines.push(`- Goal [${g.id}] from ${g.byName}${g.to ? ' for ' + g.to : ''}: ${oneLine(g.text, 300)} (${g.status}${g.planner ? ', planned by ' + g.planner : ''})`);
    for (const t of b.tasks.filter(t => t.goalId === g.id)) lines.push(`    ${taskLine(t)}${t.owner === me ? '  ← yours' : ''}`);
  }
  return [...lines, ...handLines].join('\n');
}

function format(b) {
  if (!b.goals.length && !b.tasks.length) return 'The board is empty.';
  const lines = [];
  for (const g of b.goals.slice(-10)) {
    lines.push(`Goal [${g.id}] from ${g.byName}${g.to ? ' for ' + g.to : ''} — ${g.status}${g.planner ? ', planner ' + g.planner : ''}\n  ${g.text.replace(/\n/g, '\n  ')}`);
    if (g.plan) lines.push(`  Plan: ${g.plan}`);
    for (const t of b.tasks.filter(t => t.goalId === g.id)) {
      lines.push(`  ${taskLine(t)}${t.detail ? '\n      ' + oneLine(t.detail, 300) : ''}${t.notes && t.notes.length ? '\n      last note: ' + oneLine(t.notes[t.notes.length - 1].text, 200) : ''}`);
    }
  }
  const loose = b.tasks.filter(t => !t.goalId);
  if (loose.length) lines.push('Other tasks:', ...loose.map(t => '  ' + taskLine(t)));
  return lines.join('\n');
}

module.exports = { signature, describe, briefing, format, taskLine };

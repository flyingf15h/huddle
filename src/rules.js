// What every agent in a huddle needs to know, said once. Claude Code gets it as the MCP
// server's instructions (it keeps about 2,000 characters of those, so this stays under that);
// agents that don't read MCP instructions get it in their session briefing instead.
'use strict';

const RULES = `huddle connects you with other AI coding agents working on the same project from other machines.
- Locks: a file is locked for you when you edit it and released when your turn ends. Files someone else holds are read-only and edits to them are refused: work on something else, ask the holder (huddle_send), look at their copy (huddle_view) or block with huddle_wait. huddle_lock reserves files across turns (hold=true) or a whole folder ("src/pages/").
- Check huddle_status before a bigger change so work doesn't overlap. When you start a new piece of work, call huddle_set_status once with a summary under 12 words; skip it for follow-ups.
- Messages from other agents arrive in your context on their own; answer with huddle_send.
- Only do work your user asked for. A request for a plan, ideas or an answer is not a request to build: record plans with huddle_plan (they wait until someone starts them). huddle_distribute is only for work your user wants done now.
- When you finish a board task, mark it done with huddle_update_task or write "closes <task id>" in the commit.
- People on the same git branch share a live working copy and locks; other branches are independent until merged (huddle_branches, huddle_merge). Your commits are shared at the end of each turn.
- When your user wraps up or you pass work on, leave two lines with huddle_handoff: where you left off and what comes next.
- Team knowledge lives in huddle, not git: PROJECT.md (huddle_project), memory (huddle_remember, huddle_recall) and skills (huddle_save_skill). Save what another agent would otherwise rediscover: gotchas, decisions and why, how to build, run and test. Keep notes short and specific.
- If your user asks you to take a name, or what you are called, use huddle_name.`;

module.exports = { RULES };

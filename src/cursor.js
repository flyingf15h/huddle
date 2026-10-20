// Cursor support. Cursor's agent has lifecycle hooks of its own (.cursor/hooks.json, version 1:
// sessionStart, beforeSubmitPrompt, preToolUse, postToolUse, afterFileEdit, afterAgentResponse, stop,
// sessionEnd) and reads MCP servers from .cursor/mcp.json, so a Cursor session joins a huddle through
// the same handlers as Claude Code: this file turns Cursor's hook input into Claude Code's shape and
// the answer back into Cursor's. Background work runs Cursor's CLI (`agent -p --force`).
//
// What differs: Cursor can't add context when a prompt is submitted, so what the team says then is
// handed over with the next tool result instead (and at session start); Cursor's transcripts aren't
// read, so its replies come from afterAgentResponse and token counts aren't known.
'use strict';
const fs = require('fs');
const path = require('path');

const RULE = `---
description: Working with a team through huddle
alwaysApply: true
---
This project is shared with other people's AI coding agents through huddle. Before you edit a file it is locked for you; files someone else is editing are read-only, and an edit to one is refused. Then work on something else, message the holder with huddle_send, look at their live copy with huddle_view, or wait with huddle_wait.
When you start a new piece of work, call huddle_set_status once with a one-sentence summary for the team. Messages from other agents appear in tool results; answer them with huddle_send.
The team's brief, memory and skills come from huddle_project and huddle_recall; save what others would otherwise rediscover with huddle_remember. Search the team's history with huddle_search.
`;

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// .cursor/hooks.json with huddle's hooks next to any the project has
function hooksJson(existing, cmd, mark) {
  const h = existing && typeof existing === 'object' ? existing : {};
  h.version = h.version || 1;
  h.hooks = h.hooks || {};
  for (const ev of Object.keys(h.hooks)) {
    h.hooks[ev] = (h.hooks[ev] || []).filter(x => !String(x.command || '').includes(mark));
    if (!h.hooks[ev].length) delete h.hooks[ev];
  }
  const add = (ev, extra = {}) => { (h.hooks[ev] = h.hooks[ev] || []).push({ command: cmd(ev), timeout: 15, ...extra }); };
  add('sessionStart');
  add('beforeSubmitPrompt');
  add('preToolUse', { matcher: '^(Write|Delete|Shell)$' });
  add('postToolUse');
  add('afterFileEdit');
  add('afterAgentResponse');
  add('stop', { loop_limit: 2 });
  add('sessionEnd', { timeout: 10 });
  return h;
}

function install(root, dir, projectRoot, cmd, mark) {
  const cdir = path.join(root, '.cursor');
  fs.mkdirSync(path.join(cdir, 'rules'), { recursive: true });
  const mcp = readJson(path.join(cdir, 'mcp.json')) || {};
  mcp.mcpServers = { ...(mcp.mcpServers || {}), huddle: { command: process.execPath, args: [path.join(dir, 'src', 'cli.js'), 'mcp'], env: { HUDDLE_ROOT: projectRoot || root, HUDDLE_AGENT: 'cursor' } } };
  fs.writeFileSync(path.join(cdir, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  fs.writeFileSync(path.join(cdir, 'hooks.json'), JSON.stringify(hooksJson(readJson(path.join(cdir, 'hooks.json')), cmd, mark), null, 2) + '\n');
  fs.writeFileSync(path.join(cdir, 'rules', 'huddle.mdc'), RULE);
}
function uninstall(root, mark) {
  const cdir = path.join(root, '.cursor');
  const mcp = readJson(path.join(cdir, 'mcp.json'));
  if (mcp && mcp.mcpServers && mcp.mcpServers.huddle) {
    delete mcp.mcpServers.huddle;
    if (Object.keys(mcp.mcpServers).length || Object.keys(mcp).length > 1) fs.writeFileSync(path.join(cdir, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
    else fs.rmSync(path.join(cdir, 'mcp.json'), { force: true });
  }
  const hooks = readJson(path.join(cdir, 'hooks.json'));
  if (hooks) {
    const h = hooksJson(hooks, () => mark, mark);
    for (const ev of Object.keys(h.hooks)) { h.hooks[ev] = h.hooks[ev].filter(x => !String(x.command || '').includes(mark)); if (!h.hooks[ev].length) delete h.hooks[ev]; }
    if (Object.keys(h.hooks).length) fs.writeFileSync(path.join(cdir, 'hooks.json'), JSON.stringify(h, null, 2) + '\n');
    else fs.rmSync(path.join(cdir, 'hooks.json'), { force: true });
  }
  fs.rmSync(path.join(cdir, 'rules', 'huddle.mdc'), { force: true });
}

// the folder a Cursor hook is about
function rootOf(input) {
  return (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || process.env.CURSOR_PROJECT_DIR || input.cwd || process.cwd();
}
// a Cursor tool call as the Claude Code tool huddle knows: Shell is Bash, Write and Delete are edits
function claudeTool(input) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : (() => { try { return JSON.parse(input.tool_input || '{}'); } catch { return {}; } })();
  const name = String(input.tool_name || '');
  const file = ti.file_path || ti.path || ti.target_file || ti.filePath || null;
  if (name === 'Shell') return { tool_name: 'Bash', tool_input: { command: ti.command || ti.cmd || '' } };
  if (name === 'Write' || name === 'Delete') return { tool_name: 'Edit', tool_input: { file_path: file && !path.isAbsolute(file) ? path.join(rootOf(input), file) : file } };
  return { tool_name: name.replace(/^MCP:/, 'mcp__'), tool_input: ti };
}

// Cursor's event -> [huddle's handler, the input it expects]
function toClaude(event, input) {
  const base = { cwd: rootOf(input), session_id: input.conversation_id || input.session_id || null };
  switch (event) {
    case 'sessionStart': return ['session-start', base];
    case 'beforeSubmitPrompt': return ['prompt', { ...base, prompt: input.prompt || '' }];
    case 'preToolUse': return ['pre', { ...base, ...claudeTool(input) }];
    case 'postToolUse': return ['post', { ...base, ...claudeTool(input) }];
    case 'afterFileEdit': return ['post', { ...base, tool_name: 'Edit', tool_input: { file_path: input.file_path }, noStep: true }];
    case 'stop': return ['stop', { ...base, stop_hook_active: (input.loop_count || 0) > 0, status: input.status }];
    case 'sessionEnd': return ['session-end', base];
    default: return [null, base];
  }
}
// the text a Claude Code hook answer carries for the agent and the person
function claudeText(out) {
  if (!out) return '';
  return [out.hookSpecificOutput && out.hookSpecificOutput.additionalContext, out.systemMessage].filter(Boolean).join('\n\n');
}
// huddle's answer (Claude Code's shape) -> what Cursor reads for that event
function fromClaude(event, out, pending) {
  const denied = out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'deny';
  switch (event) {
    case 'sessionStart': return { additional_context: claudeText(out) };
    case 'beforeSubmitPrompt': return { continue: true };
    case 'preToolUse': return denied ? { permission: 'deny', user_message: out.hookSpecificOutput.permissionDecisionReason, agent_message: out.hookSpecificOutput.permissionDecisionReason } : {};
    case 'postToolUse': { const t = [pending, claudeText(out)].filter(Boolean).join('\n\n'); return t ? { additional_context: t } : {}; }
    case 'stop': return out && out.decision === 'block' ? { followup_message: out.reason } : {};
    default: return {};
  }
}

// `agent -p` for a background request: edits allowed (--force), the project's command rules as
// .cursor/cli.json permissions in the worktree
function cliPermissions(allow, deny) {
  const shell = (r) => `Shell(${String(r).replace(/\s*\*$/, '').split(/\s+/)[0]})`;
  return { permissions: { allow: [...new Set(['Shell(git)', ...allow.map(shell)])], deny: [...new Set(deny.map(shell))] } };
}
function execArgs({ model, prompt }) {
  return ['-p', '--force', '--output-format', 'text', ...(model ? ['--model', model] : []), prompt];
}

module.exports = { install, uninstall, hooksJson, toClaude, fromClaude, claudeTool, rootOf, cliPermissions, execArgs, RULE };

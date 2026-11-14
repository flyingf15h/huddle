// pi support (@earendil-works/pi-coding-agent). pi has no hook config, but it loads extensions from
// .pi/extensions and MCP servers from .pi/mcp.json, so `huddle join --agent pi` writes a small
// extension that turns pi's events into the same hook calls Claude Code makes (Claude Code's input
// shape on stdin, its answer shape back) and registers the huddle MCP server. Background requests run
// `pi -p`. pi only loads project files once the folder is trusted, so it asks the first time.
'use strict';
const fs = require('fs');
const path = require('path');
const { RULE } = require('./cursor');

const TEAM_RULE = RULE.replace(/^---[\s\S]*?---\n/, '').trim();
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// the extension: one function per pi event, each a `huddle hook` call
function extension(node, cli, projectRoot) {
  return `// huddle for pi: written by \`huddle join --agent pi\`, removed by \`huddle leave\`. Holds paths on this computer.
import { spawn } from 'node:child_process';
const NODE = ${JSON.stringify(node)}, CLI = ${JSON.stringify(cli)}, ROOT = ${JSON.stringify(projectRoot || '')};
const RULE = ${JSON.stringify(TEAM_RULE)};
function hook(name, input) {
  return new Promise((resolve) => {
    const env = { ...process.env, HUDDLE_AGENT: 'pi', ...(ROOT ? { HUDDLE_ROOT: ROOT } : {}) };
    let out = '', c;
    try { c = spawn(NODE, [CLI, 'hook', name, '--agent', 'pi'], { env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch { return resolve(null); }
    const t = setTimeout(() => c.kill(), 15000);
    c.stdout.on('data', (d) => { out += d; });
    c.on('error', () => { clearTimeout(t); resolve(null); });
    c.on('close', () => { clearTimeout(t); try { resolve(JSON.parse(out || 'null')); } catch { resolve(null); } });
    c.stdin.end(JSON.stringify(input));
  });
}
const said = (o) => (o ? [o.hookSpecificOutput && o.hookSpecificOutput.additionalContext, o.systemMessage].filter(Boolean).join('\\n\\n') : '');
const abs = (cwd, p) => (!p || /^([\\\\/]|[A-Za-z]:[\\\\/])/.test(p) ? p : cwd.replace(/[\\\\/]+$/, '') + '/' + p);
function asClaude(name, input, cwd) {
  const i = input || {};
  if (name === 'bash') return { tool_name: 'Bash', tool_input: { command: i.command || '' } };
  if (name === 'write') return { tool_name: 'Write', tool_input: { file_path: abs(cwd, i.path || i.file_path) } };
  if (name === 'edit') return { tool_name: 'Edit', tool_input: { file_path: abs(cwd, i.path || i.file_path) } };
  if (name === 'read') return { tool_name: 'Read', tool_input: { file_path: abs(cwd, i.path || i.file_path) } };
  return { tool_name: String(name || ''), tool_input: i };
}
const textOf = (m) => (!m ? '' : typeof m.content === 'string' ? m.content : (m.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\\n'));
export default function (pi) {
  let pending = '';
  const base = (ctx) => ({ cwd: ctx.cwd, session_id: null });
  pi.on('session_start', async (_e, ctx) => { pending = said(await hook('session-start', base(ctx))); });
  pi.on('before_agent_start', async (e, ctx) => {
    const res = { systemPrompt: e.systemPrompt + '\\n\\n' + RULE };
    if (e.messageType !== 'user') return res;
    const t = [pending, said(await hook('prompt', { ...base(ctx), prompt: e.prompt || '' }))].filter(Boolean).join('\\n\\n');
    pending = '';
    return t ? { ...res, message: { customType: 'huddle', content: t, display: false } } : res;
  });
  pi.on('tool_call', async (e, ctx) => {
    const r = await hook('pre', { ...base(ctx), ...asClaude(e.toolName, e.input, ctx.cwd) });
    const h = r && r.hookSpecificOutput;
    if (h && h.permissionDecision === 'deny') return { block: true, reason: h.permissionDecisionReason || 'blocked by huddle' };
  });
  pi.on('tool_result', async (e, ctx) => {
    const t = said(await hook('post', { ...base(ctx), ...asClaude(e.toolName, e.input, ctx.cwd), tool_response: {} }));
    if (t) return { content: [...(e.content || []), { type: 'text', text: '\\n\\n' + t }] };
  });
  pi.on('agent_end', async (e, ctx) => {
    const last = [...(e.messages || [])].reverse().find((m) => m && m.role === 'assistant');
    await hook('stop', { ...base(ctx), stop_hook_active: false, last_assistant_message: textOf(last).slice(0, 8000) });
  });
  pi.on('session_shutdown', async (e, ctx) => { if (!e || e.reason === 'quit') await hook('session-end', base(ctx)); });
}
`;
}

function install(root, dir, projectRoot) {
  const pdir = path.join(root, '.pi');
  fs.mkdirSync(path.join(pdir, 'extensions'), { recursive: true });
  const mcp = readJson(path.join(pdir, 'mcp.json')) || {};
  mcp.mcpServers = { ...(mcp.mcpServers || {}), huddle: { command: process.execPath, args: [path.join(dir, 'src', 'cli.js'), 'mcp'], env: { HUDDLE_ROOT: projectRoot || root, HUDDLE_AGENT: 'pi' } } };
  fs.writeFileSync(path.join(pdir, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
  fs.writeFileSync(path.join(pdir, 'extensions', 'huddle.js'), extension(process.execPath, path.join(dir, 'src', 'cli.js'), projectRoot && projectRoot !== root ? projectRoot : ''));
}
function uninstall(root) {
  const pdir = path.join(root, '.pi');
  const mcp = readJson(path.join(pdir, 'mcp.json'));
  if (mcp && mcp.mcpServers && mcp.mcpServers.huddle) {
    delete mcp.mcpServers.huddle;
    if (Object.keys(mcp.mcpServers).length || Object.keys(mcp).length > 1) fs.writeFileSync(path.join(pdir, 'mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
    else fs.rmSync(path.join(pdir, 'mcp.json'), { force: true });
  }
  fs.rmSync(path.join(pdir, 'extensions', 'huddle.js'), { force: true });
}
function execArgs({ model, prompt }) { return ['-p', ...(model ? ['--model', model] : []), prompt]; }

module.exports = { install, uninstall, extension, execArgs, FILES: ['.pi/mcp.json', '.pi/extensions/huddle.js'] };

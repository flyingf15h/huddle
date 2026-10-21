// Autopilot: lets this person's Claude take work from the team without them at
// the keyboard, by running `claude -p` in this folder with their own login.
//
// Modes (a per-person setting on the server, changeable from the dashboard,
// `huddle autopilot <mode>` or the huddle_autopilot tool):
//   full      (default, "active") answer messages other Claudes send this one while the person's
//             session is idle, do requests, take tasks assigned to this Claude, plan team goals and
//             take unassigned tasks
//   requests  only do what someone sends to this person's Claude directly, without running
//             anything outside the allowed commands; the answer (and any command that needs this
//             person's OK) goes back to the sender as a message
//   off       nothing runs; requests wait for the person
//
// The runner lives inside the huddle MCP server of an open Claude session (so
// "requests" works whenever the person has Claude open), or in the foreground
// with `huddle autopilot`. Only one runner per folder at a time.
//
// Each request or task gets a Claude of its own, a new conversation in its own git worktree
// (~/.huddle/clones/), so several run at once and none of them lands in the conversation the
// person is having. When one finishes, its commits merge into the person's branch if that merges
// cleanly; otherwise they stay on huddle-request-<id> for the person to merge.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const { identity, Client, sha, adoptName, CONFIG_DIR } = require('./client');
const CLI = path.join(__dirname, 'cli.js');
const board = require('./board');
const { needsAPerson } = require('./core');
const gitx = require('./git');
const policy = require('./policy');
const codex = require('./codex');
const cursor = require('./cursor');
const procs = require('./bin');
const APP_DIR = path.join(__dirname, '..');
const q = (s) => process.platform === 'win32' ? `"${s}"` : `'${String(s).replace(/'/g, `'\\''`)}'`;

const MODES = ['off', 'requests', 'full'];
const DEFAULT_MODE = 'full';
const MODE_WORDS = { off: 'off (requests and messages wait for you)', requests: 'requests only (does what people send to your Claude)', full: 'active (answers the other Claudes, takes its tasks and plans team goals)' };

function normMode(m) {
  m = String(m || '').toLowerCase();
  if (['on', 'full', 'auto', 'autopilot', 'active', 'default'].includes(m)) return 'full';
  if (['requests', 'request', 'prompts'].includes(m)) return 'requests';
  if (['off', 'none', 'manual'].includes(m)) return 'off';
  return null;
}

function depsDone(b, t) { return (t.after || []).every(id => { const d = b.tasks.find(x => x.id === id); return !d || d.status === 'done'; }); }

function pick(b, me, skip, mode = 'full', { low = false } = {}) {
  if (mode === 'off') return null;
  // (a task the person's own session kept for itself with huddle_distribute is done there, not here)
  const mine = b.tasks.filter(t => t.owner === me && ['todo', 'doing'].includes(t.status) && !skip.has(t.id) && depsDone(b, t)
    && !t.held && !t.editor && (mode === 'full' || t.direct));
  if (mine.length) return { kind: 'task', task: mine[0] };
  if (mode !== 'full') return null;
  const goal = b.goals.find(g => g.status === 'open' && !g.planner && !g.to && !skip.has(g.id));
  if (goal) return { kind: 'plan', goal };
  // (nearly out of Claude usage: leave open tasks for someone with room)
  // (work that needs Unity or Godot open waits for a person's own session: a background run has no editor)
  const free = !low && b.tasks.find(t => !t.owner && t.status === 'todo' && !t.editor && !skip.has(t.id) && depsDone(b, t));
  if (free) return { kind: 'claim', task: free };
  return null;
}

// Whether the person's own Claude session here is in the middle of a turn (the prompt and stop hooks
// keep .huddle/turns.json). A busy session reads its messages itself before it stops, so the runner
// only answers for a session that's idle.
function sessionBusy(root) {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(root, CONFIG_DIR, 'turns.json'), 'utf8'));
    return Object.values(t).some(x => x.busy && Date.now() - x.at < 30 * 60 * 1000);
  } catch { return false; }
}

function replyPrompt(m, me, aiName, from) {
  return `You are ${selfName(me, aiName)}, one of a team of AI coding agents working on this project through huddle.
${me} isn't at the keyboard right now, so you are answering in the background. ${from} sent you this message:

${m.text}

Answer it. Look at the code, the board (huddle_board) or what the others are doing (huddle_activity) if that helps; don't edit files in this run.
If they are asking you to build or change something, say you're taking it and call huddle_ask_team with to="${me}" and a clear description of the work, so it runs as its own request.
If it needs ${me} (a decision, a login, something only they can run), say so plainly.
Your final message is sent back to ${from} as your reply, so make it short and self-contained. Don't send it yourself with huddle_send.`;
}

// "Pip, tszfei's Claude" once the person has named it
function selfName(me, aiName, tool = 'Claude') { return aiName ? `${aiName}, ${me}'s ${tool}` : `${me}'s ${tool}`; }

// "tszfei (31% of the 5-hour window used)" for the planner, so it can see who has room
function teamLine(team, usage = {}) {
  return team.map(n => { const u = usage[n]; return u && typeof u.five === 'number' ? `${n} (${u.five}% of their 5-hour Claude window used)` : n; }).join(', ');
}

function planPrompt(goal, team, me, aiName, usage) {
  return `You are ${selfName(me, aiName)}, coordinating a team of Claude agents through huddle (one per person, each on their own computer).
A person gave the team this goal [${goal.id}] (from ${goal.byName}):

${goal.text}

You won the right to plan it. Online agents: ${teamLine(team, usage)}.
1. Look at the code as much as you need to understand what the goal involves.
2. Call huddle_plan with goal_id "${goal.id}": a title (2 to 5 plain words naming the whole request's outcome, like "Dashboard cleanup" or "Get the Devpost entry submitted"; no colons, names or ids), a short summary and concrete tasks. Task titles are under 7 plain words that say the outcome (like "Shorter task titles" or "Fix login redirect"), readable by someone who never saw the chat: no owner names (the owner is shown next to it), colons, ids or parentheses; the details go in detail (what to change, where, how to know it's done). Split by files or modules so two agents don't edit the same files: give each task its paths (files, or folders ending in "/"), which are locked for whoever does it from the moment it starts. Use "after" for real dependencies only. Give every task an effort (light, medium or heavy) and leave owner empty: huddle hands heavier tasks to the Claudes with the most usage left in their window. Only set an owner when a task has to go to one person (their branch, their hardware, something only they can run).
3. Send the team a two-line summary with huddle_send.
Do not implement anything in this run; your own tasks come next.`;
}
function taskPrompt(t, b, me, canRun, aiName, tool = 'Claude') {
  const goal = b.goals.find(g => g.id === t.goalId);
  const others = b.tasks.filter(x => x.goalId === t.goalId && x.id !== t.id).map(x => `- ${x.title} (${x.owner || 'unassigned'}, ${x.status})`);
  return `You are ${selfName(me, aiName, tool)}, working with a team of AI coding agents (Claude Code and Codex) through huddle.
Your task [${t.id}]: ${t.title}
${t.detail ? '\n' + t.detail + '\n' : ''}${goal ? `\nIt is part of the team goal from ${goal.byName}: ${goal.text}\n${goal.plan ? 'Plan: ' + goal.plan + '\n' : ''}` : ''}${others.length ? '\nOther tasks in this goal:\n' + others.join('\n') + '\n' : ''}
First, call huddle_update_task with task_id "${t.id}" and a title of 2 to 6 plain words naming the outcome (like "Fix pin-to-pin guide labels"), unless the current one already reads that way. Someone who never saw the chat should understand it: sentence case, no names, colons, ids, commit hashes or parentheses.
Do the task in this repository. Stay inside its scope; if you need a file someone else is working on, message them with huddle_send instead of waiting silently.${t.paths && t.paths.length ? `\nYou hold the lock on ${t.paths.join(', ')} for this task; keep your changes there unless the task really needs more.` : ''}
Shell commands: ${canRun}${t.allow && t.allow.length ? `, and ${me} approved: ${t.allow.join('; ')}` : ''}. Nobody is watching this session to approve anything, so a refused command stays refused; don't retry it. If you can't run a check, say what you couldn't verify in your note instead of blocking the task.
If the task needs a command you weren't allowed to run, finish what you can, then end your final message with "Needs ${me}'s OK:" and one line per command, as "- <command> — why". ${me} can approve them from the dashboard, and you'll be run again with them allowed. Don't mark the task blocked for this.${t.notes && t.notes.length ? `\nNotes on this task so far:\n${t.notes.slice(-4).map(n => `- ${n.by}: ${n.text}`).join('\n')}` : ''}${feedbackText(t)}
When it's done, commit it with git (one short message; anything left uncommitted is committed for you). Then call huddle_update_task with task_id "${t.id}", status "done" and a one-line note of what you did. Only use status "blocked" for a real problem in the work itself.${t.direct ? `
${t.by} sent you this directly, and your final message goes back to ${t.by} as your reply. Always answer, even if you can't finish: read what's needed, do what you can without the refused commands, then end with a short reply saying what you did or found.` : ''}`;
}


// The command that tests the project: the team's setting (huddle tests "..."), else the usual one
// for what's in the folder. null when there's nothing to run.
function detectTests(dir) {
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  try { const t = (JSON.parse(read('package.json')).scripts || {}).test; if (t && !/no test specified/.test(t)) return 'npm test'; } catch {}
  if (read('Cargo.toml')) return 'cargo test';
  if (read('go.mod')) return 'go test ./...';
  if (read('pytest.ini') || read('conftest.py') || /\[tool\.pytest/.test(read('pyproject.toml'))) return 'python -m pytest -q';
  if (/^test:/m.test(read('Makefile'))) return 'make test';
  return null;
}
function runShell(cmd, cwd, ms = 10 * 60 * 1000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let out = '';
    const take = (d) => { out = (out + d).slice(-20000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { take('\n(timed out)'); child.kill('SIGKILL'); }, ms);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code == null ? 1 : code, out }); });
  });
}
// "Needs alice's OK:" followed by "- npm test — to check the parser" lines, from a run's final message
function neededCommands(text) {
  const i = String(text || '').search(/needs [^\n]{0,40}\bOK:/i);
  if (i < 0) return [];
  const lines = text.slice(i).split('\n');
  const items = [lines[0].replace(/^.*?OK:\s*/i, ''), ...lines.slice(1)];
  const out = [];
  for (const l of items) {
    const line = l.replace(/^\s*([-*•]|\d+[.)])\s*/, '').trim();
    if (!line) { if (out.length) break; continue; }
    const [cmd, ...why] = line.split(/\s+[—–]\s+|\s+-\s+(?=[a-z])/);
    const command = cmd.replace(/^`+|`+$/g, '').trim();
    if (command && command.length < 300) out.push({ command, why: why.join(' - ').trim() });
  }
  return out.slice(0, 5);
}
const LIMIT = /usage limit|limit reached|hit your limit|out of (usage|credits)|rate.?limited/i;

// what a task changed, from its worktree: the file list and a unified diff (capped, file by file)
function diffOf(c) {
  const num = gitx.git(c.dir, ['diff', '--numstat', `${c.base}..HEAD`]);
  if (!num.ok || !num.out) return null;
  const files = num.out.split('\n').filter(Boolean).map(l => { const [add, del, ...rest] = l.split('\t'); return { path: rest.join('\t'), add: add === '-' ? 0 : Number(add), del: del === '-' ? 0 : Number(del), binary: add === '-' }; });
  const full = gitx.git(c.dir, ['diff', '--no-color', '--no-ext-diff', '-U3', `${c.base}..HEAD`]).out;
  const parts = full.split(/\n(?=diff --git )/);
  let diff = '', truncated = false;
  for (const part of parts) { if (diff.length + part.length > 450 * 1024) { truncated = true; break; } diff += (diff ? '\n' : '') + part; }
  return { files, diff, truncated, base: c.base, head: gitx.git(c.dir, ['rev-parse', 'HEAD']).out.trim() };
}
// what a reviewer asked to change, for the agent that runs the task again
function feedbackText(t) {
  const f = (t.feedback || [])[(t.feedback || []).length - 1];
  if (!f) return '';
  const lines = f.comments.map(c => `- ${c.file}${c.line ? ':' + c.line : ''}: ${c.text}`);
  return `\n${f.by} reviewed your earlier work on this task and asked for changes${f.note ? `: ${f.note}` : ''}.${lines.length ? '\nTheir comments:\n' + lines.join('\n') : ''}\nAddress each one (your earlier changes are already in this checkout), commit, then mark the task done again.`;
}
function reviewPrompt(t, base) {
  return `You are reviewing work another Claude just finished for the task "${t.title}".${t.detail ? `\nThe task: ${t.detail.slice(0, 1500)}` : ''}
Look at the change with \`git diff ${base}..HEAD\` (and read surrounding code as needed). Check for real problems only: bugs, crashes, broken callers, parts of the task that are missing, security holes. Ignore style and taste.
Don't edit anything. End with exactly one line "VERDICT: OK" if it's fine, or "VERDICT: CHANGES" followed by a short numbered list of concrete problems (file:line and what's wrong).`;
}
function resolvePrompt(t, person, files) {
  return `You are finishing the task "${t.title}" in this repository. While you worked, ${person} moved on, and merging their branch into yours stopped with conflicts in:
${files.map(f => '- ' + f).join('\n')}

The merge is in progress. For each file: read both sides of every conflict (\`git diff\`, and \`git log --merge -p -- <file>\` for why each side changed), keep what both sides meant to do, and remove every conflict marker. Don't drop the other side's work to make your own fit. Run the project's tests if you can. Then \`git add\` the files and \`git commit --no-edit\`. End with one line per file saying how you settled it.`;
}
function fixPrompt(t, what, detail, cmd) {
  return `You are finishing the task "${t.title}" in this repository. ${what}:

${detail.slice(-4000)}

Fix the code so this is resolved. Only fix real problems; if one is wrong, skip it and say why.${cmd ? ` You may run \`${cmd}\` to check.` : ''} Commit your fix with git (one short message).`;
}

// The MCP servers a Claude started in the person's folder would have that a worktree wouldn't: ones
// added with `claude mcp add` for that folder (kept in ~/.claude.json by path) and an uncommitted .mcp.json.
function folderMcpServers(root) {
  const out = {};
  try { Object.assign(out, JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers || {}); } catch {}
  try {
    const all = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
    Object.assign(out, ((all.projects || {})[root] || {}).mcpServers || {});
  } catch {}
  delete out.huddle;   // the clone gets its own huddle server
  // an editor's server (Unity, Blender) would change the person's open project, not the clone's branch
  for (const [name, spec] of Object.entries(out)) if (require('./apps').isEditorServer(name, spec)) delete out[name];
  return out;
}

// A worktree on a branch of its own for one request, set up as the same person in the same huddle.
// null when this isn't a git checkout with commits (the request then runs in the folder itself).
function makeClone(cfg, id) {
  const root = cfg.root;
  if (cfg.requestsIn === 'here' || !gitx.isRepo(root) || !gitx.head(root)) return null;
  // outside the project, so dev servers, watchers and test runners there never see it
  const dir = path.join(cfg.clonesDir || path.join(os.homedir(), '.huddle', 'clones'), `${path.basename(root)}-${sha(root).slice(0, 6)}`, id);
  const branch = `huddle-request-${id}`;
  const head = gitx.head(root);
  // asked to change work that was left on its branch: carry on from there, with the person's branch as the base
  const kept = gitx.git(root, ['rev-parse', '-q', '--verify', 'refs/heads/' + branch]).out;
  const base = kept ? (gitx.git(root, ['merge-base', head, kept]).out.trim() || head) : head;
  fs.rmSync(dir, { recursive: true, force: true });
  gitx.git(root, ['worktree', 'prune']);
  if (!gitx.git(root, ['worktree', 'add', '-q', '-B', branch, dir, kept || head]).ok) return null;
  const person = gitx.currentBranch(root, 0);
  fs.mkdirSync(path.join(dir, CONFIG_DIR), { recursive: true });
  const own = JSON.parse(fs.readFileSync(path.join(root, CONFIG_DIR, 'config.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, CONFIG_DIR, 'config.json'), JSON.stringify({ ...own, clone: { id, branch: person, of: root } }, null, 2), { mode: 0o600 });
  // dependencies aren't in git: point the worktree at the ones in the person's folder so tests can run
  for (const d of ['node_modules', '.venv', 'venv']) {
    if (fs.existsSync(path.join(root, d)) && !fs.existsSync(path.join(dir, d))) {
      try { fs.symlinkSync(path.join(root, d), path.join(dir, d), 'junction'); } catch {}
    }
  }
  // the person's own, uncommitted Claude setup comes along, so the clone works like a conversation they started
  const local = path.join(root, '.claude', 'settings.local.json');
  if (fs.existsSync(local)) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.copyFileSync(local, path.join(dir, '.claude', 'settings.local.json'));
  }
  if (fs.existsSync(path.join(root, 'CLAUDE.local.md')) && !fs.existsSync(path.join(dir, 'CLAUDE.local.md'))) {
    fs.copyFileSync(path.join(root, 'CLAUDE.local.md'), path.join(dir, 'CLAUDE.local.md'));
  }
  return { id, dir, branch, base, person };
}

// Commit what the clone did and bring it into the person's branch when git can do that cleanly
// (it never touches files they have uncommitted changes in). Returns where the work ended up.
function commitClone(c, title) {
  if (gitx.dirty(c.dir).length || gitx.git(c.dir, ['status', '--porcelain']).out) {
    // (huddle's own Codex setup in the worktree is never part of the work)
    const ownCodex = gitx.git(c.dir, ['ls-files', '--', '.codex']).out.trim() ? [':!.codex/rules/huddle.rules'] : [':!.codex'];
    gitx.git(c.dir, ['add', '-A', '--', '.', ':!node_modules', ':!.venv', ':!venv', ...ownCodex]);
    gitx.git(c.dir, ['commit', '-q', '-m', title.slice(0, 72)]);
  }
  return Number(gitx.git(c.dir, ['rev-list', '--count', `${c.base}..HEAD`]).out) || 0;
}
// merge: false keeps the work on its branch (its tests failed)
function landClone(cfg, c, title, { merge = true } = {}) {
  const count = commitClone(c, title);
  let landed = 'none';
  if (merge && count && c.person && gitx.currentBranch(cfg.root, 0) === c.person) {
    const m = gitx.git(cfg.root, ['merge', '--no-edit', '-m', `merge ${c.branch}: ${title.slice(0, 60)}`, c.branch]);
    if (m.ok) landed = 'merged';
    else if (gitx.git(cfg.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) gitx.git(cfg.root, ['merge', '--abort']);
  }
  if (count && landed !== 'merged') landed = 'branch';
  gitx.git(cfg.root, ['worktree', 'remove', '--force', c.dir]);
  if (landed !== 'branch') gitx.git(cfg.root, ['branch', '-D', c.branch]);
  return { landed, count };
}

// Finished work as a GitHub pull request instead of a merge (the project's "delivery: pr"): the
// worktree's branch is pushed as huddle/<task>-<title> and opened against the person's branch (or
// the repository's default one), with the request, who asked and what checked it in the description.
function slug(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'work'; }
function openPr(cfg, c, t, checks, me) {
  const { spawnSync } = require('child_process');
  const gh = (args, cwd) => procs.spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 120000 });
  if (gh(['--version']).status !== 0) return { error: 'the gh CLI is not installed on ' + me + "'s computer" };
  if (!gitx.git(cfg.root, ['remote', 'get-url', 'origin']).ok) return { error: 'this repository has no origin remote' };
  const head = `huddle/${t.id}-${slug(t.title)}`;
  const push = gitx.git(cfg.root, ['push', '-q', 'origin', `${c.branch}:refs/heads/${head}`]);
  if (!push.ok) return { error: 'git push failed: ' + (push.err || push.out || '').trim().slice(0, 300) };
  const onOrigin = (b) => b && gitx.git(cfg.root, ['ls-remote', '--exit-code', '--heads', 'origin', b]).ok;
  const dflt = gitx.git(cfg.root, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).out.trim().replace(/^origin\//, '');
  const base = onOrigin(c.person) ? c.person : dflt || 'main';
  const ck = checks || {};
  const body = [`**${t.title}**`, '', t.detail && t.detail.trim() !== t.title ? t.detail.slice(0, 3000) : '', '',
    `Asked by ${t.by}${t.direct ? ` (sent to ${me}'s agent)` : ''} · done by ${me}'s ${cfg.agent === 'codex' ? 'Codex' : 'Claude'} in the background with [huddle](https://github.com/flyingf15h/huddle) · task \`${t.id}\``,
    '', '| Check | Result |', '| --- | --- |',
    `| Review | ${ck.review === 'ok' ? 'No problems found' : ck.review === 'fixed' ? 'Problems found and fixed' : ck.review ? ck.review : 'Skipped'} |`,
    `| Tests | ${ck.tests === 'passed' ? `Pass (\`${ck.testCommand}\`)` : ck.tests === 'failed' ? `**Fail** (\`${ck.testCommand}\`)` : ck.tests === 'already failing' ? 'Were already failing before this change' : 'No test command'} |`].join('\n');
  const r = gh(['pr', 'create', '--head', head, '--base', base, '--title', t.title.slice(0, 200), '--body', body], cfg.root);
  if (r.status !== 0) return { error: 'gh pr create failed: ' + (r.stderr || r.stdout || '').trim().slice(0, 300) };
  const url = (r.stdout.match(/https:\/\/\S+\/pull\/\d+/) || [r.stdout.trim()])[0];
  gitx.git(cfg.root, ['worktree', 'remove', '--force', c.dir]);
  gitx.git(cfg.root, ['branch', '-D', c.branch]);
  return { url, head, base };
}
function prState(cfg, url) {
  const r = procs.spawnSync('gh', ['pr', 'view', url, '--json', 'state'], { cwd: cfg.root, encoding: 'utf8', timeout: 30000 });
  try { return JSON.parse(r.stdout).state.toLowerCase(); } catch { return null; }
}

// one runner per folder: a pid file in .huddle/
function claimRunner(root) {
  const file = path.join(root, CONFIG_DIR, 'runner.pid');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (pid && pid !== process.pid) { try { process.kill(pid, 0); return false; } catch (e) { if (e.code === 'EPERM') return false; } }
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(process.pid));
  return true;
}
function releaseRunner(root) {
  const file = path.join(root, CONFIG_DIR, 'runner.pid');
  try { if (Number(fs.readFileSync(file, 'utf8')) === process.pid) fs.unlinkSync(file); } catch {}
}

async function myAiName(client) {
  const s = await client.get('settings');
  return ((s.settings || {})[client.agent.name] || {}).aiName || null;
}

async function getMode(client) {
  const s = await client.get('settings');
  const mine = s.settings && s.settings[client.agent.name];
  return (mine && normMode(mine.autopilot)) || DEFAULT_MODE;
}

// The work loop shared by the background runner and `huddle autopilot`.
// log: status lines; out: Claude's own output (null to discard).
function createRunner({ cfg, client, flags = {}, log = () => {}, out = null }) {
  let me = cfg.name;
  const tool = ['codex', 'cursor'].includes(cfg.agent) ? cfg.agent : 'claude';
  const toolName = { codex: 'Codex', cursor: 'Cursor' }[tool] || 'Claude';
  // auto, like the person's own sessions: Claude Code's safety check approves what's safe and refuses what's
  // risky. Accounts without auto mode fall back to acceptEdits (edits plus the allowed commands).
  let permission = flags['permission-mode'] || cfg.autopilotPermissionMode || 'auto';
  const extraAllow = [].concat(flags.allow || cfg.autopilotAllow || []).flatMap(a => String(a).split(',')).map(a => a.trim()).filter(Boolean);
  // how many request Claudes may run at once (one when they'd share this folder)
  const max = Math.max(1, Number(flags.parallel || cfg.requestsParallel || 3));
  const skip = new Set();
  const running = new Map(); // task or goal id -> what it's doing
  const replied = new Set(), answeredAt = []; // message ids answered, and when (a cap per hour)
  let usage = null, projectSettings = {}, teamSettings = {};      // this person's window use; the team's test and review settings
  const later = (id) => { skip.add(id); setTimeout(() => { skip.delete(id); work(); }, 3 * 60 * 1000).unref(); };
  let pumping = false, again = false, mode = DEFAULT_MODE, stopped = false;

  // model: e.g. 'sonnet' for reviews and test fixes; allow: extra tools for this run; readOnly: no edits
  // shown: what the team sees as this run's prompt (the request itself), instead of the long instructions
  const pol = () => projectSettings.policy || { allow: [], deny: [] };
  // Codex: `codex exec` in its sandbox (edits in the worktree, no network), with the person's approvals,
  // the project's allow list and its never-allowed list as a rules file in the worktree
  const runCodex = (prompt, { cwd = cfg.root, session, mcpRoot, model, allow = [], readOnly = false, shown = '', taskId } = {}) => new Promise((resolve) => {
    const lastFile = codex.tmpFile('last.txt');
    // (a project that keeps .codex/ in git gets nothing written there: it would end up in the commit)
    if (cwd !== cfg.root && !gitx.git(cwd, ['ls-files', '--', '.codex']).out.trim()) {
      try {
        codex.install(cwd, APP_DIR, cwd, (ev) => `${q(process.execPath)} ${q(path.join(APP_DIR, 'src', 'cli.js'))} hook ${ev} --agent codex #huddle-hook`, 'huddle-hook');
        fs.mkdirSync(path.join(cwd, '.codex', 'rules'), { recursive: true });
        const allowed = [...(pol().allow || []), ...extraAllow.map(a => a.replace(/^Bash\((.*?)(:\*)?\)$/, '$1')), ...allow.map(a => a.replace(/^Bash\((.*?)(:\*)?\)$/, '$1'))];
        fs.writeFileSync(path.join(cwd, '.codex', 'rules', 'huddle.rules'), codex.rulesFile(allowed, pol().deny || []));
      } catch (e) { log('could not set up Codex in the worktree: ' + e.message); }
    }
    const common = gitx.git(cwd, ['rev-parse', '--git-common-dir']);
    const gitDir = common.ok ? path.resolve(cwd, common.out.trim()) : null;
    const args = codex.execArgs({ dir: cwd, readOnly, model: model && model !== 'sonnet' ? model : (flags.model || cfg.autopilotModel || null), gitDir, lastFile, mcpRoot, cli: CLI });
    args.push(prompt);
    const env = { ...process.env, HUDDLE_AUTOPILOT: '1', HUDDLE_AGENT: 'codex', HUDDLE_SHOWN: String(shown).slice(0, 4000), ...(taskId ? { HUDDLE_TASK: taskId } : {}), ...(session ? { HUDDLE_SESSION: session } : {}), ...(mcpRoot ? { HUDDLE_ROOT: mcpRoot } : {}) };
    const child = procs.spawn('codex', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    let text = '', err = '';
    child.stdout.on('data', d => { text += d; if (out) out(String(d)); });
    child.stderr.on('data', d => { err += d; if (out) out(String(d)); });
    child.on('error', e => { resolve({ code: 127, out: text, err: 'could not start codex: ' + e.message, missing: e.code === 'ENOENT' }); });
    child.on('close', code => {
      // the final message is what goes back to whoever asked
      let last = '';
      try { last = fs.readFileSync(lastFile, 'utf8'); fs.rmSync(lastFile, { force: true }); } catch {}
      resolve({ code, out: last.trim() ? last : text, err, log: text });
    });
  });
  // Cursor: its command line (`agent -p --force`) in the worktree, with huddle's hooks and MCP server in
  // .cursor/ there and the project's command rules as .cursor/cli.json permissions
  const runCursor = (prompt, { cwd = cfg.root, session, mcpRoot, model, allow = [], readOnly = false, shown = '', taskId } = {}) => new Promise((resolve) => {
    if (cwd !== cfg.root && !gitx.git(cwd, ['ls-files', '--', '.cursor']).out.trim()) {
      try {
        cursor.install(cwd, APP_DIR, cwd, (ev) => `${q(process.execPath)} ${q(path.join(APP_DIR, 'src', 'cli.js'))} hook ${ev} --agent cursor #huddle-hook`, 'huddle-hook');
        const allowed = [...(pol().allow || []), ...extraAllow.map(a => a.replace(/^Bash\((.*?)(:\*)?\)$/, '$1')), ...allow.map(a => a.replace(/^Bash\((.*?)(:\*)?\)$/, '$1'))];
        const perms = cursor.cliPermissions(allowed, pol().deny || []);
        if (readOnly) perms.permissions.deny.push('Write(**)');
        fs.writeFileSync(path.join(cwd, '.cursor', 'cli.json'), JSON.stringify(perms, null, 2));
      } catch (e) { log('could not set up Cursor in the worktree: ' + e.message); }
    }
    const env = { ...process.env, HUDDLE_AUTOPILOT: '1', HUDDLE_AGENT: 'cursor', HUDDLE_SHOWN: String(shown).slice(0, 4000), ...(taskId ? { HUDDLE_TASK: taskId } : {}), ...(session ? { HUDDLE_SESSION: session } : {}), ...(mcpRoot ? { HUDDLE_ROOT: mcpRoot } : {}) };
    const args = cursor.execArgs({ model: model && model !== 'sonnet' ? model : (flags.model || cfg.autopilotModel || null), prompt });
    const run = (bin) => {
      const child = procs.spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
      let text = '', err = '';
      child.stdout.on('data', d => { text += d; if (out) out(String(d)); });
      child.stderr.on('data', d => { err += d; if (out) out(String(d)); });
      // the CLI used to be called cursor-agent
      child.on('error', e => { if (e.code === 'ENOENT' && bin === 'agent') return run('cursor-agent'); resolve({ code: 127, out: text, err: 'could not start Cursor\'s command line: ' + e.message, missing: e.code === 'ENOENT' }); });
      child.on('close', code => resolve({ code, out: text, err }));
    };
    run('agent');
  });
  // a different vendor's reviewer, when the team uses more than one kind of agent and this computer has
  // another one's command line: 'codex', 'cursor' or 'claude', or null
  const BIN = { claude: ['claude'], codex: ['codex'], cursor: ['agent', 'cursor-agent'] };
  const onPath = (name) => require('child_process').spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore' }).status === 0;
  const otherVendor = () => {
    if (projectSettings.crossReview === false) return null;
    const used = new Set(Object.values(teamSettings || {}).map(s => (s && s.tool) || 'claude'));
    return ['claude', 'codex', 'cursor'].find(v => v !== tool && used.has(v) && BIN[v].some(onPath)) || null;
  };
  const runOnce = (prompt, opts = {}) => (opts.as || tool) === 'cursor' ? runCursor(prompt, opts) : (opts.as || tool) === 'codex' ? runCodex(prompt, opts) : new Promise((resolve) => {
    const { cwd = cfg.root, session, mcpRoot, model, allow = [], readOnly = false, shown = '', taskId } = opts;
    // in its own worktree (on its own branch) a Claude can also bring in and rearrange history freely:
    // nothing reaches the person's branch until it has been reviewed, tested and merged by huddle
    const own = cwd !== cfg.root ? ['fetch', 'merge', 'cherry-pick', 'rebase', 'pull', 'restore', 'checkout', 'switch', 'stash', 'reset', 'branch'].map(g => `Bash(git ${g}:*)`) : [];
    const allowed = ['mcp__huddle', 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git add:*)', 'Bash(git commit:*)', ...own, ...extraAllow, ...allow,
      ...(pol().allow || []).map(r => `Bash(${r.replace(/\s*\*$/, '')}:*)`)];
    const args = ['-p', prompt, '--permission-mode', permission];
    // a worktree isn't the folder the huddle MCP server (or the person's other folder-level servers) were
    // registered for, so hand them over directly
    if (mcpRoot) args.push('--mcp-config', JSON.stringify({ mcpServers: { ...(mcpRoot !== cfg.root ? folderMcpServers(cfg.root) : {}), huddle: { type: 'stdio', command: process.execPath, args: [CLI, 'mcp'], env: { HUDDLE_ROOT: mcpRoot } } } }));
    if (model || flags.model || cfg.autopilotModel) args.push('--model', model || flags.model || cfg.autopilotModel);
    const never = (pol().deny || []).map(r => `Bash(${r.replace(/\s*\*$/, '')}:*)`);
    if (readOnly || never.length) args.push('--disallowedTools', ...(readOnly ? ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] : []), ...never);
    args.push('--allowedTools', ...allowed);
    // (the session's MCP server runs with HUDDLE_ROOT set to the person's folder; a clone has its own)
    const env = { ...process.env, HUDDLE_AUTOPILOT: '1', HUDDLE_SHOWN: String(shown).slice(0, 4000), ...(taskId ? { HUDDLE_TASK: taskId } : {}), ...(session ? { HUDDLE_SESSION: session } : {}), ...(mcpRoot ? { HUDDLE_ROOT: mcpRoot } : {}) };
    const child = procs.spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    let text = '', err = '';
    child.stdout.on('data', d => { text += d; if (out) out(String(d)); });
    child.stderr.on('data', d => { err += d; if (out) out(String(d)); });
    child.on('error', e => { log('could not start claude: ' + e.message); resolve({ code: 127, out: text, err: 'could not start claude: ' + e.message, missing: e.code === 'ENOENT' }); });
    child.on('close', code => resolve({ code, out: text, err }));
  });
  // each run is its own Claude Code session, started for this one job and ended when it's done (claude -p exits)
  const VENDOR_NAME = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };
  const runClaude = async (prompt, opts) => {
    const res = await runOnce(prompt, opts);
    if (res.missing) await reportProblem('missing', `${toolName} isn't installed or isn't on PATH on ${me}'s computer, so background work can't run there`, res.err);
    if (tool === 'claude' && res.code !== 0 && permission === 'auto' && /auto mode|permission.mode/i.test(res.err + res.out)) {
      log('auto mode is not available for this account; background Claudes use acceptEdits instead');
      permission = 'acceptEdits';
      return runOnce(prompt, opts);
    }
    return res;
  };
  // a failure the team should see on the Health page (and in notifications)
  async function reportProblem(kind, message, detail, taskId) {
    await client.post('problem', { kind, message, detail: String(detail || '').slice(-1500), taskId }).catch(() => {});
  }
  const canRun = () => tool === 'cursor' ? `Cursor's command line with the permissions in .cursor/cli.json: git and local commands the project allows${(pol().allow || []).length ? ` (${pol().allow.join(', ')})` : ''}; anything else is refused`
    : tool === 'codex' ? `Codex's sandbox: you can edit files in this worktree and run local commands (tests, builds, git), without network access. Anything outside that is refused${(pol().allow || []).length ? `, except what the project always allows: ${pol().allow.join(', ')}` : ''}`
    : permission === 'bypassPermissions' ? 'you may run any command'
    : permission === 'auto' ? `the same as in ${me}'s own sessions: Claude Code's auto mode lets safe commands through and refuses risky ones (deploys, publishing, deleting things outside this folder)`
    : `only git (status, diff, log, add, commit)${extraAllow.length ? ', ' + extraAllow.join(', ') : ''} and whatever the project's .claude/settings.json allows`;

  async function refreshMode() {
    mode = flags.mode ? normMode(flags.mode) : await getMode(client).catch(() => mode);
    const st = await client.get('state').catch(() => null);
    if (st && adoptName(cfg, st.aliases)) { log(`now called ${cfg.name}`); me = cfg.name; }
    if (st) { usage = (st.usage || {})[me] || null; projectSettings = st.projectSettings || {}; teamSettings = st.settings || {}; }
    await client.post('hello', { runner: mode, tool }).catch(() => {});
    return mode;
  }

  // A request's answer goes back to whoever sent it, as a message. Messages never start runs, so
  // two Claudes can't end up answering each other forever.
  async function reply(t, res, now, where) {
    const answer = res.out.trim().slice(-1500) || (res.code === 0 ? 'Done.' : 'The run failed without saying why.');
    await client.post('message', { to: t.by, text: `Re your request "${t.title.slice(0, 80)}" (${now ? now.status : 'gone'}${where ? '; ' + where : ''}):\n${answer}` })
      .catch(e => log('could not send the reply: ' + e.message));
  }

  // the huddle identity a request's Claude has: its own, so the team sees each one and their locks
  // keep them out of each other's files
  function cloneClient(root, key, branch) {
    const ccfg = { ...cfg, root };
    return new Client(ccfg, { ...identity(ccfg, 'agent', key), branch });
  }

  // A direct message from another Claude (or a person) while this person's session is idle gets an
  // answer from a short background Claude, so the team doesn't wait on someone who stepped away.
  // Automatic answers never start runs themselves, so two Claudes can't keep each other going.
  async function answer(m) {
    log(`answering a message from ${m.fromName}`);
    const key = 'msg-' + m.id;
    const who = cloneClient(cfg.root, key, gitx.currentBranch(cfg.root, 0));
    await who.post('hello', { clone: `answering ${m.fromName}` }).catch(() => {});
    await who.post('status', { status: `answering ${m.fromName}: ${m.text.split('\n')[0].slice(0, 70)}` }).catch(() => {});
    const res = await runClaude(replyPrompt(m, me, await myAiName(client).catch(() => null), m.fromName), { session: key, shown: `Reply to ${m.fromName}: ${m.text}`, model: cfg.answerModel || 'sonnet' });
    const text = res.out.trim().slice(-2000) || (res.code === 0 ? '' : "I couldn't answer this automatically; it'll wait for my person.");
    if (text) await client.post('message', { to: m.fromName, text, auto: true }).catch(e => log('could not send the answer: ' + e.message));
    await who.post('bye', {}).catch(() => {});
  }
  function wantsAnswer(m) {
    if (!m || m.auto || replied.has(m.id) || mode === 'off' || !m.to || m.to !== me || m.fromName === me) return false;
    if (Date.now() - m.at > 10 * 60 * 1000 || sessionBusy(cfg.root)) return false;
    while (answeredAt.length && Date.now() - answeredAt[0] > 3600 * 1000) answeredAt.shift();
    return answeredAt.length < 8;
  }

  async function plan(goal) {
    log(`planning goal ${goal.id}: ${goal.text.split('\n')[0]}`);
    const key = 'plan-' + goal.id;
    const who = cloneClient(cfg.root, key, gitx.currentBranch(cfg.root, 0));
    await who.post('hello', { clone: `planning a goal from ${goal.byName}` }).catch(() => {});
    await who.post('status', { status: `planning: ${goal.text.split('\n')[0].slice(0, 80)}` }).catch(() => {});
    const s = await client.get('state');
    const team = [...new Set(s.agents.filter(a => a.online && (a.kind === 'agent' || a.kind === 'autopilot')).map(a => a.name))];
    await runClaude(planPrompt(goal, team.length ? team : [me], me, await myAiName(client).catch(() => null), s.usage), { session: key, shown: `Plan: ${goal.text}`, model: cfg.planModel || 'sonnet' });
    const after = (await client.get('board')).goals.find(g => g.id === goal.id);
    if (after && after.status !== 'planned' && after.status !== 'done') {
      log('Claude did not record a plan; taking the whole goal as one task');
      await client.post('plan', { goalId: goal.id, summary: '', tasks: [{ title: goal.text.split('\n')[0].slice(0, 200), detail: goal.text, effort: 'medium' }] });
    }
    await who.post('bye', {}).catch(() => {});
  }

  // Before work lands: a Sonnet Claude reviews the diff (one fix pass if it finds problems), then the
  // project's tests run (one Sonnet fix pass if they fail). Tests that already failed before this work
  // don't hold it back.
  async function check(t, c) {
    const out = {};
    const cmd = projectSettings.testCommand || detectTests(c.dir);
    const testAllow = cmd ? [`Bash(${cmd})`, `Bash(${cmd}:*)`] : [];
    if (projectSettings.review !== false) {
      // a second opinion from another vendor's agent, when there is one to ask
      const other = otherVendor();
      log(`reviewing ${t.id} with ${other ? VENDOR_NAME[other] : 'Sonnet'}`);
      let r = await runClaude(reviewPrompt(t, c.base), { taskId: t.id, cwd: c.dir, session: 'review-' + t.id, mcpRoot: c.dir, model: 'sonnet', readOnly: true, shown: `Review the work on: ${t.title}`, ...(other ? { as: other } : {}) });
      if (other && r.code !== 0) { log(`${VENDOR_NAME[other]} could not review; asking ${toolName} instead`); r = await runClaude(reviewPrompt(t, c.base), { taskId: t.id, cwd: c.dir, session: 'review-' + t.id, mcpRoot: c.dir, model: 'sonnet', readOnly: true, shown: `Review the work on: ${t.title}` }); }
      else if (other) out.reviewer = VENDOR_NAME[other];
      const at = r.out.search(/VERDICT:\s*CHANGES/i);
      if (at >= 0) {
        await runClaude(fixPrompt(t, 'A reviewer found these problems', r.out.slice(at)), { taskId: t.id, cwd: c.dir, session: 'fix-' + t.id, mcpRoot: c.dir, model: 'sonnet', allow: testAllow, shown: `Fix what the review found in: ${t.title}` });
        commitClone(c, `fix review notes: ${t.title}`);
        out.review = 'fixed';
      } else out.review = /VERDICT:\s*OK/i.test(r.out) ? 'ok' : 'unclear';
    }
    if (!cmd) { out.tests = 'none'; return out; }
    log(`testing ${t.id}: ${cmd}`);
    let r = await runShell(cmd, c.dir);
    if (r.code !== 0) {
      await runClaude(fixPrompt(t, `The tests (\`${cmd}\`) fail after this work`, r.out, cmd), { taskId: t.id, cwd: c.dir, session: 'tests-' + t.id, mcpRoot: c.dir, model: 'sonnet', allow: testAllow, shown: `Fix the failing tests (${cmd}) in: ${t.title}` });
      commitClone(c, `fix tests: ${t.title}`);
      r = await runShell(cmd, c.dir);
    }
    out.testCommand = cmd;
    if (r.code === 0) { out.tests = 'passed'; return out; }
    // were they failing before this work too?
    const tip = gitx.git(c.dir, ['rev-parse', 'HEAD']).out.trim();
    gitx.git(c.dir, ['checkout', '-q', '--detach', c.base]);
    const before = await runShell(cmd, c.dir);
    gitx.git(c.dir, ['checkout', '-q', '-B', c.branch, tip]);
    out.tests = before.code === 0 ? 'failed' : 'already failing';
    if (out.tests === 'failed') out.testOutput = r.out.slice(-600);
    return out;
  }

  // The person's branch moved while this ran, and the two would conflict: merge it into the worktree and let
  // a Claude settle the conflicts there, so the work can still land cleanly. 'resolved' or 'unresolved'.
  async function settleConflicts(t, c) {
    if (!c.person) return null;
    const theirs = gitx.git(cfg.root, ['rev-parse', '-q', '--verify', 'refs/heads/' + c.person]).out;
    const ours = gitx.git(c.dir, ['rev-parse', 'HEAD']).out;
    if (!theirs || gitx.git(c.dir, ['merge-base', '--is-ancestor', theirs, ours]).ok) return null;
    if (gitx.git(c.dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs]).ok) return null;
    const m = gitx.git(c.dir, ['merge', '--no-edit', '-m', `merge ${c.person} into ${t.title.slice(0, 50)}`, theirs]);
    if (m.ok) return null;
    const files = gitx.git(c.dir, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    if (!files.length) { gitx.git(c.dir, ['merge', '--abort']); return null; }
    log(`${t.id}: settling conflicts with ${c.person} in ${files.join(', ')}`);
    await runClaude(resolvePrompt(t, `${me}'s ${c.person}`, files), { taskId: t.id, cwd: c.dir, session: 'merge-' + t.id, mcpRoot: c.dir, shown: `Resolve merge conflicts in: ${t.title}` });
    const left = gitx.git(c.dir, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    const markers = files.filter(f => { try { return /^(<{7}|>{7}) /m.test(fs.readFileSync(path.join(c.dir, f), 'utf8')); } catch { return false; } });
    if (left.length || markers.length) {
      gitx.git(c.dir, ['merge', '--abort']);
      gitx.git(c.dir, ['reset', '-q', '--hard', ours]);
      return 'unresolved';
    }
    if (gitx.git(c.dir, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) { gitx.git(c.dir, ['add', '-A', '--', ...files]); gitx.git(c.dir, ['commit', '-q', '--no-edit']); }
    return 'resolved';
  }

  // the task's files and folders, locked for this run before it starts; false (and nothing held)
  // when someone else is in there
  async function lockPaths(who, t, branch) {
    for (const p of t.paths || []) {
      const r = await who.post('lock', { path: p, branch, hold: true, note: t.title.slice(0, 80) }).catch(() => ({ ok: true }));
      if (!r.ok) { await who.post('unlock', { all: true }).catch(() => {}); return r.lock; }
    }
    return null;
  }

  async function task(t, b) {
    log(`working on ${t.direct ? 'a request from ' + t.by : 'task'} ${t.id}: ${t.title}`);
    await client.post('task-update', { id: t.id, status: 'doing' });
    const c = makeClone(cfg, t.id);
    const key = 'clone-' + t.id;
    const branch = c ? c.person : gitx.currentBranch(cfg.root, 0);
    const who = cloneClient(c ? c.dir : cfg.root, key, branch);
    await who.post('hello', { clone: t.direct ? `request from ${t.by}` : 'board task' }).catch(() => {});
    const busy = await lockPaths(who, t, branch);
    if (busy) {
      log(`${t.id} waits: ${busy.holderName} is working in ${busy.path}`);
      await client.post('task-update', { id: t.id, status: 'todo', note: `Waiting for ${busy.holderName} to finish in ${busy.path}.` });
      if (c) { gitx.git(cfg.root, ['worktree', 'remove', '--force', c.dir]); gitx.git(cfg.root, ['branch', '-D', c.branch]); }
      await who.post('bye', {}).catch(() => {});
      return later(t.id);
    }
    await who.post('status', { status: `${t.direct ? `request from ${t.by}` : 'task'}: ${t.title.slice(0, 80)}` }).catch(() => {});
    // a run that crashes (the agent exits with an error that isn't the usage limit) is tried again, up to
    // three times, a little later each time; every attempt is kept on the task so retries aren't silent
    const started = Date.now();
    const lastLine = (r) => String((r.err || '').trim() || r.out || '').trim().split('\n').pop().slice(0, 400);
    let res, attempt = 0;
    for (;;) {
      attempt++;
      res = await runClaude(taskPrompt(t, b, me, canRun(), await myAiName(client).catch(() => null), toolName),
        { taskId: t.id, cwd: c ? c.dir : cfg.root, session: key + (attempt > 1 ? '-' + attempt : ''), mcpRoot: c ? c.dir : null, allow: (t.allow || []).map(x => `Bash(${x})`), shown: t.detail && t.detail.trim() ? t.detail : t.title });
      const crashed = res.code !== 0 && !LIMIT.test(res.out + res.err) && !res.missing;
      const already = crashed && ((await client.get('board').catch(() => ({ tasks: [] }))).tasks.find(x => x.id === t.id) || {}).status;
      if (!crashed || attempt >= 3 || already === 'done') break;
      await client.post('task-update', { id: t.id, run: { attempt, outcome: 'retrying', ms: Date.now() - started, error: lastLine(res), agent: tool } }).catch(() => {});
      log(`${t.id}: ${toolName} exited with an error (attempt ${attempt}); trying again`);
      await new Promise(r => setTimeout(r, Number(process.env.HUDDLE_RETRY_MS || 0) || (attempt === 1 ? 20000 : 60000)));
    }
    const outcome = res.missing ? 'crashed' : res.code !== 0 && LIMIT.test(res.out + res.err) ? 'limit' : res.code !== 0 ? 'crashed' : 'ok';
    await client.post('task-update', { id: t.id, run: { attempt, outcome, ms: Date.now() - started, error: outcome === 'ok' ? '' : lastLine(res), agent: tool } }).catch(() => {});
    if (outcome === 'crashed' && !res.missing) await reportProblem('crash', `${toolName} crashed ${attempt} time${attempt === 1 ? '' : 's'} on "${t.title}"`, (res.err || '') + '\n' + (res.log || res.out || ''), t.id);
    // out of usage: give it back so someone with room takes it
    if (res.code !== 0 && LIMIT.test(res.out + res.err)) {
      log(`${t.id}: hit the ${toolName} usage limit, handing it on`);
      if (c) landClone(cfg, c, t.title, { merge: false });
      await client.post('task-update', { id: t.id, status: 'todo', limitHit: true, note: `${me}'s ${toolName} hit its usage limit partway${c ? `; its work so far is on ${c.branch}` : ''}.` }).catch(() => {});
      await who.post('unlock', { all: true }).catch(() => {});
      await who.post('bye', {}).catch(() => {});
      return later(t.id);
    }
    let where = '', checks = null;
    let pr = null;
    if (c) {
      if (commitClone(c, t.title)) checks = await check(t, c).catch(e => { log('checks: ' + e.message); return null; });
      // the project wants pull requests: the work goes up as one instead of merging here
      if (projectSettings.delivery === 'pr' && gitx.git(c.dir, ['rev-list', '--count', `${c.base}..HEAD`]).out.trim() !== '0') {
        pr = openPr(cfg, c, t, checks, me);
        if (pr.url) { where = `pull request ${pr.url}`; log(`opened ${pr.url}`); checks = { ...(checks || {}), pr: pr.url, prState: 'open', merged: false }; }
        else { log('pull request: ' + pr.error); await reportProblem('pr', `couldn't open a pull request for "${t.title}": ${pr.error}`, '', t.id); pr = null; }
      }
    }
    if (c) {
      const d = diffOf(c);
      if (d) await client.post('task-diff', { taskId: t.id, ...d, branch: c.branch, left: false }).catch(e => log('diff: ' + e.message));
    }
    if (c && !pr && (!checks || checks.tests !== 'failed')) {
      const settled = await settleConflicts(t, c).catch(e => { log('conflicts: ' + e.message); return null; });
      if (settled) checks = { ...(checks || {}), conflicts: settled };
    }
    if (c && !pr) {
      const l = landClone(cfg, c, t.title, { merge: !checks || checks.tests !== 'failed' });
      if (l.landed === 'merged') { where = `merged into ${me}'s ${c.person}`; log(`merged ${c.branch} into ${c.person}`); }
      if (l.landed === 'branch') {
        where = checks && checks.tests === 'failed' ? `on branch ${c.branch}: tests failed, so it wasn't merged`
          : `on branch ${c.branch}: it didn't merge cleanly into ${me}'s ${c.person || 'checkout'}`;
        await gitx.publish(client, cfg.root, { branch: c.branch }).catch(() => {});
        await client.post('task-diff', { taskId: t.id, branch: c.branch, left: true }).catch(() => {});
        log(`left the work on ${c.branch}`);
      }
      if (checks) checks.merged = l.landed === 'merged';
    } else if (gitx.isRepo(cfg.root) && gitx.dirty(cfg.root).length) {
      // finished work only reaches the others once it's committed
      gitx.ensureExcluded(cfg.root);
      gitx.git(cfg.root, ['add', '-A']);
      if (gitx.git(cfg.root, ['commit', '-q', '-m', t.title.slice(0, 72)]).ok) log("committed the task's changes");
    }
    if (gitx.isRepo(cfg.root)) {
      const pub = await gitx.publish(client, cfg.root).catch(e => ({ skipped: e.message }));
      if (pub.tip && !pub.unchanged) log(`shared ${pub.branch} at ${pub.tip.slice(0, 8)}`);
    }
    if (checks) await client.post('task-update', { id: t.id, checks }).catch(() => {});
    const needs = neededCommands(res.out);
    let rerun = false;
    if (needs.length) {
      const made = ((await client.post('approval-request', { taskId: t.id, commands: needs }).catch(e => { log('approval: ' + e.message); return null; })) || {}).approvals || [];
      // the safe ones are approved here and the task runs again with them; only risky ones wait for the
      // person (and so does a safe one that was already allowed and is asked for again, so nothing loops).
      // A task its Claude already marked done isn't reopened: those approvals just expire.
      const state = ((await client.get('board').catch(() => ({ tasks: [] }))).tasks.find(x => x.id === t.id) || {}).status;
      const safe = state === 'done' ? [] : made.filter(x => x.id && (!needsAPerson(x.command) || policy.allowedBy(pol(), x.command)) && !(t.allow || []).includes(x.command));
      if (safe.length) {
        await client.post('approve', { ids: safe.map(x => x.id), allow: true }).then(() => { rerun = true; }).catch(e => log('auto-approve: ' + e.message));
        if (rerun) log(`allowed ${safe.length} safe command${safe.length === 1 ? '' : 's'}; running "${t.title.slice(0, 50)}" again`);
      }
    }
    let now = (await client.get('board')).tasks.find(x => x.id === t.id);
    if (!rerun && now && now.status === 'doing') {
      const last = res.out.trim().split('\n').pop() || '';
      const failed = res.code !== 0 || (checks && checks.tests === 'failed');
      now = (await client.post('task-update', { id: t.id, status: failed ? 'blocked' : 'done',
        note: (failed ? (checks && checks.tests === 'failed' ? `tests failed (${checks.testCommand}): ` : 'autopilot run failed: ') : 'autopilot run finished: ') + last.slice(0, 300) + (where ? ` (${where})` : '') })).task;
    }
    // (the run that goes again with the approved commands sends the reply)
    if (t.direct && !rerun) await reply(t, res, now, where);
    if (!rerun && now && now.status !== 'done') skip.add(t.id); // don't loop on a blocked task
    await who.post('unlock', { all: true }).catch(() => {});
    await who.post('bye', {}).catch(() => {});
    log(`${t.id} ${now ? now.status : 'gone'}`);
  }

  let prCheckAt = 0;
  async function checkPrs() {
    if (Date.now() - prCheckAt < 10 * 60 * 1000) return;
    prCheckAt = Date.now();
    const b = await client.get('board').catch(() => null);
    for (const t of (b ? b.tasks : []).filter(x => x.owner === me && x.checks && x.checks.pr && x.checks.prState === 'open')) {
      const st = prState(cfg, t.checks.pr);
      if (st && st !== 'open') await client.post('task-update', { id: t.id, checks: { prState: st, merged: st === 'merged' } }).catch(() => {});
    }
  }

  // someone pressed "Merge" on work that was left on its own branch
  async function mergeLeft(t) {
    const branch = `huddle-request-${t.id}`;
    const say = (text, extra = {}) => client.post('task-update', { id: t.id, note: text, ...extra }).catch(() => {});
    if (!gitx.git(cfg.root, ['rev-parse', '-q', '--verify', 'refs/heads/' + branch]).ok) return say(`The branch ${branch} is gone, so there is nothing to merge.`);
    const m = gitx.git(cfg.root, ['merge', '--no-edit', '-m', `merge ${branch}: ${t.title.slice(0, 60)}`, branch]);
    if (!m.ok) {
      if (gitx.git(cfg.root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok) gitx.git(cfg.root, ['merge', '--abort']);
      return say(`The branch didn't merge cleanly into ${gitx.currentBranch(cfg.root, 0)}. Ask for changes (the agent will sort out the conflicts), or merge it by hand: git merge ${branch}`);
    }
    gitx.git(cfg.root, ['branch', '-D', branch]);
    await client.post('task-diff', { taskId: t.id, left: false }).catch(() => {});
    await say(`Merged ${branch} into ${gitx.currentBranch(cfg.root, 0)}.`, { checks: { merged: true } });
    log(`merged ${branch}`);
  }
  let conflictTimer = null;
  function checkConflictsSoon() {
    if (conflictTimer || !gitx.isRepo(cfg.root)) return;
    conflictTimer = setTimeout(async () => {
      conflictTimer = null;
      try {
        await gitx.fetchAll(client, cfg.root);
        const found = await gitx.reportConflicts(client, cfg.root);
        if (found && found.length) log(`${found.length} branch${found.length === 1 ? '' : 'es'} would conflict with yours: ${found.map(x => x.other).join(', ')}`);
      } catch (e) { log('conflict check: ' + e.message); }
    }, 15000);
    conflictTimer.unref && conflictTimer.unref();
  }

  function start(id, what, job) {
    running.set(id, what);
    job().catch(e => log('autopilot: ' + e.message)).finally(() => { running.delete(id); work(); });
  }

  // hand out work until `max` Claudes are busy; each finished one makes room for the next
  async function work() {
    if (stopped) return;
    checkPrs().catch(() => {});
    if (pumping) { again = true; return; }
    pumping = true;
    try {
      do {
        again = false;
        // without worktrees they'd share one folder and one git index, so one at a time
        const room = gitx.isRepo(cfg.root) && cfg.requestsIn !== 'here' ? max : 1;
        while (!stopped && mode !== 'off' && running.size < room) {
          const b = await client.get('board');
          const low = !!(usage && typeof usage.five === 'number' && usage.five >= 90 && Date.now() - usage.at < 3600 * 1000);
          const next = pick(b, me, new Set([...skip, ...running.keys()]), mode, { low });
          if (!next) break;
          if (next.kind === 'plan') {
            const r = await client.post('claim-goal', { id: next.goal.id });
            if (!r.ok) { skip.add(next.goal.id); continue; }
            start(next.goal.id, 'plan', () => plan(next.goal));
            continue;
          }
          let t = next.task;
          if (next.kind === 'claim') {
            const r = await client.post('claim-task', { id: t.id });
            if (!r.ok) { skip.add(t.id); continue; }
            t = r.task;
          }
          start(t.id, t.title, () => task(t, b));
        }
      } while (again && !stopped);
    } catch (e) { log('autopilot: ' + e.message); }
    pumping = false;
  }

  return {
    get mode() { return mode; },
    get running() { return [...running.values()]; },
    refreshMode,
    work,
    // react to live events: board changes mean new work, setting changes may switch modes
    async onEvent(ev) {
      if (ev.type === 'setting' && ev.name === me) { await refreshMode(); log(`mode: ${MODE_WORDS[mode]}`); return work(); }
      if (ev.type === 'merge' && ev.from === me) { await refreshMode(); return work(); }
      if (ev.type === 'message' && wantsAnswer(ev.message)) {
        replied.add(ev.message.id); answeredAt.push(Date.now());
        // a reply is short, so it doesn't wait for a free slot
        return start('msg-' + ev.message.id, 'answer', () => answer(ev.message));
      }
      if (ev.type === 'usage' && ev.name === me) usage = ev.usage;
      if (ev.type === 'board' && ev.action === 'merge-request' && ev.task && ev.task.owner === me && gitx.isRepo(cfg.root)) return mergeLeft(ev.task);
      // a teammate shared new commits: fetch them and say whether they'd conflict with this branch
      if (ev.type === 'git' && ev.action === 'publish' && ev.ref && ev.ref.owner !== me) checkConflictsSoon();
      if (ev.type === 'project-setting') projectSettings = ev.settings || {};
      // approved: run it again with the command allowed
      if (ev.type === 'board' && ev.action === 'approve' && ev.task) skip.delete(ev.task.id);
      // someone pressed "Run again" on a stuck task
      if (ev.type === 'board' && ev.action === 'task-update' && ev.task && ev.task.status === 'todo') skip.delete(ev.task.id);
      if (ev.type === 'board') return work();
    },
    stop() { stopped = true; },
  };
}

// `huddle autopilot` with no mode: run here in the foreground (for when no
// Claude session is open in this folder)
async function runAutopilot(cfg, flags = {}) {
  const client = new Client(cfg, { ...identity(cfg, 'autopilot'), kind: 'autopilot' });
  const log = (m) => console.log(`${new Date().toLocaleTimeString()}  ${m}`);
  if (!claimRunner(cfg.root)) {
    console.log('Your Claude session in this folder is already taking requests in the background (one runner per folder).\nChange what it does with: huddle autopilot on|requests|off');
    return;
  }
  process.on('exit', () => releaseRunner(cfg.root));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const runner = createRunner({ cfg, client, flags, log, out: (d) => process.stdout.write(d.replace(/^/gm, '    ')) });
  await runner.refreshMode();
  log(`autopilot for ${cfg.name} in ${cfg.root}: ${MODE_WORDS[runner.mode]}`);
  if (runner.mode === 'off') log('nothing will run until you switch it on (huddle autopilot on, or from the dashboard)');
  log('waiting for work (ctrl-c to stop)');
  await runner.work();
  let seq = (await client.get('state')).seq;
  setInterval(() => client.post('hello', { runner: runner.mode }).catch(() => {}), 60000);
  for (;;) {
    const opened = await listenWs(client, seq, (ev) => runner.onEvent(ev));
    if (!opened) {
      try {
        const r = await client.get('events', { since: seq, wait: 25 }, { timeout: 35000 });
        for (const ev of r.events) { seq = ev.seq; await runner.onEvent(ev); }
        if (r.truncated) seq = r.seq;
      } catch { await new Promise(r => setTimeout(r, 5000)); }
    } else {
      seq = (await client.get('state').catch(() => ({ seq }))).seq;
      await runner.work();
    }
  }
}

function listenWs(client, since, onEvent) {
  return new Promise((resolve) => {
    if (typeof WebSocket !== 'function') return resolve(false);
    const q = new URLSearchParams({ token: client.cfg.token, since: String(since), agent: JSON.stringify(client.agent) });
    let ws, opened = false, ping;
    try { ws = new WebSocket(`${client.base.replace(/^http/, 'ws')}/ws?${q}`); } catch { return resolve(false); }
    ws.onopen = () => { opened = true; ping = setInterval(() => { try { ws.send('ping'); } catch {} }, 30000); };
    ws.onmessage = (m) => { if (m.data === 'pong') return; try { const ev = JSON.parse(m.data); if (['board', 'setting', 'message', 'usage', 'project-setting', 'git', 'note'].includes(ev.type)) onEvent(ev); } catch {} };
    // newer Node versions report a failed handshake as "error" alone, with no "close" after it
    let done = false;
    const finish = () => { if (done) return; done = true; clearInterval(ping); try { ws.close(); } catch {} setTimeout(() => resolve(opened), opened ? 1000 : 0); };
    ws.onclose = finish;
    ws.onerror = () => { if (!opened) finish(); };
  });
}

module.exports = { folderMcpServers, detectTests, neededCommands, needsAPerson, runAutopilot, createRunner, claimRunner, releaseRunner, pick, makeClone, landClone, normMode, getMode, MODES, MODE_WORDS, DEFAULT_MODE, planPrompt, taskPrompt, board };

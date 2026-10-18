# huddle

Let several Claude Code agents work on the same project at once, from different computers and different Claude subscriptions, without stepping on each other.

- **File locks.** When an agent starts editing a file, it's locked for that agent. Everyone else's copy goes read-only and Claude Code refuses their edits, with a note saying who has it.
- **Live edits.** Every edit streams to the other machines as it happens, so the others see the file change in real time (on disk, through the `huddle_view` tool, or in the web dashboard). No GitHub push needed.
- **Claudes talk to each other.** Agents message each other with `huddle_send`. Messages show up in the other agents' context automatically, and an agent that gets a direct message answers it before it stops.
- **Shared work.** Give the whole team a goal and the Claudes split it into tasks among themselves.
- **Dashboard.** A web page with a card per person saying what they and their Claude are doing, a timeline of everything happening, the code on everyone's branches (with live edits), the project brief and memory, task progress, and a box to message the Claudes.

Zero dependencies. Each person needs Claude Code, Node 18+ (22+ recommended) and git (for `npx github:`). Tested on Linux; macOS should work, Windows is untested.

## Quick start

**1. One person creates a project** on the free public server, from inside their copy of the project:

```sh
cd ~/code/myapp
npx -y github:flyingf15h/huddle new myapp --name sam
```

That sets up your folder and prints an invite like:

```
npx -y github:flyingf15h/huddle join eyJzIjoiaHR0cHM6Ly9...
```

**2. Everyone else runs the invite in their copy of the project:**

```sh
cd ~/code/myapp
npx -y github:flyingf15h/huddle join eyJzIjoiaHR0cHM6Ly9... --name alex
```

That's it. Start Claude Code in that folder and it's in the huddle. Each person uses their own Claude login, from anywhere.

Everyone needs the same starting code (clone the same repo/branch). huddle keeps files in step while you work, but it doesn't replace git.

The public server is `https://huddle.sage-hill.workers.dev`, running on Cloudflare's free tier. Every project gets its own token, so an invite only opens that one project. Projects untouched for 30 days are deleted. Shared files are capped at 1 MB each and 10 MB per project. If you'd rather not use it, see [Hosting your own server](#hosting-your-own-server).

## Using it with Claude

Everyone uses their own Claude Code with their own subscription (Pro, Max, Team, API key, anything) on their own computer. huddle never touches your Claude account. It plugs into Claude Code through hooks and an MCP server, and those talk to the huddle server over HTTPS. So it doesn't matter whose subscription it is or where they are.

After `join`, open Claude Code in that folder (restart it if it was already open) and prompt it normally. You don't have to mention huddle. At the start of every session Claude is told who else is online and what they're doing, which files are locked, and the team's PROJECT.md, memory and skills. Some prompts that use it directly:

- "What is everyone working on right now?"
- "Tell sam I'm taking over the auth module" / "Ask the others if anyone is touching the database schema"
- "Wait until the parser file is free, then add error recovery"
- "Remember for the team that the tests need Docker running"
- "Add our deploy steps to the shared PROJECT.md"
- "Turn how we cut a release into a shared skill"

Check `/mcp` in Claude Code if the tools don't show up: `huddle` should be listed as connected.

## Working together in real time

GitHub isn't involved in any of this. Everything goes through the huddle server as it happens.

- **Edits are live.** When two people are on the same branch, every edit one Claude makes lands in the other person's copy of the file within a second or two. While a Claude is editing a file it's locked: the file goes read-only for everyone else, and their Claude is told who has it instead of overwriting their work.
- **Whole folders can be locked.** A Claude (or you, with `huddle lock src/pages/`) can lock a folder before a bigger change: nobody else can edit anything inside it until it's released or that session ends, and no two locks may overlap, so nobody can lock a file inside someone's folder or a folder around someone's file.
- **Everyone knows what everyone is on.** When you give your Claude new work, the team sees it straight away (taken from your prompt, then a short summary from Claude). Each Claude is only told when another Claude's work changes, so this costs a few tokens, not a running report.
- **Hand-off notes.** When a session ends, it leaves a short note on where it left off and what's next (Claude writes it with `huddle_handoff`, or huddle writes one from its status, edited files and commits). The rest of the team sees it, and so does your next session.
- **Commits are shared automatically.** Whenever a Claude finishes a turn, any new commits are sent to the rest of the team through huddle. People on other branches get them when they merge (see [branches and merging](#different-versions-branches-and-merging)).
- **The Claudes message each other.** A Claude can message the whole team or one person's Claude, and the message shows up in the other Claude's context at its next step. A Claude that gets a direct message has to answer it before it stops. They also coordinate through the shared task list.
- **Requests start right away.** Something sent to a person's Claude with *New request* starts immediately unless their Claude is set to Off (see [Autopilot](#autopilot-what-your-claude-does-with-work-from-the-team)). A Claude that's mid-turn reads messages at its next step; an idle one answers in the background.

## Talking to all the Claudes at once

Write it in the **New request** box at the bottom of the dashboard (or run `huddle ask "add a history feature with tests"`) and pick who it's for:

- **Full team:** the first free Claude claims it, looks at the code, splits it into tasks with an owner each (split by file so nobody collides, with dependencies where needed), and tells the team. Every Claude is told which tasks are theirs, works on them, commits, and marks them done. Progress shows under **Tasks** on the right side of the dashboard.
- **One person's Claude:** pick them under **to**, or hover them in the team list and press **Ask**. Only their Claude gets it, as a task of its own, and runs it in the background on their computer if their mode allows; your own Claude isn't involved. Its reply comes back to you in the activity feed and your notifications. From the terminal: `huddle ask "..." --to alex`.

### Autopilot: what your Claude does with work from the team

Each person chooses, and can change it any time. It decides what starts in the background on your computer while your own Claude session isn't doing it:

| Setting | Requests and messages sent to your Claude | Team-wide requests and unassigned tasks |
|---|---|---|
| **Active** (default) | Start on their own | Your Claude plans team requests and takes open tasks |
| **Requests only** | Start on their own | Left to the others |
| **Off** | Wait until you open Claude in the project | Left to the others |

What that means in practice:

- **It doesn't matter who sent it.** A request from a person on the dashboard and one from another person's Claude (`huddle_ask_team` with a name) are treated the same, and so are messages.
- **Requests never need approval.** The only approval step is for shell commands (see [Commands that need your OK](#commands-that-need-your-ok)), and that applies in every mode.
- **Messages:** when another Claude messages yours and your session is idle, a short background Claude answers it. Automatic answers never start another run, so two Claudes can't keep each other going. If your session is busy, your Claude reads the message at its next step instead. With Off, messages wait for you.
- **Each request runs as its own Claude** (a new conversation in its own git worktree, up to 3 at once), so the conversation you're having isn't interrupted. When one finishes, its commits merge into your branch if they merge cleanly; otherwise they wait on `huddle-request-<id>` and the sender is told.
- **With Off,** your Claude is reminded about waiting requests when you next start it, and you decide what to do with them.

Background work needs Claude Code open in the project folder, or `huddle autopilot` running in a terminal there.

Change it from the menu at the bottom of the dashboard's sidebar, with `/autopilot on`, `/autopilot requests` or `/autopilot off` inside Claude Code (or just ask Claude), or with `huddle autopilot on|requests|off` in a terminal. The team list shows each person's status with a dot: orange for Active, green for online, grey for away.

### Checks before background work lands

Before work from a background Claude merges into your branch, two things check it, both on Sonnet to save usage. First, a Sonnet Claude reviews the diff for real bugs (not style), and gets one pass to fix what it finds. Then the project's tests run in that work's own worktree, and Sonnet gets one try to fix a failure. Work that still fails the tests stays on its `huddle-request-<id>` branch and the task is marked blocked. Tests that were already failing before the change don't hold it back. huddle guesses the test command (`npm test`, `pytest`, `cargo test`, `go test`, `make test`), or set it with `huddle tests "npm run check"`. `huddle tests --review off` turns the review off. The dashboard shows "Tests pass", "Tests failed" and "Reviewed" on each task.

### Commands that need your OK

A background Claude runs in Claude Code's auto mode, like your own sessions: safe commands go through and risky ones (deploys, publishing, deleting things outside the project) are refused, because nobody is there to approve them. When it needs one of those, it does what it can and asks. The command shows under **Awaiting your approval** in the dashboard, and you get a notification. Commands for the same request are grouped, with one **Approve all** / **Decline all**. Decide there, or with `huddle approve ID` (or `huddle approve --all`) in a terminal, or just tell your Claude. The task then runs again once, with those exact commands allowed. Inside its own worktree a background Claude can already fetch, merge, cherry-pick, rebase and restore without asking, since nothing reaches your branch until huddle has reviewed, tested and merged it. Only you can approve commands for your Claude. Approving from a browser needs the page to be opened with `huddle open` on your computer, which hands it a key nobody else has, so don't share that link.

### When someone runs out of usage or leaves

Tasks waiting for someone whose 5-hour window is over 90% used, or who has been offline for 10 minutes, move to an active teammate with room. So do tasks whose Claude hit its usage limit partway through, and tasks still in progress after their owner has been gone 20 minutes. A note on the task says why. Requests sent to one specific person stay with them.

### Locks for a whole task

A file is locked the moment a Claude edits it. Plans also give each task the files or folders it works in, and those are locked from the moment the task starts, so another Claude can't begin in the same place. A task whose area is taken waits and tries again a few minutes later.

### Catching up

Coming back after half an hour or more, the dashboard shows one dismissible line, like "Since 3 h ago: 4 tasks done · 2 messages · 1 waiting for your OK". The first Claude session you start gets the same summary in your terminal.

### Splitting big prompts across the team

When you give your Claude a prompt with several separate pieces of work, huddle suggests splitting it. Your Claude calls `huddle_distribute` with each part and how big it is (light, medium or heavy). huddle gives the heavier parts to whoever has the most of their 5-hour Claude window left, the other Claudes start on theirs right away, and your Claude does the parts it kept. Team-wide requests from the dashboard are split the same way. Each person's Claude Code status line reports how much of their window is used, and their card on the dashboard shows what's left.

Autopilot runs Claude on *your* computer with *your* Claude subscription, so your laptop has to be on. It needs either a Claude Code session open in the folder, or `huddle autopilot` running in a terminal there (for when you don't want Claude open). Each request, task or answer is its own Claude Code session, the same as if you had started a new conversation yourself: it starts for that one job and ends when the job is done. It runs in auto mode (accounts without auto mode get `acceptEdits`, which allows edits, git and the commands you've allowed), with your settings, your `CLAUDE.md` and `CLAUDE.local.md`, your `.claude/settings.local.json` and the MCP servers you added for the project folder. Pick another mode with `"autopilotPermissionMode": "acceptEdits"` in `.huddle/config.json`, or `huddle autopilot --permission-mode acceptEdits`. Allow more with `--allow`, for example `huddle autopilot --allow "Bash(npm test:*)"`, or set `"autopilotAllow": ["Bash(npm test:*)"]` in `.huddle/config.json` so it also applies in the background.

You hear about messages and requests sent to your Claude right away: while a Claude Code session is open in the folder, huddle shows a desktop notification for each message to you (or to everyone) and each request for your Claude, so you don't have to wait for your next prompt. Your Claude also leads its next turn with them. Set `"notify": false` in `.huddle/config.json` to turn the pop-ups off.

Board tasks close themselves: a commit whose message says `closes <task id>` (or `[<task id>]`) marks that task done, and when your Claude starts on something new it's reminded of tasks it still has in progress.

## Different versions, branches and merging

huddle carries git history between people itself (as git bundles through the server), so nobody needs access to anyone else's GitHub remote.

- **Joining with a different version:** `join` compares your copy with the team's. If they differ, you choose to merge theirs into yours (Claude can resolve conflicts), keep yours on your own branch and merge later, switch to theirs (yours is kept on a backup branch), or skip. Run `huddle sync` to do it again later. A folder that isn't a git repo gets git set up first.
- **Same branch or separate branches:** people on the same branch share a live working copy, with locks. On different branches (`huddle branch own`) nobody blocks anybody, but you still see each other's activity, chat and board, and get a heads-up when two people edit the same file on different branches. `huddle branch join alex` puts you back on someone's branch.
- **Merging:** commits are shared automatically at the end of each Claude turn. Everyone else's branches show up as `huddle/<person>/<branch>`, so `huddle merge alex` (or asking Claude "merge alex's branch") merges them. On conflicts, Claude gets the list of files to resolve.
- `.huddle/` and `.claude/settings.local.json` are always kept out of git. History that contains them is refused, so your invite token can't leak through a merge.

## Is this session in the huddle?

Two places tell you:

- **The status line** at the bottom of Claude Code shows `● huddle · physical-studio · Kelly online · takes requests` in any folder that's in a huddle. No huddle line means that session isn't connected. (huddle only adds it if you don't already have your own status line. Otherwise run `/mcp` and look for `huddle`.)
- **When the session starts**, a one-line notice says which project it joined, who else is online, and what your Claude does with requests.

Only sessions started in a joined folder (or a folder linked with `huddle link`) are in the huddle. A session that was already running when you joined isn't; restart it.

## The dashboard

Open it with `huddle open` in a joined folder, or with the dashboard link `join` printed. It updates live, so you can leave it open in a tab while you work. It has a light and a dark theme (following your system until you pick one with the button in the header), both drawn over a still image of water in the style of the Submerge wallpaper.

- **Sidebar:** the project switcher at the top, then the four pages, then the team list: what each person's Claude is working on, what's happening right now (including background Claudes), how much Claude usage they have left, and a dot for their status. Click someone to see only their activity. Right-click yourself, or click your name at the bottom, to change your name or your Claude's name; everything you did moves to the new name, and your computer's huddle config picks it up. Your Claude's mode is at the bottom.
- **Activity:** everything that happens, newest at the bottom. Each row says who did what ("tszfei requested from the team", "kelly messaged you"), then the content: prompts, the steps Claude took (long runs collapse), a one-line summary of its reply (hover for all of it), plans, and messages. Filter by Everything, Claude's work or Messages.
- **Code:** pick anyone's shared branch and browse its files. A file someone is editing right now is marked with a lock and has a **Show live version** button, so you can watch it change before anything is committed.
- **Brief & memory:** the project brief, team memory and shared skills that every Claude reads when it starts. You can read and edit all of it there.
- **Usage:** how much each person used Claude in this project.
- **Right side:** task progress for every request, which files are being edited right now and by whom, and recently changed files.
- **New request:** the box at the bottom, for giving the Claudes something to build (see above).
- **The bell** lists messages to you, requests for your Claude and commands waiting for your approval, with **Mark all as read**. Set it to **Do not disturb** to keep collecting them without pop-ups or desktop alerts, and turn desktop alerts on from there.
- **Invite people** shows the command to send a teammate. The **?** button explains huddle, including the modes, and runs a short tour.

If you're in several projects, each one has its own dashboard address (`…/#p=project-name`), so separate tabs and bookmarks stay on their own project. The plain address opens the project you used last, and the switcher at the top of the sidebar lists every project you've opened in that browser. Press Escape or **Back** on the invite screen to return to the project you came from.

## What's shared, and what isn't

- Only Claude Code sessions started **inside the joined folder** are connected. Claude anywhere else on your computer never sees huddle and nothing from it is shared.
- Inside the folder, your prompts, Claude's replies and its tool calls show up in the team's timeline (so everyone can follow along). To keep one turn to yourself, start the prompt with **`private:`**, e.g. `private: draft a message to my manager`. That whole turn, prompt, replies and tool calls, stays out of the feed, and Claude is told not to repeat it to the team. File edits still sync, since they're project work.
- `huddle sharing tools` shares only which tools ran (no conversation), and `huddle sharing off` shares neither.
- Keep your huddle projects together in one parent folder? Run `huddle link PROJECT_FOLDER` in the parent, and Claude started in the parent joins that project's huddle too. Only files inside the project folder are shared; anything else in the parent stays yours. `huddle unlink` undoes it.
- The Claudes' huddle tools only reach the project the folder is joined to. Each project has its own token, and nothing crosses between projects.

## Shared team knowledge

None of this lives in git, so you can use huddle on a repo without committing anything to it.

- **PROJECT.md**: the project brief (goals, conventions, architecture, who owns what). Every agent gets it at session start, like a CLAUDE.md the whole team shares. Edit it with `huddle project --edit`, load an existing file with `huddle project --set CLAUDE.md`, edit it in the dashboard, or have an agent do it with `huddle_project`.
- **Memory**: short notes like "tests need FOO=1, otherwise the db fixture hangs". Agents save them with `huddle_remember` when they learn something the others would otherwise rediscover, and everyone else sees new ones right away.
- **Skills**: shared `SKILL.md` procedures, installed into everyone's `.claude/skills/` (and kept out of git through `.git/info/exclude`). Share one with `huddle skill add path/to/skill`, or have an agent use `huddle_save_skill`.

A copy of everything is kept in `.huddle/shared/` in each folder.

## What the agents get

Hooks (in `.claude/settings.local.json`) enforce the rules on their own, so agents don't have to remember anything:

| When | What happens |
| --- | --- |
| Session starts | Agent is told who else is online, what they're doing and what's locked |
| Before Edit / Write | File gets locked for this agent. If someone else has it, the edit is refused and the agent is told who, plus its options. If this copy is out of date, it's refreshed first and the agent re-reads it |
| After each edit | New contents go to the server and out to everyone else's disk |
| After any tool / each prompt | New messages from other agents get added to the agent's context |
| Turn ends | Its locks are released, unless it reserved them with `hold` (folder locks stay). Commits that say `closes <task>` close it. If someone sent it a direct message, it has to answer first |
| Session ends | Everything it held is released, and a hand-off note is left if Claude didn't write one |

Each prompt is one request to the server: it shares the prompt and status, reads mail, and gets back only what changed since that Claude last looked (other Claudes' work, the board, shared knowledge, new hand-off notes).

MCP tools (registered for that folder only):

| Tool | Use |
| --- | --- |
| `huddle_status` | Who's online, what they're doing, locks, recent edits |
| `huddle_set_status` | "Working on the auth middleware" |
| `huddle_send` | Message everyone, or one agent by name |
| `huddle_inbox` | Read messages; can block waiting for a reply |
| `huddle_lock` / `huddle_unlock` | Reserve files or whole folders up front, optionally across turns |
| `huddle_handoff` | Leave a note on where you left off and what's next |
| `huddle_wait` | Block until a locked file is free, then take it |
| `huddle_view` | See another agent's file mid-edit |
| `huddle_project` | Read or update the shared PROJECT.md |
| `huddle_remember` / `huddle_recall` / `huddle_forget` | Shared team memory |
| `huddle_save_skill` / `huddle_delete_skill` | Shared skills |
| `huddle_activity` | What the other Claudes are doing |
| `huddle_ask_team` / `huddle_board` | Give the team a goal, see goals and tasks |
| `huddle_claim_goal` / `huddle_plan` | Plan a goal: split it into tasks with owners |
| `huddle_claim_task` / `huddle_update_task` | Take a task, mark it doing/done/blocked |
| `huddle_branches` / `huddle_publish` / `huddle_merge` | Everyone's branches, share yours, merge theirs |

## Commands

```
huddle new [NAME] [--server URL]       create a project (public server by default)
huddle server [--port 7777] [--tunnel] [--project NAME] [--data DIR] [--open]
huddle join <invite> [--name NAME]     set up the current folder
huddle leave                           undo join in this folder
huddle update [--from DIR] [--ref REF] newest huddle from GitHub (or a local checkout), hooks refreshed in every joined folder
huddle permissions [--write]           shared .claude/settings.json: no prompts for edits, huddle, git, builds and tests
huddle status                          each person, their Claudes and what they're on, locks, recent edits, hand-offs
huddle tidy                            merge names that differ only in capitals, drop old sessions
huddle handoff ["note"]                leave a hand-off note, or read everyone's
huddle send <text> [--to NAME]         message the agents yourself
huddle inbox [--wait SECONDS]
huddle watch                           live feed in your terminal, keeps files synced while you edit by hand
huddle lock <file|folder/> / huddle unlock [file|folder/]
huddle invite                          print the invite for this project again
huddle open                            open the dashboard
```

`join` copies huddle to `~/.huddle/app` and, if `~/.local/bin` is on your PATH, puts a `huddle` command there. That way the hooks still work after npx clears its cache. `huddle update` replaces that copy with the newest version; the session-start line tells you when a teammate runs a newer one.

## Hosting your own server

Quickest, from any machine that stays on while you work:

```sh
npx -y github:flyingf15h/huddle server --tunnel --project myapp
```

`--tunnel` gives it a public https URL through a free Cloudflare quick tunnel (needs [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)). The URL changes on every restart. Without `--tunnel` you get LAN and Tailscale URLs. It prints the invite to send around.

For something permanent:

- **Cloudflare Workers (free):** `cd worker && npm install && npx wrangler deploy`, then `npx wrangler secret put HUDDLE_SECRET` with a long random string. Never change that secret, because every project token is derived from it. Then `huddle new --server https://your-worker.workers.dev`.
- **Docker anywhere:** `docker build -t huddle . && docker run -p 7777:7777 -v huddle-data:/data huddle`, with HTTPS in front. Add `-e HUDDLE_OPEN=1` to let anyone create projects on it with `huddle new --server URL`.

## How it works

- The server keeps agents, locks, the latest contents of every file that's been edited, and chat. The same core (`src/core.js`) runs in Node (`src/server.js`, saved to disk) and on Cloudflare (`worker/`, one Durable Object per project). On Cloudflare, clients stream events over hibernating WebSockets, so idle projects cost nothing. A self-hosted Node server falls back to long-polling and SSE.
- Each Claude session runs the huddle MCP server, which also runs the **sync** for that folder. When an agent on another machine locks a file, sync makes the local copy read-only (`chmod a-w`). Their edits are written in as they happen, and write access comes back when they release it. If a shell command changes a locked file anyway, sync puts the holder's version back and saves yours in `.huddle/conflicts/`. Only one sync runs per folder.
- Locks belong to a single Claude session. If a session crashes, its locks expire after 5 minutes without a heartbeat.
- The invite code is just the server URL, token and project name in base64. Anyone who has it can join, so only send it to the people you're working with. `.huddle/` (which holds the token) is added to `.git/info/exclude`, so it won't get committed.

## Limits

- Edits made with Claude's Edit/Write tools are tracked. Files created or deleted through shell commands aren't shared automatically, so commit and pull those through git as usual.
- Text files up to 2 MB.
- No merging: one agent per file at a time. That's the point, but split big files if agents keep queueing on them.

## Tests

```sh
npm test
```

Starts a real server and three fake checkouts, and drives the hooks and MCP servers the same way Claude Code does. `HUDDLE_TEST_URL=https://... npm test` runs the same checks against a deployed open server.

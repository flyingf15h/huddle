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
- **Commits are shared automatically.** Whenever a Claude finishes a turn, any new commits are sent to the rest of the team through huddle. People on other branches get them when they merge (see [branches and merging](#different-versions-branches-and-merging)).
- **The Claudes message each other.** A Claude can message the whole team or one person's Claude, and the message shows up in the other Claude's context at its next step. A Claude that gets a direct message has to answer it before it stops. They also coordinate through the shared task list.
- **One limitation: an idle Claude doesn't wake up.** A Claude that's waiting for its person to type something sees new messages and tasks at its next step, not instantly. If you want your Claude to react with nobody at the keyboard, run `huddle autopilot` (below).

## Talking to all the Claudes at once

Write it in the **Message Claude** box at the bottom of the dashboard (or run `huddle ask "add a history feature with tests"`) and pick who it's for:

- **Full team:** the first free Claude claims it, looks at the code, splits it into tasks with an owner each (split by file so nobody collides, with dependencies where needed), and tells the team. Every Claude is told which tasks are theirs, works on them, commits, and marks them done. Progress shows under **Tasks** on the right side of the dashboard.
- **One person:** only that person's Claude gets it, as a task of its own (`huddle ask "..." --to alex` from the terminal).

A Claude only acts when it's running. In a normal Claude Code session, it sees new goals and tasks at its next step and works on them if you say so. To let your Claude take team work by itself, run

```sh
huddle autopilot --allow "Bash(npm test:*)"
```

in your folder. It waits for team work, then runs `claude -p` with your own subscription to plan goals and do your tasks, commits the results and shares them. By default it can edit files and run git. Use `--allow` to add other commands, such as your test runner. Stop it with ctrl-c.

## Different versions, branches and merging

huddle carries git history between people itself (as git bundles through the server), so nobody needs access to anyone else's GitHub remote.

- **Joining with a different version:** `join` compares your copy with the team's. If they differ, you choose to merge theirs into yours (Claude can resolve conflicts), keep yours on your own branch and merge later, switch to theirs (yours is kept on a backup branch), or skip. Run `huddle sync` to do it again later. A folder that isn't a git repo gets git set up first.
- **Same branch or separate branches:** people on the same branch share a live working copy, with locks. On different branches (`huddle branch own`) nobody blocks anybody, but you still see each other's activity, chat and board, and get a heads-up when two people edit the same file on different branches. `huddle branch join alex` puts you back on someone's branch.
- **Merging:** commits are shared automatically at the end of each Claude turn. Everyone else's branches show up as `huddle/<person>/<branch>`, so `huddle merge alex` (or asking Claude "merge alex's branch") merges them. On conflicts, Claude gets the list of files to resolve.
- `.huddle/` and `.claude/settings.local.json` are always kept out of git. History that contains them is refused, so your invite token can't leak through a merge.

## The dashboard

Open it with `huddle open` in a joined folder, or with the dashboard link `join` printed. It updates live, so you can leave it open in a tab while you work.

- **Team cards** across the top, one per person, saying in plain words what they and their Claude are doing right now ("Claude edited viewer/src/Scene.tsx", "Claude is idle"), whether they're online, which branch they're on, and how many tasks they have in progress. Click a card to see only that person.
- **Timeline:** everything that happens, in order. Messages between the Claudes, what each person asked their Claude, the commands it ran and files it edited, its replies, and task updates. Filter it with the chips above it.
- **Code:** pick anyone's shared branch and browse its files. A file someone is editing right now is marked with a lock and has a **Show live version** button, so you can watch it change before anything is committed.
- **Brief & memory:** the project brief, team memory and shared skills that every Claude reads when it starts. You can read and edit all of it right there.
- **Right side:** task progress for every goal, which files are being edited right now and by whom, and recently changed files.
- **Message Claude:** the box at the bottom, for giving the Claudes something to build (see above).
- **Invite people** shows the exact steps and command to send a teammate.

If you're in several projects, each one has its own dashboard address (`…/#p=project-name`), so separate tabs and bookmarks stay on their own project. The plain address opens the project you used last, and a switcher in the header lists every project you've opened in that browser.

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
| Turn ends | Its locks are released, unless it reserved them with `hold`. If someone sent it a direct message, it has to answer first |
| Session ends | Everything it held is released |

MCP tools (registered for that folder only):

| Tool | Use |
| --- | --- |
| `huddle_status` | Who's online, what they're doing, locks, recent edits |
| `huddle_set_status` | "Working on the auth middleware" |
| `huddle_send` | Message everyone, or one agent by name |
| `huddle_inbox` | Read messages; can block waiting for a reply |
| `huddle_lock` / `huddle_unlock` | Reserve files up front, optionally across turns |
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
huddle status                          who's online, locks, recent edits
huddle send <text> [--to NAME]         message the agents yourself
huddle inbox [--wait SECONDS]
huddle watch                           live feed in your terminal, keeps files synced while you edit by hand
huddle lock <file> / huddle unlock [file]
huddle invite                          print the invite for this project again
huddle open                            open the dashboard
```

`join` copies huddle to `~/.huddle/app` and, if `~/.local/bin` is on your PATH, puts a `huddle` command there. That way the hooks still work after npx clears its cache.

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

# huddle

Let several Claude Code agents work on the same project at once, from different computers and different Claude subscriptions, without stepping on each other.

- **File locks.** When an agent starts editing a file, it's locked for that agent. Everyone else's copy goes read-only and Claude Code refuses their edits, with a note saying who has it.
- **Live view.** Every edit streams to the other machines as it happens, so the others see the file change in real time (on disk, through the `huddle_view` tool, or in the web dashboard).
- **Chat.** Agents message each other with `huddle_send`. Messages show up in the other agents' context automatically, and an agent that gets a direct message answers it before it stops.
- **Dashboard.** A web page that shows who's online, what's locked, live file contents and the chat. Humans can post there too.

Zero dependencies. Needs Node 18+ and Claude Code.

## Quick start

**1. One person hosts the server** (any machine that stays on while you work):

```sh
npx -y github:flyingf15h/huddle server --tunnel --project myapp
```

`--tunnel` gives the server a public https URL through a free Cloudflare quick tunnel (install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) first). Without it you get LAN and Tailscale URLs, which also work if everyone's on the same network or tailnet.

It prints an invite like:

```
invite:     npx -y github:flyingf15h/huddle join eyJzIjoiaHR0cHM6Ly9...
```

**2. Everyone (host included) runs the invite in their copy of the project:**

```sh
cd ~/code/myapp
npx -y github:flyingf15h/huddle join eyJzIjoiaHR0cHM6Ly9... --name sam
```

That's it. Start Claude Code in that folder and it's in the huddle. Each person uses their own Claude login.

Everyone needs the same starting code (clone the same repo/branch). huddle keeps files in step while you work, but it doesn't replace git.

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

## Commands

```
huddle server [--port 7777] [--tunnel] [--project NAME] [--data DIR]
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

## Hosting the server for good

A quick tunnel's URL changes every time you restart it. For something permanent, run the server anywhere that can serve HTTP:

```sh
docker build -t huddle . && docker run -p 7777:7777 -v huddle-data:/data huddle
```

Put HTTPS in front of it (Caddy, a Cloudflare named tunnel, Fly.io, Render, etc.). The token is generated on first start and saved in the data dir, or you can set `HUDDLE_TOKEN`. One server can host any number of projects.

## How it works

- The server keeps agents, locks, the latest contents of every file that's been edited, and chat in memory, and saves them to `state.json`. Clients long-poll it for events, and the dashboard uses SSE.
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

Starts a real server and three fake checkouts, and drives the hooks and MCP servers the same way Claude Code does.

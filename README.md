# huddle

**Your whole team's AI coding agents, working on one codebase at the same time.**

You use Claude Code, a teammate uses Codex, someone else is on Cursor. Normally those three agents edit the same files on three laptops and you find out at merge time. huddle connects them. A file one agent is editing is locked for the others, edits show up on everyone's machine as they happen, and the agents talk to each other to split the work.

It's made for small teams where everyone brings their own subscription: hackathon teams, class projects, a few friends shipping something.

```sh
curl -fsSL https://huddle.sage-hill.workers.dev/install.sh | sh                 # start a project, get an invite link
curl -fsSL https://huddle.sage-hill.workers.dev/install.sh | sh -s -- <invite>  # everyone else, in their copy of the repo
```

On Windows: `irm https://huddle.sage-hill.workers.dev/install.ps1 | iex`. No sign-up, nothing committed to your repo.

![The activity feed, team list and tasks](public/shots/activity.webp)

## What you get

- **Nobody overwrites anybody.** While an agent edits a file, everyone else's copy is read-only and their agent is told who has it.
- **Live edits.** Changes land on teammates' machines within a second or two, long before anyone commits.
- **Agents that talk.** "Ask dev's agent if anyone is touching the schema" just works, and so does "tell sam I'm taking auth".
- **Work that splits itself.** Describe a feature once. huddle plans it and hands each part to whoever has the most usage left in their 5-hour window.
- **It keeps going while you're away.** Requests sent to your agent run in the background in their own git worktree. A second agent reviews the change, and it only merges if the tests pass.
- **One memory for the team.** A project brief, notes and skills that every agent reads when it starts, so nobody rediscovers the same gotcha.
- **Unity and Blender too.** Agents can build scenes and models inside the editor, and those files are locked so you never end up with two versions of a scene that can't be merged.
- **A dashboard for all of it.** What everyone's agent is doing, tasks, the code on every branch, usage and cost, and every setting.

## Quick start

One person, inside the project folder:

```sh
npx -y github:flyingf15h/huddle new
```

It prints an invite. Everyone else runs it in their own copy of the repo:

```sh
npx -y github:flyingf15h/huddle join <invite>
```

Then open your agent in that folder and work like you normally would. You don't have to mention huddle. If something seems off, `huddle doctor` says what to fix.

Start everyone from the same repo and branch. huddle keeps files in step while you work, and git still holds the history.

**Codex or Cursor:** add `--agent codex` or `--agent cursor` to `join` (it's picked for you if it's the only one installed). Trust the folder and huddle's hooks the first time you open it. They get the same locks, messages and board as Claude Code.

## Unity and Blender

Turn them on in the dashboard (Team & settings, then Integrations) or with `huddle apps add unity blender`. Every teammate's agent gets the editor's MCP server at its next session. Each person then sets up their editor once:

- **Unity:** install [uv](https://docs.astral.sh/uv/getting-started/installation/), add `https://github.com/CoplayDev/unity-mcp.git?path=/MCPForUnity#main` in the Package Manager, then open Window > MCP for Unity and click Start Bridge.
- **Blender:** install uv, run `uvx mcp-for-blender install-addon`, turn the add-on on in Preferences, then press N in the viewport and click Start MCP Server.

Now you can ask for "a pause menu in the Menu scene" or "a low-poly crate saved to art/crate.blend". Scenes, prefabs and .blend files are locked when an agent changes them, and an agent is refused a scene a teammate is working on. Background agents don't get editor tools, because the editor has your own folder open.

## Dashboard or terminal

Almost everything lives in the dashboard (`huddle open`): sending requests, approving commands, rules, editors, invites and roles, notifications, Slack, GitHub and exports. The terminal is only for things that happen on your computer: `new`, `join`, `leave`, `doctor`, `update`, `watch` and git syncing. `huddle help` lists every command.

## Privacy

- Teammates see which tools your agent ran, not your prompts or replies. `huddle sharing full` shares the conversation too. Start a prompt with `private:` to keep that turn out of the feed.
- `.env` files, keys and anything marked private never leave your computer, and API keys and passwords are stripped from everything that's shared.
- huddle never touches your agent's account. It plugs in through hooks and an MCP server.

## Hosting

The free public server runs on Cloudflare at `huddle.sage-hill.workers.dev`. Projects untouched for 30 days are deleted. To run your own, `huddle server --tunnel` works from any machine that stays on, or deploy the Worker in `worker/` (see [the guide](docs/guide.md#hosting-your-own-server)).

## Limits

- One agent per file at a time. If agents keep queueing on one big file, split it.
- Edits made with the agent's edit tools stream live. Files changed by shell commands, or by hand in Unity or Blender, travel through git as usual.
- Developed on Linux. macOS and Windows run in CI.

## More

[The full guide](docs/guide.md) covers autopilot, reviews, pull requests, approvals, accounts, branches, notifications and everything else. Run the tests with `npm test`. MIT licensed.

# huddle progress

Multi-agent Claude collaboration: file locks (read-only for others, live view), chat.

Done (untested):
- src/server.js   relay: agents, locks, live file contents, messages, SSE/long-poll events, token auth, state.json persistence
- src/client.js   config (.huddle/config.json), identity (claude pid), HTTP client
- src/sync.js     per-checkout syncer: chmod -w files locked by other checkouts, writes their edits in live, reverts local tampering
- src/hooks.js    Claude Code hooks: pre (auto-lock / deny), post (push content + inbox), prompt, stop (release + block on DMs), session-start/end

TODO:
- src/dashboard.html (server reads it at startup, so server won't run until it exists)
- src/mcp.js      stdio MCP: huddle_status/lock/unlock/wait/view/send/inbox/set_status, runs Sync
- src/cli.js      server, join (writes config + .claude/settings.local.json hooks + `claude mcp add -s local`), watch, status, send, inbox, hook <event>, mcp
- package.json, README (tunnel via tailscale/cloudflared), e2e test with two fake checkouts

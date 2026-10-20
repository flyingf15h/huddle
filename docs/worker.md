# Always-on worker

Schedules, GitHub labels and Slack requests only get worked on while some teammate's agent is online. A worker is a teammate that never sleeps: a small machine or container that joins your project and runs autopilot.

    huddle worker <invite> --repo git@github.com:you/repo.git --dir ~/huddle-worker

It clones the repo, joins as `worker`, and works requests in the foreground. Restart it with systemd (`deploy/huddle-worker.service`) or Docker (`deploy/Dockerfile.worker`). It reads `HUDDLE_INVITE`, `HUDDLE_REPO` and `HUDDLE_WORKER_DIR` so you can skip the flags.

The machine needs git, the agent CLI you use (claude, codex or cursor's `agent`) signed in or keyed, and push access to the repo if you want finished work on branches. Name a schedule's "to" as `worker` to make sure it lands there.

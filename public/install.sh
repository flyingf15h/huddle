#!/bin/sh
# huddle in one line, run inside your project folder:
#   curl -fsSL https://huddle.sage-hill.workers.dev/install.sh | sh -s -- INVITE   (join a team)
#   curl -fsSL https://huddle.sage-hill.workers.dev/install.sh | sh                  (start a project)
# It checks that node and git are here, then runs huddle. Nothing else is installed globally.
set -e

say() { printf '%s\n' "$*"; }
fail() { say "huddle: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js isn't installed. Get it from https://nodejs.org (version 18 or newer), then run this again."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || fail "Node $(node -v) is too old. huddle needs version 18 or newer (22 is best): https://nodejs.org"
command -v npx >/dev/null 2>&1 || fail "npx is missing; it comes with Node.js from https://nodejs.org"
command -v git >/dev/null 2>&1 || say "huddle: git isn't installed, so code won't be shared through huddle (live edits still are)."
[ -d .git ] || say "huddle: this folder isn't a git repository. Run this from your project's root folder if you meant to."

HUDDLE="npx -y github:flyingf15h/huddle"
# answers to questions (your name) need the keyboard, which a piped script doesn't have
if [ ! -t 0 ] && [ -r /dev/tty ]; then exec </dev/tty; fi

if [ -n "$1" ]; then
  exec $HUDDLE join "$@"
elif [ -n "$HUDDLE_SERVER" ]; then
  exec $HUDDLE new --server "$HUDDLE_SERVER"
else
  exec $HUDDLE new
fi

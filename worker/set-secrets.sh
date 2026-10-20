#!/bin/sh
# Sets the Worker's account secrets without putting them in your shell history or on screen.
# Run from the worker/ folder, signed in to wrangler:   sh set-secrets.sh
# Leave a prompt empty to skip that one.
set -e
ask() {
  printf '%s: ' "$1" >&2
  stty -echo 2>/dev/null || true
  read -r v
  stty echo 2>/dev/null || true
  printf '\n' >&2
  if [ -n "$v" ]; then printf '%s' "$v" | npx wrangler secret put "$1"; fi
}
ask RESEND_API_KEY
ask EMAIL_FROM
ask GITHUB_CLIENT_ID
ask GITHUB_CLIENT_SECRET

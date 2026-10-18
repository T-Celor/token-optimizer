#!/usr/bin/env bash
# Launch Claude Code through Headroom (subscription or API).
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if command -v headroom &>/dev/null; then
  exec headroom wrap claude "$@"
fi

# Fallback: manual proxy
if ! pgrep -f "headroom proxy" &>/dev/null; then
  echo "Starting Headroom proxy on :8787 …"
  headroom proxy --port 8787 &
  sleep 1
fi
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
exec claude "$@"

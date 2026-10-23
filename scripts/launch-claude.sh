#!/usr/bin/env bash
# Launch Claude Code through the stack (subscription or API), with token-stack.
# Not `headroom wrap claude`: wrap sets ENABLE_TOOL_SEARCH=true, which makes Headroom skip
# its own tool-schema deferral, about half its saving in our benchmark (README.md, Results).
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if command -v token-stack &>/dev/null; then
  exec token-stack claude "$@"
fi
exec "$(dirname "$0")/../token-stack" claude "$@"

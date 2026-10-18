#!/usr/bin/env bash
# Launch GitHub Copilot CLI through Headroom.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

if command -v headroom &>/dev/null; then
  exec headroom wrap copilot "$@"
fi

echo "Headroom not found in PATH. Install with: pip install \"headroom-ai[proxy]\""
exit 1

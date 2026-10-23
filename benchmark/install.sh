#!/usr/bin/env bash
# Installs what the benchmarks need (run_session.mjs, run_ab.mjs):
#   - the stack's best combination, as ../install.sh does by default
#   - the tools the benchmark compares it with: pxpipe, code-review-graph, and the Caveman
#     plugin, installed but disabled so it stays out of your own Claude Code sessions (the
#     benchmark loads it by path in the arms that use it)
#   - the Claude Agent SDK, pinned in package-lock.json
#
# Usage: benchmark/install.sh   (as your normal user; it calls sudo where needed)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$HERE/../install.sh" --benchmark-tools

echo ""
echo "[+] Installing the benchmark's dependencies (Claude Agent SDK)…"
command -v npm &>/dev/null || { echo "npm not found. Install Node.js 20.19+ and re-run." >&2; exit 1; }
(cd "$HERE" && npm ci)

echo ""
echo "[+] Benchmark ready. From $HERE:"
echo "      node run_session.mjs                   # checks only, no model calls"
echo "      node run_session.mjs --live            # baseline vs the installed best combination"
echo "      node run_session.mjs --live --arms all # every combination (see harness.mjs)"

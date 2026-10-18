#!/usr/bin/env bash
# One-shot installer for the Token Optimization Stack
# RTK + Headroom + Caveman
# Works on Linux / macOS. Windows: use WSL or follow README manual steps.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[x]${NC} $*"; exit 1; }

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Token Optimization Stack – Installer                   ║"
echo "║   RTK + Headroom + Caveman                               ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""

# ---------------------------------------------------------------------------
# 1. RTK
# ---------------------------------------------------------------------------
info "Installing RTK (Rust Token Killer)…"

if command -v rtk &>/dev/null; then
  warn "RTK already present: $(rtk --version 2>/dev/null || echo 'unknown')"
else
  if command -v brew &>/dev/null; then
    brew install rtk-ai/tap/rtk || true
  fi
  if ! command -v rtk &>/dev/null; then
    curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh
  fi
fi

if command -v rtk &>/dev/null; then
  info "RTK OK → $(rtk --version 2>/dev/null || echo installed)"
  # Global init (non-interactive if possible)
  rtk init -g --auto-patch 2>/dev/null || rtk init -g || warn "Run 'rtk init -g' manually later"
else
  warn "RTK install may have failed – install manually from https://github.com/rtk-ai/rtk"
fi

# ---------------------------------------------------------------------------
# 2. Headroom
# ---------------------------------------------------------------------------
info "Installing Headroom…"

if command -v headroom &>/dev/null; then
  warn "Headroom already present"
else
  if command -v pipx &>/dev/null; then
    pipx install "headroom-ai[all]" || pipx install "headroom-ai[proxy]"
  elif command -v pip3 &>/dev/null; then
    pip3 install --user "headroom-ai[all]" || pip3 install --user "headroom-ai[proxy]"
  elif command -v pip &>/dev/null; then
    pip install --user "headroom-ai[all]" || pip install --user "headroom-ai[proxy]"
  else
    error "Neither pip nor pipx found. Install Python 3.10+ first."
  fi
fi

# Ensure PATH for user installs
export PATH="$HOME/.local/bin:$PATH"

if command -v headroom &>/dev/null; then
  info "Headroom OK → $(headroom --version 2>/dev/null || echo installed)"
else
  warn "Headroom binary not in PATH. Try: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ---------------------------------------------------------------------------
# 3. Caveman
# ---------------------------------------------------------------------------
info "Installing Caveman…"

if command -v node &>/dev/null; then
  npx --yes @caveman-ai/cli@latest || warn "Caveman CLI install failed – you can still use the skill/plugin"
else
  warn "Node.js not found – skipping Caveman CLI. Install Node 22+ or use the Claude Code plugin."
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
info "Installation finished."
echo ""
echo "Next steps:"
echo "  1. Restart your terminal (or source your shell rc)"
echo "  2. Launch an agent through Headroom:"
echo "       headroom wrap claude      # Claude Code"
echo "       headroom wrap copilot     # GitHub Copilot CLI"
echo "  3. Run the local benchmark:"
echo "       python3 benchmark/run_benchmark.py"
echo ""
echo "Optional: register Headroom MCP tools"
echo "  headroom mcp install"
echo ""

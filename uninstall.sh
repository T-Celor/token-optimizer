#!/usr/bin/env bash
# Uninstaller for the Token Optimization Stack
# RTK + Caveman + Ponytail + code-review-graph + Headroom -> pxpipe
# Mirrors install.sh. Asks before each removal.
#
# Usage: ./uninstall.sh [--yes] [--dry-run]
#   --yes      remove everything without prompting
#   --dry-run  show what would be removed, change nothing

set -uo pipefail

# Same as install.sh: user-level files (RTK, npm global, plugins) must be touched as the user.
if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user, not root (no sudo). The script calls sudo where needed." >&2
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[x]${NC} $*"; }

ASSUME_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,9p' "$0"
      exit 0
      ;;
    *) error "Unknown option: $arg"; exit 2 ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Token Optimization Stack – Uninstaller                 ║"
echo "║   RTK + Caveman + Ponytail + code-review-graph           ║"
echo "║   + Headroom -> pxpipe                                   ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
[ "$DRY_RUN" -eq 1 ] && warn "Dry run: nothing will be removed"

# confirm "<question>" → returns 0 if the user agrees (or --yes was given)
confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ "$DRY_RUN" -eq 1 ] && return 0
  read -r -p "$1 [y/N] " reply
  [[ "$reply" =~ ^[Yy]$ ]]
}

# run "<description>" <command...> → runs the command, or prints it in dry-run mode
run() {
  local what="$1"
  shift
  if [ "$DRY_RUN" -eq 1 ]; then
    info "would run: $*"
  else
    "$@" && info "$what"
  fi
}

# ---------------------------------------------------------------------------
# 1. token-stack launcher (stop the proxies first)
# ---------------------------------------------------------------------------
info "Removing the token-stack launcher…"
if command -v token-stack &>/dev/null; then
  run "Proxies started by token-stack stopped" token-stack stop
fi
if [ -e /usr/local/bin/token-stack ] && confirm "Delete /usr/local/bin/token-stack (sudo required)?"; then
  run "Deleted /usr/local/bin/token-stack" sudo rm -f /usr/local/bin/token-stack
fi
if [ -d /usr/local/lib/token-stack ] && confirm "Delete /usr/local/lib/token-stack, the context gate (sudo required)?"; then
  run "Deleted /usr/local/lib/token-stack" sudo rm -rf /usr/local/lib/token-stack
fi

# ---------------------------------------------------------------------------
# 2. Caveman and Ponytail plugins
# ---------------------------------------------------------------------------
info "Removing the Caveman and Ponytail plugins…"
if command -v claude &>/dev/null; then
  installed="$(claude plugin list --json 2>/dev/null)"
  for id in caveman@caveman ponytail@ponytail; do
    if ! grep -q "\"id\": *\"$id\"" <<<"$installed"; then
      warn "$id not installed (nothing to remove)"
    elif confirm "Uninstall the Claude Code plugin $id?"; then
      run "$id uninstalled" claude plugin uninstall "$id" --scope user
      run "Marketplace ${id#*@} removed" claude plugin marketplace remove "${id#*@}"
    fi
  done
else
  warn "Claude Code CLI not found – remove the plugins from inside Claude Code with /plugin"
fi

# The Caveman npm CLI was installed by earlier versions of install.sh. If you ever ran
# `caveman setup --install`, run Caveman's own uninstaller first so it restores the
# ANTHROPIC_BASE_URL it changed: npx -y github:JuliusBrussee/caveman -- --uninstall
if npm ls -g --depth=0 @caveman-ai/cli &>/dev/null; then
  if confirm "Uninstall the old global Caveman CLI (@caveman-ai/cli) via npm?"; then
    run "Caveman CLI removed" npm uninstall -g @caveman-ai/cli
  fi
fi

# ---------------------------------------------------------------------------
# 3. pxpipe
# ---------------------------------------------------------------------------
info "Removing pxpipe…"
if npm ls -g --depth=0 pxpipe-proxy &>/dev/null; then
  if confirm "Uninstall global pxpipe-proxy via npm?"; then
    run "pxpipe removed" npm uninstall -g pxpipe-proxy
  fi
else
  warn "pxpipe not installed globally (nothing to remove)"
fi

# ---------------------------------------------------------------------------
# 4. Headroom
# ---------------------------------------------------------------------------
info "Removing Headroom…"

headroom_removed=0
# Global install (installed by install.sh into /opt/headroom, linked in /usr/local/bin)
HEADROOM_VENV="/opt/headroom"
if [ -d "$HEADROOM_VENV" ] || [ -L /usr/local/bin/headroom ]; then
  if confirm "Remove system-wide Headroom ($HEADROOM_VENV and /usr/local/bin/headroom) (sudo required)?"; then
    if [ "$DRY_RUN" -eq 1 ]; then
      info "would run: sudo rm -rf $HEADROOM_VENV /usr/local/bin/headroom"
    else
      sudo rm -rf "$HEADROOM_VENV" && sudo rm -f /usr/local/bin/headroom && headroom_removed=1
    fi
  fi
fi

# Global pipx install (from an earlier version of install.sh)
if command -v pipx &>/dev/null && pipx list --global --short 2>/dev/null | grep -q '^headroom-ai '; then
  if confirm "Uninstall system-wide pipx headroom-ai (sudo required)?"; then
    run "pipx headroom-ai removed" sudo "$(command -v pipx)" uninstall --global headroom-ai && headroom_removed=1
  fi
fi

# Per-user pipx install (left over from earlier, non-global installs)
if command -v pipx &>/dev/null && pipx list --short 2>/dev/null | grep -q '^headroom-ai '; then
  if confirm "Uninstall per-user headroom-ai via pipx?"; then
    run "pipx headroom-ai removed" pipx uninstall headroom-ai && headroom_removed=1
  fi
fi

if pip show headroom-ai &>/dev/null; then
  if confirm "Uninstall headroom-ai via pip (--user)?"; then
    run "pip headroom-ai removed" pip uninstall -y headroom-ai && headroom_removed=1
  fi
fi

if [ "$headroom_removed" -eq 0 ] && ! command -v headroom &>/dev/null; then
  warn "Headroom not installed (nothing to remove)"
fi

# ---------------------------------------------------------------------------
# 4b. code-review-graph
# ---------------------------------------------------------------------------
info "Removing code-review-graph…"
CRG_VENV="/opt/code-review-graph"
if [ -d "$CRG_VENV" ] || [ -L /usr/local/bin/code-review-graph ]; then
  # Per-repo setup (from `token-stack graph`) is undone by code-review-graph itself, so it
  # has to run while the command still exists. This script cannot know which repos you set up.
  warn "Before removing it, undo its setup in each repo where you ran 'token-stack graph':"
  warn "  code-review-graph uninstall --platform claude-code --repo <repo>"
  if confirm "Remove system-wide code-review-graph ($CRG_VENV and /usr/local/bin/code-review-graph) (sudo required)?"; then
    run "code-review-graph removed" sudo rm -rf "$CRG_VENV" /usr/local/bin/code-review-graph
  fi
else
  warn "code-review-graph not installed (nothing to remove)"
fi

# ---------------------------------------------------------------------------
# 5. RTK
# ---------------------------------------------------------------------------
info "Removing RTK…"

# System-wide copy (made by install.sh)
if [ -e /usr/local/bin/rtk ] && confirm "Delete system-wide RTK at /usr/local/bin/rtk (sudo required)?"; then
  run "Deleted /usr/local/bin/rtk" sudo rm -f /usr/local/bin/rtk
fi

# Per-user copy (RTK's own installer location)
rtk_path="$HOME/.local/bin/rtk"
if [ ! -e "$rtk_path" ]; then
  warn "No RTK binary at $rtk_path (nothing to remove)"
elif confirm "Delete RTK binary at $rtk_path?"; then
  run "Deleted $rtk_path" rm -f "$rtk_path"
fi

# ---------------------------------------------------------------------------
# Manual steps
# ---------------------------------------------------------------------------
echo ""
info "Uninstall finished."
echo ""
echo "These global Claude Code settings were changed by 'rtk init -g' and are"
echo "not edited by this script. Remove them by hand if you want a full revert:"
echo "  1. ~/.claude/settings.json: delete the PreToolUse entry whose command is"
echo "     'rtk hook claude' (the 'hooks' → 'PreToolUse' block)"
echo "  2. ~/.claude/CLAUDE.md: delete the line '@RTK.md'"
echo "  3. ~/.claude/RTK.md: delete the file"
echo ""
echo "Data and config left in place (delete them if you no longer need them):"
echo "  ~/.pxpipe  ~/.config/pxpipe  ~/.config/caveman  ~/.config/ponytail"
echo "  ~/.local/state/token-stack  and RTK's own data directories, if any"
echo ""

#!/usr/bin/env bash
# One-shot installer for the Token Optimization Stack.
#
# By default it installs RTK + Ponytail + Headroom + pxpipe. pxpipe runs behind the router
# chain (gate,headroom,gate,pxpipe, gain policy, see the Results section of README.md): a context gate sends a
# request to pxpipe only when its context is large enough to pay off. Run Claude Code
# through it with `token-stack claude`. For Headroom alone, use
# TOKEN_STACK_PROXIES=headroom token-stack claude instead.
#
# Usage: ./install.sh [--without-pxpipe] [--with-crg] [--with-caveman] [--benchmark-tools]
#   --without-pxpipe   skip pxpipe. token-stack claude then runs Headroom alone
#   --with-pxpipe      accepted for compatibility; pxpipe is installed by default
#   --with-crg         also install code-review-graph, set up per repo with `token-stack graph`.
#                      It made sessions more expensive in our benchmark (small repo)
#   --with-caveman     also install and enable the Caveman plugin. It made sessions more
#                      expensive in every combination we measured
#   --benchmark-tools  what benchmark/install.sh needs: pxpipe, code-review-graph, and the
#                      Caveman plugin installed but disabled, so it stays out of your sessions
#
# Works on Linux / macOS. Windows: use WSL or follow README manual steps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# pxpipe sees every request, so its version is pinned (plain `npx pxpipe-proxy` runs the latest).
PXPIPE_VERSION="0.15.0"
CRG_VERSION="2.3.9"

# RTK and its hooks belong in the user's home. Running as root would put them in
# /root instead. sudo is called only where a system-wide install needs it.
if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user, not root (no sudo). The script calls sudo where needed." >&2
  exit 1
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[x]${NC} $*"; exit 1; }

WITH_PXPIPE=1 # on by default; --without-pxpipe turns it off
WITH_CRG=0
CAVEMAN=off   # off: not installed, and disabled if an earlier install enabled it
for arg in "$@"; do
  case "$arg" in
    --with-pxpipe) WITH_PXPIPE=1 ;; # accepted for compatibility (already the default)
    --without-pxpipe) WITH_PXPIPE=0 ;;
    --with-crg) WITH_CRG=1 ;;
    --with-caveman) CAVEMAN=enabled ;;
    --benchmark-tools)
      WITH_PXPIPE=1
      WITH_CRG=1
      [ "$CAVEMAN" = enabled ] || CAVEMAN=disabled
      ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) error "Unknown option: $arg (see --help)" ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║   Token Optimization Stack – Installer                   ║"
echo "║   RTK + Ponytail + Headroom + pxpipe (router chain)        ║"
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

# RTK's installer places the binary in ~/.local/bin; copy it to /usr/local/bin
# so it is available system-wide (sudo required).
if [ -x "$HOME/.local/bin/rtk" ]; then
  info "Making RTK system-wide (sudo required)…"
  sudo install -m 755 "$HOME/.local/bin/rtk" /usr/local/bin/rtk
fi

# ---------------------------------------------------------------------------
# 2. Headroom
# ---------------------------------------------------------------------------
info "Installing Headroom…"

# Global install: a venv under /opt/headroom with the command linked into
# /usr/local/bin, so every user can run it. Needs sudo. Only requires Python 3.10+
# with venv support (installed via apt if missing), so pipx is not needed.
# Retries and a longer timeout: large wheels (e.g. litellm, ~37 MB) can be cut
# off mid-transfer on some networks, which pip reports as a hash mismatch.
PIP_RETRY_ARGS="--retries 10 --timeout 300"
HEADROOM_VENV="/opt/headroom"

# Python 3.10+ with venv support, for the Headroom and code-review-graph venvs.
ensure_python_venv() {
  command -v python3 &>/dev/null || error "python3 (3.10+) not found. Install it and re-run."
  python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' || error "Python 3.10+ is required."
  if ! python3 -c 'import ensurepip, venv' &>/dev/null; then
    info "Installing python3-venv (sudo required)…"
    sudo apt-get install -y python3-venv || error "Could not install python3-venv. Install it manually and re-run."
  fi
}

if command -v headroom &>/dev/null; then
  warn "Headroom already present"
else
  ensure_python_venv
  # litellm (~37 MB) is cut off mid-transfer on some networks, and pip then reports a
  # hash mismatch. Fetch it with resume until its SHA-256 matches the pinned value, then
  # install that file first. pip sees the litellm requirement as already satisfied and
  # does not download it again.
  LITELLM_URL="https://files.pythonhosted.org/packages/30/88/9df7400940ebe10b21e8aa763c802e81486f3aa85e8ef8ec7228bf0876d6/litellm-1.106.0-cp310-abi3-manylinux_2_28_x86_64.whl"
  LITELLM_SHA256="eeb604f06c27ab5373e2e05e4c1f14980fd87de3a09bd9a9dc2ddab7069bd34e"
  DOWNLOAD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/headroom.XXXXXX")"
  LITELLM_WHL="$DOWNLOAD_DIR/litellm-1.106.0-cp310-abi3-manylinux_2_28_x86_64.whl"

  fetch_litellm() {
    local tries=0
    until echo "$LITELLM_SHA256  $LITELLM_WHL" | sha256sum -c --status 2>/dev/null; do
      tries=$((tries + 1))
      [ "$tries" -gt 15 ] && return 1
      curl -s -C - -m 600 -o "$LITELLM_WHL" "$LITELLM_URL" || true
    done
  }

  info "Installing Headroom system-wide into $HEADROOM_VENV (sudo required)…"
  sudo python3 -m venv "$HEADROOM_VENV"
  if fetch_litellm; then
    sudo "$HEADROOM_VENV/bin/pip" install $PIP_RETRY_ARGS "$LITELLM_WHL"
  else
    warn "Could not fetch a verified litellm wheel; pip will try the index directly"
  fi
  sudo "$HEADROOM_VENV/bin/pip" install $PIP_RETRY_ARGS "headroom-ai[all]" \
    || sudo "$HEADROOM_VENV/bin/pip" install $PIP_RETRY_ARGS "headroom-ai[proxy]" \
    || error "Headroom install failed (see pip output above). Re-run the installer to retry."
  rm -rf "$DOWNLOAD_DIR"
  sudo ln -sf "$HEADROOM_VENV/bin/headroom" /usr/local/bin/headroom
fi

# Ensure PATH for user installs (RTK)
export PATH="$HOME/.local/bin:$PATH"

if command -v headroom &>/dev/null; then
  info "Headroom OK → $(headroom --version 2>/dev/null || echo installed)"
else
  warn "Headroom binary not in PATH. Try: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ---------------------------------------------------------------------------
# 3. Claude Code plugins: Ponytail (and Caveman, only on request)
# ---------------------------------------------------------------------------
# Plugins are a skill plus hooks that run locally, no proxy. They are installed for your
# user, so every Claude Code session gets the enabled ones. The Caveman npm CLI
# (@caveman-ai/cli) is never installed: it routes Claude Code through its own proxy and
# sends telemetry by default.

# plugin_status <plugin@marketplace>: absent, enabled or disabled
plugin_status() {
  local json
  json="$(claude plugin list --json 2>/dev/null || true)"
  if command -v node &>/dev/null; then
    printf '%s' "$json" | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        let list = [];
        try { list = JSON.parse(raw); } catch {}
        const p = list.find((x) => x.id === process.argv[1]);
        console.log(!p ? "absent" : p.enabled ? "enabled" : "disabled");
      });' "$1"
  elif grep -q "\"id\": *\"$1\"" <<<"$json"; then
    echo enabled # without Node the flag is not parsed; plugins install enabled
  else
    echo absent
  fi
}

# install_plugin <GitHub repo> <plugin@marketplace>
install_plugin() {
  local repo="$1" id="$2"
  if [ "$(plugin_status "$id")" != absent ]; then
    warn "$id already installed"
    return 0
  fi
  # Fails harmlessly when the marketplace is already added; the install below tells.
  claude plugin marketplace add "$repo" </dev/null || true
  if claude plugin install "$id" --scope user </dev/null; then
    info "$id installed"
  else
    warn "$id install failed. Inside Claude Code run: /plugin marketplace add $repo, then /plugin install $id"
    return 1
  fi
}

if ! command -v claude &>/dev/null; then
  warn "Claude Code CLI not found – skipping plugins. Install Claude Code and re-run."
else
  info "Installing the Ponytail plugin…"
  install_plugin DietrichGebert/ponytail ponytail@ponytail || true
  if [ "$(plugin_status ponytail@ponytail)" = disabled ]; then
    warn "Ponytail is installed but disabled. Enable it with: claude plugin enable ponytail@ponytail"
  fi

  case "$CAVEMAN" in
    enabled)
      info "Installing the Caveman plugin (--with-caveman)…"
      install_plugin JuliusBrussee/caveman caveman@caveman || true
      if [ "$(plugin_status caveman@caveman)" = disabled ]; then
        claude plugin enable caveman@caveman </dev/null && info "Caveman enabled"
      fi
      ;;
    disabled)
      # The benchmark loads Caveman by path in the arms that use it, so it can stay
      # disabled here and out of your own sessions.
      info "Installing the Caveman plugin, disabled (benchmark only)…"
      install_plugin JuliusBrussee/caveman caveman@caveman || true
      if [ "$(plugin_status caveman@caveman)" = enabled ]; then
        claude plugin disable caveman@caveman </dev/null && info "Caveman disabled (the benchmark still loads it where needed)"
      fi
      ;;
    off)
      # An earlier version of this installer enabled Caveman. It made sessions more
      # expensive in every combination we measured, so the best combination has it off.
      if [ "$(plugin_status caveman@caveman)" = enabled ]; then
        claude plugin disable caveman@caveman </dev/null \
          && warn "Disabled the Caveman plugin from an earlier install: it made sessions more expensive in our benchmark (README.md, Results). Re-enable with: claude plugin enable caveman@caveman"
      fi
      ;;
  esac
fi

if npm ls -g --depth=0 @caveman-ai/cli &>/dev/null; then
  warn "The Caveman npm CLI from an earlier install is still present. It is not part of the stack; ./uninstall.sh can remove it."
fi

# ---------------------------------------------------------------------------
# 4. Optional: code-review-graph (--with-crg)
# ---------------------------------------------------------------------------
# Same layout as Headroom: a venv under /opt with the command linked into /usr/local/bin.
# Base package only: no embedding extras, so nothing is downloaded at run time and no
# code leaves the machine. Claude Code is set up per repository, with `token-stack graph`.
if [ "$WITH_CRG" -eq 1 ]; then
  info "Installing code-review-graph $CRG_VERSION…"
  CRG_VENV="/opt/code-review-graph"
  if [ -x "$CRG_VENV/bin/code-review-graph" ] && "$CRG_VENV/bin/pip" show code-review-graph 2>/dev/null | grep -qx "Version: $CRG_VERSION"; then
    warn "code-review-graph $CRG_VERSION already present"
  else
    ensure_python_venv
    info "Installing code-review-graph system-wide into $CRG_VENV (sudo required)…"
    sudo python3 -m venv "$CRG_VENV"
    sudo "$CRG_VENV/bin/pip" install $PIP_RETRY_ARGS "code-review-graph==$CRG_VERSION" \
      || error "code-review-graph install failed (see pip output above). Re-run the installer to retry."
  fi
  sudo ln -sf "$CRG_VENV/bin/code-review-graph" /usr/local/bin/code-review-graph
  info "code-review-graph OK → $(command -v code-review-graph)"
fi

# ---------------------------------------------------------------------------
# 5. pxpipe (default; --without-pxpipe skips it)
# ---------------------------------------------------------------------------
if [ "$WITH_PXPIPE" -eq 1 ]; then
  info "Installing pxpipe $PXPIPE_VERSION…"
  if ! command -v node &>/dev/null; then
    warn "Node.js not found – skipping pxpipe. Install Node 20.19+ and re-run."
  elif npm ls -g --depth=0 "pxpipe-proxy@$PXPIPE_VERSION" &>/dev/null; then
    warn "pxpipe $PXPIPE_VERSION already present"
  else
    # Global npm install (into the active Node's global prefix, no sudo)
    npm install -g "pxpipe-proxy@$PXPIPE_VERSION" || warn "pxpipe install failed – re-run the installer to retry"
  fi
  command -v pxpipe &>/dev/null && info "pxpipe OK → $(command -v pxpipe)"
fi

# ---------------------------------------------------------------------------
# 6. token-stack launcher
# ---------------------------------------------------------------------------
info "Installing the token-stack launcher system-wide (sudo required)…"
sudo install -m 755 "$SCRIPT_DIR/token-stack" /usr/local/bin/token-stack
# The context gate (TOKEN_STACK_PROXIES=headroom,gate,pxpipe). Node runs it; no dependencies.
info "Installing the context gate system-wide (sudo required)…"
sudo install -d -m 755 /usr/local/lib/token-stack
sudo install -m 644 "$SCRIPT_DIR/scripts/context-gate.mjs" /usr/local/lib/token-stack/context-gate.mjs

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
info "Installation finished."
echo ""
echo "Next steps:"
echo "  1. Restart your terminal (or source your shell rc)"
echo "  2. Run Claude Code through the stack (starts the proxies if needed):"
echo "       token-stack claude"
echo "     Stop the proxies with: token-stack stop"
echo "     Use token-stack rather than 'headroom wrap claude': wrap sets ENABLE_TOOL_SEARCH=true,"
echo "     which makes Headroom skip its own tool-schema deferral (half its saving in our benchmark)."
echo "     Note: with ANTHROPIC_BASE_URL set, Claude Code's Remote Control is unavailable."
if command -v pxpipe &>/dev/null; then
  echo "     token-stack claude runs the router chain: a context gate sends each request through"
  echo "     pxpipe only when its context is large (gain policy). To run Headroom alone:"
  echo "       TOKEN_STACK_PROXIES=headroom token-stack claude"
else
  echo "     pxpipe is not installed (it needs Node 20.19+), so token-stack claude runs Headroom alone."
fi
if command -v code-review-graph &>/dev/null; then
  echo "  code-review-graph is installed; set it up per repo with: cd <repo> && token-stack graph"
fi
echo "  3. Measure it on your machine: benchmark/install.sh, then see benchmark/ in README.md"
echo ""

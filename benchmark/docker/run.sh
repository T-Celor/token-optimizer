#!/usr/bin/env bash
# Runs the token-optimizer benchmark in a Linux container.
# Works from Git Bash on Windows, and on macOS/Linux.
#   bash benchmark/docker/run.sh <command> [args]
set -euo pipefail

# Git Bash rewrites arguments that look like POSIX paths (e.g. /home/bench) into Windows
# paths before they reach docker. Turn that off for every call.
export MSYS_NO_PATHCONV=1

IMAGE="token-optimizer-bench"
CONTAINER="token-optimizer-bench"
CLAUDE_VOLUME="token-optimizer-claude"
REPORTS_VOLUME="token-optimizer-reports"
BENCH_DIR="/home/bench/token-optimizer"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

# docker cp needs host paths in Windows form (C:/Users/...), not Git Bash form (/c/Users/...).
host_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

usage() {
  cat <<'EOF'
Usage: bash benchmark/docker/run.sh <command> [args]

  build              build the image from the repo root
  up                 start the container (creates it on first use)
  login              run Claude Code so you can /login (one time)
  post-login         re-run the installer, which retries plugin installs after login
  check              offline preflight, no model calls
  bench [ARGS...]    live benchmark, e.g. bench --arms default --repeat 2
  sync               copy token-stack, scripts/ and benchmark/*.mjs into the container
  reports            copy the container's reports to benchmark/reports on the host
  down               remove the container (the volumes are kept)
EOF
}

container_exists() {
  docker container inspect "$CONTAINER" >/dev/null 2>&1
}

container_running() {
  [ "$(docker container inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = "true" ]
}

require_running() {
  if ! container_running; then
    echo "The container is not running. Start it with: bash benchmark/docker/run.sh up" >&2
    exit 1
  fi
}

cmd_build() {
  cd "$REPO"
  docker build -f benchmark/docker/Dockerfile -t "$IMAGE" .
  if container_exists; then
    echo "An existing container still uses the old image. Run 'down' and then 'up' to switch."
  fi
}

cmd_up() {
  if container_exists; then
    if container_running; then
      echo "Already running: $CONTAINER"
    else
      docker start "$CONTAINER" >/dev/null
      echo "Started: $CONTAINER"
    fi
    return 0
  fi
  docker run -d --init --name "$CONTAINER" \
    -v "$CLAUDE_VOLUME:/home/bench/.claude" \
    -v "$REPORTS_VOLUME:$BENCH_DIR/benchmark/reports" \
    "$IMAGE" >/dev/null
  echo "Started: $CONTAINER"
}

cmd_login() {
  require_running
  echo "Follow the /login steps, then type /exit. The login is kept in the $CLAUDE_VOLUME volume."
  local -a cmd=(docker exec -it "$CONTAINER" claude)
  # Git Bash (mintty) has no real TTY, so docker -it needs winpty.
  if [ ! -t 0 ] && command -v winpty >/dev/null 2>&1; then
    cmd=(winpty "${cmd[@]}")
  fi
  "${cmd[@]}"
}

cmd_post_login() {
  require_running
  docker exec "$CONTAINER" bash -lc 'cd ~/token-optimizer && ./install.sh --benchmark-tools'
}

cmd_check() {
  require_running
  docker exec "$CONTAINER" bash -lc 'cd ~/token-optimizer/benchmark && node run_session.mjs'
}

cmd_bench() {
  require_running
  docker exec "$CONTAINER" bash -lc 'cd ~/token-optimizer/benchmark && exec node run_session.mjs --live "$@"' bench "$@"
}

cmd_sync() {
  require_running
  docker cp "$(host_path "$REPO/token-stack")" "$CONTAINER:$BENCH_DIR/token-stack"
  docker cp "$(host_path "$REPO/scripts")/." "$CONTAINER:$BENCH_DIR/scripts/"
  local f
  for f in "$REPO"/benchmark/*.mjs; do
    [ -f "$f" ] || continue
    docker cp "$(host_path "$f")" "$CONTAINER:$BENCH_DIR/benchmark/$(basename "$f")"
  done
  docker exec -u root "$CONTAINER" bash -c "
    set -e
    cd $BENCH_DIR
    chown -R bench:bench scripts token-stack
    chown bench:bench benchmark/*.mjs
    sed -i 's/\r$//' token-stack scripts/* benchmark/*.mjs
    chmod +x scripts/*.sh 2>/dev/null || true
    install -m 755 token-stack /usr/local/bin/token-stack
    install -d -m 755 /usr/local/lib/token-stack
    install -m 644 scripts/context-gate.mjs /usr/local/lib/token-stack/context-gate.mjs"
  echo "Synced token-stack, scripts/ and benchmark/*.mjs. Dependency or install changes need 'build'."
}

cmd_reports() {
  require_running
  mkdir -p "$REPO/benchmark/reports"
  docker cp "$CONTAINER:$BENCH_DIR/benchmark/reports/." "$(host_path "$REPO/benchmark/reports")"
  echo "Reports copied to $REPO/benchmark/reports"
}

cmd_down() {
  if container_exists; then
    docker rm -f "$CONTAINER" >/dev/null
    echo "Removed $CONTAINER. Volumes kept: $CLAUDE_VOLUME, $REPORTS_VOLUME"
  else
    echo "No container to remove."
  fi
}

cmd="${1:-}"
if [ $# -gt 0 ]; then shift; fi

case "$cmd" in
  build) cmd_build "$@" ;;
  up) cmd_up "$@" ;;
  login) cmd_login "$@" ;;
  post-login) cmd_post_login "$@" ;;
  check) cmd_check "$@" ;;
  bench) cmd_bench "$@" ;;
  sync) cmd_sync "$@" ;;
  reports) cmd_reports "$@" ;;
  down) cmd_down "$@" ;;
  -h|--help|help|"") usage ;;
  *) echo "Unknown command: $cmd" >&2; usage >&2; exit 1 ;;
esac

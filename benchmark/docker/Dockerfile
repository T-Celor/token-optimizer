# Linux image for the Token Optimization Stack benchmark (for Windows and macOS hosts).
# Build from the repo root (run.sh does this):
#   docker build -f benchmark/docker/Dockerfile -t token-optimizer-bench .
#
# Mirrors the requirements of install.sh and benchmark/install.sh:
#   - not root (install.sh refuses root), passwordless sudo for the system-wide parts
#   - python3 3.10+ with venv (Headroom, code-review-graph venvs under /opt)
#   - Node.js 20.19+ (pxpipe, token-stack helpers, benchmark npm ci); Node 24 LTS here
#   - curl, sha256sum, jq, git
#   - claude on PATH (plugin step of install.sh)

FROM ubuntu:24.04

ARG NODE_VERSION=24.11.0
ARG CLAUDE_CODE_VERSION=latest

# HOME and the npm prefix sit under the user, so `npm i -g` needs no sudo.
# CLAUDE_CONFIG_DIR keeps all Claude Code state (including ~/.claude.json) in one
# directory, which the named volume maps, so the login survives rebuilds.
# HEADROOM_TELEMETRY=off is the only telemetry switch the repo itself sets (token-stack).
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    HOME=/home/bench \
    NPM_CONFIG_PREFIX=/home/bench/.npm-global \
    CLAUDE_CONFIG_DIR=/home/bench/.claude \
    HEADROOM_TELEMETRY=off \
    PATH=/home/bench/.npm-global/bin:/home/bench/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git sudo python3 python3-venv python3-pip build-essential jq xz-utils \
 && rm -rf /var/lib/apt/lists/*

# Ubuntu 24.04 ships a user "ubuntu" with uid 1000. Replace it with "bench" at uid 1000.
RUN if getent passwd ubuntu >/dev/null; then userdel -r ubuntu; fi \
 && if getent group ubuntu >/dev/null; then groupdel ubuntu; fi \
 && groupadd --gid 1000 bench \
 && useradd --uid 1000 --gid 1000 --create-home --home-dir /home/bench --shell /bin/bash bench \
 && echo 'bench ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/bench \
 && chmod 0440 /etc/sudoers.d/bench

# Node.js LTS from the official tarball. SHASUMS256.txt is checked against the tarball;
# this guards against a corrupt download, not against a compromised nodejs.org.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) NODE_ARCH=x64 ;; \
      arm64) NODE_ARCH=arm64 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    base="node-v${NODE_VERSION}-linux-${NODE_ARCH}"; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${base}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${base}.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "${base}.tar.xz" -C /usr/local --strip-components=1 --no-same-owner; \
    rm -f "${base}.tar.xz" SHASUMS256.txt; \
    node --version; \
    npm --version

# Login shells (bash -lc, used by run.sh) read /etc/profile.d, so the user paths apply there too.
RUN printf '%s\n' \
      'export NPM_CONFIG_PREFIX="$HOME/.npm-global"' \
      'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"' \
      > /etc/profile.d/bench-path.sh

USER bench

RUN mkdir -p /home/bench/.npm-global /home/bench/.claude \
 && npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
 && claude --version

# Repo copied into the image as bench. run.sh excludes nothing itself: see benchmark/docker/README.md.
COPY --chown=bench:bench . /home/bench/token-optimizer

WORKDIR /home/bench/token-optimizer

# Restore the executable bits and LF line endings that a Windows checkout may have lost.
RUN sed -i 's/\r$//' install.sh uninstall.sh token-stack benchmark/install.sh \
 && chmod +x install.sh uninstall.sh token-stack benchmark/install.sh \
 && mkdir -p benchmark/reports

# benchmark/install.sh runs ../install.sh --benchmark-tools itself (RTK, Headroom, Ponytail,
# pxpipe, code-review-graph, token-stack) and then npm ci for the benchmark.
# Running ./install.sh first would only repeat that work.
# Plugin installs that need a logged-in Claude only warn here; run.sh post-login retries them.
RUN ./benchmark/install.sh

# Fail the build if a tool the benchmark compares with is missing.
RUN for t in rtk headroom claude pxpipe code-review-graph token-stack; do \
      command -v "$t" >/dev/null || { echo "missing after install: $t" >&2; exit 1; }; \
    done

# Long-lived container: commands go through docker exec.
CMD ["sleep", "infinity"]

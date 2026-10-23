# Benchmark in a Linux container

This runs the token benchmark in a Linux container. Use it on Windows or macOS, where
`install.sh` does not run natively. The image holds the stack (RTK, Headroom, Ponytail,
pxpipe, code-review-graph, token-stack) and Claude Code. It holds no credentials.

## Commands

Run these from the repo root with Docker running. Use `bash`, not `./run.sh`.

```
bash benchmark/docker/run.sh build
bash benchmark/docker/run.sh up
bash benchmark/docker/run.sh login                  # one time: /login, then /exit
bash benchmark/docker/run.sh check                  # offline preflight, no model calls
bash benchmark/docker/run.sh bench --arms default --repeat 2
bash benchmark/docker/run.sh reports                # copies results to benchmark/reports
bash benchmark/docker/run.sh down
```

Other commands:

- `sync` copies edited `token-stack`, `scripts/` and `benchmark/*.mjs` into the running
  container, so you do not need to rebuild for script changes.
- `post-login` re-runs the installer. Use it if the build could not install the Ponytail
  plugin, which needs a logged-in Claude.

## Login

The login is stored in the named volume `token-optimizer-claude`, mounted at
`/home/bench/.claude`. The image sets `CLAUDE_CONFIG_DIR` to that path, so all Claude Code
state lives in the volume. The login survives `down`, `up` and rebuilds. It is never written
into the image. To log out, run `/logout` in Claude, or delete the volume with
`docker volume rm token-optimizer-claude`.

`login` needs a real terminal. Use Windows Terminal, or Git Bash (run.sh uses `winpty`
there when it is installed).

## Cost

Sessions run on the logged-in Claude account and count against its usage. `bench` makes
real model calls. `check` makes none.

## Build notes

- Rebuild (`build`, then `down` and `up`) after changes to install steps or dependencies.
- The build context is the repo root. Exclude `node_modules`, `.git` and `benchmark/reports`
  from it (for example with a `.dockerignore` at the repo root) to keep the image small and
  free of local history and results.

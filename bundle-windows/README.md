# Token Optimization Stack for Claude Code (Windows)

Installs for the current user under %USERPROFILE%\.token-stack: the RTK 1.0.1 executable (bin\rtk.exe, SHA-256 checked against the release checksums.txt), Headroom 0.41.0 (venv), pxpipe-proxy 0.15.0 (npm -g), graphify (venv, /graphify skill), the Ponytail plugin (skip with `-NoPonytail`), the context gate and a launcher.

Prerequisites on PATH: Node.js 20+, npm, Python 3 (`py -3` or `python`), claude CLI.

One command to install (double-click `bundle-windows\install.cmd`, or run it from the repo root):
    bundle-windows\install.cmd [-NoPonytail] [-NoRtkHook] [-GraphifyProject <folder>]

Start Claude Code through the stack:
    %USERPROFILE%\.token-stack\bin\claude-stack.cmd

One command to uninstall (lists what will be removed, then asks you to type YES):
    bundle-windows\uninstall.cmd [-KeepData]

Automatic routing (on by default; `-NoAuto` to skip): the `env` block of `%USERPROFILE%\.claude\settings.json` (and the user variable `ANTHROPIC_BASE_URL`) points Claude Code at the stack, and the startup app `TokenStackServe` keeps the stack running from logon, with no window (`conhost --headless`). It needs no administrator rights, and you can turn it off in Settings > Apps > Startup or in Task Manager > Startup apps. Every new Claude Code session, including the Code tab of the desktop app, then goes through the stack. No API key is needed: the claude.ai login is forwarded. If the stack is down, Claude Code cannot reach the API until it is back.

To turn it off without uninstalling: `powershell -ExecutionPolicy Bypass -File bundle-windows\auto.ps1 -Disable`. Turn it back on with `-Enable`.

Refuses to uninstall while the stack is running (ports 8787, 47821, 47830, 47831): close Claude Code first.

RTK: the executable is installed (SHA-256 checked), then rtk's own global setup runs (`rtk init -g --auto-patch`), so its hook applies to every Claude Code session. The user PATH gets the bin folder so the hook finds `rtk`. Use `-NoRtkHook` to skip the hook: only the executable is installed then. Uninstall runs `rtk init -g --uninstall` and removes the PATH entry only if the install added them.

graphify writes its own registration in your global CLAUDE.md; uninstall runs graphify's own uninstall to remove it and the /graphify skill.

Not covered:
- The desktop app Chat tab cannot use local proxies; the Claude Code tab uses the stack only when started from claude-stack.cmd.
- Your own Python, Node.js, npm and claude CLI are never installed or removed.

- The install also writes the model split for sub-agents (Opus 5.5 xhigh orchestrator, Haiku 5.5 low executors) into your global `%USERPROFILE%\.claude\CLAUDE.md`, between markers. Uninstall removes that block only.

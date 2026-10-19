<div align="center">

# Token Optimization Stack

**Use less of your Claude Code usage. Measured, not promised.**

RTK + Ponytail + Headroom · one installer · one launcher · the benchmark that proves it

| −25% cost | −38% tokens | −34% peak context | 15/15 answers right |
|:-:|:-:|:-:|:-:|

<sub>Average of 3 real Claude Code work sessions against plain Claude Code (Claude Opus 5.5). Details in <a href="RESULTS.md">RESULTS.md</a>.</sub>

</div>

---

## Contents

- [Quick start](#-quick-start)
- [Results at a glance](#-results-at-a-glance)
- [What's in the stack](#-whats-in-the-stack)
- [How it works](#-how-it-works)
- [Daily use](#-daily-use)
- [Installation](#-installation)
- [Benchmark](#-benchmark)
- [Privacy and data](#-privacy-and-data)
- [Other agents and SDKs](#-other-agents-and-sdks)
- [Monitoring and troubleshooting](#-monitoring-and-troubleshooting)
- [Repository layout](#-repository-layout)
- [Credits and licence](#-credits-and-licence)

---

## ⚡ Quick start

```bash
git clone <this-repo-url> token-optimizer
cd token-optimizer
./install.sh           # as your normal user; it asks for sudo when it needs it
token-stack claude     # use this instead of `claude`
```

That's it. RTK and Ponytail now work in every Claude Code session, and `token-stack claude`
routes Claude Code through Headroom (which keeps running in the background until
`token-stack stop`).

---

## 📊 Results at a glance

Cost of one 7-request work session, per configuration (one block ≈ $0.02):

```
RTK + Ponytail + Headroom      ███████████████        $0.297   −25%   ◀ default install
RTK + Headroom                 ███████████████        $0.309   −22%
Headroom                       ████████████████       $0.310   −21%
Headroom → pxpipe              ████████████████       $0.311   −21%
RTK + Ponytail + Headroom
  → pxpipe                     ██████████████████     $0.358    −9%   ◀ smallest context (−53%)
Plain Claude Code              ████████████████████   $0.395           ◀ baseline
code-review-graph              ██████████████████████ $0.435   +10%
RTK + Caveman + Ponytail       ██████████████████████ $0.444   +12%
All six tools                  █████████████████████████████  $0.584  +48%
```

- **Headroom does most of the work.** RTK and Ponytail add a little on top.
- **pxpipe after Headroom halves the context but costs more.** It removes cheap tokens and
  adds expensive ones; use it only for very long sessions.
- **Caveman and code-review-graph made sessions more expensive**, and stacking every tool
  was the worst option of all.
- **Accuracy never dropped**: every graded answer was right in every configuration.

<details>
<summary><b>Full results table</b></summary>

| Configuration | Sessions | Cost | Tokens | Peak context | Correct |
|---|---:|---:|---:|---:|:-:|
| **RTK + Ponytail + Headroom** | 3 | **−24.9%** | −37.7% | −33.6% | 15/15 |
| RTK + Headroom | 3 | −21.8% | −35.8% | −33.4% | 15/15 |
| Headroom | 3 | −21.4% | −39.9% | −35.2% | 15/15 |
| Headroom → pxpipe | 2 | −21.3% | −47.7% | −40.9% | 10/10 |
| RTK + Ponytail + Headroom → pxpipe | 2 | −9.3% | −47.3% | **−53.2%** | 10/10 |
| RTK + Headroom → pxpipe | 2 | −8.0% | −39.7% | −39.8% | 10/10 |
| RTK | 1 | −9.4% | −14.8% | −4.6% | 5/5 |
| pxpipe | 1 | −7.0% | −34.3% | −23.3% | 5/5 |
| Caveman | 1 | −2.2% | +8.5% | +2.0% | 5/5 |
| Ponytail | 1 | −2.1% | −7.4% | −1.9% | 5/5 |
| code-review-graph | 1 | +10.2% | +10.3% | +6.5% | 5/5 |
| RTK + Caveman + Ponytail | 1 | +12.5% | +24.1% | +12.6% | 5/5 |
| All six tools (first setup) | 1 | +47.9% | +54.7% | +13.5% | 5/5 |

Baseline (plain Claude Code): $0.395, 536k tokens, peak 33.5k per session. Method, the
cost-vs-tokens explanation and the limits of these results are in [RESULTS.md](RESULTS.md).

</details>

---

## 🧩 What's in the stack

| Tool | What it does | Measured | Installed |
|---|---|---|:-:|
| **[Headroom](https://github.com/headroomlabs-ai/headroom)** | Local proxy: compresses tool results, logs and JSON, and loads tool definitions only when needed | −21% alone, the core | ✅ default |
| **[RTK](https://github.com/rtk-ai/rtk)** | Hook that shortens shell command output (`git`, tests, `grep`…) before Claude reads it | −9% alone | ✅ default |
| **[Ponytail](https://github.com/DietrichGebert/ponytail)** | Plugin that pushes Claude toward the simplest code that works | −4% on top | ✅ default |
| **[pxpipe](https://github.com/teamchong/pxpipe)** | Proxy that turns bulky context into images | after the default stack: context −53%, but cost −9% instead of −25% | `--with-pxpipe` |
| **[code-review-graph](https://github.com/tirth8205/code-review-graph)** | Code graph served to Claude over MCP | +10% on our repo | `--with-crg` |
| **[Caveman](https://github.com/JuliusBrussee/caveman)** | Plugin that makes Claude's replies terse | +17% to +30% when added | `--with-caveman` |

---

## 🔧 How it works

```
                 ┌──────────────────────────────────────────────┐
                 │ Claude Code                                  │
                 │   RTK hook ……… shortens shell output         │
                 │   Ponytail ……… less code to write            │
                 └──────────────────────┬───────────────────────┘
                                        │ ANTHROPIC_BASE_URL
                                        ▼
                 ┌──────────────────────────────────────────────┐
                 │ Headroom  (127.0.0.1:8787)                   │
                 │   compresses tool results, defers tools      │
                 └──────────────────────┬───────────────────────┘
                                        │
             optional, long sessions:   │   pxpipe (127.0.0.1:47821)
             TOKEN_STACK_PROXIES=       │   reached through `pxpipe warp`
             headroom,pxpipe            │
                                        ▼
                                 Anthropic API
```

`token-stack` wires this the way that measured best. Three settings made the difference
between saving and losing money:

| | Wrong | Right (what `token-stack` does) | Effect |
|:-:|---|---|---|
| 1 | `ENABLE_TOOL_SEARCH=true` with Headroom, as `headroom wrap claude` sets | Leave it unset: Headroom then defers tool definitions itself, far more than Claude Code does | Headroom −11% → **−21%** |
| 2 | Point Headroom at pxpipe with `--anthropic-api-url` | Run Headroom inside `pxpipe warp`, so it still sees `api.anthropic.com` | pxpipe after Headroom +24% → **about even** |
| 3 | pxpipe alone without tool deferral | `ENABLE_TOOL_SEARCH=true` when there is no Headroom | pxpipe −2% → **−7%** |

---

## 🚀 Daily use

```bash
token-stack claude                                    # Claude Code through Headroom
TOKEN_STACK_PROXIES=headroom,pxpipe token-stack claude  # very long sessions: half the context, ~+20% cost
token-stack status                                    # are the proxies running?
token-stack stop                                      # stop them
```

<details>
<summary><b>All <code>token-stack</code> commands and settings</b></summary>

| Command | Does |
|---|---|
| `token-stack claude [args]` | Starts the proxies if needed, then runs `claude [args]` through them |
| `token-stack start` | Starts the proxies in the background |
| `token-stack stop` | Stops the proxies it started |
| `token-stack status` | Shows whether each proxy answers |
| `token-stack url` | Prints the address Claude Code should use as `ANTHROPIC_BASE_URL` |
| `token-stack graph [repo]` | Sets up code-review-graph in a git repo and builds its graph (needs `--with-crg`) |

| Variable | Default | Meaning |
|---|---|---|
| `TOKEN_STACK_PROXIES` | `headroom` | Proxies in chain order: `headroom`, `headroom,pxpipe`, `pxpipe,headroom`, `pxpipe` or `none` |
| `TOKEN_STACK_HEADROOM_PORT` | `8787` | Headroom port |
| `TOKEN_STACK_PXPIPE_PORT` | `47821` | pxpipe port |
| `TOKEN_STACK_STATE_DIR` | `~/.local/state/token-stack` | PID files and proxy logs |

</details>

> [!NOTE]
> With any proxy set as `ANTHROPIC_BASE_URL`, Claude Code's Remote Control is unavailable.
> Run plain `claude` when you need it.

---

## 📦 Installation

**Requirements:** Linux, macOS or WSL · Python 3.10+ with venv · Node.js 20.19+ (for pxpipe
and the benchmark) · Claude Code · `curl` · `sudo` for the system-wide parts.

```bash
./install.sh                    # best combination: RTK + Ponytail + Headroom
./install.sh --with-pxpipe      # + pxpipe, for long sessions
./install.sh --help             # all options
```

| Option | Adds |
|---|---|
| *(none)* | RTK, Headroom, Ponytail and `token-stack`; disables Caveman if an earlier install enabled it |
| `--with-pxpipe` | pxpipe 0.15.0 (pinned: it sees every request) |
| `--with-crg` | code-review-graph 2.3.9, set up per repo with `token-stack graph` |
| `--with-caveman` | Caveman, enabled (not recommended) |
| `--benchmark-tools` | pxpipe, code-review-graph, and Caveman installed but disabled |

<details>
<summary><b>Where things go</b></summary>

| What | Where |
|---|---|
| RTK | `~/.local/bin/rtk`, copied to `/usr/local/bin/rtk`; hook in `~/.claude/settings.json`, instructions in `~/.claude/RTK.md` |
| Headroom | Python venv in `/opt/headroom`, linked as `/usr/local/bin/headroom` |
| Ponytail, Caveman | Claude Code plugins, user scope (`claude plugin list`) |
| pxpipe | global npm package `pxpipe-proxy` |
| code-review-graph | Python venv in `/opt/code-review-graph`, linked in `/usr/local/bin`; per-repo files from `token-stack graph` |
| `token-stack` | `/usr/local/bin/token-stack` |

Re-run `./install.sh` after pulling changes: it skips what is already installed and updates
the launcher.

</details>

**Uninstall:** `./uninstall.sh` asks before each removal (`--dry-run` to preview, `--yes` to
skip the questions). It prints the few manual steps left (RTK's lines in `~/.claude`).

---

## 🔬 Benchmark

Real Claude Code sessions, every combination of tools against plain Claude Code. Each session
is 7 requests in a row on a generated repository (find why CI is red, fix it, find a 503 in the
logs, find a commit, add a regression test…), with graded answers. Every configuration ignores
your own settings, so only its tools differ.

```bash
benchmark/install.sh                                  # the tools it compares + the Agent SDK
cd benchmark
node run_session.mjs                                  # checks only, no model calls
node run_session.mjs --live                           # plain Claude Code vs the default install
node run_session.mjs --live --arms best --repeat 2    # the best configurations, twice each
```

| Preset | Configurations |
|---|---|
| `default` | plain Claude Code, RTK + Ponytail + Headroom |
| `best` | plain Claude Code and the best 6, with and without pxpipe after Headroom |
| `ablation` | plain Claude Code, RTK + Caveman + Ponytail, + code-review-graph, everything |
| `all` | every configuration defined in [`harness.mjs`](benchmark/harness.mjs) |

Sessions run on your logged-in Claude account: about **$0.30–0.45 each** in our runs. Reports
go to `benchmark/reports/session-latest.md`, and `--add-to <run>/combined-results.json` merges
a new run into an earlier report. `run_ab.mjs` is a quicker variant with one question per
session.

---

## 🔒 Privacy and data

Everything runs on your machine; requests still go only to Anthropic.

- **Headroom** runs with telemetry forced off (`--no-telemetry`).
- **RTK** telemetry is opt-in and off unless you enable it (`rtk telemetry status`).
- **Ponytail** hooks run locally; its optional webhook is empty by default.
- **pxpipe** (optional) sends its images to Anthropic only. Its `warp` mode creates a local
  certificate authority in `~/.pxpipe`, trusted by the Headroom process only.
- **code-review-graph** (optional) is installed without embedding extras, so no code leaves
  the machine.
- The **Caveman npm CLI** is never installed: it adds its own proxy and sends telemetry by
  default.

---

## 🤝 Other agents and SDKs

Only Claude Code was benchmarked. Headroom and RTK also work with other agents.

<details>
<summary><b>GitHub Copilot CLI</b></summary>

```bash
./install.sh
./scripts/launch-copilot.sh        # or: headroom wrap copilot
headroom wrap copilot -- --model <model>
```

Headroom selects the Anthropic or OpenAI-compatible route automatically.

</details>

<details>
<summary><b>Other agents</b></summary>

| Agent / Client | RTK | Headroom | How |
|---|:-:|:-:|---|
| Claude Code | ✅ | ✅ | `token-stack claude` (benchmarked) |
| GitHub Copilot CLI | ✅ | ✅ | `headroom wrap copilot` |
| Cursor | ✅ | ✅ | config snippet or proxy |
| OpenAI Codex CLI | ✅ | ✅ | `headroom wrap codex` |
| Gemini CLI | ✅ | ✅ | supported |
| Aider | ✅ | ✅ | `headroom wrap aider` |
| Any OpenAI-compatible client | – | ✅ | `OPENAI_BASE_URL` → proxy |
| Anthropic API / SDK | – | ✅ | direct or via proxy |

Ponytail has plugins for other agents too: see its repository.

</details>

<details>
<summary><b>TypeScript / JavaScript SDK</b></summary>

```bash
npm install headroom-ai @anthropic-ai/sdk   # or: openai
token-stack start                           # the TS client needs the proxy running
```

```ts
// Anthropic
import { withHeadroom } from 'headroom-ai/anthropic';
import Anthropic from '@anthropic-ai/sdk';

const client = withHeadroom(new Anthropic());
const response = await client.messages.create({
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  messages: [/* … */],
});
```

```ts
// OpenAI-compatible, or compress first and call any client
import { compress } from 'headroom-ai';
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: 'http://127.0.0.1:8787/v1' });
const result = await compress(messages, { model: 'claude-opus-5-5' });
console.log(result.tokensSaved, result.compressionRatio);
```

</details>

<details>
<summary><b>Python, or any language through the proxy</b></summary>

```python
from headroom import compress

compressed = compress(messages, model="claude-opus-5-5")
# then pass compressed.messages to your client
```

```bash
token-stack start
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787     # Anthropic-style
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1     # OpenAI-compatible
```

`configs/env.example` is a ready template.

</details>

---

## 🩺 Monitoring and troubleshooting

| Command | Shows |
|---|---|
| `token-stack status` | whether Headroom (and pxpipe) are running |
| `curl -s 127.0.0.1:8787/stats` | Headroom's own counters |
| `rtk gain` · `rtk gain --daily` | RTK's savings history |
| `pxpipe stats` | pxpipe's own counters (if used) |
| `~/.local/state/token-stack/*.log` | proxy logs when started by `token-stack` |

> [!TIP]
> Each tool counts against the request it receives, after the other tools changed it, so the
> counters overstate what you save. Only the benchmark compares with plain Claude Code.

<details>
<summary><b>Troubleshooting</b></summary>

| Problem | Fix |
|---|---|
| Headroom saves less than expected | Unset `ENABLE_TOOL_SEARCH` in your shell; use `token-stack claude`, not `headroom wrap claude` |
| pxpipe after Headroom saves nothing | Start the chain with `token-stack`; never point Headroom at pxpipe with `--anthropic-api-url` |
| Port 8787 already in use | `TOKEN_STACK_HEADROOM_PORT=8788 token-stack claude` |
| Remote Control unavailable | Expected with any proxy; run plain `claude` when you need it |
| Claude 1M context lost behind the proxy | Known Claude Code behaviour with a custom base URL; check Headroom's issues |
| RTK not intercepting | `rtk init -g`, then restart Claude Code |
| `pip` reports a hash mismatch for litellm | The download was cut off; re-run `./install.sh` (it resumes and verifies) |
| Benchmark preflight fails | Run `benchmark/install.sh` |
| Auth or subscription errors | Headroom forwards your credentials unchanged; check it is the only proxy in the way |

</details>

---

## 📁 Repository layout

```
.
├── README.md
├── RESULTS.md              what we measured, and the conclusions
├── install.sh              best combination by default; --with-* for the others
├── uninstall.sh
├── token-stack             launcher: proxies + Claude Code (installed in /usr/local/bin)
├── scripts/                launch-claude.sh (token-stack claude), launch-copilot.sh
├── configs/                env.example
└── benchmark/
    ├── install.sh          the tools it compares + the Agent SDK
    ├── run_session.mjs     work-session benchmark (7 requests per session)
    ├── run_ab.mjs          quick benchmark (one question per session)
    ├── harness.mjs         configurations, proxies, token accounting
    ├── fixture_repo.mjs    the generated repository and the graders
    ├── reports/            session-latest.md, ab-latest.md, runs/
    ├── REAL_WORLD.md       older: figures published by the tools' authors
    └── run_benchmark.py    older offline demo, superseded by run_session.mjs
```

---

## 📜 Credits and licence

This repository (docs, scripts, benchmark) is released under the **MIT** licence.

| Tool | Licence | Repository |
|---|---|---|
| Headroom | Apache 2.0 | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) |
| RTK | Apache 2.0 | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) |
| Ponytail | MIT | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) |
| pxpipe | MIT | [teamchong/pxpipe](https://github.com/teamchong/pxpipe) |
| code-review-graph | MIT | [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) |
| Caveman | MIT | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) |

Always check the official repositories for the latest flags and breaking changes.

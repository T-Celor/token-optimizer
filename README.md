# Token Optimization Stack for AI Coding Agents

> **RTK + Caveman + Headroom** — Cut 50–90 % of tokens across Claude Code, GitHub Copilot CLI and other agents, without losing answer quality.

Clone this repo, run the installer, run the benchmark, launch your agent.  
Everything you need is inside.

Primary targets: **Claude Code** (Anthropic subscription or API) and **GitHub Copilot CLI**.  
Also works with Cursor, Codex, Gemini CLI, Aider, OpenCode and any OpenAI-compatible client.

---

## Table of Contents

1. [One-command setup](#one-command-setup)
2. [Benchmark (with vs without)](#benchmark-with-vs-without)
3. [The Three Tools](#the-three-tools)
4. [How They Work Together](#how-they-work-together)
5. [Supported Agents & Providers](#supported-agents--providers)
6. [Quick Start – Claude Code](#quick-start--claude-code)
7. [Quick Start – GitHub Copilot CLI](#quick-start--github-copilot-cli)
8. [TypeScript / JavaScript SDK](#typescript--javascript-sdk)
9. [Direct API Usage](#direct-api-usage)
10. [Verification & Monitoring](#verification--monitoring)
11. [Troubleshooting](#troubleshooting)
12. [Licence & Credits](#licence--credits)

---

## One-command setup

```bash
git clone <this-repo-url> token-opt-stack
cd token-opt-stack

chmod +x install.sh scripts/*.sh
./install.sh
```

What the installer does:

1. Installs **RTK** (shell output filter)
2. Installs **Headroom** (context compressor + proxy)
3. Installs **Caveman** (short-answer skill / CLI)
4. Runs `rtk init -g` so hooks are active

Then launch:

```bash
./scripts/launch-claude.sh      # Claude Code via Headroom
# or
./scripts/launch-copilot.sh     # GitHub Copilot CLI via Headroom
```

---

## Benchmarks (real published measurements)

The authoritative numbers for this stack are **published** benchmarks from Headroom, RTK and Caveman (official + independent), not a local simulation.

→ Full tables, sources and how to reproduce **on your machine**:  
**[`benchmark/REAL_WORLD.md`](benchmark/REAL_WORLD.md)**

### Quick summary

| Tool | What it compresses | Realistic band |
|------|--------------------|----------------|
| **RTK** | Shell command outputs | **60–90 %** on those outputs; **~5–25 %** of full session input |
| **Headroom** | Context / tool results sent to the LLM | **15–45 %** typical coding day; **40–80 %** tool-heavy; peaks **60–95 %** on JSON/logs |
| **Caveman** | Model *output* prose | **~30–65 %** of output on chat; **~5–15 %** of output (small total impact) on coding agents |

**Headline independent / official anchors**

| Source | Result |
|--------|--------|
| Headroom official workloads | Code search / SRE debug **~92 %**; exploration **~47 %** |
| Headroom E2E agent bench (50 cases) | **−44 %** input tokens, **−37 %** cost |
| RTK typical command table | Session-style mix **~70–80 %** on command outputs |
| RTK real Rust project (14 cmds) | **−65.7 %** on those outputs |
| Caveman official (10 chat tasks) | **~65 %** output tokens |
| Caveman JetBrains coding agent (86 tasks) | **~8.5 %** output tokens |

### Replay the same scenarios with *your* full stack

Fixtures live in `benchmark/fixtures/`. The harness uses **real Headroom** when installed:

```bash
./install.sh
pip install "headroom-ai[proxy]"   # if not already
python3 benchmark/run_benchmark.py
python3 benchmark/run_benchmark.py --json
python3 benchmark/run_benchmark.py --report benchmark/reports/my-stack.md
```

The header shows `Headroom (real compress): YES` when `from headroom import compress` works.  
Compare your report to the tables in [`benchmark/REAL_WORLD.md`](benchmark/REAL_WORLD.md).

Live session metrics (after real agent use):

```bash
rtk gain
# ~/.headroom/logs/proxy.log
```

## The Three Tools

### 1. RTK — Rust Token Killer

**What it does**  
Sits between your coding agent and the shell. When the agent runs a command (`git status`, `npm test`, `cargo build`, `find`, `grep`…), RTK intercepts the output, removes noise (progress bars, boilerplate, repeated lines…), groups similar items and returns a compact version.

**Typical savings**  
- `git diff` / large status → 70–92 %  
- Test / build logs → 60–90 %  
- Search / find results → 50–80 %

**Key points**
- Written in Rust, zero runtime dependencies
- Transparent: you keep typing normal commands
- Global or per-project hooks for Claude Code, Copilot CLI, Cursor, Codex, Gemini CLI…
- Tracks savings with `rtk gain`

**Links**  
- https://github.com/rtk-ai/rtk  
- https://www.rtk-ai.app

---

### 2. Caveman

**What it does**  
System-prompt / skill / plugin that forces the model to answer in ultra-short “caveman speak”:

- No greetings, no “Sure!”, no preambles  
- No filler words  
- Fragments preferred  
- Code blocks stay 100 % intact  

**Typical savings**  
30–65 % of *output* tokens.

**Key points**
- Works with Claude Code, GitHub Copilot, Codex, Gemini CLI, OpenCode, Claude.ai…
- Intensity levels: lite / full / ultra
- Reversible (`stop caveman` or uninstall)

**Links**  
- https://github.com/JuliusBrussee/caveman  
- `npx @caveman-ai/cli@latest`

---

### 3. Headroom

**What it does**  
Local proxy + compression engine between your client and the LLM provider (Anthropic, OpenAI / Copilot, Gemini, Bedrock, OpenRouter…).

- Compresses large tool outputs, JSON, logs, code, search results  
- Local cache of originals (CCR – Compress-Cache-Retrieve)  
- Model can retrieve full text if needed  
- Preserves provider caching headers when possible  

**Typical savings**  
25–95 % of *input* tokens (heavy tool use = higher savings).

**Key points**
- Zero code changes as a proxy  
- Subscription logins (Claude Pro/Max, Copilot) **and** API keys  
- TypeScript & Python SDKs  
- MCP tools for on-demand compress / retrieve / stats  

**Links**  
- https://github.com/headroomlabs-ai/headroom  
- Docs: https://headroom-docs.vercel.app

---

## How They Work Together

| Layer             | Tool         | Acts on                     | Savings type  |
|-------------------|--------------|-----------------------------|---------------|
| Shell / tools     | **RTK**      | Command *output*            | Input tokens  |
| Network / context | **Headroom** | Everything sent to the LLM  | Input tokens  |
| Model replies     | **Caveman**  | Model *output*              | Output tokens |

```
Your Agent (Claude Code / Copilot CLI / …)
        │
        ▼
   ┌─────────┐
   │   RTK   │  ← cleans shell outputs
   └────┬────┘
        │
        ▼
   ┌─────────┐
   │ Headroom│  ← compresses the whole request
   └────┬────┘
        │
        ▼
   LLM Provider (Anthropic / OpenAI / Copilot / …)
        │
        ▼
   ┌─────────┐
   │ Caveman │  ← forces short answers
   └─────────┘
```

---

## Supported Agents & Providers

| Agent / Client          | RTK | Headroom | Caveman | Notes |
|-------------------------|-----|----------|---------|-------|
| **Claude Code**         | ✅  | ✅       | ✅      | `headroom wrap claude` |
| **GitHub Copilot CLI**  | ✅  | ✅       | ✅      | `headroom wrap copilot` |
| Cursor                  | ✅  | ✅       | ✅      | Config snippet or proxy |
| OpenAI Codex CLI        | ✅  | ✅       | ✅      | `headroom wrap codex` |
| Gemini CLI              | ✅  | ✅       | ✅      | Supported |
| Aider                   | ✅  | ✅       | ✅      | `headroom wrap aider` |
| Any OpenAI-compatible   | –   | ✅       | –       | `OPENAI_BASE_URL` → proxy |
| Anthropic API / SDK     | –   | ✅       | optional| Direct or via proxy |

---

## Quick Start – Claude Code

Works with **Claude Pro / Max subscription** (OAuth) or an Anthropic API key.

```bash
./install.sh
./scripts/launch-claude.sh
```

Manual equivalent:

```bash
# Terminal 1
headroom proxy --port 8787

# Terminal 2
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
claude
```

Or simply:

```bash
headroom wrap claude
```

---

## Quick Start – GitHub Copilot CLI

Works with your GitHub Copilot subscription.

```bash
./install.sh
./scripts/launch-copilot.sh
```

Or:

```bash
headroom wrap copilot
# optional:
# headroom wrap copilot -- --model claude-sonnet-4-20250514
```

Headroom selects the correct Anthropic or OpenAI-compatible route automatically.

---

## TypeScript / JavaScript SDK

```bash
npm install headroom-ai
# + provider SDK
npm install @anthropic-ai/sdk
# or
npm install openai
```

Start the proxy (required for the TS client):

```bash
headroom proxy --port 8787
```

### Anthropic

```ts
import { withHeadroom } from 'headroom-ai/anthropic';
import Anthropic from '@anthropic-ai/sdk';

const client = withHeadroom(new Anthropic());

const response = await client.messages.create({
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 1024,
  messages: [/* … */],
});
```

### OpenAI / Copilot-compatible

```ts
import { compress } from 'headroom-ai';
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://127.0.0.1:8787/v1',
});

// or compress messages first then call any client
const result = await compress(messages, { model: 'gpt-4o' });
```

### Stand-alone compress (provider-agnostic)

```ts
import { compress } from 'headroom-ai';

const result = await compress(messages, {
  model: 'claude-sonnet-4-5-20250929',
});
console.log(result.tokensSaved, result.compressionRatio);
```

---

## Direct API Usage

### Python

```python
from headroom import compress

compressed = compress(messages, model="claude-sonnet-4-5-20250929")
# or model="gpt-4o"
# then pass compressed.messages to your client
```

### Via the proxy (any language)

```bash
headroom proxy --port 8787

export ANTHROPIC_BASE_URL=http://127.0.0.1:8787   # Anthropic-style
export OPENAI_BASE_URL=http://127.0.0.1:8787/v1     # OpenAI-compatible
```

See `configs/env.example` for a ready template.

---

## Verification & Monitoring

| Command / Location                   | What it shows                     |
|--------------------------------------|-----------------------------------|
| `python3 benchmark/run_benchmark.py` | Multi-scenario with/without comparison |
| `rtk gain`                           | RTK savings history               |
| `rtk gain --daily`                   | Daily breakdown                   |
| `~/.headroom/logs/proxy.log`         | Headroom compression lines        |
| `headroom_stats` (MCP)               | Live session stats                |

Example Headroom log:

```
Pipeline complete: 48200 → 11300 tokens (saved 36900, 76.5 % reduction)
```

Optional MCP tools:

```bash
headroom mcp install
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Agent ignores Headroom | Prefer `headroom wrap <agent>` or the scripts in `scripts/` |
| Claude 1 M context lost behind proxy | Known Claude Code behaviour with custom base URL; check Headroom issues |
| RTK not intercepting | `rtk init -g` then restart the agent |
| Caveman inactive | `/caveman` or reinstall CLI / plugin |
| Benchmark shows “local approximation” | `pip install "headroom-ai[proxy]"` then re-run |
| TypeScript SDK fails | Ensure `headroom proxy` is running |
| Copilot routing | Use `headroom wrap copilot` (auto route selection) |
| Auth / subscription broken | Headroom forwards tokens unchanged — verify proxy is the only intermediary |

---

## Repository layout

```
.
├── README.md
├── LICENSE
├── .gitignore
├── install.sh
├── scripts/
│   ├── launch-claude.sh
│   └── launch-copilot.sh
├── configs/
│   └── env.example
└── benchmark/
    ├── REAL_WORLD.md          # authoritative published benchmarks + sources
    ├── run_benchmark.py       # optional local demo only (not authoritative)
    ├── reports/
    ├── fixtures/
    └── scenarios/
```

---

## Licence & Credits

This repository (docs, scripts, benchmark) is released under the **MIT** licence.

Third-party tools:

- **RTK** — Apache 2.0 — [rtk-ai/rtk](https://github.com/rtk-ai/rtk)
- **Caveman** — MIT — [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)
- **Headroom** — Apache 2.0 — [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom)

Always refer to the official repositories for the latest flags and breaking changes.

---

*Happy token hunting — works with Claude, Copilot and beyond.*

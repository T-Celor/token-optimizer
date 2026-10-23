<div align="center">

# Token Optimization Stack

Claude Code for less: 25% cheaper on everyday sessions, 49% cheaper near the context limit.

RTK + Ponytail + Headroom, with pxpipe behind a context router · one installer · one launcher · a benchmark that checks the result

| Everyday sessions | Near the context limit | Answers right |
|:-:|:-:|:-:|
| −25% cost, −34% peak context | −49% cost, −78% peak context | every graded answer |

<sub>Against plain Claude Code (Claude Opus 5.5). Everyday: RTK + Ponytail + Headroom without pxpipe, average of 3 work sessions. Near the limit: RTK + Ponytail + Headroom → pxpipe, one 29-request session (baseline peak 303k tokens). Details in <a href="#results">Results</a>.</sub>

</div>

## Contents

- [Quick start](#quick-start)
- [Results](#results)
  - [Overview](#overview)
  - [In short](#in-short)
  - [Method](#method)
  - [Everyday sessions (7 requests)](#everyday-sessions-7-requests)
    - [Context gate on everyday sessions](#context-gate-on-everyday-sessions-separate-run-plain-claude-code-at-0315)
  - [Long sessions (18 requests)](#long-sessions-18-requests)
  - [Near the context limit (XL, 29 requests)](#near-the-context-limit-xl-29-requests)
  - [Why fewer tokens can still cost more](#why-fewer-tokens-can-still-cost-more)
  - [Configuration that matters](#configuration-that-matters)
  - [Recommendation](#recommendation)
  - [Limits](#limits)
  - [Reproduce](#reproduce)
- [What's in the stack](#whats-in-the-stack)
- [How it works](#how-it-works)
- [Daily use](#daily-use)
- [Installation](#installation)
- [Benchmark](#benchmark)
- [Privacy and data](#privacy-and-data)
- [Other agents and SDKs](#other-agents-and-sdks)
- [Monitoring and troubleshooting](#monitoring-and-troubleshooting)
- [Repository layout](#repository-layout)
- [Credits and licence](#credits-and-licence)

## Quick start

```bash
git clone <this-repo-url> token-optimizer
cd token-optimizer
./install.sh           # as your normal user; it asks for sudo when it needs it
token-stack claude     # use this instead of `claude`
```

RTK and Ponytail work in every Claude Code session. `token-stack claude` sends Claude Code through
the router chain: Headroom, with pxpipe behind a context gate that sends a request to pxpipe only
when its context is large (gain policy, see [Router chain](#router-chain-context-gate)). The proxies
keep running in the background until `token-stack stop`. To skip pxpipe, install with
`./install.sh --without-pxpipe`, or run `TOKEN_STACK_PROXIES=headroom token-stack claude`.

## Results

### Overview

<img src="docs/charts/pxpipe-gain-by-context.svg" alt="pxpipe after RTK + Ponytail + Headroom, cost change by session size: +18% workday, -5.3% long, -27.2% xl">

pxpipe only saves money when the context is large. This chart compares RTK + Ponytail + Headroom
with and without pxpipe; the table below compares every configuration with plain Claude Code.
Adding pxpipe changed the cost by +18% in a 7-request workday session, −5.3% in an 18-request long session and −27.2% in the
29-request xl session.

<img src="docs/charts/xl-near-limit.svg" alt="xl session cost and peak context: baseline $4.461 and 303k tokens; RTK + Ponytail + Headroom $3.144 and 208k; pxpipe always $2.288 and 66k; router with gain policy $1.777 and 68k">

Near the context limit, pxpipe pays off. In the xl session, RTK + Ponytail + Headroom cost $3.14 and
peaked at 208k tokens. Adding pxpipe cut the cost to $2.29 and the peak to 66k. The router with the
gain policy cost $1.78, but its session took a different path, so that result needs repeats (see
[Near the context limit](#near-the-context-limit-xl-29-requests)).

Workday session cost per configuration:

<img src="docs/charts/everyday.svg" alt="Workday session cost: plain Claude Code $0.395; RTK + Ponytail + Headroom $0.297 (−25%); RTK + Ponytail + Headroom → pxpipe $0.358 (−9%); all six tools $0.584 (+48%)">

Each cell shows the change against plain Claude Code in the same scenario.

| Configuration | Everyday cost | Everyday peak context | Everyday answers right | Long cost | Long peak context | Long answers right | XL cost | XL peak context | XL answers right |
|---|---:|---:|:-:|---:|---:|:-:|---:|---:|:-:|
| RTK + Ponytail + Headroom | −24.9% | −33.6% | 15/15 | +10.1% | +20.1% | 16/16 | −29.5% | −31.4% | 27/27 |
| RTK + Ponytail + Headroom → pxpipe | −9.3% | −53.2% | 10/10 | +4.3% | −43.3% | 16/16 | −48.7% | −78.4% | 27/27 |
| Router, gain policy | not run | not run | not run | not run | not run | not run | −60.2%* | −77.6% | 27/27 |

\* Its session read fewer files in full, so this is not yet separated from session variance.

Plain Claude Code per session: $0.395 (Everyday), $0.866 (Long) and $4.461 (XL). Peak context: 33.5k, 47.0k and 303.2k tokens.

### In short

- Install RTK, Ponytail and Headroom, with Headroom talking to Anthropic directly. It cut
  cost by 25%, tokens by 38% and peak context by 34%, and every answer was right (3 sessions).
  This is the stack without pxpipe. `install.sh` now also puts pxpipe behind a context gate by default (see [Recommendation](#recommendation)).
- Headroom does almost all of the work (−21% alone). RTK and Ponytail add little on top in
  these sessions, but they do no harm.
- pxpipe after the full stack shrinks context the most (peak −53%), but it costs more than the
  stack without it. Use it only for very long sessions that would otherwise hit the context limit.
- Near the context limit (xl, 29 requests), pxpipe after RTK + Ponytail + Headroom cut cost by 27%
  and peak context from 208k to 66k, and every answer was right. Single sessions cannot yet
  separate the router's cost from session variance.
- Caveman, code-review-graph and the full stack made sessions more expensive.
- The way the tools are wired matters as much as which ones you pick. Three configuration
  traps cut or reversed the savings (see [Configuration that matters](#configuration-that-matters)).

### Method

The long and xl scenarios below use the same setup with more requests.

Each session is one Claude Code session of 7 requests in a row on the same repository, the
way a real work session runs: get oriented, find why CI is red, fix it, find a 503 in the logs,
find a commit in the git history, add a regression test, write the PR description. The
repository is generated for the test (90 commits, 101 tests, two days of logs with a decoy),
and 5 steps are graded on exact values (file, request ID, commit hash) or on the test suite.
Prompts don't name commands, so Claude picks its own tools.

Every arm ignores your own Claude Code settings, CLAUDE.md, plugins and MCP servers. All arms
use the same model, tools and system prompt, and each arm adds only its own tools. Each session
starts with a one-request warm-up that is not counted, so every arm begins with its fixed prompt
cached. Tokens and cost are the SDK's figures over every model call. Cost is the SDK's estimate;
on a claude.ai plan it reflects usage, not a bill. Code: [`benchmark/`](benchmark/).

Versions used: Headroom 0.41.0, pxpipe 0.15.0, Ponytail 5.3.2, Caveman 4.0.1, code-review-graph 2.3.9,
with Claude Opus 5.5 and Agent SDK 0.3.303 under a claude.ai login. Full report:
[`benchmark/reports/session-latest.md`](benchmark/reports/session-latest.md).

### Everyday sessions (7 requests)

Compared with plain Claude Code (baseline: $0.395, 536k tokens, peak 33.5k per session):

<details>
<summary>Full results table</summary>

| Configuration | Sessions | Cost | Tokens | Peak context | Correct |
|---|---:|---:|---:|---:|:-:|
| RTK + Ponytail + Headroom | 3 | −24.9% | −37.7% | −33.6% | 15/15 |
| RTK + Headroom | 3 | −21.8% | −35.8% | −33.4% | 15/15 |
| Headroom | 3 | −21.4% | −39.9% | −35.2% | 15/15 |
| Headroom → pxpipe | 2 | −21.3% | −47.7% | −40.9% | 10/10 |
| RTK + Ponytail + Headroom → pxpipe | 2 | −9.3% | −47.3% | −53.2% | 10/10 |
| RTK + Headroom → pxpipe | 2 | −8.0% | −39.7% | −39.8% | 10/10 |
| RTK | 1 | −9.4% | −14.8% | −4.6% | 5/5 |
| pxpipe | 1 | −7.0% | −34.3% | −23.3% | 5/5 |
| Caveman | 1 | −2.2% | +8.5% | +2.0% | 5/5 |
| Ponytail | 1 | −2.1% | −7.4% | −1.9% | 5/5 |
| code-review-graph | 1 | +10.2% | +10.3% | +6.5% | 5/5 |
| RTK + Caveman + Ponytail | 1 | +12.5% | +24.1% | +12.6% | 5/5 |
| All six tools (first setup) | 1 | +47.9% | +54.7% | +13.5% | 5/5 |

</details>

What each change adds:

| Change | Cost |
|---|---:|
| Adding RTK to Headroom | −0.5% |
| Adding Ponytail to RTK + Headroom | −4.0% |
| Adding Caveman to RTK + Headroom | +16.9% |
| Adding Caveman to RTK + Ponytail + Headroom | +30.3% |
| Adding pxpipe after Headroom | +0.1% |
| Adding pxpipe after RTK + Ponytail + Headroom | +20.8% |
| pxpipe before Headroom instead of after | +13.9% |

No arm lost accuracy, including on the exact hashes and IDs behind pxpipe. The tasks may be too
easy to show a loss.

#### Context gate on everyday sessions (separate run, plain Claude Code at $0.315)

Method: the same workday benchmark (7 requests), one session per arm, Opus 5.5, Headroom
0.41.0, pxpipe 0.15.0, run in the Docker image ([`benchmark/docker/`](benchmark/docker/README.md)).

| Configuration | Cost | vs baseline | Tokens | vs baseline | Peak context | vs baseline | Correct |
|---|---:|---:|---:|---:|---:|---:|:-:|
| RTK + Ponytail + Headroom | $0.2786 | −11.6% | 316,573 | −15.7% | 21,111 | −19.0% | 5/5 |
| RTK + Ponytail + Headroom → gate 12k → pxpipe | $0.3032 | −3.8% | 227,687 | −39.4% | 13,871 | −46.8% | 5/5 |
| Baseline | $0.3151 | 0% | 375,583 | 0% | 26,065 | 0% | 5/5 |
| RTK + Ponytail + Headroom → pxpipe always | $0.3286 | +4.3% | 257,094 | −31.5% | 14,158 | −45.7% | 5/5 |
| RTK + Ponytail + Headroom → gate 20k → pxpipe | $0.4812 | +52.7% | 329,726 | −12.2% | 17,699 | −32.1% | 5/5 |

Findings:

1. The gate estimates size at 4 characters per token, counting the system prompt, messages and
   tools. That estimate passed 12k on the first request and 20k after 4 requests. Gate `/stats`
   reports 1 direct and 22 pxpipe requests for the 12k setting, and 4 direct and 24 pxpipe for
   20k. In this short session the 12k gate behaved almost like pxpipe always. The 20k arm
   switched partway through and wrote 32k cache tokens, compared with 21k without pxpipe. Each
   arm is a single session, so differences under about 15% should be read as noise.
2. That is why the router calibrates against real usage. On one live request it measured 22,291
   tokens where the estimate was 14,988.
3. The baseline cost less than in the everyday run above ($0.3151 against $0.395). Runs on different
   days cannot be compared directly, so compare arms within a single run.

### Long sessions (18 requests)

Scenario: `--scenario long`, one session of 18 requests. It starts with the 7 workday requests,
then reads a week of archived logs, two design documents and a customer export, makes a code
change, and answers 3 recall questions from memory, without tools. 16 steps are graded. Each arm
ran one session on Opus 5.5 in the Docker image.

| Configuration | Cost | vs baseline | Tokens | vs baseline | Peak context | vs baseline | Correct |
|---|---:|---:|---:|---:|---:|---:|:-:|
| Baseline | $0.866 | 0% | 1,327,882 | 0% | 47,033 | 0% | 16/16 |
| RTK + Ponytail + Headroom | $0.954 | +10.1% | 1,428,131 | +7.5% | 56,491 | +20.1% | 16/16 |
| RTK + Ponytail + Headroom → pxpipe always | $0.903 | +4.3% | 817,500 | −38.4% | 26,649 | −43.3% | 16/16 |

Findings:

- pxpipe after Headroom cut peak context by 43% and tokens by 38%. Every answer was correct,
  including the three recall questions about values read early in the session.
- Cost did not fall at this context size. The RTK + Ponytail + Headroom arm cost more than
  baseline here, unlike in the workday runs. With one session per arm, differences of about 10%
  are within noise.
- The baseline session peaked at 47k tokens because Claude Code searched the logs with grep
  instead of reading them in full. This scenario therefore does not come near the context limit.
  The router arms were stopped for that reason: with thresholds at 50k and 90k, they would never
  switch.

### Near the context limit (XL, 29 requests)

`--scenario xl` runs 29 requests. It adds six legacy source files of about 20k tokens each, which
the agent must read in full and explain, followed by 7 recall questions. The arms are baseline,
RTK + Ponytail + Headroom, pxpipe always, and the router with the gain policy. Under that policy,
requests below 20% of a 200k window go direct. Above that, pxpipe's own dry run estimates the
saving, and the router switches when the expected cost over the next 20 requests is lower,
including the cache rewrite and a 20% overhead for re-reads.

| Configuration | Cost | vs baseline | Tokens | vs baseline | Peak context | vs baseline | Correct |
|---|---:|---:|---:|---:|---:|---:|:-:|
| Baseline | $4.461 | 0% | 7,705,523 | 0% | 303,190 | 0% | 27/27 |
| RTK + Ponytail + Headroom | $3.144 | −29.5% | 4,923,769 | −36.1% | 207,893 | −31.4% | 27/27 |
| RTK + Ponytail + Headroom → pxpipe always | $2.288 | −48.7% | 2,406,711 | −68.8% | 65,523 | −78.4% | 27/27 |
| Router, gain policy | $1.777 | −60.2% | 2,886,607 | −62.5% | 67,922 | −77.6% | 27/27 |

Findings (one session per arm):

- pxpipe pays off near the limit. After RTK + Ponytail + Headroom, adding pxpipe cut cost by 27%
  ($2.288 vs $3.144) and peak context from 208k to 66k. Both sessions read the legacy files in
  full (22 and 24 Read calls). Every answer was right, and no arm used a tool during the 7 recall
  steps. No session was auto-compacted (the baseline peaked at 303k).
- pxpipe adds requests: 85 against 66 without it (the model re-runs commands to read exact values),
  which matches the 20% overhead the gain policy assumes.
- The router's lower cost does not come from pxpipe. It sent 76 requests direct and 1 through
  pxpipe, the last one. In that session the model searched with grep (11 calls) and read only 7
  times, so its context stayed at 41k to 68k. There, pxpipe's dry run estimated a saving of 12k to
  24k tokens. With the cache rewrite counted over 20 requests, the expected gain stayed negative,
  so the session stayed direct. It switched when the saving reached 37k of 68k. The calibrated
  estimate stayed within about 1% of the real size Anthropic reported. Different agent strategy
  between single sessions explains most of the gap, so the router arm needs repeated sessions
  before its cost can be compared.

Router decisions, request by request, in the router arm's xl session:

<img src="docs/charts/router-decisions.svg" alt="Router decisions request by request in the xl session: 76 requests went direct, and the last request went through pxpipe">

### Why fewer tokens can still cost more

Tokens are priced differently. A cache read (context already sent) costs about a tenth of normal
input, a cache write about 1.25×, and output about 5×. Over 90% of a session's tokens are cache
reads. RTK + Ponytail + Headroom, without and with pxpipe after it:

| Per session | Without pxpipe | With pxpipe |
|---|---:|---:|
| Cache read (×0.1) | 313,200 | 254,455 |
| Cache write (×1.25) | 15,006 | 21,470 |
| Output (×5) | 5,685 | 6,762 |
| Requests | 18 | 24 |
| Shell calls | 10 | 14.5 |

pxpipe removes cheap tokens and adds expensive ones. Older turns become images, so cached content
changes and gets written again. Claude also cannot reliably read exact values back from images,
so it re-runs commands (pxpipe's own documentation says agents re-read files). The smaller context
would pay off only in sessions that hit the context limit, and none of these did.

### Configuration that matters

1. Claude Code stops deferring tool definitions behind a proxy. With `ANTHROPIC_BASE_URL`
   set to anything but Anthropic, it sends every tool definition in full on each request.
2. Headroom defers them better, but only if Claude Code doesn't. Headroom injects its own
   tool deferral, which covers far more (about 330k tokens per session), and it stands down
   when Claude Code defers. So with Headroom, leave `ENABLE_TOOL_SEARCH` unset. Setting it
   took Headroom from −21% to −11%. `headroom wrap claude` sets it, which is why
   `token-stack claude` is used instead. Without Headroom (pxpipe alone), set it.
3. Don't point Headroom at another proxy. With `--anthropic-api-url`, Headroom treats
   the upstream as a third-party API and removes all tool deferral. To chain pxpipe after
   Headroom, run Headroom inside `pxpipe warp`. That diverts its traffic while Headroom
   still sees `api.anthropic.com`. This moved adding pxpipe after Headroom from +24% to
   about even (−7% while Claude Code deferred the tools, +0.1% with Headroom deferring them).

`token-stack` applies all three. pxpipe itself has no setting per type of content: its own
check decides what to turn into images.

### Recommendation

| Goal | Configuration |
|---|---|
| Lowest measured cost on workdays (no pxpipe) | `./install.sh --without-pxpipe`, then `token-stack claude` |
| Default install (context gate, gain policy) | `./install.sh`, then `token-stack claude`. Gate policy validated; cost not yet separated from session variance |
| Very long sessions | `./install.sh`, then `TOKEN_STACK_PROXIES=headroom,pxpipe token-stack claude` (near the context limit: −27% cost vs RTK + Ponytail + Headroom; about half the context and about +20% cost in the workday runs) |

Leave Caveman off (`install.sh` disables it if an earlier install enabled it), and skip
code-review-graph, at least on small repositories.

### Limits

- 1 to 3 sessions per configuration. Differences under about 15% between single sessions are
  noise.
- One small repository. The workday sessions are short (peak 33k tokens). Results may differ on
  large repositories, where pxpipe and code-review-graph are meant to help. The `--scenario long`
  run peaked at 47k tokens. The `--scenario xl` baseline peaked at 303k tokens, with no compaction
  (see [Near the context limit](#near-the-context-limit-xl-29-requests)).
  A run on SWE-bench would test large repositories.
- Cost is the SDK's estimate from token counts.
- One model (Opus 5.5).

### Reproduce

```bash
benchmark/install.sh                                     # everything the benchmark compares
cd benchmark
node run_session.mjs --live                              # baseline vs the default install
node run_session.mjs --live --arms all                   # every combination
node run_session.mjs --live --arms best --repeat 2       # the best ones, twice each
```

`--add-to <run>/combined-results.json` merges a run into an earlier report.

## What's in the stack

| Tool | What it does | Measured | Installed |
|---|---|---|:-:|
| [Headroom](https://github.com/headroomlabs-ai/headroom) | Local proxy: compresses tool results, logs and JSON, and loads tool definitions only when needed | −21% alone, the core | Yes, default |
| [RTK](https://github.com/rtk-ai/rtk) | Hook that shortens shell command output (`git`, tests, `grep`…) before Claude reads it | −9% alone | Yes, default |
| [Ponytail](https://github.com/DietrichGebert/ponytail) | Plugin that pushes Claude toward the simplest code that works | −4% on top | Yes, default |
| [pxpipe](https://github.com/teamchong/pxpipe) | Proxy that turns bulky context into images | after RTK + Ponytail + Headroom: context −53%, but cost −9% instead of −25%. Near the context limit: −27% cost vs RTK + Ponytail + Headroom | Yes, default, behind the router (`--without-pxpipe` to skip) |
| Context gate (this repo) | Optional proxy that sends a request through pxpipe only when its context is large, with a `threshold` or a `gain` policy | policy validated on the xl scenario; cost being measured | with `token-stack` |
| [code-review-graph](https://github.com/tirth8205/code-review-graph) | Code graph served to Claude over MCP | +10% on our repo | `--with-crg` |
| [Caveman](https://github.com/JuliusBrussee/caveman) | Plugin that makes Claude's replies terse | +17% to +30% when added | `--with-caveman` |

## How it works

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

The diagram shows the Headroom chain. The default install adds a context gate in front of it (see [Router chain](#router-chain-context-gate)).

`token-stack` wires the proxies to avoid three configuration traps that cut or reversed the savings.
They are explained with their measurements in [Configuration that matters](#configuration-that-matters).

### Router chain (context gate)

This is the default chain when pxpipe and Node are installed; `TOKEN_STACK_PROXIES=gate,headroom,gate,pxpipe`
sets it explicitly. A context gate decides, for each request, whether it goes through pxpipe. The
request passes the front gate, then Headroom, then pxpipe `warp` (when pxpipe is in the chain), then
the back gate, which forwards it to pxpipe or to Anthropic. The front gate records the raw request
size before Headroom changes it.

```
Claude Code
   │ ANTHROPIC_BASE_URL
   ▼
gate front   (127.0.0.1:47831)   records the raw request size
   │
   ▼
Headroom     (127.0.0.1:8787)
   │
   ▼
gate back    (127.0.0.1:47830)   context over TOKEN_STACK_GATE_MIN_TOKENS?
   │                                  yes ──▶ pxpipe (127.0.0.1:47821)
   │                                  no  ──▶ Anthropic API
```

- Calibrated on real usage. The back gate estimates size at 4 characters per token over the
  system prompt, messages and tools. For each session, it replaces that estimate with the real
  input size Anthropic reported for the session's previous direct request (input, cache read and
  cache write tokens). The gate reads the response stream to find that number and does not
  change the bytes it forwards.
- Threshold policy (the default when you set `TOKEN_STACK_PROXIES` yourself). With `TOKEN_STACK_GATE_POLICY=threshold`, a request goes to pxpipe
  once its estimated context reaches `TOKEN_STACK_GATE_MIN_TOKENS` (default `60000`).
- Gain policy (the default when `token-stack` picks the chain). With `TOKEN_STACK_GATE_POLICY=gain`, the gate uses `TOKEN_STACK_GATE_WINDOW`
  (default `200000`) as the context window.
  - Below 20% of the window, requests go direct with no analysis.
  - From 20%, pxpipe's own library runs a dry run on the request. Nothing is sent. A dry run
    takes about 1 to 2 seconds, and it is repeated only when the context has grown 10% or every
    5 requests.
  - The saving S is the token difference between the original and the transformed body. Images
    count as width × height / 750 tokens.
  - The gate compares the expected cost of the rest of the session, over H requests
    (`TOKEN_STACK_GATE_HORIZON`, default `20`), with k the overhead (default `0.2`):

    ```
    text    = H x 0.1 x P
    pxpipe  = 1.25 x (P - S) + H x 0.1 x (P - S) x (1 + k)
    ```

    P is the current context size. The 1.25 and 0.1 factors are the cache write and cache read
    prices. The overhead k covers the extra requests and output pxpipe caused in our benchmark:
    22% more requests and 11% more output tokens.
  - Between 20% and 50% of the window, the gate switches only when the saving beats a 5% margin.
    Between 50% and 85%, it switches when the saving is positive. At 85% and above, requests go
    through pxpipe whenever pxpipe applies.
  - pxpipe still decides which blocks become images, and it keeps exact values such as IDs and
    hashes in a text sheet.
  - The log set by `TOKEN_STACK_GATE_LOG` records each estimate and, after a switch, the real
    size, so prediction errors can be checked.
- Sticky sessions. A session that went to pxpipe stays on pxpipe, because switching back and
  forth rewrites the prompt cache. This applies to both policies.
- Fallback. If pxpipe is unreachable, the request goes directly to Anthropic. This applies to
  both policies.

The router's decisions in the xl session are shown in [Near the context limit](#near-the-context-limit-xl-29-requests).

## Daily use

```bash
token-stack claude                                    # Claude Code through the router (default)
TOKEN_STACK_PROXIES=headroom token-stack claude       # Headroom alone, no pxpipe
TOKEN_STACK_PROXIES=headroom,pxpipe token-stack claude  # very long sessions: half the context, ~+20% cost
TOKEN_STACK_PROXIES=gate,headroom,gate,pxpipe token-stack claude  # same router, threshold policy
token-stack status                                    # are the proxies running?
token-stack stop                                      # stop them
```

<details>
<summary>All <code>token-stack</code> commands and settings</summary>

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
| `TOKEN_STACK_PROXIES` | `gate,headroom,gate,pxpipe` when pxpipe and Node are installed, else `headroom` | Proxies in chain order: `headroom`, `headroom,pxpipe`, `pxpipe,headroom`, `pxpipe`, `none`, `headroom,gate,pxpipe` or `gate,headroom,gate,pxpipe` (router, see [Router chain](#router-chain-context-gate)) |
| `TOKEN_STACK_HEADROOM_PORT` | `8787` | Headroom port |
| `TOKEN_STACK_PXPIPE_PORT` | `47821` | pxpipe port |
| `TOKEN_STACK_GATE_PORT` | `47830` | Context gate, back (after Headroom) |
| `TOKEN_STACK_GATE_FRONT_PORT` | `47831` | Context gate, front (before Headroom), router chain only |
| `TOKEN_STACK_GATE_POLICY` | `gain` with the default chain, `threshold` when `TOKEN_STACK_PROXIES` is set | `threshold` sends a request to pxpipe at `TOKEN_STACK_GATE_MIN_TOKENS`; `gain` decides from the estimated saving (see [Router chain](#router-chain-context-gate)) |
| `TOKEN_STACK_GATE_MIN_TOKENS` | `60000` | Context size, in tokens, from which a request goes through pxpipe (`threshold` policy) |
| `TOKEN_STACK_GATE_WINDOW` | `200000` | Context window, in tokens, used by the `gain` policy |
| `TOKEN_STACK_GATE_HORIZON` | `20` | Requests over which the `gain` policy spreads the cache rewrite cost |
| `TOKEN_STACK_GATE_LOG` | unset | Optional JSONL log of each request's route, estimate and real context |
| `TOKEN_STACK_STATE_DIR` | `~/.local/state/token-stack` | PID files and proxy logs |

</details>

> [!NOTE]
> With any proxy set as `ANTHROPIC_BASE_URL`, Claude Code's Remote Control is unavailable.
> Run plain `claude` when you need it.

## Installation

Requirements: Linux, macOS or WSL · Python 3.10+ with venv · Node.js 20.19+ (for pxpipe
and the benchmark) · Claude Code · `curl` · `sudo` for the system-wide parts.

```bash
./install.sh                    # default: RTK + Ponytail + Headroom + pxpipe (router chain)
./install.sh --without-pxpipe   # the same without pxpipe: Headroom alone
./install.sh --help             # all options
```

| Option | Adds |
|---|---|
| *(none)* | RTK, Headroom, pxpipe 0.15.0 (pinned: it sees every request), Ponytail and `token-stack`; disables Caveman if an earlier install enabled it |
| `--without-pxpipe` | Skips pxpipe, so `token-stack claude` runs Headroom alone. `--with-pxpipe` is still accepted and changes nothing |
| `--with-crg` | code-review-graph 2.3.9, set up per repo with `token-stack graph` |
| `--with-caveman` | Caveman, enabled (not recommended) |
| `--benchmark-tools` | pxpipe, code-review-graph, and Caveman installed but disabled |

<details>
<summary>Where things go</summary>

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

Uninstall: `./uninstall.sh` asks before each removal (`--dry-run` to preview, `--yes` to
skip the questions). It prints the few manual steps left (RTK's lines in `~/.claude`).

## Benchmark

The benchmark runs real Claude Code sessions and compares every combination of tools against
plain Claude Code. How it measures is described in [Method](#method).

Three scenarios are available through `--scenario`. Sessions of different scenarios are never
merged.

| Scenario | Requests | What it covers |
|---|---:|---|
| `workday` (default) | 7 | Find why CI is red, fix it, find a 503 in the logs, find a commit, add a regression test |
| `long` | 18 | The 7 workday requests, then reading a week of archived logs, two design docs and a customer export (about 150k tokens of material), a code change, and 3 recall questions answered from memory |
| `xl` | 29 | About 120k tokens of code to read in full, on the long scenario's repository |

```bash
benchmark/install.sh                                  # the tools it compares + the Agent SDK
cd benchmark
node run_session.mjs                                  # checks only, no model calls
node run_session.mjs --live                           # plain Claude Code vs the default install
node run_session.mjs --live --arms best --repeat 2    # the best configurations, twice each
node run_session.mjs --live --scenario long --arms long
```

| Preset | Configurations |
|---|---|
| `default` | plain Claude Code, RTK + Ponytail + Headroom |
| `best` | plain Claude Code and the best 6, with and without pxpipe after Headroom |
| `ablation` | plain Claude Code, RTK + Caveman + Ponytail, + code-review-graph, everything |
| `gate` | plain Claude Code, the default install, pxpipe after Headroom, and the gate from 12k or 20k tokens |
| `long` | plain Claude Code, the default install, pxpipe after Headroom, the router at 50k and 90k tokens, and the router with the gain policy |
| `router` | the default install, the router at 50k and 90k tokens, and the router with the gain policy |
| `all` | every configuration defined in [`harness.mjs`](benchmark/harness.mjs) |

Sessions run on your logged-in Claude account. Workday sessions cost about $0.30 to $0.45 each in our runs; long and xl sessions cost several times as much. Reports
go to `benchmark/reports/session-latest.md`, and `--add-to <run>/combined-results.json` merges
a new run into an earlier report. `run_ab.mjs` is a quicker variant with one question per
session. The long scenario writes its report to `benchmark/reports/session-long-latest.md`.

> [!WARNING]
> A long session costs several times a workday session. On a claude.ai plan, the usage window
> may cover about one long session. Run the arms one at a time and merge them with `--add-to`.

To run the benchmark from Windows or macOS, use the Linux container in
[`benchmark/docker/`](benchmark/docker/README.md). Its commands are `run.sh build`, `up`,
`login`, `check`, `bench`, `sync`, `reports` and `down`.

## Privacy and data

Everything runs on your machine; requests still go only to Anthropic.

- Headroom runs with telemetry forced off (`--no-telemetry`).
- RTK telemetry is opt-in and off unless you enable it (`rtk telemetry status`).
- Ponytail hooks run locally; its optional webhook is empty by default.
- pxpipe (optional) sends its images to Anthropic only. Its `warp` mode creates a local
  certificate authority in `~/.pxpipe`, trusted by the Headroom process only.
- code-review-graph (optional) is installed without embedding extras, so no code leaves
  the machine.
- The Caveman npm CLI is never installed: it adds its own proxy and sends telemetry by
  default.

## Other agents and SDKs

Only Claude Code was benchmarked. Headroom and RTK also work with other agents.

<details>
<summary>GitHub Copilot CLI</summary>

```bash
./install.sh
./scripts/launch-copilot.sh        # or: headroom wrap copilot
headroom wrap copilot -- --model <model>
```

Headroom selects the Anthropic or OpenAI-compatible route automatically.

</details>

<details>
<summary>Other agents</summary>

| Agent / Client | RTK | Headroom | How |
|---|:-:|:-:|---|
| Claude Code | Yes | Yes | `token-stack claude` (benchmarked) |
| GitHub Copilot CLI | Yes | Yes | `headroom wrap copilot` |
| Cursor | Yes | Yes | config snippet or proxy |
| OpenAI Codex CLI | Yes | Yes | `headroom wrap codex` |
| Gemini CLI | Yes | Yes | supported |
| Aider | Yes | Yes | `headroom wrap aider` |
| Any OpenAI-compatible client | No | Yes | `OPENAI_BASE_URL` → proxy |
| Anthropic API / SDK | No | Yes | direct or via proxy |

Ponytail has plugins for other agents too: see its repository.

</details>

<details>
<summary>TypeScript / JavaScript SDK</summary>

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
<summary>Python, or any language through the proxy</summary>

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

## Monitoring and troubleshooting

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
<summary>Troubleshooting</summary>

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

## Repository layout

```
.
├── README.md
├── LICENSE
├── install.sh                 best combination by default; --with-* for the others
├── uninstall.sh
├── token-stack                launcher: proxies + Claude Code (installed in /usr/local/bin)
├── scripts/                   launch-claude.sh (token-stack claude), launch-copilot.sh, context-gate.mjs (installed to /usr/local/lib/token-stack/)
├── configs/                   env.example
├── docs/
│   └── charts/                charts used in this README: make_charts.mjs, data.json
├── security_report/           security review notes (Headroom.md)
└── benchmark/
    ├── install.sh             the tools it compares + the Agent SDK
    ├── run_session.mjs        session benchmark: workday, long or xl scenario
    ├── run_ab.mjs             quick benchmark (one question per session)
    ├── harness.mjs            configurations, proxies, token accounting
    ├── fixture_repo.mjs       the generated repository and the graders
    ├── fixtures/              sample CI log, test log, git diff and search output
    ├── long_size.mjs          prints the long scenario's sizes
    ├── package.json
    ├── package-lock.json
    ├── test_context_gate.mjs  context gate tests (29, node --test)
    ├── test_claude_stack.mjs  launcher tests: settings.json edits (6, node --test)
    ├── docker/                Linux container to run the benchmark from Windows or macOS
    ├── reports/               session-latest.md, ab-latest.md, runs/
    ├── REAL_WORLD.md          older: figures published by the tools' authors
    └── run_benchmark.py       older offline demo, superseded by run_session.mjs
```

## Credits and licence

This repository (docs, scripts, benchmark) is released under the MIT licence.

| Tool | Licence | Repository |
|---|---|---|
| Headroom | Apache 2.0 | [headroomlabs-ai/headroom](https://github.com/headroomlabs-ai/headroom) |
| RTK | Apache 2.0 | [rtk-ai/rtk](https://github.com/rtk-ai/rtk) |
| Ponytail | MIT | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) |
| pxpipe | MIT | [teamchong/pxpipe](https://github.com/teamchong/pxpipe) |
| code-review-graph | MIT | [tirth8205/code-review-graph](https://github.com/tirth8205/code-review-graph) |
| Caveman | MIT | [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) |

Check each tool's repository for current flags and breaking changes, since they change between releases.

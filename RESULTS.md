# Results: what actually saves on Claude Code

Measured on 2026-10-19 with real Claude Code sessions (Claude Opus 5.5, Agent SDK 0.3.303,
claude.ai login), comparing each combination of tools with plain Claude Code. Versions:
Headroom 0.41.0, pxpipe 0.15.0, Ponytail 5.3.2, Caveman 4.0.1, code-review-graph 2.3.9.
Full report: [`benchmark/reports/session-latest.md`](benchmark/reports/session-latest.md).

## In short

- **Install RTK + Ponytail + Headroom**, with Headroom talking to Anthropic directly. It cut
  cost by **25%**, tokens by **38%** and peak context by **34%**, with every answer right
  (3 sessions). This is what `install.sh` installs by default.
- **Headroom does almost all of it** (−21% alone). RTK and Ponytail add little on top in
  these sessions, but nothing negative.
- **pxpipe after Headroom** shrinks context the most (peak −53%), but costs more than
  Headroom without it. Use it only for very long sessions that would otherwise hit the
  context limit.
- **Caveman, code-review-graph and the full stack made sessions more expensive.**
- **How the tools are wired matters as much as which ones you pick.** Three configuration
  traps cut or reversed the savings (see [Configuration](#configuration-that-matters)).

## Method

Each session is one Claude Code session of 7 requests in a row on the same repository, as
in a real work session: get oriented, find why CI is red, fix it, find a 503 in the logs,
find a commit in the git history, add a regression test, write the PR description. The
repository is generated for the test (90 commits, 101 tests, two days of logs with a decoy),
and 5 steps are graded on exact values (file, request ID, commit hash) or on the test suite.
Prompts don't name commands: Claude picks its own tools.

Every arm ignores your own Claude Code settings, CLAUDE.md, plugins and MCP servers, and uses
the same model, tools and system prompt; it then adds only its tools. Each session follows a
one-request warm-up that is not counted, so all arms start with their fixed prompt cached.
Tokens and cost are the SDK's figures over every model call (cost is its estimate; on a
claude.ai plan it is usage, not a bill). Code: [`benchmark/`](benchmark/).

## Results

Compared with plain Claude Code (baseline: $0.395, 536k tokens, peak 33.5k per session).

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
| Everything (first setup) | 1 | +47.9% | +54.7% | +13.5% | 5/5 |

What each tool adds:

| Change | Cost |
|---|---:|
| Adding RTK to Headroom | −0.5% |
| Adding Ponytail to RTK + Headroom | −4.0% |
| Adding Caveman to RTK + Headroom | +16.9% |
| Adding Caveman to RTK + Ponytail + Headroom | +30.3% |
| Adding pxpipe after Headroom | +0.1% |
| Adding pxpipe after RTK + Ponytail + Headroom | +20.8% |
| pxpipe before Headroom instead of after | +13.9% |

Accuracy never dropped, in any arm, including exact hashes and IDs behind pxpipe. These
tasks may be too easy to show a loss.

## Why fewer tokens is not always cheaper

Tokens are not priced alike: a cache read (context already sent) costs about a tenth of
normal input, a cache write about 1.25×, and output about 5×. Over 90% of a session's
tokens are cache reads. RTK + Ponytail + Headroom, without and with pxpipe after it:

| Per session | Without pxpipe | With pxpipe |
|---|---:|---:|
| Cache read (×0.1) | 313,200 | 254,455 |
| Cache write (×1.25) | 15,006 | 21,470 |
| Output (×5) | 5,685 | 6,762 |
| Requests | 18 | 24 |
| Shell calls | 10 | 14.5 |

pxpipe removes cheap tokens and adds expensive ones. Older turns become images, so content
already cached changes and is written again; and Claude cannot read exact values back from
images reliably, so it re-runs commands (pxpipe's own documentation says agents re-read
files). Its smaller context would pay off in sessions that otherwise hit the context limit;
none of these did.

## Configuration that matters

1. **Claude Code stops deferring tool definitions behind a proxy.** With `ANTHROPIC_BASE_URL`
   set to anything but Anthropic, it sends every tool definition in full on each request.
2. **Headroom defers them better, but only if Claude Code doesn't.** Headroom injects its own
   tool deferral, which covers far more (about 330k tokens per session), and stands down
   when Claude Code defers. So with Headroom, leave `ENABLE_TOOL_SEARCH` unset: setting it
   took Headroom from −21% to −11%. `headroom wrap claude` sets it, which is why
   `token-stack claude` is used instead. Without Headroom (pxpipe alone), set it.
3. **Don't point Headroom at another proxy.** With `--anthropic-api-url`, Headroom treats
   the upstream as a third-party API and removes all tool deferral. To chain pxpipe after
   Headroom, run Headroom inside `pxpipe warp`, which diverts its traffic while Headroom
   still sees `api.anthropic.com`. That took adding pxpipe after Headroom from +24% to
   about even (−7% while Claude Code deferred the tools, +0.1% with Headroom deferring them).

`token-stack` applies all three. pxpipe itself has no setting per type of content: its own
check decides what to turn into images.

## Recommendation

| Goal | Configuration |
|---|---|
| Lowest cost (default) | `./install.sh`, then `token-stack claude` |
| Very long sessions | `./install.sh --with-pxpipe`, then `TOKEN_STACK_PROXIES=headroom,pxpipe token-stack claude` (about half the context, about +20% cost) |

Leave Caveman off (`install.sh` disables it if an earlier install enabled it), and skip
code-review-graph at least on small repositories.

## Limits

- 1 to 3 sessions per configuration: differences under about 15% between single sessions
  are noise.
- One small repository and short sessions (peak 33k tokens): the results may differ on
  large repositories and long sessions, where pxpipe and code-review-graph aim to help.
  A run on SWE-bench would test that.
- Cost is the SDK's estimate from token counts.
- One model (Opus 5.5).

## Reproduce

```bash
benchmark/install.sh                                     # everything the benchmark compares
cd benchmark
node run_session.mjs --live                              # baseline vs the default install
node run_session.mjs --live --arms all                   # every combination
node run_session.mjs --live --arms best --repeat 2       # the best ones, twice each
```

`--add-to <run>/combined-results.json` merges a run into an earlier report.

# Work-session benchmark: tool combinations

- When: 2026-10-20T20:49:07.755Z
- Model: claude-opus-5-5; 1 session(s) per arm, 7 requests each (orient, ci_red, fix, incident, history, regression_test, pr_summary)
- Every arm: none of your settings, CLAUDE.md, plugins or MCP servers; same model, tools and Claude Code system prompt; then only the arm's components (see harness.mjs)
- Tokens = uncached input + cache writes + cache reads + output, over every model call. Cost is the SDK's `total_cost_usd` estimate (on a claude.ai plan this is usage, not a bill)
- Each measured session follows a one-request warm-up with the same setup, not counted, so every arm is measured with its fixed prompt already cached whatever order the arms ran in. Startup $ is that warm-up: add it for a first session with a cold cache
- Correct = 5 graded steps per session: failing test file, suite green after the fix, exact request_id, exact commit hash, regression test added and suite green
- Peak context = the largest single request sent to the model; it decides how soon a session hits the context limit
- Single sessions vary from run to run: treat differences of a few percent as noise. `--repeat N` averages N sessions per arm
- Logs: /home/bench/token-optimizer/benchmark/reports/runs/2026-10-20T20-40-24-439Z

## Arms (cheapest first, compared with baseline)

| Arm | Components | Cost $ | vs ref | Tokens | vs ref | Peak ctx | vs ref | Startup $ | Correct |
|---|---|---:|---:|---:|---:|---:|---:|---:|:-:|
| rtk+ponytail+headroom | rtk, ponytail, headroom | 0.2786 | -11.6% | 316573 | -15.7% | 21111 | -19% | 0.1059 | 5/5 |
| rtk+ponytail+headroom+gate12k+pxpipe | rtk, ponytail, headroom, gate, pxpipe | 0.3032 | -3.8% | 227687 | -39.4% | 13871 | -46.8% | 0.0723 | 5/5 |
| **baseline** | none | 0.3151 | 0% | 375583 | 0% | 26065 | 0% | 0.1141 | 5/5 |
| rtk+ponytail+headroom+pxpipe | rtk, ponytail, headroom, pxpipe | 0.3286 | +4.3% | 257094 | -31.5% | 14158 | -45.7% | 0.0723 | 5/5 |
| rtk+ponytail+headroom+gate20k+pxpipe | rtk, ponytail, headroom, gate, pxpipe | 0.4812 | +52.7% | 329726 | -12.2% | 17699 | -32.1% | 0.0605 | 5/5 |

## What each tool or group does

Change from the first arm to the second.

| Question | From → to | Cost | Tokens | Peak ctx | Correct |
|---|---|---:|---:|---:|:-:|
| Adding pxpipe after Headroom to RTK + Ponytail + Headroom | rtk+ponytail+headroom → rtk+ponytail+headroom+pxpipe | +18% | -18.8% | -32.9% | 5/5 → 5/5 |
| pxpipe only above 12k tokens, after RTK + Ponytail + Headroom | rtk+ponytail+headroom → rtk+ponytail+headroom+gate12k+pxpipe | +8.8% | -28.1% | -34.3% | 5/5 → 5/5 |
| pxpipe only above 20k tokens, after RTK + Ponytail + Headroom | rtk+ponytail+headroom → rtk+ponytail+headroom+gate20k+pxpipe | +72.7% | +4.2% | -16.2% | 5/5 → 5/5 |
| Gate at 12k instead of pxpipe always | rtk+ponytail+headroom+pxpipe → rtk+ponytail+headroom+gate12k+pxpipe | -7.7% | -11.4% | -2% | 5/5 → 5/5 |

## Token mix (average per session)

| Arm | Uncached in | Cache write | Cache read | Output | Requests | Tools used |
|---|---:|---:|---:|---:|---:|---|
| baseline | 1235 | 15334 | 352916 | 6098 | 18 | Bash 11, Edit 1, Write 1 |
| rtk+ponytail+headroom | 49 | 15059 | 296353 | 5112 | 18 | Bash 10, Grep 1, Edit 1, Write 1 |
| rtk+ponytail+headroom+pxpipe | 58 | 21338 | 230008 | 5690 | 22 | Bash 13, Read 1, Edit 1, Write 1 |
| rtk+ponytail+headroom+gate12k+pxpipe | 52 | 19528 | 202795 | 5312 | 20 | Bash 12, Read 1, Edit 1, Write 1 |
| rtk+ponytail+headroom+gate20k+pxpipe | 64 | 32417 | 289055 | 8190 | 25 | Bash 16, Read 1, Write 1 |

## Cost per step ($, average)

| Step | baseline | rtk+ponytail+headroom | rtk+ponytail+headroom+pxpipe | rtk+ponytail+headroom+gate12k+pxpipe | rtk+ponytail+headroom+gate20k+pxpipe |
|---|---:|---:|---:|---:|---:|
| orient | 0.1093 | 0.1106 | 0.1147 | 0.1030 | 0.1729 |
| ci_red | 0.0212 | 0.0178 | 0.0682 | 0.0655 | 0.0877 |
| fix | 0.0265 | 0.0322 | 0.0309 | 0.0268 | 0.0360 |
| incident | 0.0446 | 0.0318 | 0.0238 | 0.0291 | 0.0402 |
| history | 0.0432 | 0.0321 | 0.0281 | 0.0217 | 0.0499 |
| regression_test | 0.0525 | 0.0404 | 0.0489 | 0.0444 | 0.0775 |
| pr_summary | 0.0177 | 0.0138 | 0.0141 | 0.0127 | 0.0170 |

## Answers

| Arm | Session | ci_red | fix | incident | history | regression_test |
|---|---|:-:|:-:|:-:|:-:|:-:|
| baseline | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes |
| rtk+ponytail+headroom | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes |
| rtk+ponytail+headroom+pxpipe | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes |
| rtk+ponytail+headroom+gate12k+pxpipe | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes |
| rtk+ponytail+headroom+gate20k+pxpipe | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes |

## Proxy evidence

The proxies' own counters, measured against the request each one received. The tables above compare against real sessions without them.

### rtk+ponytail+headroom

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 23
summary.compression.requests_compressed: 19
summary.compression.tool_schema_tokens_saved: 268641
summary.compression.total_tokens_saved_all_layers: 289052
summary.cost.total_saved_usd: 0.4
summary.cost.measured_saved_usd: 0.4
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 50.9
agent_usage.totals.requests: 23
agent_usage.totals.tokens_saved: 20411
agent_usage.totals.savings_percent: 5.91
agent_usage.coverage.logged_requests: 23
tokens.requests_input_provider_reported: 21
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 289052
tokens.proxy_compression_saved: 20411
tokens.all_layers_saved: 289052
tokens.active_savings_percent: 38.71
tokens.proxy_savings_percent: 5.91
tokens.new_input_savings_percent: 41.57
tokens.savings_percent: 47.07
tokens.all_layers_savings_percent: 47.07
```

### rtk+ponytail+headroom+pxpipe

pxpipe (`pxpipe stats`):

```text
━━━ pxpipe stats ━━━

requests:       25
  2xx:                25   4xx:      0   5xx:      0
  compressed:         25  (100.0%)
  passthrough:         0  ( 0.0%)

latency (ms):
  duration  p50=2464  p95=6233  p99=7326
  first-byte p50=1253  p95=4203  p99=4497

compression:
  orig text rendered: 433,251 chars
  image bytes:        5,230,429 B
  bytes/char ratio:   12.073

Anthropic token usage:
  input:                   64
  output:               5,711
  cache create:        31,040
  cache read:         230,008
  cache hit rate (by tokens):  88.1%
  cache hit rate (by events):  88.0%

measured savings — raw tokens (count_tokens baseline vs real usage):
  measured requests:            25
  baseline tokens:         429,587
  actual tokens:           261,112
  saved:                   168,475  (39.2%)
  (raw-token basis: cache reads at face value, not cost-weighted —
   differs from the dashboard's cost-weighted saved %)

top system prompts (system_sha8, high count = cache reuse):
      23  e5bd106b
       2  1a5c3901
  unique prompts: 2    reuse rate: 92.0%
```

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 27
summary.compression.requests_compressed: 23
summary.compression.tool_schema_tokens_saved: 325197
summary.compression.total_tokens_saved_all_layers: 350185
summary.cost.total_saved_usd: 1.01
summary.cost.measured_saved_usd: 1.01
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 71.6
agent_usage.totals.requests: 27
agent_usage.totals.tokens_saved: 24988
agent_usage.totals.savings_percent: 8.73
agent_usage.coverage.logged_requests: 27
tokens.requests_input_provider_reported: 25
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 350185
tokens.proxy_compression_saved: 24988
tokens.all_layers_saved: 350185
tokens.active_savings_percent: 37.84
tokens.proxy_savings_percent: 8.73
tokens.new_input_savings_percent: 44.55
tokens.savings_percent: 57.29
tokens.all_layers_savings_percent: 57.29
```

### rtk+ponytail+headroom+gate12k+pxpipe

pxpipe (`pxpipe stats`):

```text
━━━ pxpipe stats ━━━

requests:       22
  2xx:                22   4xx:      0   5xx:      0
  compressed:         22  (100.0%)
  passthrough:         0  ( 0.0%)

latency (ms):
  duration  p50=2923  p95=7286  p99=7736
  first-byte p50=1407  p95=3141  p99=3666

compression:
  orig text rendered: 393,218 chars
  image bytes:        4,383,644 B
  bytes/char ratio:   11.148

Anthropic token usage:
  input:                   54
  output:               5,366
  cache create:        28,559
  cache read:         202,279
  cache hit rate (by tokens):  87.6%
  cache hit rate (by events):  95.5%

measured savings — raw tokens (count_tokens baseline vs real usage):
  measured requests:            22
  baseline tokens:         368,156
  actual tokens:           230,892
  saved:                   137,264  (37.3%)
  (raw-token basis: cache reads at face value, not cost-weighted —
   differs from the dashboard's cost-weighted saved %)

top system prompts (system_sha8, high count = cache reuse):
      21  8e771be9
       1  1a5c3901
  unique prompts: 2    reuse rate: 90.9%
```

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 25
summary.compression.requests_compressed: 21
summary.compression.tool_schema_tokens_saved: 296919
summary.compression.total_tokens_saved_all_layers: 319706
summary.cost.total_saved_usd: 0.98
summary.cost.measured_saved_usd: 0.98
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 72
agent_usage.totals.requests: 25
agent_usage.totals.tokens_saved: 22787
agent_usage.totals.savings_percent: 8.94
agent_usage.coverage.logged_requests: 25
tokens.requests_input_provider_reported: 23
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 319706
tokens.proxy_compression_saved: 22787
tokens.all_layers_saved: 319706
tokens.active_savings_percent: 38.53
tokens.proxy_savings_percent: 8.94
tokens.new_input_savings_percent: 44.33
tokens.savings_percent: 57.94
tokens.all_layers_savings_percent: 57.94
```

Context gate (`/stats`, requests direct or to pxpipe):

```text
{
  "min_tokens": 12000,
  "direct": 1,
  "pxpipe": 22,
  "sessions_on_pxpipe": 2
}
```

### rtk+ponytail+headroom+gate20k+pxpipe

pxpipe (`pxpipe stats`):

```text
━━━ pxpipe stats ━━━

requests:       24
  2xx:                24   4xx:      0   5xx:      0
  compressed:         24  (100.0%)
  passthrough:         0  ( 0.0%)

latency (ms):
  duration  p50=2941  p95=8299  p99=8630
  first-byte p50=1160  p95=1409  p99=1601

compression:
  orig text rendered: 445,896 chars
  image bytes:        5,446,740 B
  bytes/char ratio:   12.215

Anthropic token usage:
  input:                   58
  output:               8,008
  cache create:        27,213
  cache read:         280,604
  cache hit rate (by tokens):  91.1%
  cache hit rate (by events):  95.8%

measured savings — raw tokens (count_tokens baseline vs real usage):
  measured requests:            24
  baseline tokens:         470,022
  actual tokens:           307,875
  saved:                   162,147  (34.5%)
  (raw-token basis: cache reads at face value, not cost-weighted —
   differs from the dashboard's cost-weighted saved %)

top system prompts (system_sha8, high count = cache reuse):
      24  cfc8260f
  unique prompts: 1    reuse rate: 95.8%
```

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 30
summary.compression.requests_compressed: 26
summary.compression.tool_schema_tokens_saved: 367614
summary.compression.total_tokens_saved_all_layers: 396550
summary.cost.total_saved_usd: 0.96
summary.cost.measured_saved_usd: 0.96
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 63.8
agent_usage.totals.requests: 30
agent_usage.totals.tokens_saved: 28936
agent_usage.totals.savings_percent: 7.95
agent_usage.coverage.logged_requests: 30
tokens.requests_input_provider_reported: 28
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 396550
tokens.proxy_compression_saved: 28936
tokens.all_layers_saved: 396550
tokens.active_savings_percent: 37.07
tokens.proxy_savings_percent: 7.95
tokens.new_input_savings_percent: 42.03
tokens.savings_percent: 54.2
tokens.all_layers_savings_percent: 54.2
```

Context gate (`/stats`, requests direct or to pxpipe):

```text
{
  "min_tokens": 20000,
  "direct": 4,
  "pxpipe": 24,
  "sessions_on_pxpipe": 1
}
```

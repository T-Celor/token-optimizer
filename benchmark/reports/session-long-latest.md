# Work-session benchmark: tool combinations

- When: 2026-10-20T21:14:42.195Z
- Scenario: long (18 requests per session)
- Model: claude-opus-5-5; 1 session(s) per arm, 18 requests each (orient, ci_red, fix, incident, history, regression_test, pr_summary, week_review, slowest, ledger_errors, design_read, migration_read, customers, top_customer, code_change, recall_503, recall_slowest, recall_deprecated)
- Every arm: none of your settings, CLAUDE.md, plugins or MCP servers; same model, tools and Claude Code system prompt; then only the arm's components (see harness.mjs)
- Tokens = uncached input + cache writes + cache reads + output, over every model call. Cost is the SDK's `total_cost_usd` estimate (on a claude.ai plan this is usage, not a bill)
- Each measured session follows a one-request warm-up with the same setup, not counted, so every arm is measured with its fixed prompt already cached whatever order the arms ran in. Startup $ is that warm-up: add it for a first session with a cold cache
- Correct = 16 graded steps per session (checks in fixture_repo.mjs)
- Peak context = the largest single request sent to the model; it decides how soon a session hits the context limit
- Single sessions vary from run to run: treat differences of a few percent as noise. `--repeat N` averages N sessions per arm
- Combines 3 runs (sessions of an arm present in several runs are pooled). Logs: /home/bench/token-optimizer/benchmark/reports/runs/2026-10-20T21-02-36-732Z, /home/bench/token-optimizer/benchmark/reports/runs/2026-10-20T21-06-06-354Z, /home/bench/token-optimizer/benchmark/reports/runs/2026-10-20T21-09-21-251Z

## Arms (cheapest first, compared with baseline)

| Arm | Components | Cost $ | vs ref | Tokens | vs ref | Peak ctx | vs ref | Startup $ | Correct | Compactions |
|---|---|---:|---:|---:|---:|---:|---:|---:|:-:|---:|
| **baseline** | none | 0.8660 | 0% | 1327882 | 0% | 47033 | 0% | 0.0433 | 16/16 | 0.0 |
| rtk+ponytail+headroom+pxpipe | rtk, ponytail, headroom, pxpipe | 0.9031 | +4.3% | 817500 | -38.4% | 26649 | -43.3% | 0.0722 | 16/16 | 0.0 |
| rtk+ponytail+headroom | rtk, ponytail, headroom | 0.9539 | +10.1% | 1428131 | +7.5% | 56491 | +20.1% | 0.0602 | 16/16 | 0.0 |

## What each tool or group does

Change from the first arm to the second.

| Question | From → to | Cost | Tokens | Peak ctx | Correct |
|---|---|---:|---:|---:|:-:|
| Adding pxpipe after Headroom to RTK + Ponytail + Headroom | rtk+ponytail+headroom → rtk+ponytail+headroom+pxpipe | -5.3% | -42.8% | -52.8% | 16/16 → 16/16 |

## Token mix (average per session)

| Arm | Uncached in | Cache write | Cache read | Output | Requests | Tools used |
|---|---:|---:|---:|---:|---:|---|
| baseline | 1279 | 36301 | 1274269 | 16033 | 40 | Bash 22, Write 2, Edit 1 |
| rtk+ponytail+headroom | 118 | 50439 | 1363535 | 14039 | 44 | Bash 20, Grep 4, Write 2, Read 2, Edit 1 |
| rtk+ponytail+headroom+pxpipe | 131 | 54065 | 747166 | 16138 | 51 | Bash 31, Read 3, Write 2, Edit 1 |

## Tool calls during recall steps

Recall steps (answered from memory, no tools expected): recall_503, recall_slowest, recall_deprecated. Average tool calls per session during those steps; above 0 means the agent re-read instead of remembering.

| Arm | Tool calls during recall steps |
|---|---:|
| baseline | 0.0 |
| rtk+ponytail+headroom | 0.0 |
| rtk+ponytail+headroom+pxpipe | 0.0 |

## Cost per step ($, average)

| Step | baseline | rtk+ponytail+headroom | rtk+ponytail+headroom+pxpipe |
|---|---:|---:|---:|
| orient | 0.1292 | 0.1330 | 0.1048 |
| ci_red | 0.0216 | 0.0342 | 0.0683 |
| fix | 0.0286 | 0.0303 | 0.0358 |
| incident | 0.0670 | 0.0586 | 0.0374 |
| history | 0.0477 | 0.0415 | 0.0231 |
| regression_test | 0.0543 | 0.0452 | 0.0626 |
| pr_summary | 0.0182 | 0.0145 | 0.0126 |
| week_review | 0.0784 | 0.0843 | 0.1382 |
| slowest | 0.0374 | 0.0328 | 0.0271 |
| ledger_errors | 0.0331 | 0.0298 | 0.0228 |
| design_read | 0.0654 | 0.1188 | 0.0745 |
| migration_read | 0.0843 | 0.1324 | 0.0509 |
| customers | 0.0651 | 0.0676 | 0.0625 |
| top_customer | 0.0400 | 0.0391 | 0.0294 |
| code_change | 0.0481 | 0.0430 | 0.0551 |
| recall_503 | 0.0180 | 0.0170 | 0.0155 |
| recall_slowest | 0.0151 | 0.0160 | 0.0720 |
| recall_deprecated | 0.0145 | 0.0157 | 0.0105 |

## Answers

| Arm | Session | ci_red | fix | incident | history | regression_test | week_review | slowest | ledger_errors | design_read | migration_read | customers | top_customer | code_change | recall_503 | recall_slowest | recall_deprecated |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| baseline | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes | yes `2026-10-04` | yes `a0d011d9f401` | yes `6` | yes `730` | yes `250` | yes `374` | yes `c_01245` | yes | yes `1b16b51a8557` | yes `a0d011d9f401` | yes `/api/v1/invoices/legacy-total` |
| rtk+ponytail+headroom | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes | yes `2026-10-04` | yes `a0d011d9f401` | yes `6` | yes `730` | yes `250` | yes `374` | yes `c_01245` | yes | yes `1b16b51a8557` | yes `a0d011d9f401` | yes `/api/v1/invoices/legacy-total` |
| rtk+ponytail+headroom+pxpipe | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes | yes `2026-10-04` | yes `a0d011d9f401` | yes `6` | yes `730` | yes `250` | yes `374` | yes `c_01245` | yes | yes `1b16b51a8557` | yes `a0d011d9f401` | yes `/api/v1/invoices/legacy-total` |

## Proxy evidence

The proxies' own counters, measured against the request each one received. The tables above compare against real sessions without them.

### rtk+ponytail+headroom

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 48
summary.compression.requests_compressed: 45
summary.compression.tool_schema_tokens_saved: 636255
summary.compression.total_tokens_saved_all_layers: 685988
summary.cost.total_saved_usd: 0.67
summary.cost.measured_saved_usd: 0.67
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 39.9
agent_usage.totals.requests: 50
agent_usage.totals.tokens_saved: 49733
agent_usage.totals.savings_percent: 3.37
agent_usage.coverage.logged_requests: 50
tokens.requests_input_provider_reported: 46
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 685988
tokens.proxy_compression_saved: 49733
tokens.all_layers_saved: 685988
tokens.active_savings_percent: 30.4
tokens.proxy_savings_percent: 3.37
tokens.new_input_savings_percent: 46.18
tokens.savings_percent: 32.47
tokens.all_layers_savings_percent: 32.47
```

### rtk+ponytail+headroom+pxpipe

pxpipe (`pxpipe stats`):

```text
━━━ pxpipe stats ━━━

requests:       55
  2xx:                55   4xx:      0   5xx:      0
  compressed:         54  (98.2%)
  passthrough:         0  ( 0.0%)

latency (ms):
  duration  p50=4635  p95=9960  p99=16303
  first-byte p50=2252  p95=6144  p99=10029

compression:
  orig text rendered: 971,810 chars
  image bytes:        18,986,745 B
  bytes/char ratio:   19.538

Anthropic token usage:
  input:                  137
  output:              16,160
  cache create:        63,762
  cache read:         747,166
  cache hit rate (by tokens):  92.1%
  cache hit rate (by events):  94.4%

measured savings — raw tokens (count_tokens baseline vs real usage):
  measured requests:            54
  baseline tokens:       1,497,134
  actual tokens:           811,065
  saved:                   686,069  (45.8%)
  (raw-token basis: cache reads at face value, not cost-weighted —
   differs from the dashboard's cost-weighted saved %)

top system prompts (system_sha8, high count = cache reuse):
      52  6c1cf2a4
       2  1a5c3901
  unique prompts: 2    reuse rate: 96.4%
```

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 56
summary.compression.requests_compressed: 52
summary.compression.tool_schema_tokens_saved: 735228
summary.compression.total_tokens_saved_all_layers: 797640
summary.cost.total_saved_usd: 1.59
summary.cost.measured_saved_usd: 1.59
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 62
agent_usage.totals.requests: 57
agent_usage.totals.tokens_saved: 62412
agent_usage.totals.savings_percent: 7.15
agent_usage.coverage.logged_requests: 57
tokens.requests_input_provider_reported: 54
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 797640
tokens.proxy_compression_saved: 62412
tokens.all_layers_saved: 797640
tokens.active_savings_percent: 31.24
tokens.proxy_savings_percent: 7.15
tokens.new_input_savings_percent: 49.41
tokens.savings_percent: 49.58
tokens.all_layers_savings_percent: 49.58
```

# Work-session benchmark: tool combinations

- When: 2026-10-20T21:44:32.154Z
- Scenario: xl (29 requests per session)
- Model: claude-opus-5-5; 1 session(s) per arm, 29 requests each (orient, ci_red, fix, incident, history, regression_test, pr_summary, week_review, slowest, ledger_errors, design_read, migration_read, customers, top_customer, code_change, legacy_billing_engine, legacy_ledger_sync, legacy_tax_rules, legacy_dunning, legacy_proration, legacy_export_jobs, legacy_errors, recall_503, recall_slowest, recall_deprecated, recall_billing_rule, recall_billing_code, recall_ledger_rule, recall_ledger_code)
- Every arm: none of your settings, CLAUDE.md, plugins or MCP servers; same model, tools and Claude Code system prompt; then only the arm's components (see harness.mjs)
- Tokens = uncached input + cache writes + cache reads + output, over every model call. Cost is the SDK's `total_cost_usd` estimate (on a claude.ai plan this is usage, not a bill)
- Each measured session follows a one-request warm-up with the same setup, not counted, so every arm is measured with its fixed prompt already cached whatever order the arms ran in. Startup $ is that warm-up: add it for a first session with a cold cache
- Correct = 27 graded steps per session (checks in fixture_repo.mjs)
- Peak context = the largest single request sent to the model; it decides how soon a session hits the context limit
- Single sessions vary from run to run: treat differences of a few percent as noise. `--repeat N` averages N sessions per arm
- Combines 4 runs (sessions of an arm present in several runs are pooled). Logs: /home/bench/token-optimizer/benchmark/reports/runs/2026-10-20T21-16-14-477Z, /home/bench/token-optimizer/benchmark/reports/runs/2026-10-20T21-21-47-959Z, /home/bench/token-optimizer/benchmark/reports/runs/2026-10-20T21-28-41-773Z, /home/bench/token-optimizer/benchmark/reports/runs/2026-10-20T21-38-19-256Z

## Arms (cheapest first, compared with baseline)

| Arm | Components | Cost $ | vs ref | Tokens | vs ref | Peak ctx | vs ref | Startup $ | Correct | Compactions |
|---|---|---:|---:|---:|---:|---:|---:|---:|:-:|---:|
| rtk+ponytail+router-gain+pxpipe | rtk, ponytail, gate, headroom, gate, pxpipe | 1.7766 | -60.2% | 2886607 | -62.5% | 67922 | -77.6% | 0.0617 | 27/27 | 0.0 |
| rtk+ponytail+headroom+pxpipe | rtk, ponytail, headroom, pxpipe | 2.2881 | -48.7% | 2406711 | -68.8% | 65523 | -78.4% | 0.0735 | 27/27 | 0.0 |
| rtk+ponytail+headroom | rtk, ponytail, headroom | 3.1440 | -29.5% | 4923769 | -36.1% | 207893 | -31.4% | 0.0615 | 27/27 | 0.0 |
| **baseline** | none | 4.4610 | 0% | 7705523 | 0% | 303190 | 0% | 0.0432 | 27/27 | 0.0 |

## What each tool or group does

Change from the first arm to the second.

| Question | From → to | Cost | Tokens | Peak ctx | Correct |
|---|---|---:|---:|---:|:-:|
| Adding pxpipe after Headroom to RTK + Ponytail + Headroom | rtk+ponytail+headroom → rtk+ponytail+headroom+pxpipe | -27.2% | -51.1% | -68.5% | 27/27 → 27/27 |
| pxpipe only when profitable (router, gain policy), after RTK + Ponytail + Headroom | rtk+ponytail+headroom → rtk+ponytail+router-gain+pxpipe | -43.5% | -41.4% | -67.3% | 27/27 → 27/27 |

## Token mix (average per session)

| Arm | Uncached in | Cache write | Cache read | Output | Requests | Tools used |
|---|---:|---:|---:|---:|---:|---|
| baseline | 1343 | 292460 | 7379467 | 32253 | 72 | Bash 31, Read 27, Write 2, Edit 1, Grep 1 |
| rtk+ponytail+headroom | 178 | 201841 | 4692064 | 29686 | 66 | Bash 33, Read 24, Grep 2, Write 2, Edit 1 |
| rtk+ponytail+headroom+pxpipe | 218 | 148523 | 2225162 | 32808 | 85 | Bash 45, Read 22, Write 2, Edit 1 |
| rtk+ponytail+router-gain+pxpipe | 197 | 80836 | 2776708 | 28866 | 74 | Bash 32, Grep 11, Read 7, Write 2, Edit 1 |

## Tool calls during recall steps

Recall steps (answered from memory, no tools expected): recall_503, recall_slowest, recall_deprecated, recall_billing_rule, recall_billing_code, recall_ledger_rule, recall_ledger_code. Average tool calls per session during those steps; above 0 means the agent re-read instead of remembering.

| Arm | Tool calls during recall steps |
|---|---:|
| baseline | 0.0 |
| rtk+ponytail+headroom | 0.0 |
| rtk+ponytail+headroom+pxpipe | 0.0 |
| rtk+ponytail+router-gain+pxpipe | 0.0 |

## Cost per step ($, average)

| Step | baseline | rtk+ponytail+headroom | rtk+ponytail+headroom+pxpipe | rtk+ponytail+router-gain+pxpipe |
|---|---:|---:|---:|---:|
| orient | 0.1669 | 0.1471 | 0.1093 | 0.1260 |
| ci_red | 0.0473 | 0.0523 | 0.0183 | 0.0402 |
| fix | 0.0363 | 0.0310 | 0.0776 | 0.0486 |
| incident | 0.0459 | 0.0564 | 0.0607 | 0.0421 |
| history | 0.0429 | 0.0545 | 0.0408 | 0.0376 |
| regression_test | 0.0629 | 0.0472 | 0.0735 | 0.0489 |
| pr_summary | 0.0185 | 0.0168 | 0.0168 | 0.0172 |
| week_review | 0.0978 | 0.0715 | 0.1152 | 0.0764 |
| slowest | 0.0398 | 0.0338 | 0.0334 | 0.0302 |
| ledger_errors | 0.0344 | 0.0273 | 0.0459 | 0.0253 |
| design_read | 0.1106 | 0.0623 | 0.0927 | 0.0686 |
| migration_read | 0.1334 | 0.0730 | 0.0522 | 0.0567 |
| customers | 0.0682 | 0.0468 | 0.0597 | 0.0573 |
| top_customer | 0.0449 | 0.0341 | 0.0310 | 0.0306 |
| code_change | 0.0503 | 0.0393 | 0.1204 | 0.0389 |
| legacy_billing_engine | 0.4550 | 0.3383 | 0.1541 | 0.2135 |
| legacy_ledger_sync | 0.4297 | 0.3101 | 0.1483 | 0.1073 |
| legacy_tax_rules | 0.4477 | 0.3332 | 0.1554 | 0.0999 |
| legacy_dunning | 0.4724 | 0.3021 | 0.1594 | 0.0991 |
| legacy_proration | 0.4997 | 0.3150 | 0.1640 | 0.0960 |
| legacy_export_jobs | 0.5336 | 0.3282 | 0.3784 | 0.1048 |
| legacy_errors | 0.1473 | 0.1022 | 0.0401 | 0.0421 |
| recall_503 | 0.0682 | 0.0449 | 0.0173 | 0.0178 |
| recall_slowest | 0.0668 | 0.0461 | 0.0250 | 0.0171 |
| recall_deprecated | 0.0670 | 0.0453 | 0.0214 | 0.0169 |
| recall_billing_rule | 0.0679 | 0.0458 | 0.0175 | 0.0175 |
| recall_billing_code | 0.0681 | 0.0460 | 0.0187 | 0.0204 |
| recall_ledger_rule | 0.0685 | 0.0465 | 0.0182 | 0.0201 |
| recall_ledger_code | 0.0693 | 0.0466 | 0.0226 | 0.1595 |

## Answers

| Arm | Session | ci_red | fix | incident | history | regression_test | week_review | slowest | ledger_errors | design_read | migration_read | customers | top_customer | code_change | legacy_billing_engine | legacy_ledger_sync | legacy_tax_rules | legacy_dunning | legacy_proration | legacy_export_jobs | legacy_errors | recall_503 | recall_slowest | recall_deprecated | recall_billing_rule | recall_billing_code | recall_ledger_rule | recall_ledger_code |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| baseline | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes | yes `2026-10-04` | yes `a0d011d9f401` | yes `6` | yes `730` | yes `250` | yes `374` | yes `c_01245` | yes | yes `17` | yes `412` | yes `9` | yes `6` | yes `3629` | yes `2048` | yes `proration.js` | yes `1b16b51a8557` | yes `a0d011d9f401` | yes `/api/v1/invoices/legacy-total` | yes `billDormantSeatsAtReducedRate` | yes `E_BILLING_CURRENCY_MISMATCH` | yes `carryResidualCentsToSuspense` | yes `E_LEDGER_SEQUENCE_GAP` |
| rtk+ponytail+headroom | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes | yes `2026-10-04` | yes `a0d011d9f401` | yes `6` | yes `730` | yes `250` | yes `374` | yes `c_01245` | yes | yes `17` | yes `412` | yes `9` | yes `6` | yes `3629` | yes `2048` | yes `proration.js` | yes `1b16b51a8557` | yes `a0d011d9f401` | yes `/api/v1/invoices/legacy-total` | yes `billDormantSeatsAtReducedRate` | yes `E_BILLING_CURRENCY_MISMATCH` | yes `carryResidualCentsToSuspense` | yes `E_LEDGER_SEQUENCE_GAP` |
| rtk+ponytail+headroom+pxpipe | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes | yes `2026-10-04` | yes `a0d011d9f401` | yes `6` | yes `730` | yes `250` | yes `374` | yes `c_01245` | yes | yes `17` | yes `412` | yes `9` | yes `6` | yes `3629` | yes `2048` | yes `proration.js` | yes `1b16b51a8557` | yes `a0d011d9f401` | yes `/api/v1/invoices/legacy-total` | yes `billDormantSeatsAtReducedRate` | yes `E_BILLING_CURRENCY_MISMATCH` | yes `carryResidualCentsToSuspense` | yes `E_LEDGER_SEQUENCE_GAP` |
| rtk+ponytail+router-gain+pxpipe | #1 | yes `test/invoice.test.js` | yes | yes `1b16b51a8557` | yes `799d300fe080376e3e89c51822335b2aaf19ac2b` | yes | yes `2026-10-04` | yes `a0d011d9f401` | yes `6` | yes `730` | yes `250` | yes `374` | yes `c_01245` | yes | yes `17` | yes `412` | yes `9` | yes `6` | yes `3629` | yes `2048` | yes `proration.js` | yes `1b16b51a8557` | yes `a0d011d9f401` | yes `/api/v1/invoices/legacy-total` | yes `billDormantSeatsAtReducedRate` | yes `E_BILLING_CURRENCY_MISMATCH` | yes `carryResidualCentsToSuspense` | yes `E_LEDGER_SEQUENCE_GAP` |

## Proxy evidence

The proxies' own counters, measured against the request each one received. The tables above compare against real sessions without them.

### rtk+ponytail+headroom

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 71
summary.compression.requests_compressed: 67
summary.compression.tool_schema_tokens_saved: 947313
summary.compression.total_tokens_saved_all_layers: 1791387
summary.cost.total_saved_usd: 7.05
summary.cost.measured_saved_usd: 7.05
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 68.7
agent_usage.totals.requests: 71
agent_usage.totals.tokens_saved: 844074
agent_usage.totals.savings_percent: 14.67
agent_usage.coverage.logged_requests: 71
tokens.requests_input_provider_reported: 69
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 1791387
tokens.proxy_compression_saved: 844074
tokens.all_layers_saved: 1791387
tokens.active_savings_percent: 29.36
tokens.proxy_savings_percent: 14.67
tokens.new_input_savings_percent: 80.02
tokens.savings_percent: 26.74
tokens.all_layers_savings_percent: 26.74
```

### rtk+ponytail+headroom+pxpipe

pxpipe (`pxpipe stats`):

```text
━━━ pxpipe stats ━━━

requests:       104
  2xx:               104   4xx:      0   5xx:      0
  compressed:         88  (84.6%)
  passthrough:         0  ( 0.0%)

latency (ms):
  duration  p50=5096  p95=12546  p99=14917
  first-byte p50=4702  p95=12544  p99=14916

compression:
  orig text rendered: 1,603,224 chars
  image bytes:        106,712,122 B
  bytes/char ratio:   66.561

Anthropic token usage:
  input:                  220
  output:              32,812
  cache create:       157,703
  cache read:       2,225,162
  cache hit rate (by tokens):  93.4%
  cache hit rate (by events):  97.7%

measured savings — raw tokens (count_tokens baseline vs real usage):
  measured requests:            88
  baseline tokens:       6,943,743
  actual tokens:         2,383,085
  saved:                 4,560,658  (65.7%)
  (raw-token basis: cache reads at face value, not cost-weighted —
   differs from the dashboard's cost-weighted saved %)

top system prompts (system_sha8, high count = cache reuse):
      86  cb4bb3a3
       2  1a5c3901
  unique prompts: 2    reuse rate: 98.1%
```

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 89
summary.compression.requests_compressed: 86
summary.compression.tool_schema_tokens_saved: 1215954
summary.compression.total_tokens_saved_all_layers: 2360715
summary.cost.total_saved_usd: 10.26
summary.cost.measured_saved_usd: 10.26
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 81.3
agent_usage.totals.requests: 105
agent_usage.totals.tokens_saved: 1144761
agent_usage.totals.savings_percent: 32.45
agent_usage.coverage.logged_requests: 105
tokens.requests_input_provider_reported: 87
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 2360715
tokens.proxy_compression_saved: 1144761
tokens.all_layers_saved: 2360715
tokens.active_savings_percent: 27.93
tokens.proxy_savings_percent: 32.45
tokens.new_input_savings_percent: 87.88
tokens.savings_percent: 49.76
tokens.all_layers_savings_percent: 49.76
```

### rtk+ponytail+router-gain+pxpipe

pxpipe (`pxpipe stats`):

```text
━━━ pxpipe stats ━━━

requests:       1
  2xx:                 1   4xx:      0   5xx:      0
  compressed:          1  (100.0%)
  passthrough:         0  ( 0.0%)

latency (ms):
  duration  p50=6103  p95=6103  p99=6103
  first-byte p50=6097  p95=6097  p99=6097

compression:
  orig text rendered: 18,574 chars
  image bytes:        1,179,907 B
  bytes/char ratio:   63.525

Anthropic token usage:
  input:                    4
  output:                 385
  cache create:        18,975
  cache read:               0
  cache hit rate (by tokens):   0.0%
  cache hit rate (by events):   0.0%

measured savings — raw tokens (count_tokens baseline vs real usage):
  measured requests:             1
  baseline tokens:          68,248
  actual tokens:            18,979
  saved:                    49,269  (72.2%)
  (raw-token basis: cache reads at face value, not cost-weighted —
   differs from the dashboard's cost-weighted saved %)

top system prompts (system_sha8, high count = cache reuse):
       1  a6c5b415
  unique prompts: 1    reuse rate: 0.0%
```

Headroom (`/stats`, savings fields):

```text
summary.api_requests: 79
summary.compression.requests_compressed: 75
summary.compression.tool_schema_tokens_saved: 1060425
summary.compression.total_tokens_saved_all_layers: 1166257
summary.cost.total_saved_usd: 1.31
summary.cost.measured_saved_usd: 1.31
summary.cost.projected_saved_usd: 0
summary.cost.savings_pct: 41.5
agent_usage.totals.requests: 79
agent_usage.totals.tokens_saved: 105832
agent_usage.totals.savings_percent: 3.55
agent_usage.coverage.logged_requests: 79
tokens.requests_input_provider_reported: 77
tokens.requests_input_estimated: 0
tokens.output_saved: 0
tokens.output_reduction.tokens_saved: 0
tokens.output_reduction.requests: 0
tokens.saved: 1166257
tokens.proxy_compression_saved: 105832
tokens.all_layers_saved: 1166257
tokens.active_savings_percent: 27.46
tokens.proxy_savings_percent: 3.55
tokens.new_input_savings_percent: 54.1
tokens.savings_percent: 28.88
tokens.all_layers_savings_percent: 28.88
```

Context gate (`/stats`, requests direct or to pxpipe):

```text
{
  "min_tokens": 60000,
  "policy": "gain",
  "window": 200000,
  "dryruns": 7,
  "dryrun_ms_sum": 2030,
  "predictions": 1,
  "prediction_abs_error_sum": 12085.606518789733,
  "direct": 76,
  "pxpipe": 1,
  "sessions_on_pxpipe": 1,
  "front_requests": 79,
  "real_context_direct_sum": 2852524,
  "real_context_pxpipe_sum": 18979,
  "raw_est_sum": 3106203,
  "est_sum": 3027078,
  "calibrated_sessions": 2
}
```

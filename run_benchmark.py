# Real-world benchmarks (published measurements)

This document replaces synthetic / offline simulations.  
All numbers below come from **official docs**, **independent repos**, or **community measurements** with a clear method.  
They are the right baseline to compare against when you run the stack on your machine.

> **How to read this**  
> Marketing peaks (60–95 %) are often measured on *one content type* (JSON, a fat log, a chat answer).  
> End-to-end coding-agent sessions usually land lower. Both are “real”; the workload differs.

---

## 1. Headroom — input / context compression

### 1.1 Official agent workloads

Source: Headroom README / docs (published workload table).

| Workload | Before (tokens) | After | Savings |
|----------|----------------:|------:|--------:|
| Code search (100 results) | 17 765 | 1 408 | **92 %** |
| SRE incident debugging | 65 694 | 5 118 | **92 %** |
| GitHub issue triage | 54 174 | 14 761 | **73 %** |
| Codebase exploration | 78 502 | 41 254 | **47 %** |

### 1.2 Official content-type bench (compress pipeline)

Source: Headroom docs — *Compression Performance* (Apple M-series, `compress()` on tool-like outputs).

| Content type | Original | Compressed | Saved |
|--------------|---------:|-----------:|------:|
| JSON array (100 items) | 3 163 | 297 | **90.6 %** |
| JSON array (500 items) | 9 526 | 1 614 | **83.1 %** |
| Shell output (200 lines) | 3 238 | 469 | **85.5 %** |
| Build log (200 lines) | 2 412 | 148 | **93.9 %** |
| grep results (150 hits) | 2 624 | 2 624 | **0 %** |
| Python source (~480 lines) | 2 958 | 2 958 | **0 %** |
| **Total (this suite)** | **23 921** | **8 110** | **66.1 %** |

Note: source code often **0 %** by design (signatures preserved; bodies not aggressively crushed).

### 1.3 Independent end-to-end agent run

Source: [shreyassks/headroom-benchmarks](https://github.com/shreyassks/headroom-benchmarks)  
LangGraph ReAct agent, 50 cases, 106 LLM calls, Anthropic-compatible backend.

| Metric | Without Headroom | With Headroom |
|--------|-----------------:|--------------:|
| Input tokens | 189 365 | 105 769 |
| Input compression | — | **−44.15 %** |
| Cost (list price) | $0.1355 | $0.0853 |
| Cost savings | — | **−37.05 %** |

Savings concentrated on filtered search / multi-step tool-heavy cases.

### 1.4 Production-style telemetry (honest average)

Source: Headroom docs — fleet / session telemetry summary.

| Stat | Value |
|------|------:|
| Median compression (mixed requests) | **~5 %** |
| Heavy tool-use sessions | **40–80 %** |
| Claim nuance (coding agents day-to-day) | often **~15–20 %** overall |

**Takeaway for Headroom:** peaks 60–95 % on JSON/logs; coding-agent day average closer to **15–45 %** input depending on tool density; independent E2E agent run ≈ **44 %** input / **37 %** cost.

---

## 2. RTK — shell / command output filtering

### 2.1 Official “typical session” table

Source: RTK docs (*Token Savings* / introduction).

| Operation | Frequency | Standard | RTK | Savings |
|-----------|----------:|---------:|----:|--------:|
| `ls` / `tree` | 10× | 2 000 | 400 | **80 %** |
| `cat` / read | 20× | 40 000 | 12 000 | **70 %** |
| `grep` / `rg` | 8× | 16 000 | 3 200 | **80 %** |
| `git status` | 10× | 3 000 | 600 | **80 %** |
| `git diff` | 5× | 10 000 | 2 500 | **75 %** |
| `git log` | 5× | 2 500 | 500 | **80 %** |
| `npm test` / `cargo test` | 5× | 25 000 | 2 500 | **90 %** |
| `pytest` | 4× | 8 000 | 800 | **90 %** |
| **Session total (illustrative)** | | **~118 000** | **~24 000** | **~80 %** |

These percentages apply to **command output tokens**, not the entire Claude context.

### 2.2 Independent / community measurements

| Source | Setup | Result |
|--------|--------|--------|
| RTK author (Reddit) | ~30 min Claude Code session | **~150 k → ~45 k (~70 %)** on tool-output-heavy work |
| Discussion #2371 | Rust project ~17k LOC, 14 real commands, RTK v0.42.3 | **−65.7 %** average on those command outputs |
| `pi-rtk` sample bench | Fixed fixtures (git diff, find, ls, …) | Aggregate up to **~95 %** on large outputs; small commands much less |
| Community log analysis | Full Claude Code sessions | RTK only touches a *fraction* of input → **whole-session** savings often **single-digit to ~20 %**, not 80 % |

Example per-command variance (community):

| Command class | Typical measured savings |
|---------------|-------------------------:|
| Fat test logs / env dumps | 90–99 % |
| Large `git diff` / `find` | 75–95 % |
| `git status` / short `git log` | 10–50 % (sometimes near 0 or slight overhead) |

**Takeaway for RTK:** **60–90 % on noisy command outputs is real**. Blended into a full agent session, expect closer to **~5–25 % of total input**, depending on how much Bash you run.

---

## 3. Caveman — model *output* length

### 3.1 Official sample (10 prose-heavy tasks)

Source: Caveman README benchmark (chat-style / explanation tasks).

| Task (examples) | Normal out | Caveman out | Saved |
|-----------------|----------:|------------:|------:|
| Explain React re-render bug | 1 180 | 159 | 87 % |
| PostgreSQL connection pool setup | 2 347 | 380 | 84 % |
| git rebase vs merge | 702 | 292 | 58 % |
| Refactor callback → async/await | 387 | 301 | 22 % |
| **Average (10 tasks)** | **~1 214** | **~294** | **~65 %** |

Scope: **output tokens** on explanation-style prompts. Code blocks kept intact.

### 3.2 Independent measurements (coding agents)

| Source | Method | Result |
|--------|--------|--------|
| **JetBrains** (SkillsBench / Harbor) | 86 paired coding-agent tasks, Claude Code | Output savings **~8.5 %** (not 65 %) |
| Independent 5-model study | Chat + coding, local + Claude API | Chat output **~−31 %**; **65–75 % claim not reproduced**; total $ often flat |
| Coding-session writeups | Same task with/without skill | Output shorter; **total session tokens/cost often barely moved** (input dominates) |

**Takeaway for Caveman:**  
- Prose / chat answers: **~30–65 % fewer output tokens** is plausible.  
- Agentic coding: **~5–15 % on output**, small effect on **total** bill because tool inputs dominate.

---

## 4. Stack view — what to expect together

| Layer | Acts on | Realistic savings band |
|-------|---------|------------------------|
| **RTK** | Shell tool *outputs* | 60–90 % of those outputs; ~5–25 % of full session input |
| **Headroom** | Full request context (esp. tool results) | 15–45 % typical coding day; 40–80 % tool-heavy; peaks 60–95 % on pure JSON/logs |
| **Caveman** | Model *replies* | ~30–65 % of output prose; ~5–10 % of total session tokens in coding agents |

They stack without fighting each other (different stages of the pipeline).

**Combined order of magnitude (coding agent, tool-heavy day):**  
often **roughly 20–50 % less total tokens** vs naked agent — not a guaranteed 80 % across the board.

---

## 5. How *you* should compare (the only definitive bench)

Published numbers calibrate expectations. Your workload is the ground truth.

### Headroom
```bash
headroom wrap claude   # or wrap copilot
# then inspect:
#   ~/.headroom/logs/proxy.log
#   headroom_stats   (if MCP installed)
```
Look for lines like: `Pipeline complete: X → Y tokens (saved Z, P% reduction)`.

### RTK
```bash
rtk gain
rtk gain --daily
rtk gain --weekly
```

### Caveman
Run the **same** task twice (skill on vs off). Compare Claude usage / output length for that task only — not the marketing 65 % table.

### Fair A/B
1. Same repo, same prompt, same model.  
2. One run: no stack.  
3. One run: `headroom wrap` + RTK hooks + Caveman.  
4. Record: input tokens (or quota), wall time, whether the task still succeeds.

---

## 6. Primary sources (links)

| Tool | Primary references |
|------|--------------------|
| **Headroom** | https://headroom-docs.vercel.app/docs/benchmarks · README workload table · https://github.com/shreyassks/headroom-benchmarks |
| **RTK** | https://www.mintlify.com/rtk-ai/rtk/concepts/token-savings · https://github.com/rtk-ai/rtk · community discussion #2371 |
| **Caveman** | https://github.com/JuliusBrussee/caveman (README task table) · JetBrains SkillsBench write-up · independent multi-model discussions |

---

*Last curated for this repo: 2026-10-18. Upstream numbers move with releases — prefer the links above for the latest tables.*

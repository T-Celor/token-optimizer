#!/usr/bin/env python3
"""
Replay harness — baseline vs YOUR installed stack (RTK / Headroom / Caveman).

Published reference numbers: benchmark/REAL_WORLD.md

Re-run after ./install.sh so Headroom is available. Same fixtures/scenarios;
when headroom.compress() is importable, numbers use the real compressor.

Usage:
  python3 benchmark/run_benchmark.py
  python3 benchmark/run_benchmark.py --json
  python3 benchmark/run_benchmark.py --scenario debug_session
  python3 benchmark/run_benchmark.py --report benchmark/reports/my-stack.md
"""
from __future__ import annotations
import argparse, json, re, shutil, sys, time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent
FIXTURES = ROOT / "fixtures"

def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    try:
        import tiktoken
        return len(tiktoken.get_encoding("cl100k_base").encode(text))
    except Exception:
        return max(1, (len(text) + 3) // 4)

def estimate_messages_tokens(messages: list) -> int:
    total = 0
    for m in messages:
        content = m.get("content", "")
        if isinstance(content, list):
            parts = []
            for b in content:
                if isinstance(b, dict):
                    parts.append(str(b.get("text", b.get("content", b))))
                else:
                    parts.append(str(b))
            content = " ".join(parts)
        total += estimate_tokens(str(content))
        for tc in m.get("tool_calls") or []:
            total += estimate_tokens(json.dumps(tc, default=str))
    return total + len(messages) * 4

def headroom_available() -> bool:
    try:
        from headroom import compress  # noqa: F401
        return True
    except Exception:
        return False

def rtk_available() -> bool:
    return shutil.which("rtk") is not None

PROGRESS_RE = re.compile(
    r"(?i)(Downloading|Progress|eta\s|%\s*|building\.|Compiling|warning:\s*unused|"
    r"npm notice|████|node_modules/|debug trace payload|Start at\s+\d|Duration\s+\d|"
    r"##\[debug\]|npm timing)"
)
ANSI_RE = re.compile(r"\x1b\[[0-9;]*[a-zA-Z]")

def rtk_like_filter(text: str) -> str:
    text = ANSI_RE.sub("", text)
    lines, seen = [], {}
    for line in text.splitlines():
        s = line.rstrip()
        if not s.strip() or PROGRESS_RE.search(s):
            continue
        key = s.strip()
        if key in seen:
            seen[key] += 1
            continue
        seen[key] = 1
        lines.append(s)
    if len(lines) > 150:
        lines = lines[:90] + ["… (%d lines omitted) …" % (len(lines) - 115)] + lines[-25:]
    return "\n".join(lines)

def apply_rtk_to_messages(messages: list) -> list:
    out = []
    for m in messages:
        nm = dict(m)
        c = nm.get("content")
        if isinstance(c, str):
            nm["content"] = rtk_like_filter(c)
        elif isinstance(c, list):
            blocks = []
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    nb = dict(b)
                    nb["content"] = rtk_like_filter(str(b.get("content", "")))
                    blocks.append(nb)
                elif isinstance(b, dict) and "text" in b:
                    nb = dict(b)
                    nb["text"] = rtk_like_filter(str(b["text"]))
                    blocks.append(nb)
                else:
                    blocks.append(b)
            nm["content"] = blocks
        out.append(nm)
    return out

def local_compress_text(text: str) -> str:
    text = text.strip()
    if not text:
        return text
    if text[0] in "{[":
        try:
            data = json.loads(text)
            if isinstance(data, list) and len(data) > 6:
                return json.dumps({"_compressed": True, "count": len(data), "first": data[:2], "last": data[-1:]}, indent=2)
            if isinstance(data, dict) and isinstance(data.get("results"), list) and len(data["results"]) > 6:
                r = data["results"]
                return json.dumps({**{k: v for k, v in data.items() if k != "results"},
                                   "results_compressed": {"count": len(r), "first": r[:2], "last": r[-1:]}}, indent=2)
        except Exception:
            pass
    lines = text.splitlines()
    if len(lines) > 100:
        return "\n".join(lines[:55] + ["… (%d lines omitted) …" % (len(lines) - 75)] + lines[-20:])
    return text

def local_compress_messages(messages: list) -> list:
    out = []
    for m in messages:
        nm = dict(m)
        c = nm.get("content")
        if isinstance(c, str):
            nm["content"] = local_compress_text(c)
        elif isinstance(c, list):
            blocks = []
            for b in c:
                if isinstance(b, dict) and b.get("type") == "tool_result":
                    nb = dict(b)
                    nb["content"] = local_compress_text(str(b.get("content", "")))
                    blocks.append(nb)
                else:
                    blocks.append(b)
            nm["content"] = blocks
        out.append(nm)
    return out

def headroom_compress_messages(messages: list, model: str = "claude-sonnet-4-5-20250929"):
    try:
        from headroom import compress
        result = compress(messages, model=model)
        msgs = getattr(result, "messages", None) or messages
        meta = {
            "source": "headroom",
            "tokens_before": getattr(result, "tokens_before", None),
            "tokens_after": getattr(result, "tokens_after", None),
            "transforms": list(getattr(result, "transforms_applied", None) or []),
        }
        return msgs, meta
    except Exception as e:
        return local_compress_messages(messages), {"source": "local_fallback", "error": str(e)[:120]}

CAVEMAN_FILLER = re.compile(
    r"(?i)\b(sure|certainly|of course|absolutely|let me (explain|help)|"
    r"here('s| is)|basically|essentially|actually|really|just|"
    r"hope (this|that) helps|feel free to|please note)\b"
)
CAVEMAN_ARTICLES = re.compile(r"(?i)\b(a|an|the)\b")

def caveman_speak(text: str) -> str:
    fences = []
    def save_f(m):
        fences.append(m.group(0))
        return "\x00F%d\x00" % (len(fences) - 1)
    t = re.sub(r"```[\s\S]*?```", save_f, text)
    lines = []
    for line in t.splitlines():
        s = CAVEMAN_ARTICLES.sub("", CAVEMAN_FILLER.sub("", line))
        s = re.sub(r"[ \t]{2,}", " ", s).strip(" ,;")
        if s.strip():
            lines.append(s)
    result = "\n".join(lines)
    for i, b in enumerate(fences):
        result = result.replace("\x00F%d\x00" % i, b)
    return result

SAMPLE_ASSISTANT = (
    "Sure! I'd be happy to help. Essentially the refund path does not check "
    "whether the payment was already refunded. Here's what I recommend:\n\n"
    "```typescript\nif (payment.status === 'refunded') {\n"
    "  return res.status(500).json({ error: 'already refunded' });\n}\n```\n\n"
    "Hope this helps! Let me know if you want tests updated as well."
)

def caveman_keep_ratio() -> float:
    before = estimate_tokens(SAMPLE_ASSISTANT)
    after = estimate_tokens(caveman_speak(SAMPLE_ASSISTANT))
    if before <= 0:
        return 0.45
    return max(0.30, min(0.75, after / before))

def estimate_output_tokens(input_tokens: int, workload: str) -> int:
    ratios = {"debug": 0.22, "refactor": 0.28, "explore": 0.18, "ci": 0.15, "mixed": 0.22}
    return max(40, int(input_tokens * ratios.get(workload, 0.22)))

def load_fixture(name: str) -> str:
    for ext in (".txt", ".json", ".log", ".diff"):
        p = FIXTURES / (name + ext)
        if p.exists():
            return p.read_text(encoding="utf-8", errors="replace")
    return ""

def msg(role, content, **extra):
    d = {"role": role, "content": content}
    d.update(extra)
    return d

def scenario_debug_session():
    return [
        msg("system", "You are a senior TypeScript engineer. Prefer minimal diffs."),
        msg("user", "CI is red. payments refund test fails. Investigate and fix."),
        msg("assistant", "Reproducing the failure.", tool_calls=[
            {"id": "c1", "type": "function", "function": {"name": "Bash", "arguments": '{"command":"npm test -- payments"}'}}
        ]),
        msg("user", [{"type": "tool_result", "tool_use_id": "c1", "content": load_fixture("test_log")}]),
        msg("assistant", "Reading implementation.", tool_calls=[
            {"id": "c2", "type": "function", "function": {"name": "Read", "arguments": '{"path":"src/services/PaymentService.ts"}'}}
        ]),
        msg("user", [{"type": "tool_result", "tool_use_id": "c2", "content": load_fixture("git_diff")[:4000]}]),
        msg("user", "Full CI log:"),
        msg("user", load_fixture("ci_log")),
    ]

def scenario_refactor_session():
    return [
        msg("system", "Careful refactoring assistant."),
        msg("user", "Migrate session helpers to async. Review the diff."),
        msg("assistant", "Inspecting tree.", tool_calls=[
            {"id": "c1", "type": "function", "function": {"name": "Bash", "arguments": '{"command":"git status && git diff"}'}}
        ]),
        msg("user", [{"type": "tool_result", "tool_use_id": "c1", "content": load_fixture("git_diff")}]),
        msg("user", "Related search hits:"),
        msg("user", load_fixture("search_json")),
    ]

def scenario_explore_codebase():
    return [
        msg("system", "Help navigate large codebases."),
        msg("user", "Where is Redis session creation implemented?"),
        msg("assistant", "Searching.", tool_calls=[
            {"id": "c1", "type": "function", "function": {"name": "Grep", "arguments": '{"pattern":"createSession"}'}},
            {"id": "c2", "type": "function", "function": {"name": "SemanticSearch", "arguments": '{"query":"redis session auth"}'}},
        ]),
        msg("user", [
            {"type": "tool_result", "tool_use_id": "c1", "content": load_fixture("search_json")},
            {"type": "tool_result", "tool_use_id": "c2", "content": load_fixture("search_json")},
        ]),
    ]

def scenario_ci_failure():
    return [
        msg("system", "Diagnose CI failures."),
        msg("user", "GitHub Actions failed. Full log:"),
        msg("user", load_fixture("ci_log")),
        msg("assistant", "Re-running locally.", tool_calls=[
            {"id": "c1", "type": "function", "function": {"name": "Bash", "arguments": '{"command":"npm test 2>&1"}'}}
        ]),
        msg("user", [{"type": "tool_result", "tool_use_id": "c1", "content": load_fixture("test_log")}]),
    ]

def scenario_mixed_day():
    parts = []
    for builder in (scenario_debug_session, scenario_explore_codebase, scenario_refactor_session):
        turns = builder()
        if not parts:
            parts.append(turns[0])
        parts.extend(turns[1:5])
    return parts

SCENARIOS = {
    "debug_session": scenario_debug_session,
    "refactor_session": scenario_refactor_session,
    "explore_codebase": scenario_explore_codebase,
    "ci_failure": scenario_ci_failure,
    "mixed_day": scenario_mixed_day,
}

@dataclass
class Result:
    name: str
    input_tokens: int
    output_tokens_est: int
    total_tokens_est: int
    source: str
    detail: dict = field(default_factory=dict)

def run_scenario(name, messages, workload):
    cav_ratio = caveman_keep_ratio()
    results = {}
    base_in = estimate_messages_tokens(messages)
    base_out = estimate_output_tokens(base_in, workload)
    results["baseline"] = Result("baseline", base_in, base_out, base_in + base_out, "raw")

    rtk_msgs = apply_rtk_to_messages(messages)
    rtk_in = estimate_messages_tokens(rtk_msgs)
    rtk_out = estimate_output_tokens(rtk_in, workload)
    results["rtk_only"] = Result(
        "rtk_only", rtk_in, rtk_out, rtk_in + rtk_out,
        "rtk_like" + ("+binary_present" if rtk_available() else ""),
    )

    hr_msgs, hr_meta = headroom_compress_messages(messages)
    hr_in = int(hr_meta["tokens_after"]) if hr_meta.get("tokens_after") is not None else estimate_messages_tokens(hr_msgs)
    hr_out = estimate_output_tokens(hr_in, workload)
    results["headroom_only"] = Result("headroom_only", hr_in, hr_out, hr_in + hr_out, hr_meta.get("source", "?"), hr_meta)

    stacked, st_meta = headroom_compress_messages(rtk_msgs)
    full_in = int(st_meta["tokens_after"]) if st_meta.get("tokens_after") is not None else estimate_messages_tokens(stacked)
    full_out = estimate_output_tokens(full_in, workload)
    results["full_stack"] = Result("full_stack", full_in, full_out, full_in + full_out, st_meta.get("source", "?"), st_meta)

    cav_out = max(20, int(full_out * cav_ratio))
    results["full_stack+caveman"] = Result(
        "full_stack+caveman", full_in, cav_out, full_in + cav_out,
        st_meta.get("source", "?"), {**st_meta, "caveman_keep_ratio": round(cav_ratio, 3)},
    )
    return results

def pct(before, after):
    if before <= 0:
        return 0.0
    return round(100.0 * (before - after) / before, 1)

def main():
    parser = argparse.ArgumentParser(description="Replay benchmark: baseline vs your stack")
    parser.add_argument("--scenario", choices=list(SCENARIOS) + ["all"], default="all")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--report", type=Path, default=None)
    args = parser.parse_args()

    hr, rtk = headroom_available(), rtk_available()
    tok = "tiktoken/cl100k_base" if "tiktoken" in sys.modules else "chars/4 heuristic"
    names = list(SCENARIOS) if args.scenario == "all" else [args.scenario]
    all_results = {}
    t0 = time.time()
    for name in names:
        workload = "mixed" if name == "mixed_day" else name.split("_")[0]
        all_results[name] = run_scenario(name, SCENARIOS[name](), workload)
    elapsed = round(time.time() - t0, 2)
    meta = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "headroom_installed": hr,
        "rtk_on_path": rtk,
        "tokenizer": tok,
        "elapsed_sec": elapsed,
        "note": "Published reference: benchmark/REAL_WORLD.md",
    }

    if args.json:
        print(json.dumps({"meta": meta, "results": {s: {k: asdict(v) for k, v in r.items()} for s, r in all_results.items()}}, indent=2))
        return 0

    print()
    print("=" * 78)
    print("  REPLAY BENCHMARK — baseline vs your stack")
    print("=" * 78)
    print("  Headroom (real compress) : %s" % ("YES" if hr else "NO  → pip install \"headroom-ai[proxy]\" then re-run"))
    print("  RTK on PATH              : %s" % ("YES" if rtk else "NO  (rtk-like filter still applied in this harness)"))
    print("  Tokenizer                : %s" % tok)
    print("  Reference tables         : benchmark/REAL_WORLD.md")
    print()

    for name, results in all_results.items():
        base = results["baseline"]
        print("┌─ %s  (baseline input=%s)" % (name, f"{base.input_tokens:,}"))
        print("│ %-22s %9s %8s %9s %7s %7s  src" % ("pipeline", "input", "out≈", "total≈", "in%", "tot%"))
        print("├" + "─" * 76)
        for key in ("baseline", "rtk_only", "headroom_only", "full_stack", "full_stack+caveman"):
            r = results[key]
            print(
                "│ %-22s %9s %8s %9s %6.1f%% %6.1f%%  %s"
                % (
                    r.name,
                    f"{r.input_tokens:,}",
                    f"{r.output_tokens_est:,}",
                    f"{r.total_tokens_est:,}",
                    pct(base.input_tokens, r.input_tokens),
                    pct(base.total_tokens_est, r.total_tokens_est),
                    r.source,
                )
            )
        print("└" + "─" * 76)
        print()

    sum_base = sum(r["baseline"].total_tokens_est for r in all_results.values())
    sum_full = sum(r["full_stack"].total_tokens_est for r in all_results.values())
    sum_cav = sum(r["full_stack+caveman"].total_tokens_est for r in all_results.values())
    sum_bin = sum(r["baseline"].input_tokens for r in all_results.values())
    sum_fin = sum(r["full_stack"].input_tokens for r in all_results.values())
    print("=" * 78)
    print("  GRAND TOTAL")
    print("  Baseline total≈          %10s" % f"{sum_base:,}")
    print("  Full stack total≈        %10s   (%s%% saved)" % (f"{sum_full:,}", pct(sum_base, sum_full)))
    print("  Full stack + Caveman≈    %10s   (%s%% saved)" % (f"{sum_cav:,}", pct(sum_base, sum_cav)))
    print("  Input only               %s → %s  (%s%% input saved)" % (f"{sum_bin:,}", f"{sum_fin:,}", pct(sum_bin, sum_fin)))
    print("=" * 78)
    if not hr:
        print()
        print("  Install Headroom, re-run the SAME command to measure your real stack:")
        print('    pip install "headroom-ai[proxy]"')
        print("    python3 benchmark/run_benchmark.py")
    print()

    report_path = args.report or (ROOT / "reports" / "latest.md")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Replay benchmark report",
        "",
        f"- When: `{meta['timestamp']}`",
        f"- Headroom installed: **{hr}**",
        f"- RTK on PATH: **{rtk}**",
        f"- Tokenizer: `{tok}`",
        "",
        "Compare with [REAL_WORLD.md](../REAL_WORLD.md).",
        "",
        "| Scenario | Baseline | Full stack | + Caveman | Input save | Total save |",
        "|----------|---------:|-----------:|----------:|-----------:|-----------:|",
    ]
    for name, results in all_results.items():
        b, f, c = results["baseline"], results["full_stack"], results["full_stack+caveman"]
        lines.append(
            "| `%s` | %s | %s | %s | %s%% | %s%% |"
            % (name, f"{b.total_tokens_est:,}", f"{f.total_tokens_est:,}", f"{c.total_tokens_est:,}",
               pct(b.input_tokens, f.input_tokens), pct(b.total_tokens_est, c.total_tokens_est))
        )
    lines += ["", "**All:** baseline %s → full+caveman %s (%s%% saved)." % (f"{sum_base:,}", f"{sum_cav:,}", pct(sum_base, sum_cav)), ""]
    report_path.write_text("\n".join(lines), encoding="utf-8")
    print("  Report: %s" % report_path)
    print()
    return 0

if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env node
// Work-session benchmark: one realistic Claude Code session per arm, with a series of requests
// in a row on the same repository. Two scenarios (--scenario):
//   workday  seven requests (get oriented, find why CI is red, fix it, investigate a 503 in
//            the logs, dig through git history, add a regression test, write the PR description)
//   long     eighteen requests: the seven workday ones, then more work on the same repository,
//            some of them recall steps (answered from memory, without tools). Long sessions
//            auto-compact, which the report counts.
//   xl       twenty-nine requests: the long ones without their recalls, then a full read of six
//            large legacy modules (~120k tokens), a cross-file question, and seven recalls. Built
//            to approach the context limit, so most of its context is code that must be read.
// Prompts don't name commands, so the agent picks its own tools, and context grows from
// request to request as in real work.
//
// Arms are combinations of the stack's tools (see harness.mjs), so the report shows what each
// tool adds or saves on its own and in combination. Sessions run on the logged-in Claude
// account (no API key).
//
// Usage:
//   node run_session.mjs [--scenario workday|long|xl] [--arms SPEC]     # preflight only, no model calls
//   node run_session.mjs --live [--scenario workday|long|xl] [--arms SPEC] [--repeat N] [--model ID] [--add-to FILE]
//   node run_session.mjs --report-from FILE[,FILE...] [--out REPORT]
//
//   --scenario          workday (default), long or xl. Sessions of different scenarios are never merged
//   --add-to FILE       merge this run into an earlier one: FILE is that run's
//                       session-results.json (or combined-results.json). The report covers both;
//                       sessions of an arm present in both runs are pooled
//   --report-from       rebuild a report from saved results, merging several files if given;
//                       no model calls. Writes reports/session-latest.md (session-long-latest.md
//                       for the long scenario) unless --out is given
//
// SPEC is a comma-separated list of arms and/or presets:
//   default          baseline, rtk+ponytail+headroom (what install.sh installs by default)
//   ablation         baseline, rtk+caveman+ponytail, rtk+caveman+ponytail+crg, full
//   headroom-combos  rtk+headroom, rtk+caveman+headroom, rtk+ponytail+headroom,
//                    rtk+caveman+ponytail+headroom
//   pxpipe-combos    the same with pxpipe after Headroom: rtk+headroom+pxpipe,
//                    rtk+caveman+headroom+pxpipe, rtk+ponytail+headroom+pxpipe
//                    (with Caveman and Ponytail both, that is full-no-crg)
//   pxpipe-first     pxpipe before Headroom: pxpipe+headroom, rtk+pxpipe+headroom
//   headroom-rerun   the arms with Headroom, to measure with proxy setup 3
//   best             baseline and the best arms so far, with and without pxpipe after
//                    Headroom: run with --repeat to confirm the ranking
//   confirm          baseline, headroom, rtk, rtk+headroom, rtk+caveman+ponytail+headroom
//   long             baseline, rtk+ponytail+headroom, the same with pxpipe after Headroom, and
//                    with the router at 50k and 90k tokens: meant for --scenario long
//   router           rtk+ponytail+headroom, and the router at 50k and 90k tokens
//   all              every arm defined in harness.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, readFileSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { buildRepo, answerOf, WORKDAY_STEPS, LONG_STEPS, XL_STEPS } from "./fixture_repo.mjs";
import {
  ROOT, COMPARISONS, PROXY_SETUP, SETUP_NOTES, setupLabel, baseArm, setupOf, outdated, componentsOf, resolveArms, preflight,
  buildArms, startProxies, stopProxies, prepareSession, warmUp, sessionOptions, checkSetup, usageTotals,
  minus, ZERO, totalTokens, pct, yes, newRunDir, proxyEvidence, evidenceSection, cliValue,
} from "./harness.mjs";

const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const MODEL = cliValue(args, "--model", "claude-opus-5-5");
const REPEAT = Number(cliValue(args, "--repeat", "1"));
const ARM_NAMES = resolveArms(cliValue(args, "--arms", "default"));

// Each scenario: its steps and the report it writes by default.
const SCENARIOS = {
  workday: { steps: WORKDAY_STEPS, build: { workday: true }, report: "session-latest.md" },
  long: { steps: LONG_STEPS, build: { workday: true, long: true }, report: "session-long-latest.md" },
  xl: { steps: XL_STEPS, build: { workday: true, long: true, xl: true }, report: "session-xl-latest.md" },
};
const SCENARIO = cliValue(args, "--scenario", "workday");
if (!SCENARIOS[SCENARIO]) {
  console.error(`--scenario: unknown scenario "${SCENARIO}". Scenarios: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}
const STEPS = SCENARIOS[SCENARIO].steps;
// maxTurns is set on the query(), which covers the whole session (all requests), not one request.
// The budget that works for the workday scenario (30 turns for 7 requests) is scaled to the
// number of requests, so a long session of 18 requests is not cut off earlier per request.
const MAX_TURNS = Math.ceil((30 / WORKDAY_STEPS.length) * STEPS.length);

// Runs all steps in one session (streaming input: the next request is sent when the
// previous one has finished) and grades each step right after it.
async function runWorkSession(arm, cwd, expected, extra) {
  const t0 = Date.now();
  // Steps whose result has arrived. Counting (rather than one pending promise) stays correct
  // whether a result arrives before or after the generator starts waiting.
  let finished = 0;
  let wake = null;
  async function* requests() {
    for (const [i, step] of STEPS.entries()) {
      yield { type: "user", message: { role: "user", content: step.prompt }, parent_tool_use_id: null };
      while (finished <= i) await new Promise((resolve) => (wake = resolve));
    }
  }

  const steps = [];
  const tools = {};
  const contextByRequest = new Map();
  let compactions = 0;
  let stepToolCalls = 0;
  let previous = ZERO;
  for await (const m of query({ prompt: requests(), options: sessionOptions(arm, { cwd, model: MODEL, maxTurns: MAX_TURNS }, extra) })) {
    if (m.type === "system" && m.subtype === "init") checkSetup(arm, m, extra);
    if (m.type === "system" && m.subtype === "compact_boundary") compactions++;
    if (m.type === "assistant" && !m.parent_tool_use_id) {
      // Context size of each API request = everything sent as input. Streamed frames of one
      // request share its id, so keep the largest value per id.
      const u = m.message.usage;
      if (u) {
        const ctx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        contextByRequest.set(m.message.id, Math.max(ctx, contextByRequest.get(m.message.id) ?? 0));
      }
      for (const block of m.message.content ?? []) {
        if (block.type === "tool_use") {
          tools[block.name] = (tools[block.name] ?? 0) + 1;
          stepToolCalls++;
        }
      }
    }
    if (m.type === "result") {
      const step = STEPS[steps.length];
      // modelUsage and total_cost_usd are running totals; the step's share is the difference.
      const cumulative = usageTotals(m);
      steps.push({
        name: step.name,
        ...minus(cumulative, previous),
        toolCalls: stepToolCalls,
        subtype: m.subtype,
        answer: answerOf(m.result ?? ""),
        correct: step.check ? step.check(m.result ?? "", expected, cwd) : null,
      });
      stepToolCalls = 0;
      previous = cumulative;
      const s = steps.at(-1);
      console.log(`  ${arm.name} ${step.name}: ${totalTokens(s)} tok, $${s.cost.toFixed(4)}${step.check ? `, correct: ${yes(s.correct)}` : ""}`);
      finished++;
      wake?.();
      wake = null;
    }
  }
  if (steps.length !== STEPS.length) throw new Error(`${arm.name}: session ended after ${steps.length} of ${STEPS.length} steps`);
  return {
    steps,
    totals: previous,
    peakContext: Math.max(0, ...contextByRequest.values()),
    requests: contextByRequest.size,
    tools,
    compactions,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

const gradedCount = (steps) => steps.filter((s) => s.check).length;
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Averages over an arm's sessions. `steps` are the scenario's steps.
function summarize(sessions, steps) {
  const field = (f) => avg(sessions.map(f));
  const tools = {};
  for (const s of sessions) for (const [k, v] of Object.entries(s.tools)) tools[k] = (tools[k] ?? 0) + v / sessions.length;
  const recall = steps.map((s) => !!s.recall);
  return {
    cost: field((s) => s.totals.cost),
    tokens: field((s) => totalTokens(s.totals)),
    uncached: field((s) => s.totals.uncached),
    cacheWrite: field((s) => s.totals.cacheWrite),
    cacheRead: field((s) => s.totals.cacheRead),
    output: field((s) => s.totals.output),
    peak: field((s) => s.peakContext),
    requests: field((s) => s.requests),
    compactions: field((s) => s.compactions ?? 0),
    recallToolCalls: field((s) => s.steps.reduce((n, x, k) => n + (recall[k] ? (x.toolCalls ?? 0) : 0), 0)),
    startup: field((s) => s.warmup.cost),
    correct: sessions.reduce((n, s) => n + s.steps.filter((x) => x.correct).length, 0),
    graded: gradedCount(steps) * sessions.length,
    tools,
    stepCost: steps.map((_, k) => avg(sessions.map((s) => s.steps[k].cost))),
  };
}

const round = (x) => Math.round(x);
const toolSummary = (tools) =>
  Object.entries(tools)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k.replace(/^mcp__code-review-graph__/, "crg:")} ${Math.round(v * 10) / 10}`)
    .join(", ");

// A saved run: session-results.json (one run) or combined-results.json (merged runs). Runs saved
// before scenarios existed are workday runs.
function loadRun(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  const scenario = data.scenario ?? "workday";
  if (!SCENARIOS[scenario]) throw new Error(`${file}: unknown scenario "${scenario}"`);
  return { evidence: {}, failures: {}, ...data, scenario, sources: data.sources ?? [dirname(file)] };
}

// Combines saved runs (also used on a single run, to label it). Sessions of the same arm are
// pooled; a failure is kept only for arms with no session at all; proxy evidence comes from
// the latest run that has it. Runs with different models or scenarios are not comparable and
// are refused.
// Arms measured with a setup under which they were configured differently than now (see
// PROXY_SETUP in harness.mjs) are named "<arm> [proxy setup N]", so they are never pooled
// with current sessions; the others take the plain name and are pooled. A name that already
// carries a label (from a merged file) is re-evaluated with its own setup, and a merged
// file's plain names are of the setup it records, so merged files can be merged again.
function mergeRuns(runs) {
  const merged = { model: runs[0].model, scenario: runs[0].scenario, results: {}, failures: {}, evidence: {}, sources: [], proxySetup: PROXY_SETUP };
  for (const run of runs) {
    if (run.model !== merged.model) throw new Error(`cannot combine runs of different models (${merged.model}, ${run.model})`);
    if (run.scenario !== merged.scenario) throw new Error(`cannot combine runs of different scenarios (${merged.scenario}, ${run.scenario})`);
    const label = (arm) => {
      const base = baseArm(arm);
      const setup = arm === base ? (run.proxySetup ?? 1) : setupOf(arm);
      return outdated(base, setup) ? base + setupLabel(setup) : base;
    };
    for (const [arm, sessions] of Object.entries(run.results ?? {})) {
      if (sessions.length) merged.results[label(arm)] = [...(merged.results[label(arm)] ?? []), ...sessions];
    }
    for (const [arm, ev] of Object.entries(run.evidence ?? {})) if (ev) merged.evidence[label(arm)] = ev;
    for (const [arm, msg] of Object.entries(run.failures ?? {})) merged.failures[label(arm)] = msg;
    merged.sources.push(...run.sources);
  }
  for (const arm of Object.keys(merged.failures)) if (merged.results[arm]?.length) delete merged.failures[arm];
  return merged;
}

function report({ model, scenario, results, failures, evidence, sources }) {
  const steps = SCENARIOS[scenario].steps;
  const done = Object.keys(results).filter((n) => results[n]?.length);
  const sessionsPerArm = Math.max(0, ...done.map((n) => results[n].length));
  const sum = Object.fromEntries(done.map((n) => [n, summarize(results[n], steps)]));
  const ref = done.includes("baseline") ? "baseline" : done[0];
  const r = sum[ref];
  const graded = gradedCount(steps);
  const showCompactions = scenario !== "workday";
  const lines = [
    "# Work-session benchmark: tool combinations",
    "",
    `- When: ${new Date().toISOString()}`,
    `- Scenario: ${scenario} (${steps.length} requests per session)`,
    `- Model: ${model}; ${sessionsPerArm} session(s) per arm, ${steps.length} requests each (${steps.map((s) => s.name).join(", ")})`,
    "- Every arm: none of your settings, CLAUDE.md, plugins or MCP servers; same model, tools and Claude Code system prompt; then only the arm's components (see harness.mjs)",
    "- Tokens = uncached input + cache writes + cache reads + output, over every model call. Cost is the SDK's `total_cost_usd` estimate (on a claude.ai plan this is usage, not a bill)",
    "- Each measured session follows a one-request warm-up with the same setup, not counted, so every arm is measured with its fixed prompt already cached whatever order the arms ran in. Startup $ is that warm-up: add it for a first session with a cold cache",
    `- Correct = ${graded} graded steps per session${scenario === "workday" ? ": failing test file, suite green after the fix, exact request_id, exact commit hash, regression test added and suite green" : " (checks in fixture_repo.mjs)"}`,
    "- Peak context = the largest single request sent to the model; it decides how soon a session hits the context limit",
    "- Single sessions vary from run to run: treat differences of a few percent as noise. `--repeat N` averages N sessions per arm",
    ...(done.some((n) => n !== baseArm(n))
      ? [
          `- Proxy setups (unmarked arms use setup ${PROXY_SETUP}; marked ones were measured with an earlier setup that changed for them):`,
          ...Object.entries(SETUP_NOTES).map(([v, note]) => `  - ${Number(v) === PROXY_SETUP ? `${v} (current)` : `\`${setupLabel(Number(v)).trim()}\``}: ${note}`),
        ]
      : []),
    sources.length > 1
      ? `- Combines ${sources.length} runs (sessions of an arm present in several runs are pooled). Logs: ${sources.join(", ")}`
      : `- Logs: ${sources[0]}`,
    "",
    `## Arms (cheapest first, compared with ${ref})`,
    "",
    `| Arm | Components | Cost $ | vs ref | Tokens | vs ref | Peak ctx | vs ref | Startup $ | Correct |${showCompactions ? " Compactions |" : ""}`,
    `|---|---|---:|---:|---:|---:|---:|---:|---:|:-:|${showCompactions ? "---:|" : ""}`,
  ];
  for (const n of [...done].sort((a, b) => sum[a].cost - sum[b].cost)) {
    const s = sum[n];
    const label = n === ref ? `**${n}**` : n;
    lines.push(`| ${label} | ${componentsOf(n).join(", ") || "none"} | ${s.cost.toFixed(4)} | ${pct(r.cost, s.cost)} | ${round(s.tokens)} | ${pct(r.tokens, s.tokens)} | ${round(s.peak)} | ${pct(r.peak, s.peak)} | ${s.startup.toFixed(4)} | ${s.correct}/${s.graded} |${showCompactions ? ` ${s.compactions.toFixed(1)} |` : ""}`);
  }

  // An arm's most recent setup is preferred for comparisons.
  const pick = (n) => done.filter((d) => baseArm(d) === n).sort((a, b) => setupOf(b) - setupOf(a))[0] ?? null;
  const comparisons = COMPARISONS.map(([q, a, b]) => [q, pick(a), pick(b)]).filter(([, a, b]) => a && b);
  // An arm measured with several setups: each older one against the most recent.
  for (const n of done) {
    const latest = pick(baseArm(n));
    if (n !== latest) comparisons.push([`Proxy setup ${setupOf(n)} → ${setupOf(latest)} for ${baseArm(n)}`, n, latest]);
  }
  if (comparisons.length) {
    lines.push("", "## What each tool or group does", "", "Change from the first arm to the second.", "", "| Question | From → to | Cost | Tokens | Peak ctx | Correct |", "|---|---|---:|---:|---:|:-:|");
    for (const [question, a, b] of comparisons) {
      const x = sum[a];
      const y = sum[b];
      lines.push(`| ${question} | ${a} → ${b} | ${pct(x.cost, y.cost)} | ${pct(x.tokens, y.tokens)} | ${pct(x.peak, y.peak)} | ${x.correct}/${x.graded} → ${y.correct}/${y.graded} |`);
    }
  }

  lines.push("", "## Token mix (average per session)", "", "| Arm | Uncached in | Cache write | Cache read | Output | Requests | Tools used |", "|---|---:|---:|---:|---:|---:|---|");
  for (const n of done) {
    const s = sum[n];
    lines.push(`| ${n} | ${round(s.uncached)} | ${round(s.cacheWrite)} | ${round(s.cacheRead)} | ${round(s.output)} | ${round(s.requests)} | ${toolSummary(s.tools)} |`);
  }

  // A recall step should be answered from memory: any tool call during one is a re-read.
  if (steps.some((s) => s.recall)) {
    const recallNames = steps.filter((s) => s.recall).map((s) => s.name).join(", ");
    lines.push("", "## Tool calls during recall steps", "", `Recall steps (answered from memory, no tools expected): ${recallNames}. Average tool calls per session during those steps; above 0 means the agent re-read instead of remembering.`, "", "| Arm | Tool calls during recall steps |", "|---|---:|");
    for (const n of done) lines.push(`| ${n} | ${sum[n].recallToolCalls.toFixed(1)} |`);
  }

  lines.push("", "## Cost per step ($, average)", "", `| Step | ${done.join(" | ")} |`, `|---|${done.map(() => "---:").join("|")}|`);
  for (const [k, step] of steps.entries()) {
    lines.push(`| ${step.name} | ${done.map((n) => sum[n].stepCost[k].toFixed(4)).join(" | ")} |`);
  }

  lines.push("", "## Answers", "", `| Arm | Session | ${steps.filter((s) => s.check).map((s) => s.name).join(" | ")} |`, `|---|---|${steps.filter((s) => s.check).map(() => ":-:").join("|")}|`);
  for (const n of done) {
    for (const [i, session] of results[n].entries()) {
      const cells = session.steps.filter((x) => x.correct !== null).map((x) => `${yes(x.correct)}${x.answer ? ` \`${x.answer}\`` : ""}${x.subtype !== "success" ? ` (${x.subtype})` : ""}`);
      lines.push(`| ${n} | #${i + 1} | ${cells.join(" | ")} |`);
    }
  }

  if (Object.keys(failures).length) {
    lines.push("", "## Failed arms", "", ...Object.entries(failures).map(([n, msg]) => `- ${n}: ${msg}`));
  }
  lines.push("", ...evidenceSection(evidence));
  return lines.join("\n");
}

async function main() {
  const from = cliValue(args, "--report-from", null);
  if (from) {
    const merged = mergeRuns(from.split(",").map(loadRun));
    const out = cliValue(args, "--out", join(ROOT, "reports", SCENARIOS[merged.scenario].report));
    writeFileSync(out, report(merged));
    console.log(`Report: ${out}`);
    return;
  }

  // Read the earlier run first, so a wrong path, model or scenario fails before any session runs.
  const addTo = cliValue(args, "--add-to", null);
  const earlier = addTo ? loadRun(addTo) : null;
  if (earlier && earlier.model !== MODEL) {
    console.error(`--add-to: that run used ${earlier.model}, this one would use ${MODEL}; results are not comparable.`);
    process.exit(1);
  }
  if (earlier && earlier.scenario !== SCENARIO) {
    console.error(`--add-to: that run is the ${earlier.scenario} scenario, this one is ${SCENARIO}; sessions of different scenarios are not merged.`);
    process.exit(1);
  }

  const pre = await preflight(ARM_NAMES);
  const sessions = ARM_NAMES.length * REPEAT;
  if (!LIVE) {
    // The long scenario has not been measured yet: its estimate is the workday one times 3 to 5.
    const cost = SCENARIO === "long"
      ? `Rough cost: not measured yet for the long scenario; expect roughly 3-5x a workday session, about $${(sessions * 0.45 * 3).toFixed(0)}–${(sessions * 0.9 * 5).toFixed(0)} of usage.`
      : `Rough cost from earlier runs: $${(sessions * 0.45).toFixed(0)}–${(sessions * 0.9).toFixed(0)} of usage.`;
    console.log(pre.ready
      ? `\nReady. --live runs ${sessions} session(s) of ${STEPS.length} requests (scenario: ${SCENARIO}; arms: ${ARM_NAMES.join(", ")}), each after a one-request warm-up.\n${cost}`
      : "\nNot ready. Fix the failed checks first.");
    return;
  }
  if (!pre.ready) {
    console.error("Refusing to run --live: fix the failed preflight checks first.");
    process.exit(1);
  }

  const arms = buildArms(ARM_NAMES, pre);
  const runDir = newRunDir();
  const template = mkdtempSync(join(tmpdir(), "session-repo-"));
  const expected = buildRepo(template, SCENARIOS[SCENARIO].build);
  const results = {};
  const failures = {};
  const evidence = {};
  // Saved after every arm, so a crash later keeps what was measured. A report bug must not
  // end the run: the results files are enough to rebuild it with --report-from.
  // session-results.json holds this run only; with --add-to, combined-results.json holds the
  // merge with the earlier run, and the report covers the merge.
  const save = () => {
    const current = { model: MODEL, scenario: SCENARIO, expected, results, failures, evidence, sources: [runDir], proxySetup: PROXY_SETUP };
    writeFileSync(join(runDir, "session-results.json"), JSON.stringify(current, null, 2));
    const data = mergeRuns(earlier ? [earlier, current] : [current]);
    if (earlier) writeFileSync(join(runDir, "combined-results.json"), JSON.stringify(data, null, 2));
    try {
      const md = report(data);
      writeFileSync(join(runDir, "report.md"), md);
      writeFileSync(join(ROOT, "reports", SCENARIOS[SCENARIO].report), md);
    } catch (e) {
      console.error(`  report failed (${e.message}); rebuild it with --report-from ${join(runDir, earlier ? "combined-results.json" : "session-results.json")}`);
    }
  };

  // One arm after the other, so only one arm's proxies run at a time. A failing arm is
  // recorded and the run goes on with the next one.
  for (const arm of arms) {
    console.log(`\nArm ${arm.name} (${arm.components.join(", ") || "no tools"}):`);
    results[arm.name] = [];
    try {
      startProxies(arm, runDir);
      for (let run = 0; run < REPEAT; run++) {
        const cwd = mkdtempSync(join(tmpdir(), `session-${arm.name.replace(/\W/g, "_")}-`));
        cpSync(template, cwd, { recursive: true });
        const extra = prepareSession(arm, cwd);
        const warmup = await warmUp(arm, cwd, extra, MODEL);
        const session = await runWorkSession(arm, cwd, expected, extra);
        session.warmup = warmup;
        results[arm.name].push(session);
        const correct = session.steps.filter((x) => x.correct).length;
        console.log(`  → ${totalTokens(session.totals)} tok, $${session.totals.cost.toFixed(4)}, peak ctx ${session.peakContext}, ${correct}/${gradedCount(STEPS)} correct`);
      }
      evidence[arm.name] = await proxyEvidence(arm);
    } catch (e) {
      failures[arm.name] = String(e.message ?? e).split("\n")[0];
      console.error(`  ${arm.name} failed: ${failures[arm.name]}`);
    } finally {
      stopProxies(arm);
    }
    save();
  }
  console.log(`\nReport: ${join(ROOT, "reports", SCENARIOS[SCENARIO].report)}${earlier ? ` (merged with ${earlier.sources.join(", ")})` : ""}`);
  if (Object.keys(failures).length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
// Quick benchmark: one question per session, for each arm (combination of the stack's tools,
// see harness.mjs). For a realistic multi-request work session, see run_session.mjs.
// Sessions run on the logged-in Claude account (no API key).
//
// Usage:
//   node run_ab.mjs [--arms SPEC]                    # preflight only, no model calls
//   node run_ab.mjs --smoke [--arms SPEC]            # one tiny session per arm: login through
//                                                    # the proxies works, plugins load
//   node run_ab.mjs --live [--arms SPEC] [--scenario NAME] [--repeat N] [--model ID]
//
// SPEC is a comma-separated list of arms and/or presets (see run_session.mjs); default is
// baseline,rtk+ponytail+headroom, what install.sh installs by default.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { writeFileSync, mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo, answerOf, SCENARIOS } from "./fixture_repo.mjs";
import {
  ROOT, ARMS, resolveArms, preflight, buildArms, startProxies, stopProxies, prepareSession, warmUp,
  sessionOptions, checkSetup, usageTotals, totalTokens, pct, yes, newRunDir, proxyEvidence, evidenceSection,
  cliValue,
} from "./harness.mjs";

const args = process.argv.slice(2);
const MODE = args.includes("--live") ? "live" : args.includes("--smoke") ? "smoke" : "preflight";
const MODEL = cliValue(args, "--model", "claude-opus-5-5");
const REPEAT = Number(cliValue(args, "--repeat", "1"));
const ONLY = cliValue(args, "--scenario", null);
const ARM_NAMES = resolveArms(cliValue(args, "--arms", "default"));

async function runSession(prompt, arm, cwd, extra) {
  const t0 = Date.now();
  let result = null;
  for await (const m of query({ prompt, options: sessionOptions(arm, { cwd, model: MODEL, maxTurns: 15 }, extra) })) {
    if (m.type === "system" && m.subtype === "init") checkSetup(arm, m, extra);
    if (m.type === "result") result = m;
  }
  if (!result) throw new Error("session ended without a result");
  return {
    ...usageTotals(result),
    subtype: result.subtype,
    text: result.result ?? "",
    turns: result.num_turns ?? 0,
    seconds: Math.round((Date.now() - t0) / 1000),
  };
}

// A fresh copy of the repo, set up for the arm.
function workdir(template, label, arm) {
  const cwd = mkdtempSync(join(tmpdir(), `ab-${label}-${arm.name.replace(/\W/g, "_")}-`));
  cpSync(template, cwd, { recursive: true });
  return { cwd, extra: prepareSession(arm, cwd) };
}

function report(names, results, failures, evidence, runDir) {
  const done = ARM_NAMES.filter((n) => results[n] && Object.keys(results[n]).length);
  const runsOf = (n) => names.flatMap((s) => results[n][s] ?? []);
  const total = (n, f) => runsOf(n).reduce((acc, x) => acc + f(x), 0);
  const ref = done.includes("baseline") ? "baseline" : done[0];
  const lines = [
    "# Quick benchmark: one question per session",
    "",
    `- When: ${new Date().toISOString()}`,
    `- Model: ${MODEL}; ${REPEAT} run(s) per scenario and arm; scenarios: ${names.join(", ")}`,
    "- Every arm: none of your settings, CLAUDE.md, plugins or MCP servers; same model, tools and Claude Code system prompt; then only the arm's components (see harness.mjs)",
    "- Tokens = uncached input + cache writes + cache reads + output, over every model call. Cost is the SDK's `total_cost_usd` estimate (on a claude.ai plan this is usage, not a bill)",
    "- Each session follows a one-request warm-up with the same setup, not counted, so every arm is measured with its fixed prompt already cached",
    "- Correct = the exact expected value (hash, request ID, number, file:line), or for fix_test: tests pass and test files untouched",
    `- Logs: ${runDir}`,
    "",
    `## Arms (cheapest first, compared with ${ref})`,
    "",
    "| Arm | Components | Tokens | vs ref | Cost $ | vs ref | Correct |",
    "|---|---|---:|---:|---:|---:|:-:|",
  ];
  const rt = total(ref, totalTokens);
  const rc = total(ref, (x) => x.cost);
  for (const n of [...done].sort((a, b) => total(a, (x) => x.cost) - total(b, (x) => x.cost))) {
    const t = total(n, totalTokens);
    const c = total(n, (x) => x.cost);
    lines.push(`| ${n === ref ? `**${n}**` : n} | ${ARMS[n].join(", ") || "none"} | ${t} | ${pct(rt, t)} | ${c.toFixed(4)} | ${pct(rc, c)} | ${runsOf(n).filter((x) => x.correct).length}/${runsOf(n).length} |`);
  }

  lines.push("", "## Cost per scenario ($, sum of runs)", "", `| Scenario | ${done.join(" | ")} |`, `|---|${done.map(() => "---:").join("|")}|`);
  for (const s of names) {
    lines.push(`| ${s} | ${done.map((n) => (results[n][s] ?? []).reduce((a, x) => a + x.cost, 0).toFixed(4)).join(" | ")} |`);
  }

  lines.push("", "## Details", "", "| Scenario | Arm | Uncached in | Cache write | Cache read | Output | Turns | Secs | $ | Correct | Answer |", "|---|---|---:|---:|---:|---:|---:|---:|---:|:-:|---|");
  for (const s of names) {
    for (const n of done) {
      for (const [i, x] of (results[n][s] ?? []).entries()) {
        const answer = s === "fix_test" ? "(tests)" : `\`${answerOf(x.text) ?? "none"}\``;
        lines.push(`| ${s}${REPEAT > 1 ? ` #${i + 1}` : ""} | ${n} | ${x.uncached} | ${x.cacheWrite} | ${x.cacheRead} | ${x.output} | ${x.turns} | ${x.seconds} | ${x.cost.toFixed(4)} | ${yes(x.correct)} | ${answer}${x.subtype !== "success" ? ` (${x.subtype})` : ""} |`);
      }
    }
  }
  if (Object.keys(failures).length) lines.push("", "## Failed arms", "", ...Object.entries(failures).map(([n, msg]) => `- ${n}: ${msg}`));
  lines.push("", ...evidenceSection(evidence));
  return lines.join("\n");
}

async function main() {
  const pre = await preflight(ARM_NAMES);
  const names = ONLY ? [ONLY] : Object.keys(SCENARIOS);
  if (ONLY && !SCENARIOS[ONLY]) throw new Error(`unknown scenario ${ONLY} (have: ${Object.keys(SCENARIOS).join(", ")})`);

  if (MODE === "preflight") {
    console.log(pre.ready
      ? `\nReady (arms: ${ARM_NAMES.join(", ")}). --smoke runs ${ARM_NAMES.length} tiny session(s); --live runs ${names.length * REPEAT * ARM_NAMES.length} session(s) (${names.join(", ")}), each after a one-request warm-up.`
      : "\nNot ready. Fix the failed checks first.");
    return;
  }
  if (!pre.ready) {
    console.error(`Refusing to run --${MODE}: fix the failed preflight checks first.`);
    process.exit(1);
  }

  const arms = buildArms(ARM_NAMES, pre);
  const runDir = newRunDir();
  const template = mkdtempSync(join(tmpdir(), "ab-repo-"));
  const expected = buildRepo(template);
  const results = {};
  const failures = {};
  const evidence = {};

  // One arm after the other, so only one arm's proxies run at a time. A failing arm is
  // recorded and the run goes on with the next one.
  for (const arm of arms) {
    console.log(`\nArm ${arm.name} (${arm.components.join(", ") || "no tools"}):`);
    results[arm.name] = {};
    try {
      startProxies(arm, runDir);
      if (MODE === "smoke") {
        const { cwd, extra } = workdir(template, "smoke", arm);
        const run = await warmUp(arm, cwd, extra, MODEL);
        console.log(`  ok: ${totalTokens(run)} tokens (uncached ${run.uncached}, cache write ${run.cacheWrite}, cache read ${run.cacheRead}, output ${run.output}), $${run.cost.toFixed(4)}`);
      } else {
        for (const name of names) {
          results[arm.name][name] = [];
          for (let run = 0; run < REPEAT; run++) {
            const { cwd, extra } = workdir(template, name, arm);
            await warmUp(arm, cwd, extra, MODEL);
            const result = await runSession(SCENARIOS[name].prompt, arm, cwd, extra);
            result.correct = SCENARIOS[name].check(result.text, expected, cwd);
            results[arm.name][name].push(result);
            console.log(`  ${name}: ${totalTokens(result)} tok, $${result.cost.toFixed(4)}, correct: ${yes(result.correct)}`);
          }
        }
      }
      evidence[arm.name] = await proxyEvidence(arm);
      if (MODE === "smoke" && evidence[arm.name]) {
        for (const [proxy, text] of Object.entries(evidence[arm.name])) console.log(`  ${proxy}:\n${text.replace(/^/gm, "    ")}`);
      }
    } catch (e) {
      failures[arm.name] = String(e.message ?? e).split("\n")[0];
      console.error(`  ${arm.name} failed: ${failures[arm.name]}`);
    } finally {
      stopProxies(arm);
    }
  }

  if (MODE === "live") {
    writeFileSync(join(runDir, "results.json"), JSON.stringify({ model: MODEL, expected, results, failures }, null, 2));
    const out = join(ROOT, "reports", "ab-latest.md");
    const md = report(names, results, failures, evidence, runDir);
    writeFileSync(join(runDir, "report.md"), md);
    writeFileSync(out, md);
    console.log(`\nReport: ${out}`);
  }
  if (Object.keys(failures).length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

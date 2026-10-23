// Shared pieces of the benchmarks (run_ab.mjs, run_session.mjs): preflight checks, the arms
// (which tools of the stack a session gets), the proxies, and token accounting.
//
// Every arm ignores your own Claude Code settings, CLAUDE.md, plugins and MCP servers, and
// uses the same model, tools and Claude Code system prompt. Each arm then adds exactly its
// components, so the difference between two arms is the effect of the components that differ:
//   rtk       RTK hook + RTK.md instructions
//   caveman   Caveman plugin (mode caveman)
//   ponytail  Ponytail plugin (mode full)
//   crg       code-review-graph set up and built in the session's repo copy
//   headroom  requests routed through Headroom
//   pxpipe    requests routed through pxpipe
//   gate      requests routed through the context gate: pxpipe only for large contexts
// When an arm has both proxies, they are chained in the order its components list them:
// ["headroom", "pxpipe"] is Claude Code -> Headroom -> pxpipe -> Anthropic, and
// ["pxpipe", "headroom"] is Claude Code -> pxpipe -> Headroom -> Anthropic.
// The proxies run with token-stack, so the chain is wired exactly as in daily use: Headroom
// -> pxpipe runs Headroom inside `pxpipe warp`, so Headroom still treats its upstream as
// first-party Anthropic and keeps tool-search deferral.
// Arms with pxpipe but no Headroom set ENABLE_TOOL_SEARCH=true, like `token-stack claude`:
// Claude Code turns its tool-schema deferral off behind a custom ANTHROPIC_BASE_URL. With
// Headroom in the chain it stays unset: Headroom then defers the schemas itself, and far more
// of them than Claude Code does (it stands down when the client defers).

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));
const TOKEN_STACK = join(ROOT, "..", "token-stack");
const GATE_SCRIPT = join(ROOT, "..", "scripts", "context-gate.mjs");

export const ARMS = {
  baseline: [],
  rtk: ["rtk"],
  caveman: ["caveman"],
  ponytail: ["ponytail"],
  crg: ["crg"],
  headroom: ["headroom"],
  pxpipe: ["pxpipe"],
  "headroom+pxpipe": ["headroom", "pxpipe"],
  "rtk+caveman+ponytail": ["rtk", "caveman", "ponytail"],
  "rtk+caveman+ponytail+crg": ["rtk", "caveman", "ponytail", "crg"],
  "full-no-crg": ["rtk", "caveman", "ponytail", "headroom", "pxpipe"],
  full: ["rtk", "caveman", "ponytail", "crg", "headroom", "pxpipe"],
  // Headroom talking to Anthropic directly (no pxpipe), the best single tool in the first
  // 12-arm run, with the next best ones, and Caveman and Ponytail each without the other.
  "rtk+headroom": ["rtk", "headroom"],
  "rtk+caveman+headroom": ["rtk", "caveman", "headroom"],
  "rtk+ponytail+headroom": ["rtk", "ponytail", "headroom"],
  "rtk+caveman+ponytail+headroom": ["rtk", "caveman", "ponytail", "headroom"],
  // The same combinations with pxpipe after Headroom (with Caveman and Ponytail both, that
  // is full-no-crg).
  "rtk+headroom+pxpipe": ["rtk", "headroom", "pxpipe"],
  "rtk+caveman+headroom+pxpipe": ["rtk", "caveman", "headroom", "pxpipe"],
  "rtk+ponytail+headroom+pxpipe": ["rtk", "ponytail", "headroom", "pxpipe"],
  // pxpipe before Headroom, so Headroom is the one talking to Anthropic.
  "pxpipe+headroom": ["pxpipe", "headroom"],
  "rtk+pxpipe+headroom": ["rtk", "pxpipe", "headroom"],
  // Headroom -> gate -> pxpipe: the gate sends a request to pxpipe only when its context is at
  // least the arm's threshold (ARM_GATE_MIN_TOKENS), and straight to Anthropic otherwise.
  "rtk+ponytail+headroom+gate12k+pxpipe": ["rtk", "ponytail", "headroom", "gate", "pxpipe"],
  "rtk+ponytail+headroom+gate20k+pxpipe": ["rtk", "ponytail", "headroom", "gate", "pxpipe"],
  "rtk+ponytail+headroom+gate50k+pxpipe": ["rtk", "ponytail", "headroom", "gate", "pxpipe"],
  "rtk+ponytail+headroom+gate90k+pxpipe": ["rtk", "ponytail", "headroom", "gate", "pxpipe"],
  // Router: Claude Code -> gate front -> Headroom -> gate back -> pxpipe or Anthropic. The front
  // and back are one gate process; the back sends a request to pxpipe only when its context is
  // at least the arm's threshold, calibrated on the usage Anthropic reports.
  "rtk+ponytail+router50k+pxpipe": ["rtk", "ponytail", "gate", "headroom", "gate", "pxpipe"],
  "rtk+ponytail+router90k+pxpipe": ["rtk", "ponytail", "gate", "headroom", "gate", "pxpipe"],
  // Router with the gain policy: pxpipe only when its own dry run says the saving pays back the
  // cache rewrite (zones: <20% of the window direct, 20-50% break-even over 20 requests, >50%
  // whenever profitable).
  "rtk+ponytail+router-gain+pxpipe": ["rtk", "ponytail", "gate", "headroom", "gate", "pxpipe"],
};
// The gate policy (TOKEN_STACK_GATE_POLICY) of the arms that set one. Others use the gate's default.
export const ARM_GATE_POLICY = {
  "rtk+ponytail+router-gain+pxpipe": "gain",
};
// The gate threshold (TOKEN_STACK_GATE_MIN_TOKENS) of the arms with a gate. Others use the default.
export const ARM_GATE_MIN_TOKENS = {
  "rtk+ponytail+headroom+gate12k+pxpipe": 12000,
  "rtk+ponytail+headroom+gate20k+pxpipe": 20000,
  "rtk+ponytail+headroom+gate50k+pxpipe": 50000,
  "rtk+ponytail+headroom+gate90k+pxpipe": 90000,
  "rtk+ponytail+router50k+pxpipe": 50000,
  "rtk+ponytail+router90k+pxpipe": 90000,
};
const PRESETS = {
  // No stack vs what install.sh installs by default, the best combination measured.
  default: ["baseline", "rtk+ponytail+headroom"],
  ablation: ["baseline", "rtk+caveman+ponytail", "rtk+caveman+ponytail+crg", "full"],
  "headroom-combos": ["rtk+headroom", "rtk+caveman+headroom", "rtk+ponytail+headroom", "rtk+caveman+ponytail+headroom"],
  "pxpipe-combos": ["rtk+headroom+pxpipe", "rtk+caveman+headroom+pxpipe", "rtk+ponytail+headroom+pxpipe"],
  "pxpipe-first": ["pxpipe+headroom", "rtk+pxpipe+headroom"],
  // pxpipe after Headroom always, or only for large contexts through the gate.
  gate: ["baseline", "rtk+ponytail+headroom", "rtk+ponytail+headroom+pxpipe", "rtk+ponytail+headroom+gate12k+pxpipe", "rtk+ponytail+headroom+gate20k+pxpipe"],
  // Long-session scenario (run_session.mjs --scenario long): pxpipe after Headroom always, or
  // through the gate only for contexts of at least 50k or 90k tokens.
  long: ["baseline", "rtk+ponytail+headroom", "rtk+ponytail+headroom+pxpipe", "rtk+ponytail+router50k+pxpipe", "rtk+ponytail+router90k+pxpipe", "rtk+ponytail+router-gain+pxpipe"],
  // The router (gate front and back around Headroom) at 50k and 90k tokens, against Headroom alone.
  router: ["rtk+ponytail+headroom", "rtk+ponytail+router50k+pxpipe", "rtk+ponytail+router90k+pxpipe", "rtk+ponytail+router-gain+pxpipe"],
  // Proxy arms to measure again after a proxy setup change (see PROXY_SETUP).
  "proxy-rerun": ["headroom", "pxpipe", "headroom+pxpipe", "pxpipe+headroom", "rtk+headroom", "rtk+headroom+pxpipe", "rtk+pxpipe+headroom"],
  // The arms proxy setup 3 changes (those with Headroom).
  "headroom-rerun": ["headroom", "headroom+pxpipe", "pxpipe+headroom", "rtk+headroom", "rtk+headroom+pxpipe", "rtk+pxpipe+headroom"],
  // The best arms so far with proxy setup 3, with and without pxpipe after Headroom, and the
  // baseline they are compared with. Run with --repeat to confirm the ranking.
  best: ["baseline", "headroom", "rtk+headroom", "rtk+ponytail+headroom", "headroom+pxpipe", "rtk+headroom+pxpipe", "rtk+ponytail+headroom+pxpipe"],
  confirm: ["baseline", "headroom", "rtk", "rtk+headroom", "rtk+caveman+ponytail+headroom"],
  all: Object.keys(ARMS),
};

// Pairs of arms whose difference answers one question. Reports show those whose two arms ran.
export const COMPARISONS = [
  ["RTK alone", "baseline", "rtk"],
  ["Caveman alone", "baseline", "caveman"],
  ["Ponytail alone", "baseline", "ponytail"],
  ["code-review-graph alone", "baseline", "crg"],
  ["Headroom alone", "baseline", "headroom"],
  ["pxpipe alone", "baseline", "pxpipe"],
  ["Headroom -> pxpipe alone", "baseline", "headroom+pxpipe"],
  ["RTK + Caveman + Ponytail", "baseline", "rtk+caveman+ponytail"],
  ["Adding code-review-graph to RTK + Caveman + Ponytail", "rtk+caveman+ponytail", "rtk+caveman+ponytail+crg"],
  ["Adding Headroom -> pxpipe to the rest", "rtk+caveman+ponytail+crg", "full"],
  ["Full stack without code-review-graph", "baseline", "full-no-crg"],
  ["Full stack", "baseline", "full"],
  ["RTK + Headroom", "baseline", "rtk+headroom"],
  ["Adding RTK to Headroom", "headroom", "rtk+headroom"],
  ["Adding Caveman to RTK + Headroom", "rtk+headroom", "rtk+caveman+headroom"],
  ["Adding Ponytail to RTK + Headroom", "rtk+headroom", "rtk+ponytail+headroom"],
  ["Adding Caveman + Ponytail to RTK + Headroom", "rtk+headroom", "rtk+caveman+ponytail+headroom"],
  ["Adding Ponytail to RTK + Caveman + Headroom", "rtk+caveman+headroom", "rtk+caveman+ponytail+headroom"],
  ["Adding Caveman to RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+caveman+ponytail+headroom"],
  ["Adding pxpipe after Headroom", "headroom", "headroom+pxpipe"],
  ["Adding pxpipe after Headroom to RTK + Headroom", "rtk+headroom", "rtk+headroom+pxpipe"],
  ["Adding pxpipe after Headroom to RTK + Caveman + Headroom", "rtk+caveman+headroom", "rtk+caveman+headroom+pxpipe"],
  ["Adding pxpipe after Headroom to RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+ponytail+headroom+pxpipe"],
  ["Adding pxpipe after Headroom to RTK + Caveman + Ponytail + Headroom", "rtk+caveman+ponytail+headroom", "full-no-crg"],
  ["Adding pxpipe before Headroom", "headroom", "pxpipe+headroom"],
  ["Adding pxpipe before Headroom to RTK + Headroom", "rtk+headroom", "rtk+pxpipe+headroom"],
  ["pxpipe before instead of after Headroom", "headroom+pxpipe", "pxpipe+headroom"],
  ["pxpipe before instead of after Headroom, with RTK", "rtk+headroom+pxpipe", "rtk+pxpipe+headroom"],
  ["pxpipe only above 12k tokens, after RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+ponytail+headroom+gate12k+pxpipe"],
  ["pxpipe only above 20k tokens, after RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+ponytail+headroom+gate20k+pxpipe"],
  ["pxpipe only above 50k tokens, after RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+ponytail+headroom+gate50k+pxpipe"],
  ["pxpipe only above 90k tokens, after RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+ponytail+headroom+gate90k+pxpipe"],
  ["Gate at 12k instead of pxpipe always", "rtk+ponytail+headroom+pxpipe", "rtk+ponytail+headroom+gate12k+pxpipe"],
  ["Gate at 50k instead of pxpipe always", "rtk+ponytail+headroom+pxpipe", "rtk+ponytail+headroom+gate50k+pxpipe"],
  ["pxpipe only above 50k tokens (router), after RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+ponytail+router50k+pxpipe"],
  ["pxpipe only above 90k tokens (router), after RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+ponytail+router90k+pxpipe"],
  ["Router at 50k instead of pxpipe always", "rtk+ponytail+headroom+pxpipe", "rtk+ponytail+router50k+pxpipe"],
  ["Router instead of back-only gate, at 50k", "rtk+ponytail+headroom+gate50k+pxpipe", "rtk+ponytail+router50k+pxpipe"],
  ["pxpipe only when profitable (router, gain policy), after RTK + Ponytail + Headroom", "rtk+ponytail+headroom", "rtk+ponytail+router-gain+pxpipe"],
  ["Gain policy instead of a 50k threshold", "rtk+ponytail+router50k+pxpipe", "rtk+ponytail+router-gain+pxpipe"],
];

// Comma-separated arm names and/or preset names -> list of arm names, without duplicates.
export function resolveArms(spec) {
  const names = [...new Set(spec.split(",").map((s) => s.trim()).filter(Boolean).flatMap((s) => PRESETS[s] ?? [s]))];
  const unknown = names.filter((n) => !ARMS[n]);
  if (unknown.length) {
    throw new Error(`unknown arm(s): ${unknown.join(", ")}. Arms: ${Object.keys(ARMS).join(", ")}. Presets: ${Object.keys(PRESETS).join(", ")}`);
  }
  return names;
}

// Same tools in every arm. Subagents and web access are off so every token comes from the
// main session; anything not listed is denied instead of prompting.
const ALLOWED_TOOLS = ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite", "Skill"];
const DISALLOWED_TOOLS = ["Agent", "Task", "WebFetch", "WebSearch"];
const PLUGIN_IDS = { caveman: "caveman@caveman", ponytail: "ponytail@ponytail" };

// Each arm with proxies gets its own instances on its own ports, so the proxies' stats are
// per arm and never mix with a chain you started yourself (default ports 8787 / 47821).
const portsFor = (index) => ({ headroom: 18790 + index, pxpipe: 47840 + index, gate: 47870 + index, gateFront: 47900 + index });
// The arm's proxies in chain order, as token-stack expects them (TOKEN_STACK_PROXIES).
const proxiesOf = (components) => components.filter((c) => c === "headroom" || c === "pxpipe" || c === "gate").join(",");

export function cliValue(args, name, fallback) {
  return args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
}

function sh(cmd, argv) {
  try {
    return execFileSync(cmd, argv, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}
const onPath = (bin) => !!sh("sh", ["-c", `command -v ${bin}`]);

// The RTK entries of ~/.claude/settings.json, copied as-is into arms with rtk.
function rtkHookEntries() {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"));
    const entries = (s.hooks?.PreToolUse ?? []).filter((e) => e.hooks?.some((h) => h.command?.startsWith("rtk hook")));
    return entries.length ? entries : null;
  } catch {
    return null;
  }
}

// `rtk init -g` also adds ~/.claude/RTK.md (pulled in by CLAUDE.md); arms with rtk get it too.
function rtkInstructions() {
  try {
    return readFileSync(join(homedir(), ".claude", "RTK.md"), "utf8");
  } catch {
    return null;
  }
}

// `rtk rewrite` prints the rewritten command and exits 0 or 3; exit 1 means no rewrite.
function rtkRewrite(cmd) {
  const r = spawnSync("rtk", ["rewrite", cmd], { encoding: "utf8", timeout: 10000 });
  return r.status === 0 || r.status === 3 ? r.stdout.trim() || null : null;
}

function pluginPaths() {
  let list = [];
  try {
    list = JSON.parse(sh("claude", ["plugin", "list", "--json"]) ?? "[]");
  } catch {}
  return Object.fromEntries(Object.values(PLUGIN_IDS).map((id) => [id, list.find((p) => p.id === id)?.installPath ?? null]));
}

async function answers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

// Runs and prints the checks the given arms need (a tool is only required if one of them
// uses it); returns what buildArms needs, plus whether everything passed.
export async function preflight(armNames) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok: !!ok, detail });
  const used = new Set(armNames.flatMap((n) => ARMS[n]));
  const hook = rtkHookEntries();
  if (used.has("rtk")) {
    add("rtk on PATH", onPath("rtk"));
    add("RTK hook in ~/.claude/settings.json", hook, hook ? "copied into arms with rtk" : "run `rtk init -g`");
    const rewritten = rtkRewrite("git log --stat");
    add("RTK rewrites git commands", rewritten?.startsWith("rtk "), rewritten ?? "no rewrite");
  }
  for (const [component, bin, hint] of [
    ["headroom", "headroom", "run install.sh"],
    ["pxpipe", "pxpipe", "run benchmark/install.sh"],
    ["crg", "code-review-graph", "run benchmark/install.sh"],
  ]) {
    if (!used.has(component)) continue;
    const found = onPath(bin);
    add(`${bin} on PATH`, found, found ? "" : hint);
  }
  if (used.has("gate")) {
    add("node on PATH", onPath("node"), onPath("node") ? "" : "install Node 20+");
    add("context-gate.mjs", existsSync(GATE_SCRIPT), GATE_SCRIPT);
  }
  if (used.has("headroom") || used.has("pxpipe") || used.has("crg")) add("token-stack script", existsSync(TOKEN_STACK), TOKEN_STACK);
  const plugins = pluginPaths();
  for (const [component, id] of Object.entries(PLUGIN_IDS)) {
    if (!used.has(component)) continue;
    const hint = component === "caveman" ? "run benchmark/install.sh" : "run install.sh";
    add(`plugin ${id}`, plugins[id] && existsSync(plugins[id]), plugins[id] ?? `not installed (${hint})`);
  }
  const busy = [];
  for (const [i, name] of armNames.entries()) {
    const ports = portsFor(i);
    const checkPorts = ["headroom", "pxpipe", "gate"].filter((p) => ARMS[name].includes(p));
    // Router arms (chain starts with the gate) also run a gate front.
    if (proxiesOf(ARMS[name]).startsWith("gate")) checkPorts.push("gateFront");
    for (const p of checkPorts) {
      if (await answers(`http://127.0.0.1:${ports[p]}`)) busy.push(ports[p]);
    }
  }
  add("benchmark proxy ports free", busy.length === 0, busy.length ? `in use: ${busy.join(", ")}` : "");
  add("git on PATH", onPath("git"));

  console.log("Preflight:");
  for (const c of checks) console.log(`  [${c.ok ? "OK" : "--"}] ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
  return { ready: checks.every((c) => c.ok), hook, plugins };
}

// Your shell may carry stack settings; no arm should inherit them.
function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (["ANTHROPIC_BASE_URL", "ENABLE_TOOL_SEARCH"].includes(k) || k.startsWith("CAVEMAN_") || k.startsWith("PONYTAIL_")) delete env[k];
  }
  return env;
}

// Version of the proxy setup, saved with each run so merged reports never pool sessions
// measured with different configurations of an arm.
export const PROXY_SETUP = 3;
export const SETUP_NOTES = {
  1: "ENABLE_TOOL_SEARCH unset, and Headroom -> pxpipe pointed Headroom at pxpipe, which made Headroom treat pxpipe as a third-party API and strip tool-search deferral",
  2: "ENABLE_TOOL_SEARCH=true behind every proxy, and Headroom -> pxpipe through pxpipe warp; Headroom then left deferral to Claude Code, which defers far fewer tool schemas",
  3: "as 2, but ENABLE_TOOL_SEARCH=true only without Headroom, so Headroom defers the tool schemas itself (arms with Headroom and no Headroom -> pxpipe are then configured as in setup 1, so their setup 1 results count as current)",
};
// How an arm was actually configured under a setup: whether Claude Code deferred tool
// schemas itself, and how Headroom -> pxpipe was wired. Sessions are pooled across setups
// where this is the same.
function setupSignature(components, setup) {
  const headroom = components.includes("headroom");
  const pxpipe = components.includes("pxpipe");
  if (!headroom && !pxpipe) return "no proxy";
  const toolSearch = setup === 1 ? false : setup === 2 ? true : !headroom;
  const headroomFirst = headroom && pxpipe && components.indexOf("headroom") < components.indexOf("pxpipe");
  return `tool search ${toolSearch}, ${headroomFirst ? (setup === 1 ? "api-url" : "warp") : "no headroom->pxpipe"}`;
}
// Merged reports name an arm measured with an outdated setup "<arm> [proxy setup N]"
// (setup 1 keeps its first name, "[old proxy setup]").
export const setupLabel = (setup) => (setup <= 1 ? " [old proxy setup]" : ` [proxy setup ${setup}]`);
export const baseArm = (name) => name.replace(/ \[[^\]]+\]$/, "");
export const setupOf = (name) => {
  const m = name.match(/ \[(?:old proxy setup|proxy setup (\d+))\]$/);
  return !m ? PROXY_SETUP : m[1] ? Number(m[1]) : 1;
};
export const componentsOf = (name) => ARMS[baseArm(name)] ?? [];
export const hasProxies = (name) => componentsOf(name).some((c) => c === "headroom" || c === "pxpipe");
// Was this arm configured differently under `setup` than under the current one?
export const outdated = (name, setup) =>
  setupSignature(componentsOf(name), setup) !== setupSignature(componentsOf(name), PROXY_SETUP);

export function buildArms(armNames, { hook, plugins }) {
  return armNames.map((name, index) => {
    const components = ARMS[name];
    const has = (c) => components.includes(c);
    const env = cleanEnv();
    // Caveman switches itself off in SDK sessions unless CAVEMAN_DEFAULT_MODE is set.
    if (has("caveman")) env.CAVEMAN_DEFAULT_MODE = "caveman";
    if (has("ponytail")) env.PONYTAIL_DEFAULT_MODE = "full";
    if (proxiesOf(components) && !has("headroom")) env.ENABLE_TOOL_SEARCH = "true";
    const pluginIds = Object.keys(PLUGIN_IDS).filter(has).map((c) => PLUGIN_IDS[c]);
    return {
      name,
      components,
      env,
      settings: has("rtk") ? { hooks: { PreToolUse: hook } } : null,
      append: has("rtk") ? rtkInstructions() : null,
      pluginIds,
      plugins: pluginIds.map((id) => ({ type: "local", path: plugins[id] })),
      codeGraph: has("crg"),
      proxies: proxiesOf(components),
      ports: portsFor(index),
      baseUrl: null,
      stateDir: null,
    };
  });
}

function proxyEnv(arm) {
  return {
    ...process.env,
    TOKEN_STACK_PROXIES: arm.proxies,
    TOKEN_STACK_STATE_DIR: arm.stateDir,
    TOKEN_STACK_HEADROOM_PORT: String(arm.ports.headroom),
    TOKEN_STACK_PXPIPE_PORT: String(arm.ports.pxpipe),
    TOKEN_STACK_GATE_PORT: String(arm.ports.gate),
    TOKEN_STACK_GATE_FRONT_PORT: String(arm.ports.gateFront),
    // The repo's copy, so the benchmark never runs an older installed one.
    TOKEN_STACK_GATE_SCRIPT: GATE_SCRIPT,
    ...(ARM_GATE_MIN_TOKENS[arm.name] ? { TOKEN_STACK_GATE_MIN_TOKENS: String(ARM_GATE_MIN_TOKENS[arm.name]) } : {}),
    ...(ARM_GATE_POLICY[arm.name] ? { TOKEN_STACK_GATE_POLICY: ARM_GATE_POLICY[arm.name] } : {}),
    PXPIPE_LOG: join(arm.stateDir, "pxpipe-events.jsonl"),
    TOKEN_STACK_GATE_LOG: join(arm.stateDir, "gate-events.jsonl"),
  };
}

// Starts the arm's proxies (if any) with token-stack and points the arm at them.
export function startProxies(arm, runDir) {
  if (!arm.proxies) return;
  arm.stateDir = join(runDir, arm.name);
  mkdirSync(arm.stateDir, { recursive: true });
  execFileSync(TOKEN_STACK, ["start"], { env: proxyEnv(arm), stdio: "inherit" });
  arm.baseUrl = execFileSync(TOKEN_STACK, ["url"], { env: proxyEnv(arm), encoding: "utf8" }).trim();
}

export function stopProxies(arm) {
  if (arm.stateDir) spawnSync(TOKEN_STACK, ["stop"], { env: proxyEnv(arm), stdio: "inherit" });
}

// Per-repo setup an arm needs before a session in `cwd`; returns extra query() options.
// Arms with crg run `token-stack graph` (the same command you run in your repos), then
// load what it wrote: the CLAUDE.md section, skills and hooks (project settings) and the
// MCP server from .mcp.json, whose tools are allowed like the built-in ones.
export function prepareSession(arm, cwd) {
  if (!arm.codeGraph) return {};
  const r = spawnSync(TOKEN_STACK, ["graph", cwd], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`token-stack graph failed in ${cwd}:\n${r.stdout}${r.stderr}`);
  const servers = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8")).mcpServers ?? {};
  return {
    settingSources: ["project"],
    mcpServers: servers,
    allowedTools: [...ALLOWED_TOOLS, ...Object.keys(servers).map((name) => `mcp__${name}`)],
  };
}

// query() options for one arm. `extra` comes from prepareSession.
export function sessionOptions(arm, { cwd, model, maxTurns }, extra = {}) {
  return {
    cwd,
    model,
    maxTurns,
    systemPrompt: { type: "preset", preset: "claude_code", ...(arm.append ? { append: arm.append } : {}) },
    settingSources: [],
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    env: arm.baseUrl ? { ...arm.env, ANTHROPIC_BASE_URL: arm.baseUrl } : arm.env,
    ...(arm.settings ? { settings: arm.settings } : {}),
    ...(arm.plugins.length ? { plugins: arm.plugins } : {}),
    ...extra,
  };
}

// An arm must have exactly its plugins loaded, and its MCP servers started (`pending` is
// accepted: a server may still be connecting at init). Otherwise the arm would silently
// measure something else. `init` is the session's system/init message.
export function checkSetup(arm, init, extra) {
  const loaded = (init?.plugins ?? []).map((p) => p.name);
  const isLoaded = (id) => loaded.some((p) => p === id.split("@")[0] || p === id);
  for (const id of Object.values(PLUGIN_IDS)) {
    const want = arm.pluginIds.includes(id);
    if (want && !isLoaded(id)) throw new Error(`${arm.name}: plugin ${id} did not load (plugin errors: ${JSON.stringify(init?.plugin_errors ?? [])})`);
    if (!want && isLoaded(id)) throw new Error(`${arm.name}: plugin ${id} loaded but is not part of this arm`);
  }
  for (const name of Object.keys(extra.mcpServers ?? {})) {
    const status = init?.mcp_servers?.find((s) => s.name === name)?.status ?? "missing";
    if (status !== "connected" && status !== "pending") throw new Error(`${arm.name}: MCP server ${name} is ${status}`);
  }
  return loaded;
}

// One request with the arm's full setup, not counted in comparisons. It caches the arm's
// fixed prompt (system prompt, tool definitions, plugin and graph instructions) for the
// session that follows in the same `cwd`, so every measured session starts in the same
// state whatever order the arms run in. It also fails fast on a broken setup, before the
// costly session. Returns its usage (the cost of starting cold).
export async function warmUp(arm, cwd, extra, model) {
  let init = null;
  let result = null;
  for await (const m of query({ prompt: "Reply with the single word: ready", options: sessionOptions(arm, { cwd, model, maxTurns: 1 }, extra) })) {
    if (m.type === "system" && m.subtype === "init") init = m;
    if (m.type === "result") result = m;
  }
  if (!result) throw new Error(`${arm.name}: warm-up ended without a result`);
  checkSetup(arm, init, extra);
  return usageTotals(result);
}

// Token and cost totals from a result message. `modelUsage` covers every model call of the
// query() (main loop and auxiliary calls), like `total_cost_usd`; `usage` covers only the
// main loop. Both are running totals in multi-request sessions.
export function usageTotals(result) {
  const t = { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: result.total_cost_usd ?? 0 };
  for (const m of Object.values(result.modelUsage ?? {})) {
    t.uncached += m.inputTokens ?? 0;
    t.cacheWrite += m.cacheCreationInputTokens ?? 0;
    t.cacheRead += m.cacheReadInputTokens ?? 0;
    t.output += m.outputTokens ?? 0;
  }
  return t;
}

export const minus = (a, b) => ({
  uncached: a.uncached - b.uncached,
  cacheWrite: a.cacheWrite - b.cacheWrite,
  cacheRead: a.cacheRead - b.cacheRead,
  output: a.output - b.output,
  cost: a.cost - b.cost,
});
export const ZERO = { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0 };
export const totalTokens = (u) => u.uncached + u.cacheWrite + u.cacheRead + u.output;

export const pct = (base, value) => {
  if (!(base > 0)) return "n/a";
  const change = Math.round(((value - base) / base) * 1000) / 10;
  return change === 0 ? "0%" : `${change < 0 ? "-" : "+"}${Math.abs(change)}%`;
};
export const yes = (b) => (b ? "yes" : "NO");

export function newRunDir() {
  const dir = join(ROOT, "reports", "runs", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// What the arm's proxies report they did, so a report shows they were actually in the
// path. Call before stopProxies. Null for arms without proxies.
export async function proxyEvidence(arm) {
  if (!arm.proxies) return null;
  const ev = {};
  if (arm.proxies.includes("pxpipe")) {
    ev.pxpipe = sh("pxpipe", ["stats", "--file", join(arm.stateDir, "pxpipe-events.jsonl")]) ?? "pxpipe stats returned nothing";
  }
  if (arm.proxies.includes("headroom")) {
    ev.headroom = "Headroom /stats unavailable";
    try {
      const url = `http://127.0.0.1:${arm.ports.headroom}/stats`;
      const stats = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
      writeFileSync(join(arm.stateDir, "headroom-stats.json"), JSON.stringify(stats, null, 2));
      ev.headroom = savingsFields(stats);
    } catch {}
  }
  // The gate's counters: how many requests went straight to Anthropic and how many to pxpipe.
  if (arm.proxies.includes("gate")) {
    ev.gate = "context gate /stats unavailable";
    try {
      const url = `http://127.0.0.1:${arm.ports.gate}/stats`;
      const stats = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json();
      writeFileSync(join(arm.stateDir, "gate-stats.json"), JSON.stringify(stats, null, 2));
      ev.gate = JSON.stringify(stats, null, 2);
    } catch {}
  }
  return ev;
}

// Numeric savings-related fields from Headroom's /stats, up to three levels deep.
function savingsFields(stats) {
  const out = [];
  const walk = (o, path, depth) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      const p = path ? `${path}.${k}` : k;
      if (typeof v === "number" && /saved|savings|original|optimized|compressed|requests/i.test(k)) out.push(`${p}: ${v}`);
      else if (v && typeof v === "object" && !Array.isArray(v) && depth < 2) walk(v, p, depth + 1);
    }
  };
  walk(stats, "", 0);
  return out.slice(0, 25).join("\n") || "no savings fields found (see headroom-stats.json)";
}

// Markdown section with the proxies' own figures, per arm.
export function evidenceSection(evidenceByArm) {
  const lines = [
    "## Proxy evidence",
    "",
    "The proxies' own counters, measured against the request each one received. The tables above compare against real sessions without them.",
    "",
  ];
  for (const [name, ev] of Object.entries(evidenceByArm)) {
    if (!ev) continue;
    lines.push(`### ${name}`, "");
    if (ev.pxpipe) lines.push("pxpipe (`pxpipe stats`):", "", "```text", ev.pxpipe.split("\n").slice(0, 40).join("\n"), "```", "");
    if (ev.headroom) lines.push("Headroom (`/stats`, savings fields):", "", "```text", ev.headroom, "```", "");
    if (ev.gate) lines.push("Context gate (`/stats`, requests direct or to pxpipe):", "", "```text", ev.gate.split("\n").slice(0, 40).join("\n"), "```", "");
  }
  return lines;
}

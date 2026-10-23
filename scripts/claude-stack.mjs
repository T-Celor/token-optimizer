#!/usr/bin/env node
// Runs Claude Code through the router chain on Windows (and other hosts without install.sh):
//   Claude Code -> gate front -> Headroom (inside pxpipe warp) -> gate back -> pxpipe or Anthropic
// The gate uses the gain policy: pxpipe only where its own dry run says the saving pays back.
//
// Modes:
//   node scripts/claude-stack.mjs [claude arguments...]  start the chain, run Claude Code, stop what it started
//   node scripts/claude-stack.mjs --serve               keep the chain running (used by the logon task);
//                                                       restarts any proxy that dies, until stopped
//
// Needs: Node 20+, pxpipe (npm -g pxpipe-proxy@0.15.0), Headroom in %USERPROFILE%\.token-stack\headroom.
// Environment: CLAUDE_STACK_HEADROOM (path to headroom.exe), CLAUDE_STACK_POLICY (gain|threshold).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, "context-gate.mjs");
const STATE = join(homedir(), ".token-stack");
const HEADROOM = process.env.CLAUDE_STACK_HEADROOM || join(STATE, "headroom", "Scripts", "headroom.exe");
const POLICY = process.env.CLAUDE_STACK_POLICY || "gain";
const PORTS = { pxpipe: 47821, gateBack: 47830, gateFront: 47831, headroom: 8787 };
const WIN = process.platform === "win32";
const SERVE = process.argv.includes("--serve");
const SERVE_PID = join(STATE, "serve.pid");
const WATCH_MS = 15000;
const started = [];
const children = new Map(); // name -> child process started by this script

const up = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

const alive = (name) => {
  const c = children.get(name);
  return Boolean(c && c.exitCode === null && c.signalCode === null);
};

async function waitUp(url, name, seconds = 120) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await up(url)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} did not answer on ${url}; see ${join(STATE, name + ".log")}`);
}

// With the shell on, Node joins the arguments with spaces and quotes none of them, so a prompt or a
// path with a space would be split. Quote those arguments ourselves.
const shellArg =(a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

// Shims (pxpipe.cmd, claude.cmd) need the shell on Windows; real executables such as node.exe do not.
function start(name, command, args, env, { shell = false } = {}) {
  mkdirSync(STATE, { recursive: true });
  const out = openSync(join(STATE, name + ".log"), "a");
  const useShell = WIN && shell;
  const child = spawn(command, useShell ? args.map(shellArg) : args, { env: { ...process.env, ...env }, stdio: ["ignore", out, out], detached: !WIN, windowsHide: true, shell: useShell });
  started.push({ name, pid: child.pid });
  children.set(name, child);
  child.on("error", (err) => console.error(`[claude-stack] ${name}: ${err.message}`));
  return child;
}

function stopStarted() {
  for (const { name, pid } of started.reverse()) {
    try {
      if (WIN) execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-pid, "SIGTERM");
      console.error(`[claude-stack] stopped ${name}`);
    } catch {
      // Already exited.
    }
  }
  started.length = 0;
}

// Each proxy is started only if it is not already answering and its own child is not still alive.
async function startPxpipe() {
  if (await up(`http://127.0.0.1:${PORTS.pxpipe}/`) || alive("pxpipe")) return;
  start("pxpipe", "pxpipe", [], { PORT: String(PORTS.pxpipe) }, { shell: true });
  await waitUp(`http://127.0.0.1:${PORTS.pxpipe}/`, "pxpipe");
}

async function startGate() {
  if (await up(`http://127.0.0.1:${PORTS.gateBack}/livez`) || alive("gate")) return;
  // Both stages in one process: back (after Headroom) and front (before it).
  start("gate", process.execPath, [GATE], {
    GATE_PORT: String(PORTS.gateBack),
    GATE_FRONT_PORT: String(PORTS.gateFront),
    GATE_FRONT_UPSTREAM: `http://127.0.0.1:${PORTS.headroom}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${PORTS.pxpipe}`,
    GATE_POLICY: POLICY,
    GATE_LOG: join(STATE, "gate-events.jsonl"),
  });
  await waitUp(`http://127.0.0.1:${PORTS.gateBack}/livez`, "gate");
}

async function startHeadroom() {
  if (await up(`http://127.0.0.1:${PORTS.headroom}/livez`) || alive("headroom")) return;
  // Headroom inside pxpipe warp: its api.anthropic.com/v1/messages calls reach the gate's back stage.
  start("headroom", "pxpipe", ["warp", "--", HEADROOM, "proxy", "--port", String(PORTS.headroom), "--no-telemetry"], {
    PORT: String(PORTS.gateBack),
    HEADROOM_TELEMETRY: "off",
  }, { shell: true });
  await waitUp(`http://127.0.0.1:${PORTS.headroom}/livez`, "headroom", 180);
}

async function ensureChain() {
  if (!existsSync(GATE)) throw new Error(`context-gate.mjs not found next to this script (${GATE})`);
  if (!existsSync(HEADROOM)) throw new Error(`Headroom not found at ${HEADROOM}. Install it with bundle-windows\\install.cmd.`);
  mkdirSync(STATE, { recursive: true });
  await startPxpipe();
  await startGate();
  await startHeadroom();
}

// Keeps one older copy of a log that grew past maxBytes.
// shortcut: proxy logs are only rotated when serve starts (Windows cannot rename a file a running
// proxy holds open); fine while the machine logs on again from time to time.
const LOG_MAX = 5 * 1024 * 1024;
function rotate(file, maxBytes = LOG_MAX) {
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.old`);
  } catch {
    // Missing, or still open in another process: try again later.
  }
}

// One serve at a time: it holds this port as a lock. A second one would fight the first over the
// proxies. A port, unlike a pid file, cannot go stale after a reboot.
const SERVE_LOCK_PORT = 47832;
function holdServeLock() {
  return new Promise((resolveLock) => {
    const lock = createServer();
    lock.once("error", () => resolveLock(false));
    lock.listen(SERVE_LOCK_PORT, "127.0.0.1", () => resolveLock(true));
  });
}

async function serve() {
  if (!(await holdServeLock())) {
    console.error(`[claude-stack] another serve is already running (port ${SERVE_LOCK_PORT} taken); exiting`);
    process.exit(0);
  }
  mkdirSync(STATE, { recursive: true });
  for (const name of ["pxpipe", "gate", "headroom"]) rotate(join(STATE, `${name}.log`));
  writeFileSync(SERVE_PID, String(process.pid));
  const stop = () => {
    stopStarted();
    rmSync(SERVE_PID, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Retry until the chain is up; a failed start is logged and tried again on the next round.
  const round = async () => {
    // The gate reopens its event log for every line, so this one can be rotated while it runs.
    rotate(join(STATE, "gate-events.jsonl"), 2 * LOG_MAX);
    try {
      await ensureChain();
    } catch (err) {
      console.error(`[claude-stack] ${err.message}; retrying in ${WATCH_MS / 1000} s`);
    }
  };
  await round();
  console.error(`[claude-stack] serving: front ${PORTS.gateFront}, Headroom ${PORTS.headroom}, back ${PORTS.gateBack}, pxpipe ${PORTS.pxpipe}; policy ${POLICY}`);
  setInterval(round, WATCH_MS);
}

async function main() {
  if (SERVE) return serve();
  await ensureChain();
  // Claude Code talks to the front stage. Headroom has tool-search deferral, so leave ENABLE_TOOL_SEARCH unset.
  console.error(`[claude-stack] chain up: front ${PORTS.gateFront}, Headroom ${PORTS.headroom}, back ${PORTS.gateBack}, pxpipe ${PORTS.pxpipe}; policy ${POLICY}`);
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORTS.gateFront}` };
  delete env.ENABLE_TOOL_SEARCH;
  const args = process.argv.slice(2);
  const claude = spawn("claude", WIN ? args.map(shellArg) : args, { env, stdio: "inherit", shell: WIN });
  const code = await new Promise((resolveExit) => claude.on("exit", (c) => resolveExit(c ?? 0)));
  stopStarted();
  process.exit(code);
}

process.on("SIGINT", () => {
  stopStarted();
  process.exit(130);
});

// --settings-env set|unset <url>: writes or removes ANTHROPIC_BASE_URL in the "env" block of
// ~/.claude/settings.json, which Claude Code applies to every session (no Windows env refresh needed).
// unset only removes the value if it is still <url>; a file that does not parse is left untouched.
function settingsEnv(action, url) {
  const file = join(homedir(), ".claude", "settings.json");
  let settings = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
    } catch (err) {
      throw new Error(`${file} is not valid JSON (${err.message}); not changed`);
    }
  }
  if (action === "set") {
    settings.env = { ...(settings.env ?? {}), ANTHROPIC_BASE_URL: url };
  } else if (action === "unset") {
    // stdout, not stderr: PowerShell 5.1 with ErrorActionPreference Stop turns any stderr line into an error.
    if (settings.env?.ANTHROPIC_BASE_URL !== url) return console.log("[claude-stack] settings.json env: nothing to remove");
    delete settings.env.ANTHROPIC_BASE_URL;
    if (Object.keys(settings.env).length === 0) delete settings.env;
  } else {
    throw new Error("usage: --settings-env set|unset <url>");
  }
  mkdirSync(dirname(file), { recursive: true });
  // Write a temporary file, then rename it over the original: a crash mid-write cannot leave a
  // half-written settings.json.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(tmp, file);
  console.log(`[claude-stack] settings.json env: ANTHROPIC_BASE_URL ${action === "set" ? "set" : "removed"}`);
}

if (process.argv[2] === "--settings-env") {
  try {
    settingsEnv(process.argv[3], process.argv[4]);
  } catch (err) {
    console.error(`[claude-stack] ${err.message}`);
    process.exit(1);
  }
} else {
  main().catch((err) => {
    console.error(`[claude-stack] ${err.message}`);
    stopStarted();
    process.exit(1);
  });
}

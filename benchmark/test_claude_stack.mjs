// Tests for scripts/claude-stack.mjs --settings-env, which edits the user's global
// ~/.claude/settings.json. Runs against a temporary home folder, never the real one.
// Run: node --test benchmark/test_claude_stack.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STACK = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "claude-stack.mjs");
const URL = "http://127.0.0.1:47831";

// A home folder with a settings.json holding what a real one holds: hooks, plugins, another env var.
function fakeHome(settings) {
  const home = mkdtempSync(join(tmpdir(), "claude-stack-test-"));
  mkdirSync(join(home, ".claude"));
  if (settings !== undefined) writeFileSync(join(home, ".claude", "settings.json"), settings);
  return home;
}

// homedir() reads USERPROFILE on Windows and HOME elsewhere: set both.
function run(home, ...args) {
  return spawnSync(process.execPath, [STACK, "--settings-env", ...args], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
  });
}

const read = (home) => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

const ORIGINAL = {
  permissions: { defaultMode: "default" },
  hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] },
  enabledPlugins: { "ponytail@ponytail": true },
  env: { OTHER: "kept" },
};

test("set adds ANTHROPIC_BASE_URL and keeps everything else", () => {
  const home = fakeHome(JSON.stringify(ORIGINAL));
  try {
    assert.equal(run(home, "set", URL).status, 0);
    const s = read(home);
    assert.deepEqual(s.env, { OTHER: "kept", ANTHROPIC_BASE_URL: URL });
    assert.deepEqual(s.hooks, ORIGINAL.hooks);
    assert.deepEqual(s.enabledPlugins, ORIGINAL.enabledPlugins);
    assert.deepEqual(s.permissions, ORIGINAL.permissions);
    // The temporary file used for the atomic write is gone.
    assert.deepEqual(readdirSync(join(home, ".claude")), ["settings.json"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unset removes only our value, and only if it is still ours", () => {
  const home = fakeHome(JSON.stringify({ ...ORIGINAL, env: { OTHER: "kept", ANTHROPIC_BASE_URL: URL } }));
  try {
    assert.equal(run(home, "unset", "http://127.0.0.1:9999").status, 0);
    assert.equal(read(home).env.ANTHROPIC_BASE_URL, URL, "another URL must not remove ours");
    assert.equal(run(home, "unset", URL).status, 0);
    const s = read(home);
    assert.deepEqual(s.env, { OTHER: "kept" });
    assert.deepEqual(s.hooks, ORIGINAL.hooks);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("unset drops an env block left empty", () => {
  const home = fakeHome(JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: URL } }));
  try {
    assert.equal(run(home, "unset", URL).status, 0);
    assert.deepEqual(read(home), { theme: "dark" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a settings.json that does not parse is left untouched", () => {
  const broken = '{ "theme": "dark", ';
  const home = fakeHome(broken);
  try {
    const r = run(home, "set", URL);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(readFileSync(join(home, ".claude", "settings.json"), "utf8"), broken);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a byte order mark at the start of the file is accepted", () => {
  const home = fakeHome(String.fromCharCode(0xfeff) + JSON.stringify({ theme: "dark" }));
  try {
    assert.equal(run(home, "set", URL).status, 0);
    assert.deepEqual(read(home), { theme: "dark", env: { ANTHROPIC_BASE_URL: URL } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a missing settings.json is created", () => {
  const home = fakeHome(undefined);
  try {
    assert.equal(run(home, "set", URL).status, 0);
    assert.deepEqual(read(home), { env: { ANTHROPIC_BASE_URL: URL } });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

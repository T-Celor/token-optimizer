// Builds the long-session repo in a temp dir and prints what its added commits add: bytes and
// approximate tokens (bytes / 4) per file and in total, the commit count, and the expected
// `long` values. With --xl, the legacy commit after it is included, and the expected `xl` values
// are printed too. No model calls. Usage (from REPO): node benchmark/long_size.mjs [--xl]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo } from "./fixture_repo.mjs";

const xl = process.argv.includes("--xl");
const dir = mkdtempSync(join(tmpdir(), "long-size-"));
const expected = buildRepo(dir, { long: true, xl });
const git = (argv) => execFileSync("git", argv, { cwd: dir, encoding: "utf8" });
const tokens = (bytes) => Math.round(bytes / 4);

// The added files of the long commit (and, with --xl, of the legacy commit after it).
const base = git(["rev-parse", `HEAD~${xl ? 2 : 1}`]).trim();
const files = git(["diff", "--name-only", "--diff-filter=A", base, "HEAD"]).split("\n").filter(Boolean);
const groups = new Map();
let total = 0;
for (const f of files) {
  const bytes = statSync(join(dir, f)).size;
  const group = f.split("/").slice(0, f.startsWith("logs/archive/") || f.startsWith("src/legacy/") ? 2 : 1).join("/");
  groups.set(group, (groups.get(group) ?? 0) + bytes);
  total += bytes;
  console.log(`${f.padEnd(40)} ${String(bytes).padStart(9)} B  ~${tokens(bytes)} tok`);
}
console.log("");
for (const [group, bytes] of groups) {
  console.log(`${group.padEnd(40)} ${String(bytes).padStart(9)} B  ~${tokens(bytes)} tok`);
}
console.log(`${"TOTAL".padEnd(40)} ${String(total).padStart(9)} B  ~${tokens(total)} tok`);

const commits = git(["log", "--oneline"]).split("\n").filter(Boolean).length;
console.log(`\ncommits (git log --oneline | wc -l): ${commits}`);
console.log("expected long values:");
console.log(JSON.stringify(expected.long, null, 2));
if (xl) console.log("expected xl values:\n" + JSON.stringify(expected.xl, null, 2));

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows can keep read-only git object files; the temp dir is then left behind.
}

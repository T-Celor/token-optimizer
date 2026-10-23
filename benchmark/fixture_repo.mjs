// Builds the throwaway git repository the A/B scenarios run in, and defines the scenarios
// with their graders. The content is the same on every build; commit hashes are read back
// from the built repo, so grading never depends on the git version.
//
// Each scenario makes the agent run a command whose output is big enough for the stack to
// act on (RTK rewrites git, grep, npm and cat; Headroom and pxpipe see large tool results),
// and asks for an exact value so the report shows whether compression cost accuracy.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";

const AUTHOR = {
  GIT_AUTHOR_NAME: "Dana Lee",
  GIT_AUTHOR_EMAIL: "dana@example.com",
  GIT_COMMITTER_NAME: "Dana Lee",
  GIT_COMMITTER_EMAIL: "dana@example.com",
};

// Small seeded PRNG so the log and the filler history are identical on every build.
function rng(seed) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const MODULES = [
  "refunds", "credit_notes", "dunning", "ledger", "payouts", "disputes", "tax_rules", "currencies",
  "reminders", "statements", "coupons", "plans", "usage", "metering", "exports", "imports",
  "webhooks", "audit", "vat", "receipts", "adjustments", "proration", "trials", "seats",
];
const PHRASES = [
  "normalize field names", "drop unused branch", "log the payload size", "rename handler args",
  "guard against empty payloads", "align error messages", "inline small helper", "sort keys before hashing",
];

const sessionJs = (timeout) => `// Session handling for the billing API.
export const SESSION_TIMEOUT_MINUTES = ${timeout};

const sessions = new Map();

export function createSession(userId) {
  if (!userId) throw new Error("userId is required");
  const id = \`s_\${userId}_\${sessions.size + 1}\`;
  sessions.set(id, { userId, expiresAt: Date.now() + SESSION_TIMEOUT_MINUTES * 60_000 });
  return id;
}

export function isExpired(id, now = Date.now()) {
  const s = sessions.get(id);
  return !s || s.expiresAt <= now;
}
`;

const retryJs = (retries, backoff, jitter) => `// Retry policy for calls to the payment provider.
export const MAX_RETRIES = ${retries};
export const MAX_RETRY_BACKOFF_MS = ${backoff};

export function backoffMs(attempt) {
  return Math.min(MAX_RETRY_BACKOFF_MS, 100 * 2 ** attempt)${jitter ? " + Math.floor(Math.random() * 50)" : ""};
}
`;

const invoiceJs = (validate, rounding) => `// Invoice totals. All amounts are integer cents.
export function invoiceTotal(lines, taxRate) {
${validate ? `  for (const l of lines) {
    if (!Number.isInteger(l.qty) || l.qty < 0) throw new Error(\`invalid qty: \${l.qty}\`);
  }
` : ""}  const subtotal = lines.reduce((sum, l) => sum + l.unitCents * l.qty, 0);
  const tax = Math.${rounding}(subtotal * taxRate);
  return subtotal + tax;
}
`;

const moduleJs = (name) => `import { createSession } from "../session.js";

// ${name} handler
export function handle_${name}(userId, payload) {
  const session = createSession(userId);
  return { session, kind: "${name}", size: JSON.stringify(payload).length };
}
`;

const TESTS = {
  "test/invoice.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { invoiceTotal } from "../src/invoice.js";

test("total includes tax rounded to the nearest cent", () => {
  assert.equal(invoiceTotal([{ unitCents: 1999, qty: 3 }], 0.077), 6459);
});

test("empty invoice is zero", () => {
  assert.equal(invoiceTotal([], 0.077), 0);
});
`,
  "test/session.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, isExpired } from "../src/session.js";

test("new session is not expired", () => {
  assert.equal(isExpired(createSession("u1")), false);
});

test("session needs a user", () => {
  assert.throws(() => createSession(""));
});
`,
  "test/retry.test.js": `import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_BACKOFF_MS } from "../src/retry.js";

test("backoff cap is positive", () => {
  assert.ok(MAX_RETRY_BACKOFF_MS > 0);
});
`,
};

// One JSON line per request. Exactly one request returns 503 (at line index `at503`); the
// 502s at `at502` are distractors. `drift` (500s with code E_LEDGER_DRIFT) and `slowAt` (one
// line with latency `slowMs`) are optional plants for the archived week.
function appLog(rand, hex, { start, lines: count, stepMs, at503, at502, drift = [], slowAt = -1, slowMs = 0 }) {
  const lines = [];
  let requestId503 = null;
  let slowRequestId = null;
  for (let i = 0; i < count; i++) {
    const status = i === at503 ? 503 : at502.includes(i) ? 502 : drift.includes(i) ? 500 : rand() < 0.08 ? 404 : 200;
    const requestId = hex(12);
    if (status === 503) requestId503 = requestId;
    if (i === slowAt) slowRequestId = requestId;
    lines.push(JSON.stringify({
      ts: new Date(start + i * stepMs).toISOString(),
      level: status >= 500 ? "error" : "info",
      request_id: requestId,
      method: rand() < 0.7 ? "GET" : "POST",
      path: `/api/invoices/${1000 + Math.floor(rand() * 9000)}`,
      status,
      duration_ms: i === slowAt ? slowMs : 20 + Math.floor(rand() * 400),
      user: `u${Math.floor(rand() * 300)}`,
      ...(drift.includes(i) ? { code: "E_LEDGER_DRIFT" } : {}),
    }));
  }
  return { text: lines.join("\n") + "\n", requestId503, slowRequestId };
}

// Exact facts planted in the long docs; the expected answers are built from the same values.
const FACTS = {
  retentionDays: 730,
  batchSize: 250,
  flag: "billing.ledger_shadow_writes",
  deprecatedPath: "/api/v1/invoices/legacy-total",
};

const DOC_SUBJECTS = [
  "the invoice service", "the ledger writer", "the payout worker", "the refund queue",
  "the reminder job", "the tax engine", "the webhook dispatcher", "the usage meter",
];
const DOC_VERBS = ["records", "validates", "reconciles", "emits", "archives", "replays", "checks", "rounds"];
const DOC_OBJECTS = [
  "every posting against the ledger", "the currency rounding rules", "a snapshot of each account",
  "the outbound events for each tenant", "idempotency keys for retried calls", "the totals shown on statements",
];
const DOC_CLAUSES = [
  "so operators can audit one month without a full scan", "which keeps the on-call rotation small",
  "before the nightly export starts", "whenever a provider returns an ambiguous status",
  "because support asked for it twice last quarter", "even while the upstream queue is slow",
];
const DOC_HEADINGS = ["Goals", "Current behaviour", "Failure modes", "Rollout", "Open questions", "Operations", "Testing", "Compatibility"];

// Design-doc prose: `paragraphs` paragraphs under headings. The `plants` sentences go into the
// third, ninth and fifteenth paragraphs, so they read as part of the text.
function prose(rand, title, paragraphs, plants) {
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  const out = [`# ${title}`, ""];
  for (let p = 0; p < paragraphs; p++) {
    if (p % 6 === 0) out.push(`## ${pick(DOC_HEADINGS)}`, "");
    const sentences = Array.from({ length: 5 + Math.floor(rand() * 3) }, () =>
      `${cap(pick(DOC_SUBJECTS))} ${pick(DOC_VERBS)} ${pick(DOC_OBJECTS)} ${pick(DOC_CLAUSES)}.`);
    if (p % 6 === 2 && plants.length) sentences.push(plants.shift());
    out.push(sentences.join(" "), "");
  }
  return out.join("\n");
}

// Four passing tests per module, so the suite's output has the size of a real one.
const moduleTest = (name) => `import { test } from "node:test";
import assert from "node:assert/strict";
import { handle_${name} } from "../../src/modules/${name}.js";

test("${name}: returns a session", () => {
  assert.match(handle_${name}("u1", {}).session, /^s_u1_/);
});

test("${name}: keeps the kind", () => {
  assert.equal(handle_${name}("u1", {}).kind, "${name}");
});

test("${name}: measures the payload", () => {
  assert.equal(handle_${name}("u1", { a: 1 }).size, 7);
});

test("${name}: needs a user", () => {
  assert.throws(() => handle_${name}("", {}));
});
`;

// xl scenario: six large legacy modules under src/legacy/, ~80 KB each, read in full by the agent.
// Each hides three facts that only a full read finds: a constant near the end (the step's ANSWER),
// the function whose JSDoc states a rule, and an error code thrown in one branch. XL_CROSS_CODE
// is thrown by one file only (the cross-file step). Own rng, so every earlier fact is unchanged.
const XL_CROSS_CODE = "E_PRORATION_WINDOW_INVERTED";
const LEGACY_BYTES = 80_000;
const LEGACY_NOUNS = [
  "invoice", "seat", "ledgerEntry", "refund", "creditNote", "usageRecord",
  "payout", "taxLine", "dunningNotice", "planChange", "exportPart", "priceEntry",
];
const LEGACY_ACTIONS = [
  "resolve", "normalize", "classify", "reconcile", "clamp", "prorate", "defer",
  "net", "round", "bucket", "label", "route", "reprice", "settle",
];
const LEGACY_FIELDS = ["region", "plan", "tier", "channel", "segment", "currency"];
const LEGACY_VALUES = ["standard", "reduced", "exempt", "legacy", "partner"];
const LEGACY_CONDS = [
  "when the account is in good standing", "for accounts older than one billing cycle",
  "if the region requires gross reporting", "once the period has closed",
  "for trial accounts with a card on file", "when the provider returned a soft decline",
  "for plans billed annually in advance", "when the customer disputed the line",
];
const LEGACY_NOTES = [
  "legacy path kept for the 2019 migration", "do not reorder: the nightly export depends on this order",
  "rounding happens once, at the end, on purpose", "TODO(ops): remove once the v1 reports are retired",
  "see the runbook section on manual overrides", "finance signed off on this threshold in Q2",
  "keep the branch order, the audit trail is built from it", "values are integer cents, never floats",
];

// The six files. `rule` is the function whose JSDoc states a rule; `error` throws `code` in one branch.
const LEGACY = [
  {
    key: "billing_engine",
    title: "billing engine",
    constant: { name: "GRACE_PERIOD_DAYS", value: 17 },
    rule: {
      fn: "billDormantSeatsAtReducedRate",
      doc: [
        "Dormant seats: a seat idle for 90 days or more is billed at 40 percent of its list price.",
        "The seat report marks a seat as dormant; every other seat keeps its list price.",
      ],
      params: ["@param {object} seat one seat row with idleDays and listCents", "@returns {number} amount in integer cents"],
      body: `export function billDormantSeatsAtReducedRate(seat) {
  if (!seat || !Number.isInteger(seat.idleDays)) return 0;
  if (seat.idleDays >= 90) return Math.round((seat.listCents * 40) / 100);
  return seat.listCents;
}`,
    },
    error: {
      code: "E_BILLING_CURRENCY_MISMATCH",
      doc: [
        "Every line of an invoice must be in the invoice currency before totals are built.",
        "A mismatched line stops the run; the finance team converts it by hand.",
      ],
      params: ["@param {object} invoice an invoice with a currency and lines", "@returns {true} when every line matches"],
      body: `export function reconcileInvoiceCurrency(invoice) {
  for (const line of invoice.lines ?? []) {
    if (line.currency !== invoice.currency) {
      throw new LegacyError(
        "E_BILLING_CURRENCY_MISMATCH",
        "line " + line.id + " is " + line.currency + ", invoice is " + invoice.currency,
      );
    }
  }
  return true;
}`,
    },
  },
  {
    key: "ledger_sync",
    title: "ledger sync",
    constant: { name: "SUSPENSE_SWEEP_LIMIT", value: 412 },
    rule: {
      fn: "carryResidualCentsToSuspense",
      doc: [
        "Rounding carry-over: residual cents below one unit of the ledger currency move to suspense.",
        "They never move to revenue; the revenue line keeps exactly what the customer was charged.",
      ],
      params: ["@param {object} entry with debitCents and creditCents", "@returns {object} revenueCents and suspenseCents"],
      body: `export function carryResidualCentsToSuspense(entry) {
  const residual = (entry.debitCents ?? 0) - (entry.creditCents ?? 0);
  return { revenueCents: entry.creditCents ?? 0, suspenseCents: Math.abs(residual) % 100 };
}`,
    },
    error: {
      code: "E_LEDGER_SEQUENCE_GAP",
      doc: [
        "Entries of one ledger arrive with consecutive sequence numbers; a repeated number is ignored.",
        "A jump in the numbers stops the sync, because the missing entries cannot be replayed safely.",
      ],
      params: ["@param {object} ledgerState with lastSeq", "@param {object} entry with seq", "@returns {string} duplicate or next"],
      body: `export function checkEntrySequence(ledgerState, entry) {
  const expected = ledgerState.lastSeq + 1;
  if (entry.seq < expected) return "duplicate";
  if (entry.seq > expected) {
    throw new LegacyError(
      "E_LEDGER_SEQUENCE_GAP",
      "expected sequence " + expected + " but got " + entry.seq,
    );
  }
  return "next";
}`,
    },
  },
  {
    key: "tax_rules",
    title: "tax rules",
    constant: { name: "REVERSE_CHARGE_CUTOFF_DAY", value: 9 },
    rule: {
      fn: "applyZeroRatedExportRule",
      doc: [
        "Zero-rated exports: a business supply shipped outside the seller region is taxed at 0 percent.",
        "The line then carries the reverse-charge note, and the buyer accounts for the tax.",
      ],
      params: ["@param {object} line with buyerIsBusiness, shipToRegion and sellerRegion", "@returns {object} rate and note"],
      body: `export function applyZeroRatedExportRule(line) {
  if (line.buyerIsBusiness !== true) return { rate: line.standardRate, note: null };
  if (line.shipToRegion === line.sellerRegion) return { rate: line.standardRate, note: null };
  return { rate: 0, note: "reverse charge" };
}`,
    },
    error: {
      code: "E_TAX_RATE_TABLE_STALE",
      doc: [
        "A quote is built only from a rate table that is at most 45 days old.",
        "An older table blocks the quote until the tax team loads the current one.",
      ],
      params: ["@param {object} table with asOfMs", "@param {number} nowMs current time in milliseconds", "@returns {true}"],
      body: `export function requireFreshRateTable(table, nowMs) {
  const ageDays = (nowMs - table.asOfMs) / 86400000;
  if (ageDays > 45) {
    throw new LegacyError(
      "E_TAX_RATE_TABLE_STALE",
      "rate table is " + Math.floor(ageDays) + " days old",
    );
  }
  return true;
}`,
    },
  },
  {
    key: "dunning",
    title: "dunning",
    constant: { name: "FINAL_NOTICE_MAX_ATTEMPTS", value: 6 },
    rule: {
      fn: "escalateStalledAccount",
      doc: [
        "Stalled accounts: an account still unpaid after its final notice moves to collections.",
        "Collections holds the account for 60 days before any write-off is considered.",
      ],
      params: ["@param {object} account with unpaidCycles and finalNoticeSent", "@returns {object} status and holdDays"],
      body: `export function escalateStalledAccount(account) {
  if (account.unpaidCycles < 3) return { status: "active", holdDays: 0 };
  if (account.finalNoticeSent !== true) return { status: "final_notice", holdDays: 0 };
  return { status: "collections", holdDays: 60 };
}`,
    },
    error: {
      code: "E_DUNNING_NOTICE_LOOP",
      doc: [
        "A notice is never sent twice in a row with the same template.",
        "A repeat means the state machine is stuck, so the run stops for a person to look at it.",
      ],
      params: ["@param {object} account with id, lastTemplate and noticeCount", "@param {string} template next template"],
      body: `export function planNextNotice(account, template) {
  if (account.lastTemplate === template && account.noticeCount > 0) {
    throw new LegacyError(
      "E_DUNNING_NOTICE_LOOP",
      "template " + template + " repeated for account " + account.id,
    );
  }
  return template;
}`,
    },
  },
  {
    key: "proration",
    title: "proration",
    constant: { name: "MIN_PRORATION_WINDOW_SECONDS", value: 3629 },
    rule: {
      fn: "creditUnusedTailOnDowngrade",
      doc: [
        "Downgrade credit: the unused tail of the old plan is credited pro rata to the second.",
        "The credit is rounded down, so a downgrade never credits more than the plan was charged.",
      ],
      params: ["@param {object} change with periodStartS, periodEndS, changedAtS and oldPriceCents", "@returns {number} credit in cents"],
      body: `export function creditUnusedTailOnDowngrade(change) {
  const total = change.periodEndS - change.periodStartS;
  const unused = Math.max(0, change.periodEndS - change.changedAtS);
  if (total <= 0) return 0;
  return Math.floor((change.oldPriceCents * unused) / total);
}`,
    },
    error: {
      code: XL_CROSS_CODE,
      doc: [
        "A proration window must start before it ends; an inverted window cannot be credited.",
        "The window is checked before any credit is calculated from it.",
      ],
      params: ["@param {object} win with startsAtS and endsAtS", "@returns {number} window length in seconds"],
      body: `export function validateProrationWindow(win) {
  if (win.endsAtS < win.startsAtS) {
    throw new LegacyError("E_PRORATION_WINDOW_INVERTED", "window ends before it starts");
  }
  return win.endsAtS - win.startsAtS;
}`,
    },
  },
  {
    key: "export_jobs",
    title: "export jobs",
    constant: { name: "EXPORT_CHECKSUM_ROWS", value: 2048 },
    rule: {
      fn: "splitExportIntoSignedParts",
      doc: [
        "Large exports: a file over 50 MB is split into parts; each part is later signed with its own rows.",
        "Rows are never divided between two parts, so every part can be verified on its own.",
      ],
      params: ["@param {object[]} rows the export rows", "@param {number} maxBytes size limit per part", "@returns {object[][]} parts"],
      body: `export function splitExportIntoSignedParts(rows, maxBytes = 50 * 1024 * 1024) {
  const parts = [];
  let current = [];
  let size = 0;
  for (const row of rows) {
    const bytes = JSON.stringify(row).length;
    if (size + bytes > maxBytes && current.length > 0) {
      parts.push(current);
      current = [];
      size = 0;
    }
    current.push(row);
    size += bytes;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}`,
    },
    error: {
      code: "E_EXPORT_CHECKSUM_MISMATCH",
      doc: [
        "Each part's checksum must match the rows it carries before the part is handed to the download link.",
        "A mismatch is reported with the part index, and the download is withheld.",
      ],
      params: ["@param {object} part with index and checksum", "@param {string} expectedHex checksum from the manifest"],
      body: `export function verifyPartChecksum(part, expectedHex) {
  if (part.checksum !== expectedHex) {
    throw new LegacyError("E_EXPORT_CHECKSUM_MISMATCH", "part " + part.index + " checksum differs");
  }
  return true;
}`,
    },
  },
];

const capitalize = (s) => s[0].toUpperCase() + s.slice(1);
// A JSDoc block: description lines, then the parameter and return notes.
const legacyDoc = (doc, params) => ["/**", ...doc.map((d) => ` * ${d}`), ...params.map((p) => ` * ${p}`), " */"];

// One generated function, in one of three shapes (pricing, validation, grouping), each with its own
// JSDoc and branch order. `n` makes every name and constant unique within the file.
function legacyFunction(rand, n) {
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo));
  const action = pick(LEGACY_ACTIONS);
  const noun = pick(LEGACY_NOUNS);
  const lower = noun.replace(/([A-Z])/g, " $1").toLowerCase();
  const field = pick(LEGACY_FIELDS);
  const value = pick(LEGACY_VALUES);
  const name = `${action}${capitalize(noun)}${n}`;
  const doc = [
    `Applies the ${action} step to the ${lower} amount ${pick(LEGACY_CONDS)}.`,
    `Note: ${pick(LEGACY_NOTES)}.`,
    `Callers pass the full billing context; a missing ${field} is treated as the default tier.`,
  ];
  if (n % 3 === 1) {
    const limit = int(500, 90000);
    const cut = int(3, 40);
    const pct = int(55, 99);
    const floor = int(50, 900);
    const add = int(0, 250);
    return [
      ...legacyDoc(doc, [
        "@param {object} ctx billing context: region, plan, tier, channel, segment, cycleDays, openBalanceCents",
        "@param {number} amountCents amount before the adjustment, in integer cents",
        "@returns {number} adjusted amount in integer cents, never negative",
      ]),
      `export function ${name}(ctx, amountCents) {`,
      "  if (!ctx || !Number.isInteger(amountCents)) return 0;",
      `  const LIMIT_${n} = ${limit};`,
      "  let adjusted = amountCents;",
      `  if (ctx.${field} === "${value}" && ctx.cycleDays > ${cut}) {`,
      `    adjusted = Math.round((adjusted * ${pct}) / 100);`,
      `  } else if (ctx.openBalanceCents > LIMIT_${n}) {`,
      `    adjusted -= Math.min(adjusted, ${floor});`,
      "  } else {",
      `    adjusted += ${add};`,
      "  }",
      "  return Math.max(0, adjusted);",
      "}",
      "",
    ].join("\n");
  }
  if (n % 3 === 2) {
    const limit = int(10000, 900000);
    return [
      ...legacyDoc(doc, [
        "@param {object} record one row of the export, with a string field and an amount in cents",
        "@returns {{ok: boolean, reason: string|null}} whether the row may be written",
      ]),
      `export function ${name}(record) {`,
      `  if (!record || typeof record.${field} !== "string") {`,
      `    throw new TypeError("${lower}: ${field} is required");`,
      "  }",
      `  if (record.amountCents > ${limit}) {`,
      `    return { ok: false, reason: "above the ${field} cap" };`,
      "  }",
      "  return { ok: true, reason: null };",
      "}",
      "",
    ].join("\n");
  }
  return [
    ...legacyDoc(doc, [
      "@param {object[]} rows rows of one batch, each with the grouping fields and amountCents",
      "@returns {Map<string, {count: number, cents: number}>} totals per group key",
    ]),
    `export function ${name}(rows) {`,
    "  const totals = new Map();",
    "  for (const row of rows) {",
    `    const key = row.${field} + ":" + (row.${pick(LEGACY_FIELDS)} ?? "none");`,
    "    const bucket = totals.get(key) ?? { count: 0, cents: 0 };",
    "    bucket.count += 1;",
    "    bucket.cents += Number(row.amountCents) || 0;",
    "    totals.set(key, bucket);",
    "  }",
    "  return totals;",
    "}",
    "",
  ].join("\n");
}

// One legacy module: header, error class, generated functions with the two planted rules at 40%
// and 80% of the size, then the tunables and export at the very end.
function legacyModule(rand, f) {
  const out = [
    `// Legacy ${f.title}, kept for the 2019 migration. New code uses the v2 pipeline; do not reorder.`,
    "// The nightly job calls these functions in file order, so a change here can shift its output.",
    "",
    "class LegacyError extends Error {",
    "  constructor(code, message) {",
    "    super(message);",
    '    this.name = "LegacyError";',
    "    this.code = code;",
    "  }",
    "}",
    "",
  ];
  let bytes = out.join("\n").length;
  const emit = (block) => {
    out.push(block);
    bytes += block.length + 1;
  };
  const plant = (spec) => [...legacyDoc(spec.doc, spec.params), spec.body, ""].join("\n");
  let ruleDone = false;
  let errorDone = false;
  for (let n = 1; bytes < LEGACY_BYTES; n++) {
    if (!ruleDone && bytes >= LEGACY_BYTES * 0.4) {
      emit(plant(f.rule));
      ruleDone = true;
    }
    if (!errorDone && bytes >= LEGACY_BYTES * 0.8) {
      emit(plant(f.error));
      errorDone = true;
    }
    emit(legacyFunction(rand, n));
  }
  emit([
    "// Tunables read by the nightly job. A change needs a finance sign-off and a note in the runbook.",
    `const ${f.constant.name} = ${f.constant.value};`,
    "",
    `export const LEGACY_MODULE = { name: "${f.key}", version: "1.8.3", owner: "billing-core" };`,
    "",
  ].join("\n"));
  return out.join("\n");
}

// Builds the repo in `dir` (must exist and be empty) and returns the expected answers.
// The default is the small repo of the quick A/B (~34 commits, 5 tests, one 150-line log).
// `workday: true` builds the larger repo of the work-session benchmark: ~95 commits, ~100
// tests, and two days of logs (~750 lines) with a decoy 503 at the same time on the wrong day.
// `long: true` implies workday and adds, in a final commit, a week of archived logs, two design
// docs and a customer export (its expected answers are returned under `long`). `xl: true` implies
// long and adds, in one more final commit, six large legacy modules (expected answers under `xl`).
export function buildRepo(dir, { workday = false, long = false, xl = false } = {}) {
  long ||= xl;
  workday ||= long;
  const rand = rng(42);
  const hex = (n) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  let clock = Date.UTC(2026, 8, 1, 9, 0, 0) / 1000;

  const write = (rel, text) => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  const git = (argv, env = {}) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...argv], {
      cwd: dir,
      env: { ...process.env, ...AUTHOR, ...env },
      encoding: "utf8",
    }).trim();
  const commit = (message) => {
    clock += 7 * 3600;
    const date = `${clock} +0000`;
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git(["rev-parse", "HEAD"]);
  };

  const modules = Object.fromEntries(MODULES.map((m) => [m, moduleJs(m)]));
  const changelog = ["# Changelog", ""];
  let ticket = 400;
  const filler = (count) => {
    for (let c = 0; c < count; c++) {
      ticket += 1 + Math.floor(rand() * 9);
      const phrase = PHRASES[Math.floor(rand() * PHRASES.length)];
      const picked = [...MODULES].sort(() => rand() - 0.5).slice(0, 4);
      for (const m of picked) {
        modules[m] += `// BILL-${ticket}: ${phrase}\n`;
        write(`src/modules/${m}.js`, modules[m]);
      }
      changelog.push(`- BILL-${ticket}: ${phrase} in ${picked.join(", ")}`);
      write("CHANGELOG.md", changelog.join("\n") + "\n");
      commit(`chore(${picked[0]}): ${phrase} (BILL-${ticket})`);
    }
  };

  // `init -b` needs git 2.28+; symbolic-ref works on older git too (hashes do not depend on it).
  git(["init", "-q"]);
  git(["symbolic-ref", "HEAD", "refs/heads/main"]);
  write("package.json", JSON.stringify({
    name: "billing-service",
    version: "1.0.0",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2) + "\n");
  write("README.md", "# billing-service\n\nInvoices, sessions and payment retries.\n");
  write("src/session.js", sessionJs(30));
  write("src/retry.js", retryJs(3, 2000, false));
  write("src/invoice.js", invoiceJs(true, "round"));
  for (const [m, text] of Object.entries(modules)) write(`src/modules/${m}.js`, text);
  for (const [p, text] of Object.entries(TESTS)) write(p, text);
  let log;
  if (workday) {
    for (const m of MODULES) write(`test/modules/${m}.test.js`, moduleTest(m));
    // The decoy: a 503 at 12:02 UTC on 11 October. The real one is at 12:02 UTC on 12 October.
    write("logs/app-2026-10-11.log", appLog(rand, hex, { start: Date.UTC(2026, 9, 11, 11, 55, 0), lines: 300, stepMs: 1500, at503: 290, at502: [150] }).text);
    log = appLog(rand, hex, { start: Date.UTC(2026, 9, 12, 11, 50, 0), lines: 450, stepMs: 1700, at503: 434, at502: [120, 431, 437] });
    write("logs/app-2026-10-12.log", log.text);
  } else {
    // ~25k characters, under Claude Code's Bash output limit.
    log = appLog(rand, hex, { start: Date.UTC(2026, 9, 12, 12, 0, 0), lines: 150, stepMs: 1370, at503: 97, at502: [41, 128] });
    write("logs/app.log", log.text);
  }
  commit("feat: initial billing service");

  const scale = workday ? 3 : 1;
  filler(9 * scale);
  write("README.md", "# billing-service\n\nInvoices, sessions and payment retries.\n\nSessions expire after an idle period (see src/session.js).\n\nRun the tests with `npm test`.\n");
  commit("docs: describe session lifecycle");
  git(["tag", "v1.0"]);

  filler(8 * scale);
  write("src/session.js", sessionJs(45));
  const timeoutCommit = commit("fix(session): raise idle timeout to 45 minutes");
  filler(5 * scale);
  write("src/retry.js", retryJs(3, 7500, true));
  const backoffCommit = commit("perf(retry): allow longer backoff for slow providers");
  filler(1 * scale);
  write("src/invoice.js", invoiceJs(false, "floor"));
  commit("refactor(invoice): simplify validation and use integer tax");
  write("src/retry.js", retryJs(8, 7500, true));
  commit("chore(retry): retry more on provider errors");
  filler(5 * scale);

  // Archived week, docs and customer export: a final commit after the workday history, so every
  // earlier hash and answer is unchanged. It uses its own rng.
  let longExpected;
  if (long) {
    const r2 = rng(7);
    const hex2 = (n) => Array.from({ length: n }, () => Math.floor(r2() * 16).toString(16)).join("");
    // Per day: one 502 (three on 4 Oct), a slowest request that grows with the day (so 7 Oct
    // has the week's slowest), and E_LEDGER_DRIFT errors on 5 Oct only.
    const drift = [60, 100, 140, 180, 220, 260];
    let slow = { ms: 0, requestId: null };
    for (let d = 1; d <= 7; d++) {
      const slowMs = 880 + 50 * d;
      const day = appLog(r2, hex2, {
        start: Date.UTC(2026, 9, d), lines: 350, stepMs: 240_000, at503: -1,
        at502: d === 4 ? [40, 170, 301] : [((d * 71) % 300) + 20],
        drift: d === 5 ? drift : [],
        slowAt: ((d * 97) % 300) + 25, slowMs,
      });
      write(`logs/archive/app-2026-10-0${d}.log`, day.text);
      if (slowMs > slow.ms) slow = { ms: slowMs, requestId: day.slowRequestId };
    }

    const PLANS = ["free", "pro", "team", "enterprise"];
    const COUNTRIES = ["DE", "FR", "US", "GB", "NL", "ES", "IT", "BR", "JP", "AU"];
    const customers = Array.from({ length: 1500 }, (_, i) => {
      const plan = PLANS[Math.floor(r2() * PLANS.length)];
      return {
        id: `c_${String(i + 1).padStart(5, "0")}`,
        plan,
        mrr_cents: plan === "free" ? 0 : 900 + Math.floor(r2() * 500000),
        country: COUNTRIES[Math.floor(r2() * COUNTRIES.length)],
        created_at: new Date(Date.UTC(2023, 0, 1) + Math.floor(r2() * 1000) * 86_400_000).toISOString().slice(0, 10),
      };
    });
    const top = customers.reduce((a, b) => (b.mrr_cents > a.mrr_cents ? b : a));
    if (customers.filter((c) => c.mrr_cents === top.mrr_cents).length !== 1) throw new Error("tied top customer");
    write("data/customers-export.json", "[\n" + customers.map((c) => "  " + JSON.stringify(c)).join(",\n") + "\n]\n");

    write("docs/billing-design.md", prose(r2, "Billing design", 54, [
      `Ledger entries are kept for ${FACTS.retentionDays} days after their period closes, and the retention job deletes older rows each night.`,
      `New posting code sits behind the feature flag ${FACTS.flag}, which stays off in production until the rollout review.`,
      `The endpoint ${FACTS.deprecatedPath} is deprecated; clients should move to the v2 totals endpoint before the next major release.`,
    ]));
    write("docs/ledger-migration.md", prose(r2, "Ledger migration", 54, [
      `Each run copies ledger rows in batches of ${FACTS.batchSize} and stores the last copied row id after every batch, so a failed run resumes where it stopped.`,
    ]));
    commit("chore: add archived logs, design docs and customer export");

    longExpected = {
      day502: "2026-10-04",
      slowestRequestId: slow.requestId,
      slowestMs: slow.ms,
      driftDay: "2026-10-05",
      driftCount: drift.length,
      retentionDays: FACTS.retentionDays,
      batchSize: FACTS.batchSize,
      flag: FACTS.flag,
      deprecatedPath: FACTS.deprecatedPath,
      enterpriseCount: customers.filter((c) => c.plan === "enterprise").length,
      topCustomer: top.id,
    };
  }

  // The legacy modules, one commit after the archive: ~120k tokens to read in full. Own rng.
  let xlExpected;
  if (xl) {
    const r3 = rng(11);
    for (const f of LEGACY) write(`src/legacy/${f.key}.js`, legacyModule(r3, f));
    commit("chore: add legacy billing modules");
    xlExpected = {
      crossFile: `${LEGACY.find((f) => f.error.code === XL_CROSS_CODE).key}.js`,
      ...Object.fromEntries(LEGACY.map((f) => [f.key, { constant: String(f.constant.value), rule: f.rule.fn, code: f.error.code }])),
    };
  }

  const createSessionLine = sessionJs(45).split("\n").findIndex((l) => l.startsWith("export function createSession")) + 1;
  return {
    timeoutCommit,
    backoffCommit,
    requestId503: log.requestId503,
    backoff: "7500",
    createSession: `src/session.js:${createSessionLine}`,
    testCount: testCount(dir),
    head: git(["rev-parse", "HEAD"]),
    ...(longExpected ? { long: longExpected } : {}),
    ...(xlExpected ? { xl: xlExpected } : {}),
  };
}

// Number of tests the suite runs in `cwd` (from node's TAP summary).
function testCount(cwd) {
  const out = spawnSync("node", ["--test", "--test-reporter=tap"], { cwd, encoding: "utf8" }).stdout ?? "";
  return Number(out.match(/^# tests (\d+)$/m)?.[1] ?? 0);
}

const suitePasses = (cwd) => spawnSync("node", ["--test"], { cwd, stdio: "ignore" }).status === 0;
// Compared with the commit the repo was built at, so it holds even if the agent commits.
const testsUntouched = (cwd, head) =>
  spawnSync("git", ["diff", "--quiet", "--diff-filter=MD", head, "--", "test/"], { cwd }).status === 0;
function addedTestFiles(cwd, head) {
  const git = (argv) => spawnSync("git", argv, { cwd, encoding: "utf8" }).stdout.trim();
  return [
    git(["ls-files", "--others", "--exclude-standard", "test/"]),
    git(["diff", "--name-only", "--diff-filter=A", head, "--", "test/"]),
  ].join("\n").trim();
}

// Last `ANSWER=...` line of the agent's final message.
export function answerOf(text) {
  const all = [...(text ?? "").matchAll(/ANSWER=\s*`?([^\s`]+)`?/g)];
  return all.length ? all[all.length - 1][1].replace(/^\.\//, "") : null;
}

const BULLETS = "Answer in at most 5 bullet points";

export const SCENARIOS = {
  git_history: {
    prompt: `Run \`git log --stat\` in this repository. Find the commit that raised the session idle timeout. ${BULLETS}, and end with a line \`ANSWER=<full 40-character commit hash>\`.`,
    check: (text, exp) => answerOf(text) === exp.timeoutCommit,
  },
  log_triage: {
    prompt: `Run \`cat logs/app.log\`. Exactly one request returned HTTP 503. ${BULLETS}, and end with a line \`ANSWER=<its request_id, exactly as logged>\`.`,
    check: (text, exp) => answerOf(text) === exp.requestId503,
  },
  review_diff: {
    prompt: `Run \`git diff v1.0..HEAD\`. Say what is risky in this change. ${BULLETS}, and end with a line \`ANSWER=<new value of MAX_RETRY_BACKOFF_MS>\`.`,
    check: (text, exp) => answerOf(text) === exp.backoff,
  },
  code_search: {
    prompt: `Run \`grep -rn "createSession" src\`. Where is session creation implemented? ${BULLETS}, and end with a line \`ANSWER=<file>:<line of the function definition>\`.`,
    check: (text, exp) => answerOf(text) === exp.createSession,
  },
  fix_test: {
    prompt: `Run \`npm run test\`. One test fails. Fix the root cause in src/ with the smallest correct change (do not edit the tests), then run \`npm run test\` again. ${BULLETS}.`,
    // Graded on the repo itself: tests pass and the test files are untouched.
    check: (_text, exp, cwd) => suitePasses(cwd) && testsUntouched(cwd, exp.head),
  },
};

// The work-session benchmark: seven requests in a row in one session, phrased the way a
// developer would ask, without naming commands, so the agent picks its own tools. Context
// grows from step to step as in real work. Steps with `check` are graded right after they
// finish; the others measure cost only.
export const WORKDAY_STEPS = [
  {
    name: "orient",
    prompt: "I'm new on this repository. Give me a short map of it: what it does, the main parts, and how to run the tests.",
  },
  {
    name: "ci_red",
    prompt: "CI is red on main. Find which test fails and why, but don't change anything yet. End with a line `ANSWER=<path of the failing test file>`.",
    check: (text) => answerOf(text) === "test/invoice.test.js",
  },
  {
    name: "fix",
    prompt: "Fix the root cause with the smallest correct change. Don't edit the existing tests. Make sure the whole suite passes.",
    check: (_text, exp, cwd) => suitePasses(cwd) && testsUntouched(cwd, exp.head),
  },
  {
    name: "incident",
    prompt: "Different issue: a customer got an HTTP 503 from us around 12:02 UTC on 12 October. Find that request in the logs. End with a line `ANSWER=<its request_id, exactly as logged>`.",
    check: (text, exp) => answerOf(text) === exp.requestId503,
  },
  {
    name: "history",
    prompt: "Which commit since the v1.0 tag changed the retry backoff cap, and what is the new cap? End with a line `ANSWER=<full 40-character commit hash>`.",
    check: (text, exp) => answerOf(text) === exp.backoffCommit,
  },
  {
    name: "regression_test",
    prompt: "Add a regression test for the bug you fixed earlier, in a new test file, and run the whole suite.",
    // A new test file, more tests than before, existing tests untouched, suite green.
    check: (_text, exp, cwd) =>
      addedTestFiles(cwd, exp.head) !== "" && testsUntouched(cwd, exp.head) && suitePasses(cwd) && testCount(cwd) > exp.testCount,
  },
  {
    name: "pr_summary",
    prompt: "Write the pull request description for your changes: a title and at most 5 bullet points.",
  },
];

// True when a file under src/ in `cwd` contains `text`.
const mentions = (cwd, text) => {
  const dir = join(cwd, "src");
  try {
    return readdirSync(dir, { recursive: true }).some((f) => {
      try {
        return readFileSync(join(dir, f), "utf8").includes(text);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
};

// The long-session benchmark: the workday steps, then reads of the archived week, the design
// docs and the customer export, a code change, and three recalls of earlier findings. Prompts
// stay neutral; `exp.long` holds the expected values that buildRepo returns.
export const LONG_STEPS = [
  ...WORKDAY_STEPS,
  {
    name: "week_review",
    prompt: "Read every archived app log in logs/archive in full and summarize each day. Which day had three HTTP 502 responses? End with a line `ANSWER=<YYYY-MM-DD>`.",
    check: (text, exp) => answerOf(text) === exp.long.day502,
  },
  {
    name: "slowest",
    prompt: "Across the whole archived week, which request was the slowest? End with a line `ANSWER=<its request_id, exactly as logged>`.",
    check: (text, exp) => answerOf(text) === exp.long.slowestRequestId,
  },
  {
    name: "ledger_errors",
    prompt: "How many E_LEDGER_DRIFT errors are there in the archived logs for the week? End with a line `ANSWER=<count>`.",
    check: (text, exp) => answerOf(text) === String(exp.long.driftCount),
  },
  {
    name: "design_read",
    prompt: "Read docs/billing-design.md in full and summarize it. End with a line `ANSWER=<retention period in days>`.",
    check: (text, exp) => answerOf(text) === String(exp.long.retentionDays),
  },
  {
    name: "migration_read",
    prompt: "Read docs/ledger-migration.md in full and summarize the migration plan. End with a line `ANSWER=<batch size>`.",
    check: (text, exp) => answerOf(text) === String(exp.long.batchSize),
  },
  {
    name: "customers",
    prompt: "Look at the whole customer export in data/customers-export.json and describe the plan mix. End with a line `ANSWER=<number of enterprise customers>`.",
    check: (text, exp) => answerOf(text) === String(exp.long.enterpriseCount),
  },
  {
    name: "top_customer",
    prompt: "Which customer has the highest MRR in that export? End with a line `ANSWER=<customer id>`.",
    check: (text, exp) => answerOf(text) === exp.long.topCustomer,
  },
  {
    name: "code_change",
    prompt: "Add the feature flag from the billing design doc as a named constant in a new src/flags.js, and make sure the whole suite still passes. Don't edit the existing tests.",
    check: (_text, exp, cwd) => suitePasses(cwd) && testsUntouched(cwd, exp.head) && mentions(cwd, exp.long.flag),
  },
  {
    name: "recall_503",
    recall: true,
    prompt: "From what you already found earlier in this session, without running any command or reading any file again: what was the request_id of the HTTP 503 from the incident step? End with a line `ANSWER=<request_id>`.",
    check: (text, exp) => answerOf(text) === exp.requestId503,
  },
  {
    name: "recall_slowest",
    recall: true,
    prompt: "From what you already found earlier in this session, without running any command or reading any file again: what was the request_id of the slowest request of the week? End with a line `ANSWER=<request_id>`.",
    check: (text, exp) => answerOf(text) === exp.long.slowestRequestId,
  },
  {
    name: "recall_deprecated",
    recall: true,
    prompt: "From what you already found earlier in this session, without running any command or reading any file again: which endpoint path did the billing design doc mark as deprecated? End with a line `ANSWER=<path>`.",
    check: (text, exp) => answerOf(text) === exp.long.deprecatedPath,
  },
];

// The xl-session benchmark: the fifteen long requests that are not recalls, then one read per
// legacy module (each answer is a constant near the end of that file, found only by reading it
// all), a cross-file question, the three long recalls, and four recalls of the first two modules.
const RECALL = "From what you already found earlier in this session, without running any command or reading any file again: ";
const LEGACY_FILE_STEPS = LEGACY.map((f) => ({
  name: `legacy_${f.key}`,
  prompt: `Read src/legacy/${f.key}.js completely (all of it, in several reads if needed) and explain how it works. Name its rule functions and error codes. End with a line \`ANSWER=<value of ${f.constant.name}>\`.`,
  check: (text, exp) => answerOf(text) === exp.xl[f.key].constant,
}));
export const XL_STEPS = [
  ...LONG_STEPS.filter((s) => !s.recall),
  ...LEGACY_FILE_STEPS,
  {
    name: "legacy_errors",
    prompt: `Which of the legacy modules throws ${XL_CROSS_CODE}? End with a line \`ANSWER=<file name>\`.`,
    check: (text, exp) => answerOf(text) === exp.xl.crossFile,
  },
  ...LONG_STEPS.filter((s) => s.recall),
  {
    name: "recall_billing_rule",
    recall: true,
    prompt: RECALL + "which function in billing_engine.js applies the dormant-seat rule (seats idle for 90 days or more are billed at 40 percent)? End with a line `ANSWER=<function name>`.",
    check: (text, exp) => answerOf(text) === exp.xl.billing_engine.rule,
  },
  {
    name: "recall_billing_code",
    recall: true,
    prompt: RECALL + "which error code does billing_engine.js throw when an invoice line's currency differs from the invoice's? End with a line `ANSWER=<error code>`.",
    check: (text, exp) => answerOf(text) === exp.xl.billing_engine.code,
  },
  {
    name: "recall_ledger_rule",
    recall: true,
    prompt: RECALL + "which function in ledger_sync.js applies the rounding carry-over rule (residual cents go to suspense, never to revenue)? End with a line `ANSWER=<function name>`.",
    check: (text, exp) => answerOf(text) === exp.xl.ledger_sync.rule,
  },
  {
    name: "recall_ledger_code",
    recall: true,
    prompt: RECALL + "which error code does ledger_sync.js throw when an entry's sequence number skips ahead? End with a line `ANSWER=<error code>`.",
    check: (text, exp) => answerOf(text) === exp.xl.ledger_sync.code,
  },
];

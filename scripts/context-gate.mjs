// Context gate: a small HTTP proxy in one process, with two stages that share its memory.
// BACK (GATE_PORT) sits between Headroom and the Anthropic API: a POST to /v1/messages whose
// estimated size reaches GATE_MIN_TOKENS goes to pxpipe (which pays off only on large context);
// everything else goes direct. FRONT (GATE_FRONT_PORT, optional) sits before Headroom: it records
// the raw size of each request and forwards it unchanged. Real usage read from direct answers
// calibrates the back's estimate per session. Plain node:http, no dependencies: request bodies are
// forwarded byte for byte, and responses are piped chunk by chunk because SSE must not be buffered.

import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const MAX_SESSIONS = 2000;
// Gain policy: a dry run of pxpipe's transform may take at most this long.
const DRYRUN_MS = 5000;
// Usage is read from SSE lines up to MAX_LINE characters, and from JSON answers up to JSON_CAP bytes.
const MAX_LINE = 256 * 1024;
const JSON_CAP = 2 * 1024 * 1024;
// Hop-by-hop headers describe one connection, so they are not forwarded. Host is set by node
// from the upstream URL, and content-length is recomputed for the body we send.
const REQ_DROP = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "content-length"]);
const RES_DROP = new Set(["connection", "keep-alive", "transfer-encoding"]);
// Content codings whose answers can be decoded for usage reading. Others are passed on unread.
const DECODERS = new Map([
  ["gzip", createGunzip],
  ["x-gzip", createGunzip],
  ["deflate", createInflate],
  ["br", createBrotliDecompress],
]);

function die(msg) {
  console.error(`[context-gate] ${msg}`);
  process.exit(2);
}

function upstream(name, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    die(`${name} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") die(`${name} must be http or https: ${raw}`);
  // The lib is picked by scheme because node:http and node:https have separate request functions.
  return { url, lib: url.protocol === "https:" ? https : http, prefix: url.pathname.replace(/\/+$/, "") };
}

const env = process.env;
const HOST = env.GATE_HOST || "127.0.0.1";
const PORT_RAW = env.GATE_PORT || "47830";
if (!/^\d+$/.test(PORT_RAW) || Number(PORT_RAW) > 65535) die(`GATE_PORT must be a port number, got "${PORT_RAW}"`);
const PORT = Number(PORT_RAW);
const FRONT_RAW = env.GATE_FRONT_PORT || "";
if (FRONT_RAW && (!/^\d+$/.test(FRONT_RAW) || Number(FRONT_RAW) > 65535)) {
  die(`GATE_FRONT_PORT must be a port number, got "${FRONT_RAW}"`);
}
const FRONT_PORT = FRONT_RAW ? Number(FRONT_RAW) : null;
const MIN_RAW = env.GATE_MIN_TOKENS || "60000";
if (!/^[1-9]\d*$/.test(MIN_RAW)) die(`GATE_MIN_TOKENS must be a positive integer, got "${MIN_RAW}"`);
const MIN_TOKENS = Number(MIN_RAW);
const DIRECT = upstream("GATE_DIRECT_UPSTREAM", env.GATE_DIRECT_UPSTREAM || "https://api.anthropic.com");
const PXPIPE = upstream("GATE_PXPIPE_UPSTREAM", env.GATE_PXPIPE_UPSTREAM || "http://127.0.0.1:47821");
const FRONT_UP =
  FRONT_PORT === null ? null : upstream("GATE_FRONT_UPSTREAM", env.GATE_FRONT_UPSTREAM || "http://127.0.0.1:8787");
const STICKY = !["0", "off"].includes((env.GATE_STICKY || "on").toLowerCase());
const LOG = env.GATE_LOG || "";
const POLICY = (env.GATE_POLICY || "threshold").toLowerCase();
if (!["threshold", "gain"].includes(POLICY)) die(`GATE_POLICY must be "threshold" or "gain", got "${env.GATE_POLICY}"`);
function positiveInt(name, raw) {
  if (!/^[1-9]\d*$/.test(raw)) die(`${name} must be a positive integer, got "${raw}"`);
  return Number(raw);
}
const WINDOW = positiveInt("GATE_WINDOW", env.GATE_WINDOW || "200000");
const HORIZON = positiveInt("GATE_HORIZON", env.GATE_HORIZON || "20");
// Decimal numbers for the gain economics: no sign, no exponent. Zero is allowed only where noted.
function decimal(name, raw, { allowZero }) {
  const v = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isFinite(v) || (!allowZero && v === 0)) die(`${name} must be a ${allowZero ? "non-negative" : "positive"} number, got "${raw}"`);
  return v;
}
// Gain economics, in input-token units: cache read price, cache write price, the overhead factor k for the
// extra requests and output pxpipe induces, and the mid-zone margin.
const CACHE_READ = decimal("GATE_CACHE_READ", env.GATE_CACHE_READ || "0.1", { allowZero: false });
const CACHE_WRITE = decimal("GATE_CACHE_WRITE", env.GATE_CACHE_WRITE || "1.25", { allowZero: false });
const OVERHEAD = decimal("GATE_OVERHEAD", env.GATE_OVERHEAD || "0.2", { allowZero: true });
const MARGIN = decimal("GATE_MARGIN", env.GATE_MARGIN || "0.05", { allowZero: true });
// Path to pxpipe's library. Unset, it is looked up in the global npm root, and only the gain policy needs it.
function defaultPxpipeLib() {
  try {
    const root = execFileSync("npm root -g", { shell: true, encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return join(root, "pxpipe-proxy", "dist", "core", "library.js");
  } catch {
    return "";
  }
}
const PXPIPE_LIB = env.GATE_PXPIPE_LIB || (POLICY === "gain" ? defaultPxpipeLib() : "");

// front: every request the front stage forwarded. direct and pxpipe: back routes.
const counts = { direct: 0, pxpipe: 0, front: 0, front_fallback: 0 };
// Sums over back /v1/messages requests. raw_est_sum only counts requests the front has seen.
const sums = { real_context_direct_sum: 0, real_context_pxpipe_sum: 0, raw_est_sum: 0, est_sum: 0 };
// Session hash -> true, in insertion order so the oldest key can be dropped first.
const sessionsOnPxpipe = new Map();
// Session hash -> { last_real, last_est }, from the latest direct answer that reported usage.
const calibration = new Map();
// Session hash -> { raw_est, requests }, as last seen by the front stage.
const frontRecords = new Map();
// Gain policy: session hash -> last dry run { measure, route, reason, saving, requests }. requests counts
// the requests since the dry run, itself included, so the next dry run is due at 5.
const dryRuns = new Map();
const gainStats = { dryruns: 0, dryrun_ms_sum: 0, predictions: 0, prediction_abs_error_sum: 0 };

// Rough token count: 4 characters per token, plus a flat amount per base64 image or document,
// because its characters are not text the model reads one token per four characters.
// With pngSize, a PNG costs what Anthropic bills for it (width x height / 750 tokens), read from
// its header; other images keep the flat amount. Used to price pxpipe's dry-run output.
function estimateTokens(body, { pngSize = false } = {}) {
  let chars = 0;
  let imageTokens = 0;
  const walk = (v) => {
    if (typeof v === "string") chars += v.length;
    else if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object") {
      const b64 = v.type === "base64" && typeof v.data === "string";
      if (b64) imageTokens += pngSize ? pngTokens(v.data) : 1600;
      for (const [k, x] of Object.entries(v)) if (!(b64 && k === "data")) walk(x);
    }
  };
  walk(body.system);
  walk(body.messages);
  walk(body.tools);
  return Math.ceil(chars / 4) + imageTokens;
}

function pngTokens(data) {
  const head = Buffer.from(data.slice(0, 32), "base64");
  if (head.length < 24 || head.readUInt32BE(0) !== 0x89504e47) return 1600;
  return Math.ceil((head.readUInt32BE(16) * head.readUInt32BE(20)) / 750);
}

// Tokens pxpipe's transform would save on this request. Its info fields when it fills them;
// else the difference between the original and the transformed body, priced the same way.
function dryRunSaving(result, parsed) {
  const info = result.info ?? {};
  if (typeof info.baselineImagedTokens === "number" && typeof info.imageTokens === "number") {
    return info.baselineImagedTokens - info.imageTokens - (info.nativeInjectedTokens ?? 0);
  }
  const out = parseJson(Buffer.from(result.body ?? []));
  if (!out) return 0;
  return estimateTokens(parsed) - estimateTokens(out, { pngSize: true });
}

// Sessions are keyed by user_id so every request of one user keeps the same route. Without it,
// the first message stands in, which is stable for a conversation.
function sessionHash(body) {
  const uid = body.metadata?.user_id;
  const key = typeof uid === "string" ? uid : JSON.stringify(body.messages?.[0] ?? null);
  return createHash("sha256").update(key).digest("hex");
}

// Maps are bounded by insertion order: the oldest key goes first.
function setBounded(map, key, value) {
  if (!map.has(key) && map.size >= MAX_SESSIONS) map.delete(map.keys().next().value);
  map.set(key, value);
}

function rememberPxpipe(session) {
  // Re-inserted on every hit, so a long-lived session is never the oldest key evicted.
  sessionsOnPxpipe.delete(session);
  setBounded(sessionsOnPxpipe, session, true);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Real input size of a request: uncached input plus cache reads and cache writes.
function realContext(u) {
  if (!u || typeof u.input_tokens !== "number") return null;
  return u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
}

// pxpipe's library, loaded once on first use. Null when it cannot be loaded: the gain policy then falls back.
let libPromise = null;
function loadPxpipe() {
  if (!libPromise) {
    libPromise = import(pathToFileURL(PXPIPE_LIB).href)
      .then((mod) => {
        if (typeof mod.transformAnthropicMessages !== "function") throw new Error("no transformAnthropicMessages export");
        return mod.transformAnthropicMessages;
      })
      .catch((err) => {
        console.error(`[context-gate] pxpipe library not loaded (${err.message}); gain policy uses the threshold`);
        return null;
      });
  }
  return libPromise;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`dry run exceeded ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Expected input cost of the rest of a session (HORIZON requests) on each route, for a prefix of P tokens
// that pxpipe would shrink by S. delta > 0 means pxpipe is cheaper.
function economics(P, S) {
  const text_cost = HORIZON * CACHE_READ * P;
  const pxpipe_cost = CACHE_WRITE * (P - S) + HORIZON * CACHE_READ * (P - S) * (1 + OVERHEAD);
  return { delta: text_cost - pxpipe_cost, text_cost, pxpipe_cost };
}

// Gain policy for a request that sticky did not route. Zones by measure / WINDOW.
async function gainDecision(parsed, bytes, session, measure) {
  const ratio = measure / WINDOW;
  if (ratio < 0.2) return { route: "direct", reason: "zone_low", zone: "low", saving: null, dryrun_ms: null };
  const zone = ratio < 0.5 ? "mid" : ratio < 0.85 ? "high" : "limit";
  // Cost guard: reuse the session's last dry run unless the size grew by 10% or 5 requests have passed.
  const prev = dryRuns.get(session);
  if (prev && prev.requests < 5 && measure < prev.measure * 1.1) {
    prev.requests += 1;
    return { ...prev.out, reason: `${prev.reason}_cached`, zone, dryrun_ms: null };
  }
  const lib = await loadPxpipe();
  if (lib === null) {
    return { route: measure >= MIN_TOKENS ? "pxpipe" : "direct", reason: "lib_missing", zone, saving: null, dryrun_ms: null };
  }
  const t0 = Date.now();
  let result;
  try {
    result = await withTimeout(lib({ body: bytes, model: parsed.model ?? null }), DRYRUN_MS);
  } catch {
    const ms = Date.now() - t0;
    gainStats.dryruns += 1;
    gainStats.dryrun_ms_sum += ms;
    return { route: "direct", reason: "dryrun_error", zone, saving: null, dryrun_ms: ms };
  }
  const ms = Date.now() - t0;
  gainStats.dryruns += 1;
  gainStats.dryrun_ms_sum += ms;
  // Estimate only: pxpipe's own proxy does the real transform, so the output is never sent anywhere.
  // Scaled like the measure, so both sides use the session's calibration.
  const est = estimateTokens(parsed);
  const saving = Math.round(dryRunSaving(result, parsed) * (est > 0 ? measure / est : 1));
  let route = "direct";
  let reason;
  let econ = { delta: null, text_cost: null, pxpipe_cost: null };
  if (!result.applied) reason = `pxpipe_${result.reason}`;
  else if (saving <= 0) reason = "no_saving";
  else {
    econ = economics(measure, saving);
    if (zone === "limit") {
      // Context pressure dominates the cost near the limit: switch whenever pxpipe applies.
      route = "pxpipe";
      reason = "near_limit";
    } else {
      // Mid zone needs the margin; high zone needs only a positive delta.
      const bar = zone === "mid" ? MARGIN * econ.text_cost : 0;
      if (econ.delta > bar) {
        route = "pxpipe";
        reason = zone === "mid" ? "gain" : "gain_high";
      } else reason = "not_worth_yet";
    }
  }
  const out = { route, saving, ...econ, predicted_after: route === "pxpipe" ? measure - saving : null };
  setBounded(dryRuns, session, { measure, reason, requests: 1, out });
  return { ...out, reason, zone, dryrun_ms: ms };
}

// Routes one parsed /v1/messages body. `bytes` is the body as received, for the gain policy's dry run.
async function decide(body, bytes) {
  const est = estimateTokens(body);
  const session = sessionHash(body);
  // With a calibration, the estimate is scaled by how far the last direct answer's real size was from it.
  const cal = calibration.get(session);
  const measure = cal ? est * clamp(cal.last_real / cal.last_est, 0.25, 4) : est;
  let route;
  let reason;
  let g = {};
  // Sticky first: flipping a session between routes rewrites its prompt cache every time.
  if (STICKY && sessionsOnPxpipe.has(session)) {
    route = "pxpipe";
    reason = "sticky";
  } else if (POLICY === "gain") {
    g = await gainDecision(body, bytes, session, measure);
    route = g.route;
    reason = g.reason;
  } else if (measure >= MIN_TOKENS) {
    route = "pxpipe";
    reason = "above";
  } else {
    route = "direct";
    reason = "below";
  }
  if (route === "pxpipe" && STICKY) rememberPxpipe(session);
  return {
    route,
    reason,
    est,
    measure: Math.round(measure),
    calibrated: cal !== undefined,
    session,
    raw_est: frontRecords.get(session)?.raw_est ?? null,
    zone: g.zone ?? null,
    saving: g.saving ?? null,
    dryrun_ms: g.dryrun_ms ?? null,
    delta: g.delta ?? null,
    text_cost: g.text_cost ?? null,
    pxpipe_cost: g.pxpipe_cost ?? null,
    predicted_after: g.predicted_after ?? null,
  };
}

function parseJson(buf) {
  try {
    const v = JSON.parse(buf.toString("utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function logRoute(entry) {
  if (!LOG) return;
  try {
    appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (err) {
    console.error(`[context-gate] log write failed: ${err.message}`);
  }
}

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}

const short = (session) => (session ? session.slice(0, 8) : null);

// Reads the real usage of an answer while it is piped on. SSE: the first message_start and the
// last message_delta, found line by line across chunk boundaries. JSON: body.usage, read up to
// JSON_CAP bytes. Returns the hooks for relay and the usage object they fill in.
function watchUsage(upRes) {
  const type = String(upRes.headers["content-type"] || "");
  // A compressed body is decoded before it is scanned. An unknown coding is skipped: the bytes still pass.
  const coding = String(upRes.headers["content-encoding"] || "identity").trim().toLowerCase();
  const make = DECODERS.get(coding);
  const known = coding === "identity" || make !== undefined;
  const sse = known && type.includes("text/event-stream");
  const json = known && !sse && type.includes("application/json");
  const usage = { real_context: null, output_tokens: null };
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let seenStart = false;
  let parts = [];
  let size = 0;
  let overflow = false;
  let broken = false;
  const scanLine = (line) => {
    if (!line.startsWith("data:") || !line.includes("usage")) return;
    let ev;
    try {
      ev = JSON.parse(line.slice(5));
    } catch {
      return;
    }
    if (ev?.type === "message_start" && !seenStart) {
      seenStart = true;
      usage.real_context = realContext(ev.message?.usage);
    } else if (ev?.type === "message_delta" && ev.usage?.output_tokens != null) {
      usage.output_tokens = ev.usage.output_tokens;
    }
  };
  // Reads decoded bytes of the answer: SSE text lines, or JSON bytes up to JSON_CAP.
  const feed = (c) => {
    if (sse) {
      const lines = (pending + decoder.write(c)).split("\n");
      pending = lines.pop();
      if (pending.length > MAX_LINE) pending = "";
      for (const line of lines) scanLine(line);
    } else if (json && !overflow) {
      size += c.length;
      if (size > JSON_CAP) {
        overflow = true;
        parts = [];
      } else parts.push(c);
    }
  };
  const finish = () => {
    if (sse) {
      scanLine(pending + decoder.end());
      pending = "";
    } else if (json && !overflow) {
      const body = parseJson(Buffer.concat(parts));
      usage.real_context = realContext(body?.usage);
      usage.output_tokens = body?.usage?.output_tokens ?? null;
    }
  };
  // A decoding failure only ends usage reading: the bytes were already piped on to the client.
  const dec = (sse || json) && make ? make() : null;
  if (dec) {
    dec.on("data", feed);
    dec.on("error", () => {
      broken = true;
      usage.real_context = null;
      usage.output_tokens = null;
    });
  }
  return {
    usage,
    data(c) {
      if (!dec) feed(c);
      else if (!broken) dec.write(c);
    },
    // Without a decoder the usage is final now (returns null). With one, returns a promise that
    // resolves once the decoder has flushed, whether it ended cleanly or failed.
    end() {
      if (!dec) {
        finish();
        return null;
      }
      return new Promise((resolve) => {
        if (broken) return resolve();
        dec.once("end", () => {
          finish();
          resolve();
        });
        dec.once("error", () => resolve());
        dec.end();
      });
    },
  };
}

// Sends req to target and pipes the answer back chunk by chunk. `watch` reads the usage on the way.
// done(status, usage) runs once, when the answer ends, fails or the client leaves. onError(err) may
// take over an upstream failure by returning true.
function relay(req, res, body, target, label, { watch = false, onError = null, done }) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!REQ_DROP.has(k)) headers[k] = v;
  headers["content-length"] = body.length;
  let status = null;
  let settled = false;
  let upDone = false;
  const settle = (usage) => {
    if (settled) return;
    settled = true;
    done(status, usage);
  };

  const up = target.lib.request(
    {
      hostname: target.url.hostname,
      port: target.url.port || undefined,
      method: req.method,
      path: target.prefix + req.url,
      headers,
    },
    (upRes) => {
      status = upRes.statusCode;
      const outHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) if (!RES_DROP.has(k)) outHeaders[k] = v;
      res.writeHead(upRes.statusCode, outHeaders);
      const tap = watch ? watchUsage(upRes) : null;
      if (tap) tap.usage.upstream = `${upRes.headers["content-type"] || "-"}; ${upRes.headers["content-encoding"] || "identity"}`;
      if (tap) upRes.on("data", tap.data);
      // res is ended here, not by pipe(), so the client sees the end only after the usage is settled:
      // the log line is written before it, even when a decoder has to flush first.
      upRes.on("end", () => {
        upDone = true;
        const flushed = tap ? tap.end() : null;
        const finish = () => {
          settle(tap ? tap.usage : null);
          if (!res.destroyed) res.end();
        };
        if (flushed) flushed.then(finish);
        else finish();
      });
      upRes.on("error", () => {
        res.destroy();
        settle(tap ? tap.usage : null);
      });
      upRes.pipe(res, { end: false });
    },
  );
  up.on("error", (err) => {
    if (onError && onError(err)) {
      settled = true;
      return;
    }
    if (!res.headersSent) {
      status = 502;
      sendJson(res, 502, {
        type: "error",
        error: { type: "api_error", message: `context-gate: ${label} upstream unreachable: ${err.message}` },
      });
    } else {
      res.destroy();
    }
    settle(null);
  });
  // If the client goes away mid-stream, stop the upstream request too.
  res.on("close", () => {
    if (!res.writableFinished) up.destroy();
    // Once the upstream has ended, the usage settles itself (possibly after a decoder flush).
    if (!upDone) settle(null);
  });
  up.end(body);
}

// fallback: the decision to use instead of evaluating, when pxpipe could not be reached.
async function forward(req, res, path, body, fallback = null) {
  const t0 = fallback ? fallback.t0 : Date.now();
  // Anything not evaluated goes direct, including unparseable bodies.
  let d = { route: "direct", reason: "not_messages", est: null, measure: null, calibrated: false, session: null, raw_est: null };
  if (fallback) d = fallback;
  else if (req.method === "POST" && path === "/v1/messages") {
    const parsed = parseJson(body);
    if (parsed) {
      d = await decide(parsed, body);
      sums.est_sum += d.est;
      sums.raw_est_sum += d.raw_est ?? 0;
    } else d = { ...d, reason: "unparsed" };
  }
  counts[d.route] += 1;

  const target = d.route === "pxpipe" ? PXPIPE : DIRECT;
  relay(req, res, body, target, d.route, {
    watch: d.session !== null,
    onError: (err) => {
      // pxpipe down (crashed or restarting): answer through Anthropic directly rather than fail,
      // and unstick the session so it is evaluated again on its next request.
      // A client that went away also errors the upstream request: never resend that one.
      if (d.route !== "pxpipe" || fallback || res.headersSent || res.destroyed) return false;
      console.error(`[context-gate] pxpipe unreachable (${err.message}), sending direct`);
      if (d.session) sessionsOnPxpipe.delete(d.session);
      counts.pxpipe -= 1;
      forward(req, res, path, body, { ...d, route: "direct", reason: "fallback", t0 });
      return true;
    },
    done: (status, usage) => {
      const real = usage ? usage.real_context : null;
      if (real !== null) sums[d.route === "pxpipe" ? "real_context_pxpipe_sum" : "real_context_direct_sum"] += real;
      // Only direct answers calibrate: pxpipe ones are smaller by design.
      if (d.route === "direct" && real !== null && d.session !== null && d.est > 0) {
        setBounded(calibration, d.session, { last_real: real, last_est: d.est });
      }
      // A switch predicted the prefix after pxpipe; the first answer with usage shows how close that was.
      let prediction_error = null;
      if (d.route === "pxpipe" && (d.predicted_after ?? null) !== null && real !== null) {
        prediction_error = real - d.predicted_after;
        gainStats.predictions += 1;
        gainStats.prediction_abs_error_sum += Math.abs(prediction_error);
      }
      logRoute({
        stage: "back",
        session: short(d.session),
        route: d.route,
        reason: d.reason,
        calibrated: d.calibrated,
        raw_est: d.raw_est,
        est: d.est,
        measure: d.measure,
        policy: POLICY,
        zone: d.zone ?? null,
        saving: d.saving ?? null,
        dryrun_ms: d.dryrun_ms ?? null,
        delta: d.delta == null ? null : Math.round(d.delta),
        text_cost: d.text_cost == null ? null : Math.round(d.text_cost),
        pxpipe_cost: d.pxpipe_cost == null ? null : Math.round(d.pxpipe_cost),
        predicted_after: d.predicted_after ?? null,
        prediction_error,
        real_context: real,
        output_tokens: usage ? usage.output_tokens : null,
        upstream: usage ? usage.upstream ?? null : null,
        status,
        ms: Date.now() - t0,
      });
    },
  });
}

// FRONT: records the raw size of each /v1/messages request, then forwards the request unchanged.
function frontForward(req, res, path, body) {
  const t0 = Date.now();
  let session = null;
  let raw = null;
  if (req.method === "POST" && path === "/v1/messages") {
    const parsed = parseJson(body);
    if (parsed) {
      session = sessionHash(parsed);
      raw = estimateTokens(parsed);
      const rec = frontRecords.get(session) ?? { raw_est: 0, requests: 0 };
      rec.raw_est = raw;
      rec.requests += 1;
      setBounded(frontRecords, session, rec);
    }
  }
  counts.front += 1;
  const send = (target, viaFallback) =>
    relay(req, res, body, target, viaFallback ? "direct" : "front", {
      // Headroom down (still loading after logon, or crashed): answer through Anthropic directly rather
      // than fail every request. A client that went away also errors the request: never resend that one.
      onError: viaFallback
        ? null
        : (err) => {
            if (res.headersSent || res.destroyed) return false;
            console.error(`[context-gate] Headroom unreachable (${err.message}), sending direct`);
            counts.front_fallback += 1;
            send(DIRECT, true);
            return true;
          },
      done: (status) => {
        logRoute({ stage: "front", session: short(session), raw_est: raw, status, ms: Date.now() - t0, ...(viaFallback ? { reason: "fallback" } : {}) });
      },
    });
  send(FRONT_UP, false);
}

function stats() {
  return {
    min_tokens: MIN_TOKENS,
    policy: POLICY,
    window: WINDOW,
    dryruns: gainStats.dryruns,
    dryrun_ms_sum: gainStats.dryrun_ms_sum,
    predictions: gainStats.predictions,
    prediction_abs_error_sum: gainStats.prediction_abs_error_sum,
    direct: counts.direct,
    pxpipe: counts.pxpipe,
    sessions_on_pxpipe: sessionsOnPxpipe.size,
    front_requests: counts.front,
    front_fallback: counts.front_fallback,
    ...sums,
    calibrated_sessions: calibration.size,
  };
}

// Both stages answer the same health and stats paths; any other request goes to the stage's route.
function handler(route) {
  return (req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "GET" && (path === "/" || path === "/livez")) return sendJson(res, 200, { ok: true });
    if (req.method === "GET" && path === "/stats") return sendJson(res, 200, stats());
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", () => res.destroy());
    req.on("end", () => route(req, res, path, Buffer.concat(chunks)));
  };
}

const servers = [];
const back = http.createServer(handler(forward));
servers.push(back);
back.on("error", (err) => {
  console.error(`[context-gate] cannot listen on ${HOST}:${PORT}: ${err.message}`);
  process.exit(1);
});
back.listen(PORT, HOST, () => {
  const routing = POLICY === "gain" ? `gain policy, window ${WINDOW}` : `pxpipe above ${MIN_TOKENS} tokens`;
  console.error(`[context-gate] back on http://${HOST}:${PORT}, ${routing}`);
});
if (FRONT_PORT !== null) {
  const front = http.createServer(handler(frontForward));
  servers.push(front);
  front.on("error", (err) => {
    console.error(`[context-gate] cannot listen on ${HOST}:${FRONT_PORT}: ${err.message}`);
    process.exit(1);
  });
  front.listen(FRONT_PORT, HOST, () => {
    console.error(`[context-gate] front on http://${HOST}:${FRONT_PORT} -> ${FRONT_UP.url.origin}${FRONT_UP.prefix}`);
  });
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const s of servers) {
      s.close();
      s.closeAllConnections();
    }
    process.exit(0);
  });
}

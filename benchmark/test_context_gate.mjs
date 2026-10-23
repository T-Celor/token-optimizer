// Tests for scripts/context-gate.mjs. The gate runs as a child process in front of two fake
// upstreams (direct and pxpipe) that record every request they receive.
// Run from the repo root: node --test benchmark/test_context_gate.mjs

import { test, before, after } from "node:test";
import assert from "node:assert";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip, gunzipSync } from "node:zlib";

const ROOT = dirname(fileURLToPath(import.meta.url));
const GATE = join(ROOT, "..", "scripts", "context-gate.mjs");
const AUTH = { "x-api-key": "test-key", "anthropic-version": "2023-06-01" };
const MIN_TOKENS = 1000;

const children = [];
const servers = [];
let direct;
let pxpipe;
let gate;
let logDir;
let logPath;

// Records each request, then answers /v1/messages with an SSE-like body in two chunks.
function fakeUpstream() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const hit = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks), secondChunkAt: 0 };
      hits.push(hit);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: one\ndata: 1\n\n");
      // The gap proves the gate passes the first chunk on before the second one exists.
      setTimeout(() => {
        hit.secondChunkAt = Date.now();
        res.end("event: two\ndata: 2\n\n");
      }, 300);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ hits, port: server.address().port }));
  });
}

// Equal within a few tokens: estimates include the JSON framing of the request.
const near = (actual, expected, tol = 10) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} is not within ${tol} of ${expected}`);

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      })
      .on("error", reject);
  });
}

// Sends the exact bytes given and reports when the first response chunk arrived.
function post(port, path, bytes, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: { "content-type": "application/json", "content-length": bytes.length, ...headers },
      },
      (res) => {
        const chunks = [];
        let firstChunkAt = 0;
        res.on("data", (c) => {
          if (!firstChunkAt) firstChunkAt = Date.now();
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), firstChunkAt }),
        );
      },
    );
    req.on("error", reject);
    req.end(bytes);
  });
}

function bytesOf(obj) {
  return Buffer.from(JSON.stringify(obj));
}

function msg(userId, text) {
  return { model: "claude-test", max_tokens: 16, metadata: { user_id: userId }, messages: [{ role: "user", content: text }] };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Gate environment without any GATE_* variables from the developer's shell.
function baseEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("GATE_")) delete env[k];
  return env;
}

function spawnGate(env) {
  const child = spawn(process.execPath, [GATE], { env: { ...baseEnv(), ...env }, stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  child.stderrText = () => stderr;
  return child;
}

// Starts the gate on a free port and waits until it answers /livez and has printed its banners.
async function startGate(extra) {
  const port = await freePort();
  const child = spawnGate({ GATE_PORT: String(port), GATE_HOST: "127.0.0.1", ...extra });
  const banners = [`back on http://127.0.0.1:${port}`];
  if (extra.GATE_FRONT_PORT) banners.push(`front on http://127.0.0.1:${extra.GATE_FRONT_PORT}`);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`gate exited early: ${child.stderrText()}`);
    try {
      await get(port, "/livez");
      if (banners.every((b) => child.stderrText().includes(b))) return { child, port };
    } catch {
      // not listening yet
    }
    await sleep(50);
  }
  throw new Error(`gate did not come up: ${child.stderrText()}`);
}

before(async () => {
  direct = await fakeUpstream();
  pxpipe = await fakeUpstream();
  logDir = mkdtempSync(join(tmpdir(), "context-gate-test-"));
  logPath = join(logDir, "gate.jsonl");
  gate = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logPath,
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${direct.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${pxpipe.port}`,
  });
});

after(() => {
  for (const c of children) if (c.exitCode === null) c.kill();
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  if (logDir) rmSync(logDir, { recursive: true, force: true });
});

test("startup banner names the port and threshold", () => {
  assert.ok(gate.child.stderrText().includes(`back on http://127.0.0.1:${gate.port}, pxpipe above ${MIN_TOKENS} tokens`));
});

test("small request goes direct, with headers and body bytes unchanged", async () => {
  const bytes = bytesOf(msg("alice", "hi"));
  const r = await post(gate.port, "/v1/messages", bytes, AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(direct.hits.length, 1);
  assert.strictEqual(pxpipe.hits.length, 0);
  const hit = direct.hits[0];
  assert.strictEqual(hit.method, "POST");
  assert.strictEqual(hit.path, "/v1/messages");
  assert.strictEqual(hit.headers["x-api-key"], "test-key");
  assert.strictEqual(hit.headers["anthropic-version"], "2023-06-01");
  assert.ok(hit.body.equals(bytes));
});

test("large request goes to pxpipe, body bytes unchanged", async () => {
  const bytes = bytesOf(msg("bob", "x".repeat(5000)));
  const r = await post(gate.port, "/v1/messages", bytes, AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(pxpipe.hits.length, 1);
  assert.strictEqual(direct.hits.length, 1);
  assert.ok(pxpipe.hits[0].body.equals(bytes));
  assert.strictEqual(pxpipe.hits[0].headers["x-api-key"], "test-key");
});

test("small request with the same user_id sticks to pxpipe", async () => {
  await post(gate.port, "/v1/messages", bytesOf(msg("bob", "short")), AUTH);
  assert.strictEqual(pxpipe.hits.length, 2);
  assert.strictEqual(direct.hits.length, 1);
});

test("small request with another user_id goes direct", async () => {
  await post(gate.port, "/v1/messages", bytesOf(msg("carol", "short")), AUTH);
  assert.strictEqual(direct.hits.length, 2);
  assert.strictEqual(pxpipe.hits.length, 2);
});

test("count_tokens goes direct even when the body is large", async () => {
  await post(gate.port, "/v1/messages/count_tokens", bytesOf(msg("erin", "x".repeat(5000))), AUTH);
  assert.strictEqual(direct.hits.length, 3);
  assert.strictEqual(direct.hits[2].path, "/v1/messages/count_tokens");
  assert.strictEqual(pxpipe.hits.length, 2);
});

test("streamed response is passed on before the upstream finishes", async () => {
  const r = await post(gate.port, "/v1/messages", bytesOf(msg("dave", "hi")), AUTH);
  const hit = direct.hits[3];
  assert.ok(hit.secondChunkAt > 0);
  assert.ok(r.firstChunkAt > 0 && r.firstChunkAt < hit.secondChunkAt, "first chunk arrived after the second was sent");
  assert.ok(r.body.toString("utf8").includes("event: two"));
});

test("/stats counts match the routing", async () => {
  const r = await get(gate.port, "/stats");
  assert.strictEqual(r.status, 200);
  // The stats also carry the front and calibration fields; this test checks the original ones.
  const s = JSON.parse(r.body);
  assert.deepStrictEqual(
    { min_tokens: s.min_tokens, direct: s.direct, pxpipe: s.pxpipe, sessions_on_pxpipe: s.sessions_on_pxpipe },
    { min_tokens: MIN_TOKENS, direct: 4, pxpipe: 2, sessions_on_pxpipe: 1 },
  );
});

test("GATE_LOG has one line per routed request", () => {
  const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepStrictEqual(lines.map((l) => l.route), ["direct", "pxpipe", "pxpipe", "direct", "direct", "direct"]);
  assert.deepStrictEqual(lines.map((l) => l.reason), ["below", "above", "sticky", "below", "not_messages", "below"]);
  assert.match(lines[0].session, /^[0-9a-f]{8}$/);
  assert.strictEqual(lines[1].session, lines[2].session);
});

test("query string reaches the upstream unchanged", async () => {
  await post(gate.port, "/v1/messages?beta=true", bytesOf(msg("gina", "x".repeat(5000))), AUTH);
  assert.strictEqual(pxpipe.hits.at(-1).path, "/v1/messages?beta=true");
});

test("unreachable pxpipe falls back to direct and unsticks the session", async () => {
  const closed = await freePort();
  const g = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${direct.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${closed}`,
  });
  const before = direct.hits.length;
  const bytes = bytesOf(msg("frank", "x".repeat(5000)));
  const r = await post(g.port, "/v1/messages", bytes, AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(direct.hits.length, before + 1);
  assert.ok(direct.hits.at(-1).body.equals(bytes));
  const stats = JSON.parse((await get(g.port, "/stats")).body);
  assert.deepStrictEqual([stats.direct, stats.pxpipe, stats.sessions_on_pxpipe], [1, 0, 0]);
});

test("both upstreams unreachable gives a 502 with a JSON error", async () => {
  const g = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${await freePort()}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${await freePort()}`,
  });
  const r = await post(g.port, "/v1/messages", bytesOf(msg("hank", "x".repeat(5000))), AUTH);
  assert.strictEqual(r.status, 502);
  const j = JSON.parse(r.body.toString("utf8"));
  assert.strictEqual(j.type, "error");
  assert.strictEqual(j.error.type, "api_error");
  assert.match(j.error.message, /^context-gate: direct upstream unreachable: /);
});

test("invalid GATE_MIN_TOKENS exits with code 2", async () => {
  for (const bad of ["0", "-5", "abc", "1.5"]) {
    const child = spawnGate({ GATE_MIN_TOKENS: bad });
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        child.kill();
        reject(new Error(`gate did not exit for GATE_MIN_TOKENS=${bad}`));
      }, 5000);
      child.once("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    assert.strictEqual(code, 2, `GATE_MIN_TOKENS=${bad}`);
    assert.match(child.stderrText(), /GATE_MIN_TOKENS/);
  }
});

// Usage a fake Anthropic reports: 2000 uncached + 900 cache reads + 100 cache writes = 3000.
const USAGE = { input_tokens: 2000, cache_read_input_tokens: 900, cache_creation_input_tokens: 100 };

// Answers like Anthropic with usage: an SSE stream (message_start, then message_delta after a gap,
// with message_start split across two chunks) or a JSON body. Records each request.
function fakeUsageUpstream(kind) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const hit = { path: req.url, headers: req.headers, body: Buffer.concat(chunks), secondChunkAt: 0 };
      hits.push(hit);
      if (kind === "json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "m", type: "message", usage: { ...USAGE, output_tokens: 7 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: USAGE } })}\n\n`;
      res.write(start.slice(0, 30));
      setTimeout(() => res.write(start.slice(30)), 20);
      // The gap proves the gate passes the first chunks on before the rest exists.
      setTimeout(() => {
        hit.secondChunkAt = Date.now();
        const delta = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 42 } })}\n\n`;
        res.end(delta + `event: message_stop\ndata: {"type":"message_stop"}\n\n`);
      }, 300);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ hits, port: server.address().port }));
  });
}

// Stands in for Headroom: halves the user text, then forwards to the back port (read lazily).
function fakeHeadroom(getPort) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const text = body.messages[0].content;
      body.messages[0].content = text.slice(0, Math.ceil(text.length / 2));
      const bytes = Buffer.from(JSON.stringify(body));
      const headers = { ...req.headers, "content-length": bytes.length };
      delete headers.host;
      const up = http.request({ host: "127.0.0.1", port: getPort(), method: req.method, path: req.url, headers }, (upRes) => {
        const outHeaders = { ...upRes.headers };
        delete outHeaders.connection;
        delete outHeaders["keep-alive"];
        delete outHeaders["transfer-encoding"];
        res.writeHead(upRes.statusCode, outHeaders);
        upRes.pipe(res);
      });
      up.on("error", () => res.destroy());
      up.end(bytes);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port }));
  });
}

function readLog(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("calibration: a direct answer's real size scales the next estimate", async () => {
  const direct = await fakeUsageUpstream("sse");
  const pxUp = await fakeUsageUpstream("sse");
  const logFile = join(logDir, "calibration.jsonl");
  const g = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logFile,
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${direct.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${pxUp.port}`,
  });
  // Estimates: (4 + 2396) / 4 = 600, then (4 + 1196) / 4 = 300.
  const first = await post(g.port, "/v1/messages", bytesOf(msg("calib", "x".repeat(2396))), AUTH);
  assert.strictEqual(first.status, 200);
  assert.strictEqual(direct.hits.length, 1);
  const second = await post(g.port, "/v1/messages", bytesOf(msg("calib", "x".repeat(1196))), AUTH);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(pxUp.hits.length, 1);

  const lines = readLog(logFile);
  assert.deepStrictEqual(
    lines.map((l) => [l.stage, l.route, l.reason, l.calibrated, l.est, l.measure]),
    [
      ["back", "direct", "below", false, 600, 600],
      ["back", "pxpipe", "above", true, 300, 1200],
    ],
  );
  // Written when the answer ended: real usage, output tokens and status are in the line.
  assert.strictEqual(lines[0].real_context, 3000);
  assert.strictEqual(lines[0].output_tokens, 42);
  assert.strictEqual(lines[0].status, 200);
  assert.strictEqual(lines[0].raw_est, null);

  const s = JSON.parse((await get(g.port, "/stats")).body);
  assert.strictEqual(s.calibrated_sessions, 1);
  assert.strictEqual(s.real_context_direct_sum, 3000);
  assert.strictEqual(s.real_context_pxpipe_sum, 3000);
  assert.strictEqual(s.est_sum, 900);
});

test("a JSON answer's usage is read from its body", async () => {
  const up = await fakeUsageUpstream("json");
  const logFile = join(logDir, "json.jsonl");
  const g = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logFile,
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${up.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${up.port}`,
  });
  const r = await post(g.port, "/v1/messages", bytesOf(msg("json-user", "hi")), AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body.toString("utf8")).usage.output_tokens, 7);
  const [line] = readLog(logFile);
  assert.strictEqual(line.route, "direct");
  assert.strictEqual(line.real_context, 3000);
  assert.strictEqual(line.output_tokens, 7);
});

test("front stage: shrunk request reaches back, both stages log, streaming passes through", async () => {
  const direct = await fakeUsageUpstream("sse");
  const pxUp = await fakeUsageUpstream("sse");
  let backPort = 0;
  const headroom = await fakeHeadroom(() => backPort);
  const frontPort = await freePort();
  const logFile = join(logDir, "front.jsonl");
  const g = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logFile,
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${direct.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${pxUp.port}`,
    GATE_FRONT_PORT: String(frontPort),
    GATE_FRONT_UPSTREAM: `http://127.0.0.1:${headroom.port}`,
  });
  backPort = g.port;
  assert.ok(g.child.stderrText().includes(`front on http://127.0.0.1:${frontPort} -> http://127.0.0.1:${headroom.port}`));

  // Raw: (4 + 5000) / 4 = 1251 tokens. Headroom halves the text, so the back sees about 626.
  const r = await post(frontPort, "/v1/messages", bytesOf(msg("ivy", "x".repeat(5000))), AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(direct.hits.length, 1);
  assert.strictEqual(JSON.parse(direct.hits[0].body.toString("utf8")).messages[0].content.length, 2500);
  assert.strictEqual(direct.hits[0].headers["x-api-key"], "test-key");
  assert.ok(r.firstChunkAt > 0 && r.firstChunkAt < direct.hits[0].secondChunkAt, "a stage buffered the stream");

  const s = JSON.parse((await get(frontPort, "/stats")).body);
  assert.strictEqual(s.front_requests, 1);
  assert.strictEqual(s.direct, 1);
  assert.strictEqual((await get(frontPort, "/livez")).status, 200);

  const lines = readLog(logFile);
  const front = lines.find((l) => l.stage === "front");
  const back = lines.find((l) => l.stage === "back");
  assert.ok(front && back);
  assert.strictEqual(front.session, back.session);
  assert.match(front.session, /^[0-9a-f]{8}$/);
  assert.strictEqual(front.status, 200);
  assert.strictEqual(back.raw_est, front.raw_est);
  assert.ok(Math.abs(back.raw_est - 2 * back.est) <= 4, `raw_est ${back.raw_est} vs est ${back.est}`);
});

test("front stage: Headroom unreachable, the request goes direct instead of failing", async () => {
  const direct = await fakeUsageUpstream("sse");
  const frontPort = await freePort();
  const logFile = join(logDir, "front-fallback.jsonl");
  const g = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logFile,
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${direct.port}`,
    GATE_FRONT_PORT: String(frontPort),
    GATE_FRONT_UPSTREAM: `http://127.0.0.1:${await freePort()}`,
  });
  const bytes = bytesOf(msg("jay", "hello"));
  const r = await post(frontPort, "/v1/messages?beta=true", bytes, AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(direct.hits.length, 1);
  assert.ok(direct.hits[0].body.equals(bytes));
  assert.strictEqual(direct.hits[0].path, "/v1/messages?beta=true");
  assert.strictEqual(direct.hits[0].headers["x-api-key"], "test-key");
  const s = JSON.parse((await get(frontPort, "/stats")).body);
  assert.deepStrictEqual([s.front_requests, s.front_fallback], [1, 1]);
  const front = readLog(logFile).filter((l) => l.stage === "front");
  assert.deepStrictEqual(front.map((l) => [l.status, l.reason]), [[200, "fallback"]]);
  assert.ok(g.child.stderrText().includes("Headroom unreachable"));
});

// Answers like Anthropic with content-encoding: gzip. The SSE or JSON text goes through one
// zlib.createGzip() stream, written in two parts with a gap. Records the text it encoded.
function fakeGzipUpstream(kind) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const hit = { body: Buffer.concat(chunks), text: "" };
      hits.push(hit);
      const start = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", usage: USAGE } })}\n\n`;
      const delta = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: {}, usage: { output_tokens: 7 } })}\n\n`;
      hit.text =
        kind === "json"
          ? JSON.stringify({ id: "m", type: "message", usage: { ...USAGE, output_tokens: 7 } })
          : start + delta + `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
      res.writeHead(200, {
        "content-type": kind === "json" ? "application/json" : "text/event-stream",
        "content-encoding": "gzip",
      });
      const gz = createGzip();
      gz.pipe(res);
      const cut = Math.floor(hit.text.length / 2);
      gz.write(hit.text.slice(0, cut));
      setTimeout(() => gz.end(hit.text.slice(cut)), 100);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ hits, port: server.address().port }));
  });
}

test("gzipped SSE answer: bytes pass unchanged and usage is read after decoding", async () => {
  const up = await fakeGzipUpstream("sse");
  const logFile = join(logDir, "gzip-sse.jsonl");
  const g = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logFile,
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${up.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${up.port}`,
  });
  const r = await post(g.port, "/v1/messages", bytesOf(msg("gzip-sse", "hi")), AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers["content-encoding"], "gzip");
  assert.strictEqual(gunzipSync(r.body).toString("utf8"), up.hits[0].text);
  const [line] = readLog(logFile);
  assert.strictEqual(line.route, "direct");
  assert.strictEqual(line.real_context, 3000);
  assert.strictEqual(line.output_tokens, 7);
  assert.strictEqual(line.upstream, "text/event-stream; gzip");
});

test("gzipped JSON answer: usage is read from the decoded body", async () => {
  const up = await fakeGzipUpstream("json");
  const logFile = join(logDir, "gzip-json.jsonl");
  const g = await startGate({
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logFile,
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${up.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${up.port}`,
  });
  const r = await post(g.port, "/v1/messages", bytesOf(msg("gzip-json", "hi")), AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers["content-encoding"], "gzip");
  assert.strictEqual(gunzipSync(r.body).toString("utf8"), up.hits[0].text);
  const [line] = readLog(logFile);
  assert.strictEqual(line.real_context, 3000);
  assert.strictEqual(line.output_tokens, 7);
});

// Fake pxpipe library for the gain policy. Its saving follows a marker in the body text (the saving is
// always below the prefix size, as in the real transform): SMALLSAVE 100, MIDSAVE 1500, BIGSAVE 2500
// (default), HUGESAVE 5000. NOPROFIT is not applied. Each call appends a line to callsFile.
function writeFakeLib(name, callsFile) {
  const file = join(logDir, `${name}.lib.mjs`);
  writeFileSync(
    file,
    `import { appendFileSync } from "node:fs";
const SAVINGS = [["NOPROFIT", null], ["HUGESAVE", [6000, 1000]], ["MIDSAVE", [2000, 500]], ["SMALLSAVE", [500, 400]]];
export async function transformAnthropicMessages({ body }) {
  appendFileSync(${JSON.stringify(callsFile)}, "call\\n");
  const text = Buffer.from(body).toString("utf8");
  const hit = SAVINGS.find(([marker]) => text.includes(marker));
  if (hit && hit[1] === null) return { body, applied: false, reason: "not_profitable", info: {}, cache: {} };
  const [baseline, imaged] = hit ? hit[1] : [3000, 500];
  const info = { baselineImagedTokens: baseline, imageTokens: imaged, nativeInjectedTokens: 0 };
  return { body, applied: true, reason: "applied", info, cache: {} };
}
`,
  );
  return file;
}

// Body of about `chars` characters, starting with a marker, for one user_id.
function sized(user, marker, chars) {
  return bytesOf(msg(user, marker + "x".repeat(chars - marker.length)));
}

const callCount = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0);

// Gain-policy gate with window 10000: estimates are chars / 4, so 4000 chars is zone low, 12000 mid, 24000 high.
async function gainGate(name, extra = {}) {
  const calls = join(logDir, `${name}.calls`);
  const logFile = join(logDir, `${name}.jsonl`);
  const g = await startGate({
    GATE_POLICY: "gain",
    GATE_WINDOW: "10000",
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logFile,
    GATE_PXPIPE_LIB: writeFakeLib(name, calls),
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${direct.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${pxpipe.port}`,
    ...extra,
  });
  return { g, calls, logFile };
}

test("gain: measure below 0.20 of the window goes direct as zone_low, without the library", async () => {
  const { g, calls, logFile } = await gainGate("zone-low");
  const r = await post(g.port, "/v1/messages", sized("g-low", "", 4000), AUTH);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(callCount(calls), 0);
  const [line] = readLog(logFile);
  assert.deepStrictEqual([line.route, line.reason, line.policy, line.zone, line.saving], ["direct", "zone_low", "gain", "low", null]);
});

test("gain: mid zone with a small saving does not pay back, so it stays direct", async () => {
  const { g, calls, logFile } = await gainGate("mid-small");
  await post(g.port, "/v1/messages", sized("g-mid", "SMALLSAVE", 12000), AUTH);
  assert.strictEqual(callCount(calls), 1);
  const [line] = readLog(logFile);
  assert.deepStrictEqual([line.route, line.reason, line.zone, line.saving], ["direct", "not_worth_yet", "mid", 100]);
  assert.ok(line.dryrun_ms >= 0);
});

test("gain: mid zone with a big saving switches to pxpipe, and the session then sticks", async () => {
  const { g, calls, logFile } = await gainGate("mid-big");
  const first = await post(g.port, "/v1/messages", sized("g-big", "BIGSAVE", 12000), AUTH);
  assert.strictEqual(first.status, 200);
  const second = await post(g.port, "/v1/messages", bytesOf(msg("g-big", "short")), AUTH);
  assert.strictEqual(second.status, 200);
  assert.strictEqual(callCount(calls), 1);
  const [a, b] = readLog(logFile);
  // Measure ~3000, saving 2500: text cost 20 * 0.1 * P ~ 6000; pxpipe cost 1.25 * (P - S)
  // + 20 * 0.1 * (P - S) * 1.2 ~ 1825; the estimate carries a few tokens of JSON framing.
  assert.deepStrictEqual([a.route, a.reason, a.zone, a.saving], ["pxpipe", "gain", "mid", 2500]);
  const rest = a.measure - 2500;
  near(a.text_cost, 2 * a.measure);
  near(a.pxpipe_cost, 1.25 * rest + 2 * rest * 1.2);
  near(a.delta, a.text_cost - a.pxpipe_cost);
  near(a.predicted_after, rest);
  assert.deepStrictEqual([b.route, b.reason], ["pxpipe", "sticky"]);
});

test("gain: a larger overhead k turns the same mid-zone switch into not_worth_yet", async () => {
  const body = sized("g-k", "MIDSAVE", 12000);
  const { g: cheap, logFile: cheapLog } = await gainGate("k-default");
  await post(cheap.port, "/v1/messages", body, AUTH);
  assert.deepStrictEqual([readLog(cheapLog)[0].route, readLog(cheapLog)[0].reason], ["pxpipe", "gain"]);
  // k = 3: pxpipe cost ~1875 + 2 * 1500 * 4 = ~13875 > text cost ~6000.
  const { g: costly, logFile: costlyLog } = await gainGate("k-3", { GATE_OVERHEAD: "3" });
  await post(costly.port, "/v1/messages", body, AUTH);
  const [line] = readLog(costlyLog);
  assert.deepStrictEqual([line.route, line.reason], ["direct", "not_worth_yet"]);
  near(line.delta, -7875, 20);
});

test("gain: high zone with a saving switches as gain_high", async () => {
  const { g, calls, logFile } = await gainGate("high");
  await post(g.port, "/v1/messages", sized("g-high", "HUGESAVE", 24000), AUTH);
  assert.strictEqual(callCount(calls), 1);
  const [line] = readLog(logFile);
  assert.deepStrictEqual([line.route, line.reason, line.zone], ["pxpipe", "gain_high", "high"]);
});

test("gain: the first pxpipe answer with usage gives prediction_error against predicted_after", async () => {
  // Real context of the fake answer is 3000 (2000 + 900 + 100); predicted_after is 3000 - 2500 = 500.
  const up = await fakeUsageUpstream("sse");
  const { g, logFile } = await gainGate("predict", { GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${up.port}` });
  const r = await post(g.port, "/v1/messages", sized("g-pred", "BIGSAVE", 12000), AUTH);
  assert.strictEqual(r.status, 200);
  const [line] = readLog(logFile);
  assert.deepStrictEqual([line.route, line.real_context], ["pxpipe", 3000]);
  near(line.predicted_after, 500);
  assert.strictEqual(line.prediction_error, 3000 - line.predicted_after);
  const s = JSON.parse((await get(g.port, "/stats")).body);
  assert.deepStrictEqual([s.predictions, s.prediction_abs_error_sum], [1, Math.abs(line.prediction_error)]);
});

test("gain: a library answer that is not applied keeps the request direct", async () => {
  const { g, logFile } = await gainGate("noprofit");
  await post(g.port, "/v1/messages", sized("g-np", "NOPROFIT", 12000), AUTH);
  const [line] = readLog(logFile);
  assert.deepStrictEqual([line.route, line.reason], ["direct", "pxpipe_not_profitable"]);
});

test("gain: a missing library falls back to the threshold, with reason lib_missing", async () => {
  const missing = join(logDir, "does-not-exist.mjs");
  const logFile = join(logDir, "missing-lib.jsonl");
  const g = await startGate({
    GATE_POLICY: "gain",
    GATE_WINDOW: "10000",
    GATE_MIN_TOKENS: String(MIN_TOKENS),
    GATE_LOG: logFile,
    GATE_PXPIPE_LIB: missing,
    GATE_DIRECT_UPSTREAM: `http://127.0.0.1:${direct.port}`,
    GATE_PXPIPE_UPSTREAM: `http://127.0.0.1:${pxpipe.port}`,
  });
  // Measure 3000 is above MIN_TOKENS (1000), so the threshold sends it to pxpipe.
  await post(g.port, "/v1/messages", sized("g-missing", "", 12000), AUTH);
  await post(g.port, "/v1/messages", sized("g-missing-2", "", 12000), AUTH);
  const [a, b] = readLog(logFile);
  assert.deepStrictEqual([a.route, a.reason], ["pxpipe", "lib_missing"]);
  assert.deepStrictEqual([b.route, b.reason], ["pxpipe", "lib_missing"]);
  const errors = g.child.stderrText().split("\n").filter((l) => l.includes("pxpipe library not loaded"));
  assert.strictEqual(errors.length, 1, "the load failure is reported once");
});

test("gain: a second mid-zone request of the same size reuses the dry run as _cached", async () => {
  const { g, calls, logFile } = await gainGate("cached");
  await post(g.port, "/v1/messages", sized("g-cache", "SMALLSAVE", 12000), AUTH);
  await post(g.port, "/v1/messages", sized("g-cache", "SMALLSAVE", 12000), AUTH);
  assert.strictEqual(callCount(calls), 1);
  const [a, b] = readLog(logFile);
  assert.deepStrictEqual([a.reason, b.reason], ["not_worth_yet", "not_worth_yet_cached"]);
  assert.strictEqual(b.dryrun_ms, null);
  assert.strictEqual(b.saving, 100);
  const s = JSON.parse((await get(g.port, "/stats")).body);
  assert.deepStrictEqual([s.policy, s.window, s.dryruns], ["gain", 10000, 1]);
});

test("gain: an invalid GATE_POLICY or GATE_WINDOW exits with code 2", async () => {
  for (const env of [{ GATE_POLICY: "fast" }, { GATE_WINDOW: "0" }, { GATE_HORIZON: "2.5" }]) {
    const child = spawnGate(env);
    const code = await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        child.kill();
        reject(new Error(`gate did not exit for ${JSON.stringify(env)}`));
      }, 5000);
      child.once("exit", (c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
    assert.strictEqual(code, 2, JSON.stringify(env));
  }
});

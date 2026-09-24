/**
 * Telling a slow model apart from a dead host.
 *
 * Both used to look identical: `timed out after Nms`, after paying the whole budget. The
 * difference is not duration, it is whether any bytes ever arrive — a model generating slowly
 * still answers its headers quickly, and a host that has stopped talking never does.
 *
 * Offline: two local servers, one that holds the socket open and sends nothing, one that sends
 * headers immediately and dribbles the body out afterwards.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chatCompletion } from "../dist/client.js";

let silent, slow;
const sockets = new Set();

/** Accepts the connection, then says nothing at all. A wedged host. */
function silentServer() {
  const s = http.createServer(() => { /* never respond, never end */ });
  s.on("connection", (c) => sockets.add(c));
  return s;
}

/** Headers at once, body two seconds later. A model taking its time. */
function slowBodyServer() {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    // Node holds headers until the first body write unless told otherwise, so without this the
    // server would buffer them and look exactly like a wedged host — which is precisely the
    // real-world case firstByteMs must stay overridable for.
    res.flushHeaders();
    setTimeout(() => {
      res.end(JSON.stringify({ id: "c", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "took my time" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }, 900);
  });
  s.on("connection", (c) => sockets.add(c));
  return s;
}

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const provider = (port, extra = {}) => ({ name: "probe", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "k", defaultModel: "m", supportsTools: false, kind: "chat", ...extra });
const req = { model: "m", messages: [{ role: "user", content: "hi" }] };

before(async () => {
  silent = silentServer(); slow = slowBodyServer();
  silent.port = await listen(silent); slow.port = await listen(slow);
});
after(() => {
  for (const c of sockets) c.destroy();
  silent.close(); slow.close();
});

test("a host that accepts the connection and says nothing is no_response, not timeout", async () => {
  const started = Date.now();
  const err = await chatCompletion(provider(silent.port), req, { timeoutMs: 60_000, firstByteMs: 400 }).then(
    () => undefined,
    (e) => e,
  );
  const ms = Date.now() - started;

  assert.ok(err, "it has to fail");
  assert.equal(err.reason, "no_response", "named apart from timeout, or the breaker cannot weigh it differently");
  assert.match(err.message, /sent no response headers within 400ms/);
  assert.match(err.message, /firstByteMs/, "the message names the setting, so anyone bitten can fix it in one step");
  // The point of the whole change: it gives up in under a second instead of paying 60s.
  assert.ok(ms < 5_000, `should give up on the header deadline, not the total budget: ${ms}ms`);
});

test("a model that is merely slow is not killed by the header deadline", async () => {
  // Headers arrive at once and the body takes ~900ms. A deadline of 400ms must NOT fire,
  // because it is measuring time to headers and they already arrived.
  const r = await chatCompletion(provider(slow.port), req, { timeoutMs: 60_000, firstByteMs: 400 });
  assert.equal(r.message.content, "took my time", "slow generation is legitimate and must survive");
});

test("the deadline is off when it is zero, and the total budget still applies", async () => {
  const started = Date.now();
  const err = await chatCompletion(provider(silent.port), req, { timeoutMs: 700, firstByteMs: 0 }).then(
    () => undefined,
    (e) => e,
  );
  assert.equal(err.reason, "timeout", "with no header deadline it is an ordinary timeout again");
  assert.match(err.message, /timed out after 700ms/);
  assert.ok(Date.now() - started >= 600, "and it paid the full budget to get there");
});

test("a per-provider setting overrides the default", async () => {
  // A provider that buffers headers until its body is ready needs a longer rope, and gets one
  // without changing anyone else's.
  const r = await chatCompletion(provider(slow.port, { firstByteMs: 50 }), req, { timeoutMs: 60_000, firstByteMs: 50 });
  assert.equal(r.message.content, "took my time", "headers were immediate, so even 50ms is survivable here");
});

// --- silence after it started talking ----------------------------------------------------
// firstByteMs catches a host that never speaks. It cannot catch one that speaks and then
// stops: headers, half a token, then nothing. That was only ever caught by the total timeout,
// three minutes later, having produced nothing usable. What must NOT be caught is a model that
// is merely slow, so the deadline measures the gap between chunks and resets on each one.

/** Headers, one chunk, then silence forever. A host that stopped mid-answer. */
function stallMidBodyServer() {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    res.write('{"id":"c","choices":[{"index":0,');
    // and never another byte
  });
  s.on("connection", (c) => sockets.add(c));
  return s;
}

/** A whole answer, dribbled out in pieces with gaps under the deadline. Slow, not stalled. */
function dribbleServer() {
  const s = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    const payload = JSON.stringify({ id: "c", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "one piece at a time" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    const pieces = payload.match(/[\s\S]{1,20}/g);
    let i = 0;
    const tick = () => {
      if (i < pieces.length) { res.write(pieces[i++]); setTimeout(tick, 120); } else res.end();
    };
    tick();
  });
  s.on("connection", (c) => sockets.add(c));
  return s;
}

test("a host that stops mid-body is caught by its own deadline, not the total timeout", async () => {
  const srv = stallMidBodyServer();
  const port = await listen(srv);
  try {
    const started = Date.now();
    const err = await chatCompletion(provider(port), req, { timeoutMs: 60_000, firstByteMs: 2_000, bodyStallMs: 500 }).then(() => undefined, (e) => e);
    const ms = Date.now() - started;

    assert.ok(err, "it has to fail");
    // Named apart from both: headers DID arrive, so it is not no_response, and it must not wait
    // out the total budget, so it is not timeout. The breaker weighs the three differently.
    assert.equal(err.reason, "body_stall", `expected body_stall, got ${err.reason}: ${err.message}`);
    assert.match(err.message, /started answering, then sent nothing for 500ms/);
    assert.match(err.message, /bodyStallMs/, "the message names the setting, so anyone bitten can fix it in one step");
    assert.ok(ms < 10_000, `should give up on the stall deadline, not the 60s budget: ${ms}ms`);
  } finally { srv.close(); }
});

test("a body that keeps arriving in pieces is never killed, however long it takes", async () => {
  const srv = dribbleServer();
  const port = await listen(srv);
  try {
    // Gaps of ~120ms under a 500ms deadline, over a total far longer than the deadline itself.
    // Only silence is punished, not slowness — otherwise every long answer dies.
    const r = await chatCompletion(provider(port), req, { timeoutMs: 60_000, firstByteMs: 2_000, bodyStallMs: 500 });
    assert.equal(r.message.content, "one piece at a time");
  } finally { srv.close(); }
});

test("the stall deadline is off when it is zero, and the total budget still applies", async () => {
  const srv = stallMidBodyServer();
  const port = await listen(srv);
  try {
    const err = await chatCompletion(provider(port), req, { timeoutMs: 700, firstByteMs: 0, bodyStallMs: 0 }).then(() => undefined, (e) => e);
    assert.equal(err.reason, "timeout", "with no stall deadline a wedged body is an ordinary timeout again");
  } finally { srv.close(); }
});

// --- which hosts get a header deadline, and what a late timer means -------------------------
// ollama sends no headers until the whole answer is ready (ttfb=19.50s total=19.50s), so a header
// deadline there measures generation time and kills healthy answers. DeepSeek sends headers first
// and answered 426 calls past 20s under the same deadline, so it keeps the fast failure. And the
// deepseek "no_response" trips that looked like the opposite were this process freezing: timers
// set for 20000ms fired at 23-84s, three within 300ms, while another process got answers in 2s.

test("the header deadline stays on by default, and is off for ollama, which buffers headers", async () => {
  const { loadConfig, resolveProvider } = await import("../dist/config.js");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fb-default-"));
  const cfg = loadConfig({ workspaceRoot: tmp, configPath: path.join(tmp, "none.json") }).config;
  assert.equal(cfg.defaults.firstByteMs, 20_000, "a host that sends headers first still gets the fast failure");
  assert.equal(resolveProvider(cfg, "ollama").firstByteMs, 0, "ollama's headers arrive with its answer, so the deadline would measure generation");
  assert.equal(resolveProvider(cfg, "deepseek").firstByteMs, undefined, "no catalog opinion: the default applies");
});

test("a deadline that passed while this process was frozen is started again, not trusted", async () => {
  // The server lives in another process: freezing this one must not freeze it, exactly as a
  // real provider keeps answering while a gateway is blocked on a synchronous call.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", `
    const http = require("http");
    const s = http.createServer((q, r) => setTimeout(() => {
      r.writeHead(200, { "content-type": "application/json" });
      r.end(JSON.stringify({ id: "c", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "answered once it was asked" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }, 100));
    s.listen(0, "127.0.0.1", () => console.log(s.address().port));
  `], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve) => child.stdout.once("data", (b) => resolve(Number(String(b).trim()))));
  try {
    // Freeze BEFORE the request can leave: the case that matters. The 300ms deadline passes while
    // the request is still unsent, and without the restart the overdue timer aborts the moment
    // the process wakes - before the host has even seen the request. (Freezing after it has
    // left does not reproduce anything: Node reads the reply before the late abort lands.)
    const pending = chatCompletion(provider(port), req, { timeoutMs: 60_000, firstByteMs: 300 });
    const t0 = Date.now(); while (Date.now() - t0 < 1_500) { /* blocked, as on a sync git call */ }
    const r = await pending;
    assert.equal(r.message.content, "answered once it was asked", "the deadline measured the freeze, not the host");
  } finally { child.kill(); }
});

test("a host that is genuinely silent is still caught, freeze or no freeze", async () => {
  const started = Date.now();
  const err = await chatCompletion(provider(silent.port), req, { timeoutMs: 60_000, firstByteMs: 300 }).then(() => undefined, (e) => e);
  assert.equal(err?.reason, "no_response", "the guard delays the verdict; it does not change it");
  assert.ok(Date.now() - started < 5_000);
});

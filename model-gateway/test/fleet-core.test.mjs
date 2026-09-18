// Core tests for the fleet wake-queue module. These exercise the compiled
// module only (../dist/fleet.js) against a real temp directory; no MCP server
// and no mock provider are involved.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fleetDir,
  appendEvents,
  readEvents,
  pendingEvents,
  drainTo,
  classify,
} from "../dist/fleet.js";

let sessionDir;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-core-"));
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

const t = (ms) => new Date(ms).toISOString();

test("seq increments across separate appendEvents calls", () => {
  const first = appendEvents(sessionDir, [{ ts: t(0), kind: "job.done", id: "j1", reason: "done" }]);
  const second = appendEvents(sessionDir, [{ ts: t(1), kind: "job.failed", id: "j2", reason: "failed" }]);

  assert.equal(first[0].seq, 1);
  assert.equal(second[0].seq, 2);
  assert.deepEqual(readEvents(sessionDir).map((e) => e.seq), [1, 2]);
});

test("readEvents skips a deliberately truncated final line", () => {
  appendEvents(sessionDir, [{ ts: t(0), kind: "job.done", id: "j1", reason: "done" }]);
  const queue = path.join(fleetDir(sessionDir), "wake-queue.jsonl");
  fs.appendFileSync(queue, '{"seq":2,"ts":"2026-01-01T00:00:00.000Z","kind":"harness.output","id":"h","reason":"x"');

  const events = readEvents(sessionDir);
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);

  // The truncated line must not consume seq 2; the next append derives from the
  // last valid line in the file and starts on a fresh line.
  const next = appendEvents(sessionDir, [{ ts: t(1), kind: "job.done", id: "j2", reason: "done" }]);
  assert.equal(next[0].seq, 2);
  assert.deepEqual(readEvents(sessionDir).map((e) => e.seq), [1, 2]);
});

test("drainTo makes pendingEvents return only later events", () => {
  appendEvents(sessionDir, [
    { ts: t(0), kind: "job.done", id: "j1", reason: "done" },
    { ts: t(1), kind: "job.done", id: "j2", reason: "done" },
  ]);

  drainTo(sessionDir, 1);
  assert.deepEqual(pendingEvents(sessionDir).map((e) => e.seq), [2]);

  drainTo(sessionDir, 2);
  assert.deepEqual(pendingEvents(sessionDir), []);
});

test("classify on an unchanged snapshot returns []", () => {
  const prev = {
    ts: t(0),
    jobs: { j: "running" },
    harness: { h: { state: "running", digest: "d1", since: t(0) } },
  };
  const next = {
    ts: t(500),
    jobs: { j: "running" },
    harness: { h: { state: "running", digest: "d1", since: t(0) } },
  };

  assert.deepEqual(classify(prev, next, 10_000), []);
});

test("classify emits harness.output when a digest changes", () => {
  const prev = {
    ts: t(0),
    jobs: {},
    harness: { h: { state: "running", digest: "d1", since: t(0) } },
  };
  const next = {
    ts: t(500),
    jobs: {},
    harness: { h: { state: "running", digest: "d2", since: t(0) } },
  };

  const events = classify(prev, next, 10_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "harness.output");
  assert.equal(events[0].id, "h");
});

test("classify emits harness.idle only past the threshold", () => {
  const prev = {
    ts: t(0),
    jobs: {},
    harness: { h: { state: "running", digest: "d1", since: t(0) } },
  };

  const under = {
    ts: t(500),
    jobs: {},
    harness: { h: { state: "running", digest: "d1", since: t(0) } },
  };
  assert.deepEqual(classify(prev, under, 1000), []);

  const over = {
    ts: t(1500),
    jobs: {},
    harness: { h: { state: "running", digest: "d1", since: t(0) } },
  };
  const events = classify(prev, over, 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "harness.idle");
  assert.equal(events[0].id, "h");
});

test("drainTo never rewinds the cursor", () => {
  appendEvents(sessionDir, [
    { ts: t(0), kind: "job.done", id: "j1", reason: "done" },
    { ts: t(1), kind: "job.done", id: "j2", reason: "done" },
    { ts: t(2), kind: "job.done", id: "j3", reason: "done" },
  ]);

  drainTo(sessionDir, 3);
  assert.deepEqual(pendingEvents(sessionDir), []);

  // A stale caller draining to an earlier seq must not resurrect handled events:
  // re-emitting a wake-up is the exact failure the queue exists to prevent.
  drainTo(sessionDir, 1);
  assert.deepEqual(pendingEvents(sessionDir), []);
});

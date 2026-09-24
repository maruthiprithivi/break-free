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

// Offsets from now, not from 1970: an event that belongs to no workspace expires after an hour
// (fleet.ts UNSTAMPED_TTL_MS), and a 1970 timestamp is fifty-six years past it.
const BASE = Date.now();
const t = (ms) => new Date(BASE + ms).toISOString();

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

// --- one queue, many workspaces -------------------------------------------------
// A run_plan that finished in one repository once blocked a turn in an unrelated one,
// because the queue and its single integer cursor are shared by every workspace on the
// machine. These pin the fix, including the upgrade from that single integer.

const ev = (id, kind = "job.done") => ({ ts: t(1), kind, id, reason: "done" });

test("an event from another workspace does not block this one", () => {
  appendEvents(sessionDir, [ev("job-a")], "/repo/a");
  appendEvents(sessionDir, [ev("job-b")], "/repo/b");

  assert.deepEqual(pendingEvents(sessionDir, "/repo/a").map((e) => e.id), ["job-a"]);
  assert.deepEqual(pendingEvents(sessionDir, "/repo/b").map((e) => e.id), ["job-b"]);
  // Asking without a workspace still sees everything, for a machine-wide look.
  assert.deepEqual(pendingEvents(sessionDir).map((e) => e.id), ["job-a", "job-b"]);
});

test("draining one workspace leaves another's events pending", () => {
  const [a] = appendEvents(sessionDir, [ev("job-a")], "/repo/a");
  appendEvents(sessionDir, [ev("job-b")], "/repo/b");

  drainTo(sessionDir, a.seq, "/repo/a");
  assert.deepEqual(pendingEvents(sessionDir, "/repo/a"), [], "the workspace that drained sees nothing");
  assert.deepEqual(pendingEvents(sessionDir, "/repo/b").map((e) => e.id), ["job-b"], "and the other one has not lost its event");

  // Draining past another workspace's event must not drain it: b's cursor is its own.
  drainTo(sessionDir, 99, "/repo/a");
  assert.deepEqual(pendingEvents(sessionDir, "/repo/b").map((e) => e.id), ["job-b"]);
});

test("an event with no workspace belongs to nobody, so anyone can see and drain it", () => {
  // Rows written before the queue knew about workspaces. They must not become permanently
  // blocking events that no session will admit to owning.
  const [legacy] = appendEvents(sessionDir, [ev("legacy")]);
  assert.deepEqual(pendingEvents(sessionDir, "/repo/a").map((e) => e.id), ["legacy"]);
  assert.deepEqual(pendingEvents(sessionDir, "/repo/b").map((e) => e.id), ["legacy"]);
  drainTo(sessionDir, legacy.seq, "/repo/a");
  assert.deepEqual(pendingEvents(sessionDir, "/repo/a"), []);
});

test("a cursor file still holding a bare integer is a baseline for every workspace", () => {
  appendEvents(sessionDir, [ev("old-1")], "/repo/a");
  appendEvents(sessionDir, [ev("old-2")], "/repo/b");
  const [fresh] = appendEvents(sessionDir, [ev("new")], "/repo/a");

  // Simulate the pre-upgrade file: one integer, everything up to it already drained.
  fs.writeFileSync(path.join(fleetDir(sessionDir), "cursor"), "2");

  assert.deepEqual(pendingEvents(sessionDir, "/repo/a").map((e) => e.id), ["new"], "upgrading must not re-emit what was already drained");
  assert.deepEqual(pendingEvents(sessionDir, "/repo/b"), [], "the baseline applies to every workspace, not just the first to ask");

  // And the baseline is never rewound by a later per-workspace drain.
  drainTo(sessionDir, fresh.seq, "/repo/a");
  assert.deepEqual(pendingEvents(sessionDir, "/repo/b"), []);
});

test("a harness event belongs to the session's own directory, not to whoever noticed it", () => {
  // A crew session running in one project must not block the turn-end guard of another. The
  // gateway that polls is not the owner; the session's cwd is.
  const prev = { ts: t(0), jobs: {}, harness: { s1: { state: "running", digest: "aaa", since: t(0), cwd: "/repo/other" } } };
  const next = { ts: t(1000), jobs: {}, harness: { s1: { state: "running", digest: "bbb", since: t(1000), cwd: "/repo/other" } } };

  const events = classify(prev, next, 60_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "harness.output");
  assert.equal(events[0].workspace, "/repo/other", "the session's own directory owns the event");

  // The observing gateway's workspace must not overwrite it.
  appendEvents(sessionDir, events, "/repo/observer");
  assert.deepEqual(pendingEvents(sessionDir, "/repo/observer"), [], "the observer is not the owner");
  assert.equal(pendingEvents(sessionDir, "/repo/other").length, 1, "the owner still sees it");
});

test("a harness session with no recorded directory still reaches someone", () => {
  // Sessions from before cwd was carried have no owner. They must stay visible rather than
  // becoming events that block nobody and are never cleared.
  const prev = { ts: t(0), jobs: {}, harness: { s1: { state: "running", digest: "aaa", since: t(0) } } };
  const next = { ts: t(1000), jobs: {}, harness: { s1: { state: "exited", digest: "", since: t(1000) } } };
  const events = classify(prev, next, 60_000);
  assert.equal(events[0].kind, "harness.exited");
  assert.equal(events[0].workspace, undefined);
  // fleetCheck appends harness events WITHOUT a default owner, precisely so the observer does
  // not become the owner. An unowned event then stays visible to everyone.
  appendEvents(sessionDir, events);
  assert.equal(pendingEvents(sessionDir, "/repo/anyone").length, 1);
});

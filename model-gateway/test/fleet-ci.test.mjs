// CI queue tests for the fleet module. These exercise the compiled module only
// (../dist/fleet.js) against a real temp directory; no MCP server and no mock
// provider are involved.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendEvents,
  enqueueCi,
  expireCi,
  fleetDir,
  pendingEvents,
  readEvents,
  resolveCi,
} from "../dist/fleet.js";

let sessionDir;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-ci-"));
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

// Offsets from now, not from 1970: an event that belongs to no workspace expires after an hour
// (fleet.ts UNSTAMPED_TTL_MS), and a 1970 timestamp is fifty-six years past it.
const BASE = Date.now();
const t = (ms) => new Date(BASE + ms).toISOString();

test("enqueueCi twice for the same sha yields one pending event", () => {
  const first = enqueueCi(sessionDir, { repo: "acme/app", branch: "main", sha: "abc123" });
  const second = enqueueCi(sessionDir, { repo: "acme/app", branch: "main", sha: "abc123" });

  assert.equal(second.seq, first.seq);
  const pending = pendingEvents(sessionDir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "ci.pending");
  assert.equal(pending[0].ci.sha, "abc123");
});

test("resolveCi success removes the pending event", () => {
  enqueueCi(sessionDir, { sha: "abc123" });
  resolveCi(sessionDir, "abc123", { state: "success" });

  assert.deepEqual(pendingEvents(sessionDir), []);
  // The append-only queue itself is not rewritten.
  assert.equal(readEvents(sessionDir).length, 1);
});

test("resolveCi failed removes the pending event and adds a blocking ci.failed carrying the url", () => {
  enqueueCi(sessionDir, { repo: "acme/app", sha: "abc123" });
  resolveCi(sessionDir, "abc123", { state: "failed", runId: 42, url: "https://ci.example/run/42", job: "test" });

  const pending = pendingEvents(sessionDir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "ci.failed");
  assert.equal(pending[0].id, "abc123");
  assert.equal(pending[0].ci.url, "https://ci.example/run/42");
  assert.equal(pending[0].ci.runId, 42);
  assert.equal(pending[0].ci.job, "test");
  // The original pending line remains in the append-only queue.
  assert.deepEqual(readEvents(sessionDir).map((e) => e.kind), ["ci.pending", "ci.failed"]);
});

test("resolveCi pending is a no-op", () => {
  enqueueCi(sessionDir, { sha: "abc123" });
  resolveCi(sessionDir, "abc123", { state: "pending", runId: 7 });

  const pending = pendingEvents(sessionDir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].kind, "ci.pending");
  assert.equal(readEvents(sessionDir).length, 1);
});

test("expireCi clears a stale pending and returns 1", () => {
  appendEvents(sessionDir, [
    { ts: t(0), kind: "ci.pending", id: "old-sha", reason: "ci.pending", ci: { sha: "old-sha" } },
  ]);

  assert.equal(expireCi(sessionDir, BASE + 10_000, 5_000), 1);
  assert.deepEqual(pendingEvents(sessionDir), []);
  assert.equal(readEvents(sessionDir).length, 1);
});

test("a resolved event stays resolved across a fresh read", () => {
  // An older, unrelated pending event means the ci.pending cannot be drained by
  // moving the cursor; it must be excluded via the resolved sidecar instead.
  appendEvents(sessionDir, [
    { ts: t(0), kind: "job.done", id: "j1", reason: "done" },
    { ts: t(1), kind: "ci.pending", id: "abc123", reason: "ci.pending", ci: { sha: "abc123" } },
  ]);

  resolveCi(sessionDir, "abc123", { state: "success" });

  // Simulate a restart: pendingEvents has no in-memory state and reads the
  // sidecar from disk on every call.
  const pending = pendingEvents(sessionDir);
  assert.deepEqual(pending.map((e) => e.seq), [1]);
  assert.deepEqual(readEvents(sessionDir).map((e) => e.seq), [1, 2]);
  assert.ok(fs.existsSync(path.join(fleetDir(sessionDir), "resolved.json")));
});

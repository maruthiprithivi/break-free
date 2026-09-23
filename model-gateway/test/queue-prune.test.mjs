/**
 * Pruning the wake queue.
 *
 * The queue was append-only and nothing ever removed a line, so the cost of answering "is
 * anything pending" grew with the lifetime of the install rather than with how much was
 * happening. A live queue held 481 events, all of them long since collected.
 *
 * What may be dropped follows from how visibility is decided and from nothing else, so these
 * tests are written against visibility: after a prune, every reader must still see exactly
 * what it saw before, and the allocator must not hand out a number anyone has already passed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvents, pendingEvents, drainTo, resolveJob, pruneQueue, readEvents } from "../dist/fleet.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "prune-test-"));
const ev = (kind, id) => ({ ts: new Date().toISOString(), kind, id, reason: kind });
const queueFile = (sd) => path.join(sd, "fleet", "wake-queue.jsonl");

test("collected rows go, uncollected rows stay, and nobody's view changes", () => {
  const sd = tmp();
  const [a] = appendEvents(sd, [ev("job.done", "a")], "/repo/one");
  appendEvents(sd, [ev("job.done", "b")], "/repo/one");
  appendEvents(sd, [ev("job.done", "c")], "/repo/two");

  drainTo(sd, a.seq, "/repo/one"); // one has collected 'a' and nothing else
  const before = { one: pendingEvents(sd, "/repo/one").map((e) => e.id), two: pendingEvents(sd, "/repo/two").map((e) => e.id) };

  const { removed } = pruneQueue(sd);
  assert.equal(removed, 1, "exactly the collected row");
  assert.deepEqual(pendingEvents(sd, "/repo/one").map((e) => e.id), before.one, "one sees what it saw");
  assert.deepEqual(pendingEvents(sd, "/repo/two").map((e) => e.id), before.two, "two sees what it saw");
});

test("a workspace that has never drained still sees an unstamped event", () => {
  const sd = tmp();
  // No workspace on the event: visible to everybody, including a workspace that does not yet
  // exist and will inherit the baseline. Only the baseline can retire it.
  appendEvents(sd, [ev("provider.circuit_open", "ollama")]);
  drainTo(sd, 1, "/repo/one"); // one has collected it; a newcomer has not

  pruneQueue(sd);
  assert.equal(pendingEvents(sd, "/repo/one").length, 0);
  assert.equal(pendingEvents(sd, "/repo/brand-new").length, 1, "dropping it would hide it from a workspace that never saw it");
});

test("the allocator never rewinds, however much is pruned", () => {
  const sd = tmp();
  for (const id of ["a", "b", "c"]) appendEvents(sd, [ev("job.done", id)], "/repo/one");
  drainTo(sd, 3, "/repo/one"); // everything collected

  pruneQueue(sd);
  // The file is also the allocator's memory: prune it to nothing and the next append starts
  // below every cursor, handing out numbers each reader has already skipped past.
  const [next] = appendEvents(sd, [ev("job.done", "d")], "/repo/one");
  assert.ok(next.seq > 3, `the next seq must clear the drained ones, got ${next.seq}`);
  assert.deepEqual(pendingEvents(sd, "/repo/one").map((e) => e.id), ["d"], "and it is visible");
});

test("seq numbers are never renumbered", () => {
  const sd = tmp();
  for (const id of ["a", "b", "c", "d"]) appendEvents(sd, [ev("job.done", id)], "/repo/one");
  drainTo(sd, 2, "/repo/one");

  pruneQueue(sd);
  // Renumbering would rewind every workspace at once and re-emit the lot.
  assert.deepEqual(readEvents(sd).map((e) => ({ seq: e.seq, id: e.id })).filter((e) => e.id !== "b"), [
    { seq: 3, id: "c" },
    { seq: 4, id: "d" },
  ]);
});

test("the resolved sidecar shrinks with the rows it was tracking", () => {
  const sd = tmp();
  appendEvents(sd, [ev("job.done", "read-me")], "/repo/one");
  appendEvents(sd, [ev("job.done", "still-waiting")], "/repo/one");
  resolveJob(sd, "read-me");

  const sidecar = path.join(sd, "fleet", "resolved.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, "utf8")), [1]);

  pruneQueue(sd);
  // Remembering to skip a row that no longer exists is a list that only ever grows.
  assert.deepEqual(JSON.parse(fs.readFileSync(sidecar, "utf8")), []);
  assert.deepEqual(pendingEvents(sd, "/repo/one").map((e) => e.id), ["still-waiting"]);
});

test("pruning a queue with nothing collected changes nothing at all", () => {
  const sd = tmp();
  for (const id of ["a", "b"]) appendEvents(sd, [ev("job.done", id)], "/repo/one");
  const before = fs.readFileSync(queueFile(sd), "utf8");

  assert.deepEqual(pruneQueue(sd), { removed: 0, kept: 2 });
  assert.equal(fs.readFileSync(queueFile(sd), "utf8"), before, "an untouched file is not rewritten");
  assert.equal(pruneQueue(tmp()).removed, 0, "and an empty queue is not an error");
});

test("the queue stops growing without bound", () => {
  const sd = tmp();
  // Well past the prune threshold, all of it collected as it goes — the shape of a machine
  // that has been running for weeks.
  for (let i = 0; i < 600; i += 1) {
    const [e] = appendEvents(sd, [ev("harness.idle", `session-${i}`)], "/repo/one");
    drainTo(sd, e.seq, "/repo/one");
  }
  // It sawtooths rather than staying small: rows accumulate until an append crosses the
  // threshold, then collapse. What matters is that the file is bounded by that threshold
  // instead of by how long the install has been running.
  const appends = 600;
  const lines = fs.readFileSync(queueFile(sd), "utf8").trim().split("\n").length;
  assert.ok(lines < appends / 2, `the file should have been pruned along the way, holds ${lines} rows after ${appends} appends`);
  assert.equal(pendingEvents(sd, "/repo/one").length, 0);

  // And it is still a working queue afterwards.
  appendEvents(sd, [ev("job.done", "after")], "/repo/one");
  assert.deepEqual(pendingEvents(sd, "/repo/one").map((e) => e.id), ["after"]);
});


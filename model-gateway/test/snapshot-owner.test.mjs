/**
 * A snapshot is a private memory, and cannot be shared.
 *
 * Every gateway puts only its OWN workspace's jobs into the fleet snapshot, but they all wrote
 * to one `snapshot.json` in the shared session directory. So each gateway's "what I saw last
 * time" was whichever other project happened to check last — its own finished jobs were absent
 * from that view, looked new again, and were announced again.
 *
 * The live queue that prompted this: 337 rows, 93 distinct notices announced more than once,
 * several jobs announced four times, hours apart, in batches of consecutive sequence numbers.
 * That shape is the signature of two gateways taking turns overwriting each other's memory.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classify, readSnapshot, writeSnapshot } from "../dist/fleet.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "snap-test-"));
const snap = (jobs, ts = new Date().toISOString()) => ({ ts, jobs, harness: {} });

/** One gateway's turn: read my own memory, compare, record. Returns what it announced. */
function check(sd, workspace, jobs) {
  const prev = readSnapshot(sd, workspace);
  const next = snap(jobs);
  const events = classify(prev, next, 60_000).filter((e) => e.kind.startsWith("job."));
  writeSnapshot(sd, next, workspace);
  return events.map((e) => e.id);
}

test("two workspaces taking turns do not re-announce each other's finished jobs", () => {
  const sd = tmp();
  const A = "/repo/alpha", B = "/repo/beta";

  // First look for each is a baseline: a gateway that has never looked cannot tell what is new
  // from what has always been there, and announcing everything is the flood, not the news.
  assert.deepEqual(check(sd, A, { "job-a1": "done", "job-a2": "done" }), []);
  assert.deepEqual(check(sd, B, { "job-b1": "done" }), []);

  // Now the interleaving that caused the bug: each gateway checks repeatedly, seeing only its
  // own jobs, while the other writes in between. With one shared file, every one of these
  // returned the whole job list again.
  for (let round = 0; round < 4; round += 1) {
    assert.deepEqual(check(sd, A, { "job-a1": "done", "job-a2": "done" }), [], `A re-announced in round ${round}`);
    assert.deepEqual(check(sd, B, { "job-b1": "done" }), [], `B re-announced in round ${round}`);
  }
});

test("a job that finished since the last look is still announced, once", () => {
  const sd = tmp();
  const A = "/repo/alpha";
  check(sd, A, { "old-job": "done" }); // baseline

  // Started and finished between two checks: absent from the previous view and already
  // terminal. That is genuinely new and must be reported.
  assert.deepEqual(check(sd, A, { "old-job": "done", "fresh": "done" }), ["fresh"]);
  // But only the once.
  assert.deepEqual(check(sd, A, { "old-job": "done", "fresh": "done" }), []);
  // And a running job that then finishes is a transition, reported when it happens.
  assert.deepEqual(check(sd, A, { "old-job": "done", "fresh": "done", "slow": "running" }), []);
  assert.deepEqual(check(sd, A, { "old-job": "done", "fresh": "done", "slow": "failed" }), ["slow"]);
});

test("each workspace keeps its own snapshot file, and one cannot read another's", () => {
  const sd = tmp();
  writeSnapshot(sd, snap({ "mine": "done" }), "/repo/alpha");
  writeSnapshot(sd, snap({ "theirs": "done" }), "/repo/beta");

  assert.deepEqual(Object.keys(readSnapshot(sd, "/repo/alpha").jobs), ["mine"]);
  assert.deepEqual(Object.keys(readSnapshot(sd, "/repo/beta").jobs), ["theirs"]);
  assert.equal(readSnapshot(sd, "/repo/never-seen"), undefined, "an unknown workspace has no memory, not someone else's");

  // Two files, not one. This is the property the bug violated.
  const files = fs.readdirSync(path.join(sd, "fleet")).filter((f) => f.startsWith("snapshot"));
  assert.equal(files.length, 2, `expected one snapshot per workspace, got ${files.join(", ")}`);
});

test("an upgrade does not inherit the shared file as its own memory", () => {
  const sd = tmp();
  // What an existing install has on disk: the old shared snapshot, holding whichever project
  // checked last. Adopting it would make every other workspace's jobs look like ours.
  fs.mkdirSync(path.join(sd, "fleet"), { recursive: true });
  fs.writeFileSync(path.join(sd, "fleet", "snapshot.json"), JSON.stringify(snap({ "someone-elses": "done" })));

  assert.equal(readSnapshot(sd, "/repo/alpha"), undefined, "a workspace starts with no memory, not a stranger's");
  assert.deepEqual(check(sd, "/repo/alpha", { "my-job": "done" }), [], "and its first look is a baseline");
});

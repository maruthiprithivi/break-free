/**
 * Every wake event has an owner, and one that has none cannot ask for attention forever.
 *
 * #90 deduplicated unstamped events against `baseline`, and nothing ever advances `baseline`.
 * So one stale `provider.circuit_open deepseek` row stayed "pending" for good: it blocked the
 * first turn of every new worktree, was never pruned, and - because the deduplicator saw it as
 * outstanding - no later deepseek outage could ever be reported. CI events were worse: written
 * with no owner at all, so every session on the machine blocked on another project's push.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvents, pendingEvents, drainTo, pruneQueue, resolveJob, enqueueCi, resolveCi, expireCi, readEvents } from "../dist/fleet.js";

const HOUR = 60 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "owner-test-"));
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const circuit = (ts) => ({ ts, kind: "provider.circuit_open", id: "deepseek", reason: "2 consecutive timeouts" });

test("a stale unstamped event no longer mutes the next outage with the same id", () => {
  const sd = tmp();
  appendEvents(sd, [circuit(ago(2 * HOUR))]);
  // The exact regression: this was suppressed as a duplicate of a two-hour-old row.
  assert.equal(appendEvents(sd, [circuit(ago(0))]).length, 1, "a new outage is news, whatever happened two hours ago");
});

test("an unstamped event stops blocking once it is older than its time to live", () => {
  const sd = tmp();
  appendEvents(sd, [circuit(ago(2 * HOUR))]);
  // A brand-new worktree has no cursor and inherits baseline 0 - it used to see every such row.
  assert.deepEqual(pendingEvents(sd, "/repo/brand-new-worktree"), [], "history is not news to a workspace that just arrived");
});

test("a fresh unstamped event is still shown to everyone, and still deduplicated", () => {
  const sd = tmp();
  appendEvents(sd, [circuit(ago(60_000))]);
  assert.equal(appendEvents(sd, [circuit(ago(0))]).length, 0, "within the hour, the same outage is one notice");
  assert.equal(pendingEvents(sd, "/repo/a").length, 1);
  assert.equal(pendingEvents(sd, "/repo/b").length, 1, "a provider outage is everybody's business while it is current");
});

test("an expired unstamped row is pruned instead of living for ever", () => {
  const sd = tmp();
  appendEvents(sd, [circuit(ago(3 * HOUR))]);
  appendEvents(sd, [{ ts: ago(0), kind: "job.done", id: "keep", reason: "done" }], "/repo/a");
  pruneQueue(sd);
  assert.deepEqual(readEvents(sd).map((e) => e.id), ["keep"], "only the live row survives");
});

test("a push in one project does not block a session in another", () => {
  const sd = tmp();
  enqueueCi(sd, { sha: "abc1234", branch: "feat" }, "/repo/pusher");
  assert.equal(pendingEvents(sd, "/repo/pusher").length, 1, "the project that pushed is waiting on its run");
  assert.deepEqual(pendingEvents(sd, "/repo/bystander"), [], "an unrelated session has nothing to wait for");
});

test("a session whose gh cannot answer does not cancel another project's CI watch", () => {
  const sd = tmp();
  enqueueCi(sd, { sha: "abc1234" }, "/repo/pusher");
  // The bystander's reconcile: gh failed in its own repo, so it expires with timeout 0.
  assert.equal(expireCi(sd, Date.now(), 0, "/repo/bystander"), 0, "it may only give up on its own runs");
  assert.equal(pendingEvents(sd, "/repo/pusher").length, 1, "the owner is still watching");
});

test("a CI failure is reported to the project that pushed, and only to it", () => {
  const sd = tmp();
  enqueueCi(sd, { sha: "abc1234" }, "/repo/pusher");
  resolveCi(sd, "abc1234", { state: "failed", runId: 7, url: "https://ci/7", job: "test" }, "/repo/pusher");
  assert.deepEqual(pendingEvents(sd, "/repo/pusher").map((e) => e.kind), ["ci.failed"]);
  assert.deepEqual(pendingEvents(sd, "/repo/bystander"), [], "being told to fix another repo's CI is not actionable");
});

test("resolving a run clears it for its owner even when the no-workspace cursor has run ahead", () => {
  const sd = tmp();
  enqueueCi(sd, { sha: "abc1234" }, "/repo/pusher");
  // Something drains without naming a workspace, far past the CI row - the live machine's
  // "" cursor stood at 1368. The old resolver read through that cursor and missed the row.
  // The filler belongs to another project: it exists only so there is something to drain past.
  appendEvents(sd, [{ ts: ago(0), kind: "job.done", id: "filler", reason: "done" }], "/repo/elsewhere");
  drainTo(sd, 5_000);
  resolveCi(sd, "abc1234", { state: "success" }, "/repo/pusher");
  assert.deepEqual(pendingEvents(sd, "/repo/pusher"), [], "a finished run no longer blocks its owner");

});

test("reading a job's result clears its event even when the no-workspace cursor has run ahead", () => {
  const sd = tmp();
  appendEvents(sd, [{ ts: ago(0), kind: "job.done", id: "run_plan-x", reason: "done" }], "/repo/a");
  drainTo(sd, 5_000); // the "" key, far past the row
  assert.equal(resolveJob(sd, "run_plan-x"), 1, "it must reach the row regardless of any cursor");
  assert.deepEqual(pendingEvents(sd, "/repo/a"), []);
});

test("duplicates written by an old gateway are reported once, and one drain clears them all", () => {
  const sd = tmp();
  // What a gateway started before the write-side deduplicator produces: raw repeats. Written
  // straight to the file, since the current appendEvents would refuse them.
  const dir = path.join(sd, "fleet");
  fs.mkdirSync(dir, { recursive: true });
  const rows = [1, 2, 3, 4].map((seq) => ({ seq, ts: ago(0), kind: "job.done", id: "run_plan-dup", reason: "done", workspace: "/repo/a" }));
  fs.writeFileSync(path.join(dir, "wake-queue.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

  const shown = pendingEvents(sd, "/repo/a");
  assert.equal(shown.length, 1, "four copies of one finished job are one piece of work");
  // The last copy is kept, so draining to what the reader was shown clears every hidden copy.
  // Keeping the first would leave seq 2..4 above the cursor, to block again next turn.
  assert.equal(shown[0].seq, 4);
  drainTo(sd, Math.max(...shown.map((e) => e.seq)), "/repo/a");
  assert.deepEqual(pendingEvents(sd, "/repo/a"), [], "nothing hidden survives the drain");
});

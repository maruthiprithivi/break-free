/**
 * Forgetting workspaces that stopped asking.
 *
 * The cursor file keeps one entry per workspace that ever drained, and a long-lived machine
 * held 228 of them / 14.6 KB — parsed on every append, every read and every prune.
 *
 * The obvious fix, dropping keys whose directory is gone, was written and reverted: dropping a
 * key resets that workspace's floor to `baseline`, so it re-sees every event it already
 * collected, and `fs.existsSync() === false` means "not readable right now" — an unmounted
 * volume, a detached container — not "deleted". These tests pin the rule that replaced it:
 * retire on silence, never on a path lookup.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEvents, pendingEvents, drainTo, pruneQueue } from "../dist/fleet.js";

const DAY = 24 * 60 * 60 * 1000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "retire-test-"));
const ev = (id) => ({ ts: new Date().toISOString(), kind: "job.done", id, reason: "done" });
const cursorPath = (sd) => path.join(sd, "fleet", "cursor");
const cursors = (sd) => JSON.parse(fs.readFileSync(cursorPath(sd), "utf8"));
const writeCursors = (sd, c) => fs.writeFileSync(cursorPath(sd), JSON.stringify(c));

/** Enough collected rows for pruneQueue to have work to do. */
function busyQueue(sd, workspaces) {
  for (const ws of workspaces) {
    const [e] = appendEvents(sd, [ev(`job-${ws}`)], ws);
    drainTo(sd, e.seq, ws);
  }
}

test("a key idle past the threshold is retired; one seen recently is kept", () => {
  const sd = tmp();
  busyQueue(sd, ["/repo/active", "/repo/abandoned"]);

  const c = cursors(sd);
  c.lastSeen["/repo/abandoned"] = Date.now() - 31 * DAY;
  c.lastSeen["/repo/active"] = Date.now() - 2 * DAY;
  writeCursors(sd, c);

  pruneQueue(sd);
  const after = cursors(sd);
  assert.equal(after.byWorkspace["/repo/abandoned"], undefined, "thirty days of silence is enough to forget");
  assert.ok(after.byWorkspace["/repo/active"] !== undefined, "two days is not");
  assert.equal(after.lastSeen["/repo/abandoned"], undefined, "and its timestamp goes with it");
});

test("retirement is by silence, not by whether the path is readable", () => {
  const sd = tmp();
  // A path that has never existed on this machine, drained seconds ago. The reverted fix would
  // have dropped it; an unmounted volume or detached container looks exactly like this.
  const away = "/Volumes/not-mounted-right-now/repo";
  busyQueue(sd, [away]);
  assert.equal(fs.existsSync(away), false, "precondition: the path is not readable");

  pruneQueue(sd);
  assert.ok(cursors(sd).byWorkspace[away] !== undefined, "an unreadable path is not a deleted workspace");
});

test("a legacy cursor file survives the upgrade and loses nothing", () => {
  const sd = tmp();
  const [e] = appendEvents(sd, [ev("a")], "/repo/legacy");
  appendEvents(sd, [ev("b")], "/repo/legacy");

  // What an existing install has on disk: marks, but no lastSeen field at all.
  writeCursors(sd, { baseline: 0, byWorkspace: { "/repo/legacy": e.seq } });

  pruneQueue(sd);
  const after = cursors(sd);
  assert.equal(after.byWorkspace["/repo/legacy"], e.seq, "a key never seen is kept, not retired");
  // The mark still does its job: 'a' stays collected, 'b' stays pending.
  assert.deepEqual(pendingEvents(sd, "/repo/legacy").map((x) => x.id), ["b"]);
});

test("a key with no recorded last-seen is never retired, however old the file", () => {
  const sd = tmp();
  busyQueue(sd, ["/repo/one"]);
  const c = cursors(sd);
  delete c.lastSeen["/repo/one"]; // seen before the field existed
  writeCursors(sd, c);

  pruneQueue(sd);
  // "Never seen" and "seen long ago" are different claims, and only one justifies forgetting.
  assert.ok(cursors(sd).byWorkspace["/repo/one"] !== undefined);
});

test("an active workspace never re-sees what it already drained", () => {
  const sd = tmp();
  const ws = "/repo/active";
  const [first] = appendEvents(sd, [ev("collected")], ws);
  drainTo(sd, first.seq, ws);
  appendEvents(sd, [ev("outstanding")], ws);

  pruneQueue(sd);
  // The whole reason the path check was reverted.
  assert.deepEqual(pendingEvents(sd, ws).map((e) => e.id), ["outstanding"]);
});

test("the no-workspace key is never retired", () => {
  const sd = tmp();
  appendEvents(sd, [ev("unstamped")]);
  drainTo(sd, 1);
  const c = cursors(sd);
  c.lastSeen[""] = Date.now() - 400 * DAY;
  writeCursors(sd, c);

  pruneQueue(sd);
  // "" is not a workspace that can go away; it is every caller that names none, and dropping
  // its mark would re-show them everything the machine has ever queued.
  assert.ok(cursors(sd).byWorkspace[""] !== undefined);
});

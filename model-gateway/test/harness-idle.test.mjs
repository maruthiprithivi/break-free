/**
 * One idle period is one event.
 *
 * harness.idle is a condition: a sub-agent waiting at a permission prompt stays idle for as long
 * as nobody answers it. It used to be derived afresh at every check, so once the owning session
 * drained it the very next check raised it again - that session was blocked at every turn end
 * until someone killed the harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { classify } from "../dist/fleet.js";

const MIN = 60_000;
const at = (m) => new Date(Date.UTC(2026, 8, 24, 12, 0) + m * MIN).toISOString();
const snap = (m, digest, since, extra = {}) => ({ ts: at(m), jobs: {}, harness: { h1: { state: "running", digest, since: at(since), cwd: "/repo/a", ...extra } } });

/** One check: what classify reports, and the snapshot it leaves to be persisted. */
function step(prev, m, digest, since) {
  // Built fresh with no marker, exactly as buildFleetSnapshot does: carrying it forward is
  // classify's job, and a test that carried it here would hide that job not being done.
  const next = snap(m, digest, since);
  const events = classify(prev, next, 5 * MIN).filter((e) => e.kind === "harness.idle");
  return { next, idle: events.length };
}

test("a harness that stays idle is reported once, not once per check", () => {
  let s = snap(0, "same", 0);
  const reported = [];
  for (let m = 1; m <= 60; m += 1) {
    const r = step(s, m, "same", 0);
    reported.push(r.idle);
    s = r.next;
  }
  // Idle crosses 5 minutes at m=6, and then an hour of the same screen follows.
  assert.equal(reported.reduce((a, b) => a + b, 0), 1, "an hour at one prompt is one piece of news");
  assert.equal(reported.indexOf(1), 5, "raised when it first became idle");
});

test("new output ends the period, and the next idle period is news again", () => {
  let s = snap(0, "a", 0);
  let total = 0;
  for (let m = 1; m <= 10; m += 1) { const r = step(s, m, "a", 0); total += r.idle; s = r.next; }
  assert.equal(total, 1);
  // The sub-agent prints something: a new digest, a new `since`, a fresh period.
  let r = step(s, 11, "b", 11); s = r.next;
  for (let m = 12; m <= 25; m += 1) { r = step(s, m, "b", 11); total += r.idle; s = r.next; }
  assert.equal(total, 2, "a second, separate wait at a prompt is reported");
});

test("a snapshot written before the marker existed still reports the period, once", () => {
  // An upgraded gateway reads a snapshot with no idleReported field.
  let s = snap(20, "same", 0);
  let total = 0;
  for (let m = 21; m <= 40; m += 1) { const r = step(s, m, "same", 0); total += r.idle; s = r.next; }
  assert.equal(total, 1);
});

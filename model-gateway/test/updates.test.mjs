/**
 * Checking whether break-free is current.
 *
 * Offline and deterministic: real git repositories in a temp directory, a local path as
 * origin, no network. The cases worth pinning are the ones where the honest answer is "I do
 * not know" or "nothing to say" — a check that reports 0 when it failed, or a notice that
 * appears every session, are both worse than no feature.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { behindOrigin, isCheckout, readCache, writeCache, cacheIsWarm, notice } from "../dist/updates.js";

const git = (cwd, args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "upd-test-"));

/** An upstream and a clone of it, the shape every real install has. */
function pair() {
  const upstream = tmp();
  fs.writeFileSync(path.join(upstream, "AGENTS.md"), "# rules\n");
  fs.writeFileSync(path.join(upstream, "readme.md"), "prose\n");
  git(upstream, ["init", "-q", "-b", "main"]);
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-q", "-m", "one"]);
  const clone = path.join(tmp(), "clone");
  git(path.dirname(clone), ["clone", "-q", upstream, clone]);
  return { upstream, clone };
}

test("a directory that is not a checkout is said to be, not guessed at", async () => {
  assert.equal(isCheckout(tmp()), false);
  assert.equal(isCheckout(""), false);
  const { clone } = pair();
  assert.equal(isCheckout(clone), true);
  assert.equal((await behindOrigin(tmp())).reason, "not a git checkout");
});

test("behind is counted, and a failure to ask is never reported as nothing-new", async () => {
  const { upstream, clone } = pair();
  assert.equal((await behindOrigin(clone)).behind, 0, "level with origin");

  fs.writeFileSync(path.join(upstream, "AGENTS.md"), "# rules CHANGED\n");
  git(upstream, ["commit", "-qam", "two"]);
  fs.writeFileSync(path.join(upstream, "readme.md"), "more prose\n");
  git(upstream, ["commit", "-qam", "three"]);

  assert.equal((await behindOrigin(clone)).behind, 0, "without a fetch the clone only knows what it heard");
  assert.equal((await behindOrigin(clone, { fetch: true })).behind, 2);

  // An unreachable origin must be undefined, never 0. "I could not ask" and "there is nothing
  // new" are different answers and only one of them is good news.
  fs.rmSync(upstream, { recursive: true, force: true });
  const broken = await behindOrigin(clone, { fetch: true });
  assert.equal(broken.behind, undefined);
  assert.match(broken.reason, /could not reach origin/);
});

test("the cache is warm for its interval and cold after it", () => {
  const dir = tmp();
  const state = { checkedAt: new Date().toISOString(), components: [], applied: [] };
  writeCache(dir, state);
  assert.equal(readCache(dir).checkedAt, state.checkedAt);

  assert.equal(cacheIsWarm(state, 6), true);
  assert.equal(cacheIsWarm(state, 0), false, "a zero interval means always check");
  assert.equal(cacheIsWarm({ checkedAt: new Date(Date.now() - 7 * 3600_000).toISOString(), components: [], applied: [] }, 6), false);
  assert.equal(cacheIsWarm(undefined, 6), false);
  // A clock that moved backwards must not produce a cache warm for eternity.
  assert.equal(cacheIsWarm({ checkedAt: new Date(Date.now() + 99 * 3600_000).toISOString(), components: [], applied: [] }, 6), false);
  assert.equal(cacheIsWarm({ checkedAt: "not a date", components: [], applied: [] }, 6), false);
  assert.equal(readCache(tmp()), undefined, "no cache is undefined, not a crash");
});

test("nothing to say produces no notice at all", () => {
  // A notice every session stops being read, and then the one that mattered is missed with it.
  assert.equal(notice(undefined), undefined);
  assert.equal(notice({ checkedAt: "x", components: [], applied: [] }), undefined);
  assert.equal(
    notice({ checkedAt: "x", applied: [], components: [{ name: "break-free", root: "/r", behind: 0, instructionChanges: [] }] }),
    undefined,
    "current is not news",
  );
  // Old cache entries for Firstmate are ignored.
  assert.equal(notice({ checkedAt: "x", applied: [{ name: "firstmate", from: "a", to: "b" }], components: [{ name: "firstmate", root: "/fm", behind: 2, instructionChanges: [] }] }), undefined);
});

test("a waiting break-free update names the rebuild command", () => {
  const waiting = notice({ checkedAt: "x", applied: [], components: [{ name: "break-free", root: "/bf", behind: 3, instructionChanges: [] }] });
  assert.match(waiting, /break-free is 3 commit\(s\) behind/);
  assert.match(waiting, /node \/bf\/setup\.mjs --update/);
  assert.match(waiting, /rebuilds/);
});

test("break-free is never reported as updated by a source-only merge", () => {
  // It used to be fast-forwarded in the background with no rebuild, so every session kept
  // running the old build while the notice announced "break-free updated".
  const n = notice({ checkedAt: "x", applied: [], components: [{ name: "break-free", root: "/bf", behind: 2, instructionChanges: [] }] });
  assert.doesNotMatch(n, /updated/);
});

// --- whose job is it ------------------------------------------------------------------
// The job store is one directory shared by every project on the machine. Without an owner
// on each record, a gateway reading it cannot tell its own work from anyone else's — and the
// fleet watcher stamped another project's finished job with whichever workspace noticed it,
// blocking an unrelated turn.

test("a job record carries the workspace that started it, and listing can be scoped to it", async () => {
  const { JobRegistry } = await import("../dist/jobs.js");
  const sessionDir = tmp();
  const cfg = { sessionDir, budget: { perTaskUsd: 0, perPlanUsd: 0, perDayUsd: 0 } };

  const mine = new JobRegistry(cfg, false, "/repo/mine");
  const theirs = new JobRegistry(cfg, false, "/repo/theirs");
  mine.start("delegate", "my work", async () => ({ text: "ok" }));

  // Written straight to disk: a running job lives in memory and only lands there when it
  // finishes, and what is under test is ownership, not the job lifecycle.
  fs.mkdirSync(path.join(sessionDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "jobs", "theirs-1.json"),
    JSON.stringify({ id: "theirs-1", kind: "run_plan", label: "their work", workspace: "/repo/theirs", state: "done", createdAt: new Date(Date.now() - 1000).toISOString(), progress: [] }),
  );

  // Both registries read the same directory, which is the shape that caused the bug.
  assert.equal(mine.list().length, 2, "everything on the machine is still listable");
  assert.deepEqual(mine.list({ mine: true }).map((j) => j.label), ["my work"], "scoped to this workspace");
  assert.deepEqual(theirs.list({ mine: true }).map((j) => j.label), ["their work"]);
  assert.ok(theirs.list({ mine: true }).every((j) => j.label !== "my work"), "and never the other way round");
  assert.equal(mine.list({ mine: true })[0].workspace, "/repo/mine");
});

test("a job record written before it had an owner stays visible to everyone", async () => {
  const { JobRegistry } = await import("../dist/jobs.js");
  const sessionDir = tmp();
  fs.mkdirSync(path.join(sessionDir, "jobs"), { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "jobs", "legacy-1.json"),
    JSON.stringify({ id: "legacy-1", kind: "delegate", label: "from before", state: "done", createdAt: new Date().toISOString(), progress: [] }),
  );
  const r = new JobRegistry({ sessionDir, budget: {} }, false, "/repo/mine");
  // An upgrade must not make work someone is relying on disappear from their listing.
  assert.deepEqual(r.list({ mine: true }).map((j) => j.label), ["from before"]);
});

test("a fetch that never answers does not block the process while it waits", async () => {
  // The old fetch was execFileSync inside an async function that ran before its first await,
  // so "fire and forget" froze the event loop for the whole timeout - at startup and at every
  // Stop hook. Here the remote is a listener that accepts and never speaks.
  const net = await import("node:net");
  // Every accepted socket is destroyed afterwards: server.close() waits for open connections,
  // and one left behind keeps this test file's process alive for ever.
  const conns = new Set();
  const silent = net.createServer((c) => conns.add(c));
  await new Promise((r) => silent.listen(0, "127.0.0.1", r));
  const { clone } = pair();
  git(clone, ["remote", "set-url", "origin", `http://127.0.0.1:${silent.address().port}/repo.git`]);

  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 20);
  const r = await behindOrigin(clone, { fetch: true, timeoutMs: 800 });
  clearInterval(ticker);
  for (const c of conns) c.destroy();
  silent.close();

  assert.equal(r.behind, undefined, "an unreachable origin is never reported as nothing-new");
  assert.match(r.reason, /could not reach origin/);
  // A blocked event loop would have produced zero ticks across the whole wait.
  assert.ok(ticks >= 10, `the event loop must keep running during the fetch, saw ${ticks} ticks`);
});

/**
 * Keeping break-free and firstmate current.
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

test("a directory that is not a checkout is said to be, not guessed at", () => {
  assert.equal(isCheckout(tmp()), false);
  assert.equal(isCheckout(""), false);
  const { clone } = pair();
  assert.equal(isCheckout(clone), true);
  assert.equal(behindOrigin(tmp()).reason, "not a git checkout");
});

test("behind is counted, and a failure to ask is never reported as nothing-new", () => {
  const { upstream, clone } = pair();
  assert.equal(behindOrigin(clone).behind, 0, "level with origin");

  fs.writeFileSync(path.join(upstream, "AGENTS.md"), "# rules CHANGED\n");
  git(upstream, ["commit", "-qam", "two"]);
  fs.writeFileSync(path.join(upstream, "readme.md"), "more prose\n");
  git(upstream, ["commit", "-qam", "three"]);

  assert.equal(behindOrigin(clone).behind, 0, "without a fetch the clone only knows what it heard");
  assert.equal(behindOrigin(clone, { fetch: true }).behind, 2);

  // An unreachable origin must be undefined, never 0. "I could not ask" and "there is nothing
  // new" are different answers and only one of them is good news.
  fs.rmSync(upstream, { recursive: true, force: true });
  const broken = behindOrigin(clone, { fetch: true });
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
  // A component that could not be checked is also not news — it is a reason, not an update.
  assert.equal(
    notice({ checkedAt: "x", applied: [], components: [{ name: "firstmate", root: "/r", instructionChanges: [], reason: "could not reach origin" }] }),
    undefined,
  );
});

test("an applied update names the rollback, and a waiting one names the command", () => {
  const applied = notice({
    checkedAt: "x",
    applied: [{ name: "firstmate", from: "abcdef1234567890", to: "1234567890abcdef" }],
    components: [{ name: "firstmate", root: "/fm", behind: 0, instructionChanges: ["AGENTS.md", "bin/fm-spawn.sh"] }],
  });
  assert.match(applied, /firstmate updated abcdef12 -> 12345678/);
  assert.match(applied, /2 file\(s\) that steer an agent/, "an instruction change is the part worth reading");
  assert.match(applied, /git -C \/fm reset --hard abcdef123456/, "rolling back has to be one command");

  const waiting = notice({
    checkedAt: "x",
    applied: [],
    components: [{ name: "break-free", root: "/bf", behind: 3, instructionChanges: [] }],
  });
  assert.match(waiting, /break-free is 3 commit\(s\) behind/);
  assert.match(waiting, /node setup\.mjs --update/);
});

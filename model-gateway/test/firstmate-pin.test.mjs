/**
 * firstmate's pin follows its own auto-update, and nothing else.
 *
 * The background update fast-forwarded firstmate every six hours but never moved the pin, so the
 * pin check read the gateway's own update as "instructions nobody approved" and refused to launch
 * `bf firstmate` - on a live machine HEAD was ac2ed3b2 and the pin 9296f9b9. The fix must not
 * swing too far: drift someone else caused has to keep reading as drift.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { followablePin } from "../dist/firstmate.js";

const git = (cwd, args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const commit = (dir, file, text) => { fs.writeFileSync(path.join(dir, file), text); git(dir, ["add", "-A"]); git(dir, ["commit", "-qm", text]); return git(dir, ["rev-parse", "HEAD"]); };

/** An upstream, and an install that was pinned at the first commit and then fast-forwarded. */
function distro() {
  const upstream = fs.mkdtempSync(path.join(os.tmpdir(), "fm-up-"));
  git(upstream, ["init", "-q", "-b", "main"]);
  const pin = commit(upstream, "AGENTS.md", "rules v1\n");
  const install = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fm-inst-")), "firstmate");
  git(path.dirname(install), ["clone", "-q", upstream, install]);
  commit(upstream, "AGENTS.md", "rules v2\n");
  git(install, ["fetch", "-q", "origin"]);
  git(install, ["merge", "-q", "--ff-only", "origin/main"]);
  return { upstream, install, pin, head: git(install, ["rev-parse", "HEAD"]) };
}

test("a pin left behind by the gateway's own fast-forward follows it", () => {
  const { install, pin, head } = distro();
  assert.equal(followablePin(install, pin, "origin/main"), head, "the update was approved; the pin should say so");
});

test("a pin already at HEAD stays where it is", () => {
  const { install, head } = distro();
  assert.equal(followablePin(install, head, "origin/main"), undefined);
});

test("a local commit on top of upstream is drift, and the pin does not bless it", () => {
  const { install, pin } = distro();
  commit(install, "AGENTS.md", "rules edited locally\n");
  assert.equal(followablePin(install, pin, "origin/main"), undefined);
});

test("an edited working tree is drift, and the pin does not bless it", () => {
  const { install, pin } = distro();
  fs.writeFileSync(path.join(install, "AGENTS.md"), "uncommitted instructions\n");
  assert.equal(followablePin(install, pin, "origin/main"), undefined);
});

test("HEAD checked out somewhere the pin is not an ancestor of is drift", () => {
  const { install, upstream } = distro();
  // A pin on a history this HEAD never passed through: the pin is not its ancestor.
  git(upstream, ["checkout", "-q", "--orphan", "other"]);
  const foreign = commit(upstream, "AGENTS.md", "an unrelated history\n");
  git(install, ["fetch", "-q", "origin", "other"]);
  assert.equal(followablePin(install, foreign, "origin/main"), undefined);
});

test("no pin means nothing to follow", () => {
  const { install } = distro();
  assert.equal(followablePin(install, undefined, "origin/main"), undefined);
});

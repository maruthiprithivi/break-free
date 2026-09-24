/**
 * The worktree registry is shared by every agent in a repository, so losing it loses everyone's
 * record of what they are doing: purpose, claimed paths, handoff notes.
 *
 * An unreadable worktrees.json used to be rebuilt as an empty registry and then saved, so one
 * gateway reading in another's truncate-then-write gap wiped every agent's entry. And every
 * writer read, changed and saved with nothing in between - reconcile() holding its copy across
 * dozens of git subprocesses - so a handoff written in that window was overwritten.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeRegistry } from "../dist/worktrees.js";

const git = (cwd, args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

/** A repo with one extra worktree, registered with a handoff note worth keeping. */
function repo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-reg-")));
  git(root, ["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "one"]);
  const wt = path.join(path.dirname(root), path.basename(root) + "-feat");
  git(root, ["worktree", "add", "-q", "-b", "feat", wt]);
  const reg = new WorktreeRegistry(root);
  reg.register({ path: wt, purpose: "the feature", handoff: "half done; tests in test/feat" });
  const file = path.join(root, ".git", "break-free", "worktrees.json");
  return { root, wt, reg, file };
}

test("a corrupt registry is moved aside, never written over", () => {
  const { root, file } = repo();
  const before = fs.readFileSync(file, "utf8");
  assert.match(before, /half done/, "precondition: the handoff is on disk");

  // Half a document: what a reader sees in another gateway's truncate-then-write gap, or after
  // a crash mid-write by a version that did not write atomically.
  fs.writeFileSync(file, before.slice(0, Math.floor(before.length / 2)));
  new WorktreeRegistry(root).list();

  const aside = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith("worktrees.json.corrupt-"));
  assert.equal(aside.length, 1, "the unreadable file is kept, so what was in it can be recovered");
  assert.equal(fs.readFileSync(path.join(path.dirname(file), aside[0]), "utf8").length, Math.floor(before.length / 2));
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, "utf8")), "and the live file is valid again");
});

test("a handoff written by one agent survives another agent's reconcile", () => {
  const { root, file } = repo();
  const a = new WorktreeRegistry(root);
  const b = new WorktreeRegistry(root);
  a.update("feat", { handoff: "A: switched approach, see notes" });
  // b never saw that write; its reconcile starts from the file, not from anything it cached.
  b.list();
  const on = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.match(on.worktrees.feat.handoff, /A: switched approach/, "the later writer did not replace it with an older copy");

});

test("the registry is replaced atomically, leaving no temp file behind", () => {
  const { root, file } = repo();
  const reg = new WorktreeRegistry(root);
  for (let i = 0; i < 10; i += 1) reg.update("feat", { log: `step ${i}` });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes(".tmp")), []);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).worktrees.feat.log.filter((l) => /step/.test(l)).length, 10);
});

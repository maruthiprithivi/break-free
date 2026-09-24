/**
 * firstmate provisioning: where the distro lives, what it is pinned to, and what moving that
 * pin would change.
 *
 * Offline and deterministic — real git repositories built in a temp directory, no network and
 * no firstmate required. The cases that matter are the refusals and the drift detection: this
 * code decides which third-party instructions the user's agent obeys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRoot, resolveRoot, looksLikeDistro, status, planUpdate, updateCommand, parseUpdateSummary, sessionLabel, FIRSTMATE_LABEL } from "../dist/firstmate.js";

const git = (cwd, args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fm-test-"));

/** A directory that is a firstmate distro as far as the checks are concerned. */
function fakeDistro() {
  const root = tmp();
  fs.mkdirSync(path.join(root, "bin"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# firstmate\n\nhard rule 1\n");
  fs.writeFileSync(path.join(root, "bin", "fm-update.sh"), "#!/usr/bin/env bash\necho reread-firstmate: no\n");
  fs.writeFileSync(path.join(root, "docs.md"), "docs\n");
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "one"]);
  return root;
}

test("a directory is a distro only when the files that make it one are there", () => {
  const root = fakeDistro();
  assert.equal(looksLikeDistro(root), true);

  // A half-clone must report "not installed" rather than be driven as though it were.
  const half = tmp();
  fs.writeFileSync(path.join(half, "AGENTS.md"), "# looks right\n");
  assert.equal(looksLikeDistro(half), false);
  assert.equal(looksLikeDistro(tmp()), false, "an empty directory is not a distro");

  const st = status({ enabled: true, root: half });
  assert.equal(st.installed, false);
  assert.match(st.reason, /exists but is not a firstmate distro/);
});

test("one distro per machine, not one per repository", () => {
  // The crew registry and backlog are machine-level facts; N clones would be N fleets that
  // cannot see each other.
  assert.equal(defaultRoot("/home/u"), path.join("/home/u", ".break-free", "firstmate"));
  assert.equal(resolveRoot({ enabled: true }, "/home/u"), path.join("/home/u", ".break-free", "firstmate"));
  assert.equal(resolveRoot({ enabled: true, root: "~/elsewhere/fm" }, "/home/u"), "/home/u/elsewhere/fm");
  assert.equal(resolveRoot({ enabled: true, root: "/abs/fm" }, "/home/u"), "/abs/fm");
});

test("drift is detected, because it means the agent obeys instructions nobody approved", () => {
  const root = fakeDistro();
  const head = git(root, ["rev-parse", "HEAD"]);

  assert.equal(status({ enabled: true, root, pin: head }).drifted, false, "HEAD matching the pin is the good case");
  assert.equal(status({ enabled: true, root, pin: head.slice(0, 12) }).drifted, false, "a short pin still matches");

  // Somebody moved the checkout out from under the pin.
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# firstmate\n\nhard rule 1 CHANGED\n");
  git(root, ["commit", "-qam", "two"]);
  const st = status({ enabled: true, root, pin: head });
  assert.equal(st.drifted, true);
  assert.notEqual(st.head, head);

  // No pin at all is not drift — it is the absence of a pin, which is a different problem.
  assert.equal(status({ enabled: true, root }).drifted, false);
  assert.equal(status({ enabled: true, root }).pinState, "unpinned");
});

test("a matching commit with a dirty tree is not a clean pin", () => {
  // The bytes on disk are what an agent reads, not the commit id. An uncommitted edit to
  // AGENTS.md changes the instructions while HEAD still matches the approved revision.
  const root = fakeDistro();
  const head = git(root, ["rev-parse", "HEAD"]);
  assert.equal(status({ enabled: true, root, pin: head }).pinState, "clean");

  fs.writeFileSync(path.join(root, "AGENTS.md"), "# firstmate\n\nhard rule 1 EDITED LOCALLY\n");
  const st = status({ enabled: true, root, pin: head });
  assert.equal(st.dirty, true);
  assert.equal(st.drifted, false, "HEAD still matches; the edit is uncommitted");
  assert.equal(st.pinState, "dirty", "which is still not a pin anyone approved");
});

test("an unreadable checkout is unknown, never clean", () => {
  const root = fakeDistro();
  fs.rmSync(path.join(root, ".git"), { recursive: true, force: true });
  const st = status({ enabled: true, root, pin: "abc123" });
  assert.equal(st.pinState, "unknown");
  assert.match(st.reason, /could not read/);
  assert.notEqual(st.pinState, "clean", "reporting an unreadable checkout as fine is the worst answer");
});

test("an update is planned before it is applied, and only instruction surfaces count", () => {
  const root = fakeDistro();
  const from = git(root, ["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(root, "AGENTS.md"), "# firstmate\n\nhard rule 1 REWRITTEN\n");
  fs.writeFileSync(path.join(root, "bin", "fm-new.sh"), "#!/usr/bin/env bash\n");
  fs.writeFileSync(path.join(root, "docs.md"), "a thousand lines of docs\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "upstream moved"]);
  const to = git(root, ["rev-parse", "HEAD"]);

  git(root, ["checkout", "-q", from]);
  const plan = planUpdate(root, to);
  assert.equal(plan.current, false);
  assert.deepEqual(plan.instructionChanges.sort(), ["AGENTS.md", "bin/fm-new.sh"]);
  assert.ok(plan.allChanges.includes("docs.md"), "every change is still shown; what counts as an instruction is our judgement, not the user's");
  assert.equal(plan.unknown, false);
  assert.equal(git(root, ["rev-parse", "HEAD"]), from, "planning must not move the checkout");

  // Planning towards where you already are is not a change.
  assert.equal(planUpdate(root, from).current, true);
});

test("the tree is moved by upstream's own script, and the gap is stated", () => {
  const root = fakeDistro();
  const cmd = updateCommand(root);
  assert.equal(cmd.command, path.join(root, "bin", "fm-update.sh"));
  assert.deepEqual(cmd.args, [], "fm-update.sh takes no arguments; passing any is an error there");
  assert.equal(cmd.cwd, root);
  // The planner reviews a revision; the updater fast-forwards to origin. They are not the same
  // thing and presenting them as connected would be the dangerous part.
  assert.match(cmd.caveat, /origin/);
});

test("executable harness assets count as instructions, because they run without being read", () => {
  const root = fakeDistro();
  const from = git(root, ["rev-parse", "HEAD"]);
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), '{"hooks":{"Stop":[]}}');
  fs.writeFileSync(path.join(root, "README.md"), "prose\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "hooks"]);
  const to = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-q", from]);

  const plan = planUpdate(root, to);
  assert.ok(plan.instructionChanges.includes(".claude/settings.json"), "a Stop hook runs without anybody reading it");
  assert.ok(!plan.instructionChanges.includes("README.md"));
});

test("an unreadable revision is unknown, not 'nothing changed'", () => {
  const root = fakeDistro();
  const plan = planUpdate(root, "no-such-revision");
  assert.equal(plan.unknown, true);
  assert.equal(plan.current, false, "a failed read must never present as already up to date");
  assert.deepEqual(plan.instructionChanges, []);
});

test("upstream's summary is parsed, including the lines that mean the caller must act", () => {
  const out = [
    "updated /home/u/.break-free/firstmate",
    "reread-firstmate: yes",
    "restart-secondmates: fm-a fm-b",
    "nudge-secondmates: none",
  ].join("\n");
  const r = parseUpdateSummary(out);
  assert.equal(r.rereadInstructions, true, "the instructions changed under a running agent");
  assert.deepEqual(r.restart, ["fm-a", "fm-b"]);
  assert.deepEqual(r.nudge, []);

  const quiet = parseUpdateSummary("reread-firstmate: no\nrestart-secondmates: none\nnudge-secondmates: none");
  assert.deepEqual([quiet.rereadInstructions, quiet.restart, quiet.nudge], [false, [], []]);
  // Missing lines must not throw: a future version may not print all of them.
  assert.deepEqual(parseUpdateSummary("").restart, []);
});

test("a firstmate-backed session says so on screen", () => {
  assert.equal(sessionLabel(), FIRSTMATE_LABEL);
  assert.equal(FIRSTMATE_LABEL, "break-free -firstmate");
  assert.match(sessionLabel("fix the flaky auth test"), /^break-free -firstmate: fix the flaky auth test$/);
  // A long task must not produce an unusable session name.
  const long = sessionLabel("x".repeat(500));
  assert.ok(long.length < 100, `session label must stay short, got ${long.length}`);
  assert.match(sessionLabel("two\n\nlines   here"), /two lines here/, "newlines would break a session name");
});

// --- launching -------------------------------------------------------------------
// An MCP server cannot make a running client adopt firstmate's identity, so break-free
// launches a NEW session inside the distro. These pin the refusals, which are the point:
// launching past a bad pin would make the audit decorative.

import { planLaunch, FIRSTMATE_HARNESSES } from "../dist/firstmate.js";

const everything = () => true;

test("a launch is refused when firstmate is off, absent, drifted or dirty", () => {
  const root = fakeDistro();
  const head = git(root, ["rev-parse", "HEAD"]);

  assert.match(planLaunch({ enabled: false, root, pin: head }, { available: everything }).reason, /firstmate is off/);
  // tmp() creates the directory, so this is the "present but not a distro" case, which is the
  // more dangerous one: something is there, and driving it would be driving the wrong thing.
  assert.match(planLaunch({ enabled: true, root: tmp() }, { available: everything }).reason, /not a firstmate distro/);
  assert.match(planLaunch({ enabled: true, root: path.join(tmp(), "absent") }, { available: everything }).reason, /not installed/);

  // Dirty: the commit matches but the bytes on disk do not.
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# edited locally\n");
  const dirty = planLaunch({ enabled: true, root, pin: head }, { available: everything });
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /dirty/, "launching would run instructions nobody approved");

  // Drifted: someone moved the checkout past the pin.
  git(root, ["commit", "-qam", "moved"]);
  const drifted = planLaunch({ enabled: true, root, pin: head }, { available: everything });
  assert.equal(drifted.ok, false);
  assert.match(drifted.reason, /drifted/);
});

test("an unverified harness is refused rather than launched", () => {
  const root = fakeDistro();
  const head = git(root, ["rev-parse", "HEAD"]);
  const cfg = { enabled: true, root, pin: head };

  // firstmate's turn-end guard and watcher re-arm are per-harness. An unsupported one looks
  // like it works while the supervision it depends on is silently absent — worse than refusing.
  const bad = planLaunch(cfg, { harness: "my-own-agent", available: everything });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /not verified as a firstmate primary/);

  // A verified harness that is not installed is also refused, with a different reason.
  const missing = planLaunch(cfg, { harness: "codex", available: () => false });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /not on PATH/);

  // Nothing at all on PATH names what was tried.
  const none = planLaunch(cfg, { available: () => false });
  assert.match(none.reason, /no verified harness found/);
});

test("a good launch runs in the distro, keeps FM_HOME outside it, and says who is leading", () => {
  const root = fakeDistro();
  const head = git(root, ["rev-parse", "HEAD"]);
  const plan = planLaunch({ enabled: true, root, pin: head }, { harness: "claude", task: "fix the auth test", available: everything });

  assert.equal(plan.ok, true);
  assert.equal(plan.command, "claude");
  assert.equal(plan.cwd, root, "cwd must be the distro, which is how AGENTS.md is picked up");
  assert.match(plan.label, /^break-free -firstmate: fix the auth test/, "the screen has to say which system is leading");
  assert.equal(plan.env.BREAK_FREE_FIRSTMATE, "1");
  assert.ok(!plan.env.FM_HOME.startsWith(root + path.sep), "FM_HOME outside the code root, so rolling back code never hides the crew registry");

  // Grok needs --trust or none of its project hooks load, which is exactly the silent
  // supervision loss this refuses elsewhere.
  assert.deepEqual(planLaunch({ enabled: true, root, pin: head }, { harness: "grok", available: everything }).args, ["--trust"]);
  assert.ok(FIRSTMATE_HARNESSES.includes("claude"));
});

test("an upstream update is reported, never taken on its own", async () => {
  const { updateAvailable } = await import("../dist/firstmate.js");
  // A clone with an origin that has moved ahead — the ordinary case after upstream ships.
  const upstream = fakeDistro();
  const clone = path.join(tmp(), "clone");
  git(path.dirname(clone), ["clone", "-q", upstream, clone]);
  const before = git(clone, ["rev-parse", "HEAD"]);

  assert.deepEqual(
    [updateAvailable(clone).behind, updateAvailable(clone).unknown],
    [0, false],
    "nothing waiting when the clone is level with origin",
  );

  fs.writeFileSync(path.join(upstream, "AGENTS.md"), "# firstmate\n\nhard rule 1 CHANGED UPSTREAM\n");
  fs.writeFileSync(path.join(upstream, "notes.md"), "just docs\n");
  git(upstream, ["add", "-A"]);
  git(upstream, ["commit", "-q", "-m", "upstream release"]);

  // Without a fetch the clone cannot know: reporting 0 here is honest, not a miss.
  assert.equal(updateAvailable(clone).behind, 0);

  const found = updateAvailable(clone, { fetch: true });
  assert.equal(found.behind, 1, "one commit waiting");
  assert.deepEqual(found.instructionChanges, ["AGENTS.md"], "and it changes what the agent obeys");
  assert.equal(git(clone, ["rev-parse", "HEAD"]), before, "checking must never move the checkout");
});

// --- which harness --------------------------------------------------------------
// Typing `bf firstmate` inside Codex and being handed Claude is the wrong answer even when
// Claude is also installed. These pin the order the signals deserve.

import { preferredHarness, runningHarness } from "../dist/firstmate.js";

const all = () => true;

test("the harness running this session is detected from its own markers", () => {
  assert.equal(runningHarness({ CLAUDECODE: "1" }), "claude");
  assert.equal(runningHarness({ CLAUDE_CODE_SESSION_ID: "abc" }), "claude");
  assert.equal(runningHarness({ CODEX_SESSION_ID: "abc" }), "codex");
  assert.equal(runningHarness({ CODEX_VERSION: "0.155.0" }), "codex");
  assert.equal(runningHarness({ CURSOR_AGENT: "1" }), "cursor-agent");
  assert.equal(runningHarness({ GROK_AGENT: "1" }), "grok");
  assert.equal(runningHarness({ PI_CODING_AGENT: "1" }), "pi");
  assert.equal(runningHarness({ OMP_EXT: "1" }), "omp");
  assert.equal(runningHarness({ PATH: "/usr/bin" }), undefined, "an ordinary shell is not a harness");
});

test("the session you are in beats everything an installer recorded", () => {
  // The bug this fixes: claude is first in the shipped list, so it won that race from inside
  // a Codex session on a machine with both installed.
  assert.equal(
    preferredHarness({ env: { CODEX_SESSION_ID: "x" }, wired: ["claude"], available: all }),
    "codex",
  );
  assert.equal(preferredHarness({ env: { CLAUDECODE: "1" }, wired: ["codex"], available: all }), "claude");
});

test("an explicit choice wins, even when it is not installed", () => {
  // So the refusal can say "not on PATH" rather than quietly handing over something else.
  assert.equal(preferredHarness({ explicit: "codex", env: { CLAUDECODE: "1" }, available: () => false }), "codex");
  assert.equal(preferredHarness({ explicit: "my-own-agent", available: all }), "my-own-agent");
});

test("configuration, then what the install wired, then the shipped order", () => {
  // `env: {}` says "no harness is running here". Omitted, preferredHarness reads process.env, and a
  // running harness deliberately outranks configuration (see the test above) - so run from inside
  // Claude Code, as the installer's self-test is, these read the real CLAUDECODE and fail.
  const none = {};
  assert.equal(preferredHarness({ env: none, configured: "codex", wired: ["claude"], available: all }), "codex");
  assert.equal(preferredHarness({ env: none, wired: ["omp", "claude"], available: all }), "omp", "what the user wired beats list order");
  assert.equal(preferredHarness({ env: none, available: all }), "claude", "the shipped order is the last resort");

  // A signal pointing at something not installed must not win, or the fallback never runs.
  assert.equal(preferredHarness({ env: { CODEX_SESSION_ID: "x" }, available: (b) => b === "claude" }), "claude");
  assert.equal(preferredHarness({ env: none, configured: "grok", available: (b) => b === "pi" }), "pi");
  // An unverified name in config or install state is ignored rather than launched.
  assert.equal(preferredHarness({ env: none, configured: "not-a-harness", wired: ["codex"], available: all }), "codex");
  assert.equal(preferredHarness({ env: none, available: () => false }), undefined, "nothing installed is an honest nothing");
});

test("a launch plan follows the running session", () => {
  const root = fakeDistro();
  const head = git(root, ["rev-parse", "HEAD"]);
  const plan = planLaunch({ enabled: true, root, pin: head }, { env: { CODEX_SESSION_ID: "x" }, available: all });
  assert.equal(plan.ok, true);
  assert.equal(plan.command, "codex", "started from Codex, it hands back Codex");
});

test("a nested session is ambiguous, and ambiguity is not resolved by list order", async () => {
  const { runningHarnesses } = await import("../dist/firstmate.js");
  // Found by running `bf firstmate` inside a Codex session that had itself been started from
  // Claude Code: the child carried BOTH marker sets, because an outer harness's variables are
  // inherited by everything it spawns. Picking by list order made that a silent coin flip.
  const nested = { CLAUDECODE: "1", CODEX_SESSION_ID: "x" };
  assert.deepEqual(runningHarnesses(nested).sort(), ["claude", "codex"]);
  assert.equal(runningHarness(nested), undefined, "two claimants is not an answer");

  // So it falls through to what the user actually chose.
  assert.equal(preferredHarness({ env: nested, configured: "codex", available: all }), "codex");
  assert.equal(preferredHarness({ env: nested, wired: ["codex"], available: all }), "codex");

  // A single claimant is still trusted.
  assert.equal(runningHarness({ CODEX_SESSION_ID: "x" }), "codex");
  assert.deepEqual(runningHarnesses({ PATH: "/usr/bin" }), []);
});

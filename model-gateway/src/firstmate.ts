/**
 * firstmate, provisioned and driven by break-free.
 *
 * firstmate (github.com/kunchenguid/firstmate) is an agent distro: a cloned repository of
 * AGENTS.md, skills and several hundred deterministic shell scripts that a harness follows. It
 * owns what break-free does not — a clean git worktree per task, a visible crew, fleet sync and
 * merge authority. break-free keeps routing, tiers, verification, review and CI watching.
 *
 * Three rules shape everything here.
 *
 * It is NEVER forked. break-free clones it, pins a revision, and moves that pin deliberately.
 * The upstream default branch is someone else's moving target, and its contents become the
 * instructions the user's agent obeys — so an unreviewed fast-forward is a supply-chain event,
 * not a convenience.
 *
 * break-free decides WHICH commit; upstream's own bin/fm-update.sh moves the tree. Their script
 * is fast-forward only, never forces, never stashes, and never touches the gitignored
 * operational directories. Reimplementing that in TypeScript would be a second, worse copy of
 * mechanics they maintain.
 *
 * The distro lives in ONE place per machine, not per repository. Its operational state (FM_HOME)
 * holds the crew registry and the task backlog, which are machine-level facts; N clones would
 * mean N fleets that cannot see each other.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIRSTMATE_REPO = "https://github.com/kunchenguid/firstmate";

/** What the user sees whenever break-free hands work to the distro. */
export const FIRSTMATE_LABEL = "break-free -firstmate";

export interface FirstmateConfig {
  /** Where the distro lives. Default: <breakFreeHome>/firstmate. */
  root?: string;
  /** Commit this machine is pinned to. Absent means "whatever was cloned", which is not a pin. */
  pin?: string;
  enabled: boolean;
}

export interface FirstmateStatus {
  installed: boolean;
  root: string;
  /** HEAD of the checkout, which is what the user's agent is actually obeying. */
  head?: string;
  pin?: string;
  /** True when HEAD has drifted from the pin — someone moved it, or a pin was never applied. */
  drifted: boolean;
  /** Uncommitted edits in the checkout. A matching HEAD with a dirty tree is NOT a clean pin. */
  dirty: boolean;
  /** HEAD is the revision on disk. It is not proof of what a RUNNING agent already loaded. */
  pinState: "clean" | "drifted" | "dirty" | "unpinned" | "unknown";
  /** Commits the pinned revision is behind origin, when that can be determined offline. */
  behind?: number;
  reason?: string;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

export function defaultRoot(home = os.homedir()): string {
  return path.join(process.env.BREAK_FREE_HOME ?? path.join(home, ".break-free"), "firstmate");
}

export function resolveRoot(cfg: FirstmateConfig, home = os.homedir()): string {
  return cfg.root ? cfg.root.replace(/^~(?=$|\/)/, home) : defaultRoot(home);
}

/**
 * Is a directory actually a firstmate distro, rather than merely present?
 *
 * Checked by the files that make it one — AGENTS.md and bin/fm-update.sh — so an empty or
 * half-cloned directory is reported as not installed instead of being driven as if it were.
 */
export function looksLikeDistro(root: string): boolean {
  return fs.existsSync(path.join(root, "AGENTS.md")) && fs.existsSync(path.join(root, "bin", "fm-update.sh"));
}

export function status(cfg: FirstmateConfig, home = os.homedir()): FirstmateStatus {
  const root = resolveRoot(cfg, home);
  if (!looksLikeDistro(root)) {
    return { installed: false, root, drifted: false, dirty: false, pinState: "unknown", reason: fs.existsSync(root) ? `${root} exists but is not a firstmate distro` : "not installed" };
  }
  const head = git(root, ["rev-parse", "HEAD"]);
  const porcelain = git(root, ["status", "--porcelain"]);
  // A failed git read is UNKNOWN, never "fine". Reporting an unreadable checkout as clean is
  // the worst of the three answers.
  if (head === undefined || porcelain === undefined) {
    return { installed: true, root, head, pin: cfg.pin, drifted: false, dirty: false, pinState: "unknown", reason: "could not read the checkout with git" };
  }
  const pin = cfg.pin;
  const dirty = porcelain.length > 0;
  // A pin HEAD does not match means the agent obeys instructions nobody approved. So does a
  // dirty tree at the right commit: the bytes on disk are what gets read, not the commit id.
  const drifted = !!pin && !head.startsWith(pin) && !pin.startsWith(head);
  const pinState = !pin ? "unpinned" : drifted ? "drifted" : dirty ? "dirty" : "clean";
  return { installed: true, root, head, pin, drifted, dirty, pinState };
}

export interface UpdatePlan {
  root: string;
  from?: string;
  to?: string;
  /** Changes to surfaces that steer an agent, including executable harness hooks. */
  instructionChanges: string[];
  /** Every changed path, because "not an instruction surface" is a judgement the user may not share. */
  allChanges: string[];
  /** True when the revisions could not be read; NOT the same as "nothing changed". */
  unknown: boolean;
  /** True when nothing would move. */
  current: boolean;
}

/**
 * What moving the pin to `target` would change, WITHOUT changing anything.
 *
 * The diff is limited to the surfaces that steer an agent — AGENTS.md, skills and bin — because
 * those are what a human needs to have seen. A thousand-line docs change is not the thing that
 * can quietly alter what the agent does.
 */
/**
 * The commit firstmate's pin should move to, or undefined when it must stay put.
 *
 * The auto-update fast-forwards firstmate but never moved the pin, so the pin check then read the
 * gateway's own update as "instructions nobody approved" and refused to launch `bf firstmate`.
 * The pin follows HEAD only when HEAD got there the way the auto-update gets there - each
 * condition rules out something that must go on reading as drift:
 *
 *   HEAD is exactly the upstream target      nothing local was committed on top
 *   the pin is an ancestor of HEAD           it only moved forward: no checkout, no rewrite
 *   the working tree is clean                no one has edited the instructions
 */
export function followablePin(root: string, pin: string | undefined, target: string): string | undefined {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!pin || !head || head.startsWith(pin) || pin.startsWith(head)) return undefined;
  if (head !== git(root, ["rev-parse", target])) return undefined;
  if (git(root, ["merge-base", "--is-ancestor", pin, head]) === undefined) return undefined;
  if (git(root, ["status", "--porcelain"]) !== "") return undefined;
  return head;
}

export function planUpdate(root: string, target: string): UpdatePlan {
  const from = git(root, ["rev-parse", "HEAD"]);
  const to = git(root, ["rev-parse", target]);
  if (!from || !to) return { root, from, to, instructionChanges: [], allChanges: [], unknown: true, current: false };
  const changed = (git(root, ["diff", "--name-only", `${from}..${to}`]) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return { root, from, to, instructionChanges: changed.filter(steersAnAgent), allChanges: changed, unknown: false, current: from === to };
}

/**
 * Does changing this file change what an agent does?
 *
 * Prose is the obvious case and the least dangerous. The executable harness assets matter more:
 * a `.claude/settings.json` hook or a `.cursor/hooks.json` entry runs without anybody reading
 * it. Excluding them because they are "config" would hide the changes with the shortest path
 * to execution.
 */
function steersAnAgent(p: string): boolean {
  return (
    p === "AGENTS.md" ||
    p === "CLAUDE.md" ||
    p.startsWith("bin/") ||
    p.startsWith("skills/") ||
    p.startsWith(".agents/") ||
    p.startsWith(".claude/") ||
    p.startsWith(".cursor/") ||
    p.startsWith(".pi/") ||
    p.startsWith(".omp/") ||
    /(^|\/)hooks?\.(json|toml|ya?ml)$/.test(p) ||
    /(^|\/)settings\.json$/.test(p)
  );
}

/**
 * The command that moves the tree, which is upstream's own.
 *
 * Returned rather than executed so the caller decides when a third party's script runs against
 * the user's machine, and so the same string can be shown to them first.
 */
export function updateCommand(root: string): { command: string; args: string[]; cwd: string; caveat: string } {
  return {
    command: path.join(root, "bin", "fm-update.sh"),
    args: [],
    cwd: root,
    // fm-update.sh takes no arguments and fast-forwards from ORIGIN. It cannot be aimed at the
    // revision a plan reviewed, so between planning and applying, origin may have moved. The
    // two are not connected and must not be presented as if they were.
    caveat: "fast-forwards to origin's current tip, which is not necessarily the revision you planned against; re-plan if origin moved",
  };
}

/** Upstream's parseable summary: which of its lines the caller must act on. */
export function parseUpdateSummary(out: string): { rereadInstructions: boolean; restart: string[]; nudge: string[] } {
  const field = (name: string) => out.split("\n").find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? "";
  const list = (v: string) => (v && v !== "none" ? v.split(/\s+/).filter(Boolean) : []);
  return {
    rereadInstructions: field("reread-firstmate") === "yes",
    restart: list(field("restart-secondmates")),
    nudge: list(field("nudge-secondmates")),
  };
}

/**
 * How a firstmate-backed session announces itself.
 *
 * The user asked to see which system is driving. A crew session that looks like any other
 * terminal is the thing that makes a fleet confusing, so every session break-free starts
 * through the distro carries the label in its name.
 */
export function sessionLabel(task?: string): string {
  return task ? `${FIRSTMATE_LABEL}: ${task.replace(/\s+/g, " ").slice(0, 60)}` : FIRSTMATE_LABEL;
}

// ---------------------------------------------------------------- launching

/**
 * Harnesses firstmate verifies as a primary session, in its own recommended order.
 *
 * Launching an unverified harness inside the distro is worse than refusing: firstmate's
 * turn-end guard and watcher re-arm are per-harness, so an unsupported one looks like it is
 * working while the supervision it depends on is silently absent.
 */
export const FIRSTMATE_HARNESSES = ["claude", "grok", "pi", "omp", "codex", "opencode", "cursor-agent"] as const;
export type FirstmateHarness = (typeof FIRSTMATE_HARNESSES)[number];


/**
 * Markers a harness sets in its own sessions.
 *
 * Verified rather than guessed: CLAUDE_CODE_* and CLAUDECODE from a Claude Code session,
 * CODEX_* by asking Codex to print its own environment, and the Cursor, Grok, Pi and omp
 * markers from the set firstmate itself detects on (`.firstmate/bin`), which is the closest
 * thing to an authority on which of these are load-bearing.
 */
const HARNESS_MARKERS: ReadonlyArray<readonly [FirstmateHarness, readonly string[]]> = [
  ["claude", ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID"]],
  ["codex", ["CODEX_SESSION_ID", "CODEX_THREAD_ID", "CODEX_VERSION", "CODEX_SANDBOX"]],
  ["cursor-agent", ["CURSOR_AGENT", "CURSOR_MODE", "CURSOR_INVOKED_AS"]],
  ["grok", ["GROK_AGENT", "GROK_HOOKS_DIR", "GROK_HOME"]],
  ["omp", ["OMP_EXT", "OMP_BIN", "OMP_WORKER_CFG"]],
  ["pi", ["PI_CODING_AGENT"]],
];

/** Every harness whose markers are present. More than one means the session is nested. */
export function runningHarnesses(env: NodeJS.ProcessEnv = process.env): FirstmateHarness[] {
  return HARNESS_MARKERS.filter(([, markers]) => markers.some((m) => env[m])).map(([h]) => h);
}

/**
 * The harness running this process, or undefined when that cannot be told.
 *
 * Undefined covers two different situations on purpose. An ordinary shell has no markers. A
 * NESTED session — Codex started from inside Claude Code, say — carries BOTH sets, because the
 * outer harness's variables are inherited by everything it spawns. Breaking that tie by the
 * order of a list in this file would be a coin flip wearing a suit: the answer would depend on
 * which name I happened to type first. Ambiguity falls through to what the user configured or
 * wired, which they actually chose.
 */
export function runningHarness(env: NodeJS.ProcessEnv = process.env): FirstmateHarness | undefined {
  const found = runningHarnesses(env);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Which harness a firstmate session should use, in the order the signals deserve.
 *
 * The session you are IN wins over everything an installer recorded: typing `bf firstmate`
 * inside Codex and being handed Claude is the wrong answer even if Claude is also installed.
 * Configuration comes next because it was stated deliberately, then the harnesses the install
 * actually wired, and only then the shipped order — which is a fallback, not a preference.
 */
export function preferredHarness(
  opts: { explicit?: string; configured?: string; wired?: readonly string[]; env?: NodeJS.ProcessEnv; available?: (b: string) => boolean } = {},
): FirstmateHarness | undefined {
  const has = opts.available ?? (() => true);
  const verified = (h: string | undefined): h is FirstmateHarness =>
    !!h && (FIRSTMATE_HARNESSES as readonly string[]).includes(h);

  // An explicit --harness is honoured even when it is not installed, so the refusal can say
  // "not on PATH" rather than silently handing over something else.
  if (opts.explicit) return opts.explicit as FirstmateHarness;

  const running = runningHarness(opts.env);
  for (const candidate of [verified(running) ? running : undefined, verified(opts.configured) ? opts.configured : undefined]) {
    if (candidate && has(candidate)) return candidate;
  }
  for (const w of opts.wired ?? []) if (verified(w) && has(w)) return w;
  return FIRSTMATE_HARNESSES.find((h) => has(h));
}

export interface LaunchPlan {
  ok: boolean;
  /** The command a user could run themselves; break-free runs the same one. */
  command?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  /** What the session is called, so the screen says which system is leading. */
  label: string;
  reason?: string;
}

/**
 * How to start a firstmate-led session.
 *
 * This is the honest shape of "break-free uses firstmate". An MCP server cannot make a client
 * that is already running adopt firstmate's identity — the distro is instructions a harness
 * reads at startup, and startup has already happened. So break-free launches a NEW session
 * inside the distro instead, and that session's lead is firstmate.
 *
 * `cwd` is the distro, because that is how AGENTS.md is picked up. FM_HOME is kept separate
 * from the code root so a rollback of the code never hides the crew registry or the backlog.
 */
export function planLaunch(
  cfg: FirstmateConfig,
  opts: { harness?: string; fmHome?: string; task?: string; configured?: string; wired?: readonly string[]; env?: NodeJS.ProcessEnv; available?: (bin: string) => boolean } = {},
  home = os.homedir(),
): LaunchPlan {
  const label = sessionLabel(opts.task);
  const st = status(cfg, home);
  if (!cfg.enabled) return { ok: false, args: [], env: {}, label, reason: "firstmate is off; set firstmate.enabled to launch a firstmate-led session" };
  if (!st.installed) return { ok: false, args: [], env: {}, label, reason: st.reason ?? "not installed" };
  // A pin nobody approved is exactly what the audit exists to catch; launching past it would
  // make the audit decorative.
  if (st.pinState === "drifted" || st.pinState === "dirty") {
    return { ok: false, args: [], env: {}, label, reason: `the distro is ${st.pinState}: it would run instructions that do not match the pin. Review with firstmate_update_plan, then re-pin.` };
  }

  const has = opts.available ?? (() => true);
  const harness = preferredHarness({ explicit: opts.harness, configured: opts.configured, wired: opts.wired, env: opts.env, available: has });
  if (!harness) return { ok: false, args: [], env: {}, label, reason: `no verified harness found on PATH (tried ${FIRSTMATE_HARNESSES.join(", ")})` };
  if (!(FIRSTMATE_HARNESSES as readonly string[]).includes(harness)) {
    return { ok: false, args: [], env: {}, label, reason: `${harness} is not verified as a firstmate primary; its turn-end guard and watcher re-arm would be absent while appearing to work` };
  }
  if (!has(harness)) return { ok: false, args: [], env: {}, label, reason: `${harness} is not on PATH` };

  return {
    ok: true,
    command: harness,
    args: harness === "grok" ? ["--trust"] : [],
    cwd: st.root,
    env: {
      FM_HOME: opts.fmHome ?? path.join(path.dirname(st.root), "firstmate-home"),
      BREAK_FREE_FIRSTMATE: "1",
    },
    label,
  };
}

/**
 * Is there a newer firstmate upstream, and what would taking it change?
 *
 * Offline by default: it reads what the local clone already knows about origin. `fetch` asks
 * upstream first, which is the only way to notice a release that landed since the last clone.
 * An update is reported, never applied — the whole point of the pin is that moving it is a
 * decision somebody makes.
 */
export function updateAvailable(root: string, opts: { fetch?: boolean } = {}): { behind: number; target?: string; instructionChanges: string[]; unknown: boolean } {
  if (opts.fetch) git(root, ["fetch", "--quiet", "origin"]);
  const target = git(root, ["rev-parse", "origin/HEAD"]) ?? git(root, ["rev-parse", "origin/main"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!target || !head) return { behind: 0, instructionChanges: [], unknown: true };
  if (target === head) return { behind: 0, target, instructionChanges: [], unknown: false };
  const behind = Number(git(root, ["rev-list", "--count", `${head}..${target}`]) ?? "0");
  return { behind, target, instructionChanges: planUpdate(root, target).instructionChanges, unknown: false };
}

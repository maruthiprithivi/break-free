/**
 * Checking whether break-free is current.
 *
 * Checking is cheap but not free — it talks to a remote — so the result is cached and a check
 * is skipped while that cache is warm. A session start must never block on the network.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ComponentUpdate {
  name: "break-free";
  root: string;
  /** Commits behind origin. 0 means current; undefined means the question could not be asked. */
  behind?: number;
  /** Kept for compatibility with existing update cache files. */
  instructionChanges: string[];
  /** Why no answer, when there is none. */
  reason?: string;
  /** A fast-forward was attempted and did not land - local changes in the way. */
  applyFailed?: boolean;
}

export interface UpdateState {
  checkedAt: string;
  components: ComponentUpdate[];
  /** Kept for compatibility with existing update cache files. */
  applied: { name: string; from: string; to: string }[];
}

const CACHE = "updates.json";

function git(cwd: string, args: string[], timeoutMs = 20_000): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: timeoutMs }).trim();
  } catch {
    return undefined;
  }
}

/** A git checkout we can reason about, rather than a directory that happens to exist. */
export function isCheckout(root: string): boolean {
  return !!root && fs.existsSync(path.join(root, ".git"));
}

/**
 * How far behind origin a checkout is.
 *
 * `fetch` is what makes the answer current; without it this reports what the clone last heard,
 * which is honest but stale. A failure to reach the remote is `undefined`, never 0 — "I could
 * not ask" and "there is nothing new" are different answers and only one of them is good news.
 */
export async function behindOrigin(root: string, opts: { fetch?: boolean; timeoutMs?: number } = {}): Promise<{ behind?: number; target?: string; reason?: string }> {
  if (!isCheckout(root)) return { reason: "not a git checkout" };
  // The fetch is the only step here that touches the network, so it is the only one that must
  // not block. It used to be execFileSync inside an async function that ran before its first
  // await, which froze the event loop for up to its timeout - at startup and in the Stop hook -
  // on a network that black-holes TCP. The local steps below are milliseconds and stay simple.
  if (opts.fetch && !(await fetchOrigin(root, opts.timeoutMs ?? 20_000))) {
    return { reason: "could not reach origin" };
  }
  const target = git(root, ["rev-parse", "origin/HEAD"]) ?? git(root, ["rev-parse", "origin/main"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  if (!target || !head) return { reason: "could not read the checkout" };
  if (target === head) return { behind: 0, target };
  const n = Number(git(root, ["rev-list", "--count", `${head}..${target}`]) ?? "");
  return Number.isFinite(n) ? { behind: n, target } : { reason: "could not count commits" };
}

function fetchOrigin(root: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("git", ["fetch", "--quiet", "origin"], { cwd: root, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err) => resolve(!err));
  });
}

/**
 * Files an install produces, and that no one edits by hand.
 *
 * `npm install` used to rewrite a stale committed lockfile, so every real install carried
 * `M model-gateway/package-lock.json`, and the first upstream commit that changed the lockfile
 * made every fast-forward abort - auto-update stopped for good and nothing said so. Anything
 * else modified is somebody's work and is never touched. Mirrored in setup.mjs update().
 */
export const BUILD_ARTEFACTS = ["model-gateway/package-lock.json"];

/**
 * Put build artefacts back when they are the only reason a checkout is dirty.
 *
 * Returns true when the checkout is clean afterwards (or already was), false when something a
 * person changed is in the way - in which case nothing is touched.
 */
export function restoreBuildArtefacts(root: string): boolean {
  // Names only - no status prefix to parse. `status --porcelain` fed through this file's git(),
  // which trims, lost the first line's leading space and so the first character of its path.
  const changed = git(root, ["diff", "--name-only", "HEAD"]);
  if (changed === undefined) return false;
  const dirty = changed.split("\n").map((l) => l.trim()).filter(Boolean);
  if (dirty.length === 0) return true;
  if (!dirty.every((f) => BUILD_ARTEFACTS.includes(f))) return false;
  return git(root, ["checkout", "--", ...dirty]) !== undefined;
}

/** Cached so a session start is not a network round trip every time. */
export function readCache(sessionDir: string): UpdateState | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(sessionDir, CACHE), "utf8")) as UpdateState;
  } catch {
    return undefined;
  }
}

export function writeCache(sessionDir: string, state: UpdateState): void {
  try {
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(sessionDir, CACHE), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // A cache that cannot be written costs an extra check, which is not worth failing over.
  }
}

export function cacheIsWarm(state: UpdateState | undefined, intervalHours: number, now = Date.now()): boolean {
  if (!state?.checkedAt) return false;
  const age = now - Date.parse(state.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < intervalHours * 3_600_000;
}

/**
 * One line a person can act on, or nothing at all.
 *
 * Silence when everything is current is the point: a notice that appears every session stops
 * being read, and then the one that mattered is missed with all the others.
 */
export function notice(state: UpdateState | undefined): string | undefined {
  if (!state) return undefined;
  const waiting = (state.components ?? []).filter((c) => c.name === "break-free" && (c.behind ?? 0) > 0);
  const parts: string[] = [];
  for (const c of waiting) {
    // New source does nothing until the installer rebuilds it.
    parts.push(`break-free is ${c.behind} commit(s) behind origin. Update with: node ${path.join(c.root, "setup.mjs")} --update (it rebuilds; new sessions use it, open ones keep the old version until restarted)`);
  }
  return parts.length ? parts.join("\n") : undefined;
}

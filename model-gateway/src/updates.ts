/**
 * Keeping break-free and firstmate current.
 *
 * Both are git checkouts, so "is there a new version" is a question about origin, and taking
 * one is a fast-forward. The two are not the same kind of thing, though, and the difference
 * decides the design:
 *
 *   break-free is a PROGRAM. Its new bytes do nothing until the next process starts, so
 *   updating the source under a running gateway is safe and simply lands next session.
 *
 *   firstmate is INSTRUCTIONS. Its new bytes are read by an agent during the session, so an
 *   update changes what the agent does, in flight. That is why the previous pin is recorded
 *   before anything moves: rolling back has to be one command, not an archaeology exercise.
 *
 * Checking is cheap but not free — it talks to a remote — so the result is cached and a check
 * is skipped while that cache is warm. A session start must never block on the network.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ComponentUpdate {
  name: "break-free" | "firstmate";
  root: string;
  /** Commits behind origin. 0 means current; undefined means the question could not be asked. */
  behind?: number;
  /** Files that steer an agent, when this is firstmate. Empty for a program. */
  instructionChanges: string[];
  /** Why no answer, when there is none. */
  reason?: string;
}

export interface UpdateState {
  checkedAt: string;
  components: ComponentUpdate[];
  /** Applied in this check, with the pin each one moved from, so a rollback is one command. */
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
  const applied = state.applied ?? [];
  const waiting = (state.components ?? []).filter((c) => (c.behind ?? 0) > 0);
  const parts: string[] = [];

  for (const a of applied) {
    const c = state.components.find((x) => x.name === a.name);
    const changed = c?.instructionChanges.length
      ? ` — it changed ${c.instructionChanges.length} file(s) that steer an agent: ${c.instructionChanges.slice(0, 3).join(", ")}`
      : "";
    parts.push(`${a.name} updated ${a.from.slice(0, 8)} -> ${a.to.slice(0, 8)}${changed}. Roll back with: git -C ${c?.root ?? "<root>"} reset --hard ${a.from.slice(0, 12)}`);
  }
  for (const c of waiting) {
    parts.push(`${c.name} is ${c.behind} commit(s) behind origin${c.name === "firstmate" && c.instructionChanges.length ? `, touching ${c.instructionChanges.length} instruction file(s)` : ""}. Take it with: node setup.mjs --update`);
  }
  return parts.length ? parts.join("\n") : undefined;
}

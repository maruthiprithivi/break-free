/**
 * Writing files that several gateways share.
 *
 * A gateway runs per session and per worktree, so every file under the session directory and
 * every per-repo registry has many concurrent readers and writers. Two failure shapes recur, and
 * both have already cost real data here:
 *
 *   TORN READS. writeFileSync truncates and then writes. A reader in that gap sees an empty or
 *   half-written file, and code that treats "unreadable" as "nothing there yet" then writes its
 *   empty idea of the state back - erasing everyone else's. (The fleet cursor file, the worktree
 *   registry.)
 *
 *   LOST UPDATES. Read, change, write - with nothing stopping another process doing the same in
 *   between - and the second write replaces the first with a copy read before it. (breaker.json,
 *   the worktree registry, drains.)
 *
 * atomicWrite fixes the first; withDirLock the second. They live in one place because three
 * hand-rolled copies of the same idea is how the copies come to disagree.
 */
import fs from "node:fs";
import path from "node:path";

const LOCK_DIR = ".lock";
/** A lock older than this belonged to a process that died holding it. */
const LOCK_STALE_MS = 30_000;

/** Block this thread briefly. The callers are synchronous, so the wait must be too. */
export function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Replace a file so a concurrent reader sees the old contents or the new, never neither. */
export function atomicWrite(file: string, text: string, mode = 0o600): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  // A rename within one directory is atomic on every platform this runs on.
  fs.renameSync(tmp, file);
}

/** Directories whose lock this process already holds, so a nested call does not wait on itself. */
const held = new Set<string>();

/**
 * Run fn with an exclusive lock on dir, across processes.
 *
 * mkdir is atomic and needs no dependency. A holder that crashes would otherwise wedge every
 * other process for good, so a lock older than LOCK_STALE_MS is treated as abandoned. Re-entrant
 * within one process. Returns undefined when the lock could not be had within waitMs.
 */
export function withDirLock<T>(dir: string, fn: () => T, waitMs = 2_000): T | undefined {
  if (held.has(dir)) return fn();
  const lock = path.join(dir, LOCK_DIR);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      // Only EEXIST means someone holds it. Anything else - a missing directory, no permission -
      // will not change by waiting, and waiting here is Atomics.wait: every retry froze this
      // process's event loop for the full deadline, the same kind of freeze that made healthy
      // providers look dead. Give up at once and let the caller fall back.
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        // It vanished between the two calls: the holder just released it, so try to take it.
      }
      if (Date.now() >= deadline) return undefined;
      sleepMs(25);
    }
  }
  held.add(dir);
  try {
    return fn();
  } finally {
    held.delete(dir);
    try { fs.rmSync(lock, { recursive: true, force: true }); } catch { /* releasing must not throw */ }
  }
}

/**
 * Run a read-modify-write under the lock, or unlocked if the lock cannot be had.
 *
 * Not `withDirLock(dir, fn) ?? fn()`: for a function that returns nothing, withDirLock returns
 * undefined on success too, and that fallback would run the change twice. Unlocked is the
 * fallback because a stuck lock must degrade to today's behaviour, never to a lost write.
 */
export function locked(dir: string, fn: () => void): void {
  if (withDirLock(dir, () => { fn(); return true as const; }) === undefined) fn();
}

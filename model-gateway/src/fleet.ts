/**
 * Fleet supervision queue: lets a watcher decide, without any model involvement,
 * whether the lead needs to be woken. Snapshots and wake events are persisted
 * under <sessionDir>/fleet. Events are appended before the drain cursor is
 * advanced, so a crash between appending and draining cannot lose a wake-up.
 *
 * This file intentionally has no tmux or subprocess dependencies: the watcher
 * feeds it snapshots (job states + harness digests) and it turns the diff into
 * a durable event queue.
 */
import fs from "node:fs";
import path from "node:path";

export type FleetEventKind = "job.done" | "job.failed" | "harness.exited" | "harness.output" | "harness.idle" | "ci.pending" | "ci.failed" | "provider.circuit_open";

export interface FleetCi {
  repo?: string;
  branch?: string;
  sha: string;
  runId?: number;
  url?: string;
  job?: string;
  deployment?: boolean;
}

export interface FleetEvent {
  seq: number;
  ts: string;
  kind: FleetEventKind;
  id: string;
  reason: string;
  ci?: FleetCi;
  /**
   * Workspace root that produced the event. Absent on rows written before the queue learned
   * about workspaces; those belong to nobody and are visible to everyone, so an upgrade never
   * strands an event that no session will admit to owning.
   */
  workspace?: string;
}

export interface FleetSnapshot {
  ts: string;
  jobs: Record<string, string>;
  /**
   * `cwd` is the session's OWN directory, which is what owns its events. Without it a harness
   * event is attributed to whichever gateway happened to observe it, so a crew session running
   * in one project blocks the turn-end guard of every other project on the machine.
   */
  harness: Record<string, { state: string; digest: string; since: string; cwd?: string }>;
}

const QUEUE_FILE = "wake-queue.jsonl";
const CURSOR_FILE = "cursor";
const SNAPSHOT_FILE = "snapshot.json";
const RESOLVED_FILE = "resolved.json";

export function fleetDir(sessionDir: string): string {
  const dir = path.join(sessionDir, "fleet");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function readSnapshot(sessionDir: string): FleetSnapshot | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(fleetDir(sessionDir), SNAPSHOT_FILE), "utf8")) as FleetSnapshot;
    if (!parsed || typeof parsed !== "object" || typeof parsed.ts !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeSnapshot(sessionDir: string, snap: FleetSnapshot): void {
  fs.writeFileSync(path.join(fleetDir(sessionDir), SNAPSHOT_FILE), JSON.stringify(snap), { mode: 0o600 });
}

function parseTs(s: string): number | undefined {
  if (/^\d+$/.test(s.trim())) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  const n = Date.parse(s);
  return Number.isNaN(n) ? undefined : n;
}

function elapsedMs(a: string, b: string): number | undefined {
  const ta = parseTs(a);
  const tb = parseTs(b);
  if (ta === undefined || tb === undefined) return undefined;
  return ta - tb;
}

export function classify(prev: FleetSnapshot | undefined, next: FleetSnapshot, idleMs: number): Omit<FleetEvent, "seq">[] {
  const events: Omit<FleetEvent, "seq">[] = [];

  // Job transitions. On the very first snapshot there is no previous state to
  // compare against, but terminal jobs still matter to the watcher.
  for (const [id, state] of Object.entries(next.jobs ?? {})) {
    if (state !== "done" && state !== "failed") continue;
    const prevState = prev?.jobs?.[id];
    if (prev === undefined || prevState !== state) {
      events.push({ ts: next.ts, kind: state === "done" ? "job.done" : "job.failed", id, reason: state });
    }
  }

  if (prev) {
    for (const [id, h] of Object.entries(next.harness ?? {})) {
      const prevH = prev.harness?.[id];

      if (h.state === "exited") {
        if (prevH && prevH.state !== "exited") {
          events.push({ ts: next.ts, kind: "harness.exited", id, reason: "exited", ...(prevH?.cwd ? { workspace: prevH.cwd } : {}) });
        }
        continue;
      }

      if (h.state !== "running") continue;

      // Only a session that was already running can have produced new output or
      // be judged idle against its previous digest.
      const digestChanged = prevH !== undefined && prevH.state === "running" && prevH.digest !== h.digest;
      const digestUnchanged = prevH !== undefined && prevH.state === "running" && prevH.digest === h.digest;

      if (digestChanged) {
        events.push({ ts: next.ts, kind: "harness.output", id, reason: `digest ${prevH!.digest} -> ${h.digest}`, ...(h.cwd ? { workspace: h.cwd } : {}) });
        continue; // the digest just changed: since resets to next.ts, so it cannot be idle yet
      }

      if (digestUnchanged) {
        const since = prevH!.since;
        const idle = elapsedMs(next.ts, since);
        if (idle !== undefined && idle > idleMs) {
          events.push({ ts: next.ts, kind: "harness.idle", id, reason: `idle for ${idle}ms`, ...(h.cwd ? { workspace: h.cwd } : {}) });
        }
      }
    }
  }

  return events;
}

function readFileText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function parseEvents(text: string): FleetEvent[] {
  const events: FleetEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as FleetEvent;
      // Keep the queue resilient to corrupt-but-parseable lines too.
      if (parsed && typeof parsed === "object" && typeof parsed.seq === "number") {
        events.push(parsed);
      }
    } catch {
      // A truncated final line is normal after a crash: skip it.
    }
  }
  return events;
}

function readEventsFile(file: string): FleetEvent[] {
  const text = readFileText(file);
  return text === undefined ? [] : parseEvents(text);
}

function readResolvedSeqs(dir: string): number[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, RESOLVED_FILE), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  } catch {
    // Missing or corrupt sidecar behaves like an empty set: the queue itself is
    // still authoritative, and a crash while writing resolved.json must never
    // wedge pendingEvents.
    return [];
  }
}

function writeResolvedSeqs(dir: string, seqs: number[]): void {
  const unique = Array.from(new Set(seqs)).sort((a, b) => a - b);
  fs.writeFileSync(path.join(dir, RESOLVED_FILE), JSON.stringify(unique), { mode: 0o600 });
}

function markResolved(dir: string, seq: number): void {
  const seqs = readResolvedSeqs(dir);
  if (seqs.includes(seq)) return;
  seqs.push(seq);
  writeResolvedSeqs(dir, seqs);
}

function pendingEventsInDir(dir: string, workspace?: string): FleetEvent[] {
  const cursor = readCursor(dir, workspace);
  const resolved = new Set(readResolvedSeqs(dir));
  // An event belonging to another workspace is not this session's business: blocking a turn on
  // it is a false positive, and the only way to clear it is to discard a result nobody read.
  const mine = (e: FleetEvent) => !workspace || !e.workspace || e.workspace === workspace;
  return readEventsFile(path.join(dir, QUEUE_FILE)).filter((e) => e.seq > cursor && !resolved.has(e.seq) && mine(e));
}

/**
 * An event still waiting to be read, keyed by what it is about rather than when it was seen.
 *
 * `harness.idle` and a finished job are CONDITIONS, not moments: a session that has been idle
 * for a day is still idle at the next check, and a job that finished is still finished. The
 * classifier re-derives them from the snapshot every time, so appending unconditionally turns
 * one standing condition into one event per check — a real queue held 287 copies of a single
 * idle session and 15 of one finished plan, which is what made the turn-end guard look like it
 * was re-sending stale work. It was.
 *
 * Deduplicating here rather than in the classifier also covers the case the classifier cannot
 * see: several gateways share this directory, the snapshot is read-then-written, and a lost
 * race makes a finished job look new again to whichever process wrote last.
 */
function pendingMatcher(dir: string): (existing: FleetEvent[], event: Omit<FleetEvent, "seq">, workspace?: string) => boolean {
  const resolved = new Set(readResolvedSeqs(dir));
  // Against THIS workspace's cursor, not the shared baseline. A workspace that has already
  // collected an event has nothing outstanding, so a session going idle again — or a second
  // run of the same plan — is news to it and must be raised. Deduplicating against the
  // baseline instead would silence every recurrence for the rest of the queue's life.
  const cursors = readCursors(dir);
  const cursorFor = (ws?: string) => Math.max(cursors.baseline, cursors.byWorkspace[ws ?? ""] ?? 0);
  return (existing, event, workspace) => {
    const ws = event.workspace ?? workspace;
    const cursor = cursorFor(ws);
    return existing.some(
      (e) => e.seq > cursor && !resolved.has(e.seq) && e.kind === event.kind && e.id === event.id && (e.workspace ?? undefined) === (ws ?? undefined),
    );
  };
}

/**
 * Append events and hand back the same rows with their assigned seq.
 *
 * Read-then-append, so it assumes a single writer. That is the design: one
 * watcher owns the queue. Two concurrent writers could hand out the same seq.
 */
export function appendEvents(sessionDir: string, events: Omit<FleetEvent, "seq">[], workspace?: string): FleetEvent[] {
  const dir = fleetDir(sessionDir);
  const file = path.join(dir, QUEUE_FILE);

  const text = readFileText(file) ?? "";
  const existing = parseEvents(text);
  let seq = existing.length > 0 ? existing[existing.length - 1].seq : 0;

  const out: FleetEvent[] = [];
  const lines: string[] = [];
  const alreadyPending = pendingMatcher(dir);
  for (const event of events) {
    // Saying the same thing twice does not make it twice as true, and the reader cannot tell
    // the copies apart to dismiss them. `existing` grows as we go, so a batch that repeats
    // itself is deduplicated against its own earlier rows too, not just against the file.
    if (alreadyPending(existing, event, workspace)) continue;
    seq += 1;
    // Stamp the producer, unless the caller already set one (a CI event knows its own repo).
    const full: FleetEvent = { ...(workspace ? { workspace } : {}), ...event, seq };
    existing.push(full);
    out.push(full);
    lines.push(JSON.stringify(full));
  }

  if (lines.length > 0) {
    // If a crash left a truncated final line without a trailing newline, the
    // next append must start on a fresh line or it would become unparseable too.
    const prefix = text.length > 0 && !text.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(file, `${prefix}${lines.join("\n")}\n`, { mode: 0o600 });
  }
  return out;
}

export function readEvents(sessionDir: string): FleetEvent[] {
  return readEventsFile(path.join(fleetDir(sessionDir), QUEUE_FILE));
}

/** The whole cursor file: a baseline every workspace inherits, plus each workspace's own mark. */
interface Cursors {
  /** What the file held before it learned about workspaces: already-drained for everybody. */
  baseline: number;
  byWorkspace: Record<string, number>;
}

/**
 * One shared integer cannot say "project A has seen up to 99, project B up to 42", which is how
 * a finished job in one repository came to block a turn in another. The file is a map now; a
 * file still holding a bare integer is read as a baseline that applies to every workspace, so
 * upgrading does not re-emit everything already drained.
 */
function readCursors(dir: string): Cursors {
  try {
    const raw = fs.readFileSync(path.join(dir, CURSOR_FILE), "utf8").trim();
    if (!raw) return { baseline: 0, byWorkspace: {} };
    if (/^\d+$/.test(raw)) return { baseline: Number.parseInt(raw, 10), byWorkspace: {} };
    const j = JSON.parse(raw) as Partial<Cursors>;
    return { baseline: Number(j.baseline) || 0, byWorkspace: j.byWorkspace ?? {} };
  } catch {
    return { baseline: 0, byWorkspace: {} };
  }
}

function readCursor(dir: string, workspace?: string): number {
  const c = readCursors(dir);
  // "" is a real key, not the absence of one: a caller that drains without naming a workspace
  // must see its own drain on the next read, exactly as a named one does.
  return Math.max(c.baseline, c.byWorkspace[workspace ?? ""] ?? 0);
}

export function pendingEvents(sessionDir: string, workspace?: string): FleetEvent[] {
  const dir = fleetDir(sessionDir);
  return pendingEventsInDir(dir, workspace);
}

function findNonDrainedCiPending(dir: string, sha: string): FleetEvent | undefined {
  const cursor = readCursor(dir);
  return readEventsFile(path.join(dir, QUEUE_FILE)).find(
    (e) => e.kind === "ci.pending" && e.seq > cursor && e.ci?.sha === sha,
  );
}

function resolveCiPending(sessionDir: string, dir: string, event: FleetEvent): void {
  // The queue is append-only. If this pending event is the oldest thing still
  // waiting, advancing the cursor naturally drains it. Otherwise we can only
  // mark its seq in the sidecar so pendingEvents skips it without rewriting
  // wake-queue.jsonl and without draining unrelated, older pending events.
  const pending = pendingEventsInDir(dir);
  const oldest = pending.length > 0 ? pending[0] : undefined;
  if (oldest !== undefined && oldest.seq === event.seq) {
    drainTo(sessionDir, event.seq);
  } else {
    markResolved(dir, event.seq);
  }
}

/**
 * Record that a CI run for `sha` is underway. One pending event per sha is
 * enough: a duplicate would make the same push block twice.
 */
export function enqueueCi(sessionDir: string, ci: { repo?: string; branch?: string; sha: string }): FleetEvent {
  const dir = fleetDir(sessionDir);
  const existing = findNonDrainedCiPending(dir, ci.sha);
  if (existing) return existing;

  const [event] = appendEvents(sessionDir, [
    { ts: new Date().toISOString(), kind: "ci.pending", id: ci.sha, reason: "ci.pending", ci },
  ]);
  return event;
}

export function resolveCi(
  sessionDir: string,
  sha: string,
  outcome: { state: "pending" | "success" | "failed"; runId?: number; url?: string; job?: string },
): void {
  if (outcome.state === "pending") return;

  const dir = fleetDir(sessionDir);
  const pending = pendingEventsInDir(dir).find((e) => e.kind === "ci.pending" && e.ci?.sha === sha);

  if (pending) resolveCiPending(sessionDir, dir, pending);

  if (outcome.state === "failed") {
    // Keep repo/branch/deployment context when we have a pending event, but a
    // failure must still be recorded even if the original pending was already
    // drained or never enqueued.
    appendEvents(sessionDir, [
      {
        ts: new Date().toISOString(),
        kind: "ci.failed",
        id: sha,
        reason: "ci.failed",
        ci: {
          repo: pending?.ci?.repo,
          branch: pending?.ci?.branch,
          sha,
          runId: outcome.runId,
          url: outcome.url,
          job: outcome.job,
          deployment: pending?.ci?.deployment,
        },
      },
    ]);
  }
}

export function expireCi(sessionDir: string, now: number, timeoutMs: number): number {
  const dir = fleetDir(sessionDir);
  let expired = 0;

  for (const event of pendingEventsInDir(dir)) {
    if (event.kind !== "ci.pending") continue;
    const ts = parseTs(event.ts);
    if (ts === undefined || now - ts <= timeoutMs) continue;

    resolveCiPending(sessionDir, dir, event);
    expired += 1;
  }

  return expired;
}

/**
 * Advance the drain cursor. Monotonic on purpose: a caller passing a lower seq
 * than the cursor already holds would otherwise rewind it and re-emit events
 * that were already handled, which is exactly the duplicate-wake the queue
 * exists to prevent.
 */
export function drainTo(sessionDir: string, seq: number, workspace?: string): void {
  const dir = fleetDir(sessionDir);
  const cursors = readCursors(dir);
  const key = workspace ?? "";
  const current = Math.max(cursors.baseline, cursors.byWorkspace[key] ?? 0);
  if (seq <= current) return;
  cursors.byWorkspace[key] = seq;
  fs.writeFileSync(path.join(dir, CURSOR_FILE), JSON.stringify(cursors), { mode: 0o600 });
}

/**
 * Reading a job's result IS collecting it.
 *
 * The wake queue exists to stop a finished job going unnoticed, so once someone has read the
 * result that purpose is served. Without this, `job_result` left the event pending and the
 * turn-end guard kept naming jobs the agent had already collected — the same three ids every
 * turn, with no call that would clear them. Resolving by id (the sidecar, not the cursor)
 * skips exactly this job's events and leaves older, unrelated ones pending.
 */
export function resolveJob(sessionDir: string, jobId: string): number {
  const dir = fleetDir(sessionDir);
  let resolved = 0;
  for (const event of pendingEventsInDir(dir)) {
    if (event.id !== jobId) continue;
    if (event.kind !== "job.done" && event.kind !== "job.failed") continue;
    markResolved(dir, event.seq);
    resolved += 1;
  }
  return resolved;
}

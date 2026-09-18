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

export type FleetEventKind = "job.done" | "job.failed" | "harness.exited" | "harness.output" | "harness.idle";

export interface FleetEvent {
  seq: number;
  ts: string;
  kind: FleetEventKind;
  id: string;
  reason: string;
}

export interface FleetSnapshot {
  ts: string;
  jobs: Record<string, string>;
  harness: Record<string, { state: string; digest: string; since: string }>;
}

const QUEUE_FILE = "wake-queue.jsonl";
const CURSOR_FILE = "cursor";
const SNAPSHOT_FILE = "snapshot.json";

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
          events.push({ ts: next.ts, kind: "harness.exited", id, reason: "exited" });
        }
        continue;
      }

      if (h.state !== "running") continue;

      // Only a session that was already running can have produced new output or
      // be judged idle against its previous digest.
      const digestChanged = prevH !== undefined && prevH.state === "running" && prevH.digest !== h.digest;
      const digestUnchanged = prevH !== undefined && prevH.state === "running" && prevH.digest === h.digest;

      if (digestChanged) {
        events.push({ ts: next.ts, kind: "harness.output", id, reason: `digest ${prevH!.digest} -> ${h.digest}` });
        continue; // the digest just changed: since resets to next.ts, so it cannot be idle yet
      }

      if (digestUnchanged) {
        const since = prevH!.since;
        const idle = elapsedMs(next.ts, since);
        if (idle !== undefined && idle > idleMs) {
          events.push({ ts: next.ts, kind: "harness.idle", id, reason: `idle for ${idle}ms` });
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

/**
 * Append events and hand back the same rows with their assigned seq.
 *
 * Read-then-append, so it assumes a single writer. That is the design: one
 * watcher owns the queue. Two concurrent writers could hand out the same seq.
 */
export function appendEvents(sessionDir: string, events: Omit<FleetEvent, "seq">[]): FleetEvent[] {
  const dir = fleetDir(sessionDir);
  const file = path.join(dir, QUEUE_FILE);

  const text = readFileText(file) ?? "";
  const existing = parseEvents(text);
  let seq = existing.length > 0 ? existing[existing.length - 1].seq : 0;

  const out: FleetEvent[] = [];
  const lines: string[] = [];
  for (const event of events) {
    seq += 1;
    const full: FleetEvent = { ...event, seq };
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

function readCursor(dir: string): number {
  try {
    const raw = fs.readFileSync(path.join(dir, CURSOR_FILE), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function pendingEvents(sessionDir: string): FleetEvent[] {
  const dir = fleetDir(sessionDir);
  const cursor = readCursor(dir);
  return readEventsFile(path.join(dir, QUEUE_FILE)).filter((e) => e.seq > cursor);
}

/**
 * Advance the drain cursor. Monotonic on purpose: a caller passing a lower seq
 * than the cursor already holds would otherwise rewind it and re-emit events
 * that were already handled, which is exactly the duplicate-wake the queue
 * exists to prevent.
 */
export function drainTo(sessionDir: string, seq: number): void {
  const dir = fleetDir(sessionDir);
  const current = readCursor(dir);
  if (seq <= current) return;
  fs.writeFileSync(path.join(dir, CURSOR_FILE), String(seq), { mode: 0o600 });
}

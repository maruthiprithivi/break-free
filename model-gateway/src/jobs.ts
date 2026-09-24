/**
 * Background jobs: long delegations / plans run detached from the MCP call so the
 * orchestrator can keep working and poll (job_status / job_result) or cancel.
 * Completed jobs are persisted under <sessionDir>/jobs so a new session can
 * still collect results.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic.js";

/**
 * How many of the newest job records a listing reads.
 *
 * The Stop hook lists jobs at every turn end of every session. It used to read and JSON-parse
 * every record ever written - 299 files, 2.5 MB, 89% of it result text it then threw away - and
 * nothing removed any of them, so the cost of ending a turn grew with the lifetime of the
 * install. A stat is microseconds; only the newest records are opened.
 */
const LIST_SCAN = 150;
/** Finished records older than this are removed; job_result on one returns "unknown job". */
const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
import type { GatewayConfig } from "./config.js";
import { log as rlog } from "./logger.js";

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  /**
   * Workspace that started this job.
   *
   * The job store is one directory shared by every project on the machine, so without this a
   * gateway reading it cannot tell its own work from anyone else's — and the fleet watcher
   * ended up stamping another project's finished job with whichever workspace noticed it.
   */
  workspace?: string;
  kind: string;
  label?: string;
  state: JobState;
  createdAt: string;
  finishedAt?: string;
  progress: string[];
  result?: unknown;
  error?: string;
}

interface LiveJob {
  rec: JobRecord;
  abort: AbortController;
  promise: Promise<void>;
}

export class JobRegistry {
  private jobs = new Map<string, LiveJob>();
  private dir: string | undefined;
  constructor(private config: GatewayConfig, stateless: boolean, private workspace?: string) {
    if (!stateless && config.sessionDir) {
      this.dir = path.join(config.sessionDir, "jobs");
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  start<T>(kind: string, label: string | undefined, fn: (signal: AbortSignal, progress: (s: string) => void) => Promise<T>): JobRecord {
    const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const abort = new AbortController();
    const rec: JobRecord = { id, kind, label, workspace: this.workspace, state: "running", createdAt: new Date().toISOString(), progress: [] };
    const progress = (s: string) => {
      rec.progress.push(`${new Date().toISOString()} ${s}`);
      if (rec.progress.length > 200) rec.progress.splice(0, rec.progress.length - 200);
    };
    const promise = fn(abort.signal, progress).then(
      (r) => {
        rec.state = "done";
        rec.result = r;
      },
      (e) => {
        rec.state = abort.signal.aborted ? "cancelled" : "failed";
        rec.error = String((e as Error).message ?? e);
      },
    ).finally(() => {
      rec.finishedAt = new Date().toISOString();
      rlog("job.end", { id, job_kind: kind, state: rec.state, ms: Date.parse(rec.finishedAt) - Date.parse(rec.createdAt), error: rec.error?.slice(0, 200) });
      this.persist(rec);
    });
    this.jobs.set(id, { rec, abort, promise });
    rlog("job.start", { id, job_kind: kind, label });
    return rec;
  }

  get(id: string): JobRecord | undefined {
    const live = this.jobs.get(id);
    if (live) return live.rec;
    if (this.dir) {
      const base = path.join(this.dir, id.replace(/[^A-Za-z0-9._-]/g, "_"));
      if (fs.existsSync(`${base}.json`)) {
        try {
          const rec = JSON.parse(fs.readFileSync(`${base}.json`, "utf8")) as JobRecord;
          // The result lives beside the record, read only when someone asks for it.
          if (rec.result === undefined && fs.existsSync(`${base}.result.json`)) rec.result = JSON.parse(fs.readFileSync(`${base}.result.json`, "utf8"));
          return rec;
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  async wait(id: string, timeoutMs: number): Promise<JobRecord | undefined> {
    const live = this.jobs.get(id);
    if (!live) return this.get(id);
    await Promise.race([live.promise, new Promise((r) => setTimeout(r, timeoutMs))]);
    return live.rec;
  }

  cancel(id: string): boolean {
    const live = this.jobs.get(id);
    if (!live || live.rec.state !== "running") return false;
    live.abort.abort();
    return true;
  }

  /**
   * Jobs on this machine. `mine` limits them to this workspace, which is what the fleet
   * watcher wants: another project's running job is not a reason to hold this turn open.
   * Records written before jobs carried a workspace have none and are included either way,
   * so an upgrade does not make existing work invisible.
   */
  list(opts: { mine?: boolean } = {}): Omit<JobRecord, "result" | "progress">[] {
    const rows = new Map<string, JobRecord>();
    if (this.dir) {
      const now = Date.now();
      const entries: { f: string; mtime: number }[] = [];
      for (const f of fs.readdirSync(this.dir)) {
        if (!f.endsWith(".json") || f.endsWith(".result.json")) continue;
        try { entries.push({ f, mtime: fs.statSync(path.join(this.dir, f)).mtimeMs }); } catch { /* raced a delete */ }
      }
      entries.sort((a, b) => b.mtime - a.mtime);
      for (const [i, { f, mtime }] of entries.entries()) {
        const file = path.join(this.dir, f);
        if (now - mtime > JOB_RETENTION_MS) {
          // Every record on disk is a finished job: running ones live in memory until they end.
          for (const x of [file, file.replace(/\.json$/, ".result.json")]) fs.rmSync(x, { force: true });
          continue;
        }
        if (i >= LIST_SCAN) continue;
        try {
          const j = JSON.parse(fs.readFileSync(file, "utf8")) as JobRecord;
          if (j.result !== undefined) {
            // Written before results moved out. Keep its age: rewriting it would otherwise make
            // an old job look newest and restart its retention clock.
            this.split(j);
            try { fs.utimesSync(file, mtime / 1000, mtime / 1000); } catch { /* ordering is best effort */ }
          }
          rows.set(j.id, j);
        } catch {
          /* skip */
        }
      }
    }
    for (const j of this.jobs.values()) rows.set(j.rec.id, j.rec);
    // A record with no workspace predates this field; it is nobody's and stays visible rather
    // than vanishing from a listing someone is relying on.
    const mine = (j: JobRecord) => !opts.mine || !this.workspace || !j.workspace || j.workspace === this.workspace;
    return [...rows.values()].filter(mine).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(({ result: _r, progress: _p, ...rest }) => rest);
  }

  private persist(rec: JobRecord): void {
    if (!this.dir) return;
    try {
      this.split(rec);
    } catch {
      /* best effort */
    }
  }

  /**
   * Write a record and its result as two files: the listing reads the small one, and only
   * job_result reads the large one. The result is written first so a record never points at a
   * result that is not there yet.
   */
  private split(rec: JobRecord): void {
    if (!this.dir) return;
    const base = path.join(this.dir, rec.id.replace(/[^A-Za-z0-9._-]/g, "_"));
    const { result, ...head } = rec;
    if (result !== undefined) atomicWrite(`${base}.result.json`, JSON.stringify(result));
    atomicWrite(`${base}.json`, JSON.stringify(head, null, 2));
  }
}

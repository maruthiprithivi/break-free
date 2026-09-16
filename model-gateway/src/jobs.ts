/**
 * Background jobs: long delegations / plans run detached from the MCP call so the
 * orchestrator can keep working and poll (job_status / job_result) or cancel.
 * Completed jobs are persisted under <sessionDir>/jobs so a new session can
 * still collect results.
 */
import fs from "node:fs";
import path from "node:path";
import type { GatewayConfig } from "./config.js";
import { log as rlog } from "./logger.js";

export type JobState = "running" | "done" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
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
  constructor(private config: GatewayConfig, stateless: boolean) {
    if (!stateless && config.sessionDir) {
      this.dir = path.join(config.sessionDir, "jobs");
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    }
  }

  start<T>(kind: string, label: string | undefined, fn: (signal: AbortSignal, progress: (s: string) => void) => Promise<T>): JobRecord {
    const id = `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const abort = new AbortController();
    const rec: JobRecord = { id, kind, label, state: "running", createdAt: new Date().toISOString(), progress: [] };
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
      const f = path.join(this.dir, `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
      if (fs.existsSync(f)) {
        try {
          return JSON.parse(fs.readFileSync(f, "utf8")) as JobRecord;
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

  list(): Omit<JobRecord, "result" | "progress">[] {
    const rows = new Map<string, JobRecord>();
    if (this.dir) {
      for (const f of fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as JobRecord;
          rows.set(j.id, j);
        } catch {
          /* skip */
        }
      }
    }
    for (const j of this.jobs.values()) rows.set(j.rec.id, j.rec);
    return [...rows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(({ result: _r, progress: _p, ...rest }) => rest);
  }

  private persist(rec: JobRecord): void {
    if (!this.dir) return;
    try {
      fs.writeFileSync(path.join(this.dir, `${rec.id}.json`), JSON.stringify(rec, null, 2), { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }
}

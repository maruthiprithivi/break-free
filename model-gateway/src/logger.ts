/**
 * Runtime log: one JSON object per line in ~/.config/model-gateway/gateway.log
 * (override with MODEL_GATEWAY_LOG=path or config.logFile). Rotated at 10 MB,
 * 3 generations kept. Secrets are redacted before writing.
 *
 * Event kinds:
 *   tool.start / tool.end   MCP tool calls from the orchestrator (name, args summary, ok, ms)
 *   route.attempt           one provider/model attempt (spec, ok, reason, ms)
 *   worker.tool             a tool the delegated model invoked (name, ok, ms)
 *   server                  lifecycle
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";

export interface LogEvent {
  ts: string;
  kind: string;
  call?: string; // correlation id for one MCP tool invocation
  [k: string]: unknown;
}

const MAX_BYTES = 10 * 1024 * 1024;
const GENERATIONS = 3;
// Known key prefixes, bearer tokens, and generic long mixed-case+digit strings (so git SHAs / hex hashes survive).
const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+[A-Za-z0-9._-]{12,}|(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,})\b/g;
const SECRET_KEYS = /^(apikey|api_key|token|authorization|password|secret|gh_token)$/i;

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof v === "string") return v.replace(SECRET_RE, (m) => (m.length > 12 ? `${m.slice(0, 4)}…[redacted]` : "[redacted]"));
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(val, depth + 1);
    return out;
  }
  return v;
}

export function summarizeArgs(args: unknown, max = 200): Record<string, unknown> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = typeof v === "string" ? (v.length > max ? `${v.slice(0, max)}… (${v.length} chars)` : v) : Array.isArray(v) ? `[${v.length} items]` : v;
  }
  return redact(out) as Record<string, unknown>;
}

export class Logger {
  readonly file: string;
  private enabled: boolean;
  private seq = 0;

  constructor(file?: string, enabled = true) {
    this.file = file ?? process.env.MODEL_GATEWAY_LOG ?? path.join(os.homedir(), ".config", "model-gateway", "gateway.log");
    this.enabled = enabled;
    if (enabled) {
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      } catch {
        this.enabled = false;
      }
    }
  }

  newCallId(): string {
    return `${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
  }

  write(kind: string, fields: Record<string, unknown> = {}): void {
    if (!this.enabled) return;
    const ev: LogEvent = { ts: new Date().toISOString(), kind, ...(redact(fields) as Record<string, unknown>) };
    try {
      this.rotateIfNeeded();
      fs.appendFileSync(this.file, JSON.stringify(ev) + "\n", { mode: 0o600 });
    } catch {
      /* logging must never break a call */
    }
  }

  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < MAX_BYTES) return;
    for (let i = GENERATIONS - 1; i >= 1; i--) {
      const from = `${this.file}.${i}`;
      const to = `${this.file}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(this.file, `${this.file}.1`);
  }

  /** Read the last `n` events (across rotated generations if needed). */
  tail(n = 200, filter?: (e: LogEvent) => boolean): LogEvent[] {
    const files = [`${this.file}.2`, `${this.file}.1`, this.file].filter((f) => fs.existsSync(f));
    const events: LogEvent[] = [];
    for (const f of files) {
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const e = JSON.parse(line) as LogEvent;
          if (!filter || filter(e)) events.push(e);
        } catch {
          /* skip corrupt line */
        }
      }
    }
    return events.slice(-n);
  }
}

/** Aggregate recent events into a health picture. Used by the gateway_logs tool and setup --doctor. */
export function analyze(events: LogEvent[]) {
  const byProvider: Record<string, { ok: number; fail: number; reasons: Record<string, number>; lastError?: string; lastErrorAt?: string; lastOkAt?: string; totalMs: number; tokens: { prompt: number; completion: number }; costUsd: number; unpriced: number }> = {};
  const costByDay: Record<string, number> = {};
  const jobs = { started: 0, done: 0, failed: 0, cancelled: 0 };
  const mcp: Record<string, { calls: number; failed: number; connectFailures: number }> = {};
  const byTool: Record<string, { ok: number; fail: number; totalMs: number; lastError?: string }> = {};
  let first: string | undefined, last: string | undefined;
  for (const e of events) {
    first ??= e.ts;
    last = e.ts;
    if (e.kind === "route.attempt") {
      const prov = String(e.spec ?? "?").split("/")[0];
      const p = (byProvider[prov] ??= { ok: 0, fail: 0, reasons: {}, totalMs: 0, tokens: { prompt: 0, completion: 0 }, costUsd: 0, unpriced: 0 });
      p.totalMs += Number(e.ms ?? 0);
      if (e.ok) {
        p.ok++;
        p.lastOkAt = e.ts;
        const u = e.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
        p.tokens.prompt += Number(u?.prompt_tokens ?? 0);
        p.tokens.completion += Number(u?.completion_tokens ?? 0);
        const c = Number(e.cost_usd ?? 0);
        p.costUsd = Math.round((p.costUsd + c) * 1e6) / 1e6;
        if (e.priced === false) p.unpriced++;
        const day = String(e.ts).slice(0, 10);
        costByDay[day] = Math.round(((costByDay[day] ?? 0) + c) * 1e6) / 1e6;
      } else {
        p.fail++;
        const r = String(e.reason ?? "error");
        p.reasons[r] = (p.reasons[r] ?? 0) + 1;
        p.lastError = String(e.error ?? "").slice(0, 200);
        p.lastErrorAt = e.ts;
      }
    } else if (e.kind === "job.start") jobs.started++;
    else if (e.kind === "job.end") {
      if (e.state === "done") jobs.done++;
      else if (e.state === "cancelled") jobs.cancelled++;
      else jobs.failed++;
    } else if (e.kind === "mcp.call" || e.kind === "mcp.connect") {
      const m = (mcp[String(e.server)] ??= { calls: 0, failed: 0, connectFailures: 0 });
      if (e.kind === "mcp.call") {
        m.calls++;
        if (!e.ok) m.failed++;
      } else if (!e.ok) m.connectFailures++;
    } else if (e.kind === "tool.end") {
      const t = (byTool[String(e.tool)] ??= { ok: 0, fail: 0, totalMs: 0 });
      t.totalMs += Number(e.ms ?? 0);
      if (e.ok) t.ok++;
      else {
        t.fail++;
        t.lastError = String(e.error ?? "").slice(0, 200);
      }
    }
  }
  const findings: string[] = [];
  for (const [prov, p] of Object.entries(byProvider)) {
    const total = p.ok + p.fail;
    if (total >= 3 && p.fail === total) findings.push(`${prov}: every one of the last ${total} attempts failed (${Object.entries(p.reasons).map(([r, n]) => `${r}×${n}`).join(", ")}) — last: ${p.lastError}`);
    else if (p.fail >= 3 && p.fail / total > 0.5) findings.push(`${prov}: ${p.fail}/${total} attempts failed — mostly ${Object.entries(p.reasons).sort((a, b) => b[1] - a[1])[0][0]}`);
    if ((p.reasons.auth ?? 0) >= 2) findings.push(`${prov}: repeated auth failures — the key is probably wrong or expired`);
    if ((p.reasons.rate_limit ?? 0) >= 3) findings.push(`${prov}: rate-limited ${p.reasons.rate_limit} times — add credit, lower concurrency, or move it later in the fallback chain`);
    if ((p.reasons.timeout ?? 0) >= 3) findings.push(`${prov}: ${p.reasons.timeout} timeouts — raise providers.${prov}.timeoutMs or pick a faster model`);
  }
  for (const [tool, t] of Object.entries(byTool)) if (t.fail >= 2 && t.fail >= t.ok) findings.push(`tool ${tool}: ${t.fail} failures vs ${t.ok} successes — last: ${t.lastError}`);
  for (const [srv, m] of Object.entries(mcp)) if (m.connectFailures >= 2) findings.push(`MCP server ${srv}: ${m.connectFailures} connection failures — check its command/url in list_mcp_servers`);
  return {
    window: { from: first, to: last, events: events.length },
    providers: Object.fromEntries(Object.entries(byProvider).map(([k, p]) => [k, { ...p, avgMs: p.ok + p.fail ? Math.round(p.totalMs / (p.ok + p.fail)) : 0 }])),
    tools: Object.fromEntries(Object.entries(byTool).map(([k, t]) => [k, { ...t, avgMs: t.ok + t.fail ? Math.round(t.totalMs / (t.ok + t.fail)) : 0 }])),
    jobs,
    mcp,
    cost: { byDay: costByDay, totalUsd: Math.round(Object.values(costByDay).reduce((a, b) => a + b, 0) * 1e6) / 1e6, unpricedCalls: Object.values(byProvider).reduce((a, p) => a + p.unpriced, 0) },
    findings,
  };
}

// ---- process-wide singleton + call correlation -------------------------------
let active: Logger | undefined;
export const callContext = new AsyncLocalStorage<{ call: string; tool: string }>();
export function setLogger(l: Logger | undefined): void { active = l; }
export function log(kind: string, fields: Record<string, unknown> = {}): void {
  if (!active) return;
  const ctx = callContext.getStore();
  active.write(kind, { ...(ctx ? { call: ctx.call, tool: ctx.tool } : {}), ...fields });
}

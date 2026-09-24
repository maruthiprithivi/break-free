/**
 * Per-provider circuit breaker.
 *
 * The failure this exists for: a delegated task fell back to a host that was
 * wedged — TCP connected, then silence — with timeoutMs 600000 and one retry
 * per candidate. One call burned twenty minutes, and every later call in the
 * session burned twenty more, because nothing remembered that the host was
 * dead. A timeout is per-host evidence, not per-model, so the strike count is
 * kept per provider.
 *
 * After `failures` consecutive timeout/network errors a provider's circuit
 * opens and its candidates are skipped instantly for `cooldownMs`. When the
 * cooldown lapses the next call is a trial: the strike count is NOT reset, so
 * a single further failure re-opens it, and only a success clears it.
 *
 * State is persisted so a restart does not re-learn the same dead host, and
 * so `--doctor` can report it from a separate process.
 */
import fs from "node:fs";
import path from "node:path";
import { appendEvents } from "./fleet.js";
import { log as rlog } from "./logger.js";

export interface CircuitState {
  failures: number;
  /** ISO time the circuit opened; absent while closed. */
  openedAt?: string;
  lastError?: string;
}

export interface OpenCircuit {
  provider: string;
  openedAt: string;
  reopensAt: string;
  failures: number;
  lastError?: string;
}

export interface BreakerConfig {
  enabled: boolean;
  failures: number;
  cooldownMs: number;
}

export class Breaker {
  private state: Record<string, CircuitState> | undefined;
  /** mtime and size of the file this process last read, so a change by another gateway is seen. */
  private version = "";

  constructor(
    private readonly sessionDir: string | undefined,
    private readonly cfg: BreakerConfig,
  ) {}

  private get file(): string | undefined {
    return this.sessionDir ? path.join(this.sessionDir, "breaker.json") : undefined;
  }

  /**
   * The circuits as they are on disk now, re-read whenever another process has changed them.
   *
   * This used to read breaker.json once per process and trust that copy for the life of the
   * session. With a gateway per session and per worktree - 28 on one machine - a trip recorded
   * by one was invisible to the rest, and each of them paid the failed calls again to learn it.
   */
  private read(): Record<string, CircuitState> {
    if (!this.file) return (this.state ??= {});
    try {
      const st = fs.statSync(this.file);
      const version = `${st.mtimeMs}:${st.size}`;
      if (this.state && version === this.version) return this.state;
      this.state = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, CircuitState>;
      this.version = version;
    } catch {
      // Missing means nothing recorded yet. Unreadable means keep what we had: a breaker that
      // throws would be worse than one that forgets, which costs one timeout.
      this.state ??= {};
    }
    return this.state;
  }

  /**
   * Change one provider's circuit, starting from the file as it is now.
   *
   * The old save() wrote this process's whole in-memory map back, so a gateway that had loaded
   * the file hours earlier erased every circuit another gateway had opened since, the moment it
   * recorded one strike against anything. Re-reading first and writing through a rename means a
   * change touches only its own provider, and no reader ever sees a half-written file.
   */
  private mutate(change: (st: Record<string, CircuitState>) => void): void {
    this.version = "";
    const st = this.read();
    change(st);
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      const after = fs.statSync(this.file);
      this.version = `${after.mtimeMs}:${after.size}`;
    } catch {
      // Persistence is an optimisation; in-memory state still protects this process.
    }
  }

  /** Epoch ms at which the circuit reopens, or undefined when the provider is usable. */
  openUntil(provider: string, now = Date.now()): number | undefined {
    if (!this.cfg.enabled) return undefined;
    const s = this.read()[provider];
    if (!s?.openedAt) return undefined;
    const until = Date.parse(s.openedAt) + this.cfg.cooldownMs;
    return until > now ? until : undefined;
  }

  /** Record a host-level failure. Returns true when this call opened the circuit. */
  record(provider: string, error: string, now = Date.now()): boolean {
    if (!this.cfg.enabled) return false;
    let tripped = false;
    let s: CircuitState = { failures: 0 };
    this.mutate((st) => {
      s = st[provider] ??= { failures: 0 };
      s.failures += 1;
      s.lastError = error.slice(0, 300);
      // Already open - perhaps by another gateway - is not a new trip, and must not append a
      // second circuit_open row for every process that happens to notice the same outage.
      const open = !!s.openedAt && Date.parse(s.openedAt) + this.cfg.cooldownMs > now;
      tripped = s.failures >= this.cfg.failures && !open;
      if (tripped) s.openedAt = new Date(now).toISOString();
    });
    if (tripped) {
      rlog("breaker.open", { provider, failures: s.failures, cooldown_ms: this.cfg.cooldownMs, error: s.lastError });
      if (this.sessionDir) {
        try {
          appendEvents(this.sessionDir, [{
            ts: new Date(now).toISOString(),
            kind: "provider.circuit_open",
            id: provider,
            reason: `${s.failures} consecutive timeouts/network errors; skipped for ${Math.round(this.cfg.cooldownMs / 1000)}s — ${s.lastError}`,
          }]);
        } catch {
          // A missing queue must not turn a degraded provider into a failed call.
        }
      }
    }
    return tripped;
  }

  /** A provider that answered is healthy: strikes and any open circuit are dropped. */
  clear(provider: string): void {
    // Called on every success, so the common case - nothing recorded - must not write.
    if (!this.read()[provider]) return;
    let wasOpen = false;
    this.mutate((st) => {
      if (!st[provider]) return;
      wasOpen = !!st[provider].openedAt;
      delete st[provider];
    });
    if (wasOpen) rlog("breaker.close", { provider });
  }

  list(now = Date.now()): OpenCircuit[] {
    const st = this.read();
    return Object.entries(st)
      .filter(([p]) => this.openUntil(p, now) !== undefined)
      .map(([provider, s]) => ({
        provider,
        openedAt: s.openedAt!,
        reopensAt: new Date(this.openUntil(provider, now)!).toISOString(),
        failures: s.failures,
        lastError: s.lastError,
      }));
  }
}

// One breaker per session directory: the circuit is a property of the host, not of a
// single call, so every route in this process must see the same strikes.
const instances = new Map<string, Breaker>();

export function getBreaker(config: { sessionDir?: string; fallback: { breaker: BreakerConfig } }): Breaker {
  const cfg = config.fallback.breaker;
  const key = `${config.sessionDir ?? ""}|${cfg.enabled}|${cfg.failures}|${cfg.cooldownMs}`;
  let b = instances.get(key);
  if (!b) instances.set(key, (b = new Breaker(config.sessionDir, cfg)));
  return b;
}

/** Test seam: forget every memoised breaker. */
export function resetBreakers(): void {
  instances.clear();
}

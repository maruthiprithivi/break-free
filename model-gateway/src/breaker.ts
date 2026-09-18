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

  constructor(
    private readonly sessionDir: string | undefined,
    private readonly cfg: BreakerConfig,
  ) {}

  private get file(): string | undefined {
    return this.sessionDir ? path.join(this.sessionDir, "breaker.json") : undefined;
  }

  private load(): Record<string, CircuitState> {
    if (this.state) return this.state;
    this.state = {};
    // A breaker that throws on a corrupt file would be worse than one that forgets:
    // forgetting costs one timeout, throwing costs every call.
    try {
      if (this.file && fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, CircuitState>;
    } catch {
      this.state = {};
    }
    return this.state;
  }

  private save(): void {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.file, JSON.stringify(this.load(), null, 2), { mode: 0o600 });
    } catch {
      // Persistence is an optimisation; in-memory state still protects this process.
    }
  }

  /** Epoch ms at which the circuit reopens, or undefined when the provider is usable. */
  openUntil(provider: string, now = Date.now()): number | undefined {
    if (!this.cfg.enabled) return undefined;
    const s = this.load()[provider];
    if (!s?.openedAt) return undefined;
    const until = Date.parse(s.openedAt) + this.cfg.cooldownMs;
    return until > now ? until : undefined;
  }

  /** Record a host-level failure. Returns true when this call opened the circuit. */
  record(provider: string, error: string, now = Date.now()): boolean {
    if (!this.cfg.enabled) return false;
    const st = this.load();
    const s = (st[provider] ??= { failures: 0 });
    s.failures += 1;
    s.lastError = error.slice(0, 300);
    const tripped = s.failures >= this.cfg.failures && !this.openUntil(provider, now);
    if (tripped) s.openedAt = new Date(now).toISOString();
    this.save();
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
    const st = this.load();
    if (!st[provider]) return;
    const wasOpen = !!st[provider].openedAt;
    delete st[provider];
    this.save();
    if (wasOpen) rlog("breaker.close", { provider });
  }

  list(now = Date.now()): OpenCircuit[] {
    const st = this.load();
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

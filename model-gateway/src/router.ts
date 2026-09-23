/**
 * Model resolution + fallback.
 *
 * A "model spec" is one of:
 *   - an alias from config.aliases            e.g. "fast", "strong", "reviewer"
 *   - "<provider>/<model>"                     e.g. "deepseek/deepseek-v4-pro", "openrouter/moonshotai/kimi-k3"
 *   - "<provider>"                             -> provider's defaultModel
 *   - a comma-separated list of the above      -> ad-hoc fallback chain
 *
 * Resolution produces an ordered candidate list. The router tries each in
 * turn; a candidate is skipped/abandoned according to config.fallback.retryOn.
 */
import { chatCompletion, ProviderError, type ChatRequest, type ChatResponse } from "./client.js";
import { resolveProvider, tierFor, type GatewayConfig, type ResolvedProvider, type FallbackReason } from "./config.js";
import { log as rlog } from "./logger.js";
import { getBreaker } from "./breaker.js";
import { costUsd } from "./config.js";

export interface Candidate {
  spec: string;
  provider: ResolvedProvider;
  model: string;
}

export interface Attempt {
  spec: string;
  ok: boolean;
  reason?: FallbackReason;
  error?: string;
  ms: number;
}

export interface RouteResult {
  costUsd: number;
  priced: boolean;
  response: ChatResponse;
  used: Candidate;
  attempts: Attempt[];
}

export function parseSpec(config: GatewayConfig, spec: string): { provider: string; model: string } | undefined {
  const s = spec.trim();
  if (!s) return undefined;
  const slash = s.indexOf("/");
  const providerName = slash === -1 ? s : s.slice(0, slash);
  const prov = resolveProvider(config, providerName);
  if (!prov) return undefined;
  const model = slash === -1 ? prov.defaultModel : s.slice(slash + 1);
  return { provider: providerName, model };
}

export interface SkippedCandidate {
  spec: string;
  tier: number;
}

export interface ResolvedCandidates {
  candidates: Candidate[];
  skipped: SkippedCandidate[];
}

export function resolveCandidatesWithFloor(
  config: GatewayConfig,
  spec: string | undefined,
  opts: { useGlobalChain?: boolean; seen?: Set<string>; minTier?: number } = {},
): ResolvedCandidates {
  const seen = opts.seen ?? new Set<string>();
  const out: Candidate[] = [];
  const skipped: SkippedCandidate[] = [];
  const push = (s: string) => {
    const parsed = parseSpec(config, s);
    if (!parsed) return;
    const provider = resolveProvider(config, parsed.provider);
    // `decision` providers (TypeSafe/Jev) answer typed questions, not chat completions:
    // they must never appear in a delegate/run_plan candidate chain.
    if (!provider || provider.kind !== "chat") return;
    const key = `${parsed.provider}/${parsed.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    const tier = tierFor(config, parsed.provider, parsed.model);
    if (opts.minTier !== undefined && tier < opts.minTier) {
      skipped.push({ spec: key, tier });
      return;
    }
    out.push({ spec: key, provider, model: parsed.model });
  };
  const expand = (s: string, depth: number) => {
    if (depth > 5) return;
    for (const part of s.split(",").map((x) => x.trim()).filter(Boolean)) {
      const alias = config.aliases[part];
      if (alias) {
        const cands = Array.isArray(alias) ? alias : alias.candidates;
        for (const c of cands) expand(c, depth + 1);
      } else {
        push(part);
      }
    }
  };
  expand(spec ?? config.defaults.model, 0);
  if (config.fallback.enabled && opts.useGlobalChain !== false) {
    for (const c of config.fallback.chain) expand(c, 0);
  }
  if (opts.minTier !== undefined && out.length === 0 && skipped.length > 0) {
    throw new Error(
      `no candidate at or above tier ${opts.minTier} — skipped ${skipped.map((s) => `${s.spec} (tier ${s.tier})`).join(", ")}; raise min_tier, set allow_downgrade, or add a tier ${opts.minTier} provider`,
    );
  }
  return { candidates: out, skipped };
}

export function resolveCandidates(config: GatewayConfig, spec: string | undefined, opts: { useGlobalChain?: boolean; seen?: Set<string>; minTier?: number } = {}): Candidate[] {
  return resolveCandidatesWithFloor(config, spec, opts).candidates;
}

export interface ResolvedFloor {
  /** The floor passed to the router for filtering. `undefined` means no filtering (downgrading was allowed). */
  minTier: number | undefined;
  /** The floor used for honest downgrade reporting, regardless of allowDowngrade. */
  derivedTier: number | undefined;
  allowDowngrade: boolean;
}

/**
 * ONE place to resolve the effective tier floor for a delegated call.
 *   - allowDowngrade true (explicitly, or from config when the task did not opt out)
 *     disables filtering entirely.
 *   - otherwise the floor is the task's minTier, else config.fallback.minTier,
 *     else the tier of the model the caller asked for.
 */
export function resolveFloor(
  config: GatewayConfig,
  spec: string | undefined,
  opts: { minTier?: number; allowDowngrade?: boolean } = {},
): ResolvedFloor {
  const allowDowngrade = opts.allowDowngrade ?? config.fallback.allowDowngrade;
  const derivedTier = opts.minTier ?? config.fallback.minTier ?? deriveFloor(config, spec);
  return { minTier: allowDowngrade ? undefined : derivedTier, derivedTier, allowDowngrade };
}

/** Tier of a "provider/model" spec, or undefined when it cannot be parsed. */
export function tierOfSpec(config: GatewayConfig, spec: string | undefined): number | undefined {
  if (!spec) return undefined;
  const parsed = parseSpec(config, spec);
  return parsed ? tierFor(config, parsed.provider, parsed.model) : undefined;
}

/**
 * The tier of the first candidate a spec resolves to — the default floor for
 * "the model you asked for" when a task does not set one explicitly.
 */
export function deriveFloor(config: GatewayConfig, spec: string | undefined): number | undefined {
  const first = resolveCandidatesWithFloor(config, spec, { useGlobalChain: false }).candidates[0];
  return first ? tierFor(config, first.provider.name, first.model) : undefined;
}

export function aliasParams(config: GatewayConfig, spec: string | undefined): { temperature?: number; maxTokens?: number } {
  if (!spec) return {};
  const alias = config.aliases[spec.trim()];
  if (!alias || Array.isArray(alias)) return {};
  return { temperature: alias.temperature, maxTokens: alias.maxTokens };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT: FallbackReason[] = ["rate_limit", "server_error", "timeout", "network", "no_response"];

/**
 * Execute one chat completion across the candidate list with fallback.
 * `buildRequest` gets the model name so tool support etc. can be adapted.
 */
/** What the floor removed, so an exhausted chain never looks like a plain outage. */
function floorNote(minTier: number | undefined, skipped: SkippedCandidate[] | undefined): string {
  if (minTier === undefined || !skipped?.length) return "";
  return (
    `\n\nNot tried, below the tier ${minTier} floor: ` +
    skipped.map((s) => `${s.spec} (tier ${s.tier})`).join(", ") +
    `\nPass allow_downgrade:true to use them anyway, or min_tier to move the floor.`
  );
}

export async function routeChat(
  config: GatewayConfig,
  candidates: Candidate[],
  buildRequest: (c: Candidate) => ChatRequest,
  opts: { timeoutMs?: number; signal?: AbortSignal; log?: (s: string) => void; minTier?: number; skipped?: SkippedCandidate[] } = {},
): Promise<RouteResult> {
  if (!candidates.length) throw new Error("No usable model candidates. Check `list_models` / `list_providers`.");
  const attempts: Attempt[] = [];
  const log = opts.log ?? (() => {});
  const fb = config.fallback;

  const breaker = getBreaker(config);

  for (const cand of candidates) {
    // A provider known to be dead costs nothing to skip and a full timeout to try.
    const openUntil = breaker.openUntil(cand.provider.name);
    if (openUntil) {
      const secs = Math.max(1, Math.round((openUntil - Date.now()) / 1000));
      attempts.push({ spec: cand.spec, ok: false, reason: "circuit_open", error: `${cand.provider.name} circuit open for another ${secs}s after repeated timeouts`, ms: 0 });
      rlog("route.attempt", { spec: cand.spec, ok: false, reason: "circuit_open", ms: 0, skipped: true });
      log(`skip ${cand.spec}: circuit open for another ${secs}s`);
      continue; // never abort the chain over a provider we already know is dead
    }
    if (cand.provider.unusableReason) {
      attempts.push({ spec: cand.spec, ok: false, reason: cand.provider.requiresKey && !cand.provider.apiKey ? "no_key" : "bad_request", error: cand.provider.unusableReason, ms: 0 });
      rlog("route.attempt", { spec: cand.spec, ok: false, reason: attempts.at(-1)!.reason, error: cand.provider.unusableReason, ms: 0, skipped: true });
      if (!fb.enabled || !fb.retryOn.includes(attempts.at(-1)!.reason!)) break;
      log(`skip ${cand.spec}: ${cand.provider.unusableReason}`);
      continue;
    }
    const maxTries = 1 + fb.retriesPerCandidate;
    for (let t = 0; t < maxTries; t++) {
      const started = Date.now();
      try {
        const req = buildRequest(cand);
        const response = await chatCompletion(cand.provider, req, { timeoutMs: cand.provider.timeoutMs ?? opts.timeoutMs ?? config.defaults.timeoutMs, firstByteMs: cand.provider.firstByteMs ?? config.defaults.firstByteMs, bodyStallMs: cand.provider.bodyStallMs ?? config.defaults.bodyStallMs, signal: opts.signal });
        attempts.push({ spec: cand.spec, ok: true, ms: Date.now() - started });
        breaker.clear(cand.provider.name);
        const cost = costUsd(config, cand.provider.name, cand.model, response.usage);
        rlog("route.attempt", { spec: cand.spec, ok: true, ms: Date.now() - started, try: t + 1, usage: response.usage, finish: response.finishReason, cost_usd: cost.usd, priced: cost.priced });
        return { response, used: cand, attempts, costUsd: cost.usd, priced: cost.priced };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError("server_error", (e as Error).message, undefined, cand.provider.name, cand.model);
        attempts.push({ spec: cand.spec, ok: false, reason: err.reason, error: err.message, ms: Date.now() - started });
        log(`fail ${cand.spec}: [${err.reason}] ${err.message}`);
        rlog("route.attempt", { spec: cand.spec, ok: false, reason: err.reason, status: err.status, error: err.message.slice(0, 300), ms: Date.now() - started, try: t + 1 });
        if (opts.signal?.aborted) throw err;
        // Only host-level symptoms count as strikes: a 401 or an unknown model says
        // nothing about whether the host is answering.
        if (err.reason === "timeout" || err.reason === "network" || err.reason === "no_response") {
          if (breaker.record(cand.provider.name, err.message)) log(`circuit open: ${cand.provider.name} skipped for the next ${Math.round(config.fallback.breaker.cooldownMs / 1000)}s`);
        }
        const transient = TRANSIENT.includes(err.reason);
        // Retrying a candidate whose circuit just opened would pay its timeout twice
        // for evidence we already have.
        if (transient && t < maxTries - 1 && !breaker.openUntil(cand.provider.name)) {
          await sleep(fb.retryDelayMs * (t + 1));
          continue; // retry same candidate
        }
        if (!fb.enabled || !fb.retryOn.includes(err.reason)) {
          throw new Error(`${err.message}\n\nFallback not attempted (reason "${err.reason}" not in fallback.retryOn).\nAttempts: ${JSON.stringify(attempts)}`);
        }
        break; // next candidate
      }
    }
  }
  throw new Error(
    `All ${candidates.length} candidate(s) failed:\n` +
      attempts.map((a) => `  - ${a.spec}: [${a.reason}] ${a.error}`).join("\n") +
      floorNote(opts.minTier, opts.skipped),
  );
}

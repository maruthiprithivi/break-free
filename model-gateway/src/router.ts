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
import { resolveProvider, type GatewayConfig, type ResolvedProvider, type FallbackReason } from "./config.js";
import { log as rlog } from "./logger.js";
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

export function resolveCandidates(config: GatewayConfig, spec: string | undefined, opts: { useGlobalChain?: boolean; seen?: Set<string> } = {}): Candidate[] {
  const seen = opts.seen ?? new Set<string>();
  const out: Candidate[] = [];
  const push = (s: string) => {
    const parsed = parseSpec(config, s);
    if (!parsed) return;
    const key = `${parsed.provider}/${parsed.model}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ spec: key, provider: resolveProvider(config, parsed.provider)!, model: parsed.model });
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
  return out;
}

export function aliasParams(config: GatewayConfig, spec: string | undefined): { temperature?: number; maxTokens?: number } {
  if (!spec) return {};
  const alias = config.aliases[spec.trim()];
  if (!alias || Array.isArray(alias)) return {};
  return { temperature: alias.temperature, maxTokens: alias.maxTokens };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT: FallbackReason[] = ["rate_limit", "server_error", "timeout", "network"];

/**
 * Execute one chat completion across the candidate list with fallback.
 * `buildRequest` gets the model name so tool support etc. can be adapted.
 */
export async function routeChat(
  config: GatewayConfig,
  candidates: Candidate[],
  buildRequest: (c: Candidate) => ChatRequest,
  opts: { timeoutMs?: number; signal?: AbortSignal; log?: (s: string) => void } = {},
): Promise<RouteResult> {
  if (!candidates.length) throw new Error("No usable model candidates. Check `list_models` / `list_providers`.");
  const attempts: Attempt[] = [];
  const log = opts.log ?? (() => {});
  const fb = config.fallback;

  for (const cand of candidates) {
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
        const response = await chatCompletion(cand.provider, req, { timeoutMs: cand.provider.timeoutMs ?? opts.timeoutMs ?? config.defaults.timeoutMs, signal: opts.signal });
        attempts.push({ spec: cand.spec, ok: true, ms: Date.now() - started });
        const cost = costUsd(config, cand.provider.name, cand.model, response.usage);
        rlog("route.attempt", { spec: cand.spec, ok: true, ms: Date.now() - started, try: t + 1, usage: response.usage, finish: response.finishReason, cost_usd: cost.usd, priced: cost.priced });
        return { response, used: cand, attempts, costUsd: cost.usd, priced: cost.priced };
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError("server_error", (e as Error).message, undefined, cand.provider.name, cand.model);
        attempts.push({ spec: cand.spec, ok: false, reason: err.reason, error: err.message, ms: Date.now() - started });
        log(`fail ${cand.spec}: [${err.reason}] ${err.message}`);
        rlog("route.attempt", { spec: cand.spec, ok: false, reason: err.reason, status: err.status, error: err.message.slice(0, 300), ms: Date.now() - started, try: t + 1 });
        if (opts.signal?.aborted) throw err;
        const transient = TRANSIENT.includes(err.reason);
        if (transient && t < maxTries - 1) {
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
  throw new Error(`All ${candidates.length} candidate(s) failed:\n` + attempts.map((a) => `  - ${a.spec}: [${a.reason}] ${a.error}`).join("\n"));
}

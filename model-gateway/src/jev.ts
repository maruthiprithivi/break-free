/**
 * TypeSafe System One client (Jev).
 *
 * Jev is not a chat model. It evaluates typed *questions* against a *state* and returns
 * typed answers with probabilities and a confidence score — no text to parse, no rationale.
 * That is why it has its own client (client.ts speaks Chat Completions) and why it can never
 * be picked as a worker model: `resolveCandidates` skips `kind: "decision"` providers.
 *
 *   POST https://api.typesafe.ai/v1/systemone   { state, model, questions } -> { model, answers, usage }
 *   GET  https://api.typesafe.ai/v1/models
 *
 * Design constraints taken from the docs (docs.typesafe.ai):
 *   - Every question in one request is evaluated in parallel against the same state, so a
 *     whole plan is routed in ONE round trip; adding questions barely moves latency.
 *   - Jev does not count reliably and degrades with padded state: callers pre-bucket numbers
 *     and keep `state` small.
 *   - 429/529 are overload signals: back off exponentially and honour `retry-after`.
 *   - Output tokens are free; input is $0.042/Mtok.
 */
import type { GatewayConfig, ResolvedProvider } from "./config.js";
import { costUsd } from "./config.js";
import { log as rlog } from "./logger.js";

export type JevQuestion =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] }
  | { type: "noul"; instructions: unknown; criteria?: { true?: string; false?: string } };

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend?: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
/** A Noul answer carries no confidence of its own — only the probability that the answer is yes. */
export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}
export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer;

export interface JevUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface JevResult {
  /** The versioned id that actually answered (e.g. `jev-1.13.0`), not the alias we sent. */
  model: string;
  answers: Record<string, JevAnswer>;
  usage: JevUsage;
  ms: number;
  costUsd: number;
  priced: boolean;
  attempts: number;
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "JevError";
  }
}

/** 429 (rate limit) and 529 (overloaded) are the documented overload signals; 5xx/408 are transient too. */
const RETRYABLE_STATUS: Record<number, true> = { 408: true, 425: true, 429: true, 500: true, 502: true, 503: true, 504: true, 529: true };

export interface JevCallOptions {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  log?: (s: string) => void;
}

/**
 * Cheap deterministic token estimate (~4 chars/token, the standard English rule of thumb).
 * We only use it to keep `state` inside `routing.maxStateTokens`; it never gates correctness.
 */
export function estimateTokens(value: unknown): number {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return Math.ceil(s.length / 4);
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

/** Parse the documented 429/529 payload shape without assuming it exists. */
function errorText(status: number, body: string): string {
  const trimmed = body.slice(0, 400).replace(/\s+/g, " ").trim();
  return `TypeSafe ${status}${trimmed ? `: ${trimmed}` : ""}`;
}

/**
 * Evaluate `questions` against `state` in one request.
 * Retries transient failures; anything else (401/422, malformed body) throws immediately
 * so the caller can degrade to the rules engine rather than stall the plan.
 */
export async function systemOne(
  config: GatewayConfig,
  provider: ResolvedProvider,
  body: { state: unknown; model: string; questions: Record<string, JevQuestion> },
  opts: JevCallOptions = {},
): Promise<JevResult> {
  if (provider.unusableReason) throw new JevError(`TypeSafe provider unusable: ${provider.unusableReason}`);
  const timeoutMs = opts.timeoutMs ?? provider.timeoutMs ?? config.routing.timeoutMs;
  const retries = opts.retries ?? config.routing.retries;
  const baseDelay = opts.retryDelayMs ?? config.routing.retryDelayMs;
  const log = opts.log ?? (() => {});
  const url = `${provider.baseUrl}/systemone`;
  const calledAt = Date.now();
  let lastError: JevError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`TypeSafe request timed out after ${timeoutMs}ms`)), timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, ac.signal]) : ac.signal;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
          ...provider.headers,
        },
        body: JSON.stringify({ ...body, model: body.model }),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const retryable = RETRYABLE_STATUS[res.status] === true;
        lastError = new JevError(errorText(res.status, text), res.status, retryable);
        if (!retryable || attempt === retries) throw lastError;
        const wait = retryAfterMs(res) ?? baseDelay * 2 ** attempt;
        log(`route.decision retry ${attempt + 1}/${retries} after ${res.status} (waiting ${wait}ms)`);
        if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
        continue;
      }
      const json = (await res.json()) as { model?: unknown; answers?: unknown; usage?: unknown };
      const answers = json.answers;
      if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
        throw new JevError("TypeSafe returned no `answers` object");
      }
      const usage: JevUsage = {
        input_tokens: Number((json.usage as JevUsage | undefined)?.input_tokens ?? 0) || 0,
        output_tokens: Number((json.usage as JevUsage | undefined)?.output_tokens ?? 0) || 0,
      };
      const { usd, priced } = costUsd(config, provider.name, provider.defaultModel, {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
      });
      const ms = Date.now() - calledAt;
      const result: JevResult = {
        model: String(json.model ?? body.model),
        answers: answers as Record<string, JevAnswer>,
        usage,
        ms,
        costUsd: usd,
        priced,
        attempts: attempt + 1,
      };
      rlog("route.decision", { spec: `${provider.name}/${provider.defaultModel}`, answered_by: result.model, ok: true, ms, usage, cost_usd: usd, priced, questions: Object.keys(body.questions).length, attempts: result.attempts });
      return result;
    } catch (e) {
      const err = e instanceof JevError ? e : new JevError((e as Error).message, undefined, true);
      lastError = err;
      const aborted = opts.signal?.aborted;
      if (aborted) throw err;
      const retryable = err.retryable || err.status === undefined;
      if (!retryable || attempt === retries) throw err;
      const wait = baseDelay * 2 ** attempt;
      log(`route.decision retry ${attempt + 1}/${retries} after ${err.message} (waiting ${wait}ms)`);
      if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new JevError("TypeSafe request failed");
}

/** GET /v1/models — the ids/aliases this account may send. */
export async function listModels(provider: ResolvedProvider, timeoutMs = 15_000): Promise<string[]> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${provider.baseUrl}/models`, {
      headers: { ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}), ...provider.headers },
      signal: ac.signal,
    });
    if (!res.ok) throw new JevError(errorText(res.status, await res.text().catch(() => "")));
    const json = (await res.json()) as { models?: { name?: unknown }[] } | { data?: { id?: unknown }[] };
    const list = (json as { models?: { name?: unknown }[] }).models ?? (json as { data?: { id?: unknown }[] }).data ?? [];
    return list.map((m) => String((m as { name?: unknown; id?: unknown }).name ?? (m as { id?: unknown }).id ?? "")).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

/** Round-trip probe used by `test_provider`: one trivially-answerable Noul question. */
export async function probe(provider: ResolvedProvider, opts: JevCallOptions = {}): Promise<{ ok: boolean; model?: string; ms: number; error?: string }> {
  const started = Date.now();
  try {
    const res = await fetch(`${provider.baseUrl}/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}), ...provider.headers },
      body: JSON.stringify({ state: "The sky is blue.", model: provider.defaultModel, questions: { probe: { type: "noul", instructions: "Is the sky blue?" } } }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    if (!res.ok) return { ok: false, ms: Date.now() - started, error: errorText(res.status, await res.text().catch(() => "")) };
    const json = (await res.json()) as { model?: unknown };
    return { ok: true, model: String(json.model ?? provider.defaultModel), ms: Date.now() - started };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: (e as Error).message };
  }
}

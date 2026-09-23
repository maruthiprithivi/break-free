/**
 * Minimal OpenAI-compatible Chat Completions client using native fetch.
 * Classifies failures so the router can decide whether to fall back.
 */
import type { ResolvedProvider } from "./config.js";
import type { FallbackReason } from "./config.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResponse {
  message: ChatMessage;
  finishReason: string;
  usage?: ChatUsage;
  raw?: unknown;
}

export class ProviderError extends Error {
  constructor(
    public readonly reason: FallbackReason,
    message: string,
    public readonly status?: number,
    public readonly provider?: string,
    public readonly model?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export function classifyStatus(status: number, body: string): FallbackReason {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429 || status === 402) return "rate_limit";
  if (status >= 500) return "server_error";
  if (status === 408) return "timeout";
  if (/model.*(not|does not) (exist|found)|unknown model|no such model|not found/i.test(body)) return "not_found";
  return "bad_request";
}

export async function chatCompletion(
  provider: ResolvedProvider,
  req: ChatRequest,
  opts: { timeoutMs: number; firstByteMs?: number; bodyStallMs?: number; signal?: AbortSignal; extraBody?: Record<string, unknown> } ,
): Promise<ChatResponse> {
  if (provider.unusableReason) {
    throw new ProviderError(provider.requiresKey && !provider.apiKey ? "no_key" : "bad_request", `${provider.name}: ${provider.unusableReason}`, undefined, provider.name, req.model);
  }
  const url = `${provider.baseUrl}/chat/completions`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...provider.headers,
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  else if (!provider.requiresKey) headers.authorization = "Bearer local";

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: false,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
    ...(req.tools && req.tools.length ? { tools: req.tools, tool_choice: "auto" } : {}),
    ...(req.response_format ? { response_format: req.response_format } : {}),
    ...(provider.extraBody ?? {}),
    ...(opts.extraBody ?? {}),
  };

  if (opts.signal?.aborted) throw new ProviderError("network", `${provider.name}/${req.model}: aborted before request`, undefined, provider.name, req.model);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), opts.timeoutMs);
  // A separate, much shorter deadline for RESPONSE HEADERS. `await fetch` resolves when they
  // arrive, so clearing this there measures exactly time-to-first-byte — which is what tells a
  // model generating slowly apart from a host that has stopped talking. Without it both look
  // identical and both cost the full timeout.
  let headersSeen = false;
  const firstByteMs = opts.firstByteMs ?? 0;
  const fbTimer = firstByteMs > 0
    ? setTimeout(() => { if (!headersSeen) ctrl.abort(new Error("no_response")); }, firstByteMs)
    : undefined;
  const onOuterAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });

  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
    headersSeen = true;
    if (fbTimer) clearTimeout(fbTimer);
    // The total timer stays armed throughout; this adds the per-gap one. res.text() would read
    // to completion with no way to notice a host that stops halfway, so the body is drained a
    // chunk at a time instead and the stall deadline is rearmed on each one.
    text = await readBody(res, ctrl, opts.bodyStallMs ?? 0);
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const why = String(ctrl.signal.reason?.message ?? ctrl.signal.reason);
    const noResponse = ctrl.signal.aborted && why.includes("no_response");
    const bodyStall = ctrl.signal.aborted && why.includes("body_stall");
    const isTimeout = ctrl.signal.aborted && why.includes("timeout");
    // Named separately so the difference survives into the report and the circuit breaker: a
    // host that sent nothing at all is stronger evidence than one that was merely slow.
    const message = noResponse
      ? `sent no response headers within ${firstByteMs}ms — the host accepted the connection and then said nothing. Raise providers.${provider.name}.firstByteMs if it buffers headers until the body is ready.`
      : bodyStall
        ? `started answering, then sent nothing for ${opts.bodyStallMs}ms — the host is still connected but has stopped producing. Raise providers.${provider.name}.bodyStallMs if it pauses mid-answer.`
        : isTimeout ? `timed out after ${opts.timeoutMs}ms` : `${err.message}${err.cause?.code ? ` (${err.cause.code})` : ""}`;
    throw new ProviderError(noResponse ? "no_response" : bodyStall ? "body_stall" : isTimeout ? "timeout" : "network", `${provider.name}/${req.model}: ${message}`, undefined, provider.name, req.model);
  } finally {
    clearTimeout(timer);
    if (fbTimer) clearTimeout(fbTimer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }

  if (!res.ok) {
    const reason = classifyStatus(res.status, text);
    throw new ProviderError(reason, `${provider.name}/${req.model}: HTTP ${res.status} ${text.slice(0, 600)}`, res.status, provider.name, req.model);
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError("server_error", `${provider.name}/${req.model}: non-JSON response: ${text.slice(0, 300)}`, res.status, provider.name, req.model);
  }
  const choice = json?.choices?.[0];
  if (!choice) {
    // Some providers return {error:{...}} with 200
    const msg = String(json?.error?.message ?? json?.message ?? text.slice(0, 300));
    const code = String(json?.error?.code ?? json?.error?.type ?? "");
    const status = /invalid_api_key|authentication|unauthorized/i.test(code + msg) ? 401 : /rate|quota|insufficient/i.test(code + msg) ? 429 : 400;
    throw new ProviderError(classifyStatus(status, msg), `${provider.name}/${req.model}: ${msg}`, res.status, provider.name, req.model);
  }
  const m = choice.message ?? {};
  const message: ChatMessage = {
    role: "assistant",
    content: typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? "").join("") : null,
    tool_calls: Array.isArray(m.tool_calls) && m.tool_calls.length ? m.tool_calls : undefined,
  };
  return { message, finishReason: choice.finish_reason ?? "stop", usage: json.usage, raw: json };
}

/**
 * Drain a response body, watching the gap between chunks rather than the total.
 *
 * A host that sends headers and half a token and then goes quiet used to be caught only by the
 * total timeout, minutes later, having produced nothing usable. The deadline here is per gap
 * and rearmed on every chunk, so a model that generates slowly but keeps emitting is never
 * touched however long its whole answer takes — only silence is punished, not slowness.
 *
 * With no body to stream (a mocked or already-buffered response) or no deadline set, this is
 * res.text() and nothing changes.
 */
async function readBody(res: Response, ctrl: AbortController, stallMs: number): Promise<string> {
  if (stallMs <= 0 || !res.body) return await res.text();

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(new Error("body_stall")), stallMs);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
      arm(); // progress, whatever its size, is the thing being measured
    }
  } finally {
    if (timer) clearTimeout(timer);
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

/** GET /models — used by list_models(live) and probes. */
export async function listRemoteModels(provider: ResolvedProvider, timeoutMs = 15_000): Promise<string[]> {
  const headers: Record<string, string> = { accept: "application/json", ...provider.headers };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${provider.baseUrl}/models`, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new ProviderError(classifyStatus(res.status, text), `HTTP ${res.status} ${text.slice(0, 200)}`, res.status, provider.name);
    const json = JSON.parse(text);
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return data.map((d: any) => d.id ?? d.name ?? d.model).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

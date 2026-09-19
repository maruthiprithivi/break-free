/**
 * Worker loop: run a model against a task with (optionally) workspace/git/
 * GitHub tools until it stops calling tools or the iteration budget is spent.
 * Every call goes through the fallback router.
 */
import type { ChatMessage, ChatRequest, ToolCall } from "./client.js";
import type { GatewayConfig } from "./config.js";
import { aliasParams, resolveCandidatesWithFloor, routeChat, tierOfSpec, type Attempt, type Candidate } from "./router.js";
import { githubTools } from "./github.js";
import { Workspace, type Capability, type WorkerTool } from "./workspace.js";
import { log as rlog } from "./logger.js";
import { runTool } from "./runcmd.js";

export type TaskShape = "ship" | "scout";

/** Resolve the effective capabilities for a task shape. A scout is always read-only. */
export function resolveCapabilities(shape: TaskShape | undefined, capabilities: Capability[] | undefined): Capability[] {
  return shape === "scout" ? ["read"] : [...(capabilities ?? ["read"])];
}

export interface RouteNotice {
  requested: string;
  used: string;
  reason?: string;
  requestedTier?: number;
  usedTier?: number;
  downgraded: boolean;
}

export interface RunOptions {
  model?: string;
  system: string;
  messages: ChatMessage[]; // prior history + new user turn
  capabilities: Capability[];
  temperature?: number;
  maxTokens?: number;
  maxIterations?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  workspace?: Workspace;
  /** Extra tools (e.g. bridged MCP tools) appended to the capability-selected set */
  extraTools?: WorkerTool[];
  /** USD cap for this worker run (default config.budget.perTaskUsd; 0 = unlimited) */
  budgetUsd?: number;
  log?: (s: string) => void;
  /** Competence floor for the router: candidates below it are excluded before any call is made. */
  minTier?: number;
  /** Reporting floor used to detect a downward tier crossing (differs from minTier only when downgrading is allowed). */
  derivedTier?: number;
  /** The model spec the caller asked for (for route reporting). */
  requestedModel?: string;
  /** Whether downgrading was allowed (used for the route reason when no failure occurred). */
  allowDowngrade?: boolean;
  /** Called once, the moment the first candidate answers, with route/downgrade metadata. */
  onRoute?: (notice: RouteNotice) => void;
}

export class BudgetExceeded extends Error {
  constructor(public readonly scope: string, public readonly spent: number, public readonly cap: number) {
    super(`budget exceeded: ${scope} spent $${spent.toFixed(4)} of $${cap.toFixed(2)} cap — stopped; raise budget.${scope === "task" ? "perTaskUsd" : scope === "plan" ? "perPlanUsd" : "perDayUsd"} or use a cheaper model`);
  }
}

export interface RunResult {
  text: string;
  messages: ChatMessage[]; // full appended transcript (without system)
  usedModel: string; // provider/model actually used for the final answer
  modelsUsed: string[];
  attempts: Attempt[];
  toolCalls: { name: string; args: string; ok: boolean; ms: number }[];
  iterations: number;
  usage: { prompt: number; completion: number };
  costUsd: number;
  unpriced: boolean;
  truncated: boolean;
}

export function selectTools(config: GatewayConfig, ws: Workspace | undefined, caps: Capability[]): WorkerTool[] {
  if (!ws || !caps.length) return [];
  const want = new Set<Capability>(caps);
  if (want.has("github")) want.add("git");
  if (want.has("git")) want.add("write"); // committing without writing is pointless
  if (want.size) want.add("read");
  const all = [...ws.tools(), ...(want.has("github") ? githubTools(config, ws) : []), ...(want.has("run") ? [runTool(config, ws.root)] : [])];
  return all.filter((t) => want.has(t.capability));
}

export async function runWorker(config: GatewayConfig, opts: RunOptions): Promise<RunResult> {
  const { candidates, skipped } = resolveCandidatesWithFloor(config, opts.model, { minTier: opts.minTier });
  const ap = aliasParams(config, opts.model);
  const tools = [...selectTools(config, opts.workspace, opts.capabilities), ...(opts.extraTools ?? [])];
  const byName = new Map(tools.map((t) => [t.spec.function.name, t]));
  const transcript: ChatMessage[] = [...opts.messages];
  const attempts: Attempt[] = [];
  const toolCalls: RunResult["toolCalls"] = [];
  const modelsUsed = new Set<string>();
  const usage = { prompt: 0, completion: 0 };
  let costUsd = 0;
  let unpriced = false;
  const cap = opts.budgetUsd ?? config.budget.perTaskUsd;
  const maxIter = opts.maxIterations ?? config.defaults.maxToolIterations;
  let used: Candidate | undefined;
  let text = "";
  let truncated = false;
  let iterations = 0;

  // Once a candidate answered, stick to it for the rest of the loop (tool-call ids are per-provider).
  let pinned: Candidate[] | undefined;

  for (iterations = 1; iterations <= maxIter; iterations++) {
    if (opts.signal?.aborted) throw new Error("cancelled");
    const build = (c: Candidate): ChatRequest => ({
      model: c.model,
      messages: [{ role: "system", content: opts.system }, ...transcript],
      tools: tools.length && c.provider.supportsTools ? tools.map((t) => t.spec) : undefined,
      temperature: opts.temperature ?? ap.temperature ?? config.defaults.temperature,
      max_tokens: opts.maxTokens ?? ap.maxTokens ?? config.defaults.maxTokens,
      response_format: opts.jsonMode && !tools.length ? { type: "json_object" } : undefined,
    });
    const r = await routeChat(config, pinned ?? candidates, build, { signal: opts.signal, log: opts.log, minTier: opts.minTier, skipped });
    attempts.push(...r.attempts);
    used = r.used;
    if (!pinned && opts.onRoute) {
      const usedTier = tierOfSpec(config, r.used.spec);
      const downgraded = opts.derivedTier !== undefined && usedTier !== undefined && usedTier < opts.derivedTier;
      opts.onRoute({
        requested: opts.requestedModel ?? opts.model ?? config.defaults.model,
        used: r.used.spec,
        reason: r.attempts.filter((a) => !a.ok).at(-1)?.reason ?? (opts.allowDowngrade ? "allow_downgrade" : undefined),
        requestedTier: opts.derivedTier,
        usedTier,
        downgraded,
      });
    }
    // Pin to the provider that answered: tool_call ids and tool-message semantics are provider-specific,
    // so a mid-loop switch would replay a foreign transcript. Fallback happens only before the first answer.
    pinned = [r.used];
    modelsUsed.add(r.used.spec);
    usage.prompt += r.response.usage?.prompt_tokens ?? 0;
    usage.completion += r.response.usage?.completion_tokens ?? 0;
    costUsd += r.costUsd;
    if (!r.priced) unpriced = true;
    if (cap > 0 && costUsd > cap) throw new BudgetExceeded("task", costUsd, cap);

    const msg = r.response.message;
    transcript.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    if (!msg.tool_calls?.length) {
      text = msg.content ?? "";
      if (r.response.finishReason === "length") truncated = true;
      break;
    }
    // Normalise tool calls: some providers send arguments as an object, omit ids, etc.
    const calls: ToolCall[] = (msg.tool_calls as unknown[]).map((raw, i) => {
      const c = (raw ?? {}) as { id?: string; function?: { name?: string; arguments?: unknown } };
      const argsRaw = c.function?.arguments;
      const args = typeof argsRaw === "string" ? argsRaw : JSON.stringify(argsRaw ?? {});
      return { id: c.id ?? `call_${iterations}_${i}`, type: "function", function: { name: String(c.function?.name ?? ""), arguments: args } };
    });
    transcript[transcript.length - 1].tool_calls = calls;
    for (const call of calls) {
      const started = Date.now();
      const tool = byName.get(call.function.name);
      let out: string;
      let ok = true;
      try {
        if (!tool) throw new Error(`unknown tool ${call.function.name}`);
        let args: unknown = {};
        try {
          args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          throw new Error(`arguments are not valid JSON: ${call.function.arguments.slice(0, 200)}`);
        }
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be a JSON object");
        out = await tool.run(args as Record<string, unknown>);
      } catch (e) {
        ok = false;
        out = `ERROR: ${(e as Error).message}`;
      }
      toolCalls.push({ name: call.function.name, args: call.function.arguments.slice(0, 300), ok, ms: Date.now() - started });
      rlog("worker.tool", { name: call.function.name, args: call.function.arguments.slice(0, 200), ok, ms: Date.now() - started, model: used?.spec, ...(ok ? {} : { error: out.slice(0, 200) }) });
      opts.log?.(`tool ${call.function.name}(${call.function.arguments.slice(0, 120)}) -> ${ok ? "ok" : "error"} ${out.length}B`);
      transcript.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: out.slice(0, config.workspace.maxFileBytes) });
    }
    if (iterations === maxIter) {
      truncated = true;
      // Ask for a final answer without tools.
      const final = await routeChat(config, pinned, (c) => ({ ...build(c), tools: undefined, messages: [{ role: "system", content: opts.system }, ...transcript, { role: "user", content: "Tool budget exhausted. Give your final answer now using what you have." }] }), { signal: opts.signal });
      text = final.response.message.content ?? "";
      costUsd += final.costUsd;
      transcript.push({ role: "assistant", content: text });
    }
  }
  return { text, messages: transcript, usedModel: used?.spec ?? "(none)", modelsUsed: [...modelsUsed], attempts, toolCalls, iterations, usage, costUsd: Math.round(costUsd * 1e6) / 1e6, unpriced, truncated };
}

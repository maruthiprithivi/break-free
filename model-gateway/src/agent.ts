/**
 * Worker loop: run a model against a task with (optionally) workspace/git/
 * GitHub tools until it stops calling tools or the iteration budget is spent.
 * Every call goes through the fallback router.
 */
import type { ChatMessage, ChatRequest, ToolCall } from "./client.js";
import type { GatewayConfig } from "./config.js";
import { aliasParams, resolveCandidatesWithFloor, routeChat, tierOfSpec, type Attempt, type Candidate, type RouteResult } from "./router.js";
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

/**
 * Phase 3 — hand over a brief, not a transcript.
 *
 * Substituting a model mid-task by replaying the conversation into it hands it a transcript built
 * for a different context window, in a different tool-calling dialect — and the files already
 * written are not in the transcript at all. So a substitution hands over the TASK instead.
 */
export interface TaskCheckpoint {
  /** The model the task was going to run on (the first candidate of the resolved chain). */
  from: string;
  /** The model taking it over. */
  to: string;
  reason?: string;
  /** What the task is. Defaults to the last user message when the caller has nothing better. */
  instruction?: string;
  acceptance?: string;
  /** Paths already changed in the workspace, from the tree snapshot the policy review uses. */
  filesTouched: string[];
  lastVerify?: { command: string; ok: boolean; exit: number | null; output?: string };
  /** Transcript messages dropped rather than replayed into a foreign context window. */
  droppedMessages: number;
}

export interface HandoverBrief {
  text: string;
  /** Estimated tokens. The cap is expressed in these, so it can be checked against a window. */
  tokens: number;
  truncated: boolean;
  sectionsDropped: string[];
}

/** What the caller supplies to `checkpoint`: what it knows about the task that the worker does not. */
export interface HandoverCheckpoint {
  instruction?: string;
  acceptance?: string;
  filesTouched?: string[];
  lastVerify?: TaskCheckpoint["lastVerify"];
}

/** What was handed over, as published in `meta` and journalled to the ledger. */
export interface HandoverRecord {
  from: string;
  to: string;
  reason?: string;
  context_tokens: number;
  brief_tokens: number;
  brief_chars: number;
  truncated: boolean;
  sections_dropped: string[];
  dropped_messages: number;
  files_touched: string[];
  at: string;
}

/** A provider with no declared window still gets a sane one: the brief makes room, it does not guess. */
export const DEFAULT_CONTEXT_TOKENS = 8192;
/** The brief replaces the transcript, but the worker still needs room for its own turns. */
const HANDOVER_CONTEXT_SHARE = 0.5;
/** Deliberately rough: an estimate only has to be the right order of magnitude to bound a brief. */
const CHARS_PER_TOKEN = 4;

/**
 * Render the checkpoint as the compact brief a substitute starts from, never longer than
 * `contextTokens` allows. The header and the files-touched list are mandatory — a brief that
 * omits what has already been written is the failure this exists to prevent — and the rest is
 * cut from the end of the instruction, acceptance criteria and verification output in that order.
 */
export function buildHandoverBrief(cp: TaskCheckpoint, contextTokens: number): HandoverBrief {
  const budget = Math.max(1, Math.floor(contextTokens * HANDOVER_CONTEXT_SHARE)) * CHARS_PER_TOKEN;
  const dropped: string[] = [];
  const files = ["### Files already touched", ...(cp.filesTouched.length ? cp.filesTouched.map((f) => `- ${f}`) : ["- (nothing yet)"])].join("\n");
  const head =
    "## Handover brief\n\n" +
    `This task is being handed from \`${cp.from}\` to \`${cp.to}\`${cp.reason ? ` after \`${cp.reason}\` failed` : ""}. ` +
    "The previous transcript is NOT replayed: it was built for another context window and another tool-calling dialect. " +
    "Work from this brief." +
    (cp.droppedMessages ? ` ${cp.droppedMessages} earlier message(s) were dropped.` : "");
  const fixed = `${head}\n\n${files}\n`;
  let text = fixed;
  if (fixed.length >= budget) {
    // Only a window too small for the header itself gets here, and the cap is still the cap.
    dropped.push("instruction", "acceptance criteria", "last verification");
  } else {
    let left = budget - fixed.length;
    const parts: string[] = [];
    const take = (name: string, body: string | undefined): void => {
      if (!body?.trim()) return;
      if (left < 140) {
        dropped.push(name);
        return;
      }
      const block = `\n### ${name}\n${body.trim()}\n`;
      if (block.length <= left) {
        parts.push(block);
        left -= block.length;
        return;
      }
      parts.push(`${block.slice(0, left - 2)}…\n`);
      dropped.push(`${name} (truncated)`);
      left = 0;
    };
    take("Instruction", cp.instruction);
    take("Acceptance criteria", cp.acceptance);
    if (cp.lastVerify) {
      const out = (cp.lastVerify.output ?? "").trim();
      // The tail of a failing run is the part worth handing over.
      take(
        "Last verification",
        `\`${cp.lastVerify.command}\` ${cp.lastVerify.ok ? "PASSED" : "FAILED"} (exit ${cp.lastVerify.exit ?? "?"})\n${out.length > 600 ? `…\n${out.slice(-600)}` : out}`,
      );
    }
    text = `${fixed}${parts.join("")}`;
  }
  // Belt and braces: the per-section accounting above is approximate, this is the guarantee.
  const brief = text.trimEnd();
  const capped = brief.length > budget ? brief.slice(0, budget).trimEnd() : brief;
  if (capped.length < brief.length) dropped.push("(hard cap)");
  return { text: capped, tokens: Math.ceil(capped.length / CHARS_PER_TOKEN), truncated: dropped.length > 0, sectionsDropped: dropped };
}

/**
 * A worker that has made no tool call for `workers.stallAbortMs`. This is deliberately not a
 * `ProviderError`: a stalled task is neither a slow model nor a failed verification, and the
 * caller has to be able to tell the three apart.
 */
export class StalledError extends Error {
  constructor(
    readonly msSinceToolCall: number,
    readonly toolCalls: number,
    readonly filesWritten: number,
    readonly limitMs: number,
  ) {
    super(
      `stalled: no tool call for ${msSinceToolCall}ms (${toolCalls} tool call(s), ${filesWritten} file(s) written) — aborted by workers.stallAbortMs (${limitMs}ms); raise it, or set it to 0 to disable, if the task legitimately works that long without touching the workspace`,
    );
    this.name = "StalledError";
  }
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
  /**
   * Phase 3: the task checkpoint a substituted model is handed instead of the transcript. Read
   * once, before the first request — the router decides the substitution inside the call, so the
   * brief has to exist before any candidate is tried.
   */
  checkpoint?: () => HandoverCheckpoint;
  /** Called once per model substitution, with what was handed over (for `meta` and the ledger). */
  onHandover?: (record: HandoverRecord) => void;
  /** Progress line for a stall warning (no `log`-only: the operator watching a long task needs to see it). */
  onStall?: (line: string) => void;
  /** Override `workers.stallWarnMs` for this run. */
  stallWarnMs?: number;
  /** Override `workers.stallAbortMs` for this run. */
  stallAbortMs?: number;
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
  /** Distinct paths the workspace write tools wrote or edited. Other capabilities (`run`, mcp) can
   *  write too, and this does not see that — it counts what the worker's own tool calls name. */
  filesWritten: string[];
  /** Epoch ms of the last tool call, or null when the worker never made one. */
  lastToolCallAt: number | null;
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
  // What the model sees. Normally the transcript itself; a substitution replaces it with a brief
  // (phase 3), and the run's own new turns are then appended to both.
  let history: ChatMessage[] = transcript;
  const pushMsg = (m: ChatMessage) => {
    transcript.push(m);
    if (history !== transcript) history.push(m);
  };
  const attempts: Attempt[] = [];
  const toolCalls: RunResult["toolCalls"] = [];
  const filesWritten = new Set<string>();
  let lastToolCallAt: number | null = null;
  const startedAt = Date.now();
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
  let writesWarned = false;

  // Once a candidate answered, stick to it for the rest of the loop (tool-call ids are per-provider).
  let pinned: Candidate[] | undefined;

  // ---- liveness (phase 2)
  // A worker that reads for thirty minutes and writes nothing looks identical to one making
  // progress, because nothing measures observable work. A tool call is the only evidence there
  // is, so the clock measures the silence between tool calls, not the run.
  const warnMs = opts.stallWarnMs ?? config.workers.stallWarnMs;
  const abortMs = opts.stallAbortMs ?? config.workers.stallAbortMs;
  const warnIterations = config.workers.stallWarnIterations;
  const writeCapable = opts.capabilities.some((c) => c !== "read");
  const stallCtl = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stallCtl.signal]) : stallCtl.signal;
  let warnTimer: NodeJS.Timeout | undefined;
  let abortTimer: NodeJS.Timeout | undefined;
  const stallStats = () => ({ ms_since_tool_call: Date.now() - (lastToolCallAt ?? startedAt), tool_calls: toolCalls.length, files_written: filesWritten.size });
  /**
   * Arm the watchdog for the time that is left since the last tool activity — not for a fresh
   * interval, so a long-running tool call cannot earn itself a second full window. Called from
   * every point that marks activity, and once before the loop.
   */
  const armStall = () => {
    clearTimeout(warnTimer);
    clearTimeout(abortTimer);
    const left = (limit: number) => Math.max(1, limit - (Date.now() - (lastToolCallAt ?? startedAt)));
    if (warnMs > 0) {
      const warn = () => {
        const stats = stallStats();
        rlog("worker.stall", { reason: "idle", ...stats, model: used?.spec });
        opts.onStall?.(`stall: no tool call for ${stats.ms_since_tool_call}ms (${stats.tool_calls} tool call(s) so far)`);
        // Keep repeating it: a long silence must not go quiet after one line.
        warnTimer = setTimeout(warn, warnMs);
        warnTimer.unref();
      };
      warnTimer = setTimeout(warn, left(warnMs));
      warnTimer.unref();
    }
    if (abortMs > 0) {
      abortTimer = setTimeout(() => {
        abortTimer = undefined;
        const stats = stallStats();
        rlog("worker.stall", { reason: "abort", limit_ms: abortMs, ...stats, model: used?.spec });
        stallCtl.abort(new StalledError(stats.ms_since_tool_call, stats.tool_calls, stats.files_written, abortMs));
      }, left(abortMs));
      abortTimer.unref();
    }
  };

  /**
   * Phase 3: the checkpoint is read once, before the first request.
   *
   * The router picks a candidate *inside* the call, so by the time we learn that a different model
   * answered, that model has already been sent the transcript. A brief built at that point would
   * only reach a substitute that made a tool call and came back for a second turn — and the case
   * this phase exists for is the substitute that answers once and stops. So the brief is prepared
   * up front and handed to every candidate but the first.
   */
  const checkpoint = opts.checkpoint && candidates.length > 1 ? opts.checkpoint() : undefined;
  const intended = candidates[0]?.spec;
  const briefs = new Map<string, HandoverBrief>();
  const briefFor = (c: Candidate): HandoverBrief | undefined => {
    if (!checkpoint || !intended || c.spec === intended) return undefined;
    let brief = briefs.get(c.spec);
    if (!brief) {
      brief = buildHandoverBrief(
        {
          from: intended,
          to: c.spec,
          instruction: checkpoint.instruction ?? lastUserContent(opts.messages),
          acceptance: checkpoint.acceptance,
          filesTouched: checkpoint.filesTouched ?? [],
          lastVerify: checkpoint.lastVerify,
          droppedMessages: Math.max(0, transcript.length - 1),
        },
        config.providers[c.provider.name]?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
      );
      briefs.set(c.spec, brief);
    }
    return brief;
  };

  try {
    armStall();
    for (iterations = 1; iterations <= maxIter; iterations++) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      const build = (c: Candidate): ChatRequest => {
        const brief = briefFor(c);
        return {
          model: c.model,
          messages: [{ role: "system", content: opts.system }, ...(brief ? [{ role: "user" as const, content: brief.text }] : history)],
          tools: tools.length && c.provider.supportsTools ? tools.map((t) => t.spec) : undefined,
          temperature: opts.temperature ?? ap.temperature ?? config.defaults.temperature,
          max_tokens: opts.maxTokens ?? ap.maxTokens ?? config.defaults.maxTokens,
          response_format: opts.jsonMode && !tools.length ? { type: "json_object" } : undefined,
        };
      };
      let r: RouteResult;
      try {
        r = await routeChat(config, pinned ?? candidates, build, { signal, log: opts.log, minTier: opts.minTier, skipped });
      } catch (e) {
        // The watchdog fired while we were waiting: this run died of silence, which is a different
        // fact from a slow provider and must not be reported as one.
        if (stallCtl.signal.aborted && stallCtl.signal.reason instanceof StalledError) throw stallCtl.signal.reason;
        throw e;
      }
      attempts.push(...r.attempts);
      used = r.used;
      const reason = r.attempts.filter((a) => !a.ok).at(-1)?.reason;
      if (!pinned && opts.onRoute) {
        const usedTier = tierOfSpec(config, r.used.spec);
        const downgraded = opts.derivedTier !== undefined && usedTier !== undefined && usedTier < opts.derivedTier;
        opts.onRoute({
          requested: opts.requestedModel ?? opts.model ?? config.defaults.model,
          used: r.used.spec,
          reason: reason ?? (opts.allowDowngrade ? "allow_downgrade" : undefined),
          requestedTier: opts.derivedTier,
          usedTier,
          downgraded,
        });
      }
      // ---- handover (phase 3)
      // A different model is running this task from here on. It keeps the brief it was given; the
      // transcript stays behind, because it was built for another context window and another
      // tool-calling dialect, and it does not contain the files already written.
      const brief = !pinned ? briefFor(r.used) : undefined;
      if (brief) {
        const record: HandoverRecord = {
          from: intended!,
          to: r.used.spec,
          reason,
          context_tokens: config.providers[r.used.provider.name]?.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
          brief_tokens: brief.tokens,
          brief_chars: brief.text.length,
          truncated: brief.truncated,
          sections_dropped: brief.sectionsDropped,
          dropped_messages: Math.max(0, transcript.length - 1),
          files_touched: checkpoint?.filesTouched ?? [],
          at: new Date().toISOString(),
        };
        rlog("worker.handover", { ...record });
        history = [{ role: "user", content: brief.text }];
        opts.onHandover?.(record);
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
      pushMsg({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
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
      history[history.length - 1].tool_calls = calls;
      for (const call of calls) {
        const started = Date.now();
        // A tool call is activity from the moment it starts to the moment it ends, so a command
        // that runs for minutes is work rather than silence.
        lastToolCallAt = started;
        armStall();
        const tool = byName.get(call.function.name);
        let out: string;
        let ok = true;
        let args: Record<string, unknown> = {};
        try {
          if (!tool) throw new Error(`unknown tool ${call.function.name}`);
          let parsed: unknown = {};
          try {
            parsed = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          } catch {
            throw new Error(`arguments are not valid JSON: ${call.function.arguments.slice(0, 200)}`);
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("arguments must be a JSON object");
          args = parsed as Record<string, unknown>;
          out = await tool.run(args);
        } catch (e) {
          ok = false;
          out = `ERROR: ${(e as Error).message}`;
        }
        // Liveness is measured in observable work: a completed tool call is the only evidence of
        // it, and a write tool that named a path is the only evidence of a file.
        lastToolCallAt = Date.now();
        if (ok && tool?.capability === "write" && typeof args.path === "string" && args.path) filesWritten.add(args.path);
        toolCalls.push({ name: call.function.name, args: call.function.arguments.slice(0, 300), ok, ms: Date.now() - started });
        rlog("worker.tool", { name: call.function.name, args: call.function.arguments.slice(0, 200), ok, ms: Date.now() - started, model: used?.spec, ...(ok ? {} : { error: out.slice(0, 200) }) });
        opts.log?.(`tool ${call.function.name}(${call.function.arguments.slice(0, 120)}) -> ${ok ? "ok" : "error"} ${out.length}B`);
        pushMsg({ role: "tool", tool_call_id: call.id, name: call.function.name, content: out.slice(0, config.workspace.maxFileBytes) });
        armStall();
      }
      // A write-capable worker that has written nothing after several iterations is the shape of
      // the original failure: plenty of reading, no output.
      if (writeCapable && warnIterations > 0 && !writesWarned && iterations >= warnIterations && !filesWritten.size) {
        writesWarned = true;
        rlog("worker.stall", { reason: "no-writes", iterations, ...stallStats(), model: used?.spec });
        opts.onStall?.(`stall: ${iterations} iteration(s) and no file written yet — a write-capable worker that has produced nothing`);
      }
      if (iterations === maxIter) {
        truncated = true;
        // Ask for a final answer without tools.
        const final = await routeChat(config, pinned, (c) => ({ ...build(c), tools: undefined, messages: [{ role: "system", content: opts.system }, ...history, { role: "user", content: "Tool budget exhausted. Give your final answer now using what you have." }] }), { signal });
        text = final.response.message.content ?? "";
        costUsd += final.costUsd;
        pushMsg({ role: "assistant", content: text });
      }
    }
    return {
      text,
      messages: transcript,
      usedModel: used?.spec ?? "(none)",
      modelsUsed: [...modelsUsed],
      attempts,
      toolCalls,
      filesWritten: [...filesWritten].sort(),
      lastToolCallAt,
      iterations,
      usage,
      costUsd: Math.round(costUsd * 1e6) / 1e6,
      unpriced,
      truncated,
    };
  } finally {
    // The watchdog outlives the loop otherwise, and a finished run must not keep warning.
    clearTimeout(warnTimer);
    clearTimeout(abortTimer);
  }
}

/** The instruction a handover brief falls back to: whatever the model was last asked to do. */
function lastUserContent(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string" && m.content.trim()) return m.content;
  }
  return undefined;
}

/**
 * `bf bench route` — score routers against a labeled set of subtasks.
 *
 * Four routers, one task set, one table:
 *   lead   — what the lead (a frontier model) picks today: the `lead_lane` label itself, so it
 *            is the accuracy ceiling by construction and the honest cost baseline.
 *   rules  — the deterministic engine, offline, no key.
 *   jev    — TypeSafe System One. Offline it replays a recorded decision set through the real
 *            code path; with `--live` it calls the API.
 *   llm    — a frontier model prompted as a router. Needs a provider key; reported UNMEASURED
 *            when there is none rather than guessed.
 *
 * The ground truth is the labeled `cheapest_passing_lane`: the cheapest lane that actually
 * passed `verify`. Under-routing (sending work to a lane weaker than that) is the guardrail
 * metric — a router that saves money by breaking things is not a success.
 */
import fs from "node:fs";
import path from "node:path";
import type { GatewayConfig } from "./config.js";
import { costUsd, DEFAULT_LANE_MAP, priceFor, withDefaultPricing } from "./config.js";
import { resolveCandidates } from "./router.js";
import type { RouteDecision, RouteTaskInput, RoutingEngine } from "./routing.js";
import { buildState, LANE_SPEC, LANES, LANE_TIER } from "./routing.js";
import { chatCompletion, type ChatRequest } from "./client.js";

/** Per-task token budget used for every cost figure in the bench. Declared, not measured. */
export const ASSUMED_TOKENS_PER_TASK = { input: 20_000, output: 4_000 };

export interface LabeledTask {
  id: string;
  title: string;
  task: string;
  acceptance?: string;
  verify?: string;
  files: string[];
  file_bucket: "1" | "2-5" | "6+";
  tags: string[];
  lead_lane: string;
  cheapest_passing_lane: string;
  difficulty: number;
  sensitive: boolean;
  needs_repo_context: boolean;
}

export function loadLabeledSet(file: string): LabeledTask[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LabeledTask);
}

/**
 * Capability/cost order used by "within one tier". `codex_handoff`, `lead_keeps` and `unclear`
 * are not rungs on the cost ladder, so they only count for exact agreement.
 */
export const tierOf = (lane: string): number | null => LANE_TIER[lane] ?? null;

export interface RouterOutcome {
  lane: string;
  model: string | null;
  confidence: number | null;
  escalated: boolean;
  /** Set when a guardrail, not the router, chose the lane: governed by policy safety, not under-routing. */
  forced?: "policy" | "sensitive";
}

export interface RouterArm {
  name: "lead" | "rules" | "jev" | "llm";
  label: string;
  outcomes: Map<string, RouterOutcome>;
  ms: number;
  cost_usd: number;
  measured: boolean;
  note?: string;
}

export interface BenchMetrics {
  router: string;
  label: string;
  measured: boolean;
  note?: string;
  tasks: number;
  agreement_exact_pct: number;
  /**
   * Agreement over the tasks whose expert label is a crew lane (local/fast/strong/thinker).
   * `codex_handoff`, `lead_keeps` and `unclear` are meta-labels about harness logistics and product
   * authority — nothing in a task description implies them — so they are reported separately
   * rather than allowed to bury the lanes a router can actually judge.
   */
  agreement_crew_lanes_pct: number;
  crew_lane_tasks: number;
  agreement_within_one_pct: number;
  /** Over tasks the router was free to choose for (guardrail-forced tasks are excluded). */
  under_routing_pct: number;
  over_routing_pct: number;
  free_choices: number;
  /** Share of tasks a guardrail (policy or sensitivity) chose the lane for — criterion 10, not 4. */
  forced_pct: number;
  escalation_pct: number;
  /** Wall-clock for the whole set; routing is batched per plan, so both are informative. */
  ms_total: number;
  ms_p50: number;
  ms_per_plan: number;
  cost_usd: number;
  cost_per_1000_decisions_usd: number;
  /** The cheapest lane that passes, per task, priced with the assumed token budget. */
  cheapest_passing_plan_usd: number;
  /** What this router's choices would cost on the same assumed budget. */
  assumed_plan_cost_usd: number;
  saved_vs_all_strong_pct: number;
}

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Cost of one task on a lane, from the lane's mapped alias and the declared token budget,
 * priced against the SHIPPED alias/price table so the figure is the same on every machine. */
export function laneCostUsd(config: GatewayConfig, lane: string): number {
  const priced = withDefaultPricing(config);
  const spec = (DEFAULT_LANE_MAP[lane] ?? config.routing.laneMap[lane]) as string | null | undefined;
  if (!spec) return 0; // escalated: the lead does it, no crew spend
  const cand = resolveCandidates(priced, spec, { useGlobalChain: false })[0];
  if (!cand) return 0;
  const p = priceFor(priced, cand.provider.name, cand.model);
  return (ASSUMED_TOKENS_PER_TASK.input * p.input + ASSUMED_TOKENS_PER_TASK.output * p.output) / 1_000_000;
}

/** Percentage of tasks whose routed lane is weaker than the cheapest lane that actually passed. */
export function scoreArm(config: GatewayConfig, set: LabeledTask[], arm: RouterArm): BenchMetrics {
  // An arm that did not run has no outcomes, and scoring an empty outcome map still produces numbers
  // ("unclear" happens to match some labels) that a JSON consumer could quote. Zero them instead.
  if (!arm.measured) {
    return {
      router: arm.name, label: arm.label, measured: false, ...(arm.note ? { note: arm.note } : {}), tasks: set.length,
      agreement_exact_pct: 0, agreement_crew_lanes_pct: 0, crew_lane_tasks: 0, agreement_within_one_pct: 0,
      under_routing_pct: 0, over_routing_pct: 0, free_choices: 0, forced_pct: 0, escalation_pct: 0,
      ms_total: 0, ms_p50: 0, ms_per_plan: 0, cost_usd: 0, cost_per_1000_decisions_usd: 0,
      cheapest_passing_plan_usd: 0, assumed_plan_cost_usd: 0, saved_vs_all_strong_pct: 0,
    };
  }
  let exact = 0;
  let crewExact = 0;
  let crewTotal = 0;
  let withinOne = 0;
  let comparable = 0;
  let under = 0;
  let over = 0;
  let free = 0;
  let escalated = 0;
  let forced = 0;
  let cost = 0;
  let cheapestCost = 0;
  const allStrong = laneCostUsd(config, "strong") * set.length;
  for (const t of set) {
    const o = arm.outcomes.get(t.id);
    const lane = o?.lane ?? "unclear";
    if (lane === t.lead_lane) exact++;
    // Split out the meta-labels: no router can infer "the lead should keep this" from task text.
    if (tierOf(t.lead_lane) !== null) {
      crewTotal++;
      if (lane === t.lead_lane) crewExact++;
    }
    const a = tierOf(lane);
    const b = tierOf(t.lead_lane);
    if (a !== null && b !== null) {
      comparable++;
      if (Math.abs(a - b) <= 1) withinOne++;
    }
    // A lane a guardrail chose is scored by the policy-safety criterion, not by under-routing:
    // mixing the two would say "you were too cheap" about a task that was deliberately sent home.
    const chosen = tierOf(lane);
    const needed = tierOf(t.cheapest_passing_lane);
    if (o?.forced) forced++;
    else if (chosen !== null && needed !== null) {
      free++;
      if (chosen < needed) under++;
      if (chosen > needed) over++;
    }
    if (o?.escalated || lane === "lead_keeps" || lane === "unclear") escalated++;
    cost += laneCostUsd(config, lane);
    cheapestCost += laneCostUsd(config, t.cheapest_passing_lane);
  }
  const perPlanMs = arm.ms / Math.max(1, Math.ceil(set.length / 12));
  return {
    router: arm.name,
    label: arm.label,
    measured: arm.measured,
    ...(arm.note ? { note: arm.note } : {}),
    tasks: set.length,
    agreement_exact_pct: round((exact / set.length) * 100),
    agreement_crew_lanes_pct: crewTotal ? round((crewExact / crewTotal) * 100) : 0,
    crew_lane_tasks: crewTotal,
    agreement_within_one_pct: comparable ? round((withinOne / comparable) * 100) : 0,
    // Denominator is the tasks the router was actually free to choose for.
    under_routing_pct: free ? round((under / free) * 100) : 0,
    free_choices: free,
    forced_pct: round((forced / set.length) * 100),
    over_routing_pct: free ? round((over / free) * 100) : 0,
    escalation_pct: round((escalated / set.length) * 100),
    ms_total: arm.ms,
    ms_p50: round(perPlanMs),
    ms_per_plan: round(perPlanMs),
    cost_usd: round(arm.cost_usd, 6),
    cost_per_1000_decisions_usd: round((arm.cost_usd / set.length) * 1000, 4),
    cheapest_passing_plan_usd: round(cheapestCost, 4),
    assumed_plan_cost_usd: round(cost, 4),
    saved_vs_all_strong_pct: allStrong > 0 ? round(((allStrong - cost) / allStrong) * 100, 1) : 0,
  };
}

/** The lead-picks baseline: the label itself. Its agreement is 100% by construction. */
export function leadArm(set: LabeledTask[]): RouterArm {
  return {
    name: "lead",
    label: "lead picks (the label)",
    measured: true,
    ms: 0,
    cost_usd: 0,
    note: "the baseline to beat: agreement is 100% by construction, cost is what those picks spend",
    outcomes: new Map(set.map((t) => [t.id, { lane: t.lead_lane, model: null, confidence: null, escalated: t.lead_lane === "lead_keeps" || t.lead_lane === "unclear" }])),
  };
}

export function decisionArm(name: "rules" | "jev", label: string, decisions: RouteDecision[], ms: number, cost: number): RouterArm {
  return {
    name,
    label,
    measured: true,
    ms,
    cost_usd: cost,
    outcomes: new Map(
      decisions.map((d) => [d.id, { lane: d.lane, model: d.model, confidence: d.confidence, escalated: d.escalated, ...(d.reason === "policy" ? { forced: "policy" as const } : d.reason === "sensitive" ? { forced: "sensitive" as const } : {}) }]),
    ),
  };
}

export function unmeasuredLlmArm(note: string): RouterArm {
  return { name: "llm", label: "frontier LLM as router", measured: false, note, ms: 0, cost_usd: 0, outcomes: new Map() };
}

/** Tasks per routing call. The bench reports `ms_per_plan` for a 12-task plan, so both routers are
 * asked in 12-task batches and divided the same way — otherwise the LLM arm looks slow for being
 * called 60 times where Jev is called once. */
export const LLM_ROUTER_CHUNK = 12;

export interface LlmRouterStats {
  spec: string;
  model: string;
  chunks: number;
  input_tokens: number;
  /** Tokens the provider will bill as output, which includes thinking where the shim hides it. */
  output_tokens: number;
  /** Of those, the ones that were thinking: reported so the cost is auditable, not just computed. */
  thinking_tokens: number;
  /** False when the model is absent from the price table — the cost column would be a lie. */
  priced: boolean;
  /** Chunks that could not be answered or parsed, with the reason. Never silently treated as "allow". */
  failures: string[];
}

const toRouteInput = (t: LabeledTask): RouteTaskInput => ({ id: t.id, title: t.title, task: t.task, acceptance: t.acceptance, verify: t.verify, files: t.files, tags: t.tags });

/**
 * The prompt for the frontier-LLM baseline (criterion 11).
 *
 * It gets the SAME lane definitions Jev gets — `LANE_SPEC`, verbatim, the same strings that go into
 * Jev's Choice criteria — and the same task facts `buildState` hands Jev. A baseline that wins or
 * loses on prompt wording would measure nothing; the only difference here is the model.
 */
export function llmRouterMessages(config: GatewayConfig, chunk: LabeledTask[]): { system: string; user: string } {
  const lanes = LANES.map((l) => `- ${l}: ${LANE_SPEC[l].what}\n  NOT for: ${LANE_SPEC[l].not_for}\n  Examples: ${LANE_SPEC[l].examples}`).join("\n");
  const system = [
    "You route software engineering subtasks to the cheapest model that can do them well.",
    `Assign each task exactly one lane:\n${lanes}`,
    'Reply with a JSON array and nothing else — no prose, no code fences:\n[{"id":"<task id>","lane":"<lane>"}, ...]\nOne entry per task, in the order given, with the id copied exactly.',
  ].join("\n\n");
  const { state } = buildState(config, undefined, chunk.map(toRouteInput), []);
  return { system, user: JSON.stringify(state) };
}

/** Tolerant of the shapes a chat model actually returns: fences, prose, or a different key name. */
export function parseLlmRouting(text: string, ids: string[]): { lanes: Map<string, string>; bad: string[] } {
  const lanes = new Map<string, string>();
  const bad: string[] = [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return { lanes, bad: ["no JSON array in the reply"] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { lanes, bad: [`unparseable JSON: ${(e as Error).message.slice(0, 80)}`] };
  }
  if (!Array.isArray(parsed)) return { lanes, bad: ["reply was not an array"] };
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = String(r.id ?? r.task_id ?? r.task ?? "").trim();
    const lane = String(r.lane ?? r.model ?? r.choice ?? "").trim();
    if (!id || !ids.includes(id)) {
      bad.push(`unknown task id '${id}'`);
      continue;
    }
    if (!(LANES as readonly string[]).includes(lane)) {
      bad.push(`${id}: '${lane}' is not a lane`);
      continue;
    }
    lanes.set(id, lane);
  }
  for (const id of ids) if (!lanes.has(id)) bad.push(`${id}: no lane returned`);
  return { lanes, bad };
}

/**
 * The frontier-LLM-as-router arm.
 *
 * Cost comes from the usage the API actually reports, priced at published list prices. On these
 * models THE THINKING TOKENS ARE BILLED AS OUTPUT and they dominate the bill — a reasoning router is
 * expensive because it thinks before every answer. That asymmetry is not a flaw in the comparison,
 * it is the comparison: it is exactly what criterion 11 is asking about.
 */
export async function llmRouterArm(
  config: GatewayConfig,
  set: LabeledTask[],
  opts: { spec: string; timeoutMs?: number; signal?: AbortSignal; maxTokens?: number },
): Promise<{ arm: RouterArm; stats: LlmRouterStats }> {
  const cand = resolveCandidates(config, opts.spec, { useGlobalChain: false }).find((c) => !c.provider.unusableReason);
  const emptyStats: LlmRouterStats = { spec: opts.spec, model: "-", chunks: 0, input_tokens: 0, output_tokens: 0, thinking_tokens: 0, priced: true, failures: [] };
  if (!cand) return { arm: unmeasuredLlmArm(`nothing usable resolves from '${opts.spec}' — set a key for that provider`), stats: emptyStats };

  const chunks: LabeledTask[][] = [];
  for (let i = 0; i < set.length; i += LLM_ROUTER_CHUNK) chunks.push(set.slice(i, i + LLM_ROUTER_CHUNK));

  const outcomes = new Map<string, RouterOutcome>();
  const failures: string[] = [];
  let cost = 0;
  let priced = true;
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  const started = Date.now();

  for (const chunk of chunks) {
    const { system, user } = llmRouterMessages(config, chunk);
    const req: ChatRequest = {
      model: cand.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: opts.maxTokens ?? 8000,
    };
    const ids = chunk.map((t) => t.id);
    const answered = (lane: string) => ({ lane, model: `${cand.provider.name}/${cand.model}`, confidence: null, escalated: lane === "lead_keeps" || lane === "unclear" });
    try {
      const r = await chatCompletion(cand.provider, req, { timeoutMs: opts.timeoutMs ?? 180_000, signal: opts.signal });
      const c = costUsd(config, cand.provider.name, cand.model, r.usage);
      cost += c.usd;
      priced = priced && c.priced;
      inputTokens += r.usage?.prompt_tokens ?? 0;
      // Billed output, not the visible reply: see costUsd for why those differ.
      outputTokens += c.output_tokens;
      thinkingTokens += Math.max(0, c.output_tokens - (r.usage?.completion_tokens ?? 0));
      const { lanes, bad } = parseLlmRouting(r.message.content ?? "", ids);
      if (bad.length) failures.push(`${chunk.length} tasks: ${bad.slice(0, 3).join("; ")}`);
      for (const id of ids) outcomes.set(id, answered(lanes.get(id) ?? "unclear"));
    } catch (e) {
      const msg = (e as Error).message.slice(0, 120);
      failures.push(`${chunk.length} tasks: ${msg}`);
      // An unanswered chunk is ESCALATED, never guessed at — the same rule the routers themselves
      // follow when they cannot answer.
      for (const id of ids) outcomes.set(id, answered("unclear"));
    }
  }

  const ms = Date.now() - started;
  const note = [
    `${cand.provider.name}/${cand.model}: ${chunks.length} call(s), ${inputTokens} in / ${outputTokens} out tokens${thinkingTokens ? ` (${thinkingTokens} of them thinking, billed as output)` : ""}`,
    priced ? "" : "UNPRICED — no entry in the price table, so the cost column is not usable",
    failures.length ? `${failures.length} chunk(s) unanswered: ${failures[0]}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    arm: { name: "llm", label: `frontier LLM as router (${cand.model})`, measured: true, ms, cost_usd: Math.round(cost * 1e6) / 1e6, outcomes, note },
    stats: { spec: cand.provider.name + "/" + cand.model, model: cand.model, chunks: chunks.length, input_tokens: inputTokens, output_tokens: outputTokens, thinking_tokens: thinkingTokens, priced, failures },
  };
}

/** One table anyone can read, and the same numbers as JSON for the post. */
export function renderBenchTable(metrics: BenchMetrics[], meta: { set: string; tasks: number; engine: string; live: boolean; assumed: string }): string {
  const cols = ["router", "exact %", "crew %", "±1 tier %", "under %", "forced %", "escal %", "ms/plan", "$/1000", "$ plan", "vs strong"];
  const rows = metrics.map((m) =>
    m.measured
      ? [m.router, `${m.agreement_exact_pct}`, `${m.agreement_crew_lanes_pct}`, `${m.agreement_within_one_pct}`, `${m.under_routing_pct}`, `${m.forced_pct}`, `${m.escalation_pct}`, `${m.ms_p50}`, `$${m.cost_per_1000_decisions_usd}`, `$${m.assumed_plan_cost_usd}`, `${m.saved_vs_all_strong_pct}%`]
      : [m.router, "unmeasured", "-", "-", "-", "-", "-", "-", "-", "-", "-"],
  );
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const fmt = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const lines = [
    `# bf bench route — ${meta.tasks} tasks from ${path.basename(meta.set)}${meta.live ? " (live)" : " (recorded decisions)"}`,
    "",
    fmt(cols),
    fmt(cols.map((c) => "-".repeat(c.length))),
    ...rows.map(fmt),
    "",
    `engine ${meta.engine} · ${meta.assumed}`,
    "crew % is agreement over the crew lanes only (local/fast/strong/thinker) — codex_handoff, lead_keeps and unclear are meta-labels nothing in a task description implies",
    "under % is over the tasks the router was free to choose for; forced % is the share a guardrail decided (policy safety, criterion 10)",
  ];
  const skipped = metrics.filter((m) => !m.measured);
  if (skipped.length) lines.push("", ...skipped.map((m) => `unmeasured: ${m.router} — ${m.note}`));
  return lines.join("\n");
}

/** Which engine key the bench used, for the table footer. */
export function benchEngineLabel(engine: RoutingEngine | "recorded"): string {
  return engine === "recorded" ? "jev (replayed from a recording)" : engine;
}

/**
 * `bf scenarios` — ten agent workflows, each routed four ways, side by side.
 *
 * The bench (`bench.ts`) answers "which router is more accurate?" over 60 flat subtasks. This
 * answers the question a user actually asks: **for a real piece of work, what changes if routing
 * is on?** Every scenario is a plan someone would really hand to an agent, and it is routed as its
 * own plan — one decision pass per scenario, the way `run_plan` does it.
 *
 * Four arms:
 *   jev     TypeSafe System One decides each task's lane
 *   rules   the deterministic keyword engine
 *   off     no routing at all: every task runs on `defaults.model` (what Break Free did before)
 *   lead    the expert label — what a skilled lead would pick, and the bar to beat
 *
 * Three questions per scenario, which is what the comparison is for:
 *   right place    did the right task go to the right lane, and was it ever sent BELOW the lane
 *                  that actually passes (under-routing, the guardrail)
 *   cost           crew spend for that plan at list prices, on a declared token budget
 *   latency        wall-clock for the routing decision itself
 */
import fs from "node:fs";
import path from "node:path";
import type { GatewayConfig } from "./config.js";
import { DEFAULT_LANE_MAP, priceFor, withDefaultPricing } from "./config.js";
import { resolveCandidates } from "./router.js";
import { LANE_TIER } from "./routing.js";
import type { RouteDecision, RouteResult } from "./routing.js";

/** Per-task token budget for every cost figure here. Declared, not measured. */
export const SCENARIO_TOKENS_PER_TASK = { input: 20_000, output: 4_000 };

export interface ScenarioTask {
  id: string;
  task: string;
  acceptance?: string;
  verify?: string;
  files?: string[];
  tags?: string[];
  /** The lane a skilled lead would pick: the right answer for this task. */
  lane: string;
  /** The cheapest lane that would still pass `verify`: the under-routing guardrail's line. */
  cheapest_passing_lane: string;
  difficulty: number;
  sensitive: boolean;
  needs_lead: boolean;
  long_refactor: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  story: string;
  tasks: ScenarioTask[];
}

export function loadScenarios(file: string): Scenario[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { scenarios?: Scenario[] };
  return parsed.scenarios ?? [];
}

export type ArmName = "jev" | "rules" | "off" | "lead";

export interface Arm {
  name: ArmName;
  label: string;
  /** task id -> the lane this arm would run it on (or `lead_keeps` when it hands it back) */
  lanes: Map<string, string>;
  ms: number;
  cost_usd: number;
  measured: boolean;
  note?: string;
}

export interface ArmScore {
  exact: number;
  exact_pct: number;
  /** Routed BELOW the cheapest lane that passes: the metric that catches false savings. */
  under: number;
  under_pct: number;
  escalated: number;
  cost_usd: number;
  /** The model each task actually lands on, so "right place" is legible. */
  models: string[];
}

export interface ScenarioScore {
  id: string;
  title: string;
  story: string;
  tasks: number;
  arms: Record<ArmName, ArmScore>;
  jev_ms: number;
  rules_ms: number;
  /** What Jev's own decision call cost for this scenario (not crew spend). */
  jev_call_usd: number;
  /** Crew cost if every task ran on the strong lane. */
  all_strong_usd: number;
  /** Crew cost of the expert picks: what a good lead spends. */
  lead_usd: number;
}

const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Cost of one task on one lane, from the lane's mapped alias and the declared token budget,
 * priced against the SHIPPED alias/price table so the figure is the same on every machine.
 */
export function laneCost(config: GatewayConfig, lane: string): number {
  const priced = withDefaultPricing(config);
  const spec = (config.routing.laneMap[lane] ?? DEFAULT_LANE_MAP[lane]) as string | null | undefined;
  if (!spec) return 0;
  const cand = resolveCandidates(priced, spec, { useGlobalChain: false })[0];
  if (!cand) return 0;
  const p = priceFor(priced, cand.provider.name, cand.model);
  return (SCENARIO_TOKENS_PER_TASK.input * p.input + SCENARIO_TOKENS_PER_TASK.output * p.output) / 1_000_000;
}

/** The model a lane lands on, for the "right place" column. `null` means the lead keeps it. */
export function laneModel(config: GatewayConfig, lane: string): string | null {
  return (config.routing.laneMap[lane] ?? DEFAULT_LANE_MAP[lane]) ?? null;
}

export function scoreArm(config: GatewayConfig, tasks: ScenarioTask[], lanes: Map<string, string>): ArmScore {
  let exact = 0;
  let under = 0;
  let escalated = 0;
  let cost = 0;
  const models: string[] = [];
  for (const t of tasks) {
    const lane = lanes.get(t.id) ?? "unclear";
    if (lane === t.lane) exact++;
    const got = LANE_TIER[lane];
    const needed = LANE_TIER[t.cheapest_passing_lane];
    if (got !== undefined && needed !== undefined && got < needed) under++;
    if (lane === "lead_keeps" || lane === "unclear") escalated++;
    cost += laneCost(config, lane);
    const m = laneModel(config, lane);
    if (m && !models.includes(m)) models.push(m);
  }
  return {
    exact,
    exact_pct: Math.round((exact / tasks.length) * 100),
    under,
    under_pct: Math.round((under / tasks.length) * 100),
    escalated,
    cost_usd: round(cost),
    models,
  };
}

/** The arms that need no routing call. `off` is the pre-routing behaviour: everything on defaults.model. */
export function staticArms(config: GatewayConfig, tasks: ScenarioTask[]): { lead: Arm; off: Arm } {
  return {
    lead: { name: "lead", label: "lead picks (expert)", lanes: new Map(tasks.map((t) => [t.id, t.lane])), ms: 0, cost_usd: 0, measured: true },
    off: { name: "off", label: `no routing (all ${config.defaults.model})`, lanes: new Map(tasks.map((t) => [t.id, "fast"])), ms: 0, cost_usd: 0, measured: true, note: `every task runs on defaults.model (${config.defaults.model}); this is what Break Free did before routing existed` },
  };
}

export function routedArm(name: "jev" | "rules", label: string, result: RouteResult): Arm {
  return {
    name,
    label,
    lanes: new Map(result.decisions.map((d) => [d.id, d.lane])),
    ms: result.ms,
    /** What the routing call itself cost (crew spend is computed from the lanes, not here). */
    cost_usd: result.cost_usd,
    measured: name === "rules" ? true : result.answered_by === "jev",
    ...(name === "jev" && result.answered_by !== "jev" ? { note: `Jev did not answer: ${result.degraded ?? "unknown"}` } : {}),
  };
}

export function scoreScenario(config: GatewayConfig, sc: Scenario, arms: Arm[], ms: Record<string, number> = {}): ScenarioScore {
  const strong = laneCost(config, "strong") * sc.tasks.length;
  const byName = Object.fromEntries(arms.map((a) => [a.name, scoreArm(config, sc.tasks, a.lanes)])) as Record<ArmName, ArmScore>;
  return {
    id: sc.id,
    title: sc.title,
    story: sc.story,
    tasks: sc.tasks.length,
    arms: byName,
    jev_ms: ms.jev ?? 0,
    rules_ms: ms.rules ?? 0,
    jev_call_usd: round(arms.find((a) => a.name === "jev")?.cost_usd ?? 0, 6),
    all_strong_usd: round(strong),
    lead_usd: byName.lead.cost_usd,
  };
}

export interface ScenarioTotals {
  scenarios: number;
  tasks: number;
  arms: Record<ArmName, { exact_pct: number; under_pct: number; cost_usd: number; escalated: number; measured: boolean; label: string; note?: string }>;
  jev_ms: number;
  rules_ms: number;
  jev_ms_per_plan: number;
  /** What Jev's own decision calls cost across every scenario (separate from crew spend). */
  jev_decision_usd: number;
  all_strong_usd: number;
  saved_vs_all_strong_pct: number;
  saved_vs_lead_pct: number;
  saved_vs_off_pct: number;
}

export function totals(scores: ScenarioScore[], labels: Record<ArmName, { label: string; measured: boolean; note?: string }>): ScenarioTotals {
  const tasks = scores.reduce((n, s) => n + s.tasks, 0);
  const agg = (name: ArmName) => {
    const exact = scores.reduce((n, s) => n + s.arms[name].exact, 0);
    const under = scores.reduce((n, s) => n + s.arms[name].under, 0);
    const cost = scores.reduce((n, s) => n + s.arms[name].cost_usd, 0);
    const escalated = scores.reduce((n, s) => n + s.arms[name].escalated, 0);
    const l = labels[name];
    return { exact_pct: Math.round((exact / tasks) * 100), under_pct: Math.round((under / tasks) * 100), cost_usd: round(cost), escalated, measured: l.measured, label: l.label, ...(l.note ? { note: l.note } : {}) };
  };
  const jev = agg("jev");
  const lead = agg("lead");
  const off = agg("off");
  const allStrong = round(scores.reduce((n, s) => n + s.all_strong_usd, 0));
  const jevMs = scores.reduce((n, s) => n + s.jev_ms, 0);
  const rulesMs = scores.reduce((n, s) => n + s.rules_ms, 0);
  const pct = (from: number, to: number) => (from > 0 ? Math.round(((from - to) / from) * 1000) / 10 : 0);
  return {
    scenarios: scores.length,
    tasks,
    arms: { jev, rules: agg("rules"), off, lead },
    jev_ms: jevMs,
    rules_ms: rulesMs,
    jev_ms_per_plan: Math.round(jevMs / Math.max(1, scores.length)),
    jev_decision_usd: round(scores.reduce((n, s) => n + s.jev_call_usd, 0), 6),
    all_strong_usd: allStrong,
    saved_vs_all_strong_pct: pct(allStrong, jev.cost_usd),
    saved_vs_lead_pct: pct(lead.cost_usd, jev.cost_usd),
    saved_vs_off_pct: pct(off.cost_usd, jev.cost_usd),
  };
}

/** Two tables and a totals block. Read the `under %` column before the money columns. */
export function renderScenarioReport(scores: ScenarioScore[], t: ScenarioTotals, meta: { live: boolean; file: string }): string {
  const w = Math.max(8, ...scores.map((s) => s.title.length));
  const pad = (s: string, n: number) => s.padEnd(n);
  const num = (n: number | string, n2 = 6) => String(n).padStart(n2);
  const out: string[] = [
    `# bf scenarios — ${t.scenarios} agent workflows, ${t.tasks} tasks${meta.live ? " (live)" : " (recorded decisions)"}`,
    "",
    "## Right task to the right lane",
    "",
    `  ${pad("scenario", w)}  tasks   jev   rules    off   lead`,
    `  ${"-".repeat(w)}  -----  ----  ------  -----  -----`,
    ...scores.map((s) => `  ${pad(s.title.slice(0, w), w)}  ${num(s.tasks, 5)}  ${num(`${s.arms.jev.exact_pct}%`, 4)}  ${num(`${s.arms.rules.exact_pct}%`, 6)}  ${num(`${s.arms.off.exact_pct}%`, 5)}  ${num(`${s.arms.lead.exact_pct}%`, 5)}`),
    `  ${"-".repeat(w)}  -----  ----  ------  -----  -----`,
    `  ${pad("ALL (weighted)", w)}  ${num(t.tasks, 5)}  ${num(`${t.arms.jev.exact_pct}%`, 4)}  ${num(`${t.arms.rules.exact_pct}%`, 6)}  ${num(`${t.arms.off.exact_pct}%`, 5)}  ${num(`${t.arms.lead.exact_pct}%`, 5)}`,
    "",
    "## Routed below the lane that passes (the guardrail — lower is safer)",
    "",
    `  ${pad("scenario", w)}   jev   rules    off   lead`,
    `  ${"-".repeat(w)}  ----  ------  -----  -----`,
    ...scores.map((s) => `  ${pad(s.title.slice(0, w), w)}  ${num(`${s.arms.jev.under_pct}%`, 4)}  ${num(`${s.arms.rules.under_pct}%`, 6)}  ${num(`${s.arms.off.under_pct}%`, 5)}  ${num(`${s.arms.lead.under_pct}%`, 5)}`),
    `  ${"-".repeat(w)}  ----  ------  -----  -----`,
    `  ${pad("ALL (weighted)", w)}  ${num(`${t.arms.jev.under_pct}%`, 4)}  ${num(`${t.arms.rules.under_pct}%`, 6)}  ${num(`${t.arms.off.under_pct}%`, 5)}  ${num(`${t.arms.lead.under_pct}%`, 5)}`,
    "",
    "## Cost and routing latency per scenario",
    "",
    `  ${pad("scenario", w)}    jev $   rules $     off $    lead $   strong $   jev ms  rules ms`,
    `  ${"-".repeat(w)}  -------  --------  --------  --------  ---------  -------  --------`,
    ...scores.map((s) => `  ${pad(s.title.slice(0, w), w)}  ${num(s.arms.jev.cost_usd.toFixed(4), 7)}  ${num(s.arms.rules.cost_usd.toFixed(4), 8)}  ${num(s.arms.off.cost_usd.toFixed(4), 8)}  ${num(s.arms.lead.cost_usd.toFixed(4), 8)}  ${num(s.all_strong_usd.toFixed(4), 9)}  ${num(s.jev_ms, 7)}  ${num(s.rules_ms, 8)}`),
    "",
    "## Totals",
    "",
    `  right lane     jev ${t.arms.jev.exact_pct}%   rules ${t.arms.rules.exact_pct}%   off ${t.arms.off.exact_pct}%   lead ${t.arms.lead.exact_pct}%`,
    `  under-routed   jev ${t.arms.jev.under_pct}%   rules ${t.arms.rules.under_pct}%   off ${t.arms.off.under_pct}%   lead ${t.arms.lead.under_pct}%`,
    `  escalated      jev ${t.arms.jev.escalated}/${t.tasks}${t.arms.rules.escalated ? `   rules ${t.arms.rules.escalated}/${t.tasks}` : ""}`,
    `  crew cost      jev $${t.arms.jev.cost_usd}  (${t.saved_vs_all_strong_pct}% below all-strong, ${t.saved_vs_lead_pct > 0 ? `${t.saved_vs_lead_pct}% below` : `${Math.abs(t.saved_vs_lead_pct)}% above`} the lead's own picks, ${t.saved_vs_off_pct > 0 ? `${t.saved_vs_off_pct}% below` : `${Math.abs(t.saved_vs_off_pct)}% above`} no-routing)`,
    `  routing time   jev ${t.jev_ms} ms for ${t.scenarios} plans (${t.jev_ms_per_plan} ms/plan)   rules ${t.rules_ms} ms`,
    `  decision cost  $${t.jev_decision_usd} for ${t.scenarios} routing calls covering ${t.tasks} tasks (logged separately as route.decision, never as crew spend)`,
    "",
    `costs assume ${SCENARIO_TOKENS_PER_TASK.input.toLocaleString()} input + ${SCENARIO_TOKENS_PER_TASK.output.toLocaleString()} output tokens per task at list prices`,
    `${meta.live ? "live TypeSafe API" : `replayed from ${path.basename(meta.file)} through the real client`}`,
  ];
  return out.join("\n");
}

/** One compact line per scenario — for pasting into an issue. */
export function renderScenarioDigest(scores: ScenarioScore[]): string {
  return scores.map((s) => `${s.id} ${s.title}: jev ${s.arms.jev.exact_pct}% right / ${s.arms.jev.under_pct}% under-routed, rules ${s.arms.rules.exact_pct}% / ${s.arms.rules.under_pct}%, off ${s.arms.off.exact_pct}% / ${s.arms.off.under_pct}%`).join("\n");
}

export interface ScenarioRecording {
  note: string;
  answered_by: string;
  scenarios: number;
  tasks: number;
  /** Live per-scenario latency and decision cost, so an offline replay reports the real numbers. */
  latency?: Record<string, { ms: number; call_usd: number }>;
  decisions: Record<string, unknown>;
}

/**
 * Decision-recording shape for replay, keyed by task id.
 *
 * `latency` is captured alongside the decisions on purpose: a replay answers in milliseconds
 * because the API is local, and reporting that as the routing latency would be a lie.
 */
export function recordScenarioDecisions(file: string, results: { scenario: string; tasks: ScenarioTask[]; decisions: RouteDecision[] }[], answeredBy: string, latency: Record<string, { ms: number; call_usd: number }> = {}): void {
  const decisions: Record<string, unknown> = {};
  for (const r of results) {
    const byId = new Map(r.decisions.map((d) => [d.id, d]));
    for (const t of r.tasks) {
      const d = byId.get(t.id);
      decisions[t.id] = { lane: d?.proposed_lane ?? "unclear", confidence: d?.confidence ?? 0, difficulty: d?.difficulty ?? 2, sensitive: d?.sensitive_prob ?? 0, context: d?.needs_repo_context ? 1 : 0, probs: d?.probabilities ?? null };
    }
  }
  const out: ScenarioRecording = {
    note: "Recorded TypeSafe System One decisions for bench/scenarios.json, captured live from api.typesafe.ai. Replayed offline through the real client so `bf scenarios` needs no key; `latency` holds the live measurement so the replay does not report its own (near-zero) time as the routing latency. Regenerate: bf scenarios --live --record bench/scenario-recording.json",
    answered_by: answeredBy,
    scenarios: results.length,
    tasks: Object.keys(decisions).length,
    ...(Object.keys(latency).length ? { latency } : {}),
    decisions,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
}

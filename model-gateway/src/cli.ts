#!/usr/bin/env node
/**
 * `bf` — the Break Free command line.
 *
 *   bf route  --plan <file> [--engine jev|rules|off] [--threshold 0.7] [--json]
 *   bf bench route [--set <file>] [--engine rules,jev] [--live] [--record <file>] [--json]
 *   bf demo [--plan <file>] [--live] [--json]
 *   bf ab --plan <file> [--workspace <git repo>] [--json]
 *
 * `bf route`, `bf bench route` and `bf demo` call the same functions `run_plan` calls, so what
 * you see here is what the gateway does — not a reimplementation. Offline (the default) the Jev
 * arm answers from a recorded decision set replayed through the real TypeSafe client; `--live`
 * calls api.typesafe.ai and needs TYPESAFE_API_KEY.
 *
 * `bf ab` and `bf validate` are the two commands that RUN real work; everything else here only
 * decides or scores. `bf ab` runs one plan under both arms and compares what the scorecards say.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, userConfigPath, type GatewayConfig } from "./config.js";
import { routePlanTasks, type RouteDecision, type RouteResult, type RoutingEngine, type RouteTaskInput } from "./routing.js";
import { ASSUMED_TOKENS_PER_TASK, benchEngineLabel, decisionArm, laneCostUsd, leadArm, llmRouterArm, loadLabeledSet, renderBenchTable, scoreArm, unmeasuredLlmArm, type LabeledTask, type RouterArm } from "./bench.js";
import { startTypeSafeDouble, type DoubleDecision, type TypeSafeDouble } from "./jev-double.js";
import { loadScenarios, recordScenarioDecisions, renderScenarioDigest, renderScenarioReport, routedArm, scoreScenario, staticArms, totals, type ScenarioRecording, type ScenarioScore, type ScenarioTask } from "./scenarios.js";
import { exitCodeFor, laneFor, renderValidation, summarise, toValidateTasks, type RawValidateTask, type TaskOutcome, type ValidateArm, type ValidateTask } from "./validate.js";
import { abExitCode, renderAb, summariseAb, toAbRows, type AbArmInput, type AbArmName, type AbSavings } from "./ab.js";
import { Ledger } from "./ledger.js";
import { resolveCandidates } from "./router.js";
import type { PlanTask } from "./orchestrate.js";
import { renderTripwireMetrics, runTripwire, scoreTripwire, TRIPWIRE_CHECKS, type TripwireOutcome } from "./tripwire.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { runCommand } from "./runcmd.js";

const REPO_BENCH = new URL("../bench/", import.meta.url).pathname;
const DEFAULT_RECORDING = path.join(REPO_BENCH, "jev-recording.json");

interface Parsed {
  cmd: string;
  sub?: string;
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Parsed {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const [cmd = "help", sub] = positional;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else flags[key] = true;
  }
  return { cmd, sub, flags };
}

/** A config for a CLI run: the user's own file plus explicit overrides, in a throwaway path. */
export function configFor(over: { providers?: Record<string, unknown>; routing?: Record<string, unknown>; tripwire?: Record<string, unknown> }): GatewayConfig {
  const userPath = userConfigPath();
  const userJson = fs.existsSync(userPath) ? (JSON.parse(fs.readFileSync(userPath, "utf8")) as Record<string, unknown>) : {};
  const merged = {
    ...userJson,
    providers: { ...((userJson.providers as Record<string, unknown>) ?? {}), ...(over.providers ?? {}) },
    routing: { ...((userJson.routing as Record<string, unknown>) ?? {}), ...(over.routing ?? {}) },
    tripwire: { ...((userJson.tripwire as Record<string, unknown>) ?? {}), ...(over.tripwire ?? {}) },
  };
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-cli-")), "config.json");
  fs.writeFileSync(file, JSON.stringify(merged));
  return loadConfig({ workspaceRoot: process.cwd(), configPath: file }).config;
}

export function readPlan(file: string): { goal?: string; tasks: (RouteTaskInput & { tags?: string[]; files?: string[] })[] } {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".jsonl")) return { tasks: text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RouteTaskInput) };
  const parsed = JSON.parse(text) as { goal?: string; tasks?: RouteTaskInput[] } | RouteTaskInput[];
  return Array.isArray(parsed) ? { tasks: parsed } : { goal: parsed.goal, tasks: parsed.tasks ?? [] };
}

export function renderRouteTable(r: RouteResult): string {
  if (!r.decisions.length) return `routing is ${r.engine}: an omitted model means config.defaults.model (nothing was routed)`;
  const cols = ["task", "lane", "model", "conf", "diff", "sens", "ctx", "why"];
  const rows = r.decisions.map((d): string[] => [d.id, d.lane, d.model ?? "— lead", d.confidence?.toFixed(2) ?? "—", String(d.difficulty), d.sensitive ? "yes" : "no", d.needs_repo_context ? "yes" : "no", d.reason + (d.policy_hits.length ? ` (${d.policy_hits[0]})` : "")]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)));
  const fmt = (row: string[]) => row.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const msPerTask = r.decisions.length ? Math.round(r.ms / r.decisions.length) : 0;
  return [
    fmt(cols),
    fmt(cols.map((c) => "-".repeat(c.length))),
    ...rows.map(fmt),
    "",
    `engine ${r.answered_by}${r.degraded ? ` (degraded: ${r.degraded})` : ""} · ${r.decisions.length} tasks in ${r.ms} ms (${msPerTask} ms/task)${r.requests > 1 ? ` · ${r.requests} requests` : ""} · $${r.cost_usd.toFixed(6)}${r.priced ? "" : " (unpriced)"} · state ${r.state_tokens} tokens${r.state_truncated ? " (trimmed)" : ""}`,
    `escalated ${r.escalated}/${r.decisions.length} · policy hits ${r.policy_hits}`,
  ].join("\n");
}

/**
 * The offline decision source: a recorded set replayed through the real client and router.
 *
 * A missing recording is an error, not a silent fallback: the double would answer its default
 * (`fast`) for every task, which looks like a plausible result and is not one. Better to say so.
 */
async function offlineDouble(recordFile: string): Promise<TypeSafeDouble & { source: string; record: Partial<ScenarioRecording> }> {
  if (!fs.existsSync(recordFile)) {
    throw new Error(`no recorded decisions at ${recordFile}\n  run this once with --live to capture them (needs TYPESAFE_API_KEY), or point --record at an existing recording`);
  }
  const raw = JSON.parse(fs.readFileSync(recordFile, "utf8")) as ScenarioRecording;
  const double = await startTypeSafeDouble({ decisions: (raw.decisions ?? {}) as Record<string, DoubleDecision> });
  return Object.assign(double, { source: recordFile, record: raw });
}

function offlineRouting(recordFile: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { engine: "jev", retryDelayMs: 0, ...extra };
}

// ------------------------------------------------------------------ bf route
async function cmdRoute(flags: Record<string, string | boolean>): Promise<number> {
  const planFile = typeof flags.plan === "string" ? flags.plan : undefined;
  if (!planFile) {
    console.error("usage: bf route --plan <file.json|file.jsonl> [--engine jev|rules|off] [--threshold 0.7]");
    return 2;
  }
  const engine = (typeof flags.engine === "string" ? flags.engine : "rules") as RoutingEngine;
  const offline = engine === "jev" && flags.live !== true;
  const double = offline ? await offlineDouble(typeof flags.record === "string" ? flags.record : DEFAULT_RECORDING) : undefined;
  try {
    const config = configFor({
      providers: double ? { typesafe: { baseUrl: double.url, apiKey: "bf-offline" } } : {},
      routing: { engine, ...(typeof flags.threshold === "string" ? { threshold: Number(flags.threshold) } : {}), ...(offline ? offlineRouting(double!.source) : {}) },
    });
    const { goal, tasks } = readPlan(planFile);
    const result = await routePlanTasks(config, tasks, { goal, engine });
    console.log(flags.json ? JSON.stringify(result, null, 2) : renderRouteTable(result));
    return 0;
  } finally {
    await double?.close();
  }
}

// ------------------------------------------------------------------ bf bench route
export function writeRecording(file: string, set: LabeledTask[], decisions: RouteDecision[], answeredBy: string): void {
  const byId = new Map(decisions.map((d) => [d.id, d]));
  const out = {
    note: "Recorded TypeSafe System One decisions, replayed offline through the real client so `bf bench route` and `bf demo` run with no key. Regenerate against the live API with: bf bench route --live --record bench/jev-recording.json",
    answered_by: answeredBy,
    recorded_at: new Date().toISOString(),
    tasks: set.length,
    decisions: Object.fromEntries(
      set.map((t) => {
        const d = byId.get(t.id);
        return [t.id, { lane: d?.proposed_lane ?? "unclear", confidence: d?.confidence ?? 0, difficulty: d?.difficulty ?? 2, sensitive: d?.sensitive_prob ?? 0, context: d?.needs_repo_context ? 1 : 0, probs: d?.probabilities ?? null }];
      }),
    ),
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.error(`wrote ${file}`);
}

async function cmdBench(flags: Record<string, string | boolean>): Promise<number> {
  const setFile = typeof flags.set === "string" ? flags.set : path.join(REPO_BENCH, "route-set.jsonl");
  const set = loadLabeledSet(setFile);
  const live = flags.live === true;
  const recordFile = typeof flags.record === "string" ? flags.record : DEFAULT_RECORDING;
  const arms: RouterArm[] = [leadArm(set)];

  const rulesConfig = configFor({ routing: { engine: "rules" } });
  const rulesStart = Date.now();
  const rules = await routePlanTasks(rulesConfig, set, { engine: "rules" });
  arms.push(decisionArm("rules", "static rules", rules.decisions, Date.now() - rulesStart, 0));

  if (flags.engine === undefined || String(flags.engine).includes("jev")) {
    const double = live ? undefined : await offlineDouble(recordFile);
    try {
      const config = configFor({
        providers: double ? { typesafe: { baseUrl: double.url, apiKey: "bf-offline" } } : {},
        routing: live ? { engine: "jev" } : offlineRouting(double!.source),
      });
      const started = Date.now();
      const r = await routePlanTasks(config, set, { engine: "jev" });
      const ms = Date.now() - started;
      const label = live ? "Jev (live api.typesafe.ai)" : "Jev (replayed recording)";
      if (r.answered_by !== "jev") {
        arms.push({ name: "jev", label, measured: false, note: `Jev did not answer: ${r.degraded ?? "unknown"}`, ms, cost_usd: r.cost_usd, outcomes: new Map() });
      } else {
        arms.push({ ...decisionArm("jev", label, r.decisions, ms, r.cost_usd), note: `${r.usage.input_tokens} input tokens, ${r.batch} batch, ${r.escalated} escalated` });
        if (live) writeRecording(recordFile, set, r.decisions, r.answered_by);
      }
    } finally {
      await double?.close();
    }
  }

  // The frontier-LLM-as-router baseline (criterion 11). It is opt-in: `bf bench route` is documented
  // as an offline command, and quietly making paid API calls from it would be a nasty surprise.
  if (flags.llm === undefined) {
    arms.push(unmeasuredLlmArm("not run: pass --llm [provider/model] to send the same tasks through a chat model prompted as a router (needs that provider's key, and it costs money)"));
  } else {
    const llmSpec = typeof flags.llm === "string" ? flags.llm : "gemini";
    const { arm: llmArm, stats } = await llmRouterArm(configFor({}), set, { spec: llmSpec });
    arms.push(llmArm);
    if (llmArm.measured) console.error(`llm arm: ${stats.spec} · ${stats.chunks} call(s) · ${stats.input_tokens} in / ${stats.output_tokens} out tokens${stats.failures.length ? ` · ${stats.failures.length} unanswered` : ""}`);
  }

  const metrics = arms.map((a) => scoreArm(rulesConfig, set, a));
  const meta = {
    set: setFile,
    tasks: set.length,
    engine: benchEngineLabel(live ? "jev" : "recorded"),
    live,
    assumed: `costs assume ${ASSUMED_TOKENS_PER_TASK.input.toLocaleString()} input + ${ASSUMED_TOKENS_PER_TASK.output.toLocaleString()} output tokens per task at list prices`,
  };
  console.log(flags.json ? JSON.stringify({ meta, metrics }, null, 2) : renderBenchTable(metrics, meta));
  return 0;
}

// ------------------------------------------------------------------ bf demo
async function cmdDemo(flags: Record<string, string | boolean>): Promise<number> {
  const planFile = typeof flags.plan === "string" ? flags.plan : path.join(REPO_BENCH, "demo-plan.json");
  const { goal = "", tasks } = readPlan(planFile);
  const live = flags.live === true;
  const sensitiveLane = flags["sensitive-lane"] === "local" ? "local" : "strong";
  const recordFile = typeof flags.record === "string" ? flags.record : path.join(REPO_BENCH, "demo-recording.json");
  const double = live ? undefined : await offlineDouble(recordFile);
  try {
    const jevConfig = configFor({
      providers: double ? { typesafe: { baseUrl: double.url, apiKey: "bf-offline" } } : {},
      routing: { ...(live ? { engine: "jev" } : offlineRouting(double!.source)), sensitiveLane },
    });
    const rulesConfig = configFor({ routing: { engine: "rules" } });
    const offConfig = configFor({ routing: { engine: "off" } });

    const started = Date.now();
    const jev = await routePlanTasks(jevConfig, tasks, { goal, engine: "jev" });
    const jevMs = Date.now() - started;
    const rules = await routePlanTasks(rulesConfig, tasks, { goal, engine: "rules" });
    const none = await routePlanTasks(offConfig, tasks, { goal, engine: "off" });

    const crewCost = (r: RouteResult) => tasks.reduce((sum, t) => sum + laneCostUsd(jevConfig, r.decisions.find((d) => d.id === t.id)?.lane ?? "unclear"), 0);
    const strongCost = laneCostUsd(jevConfig, "strong") * tasks.length;
    const jevCrew = crewCost(jev);
    const rulesCrew = crewCost(rules);
    const offCrew = laneCostUsd(jevConfig, "fast") * tasks.length;
    const summary = {
      goal,
      plan_file: planFile,
      tasks: tasks.length,
      with_jev: { answered_by: jev.answered_by, routing_ms: jevMs, routing_usd: jev.cost_usd, state_tokens: jev.state_tokens, escalated: jev.escalated, policy_hits: jev.policy_hits, crew_cost_usd: round4(jevCrew), vs_all_strong_pct: round1(((strongCost - jevCrew) / strongCost) * 100), lanes: countBy(jev.decisions) },
      without_jev_rules: { crew_cost_usd: round4(rulesCrew), lanes: countBy(rules.decisions), escalated: rules.escalated },
      without_jev_off: { model: offConfig.defaults.model, crew_cost_usd: round4(offCrew), note: "every task runs on defaults.model — what Break Free did before routing existed" },
      all_strong_usd: round4(strongCost),
      assumed_tokens_per_task: ASSUMED_TOKENS_PER_TASK,
      sensitive_lane: sensitiveLane,
      mode: live ? "live" : "recorded decisions replayed through the real code path",
    };

    if (flags.json) {
      console.log(JSON.stringify({ summary, with_jev: jev.decisions, without_jev_rules: rules.decisions }, null, 2));
      return 0;
    }
    console.log(`# bf demo — "${goal}" (${tasks.length} tasks)\n`);
    console.log("## With Jev — one call routes the whole plan\n");
    console.log(renderRouteTable(jev));
    console.log("\n## Without Jev — deterministic rules\n");
    console.log(renderRouteTable(rules));
    console.log("\n## Without Jev — routing off (pre-routing behaviour)\n");
    console.log(renderRouteTable(none));
    console.log("\n## Cost (assumed budget per task, list prices)\n");
    console.log(`  Jev:        $${summary.with_jev.crew_cost_usd} crew + $${jev.cost_usd.toFixed(6)} routing — ${summary.with_jev.vs_all_strong_pct}% cheaper than all-strong`);
    console.log(`  rules:      $${summary.without_jev_rules.crew_cost_usd} crew`);
    console.log(`  all strong: $${summary.all_strong_usd} crew`);
    console.log(`  latency:    ${jevMs} ms for ${tasks.length} tasks (${Math.round(jevMs / tasks.length)} ms/task), state ${jev.state_tokens} tokens`);
    const escalated = jev.decisions.filter((d) => d.escalated);
    if (escalated.length) {
      console.log("\n## Handed back to the lead\n");
      for (const d of escalated) console.log(`  ${d.id}: ${d.reason}${d.confidence !== null ? ` (confidence ${d.confidence.toFixed(2)})` : ""} — lanes ${formatLanes(d.probabilities)}`);
    }
    const policy = jev.decisions.filter((d) => d.policy_hits.length || d.requires_review);
    if (policy.length) {
      console.log(`\n## Guardrail (sensitiveLane: ${summary.sensitive_lane}) — these get an independent review\n`);
      for (const d of policy) console.log(`  ${d.id}: lane ${d.lane}${d.policy_hits.length ? ` (policy: ${d.policy_hits.join(", ")})` : ` (sensitive p=${d.sensitive_prob?.toFixed(2)})`}${d.lane === "local" ? " — data stays on this machine" : ""}`);
    }
    console.log(`\n${summary.mode}`);
    return 0;
  } finally {
    await double?.close();
  }
}

function formatLanes(probs: Record<string, number> | null): string {
  if (!probs) return "n/a";
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k} ${Number(v).toFixed(2)}`)
    .join(" ");
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const round1 = (n: number) => Math.round(n * 10) / 10;
function countBy(decisions: RouteDecision[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of decisions) out[d.lane] = (out[d.lane] ?? 0) + 1;
  return out;
}

// ------------------------------------------------------------------ bf scenarios
async function cmdScenarios(flags: Record<string, string | boolean>): Promise<number> {
  const setFile = typeof flags.set === "string" ? flags.set : path.join(REPO_BENCH, "scenarios.json");
  const scenarios = loadScenarios(setFile);
  if (!scenarios.length) {
    console.error(`no scenarios in ${setFile}`);
    return 2;
  }
  const live = flags.live === true;
  const recordFile = typeof flags.record === "string" ? flags.record : path.join(REPO_BENCH, "scenario-recording.json");
  const double = live ? undefined : await offlineDouble(recordFile);
  try {
    const jevConfig = configFor({
      providers: double ? { typesafe: { baseUrl: double.url, apiKey: "bf-offline" } } : {},
      routing: live ? { engine: "jev" } : offlineRouting(double!.source),
    });
    const rulesConfig = configFor({ routing: { engine: "rules" } });

    const scores: ScenarioScore[] = [];
    const recorded: { scenario: string; tasks: ScenarioTask[]; decisions: RouteDecision[] }[] = [];
    const latency: Record<string, { ms: number; call_usd: number }> = {};
    let answeredByJev = false;
    for (const sc of scenarios) {
      // One decision pass per scenario, the same shape run_plan uses — so the latency reported
      // below is the latency a real plan pays for its routing.
      const jev = await routePlanTasks(jevConfig, sc.tasks, { goal: sc.title, engine: "jev" });
      const rules = await routePlanTasks(rulesConfig, sc.tasks, { goal: sc.title, engine: "rules" });
      const statics = staticArms(jevConfig, sc.tasks);
      const arms = [routedArm("jev", live ? "Jev (live)" : "Jev (replayed from a live recording)", jev), routedArm("rules", "static rules", rules), statics.off, statics.lead];
      // Replaying answers locally in milliseconds; report the LIVE measurement instead, and say so.
      const prev = double?.record.latency?.[sc.id];
      scores.push(scoreScenario(jevConfig, sc, arms, live || !prev ? { jev: jev.ms, rules: rules.ms } : { jev: prev.ms, rules: rules.ms }));
      if (jev.answered_by === "jev") answeredByJev = true;
      if (live && jev.answered_by === "jev") {
        recorded.push({ scenario: sc.id, tasks: sc.tasks, decisions: jev.decisions });
        latency[sc.id] = { ms: jev.ms, call_usd: jev.cost_usd };
      }
    }

    const t = totals(scores, {
      jev: { label: live ? "Jev (live)" : "Jev (replayed)", measured: answeredByJev, ...(answeredByJev ? {} : { note: "Jev did not answer; the jev column is rules" }) },
      rules: { label: "static rules", measured: true },
      off: { label: "no routing", measured: true },
      lead: { label: "lead picks (expert)", measured: true },
    });
    if (live && recorded.length) recordScenarioDecisions(recordFile, recorded, "jev", latency);
    if (flags.json) console.log(JSON.stringify({ meta: { file: setFile, live, scenarios: scenarios.length, tasks: t.tasks }, totals: t, scores }, null, 2));
    else {
      console.log(renderScenarioReport(scores, t, { live, file: recordFile }));
      console.log("\n## One line per scenario\n");
      console.log(renderScenarioDigest(scores));
    }
    return 0;
  } finally {
    await double?.close();
  }
}

// ------------------------------------------------------------------ bf bench tripwire
async function cmdBenchTripwire(flags: Record<string, string | boolean>): Promise<number> {
  const setFile = typeof flags.set === "string" ? flags.set : path.join(REPO_BENCH, "tripwire-set.jsonl");
  if (!fs.existsSync(setFile)) {
    console.error(`no seeded diff set at ${setFile}`);
    return 2;
  }
  const rows = fs.readFileSync(setFile, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { id: string; task: string; acceptance?: string; hunk: string; label: "bad" | "clean"; kinds: string[] });
  const live = flags.live === true;
  const recordFile = typeof flags.record === "string" ? flags.record : path.join(REPO_BENCH, "tripwire-recording.json");
  const double = live ? undefined : await offlineDouble(recordFile);
  // A recording that does not cover this set is worse than a missing one: unanswered rows come back as
  // `allow`, so the bench reports a beautiful 0% false-flag rate computed from nothing. Refuse it.
  const unanswered = double ? rows.filter((r) => !double.record.decisions?.[r.id]) : [];
  if (unanswered.length) {
    console.error(
      `the recording ${recordFile} has no decision for ${unanswered.length} of ${rows.length} diffs in ${setFile}\n` +
        `  (first: ${unanswered.slice(0, 3).map((r) => r.id).join(", ")}). It was recorded against a different set.\n` +
        `  Point --record at the matching recording, or run with --live to record one.`,
    );
    await double?.close();
    return 2;
  }
  try {
    const config = configFor({ providers: double ? { typesafe: { baseUrl: double.url, apiKey: "bf-offline" } } : {}, routing: live ? { engine: "jev" } : offlineRouting(double!.source), tripwire: { enabled: true } });
    const outcomes: TripwireOutcome[] = [];
    const recorded: Record<string, DoubleDecision> = {};
    for (const row of rows) {
      // Offline, the double is keyed `<taskId>__<question>`; every row here asks about `h0`, so the
      // recorded decision for THIS row has to be re-seeded under that key before the call. Reading it
      // from `double.record` (the loaded recording) is what makes the offline replay real — seeding
      // `recorded`, which is only filled on a live run, replayed nothing at all.
      if (double) double.setDecisions({ h0: (double.record.decisions?.[row.id] as DoubleDecision) ?? {} });
      const r = await runTripwire(config, row.hunk, row.task, { acceptance: row.acceptance });
      const h = r.hunks[0];
      const fired: string[] = h
        ? TRIPWIRE_CHECKS.filter((c) => {
            const v = h.flags[c.key];
            return typeof v === "number" && v >= config.tripwire.reviewAt;
          }).map((c) => c.key)
        : [];
      if (h && typeof h.flags.risk === "number" && h.flags.risk >= config.tripwire.reviewRisk) fired.push("risk");
      outcomes.push({ id: row.id, verdict: h?.verdict ?? "allow", fired, ms: r.ms, cost_usd: r.cost_usd, priced: r.priced, ran: r.ran });
      if (live && h) {
        recorded[row.id] = {
          lane: "fast",
          confidence: 0.9,
          difficulty: 2,
          sensitive: 0,
          context: 0,
          test_weakened: h.flags.test_weakened ?? 0,
          security_touch: h.flags.security_touch ?? 0,
          destructive_data: h.flags.destructive_data ?? 0,
          scope_creep: h.flags.scope_creep ?? 0,
          risk: h.flags.risk ?? 0,
          risk_confidence: h.flags.confidence ?? 0.8,
        };
      }
    }
    // A live run that did not actually reach an engine must not overwrite a good recording. Without
    // a key, `runTripwire` returns `ran: false` and the loop still captures a row of ZEROS for each
    // diff — a structurally valid file recording nothing, which on replay reads as a flawless 0%
    // false-flag rate. Refuse to write, and do not score.
    const ranCount = outcomes.filter((o) => o.ran).length;
    if (live && ranCount < rows.length) {
      console.error(
        `the tripwire ran on only ${ranCount} of ${rows.length} diffs — nothing recorded to ${recordFile}.\n` +
          `  Check the \`typesafe\` provider: it needs TYPESAFE_API_KEY or providers.typesafe.apiKey.`,
      );
      return 2;
    }
    const metrics = scoreTripwire(rows, outcomes);
    if (live && Object.keys(recorded).length) {
      fs.writeFileSync(recordFile, JSON.stringify({ note: "Recorded TypeSafe decisions for bench/tripwire-set.jsonl, captured live. Replayed offline through the real client so `bf bench tripwire` needs no key. Regenerate: bf bench tripwire --live --record bench/tripwire-recording.json", answered_by: "jev", diffs: rows.length, decisions: recorded }, null, 2) + "\n");
      console.error(`wrote ${recordFile}`);
    }
    if (flags.json) console.log(JSON.stringify({ meta: { set: setFile, live, diffs: rows.length }, metrics, outcomes }, null, 2));
    else console.log(renderTripwireMetrics(metrics, { set: setFile, live, targetsShown: true }));
    return 0;
  } finally {
    await double?.close();
  }
}

// ------------------------------------------------------------------ bf validate

/**
 * The text blocks of a tool reply. Read field by field rather than asserted into a shape: this is
 * another process's answer, and a reply without content must read as empty, not as a lie.
 */
function asText(reply: unknown): string {
  if (!reply || typeof reply !== "object" || !("content" in reply) || !Array.isArray(reply.content)) return "";
  return reply.content.map((c) => (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c && typeof c.text === "string" ? c.text : "")).join("\n");
}

/**
 * Runs real work to check the labels. The workspace is reset to HEAD between runs so each arm
 * starts from the same tree — which means it must be clean when you start, and it removes
 * untracked files it created (git-clean honours .gitignore, so node_modules stays).
 *
 * A run whose verify fails is repeated once (`--attempts`, default 2). Criterion 3 asks what the
 * pass rate is after one retry, which a single pass/fail cannot answer.
 */
async function cmdValidate(flags: Record<string, string | boolean>): Promise<number> {
  const setFile = typeof flags.set === "string" ? flags.set : path.join(REPO_BENCH, "route-set.jsonl");
  const ws = path.resolve(typeof flags.workspace === "string" ? flags.workspace : process.cwd());
  const limit = typeof flags.tasks === "string" ? Number(flags.tasks) : 3;
  const withRouting = flags["with-routing"] === true;
  // Capped at 3: each extra attempt is another full worker run on every arm that failed verify.
  const maxAttempts = typeof flags.attempts === "string" ? Math.min(3, Math.max(1, Math.floor(Number(flags.attempts)) || 1)) : 2;
  // Either shipped set works: the 60-task JSONL and the scenario file differ only in what they
  // call the lead's lane, which `toValidateTasks` absorbs.
  const raw = setFile.endsWith(".jsonl") ? (loadLabeledSet(setFile) as unknown as RawValidateTask[]) : (loadScenarios(setFile).flatMap((s) => s.tasks) as unknown as RawValidateTask[]);
  const tasks = toValidateTasks(raw).slice(0, Math.max(1, limit));
  if (!tasks.length) {
    console.error(`no tasks with a verify command in ${setFile}`);
    return 2;
  }

  const git = (args: string[]) => spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" });
  const clean = git(["status", "--porcelain"]);
  if (clean.status !== 0) {
    console.error(`${ws} is not a git repository — bf validate needs one so it can reset between runs`);
    return 2;
  }
  if (clean.stdout.trim() && flags.force !== true) {
    console.error(`${ws} has uncommitted changes.\n  bf validate resets the tree to HEAD between runs; commit, stash, or pass --force.`);
    return 2;
  }
  // Say it out loud. This command resets a git tree repeatedly and cannot tell a worker's edit from
  // yours, so the only real protection is that you know it is running and do not edit there meanwhile.
  console.error(
    `bf validate: workspace ${ws}\n` +
      `  reset to HEAD between runs, and files the runs add are deleted. Do not edit files there while this runs.`,
  );

  const config = configFor({ routing: withRouting ? { engine: "jev" } : {} });

  const entry = new URL("./index.js", import.meta.url).pathname;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", userConfigPath()], env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "bf-validate", version: "0" });
  await client.connect(transport);

  const resetTree = () => {
    git(["checkout", "--", "."]);
    git(["clean", "-fdq"]);
  };
  /** Nothing ran, and the reason is the reason — not "no lane mapped", which is what an engine that
   *  never answered used to be reported as. */
  const notRun = (t: ValidateTask, arm: ValidateArm, reason: string): TaskOutcome => ({ task: t.id, arm, lane: "(none)", confidence: null, verify_ok: null, model: "", ms: 0, not_run: reason });

  /** One real run of one task on one lane; the verify result is the gateway's own exit code. */
  const runOn = async (t: ValidateTask, arm: ValidateArm, lane: string | null, model: string | null, confidence: number | null, brief?: string): Promise<TaskOutcome> => {
    const started = Date.now();
    if (model === null) return notRun(t, arm, `lane ${lane ?? "(none)"} maps to no model, so this arm has nothing to run it on`);
    try {
      const r = await client.callTool({
        name: "run_plan",
        arguments: {
          goal: `bf validate ${t.id} on ${lane ?? model}`,
          tasks: [{ id: `${t.id}--${arm}${brief ? "-retry" : ""}`, task: brief ? `${brief}\n\n${t.task}` : t.task, acceptance: t.acceptance, verify: t.verify, files: t.files, tags: t.tags, model, capabilities: ["read", "write", "run"] }],
        },
      });
      const text = asText(r);
      const meta = JSON.parse(text.slice(text.lastIndexOf("\nmeta: ") + 7)) as { results: { model?: string; verify?: { ok?: boolean; exit?: number | null } | null; error?: string }[] };
      const res = meta.results[0];
      const verify = res?.verify ?? null;
      const ok = verify ? verify.ok === true : null;
      return { task: t.id, arm, lane: lane ?? model, confidence, first_attempt_ok: ok, verify_ok: ok, attempts: 1, model: res?.model ?? model, ms: Date.now() - started, ...(verify?.exit != null ? { verify_exit: verify.exit } : {}), ...(res?.error ? { error: res.error } : {}) };
    } catch (e) {
      return { task: t.id, arm, lane: lane ?? model, confidence, verify_ok: null, model: "", ms: Date.now() - started, error: (e as Error).message };
    }
  };

  /**
   * One arm: the attempt, then — only if its verify failed — one retry on the same lane, with the
   * failed verify's command and exit code handed to the worker. Both results are kept (`attempts`,
   * `first_attempt_ok`), because criterion 3 asks for the rate after a retry and criterion 2 asks
   * for the rate without one. The tree is reset first, so a retry is an independent attempt rather
   * than an inheritance of the first one's half-finished edits.
   */
  const runArm = async (t: ValidateTask, arm: ValidateArm, lane: string | null, model: string | null, confidence: number | null): Promise<TaskOutcome> => {
    resetTree();
    const first = await runOn(t, arm, lane, model, confidence);
    if (first.not_run || maxAttempts < 2 || first.verify_ok !== false) return first;
    const brief = [
      "A previous attempt at this task ran and its verify command failed, so the task is not complete.",
      `  command: ${t.verify}`,
      `  exit: ${first.verify_exit ?? "non-zero"}`,
      "The gateway's verify step records no output, so diagnose it yourself: run that command and find the actual failure before changing anything.",
    ].join("\n");
    resetTree();
    const retried = await runOn(t, arm, lane, model, confidence, brief);
    return { ...retried, attempts: 2, first_attempt_ok: first.verify_ok };
  };

  /** The routed arm. Whatever the engine answers — a lane, an escalation, or nothing at all — the
   *  row says which one it was; the reasons are different problems and must not read alike. */
  const runRouted = async (t: ValidateTask): Promise<TaskOutcome> => {
    // The engine travels on the call, not in the config: the spawned server reads the user's config,
    // whose `routing.engine` defaults to `off`, so a config-only override never reaches it.
    const routed = await client.callTool({ name: "route", arguments: { engine: "jev", goal: `bf validate ${t.id}`, tasks: [{ id: t.id, task: t.task, acceptance: t.acceptance, files: t.files, tags: t.tags }] } });
    const body = JSON.parse(asText(routed)) as { engine: string; engine_source: string; threshold: number; degraded?: string | null; decisions: { id: string; lane: string; model: string | null; confidence: number | null; reason: string }[] };
    const decision = body.decisions.find((d) => d.id === t.id);
    if (!decision) {
      const degraded = body.degraded ? ` (degraded: ${body.degraded})` : "";
      return notRun(t, "jev", `the routing engine answered "${body.engine}" (source: ${body.engine_source})${degraded} and returned no decision for this task, so no lane was ever chosen`);
    }
    if (decision.model === null) {
      const why =
        decision.reason === "confidence"
          ? `the engine handed this task back to the lead: confidence ${decision.confidence?.toFixed(2) ?? "?"} is below the ${body.threshold} threshold (lane ${decision.lane})`
          : `the engine handed this task back to the lead: reason "${decision.reason}" on lane ${decision.lane}`;
      return notRun(t, "jev", `${why} — an escalated task is not run by the crew, so it is not a result for this arm`);
    }
    return runArm(t, "jev", decision.lane, decision.model, decision.confidence ?? null);
  };

  const outcomes: TaskOutcome[] = [];
  const unfalsifiable: string[] = [];
  try {
    // Before spending a single worker call: a verify command that already passes on the untouched
    // tree cannot tell whether the work was done, so any "pass" from it is vacuous. Skip those
    // tasks rather than report a clean result that means nothing.
    for (const t of tasks) {
      const pre = await runCommand(config, ws, t.verify ?? "", { timeoutMs: 120_000 }).catch(() => undefined);
      if (pre?.ok && flags["include-unfalsifiable"] !== true) {
        unfalsifiable.push(t.id);
        console.error(`  skip ${t.id}: \`${t.verify}\` already passes on the untouched tree, so it cannot discriminate`);
      }
    }
    for (const t of tasks) {
      if (unfalsifiable.includes(t.id)) continue;
      outcomes.push(await runArm(t, "claimed", t.cheapest_passing_lane, laneFor(config, t.cheapest_passing_lane), null));
      outcomes.push(await runArm(t, "lead", t.lane, laneFor(config, t.lane), null));
      if (withRouting) outcomes.push(await runRouted(t));
      console.error(`  ran ${t.id} (${outcomes.filter((o) => o.task === t.id).length} arms)`);
    }
  } finally {
    resetTree();
    await client.close();
  }

  const report = summarise(outcomes, tasks, config, unfalsifiable);
  if (flags.json) console.log(JSON.stringify({ meta: { workspace: ws, set: setFile, with_routing: withRouting, max_attempts: maxAttempts }, report }, null, 2));
  else console.log(renderValidation(report, { workspace: ws, set: setFile, withRouting }));
  // An arm can be entirely dead — a lane mapped to nothing, a key missing, every worker errored —
  // while the labels themselves are clean. Reporting success there is the bug this exit code fixes.
  return exitCodeFor(report);
}

// ------------------------------------------------------------------ bf ab
/**
 * One plan, two arms, one commit: arm A routed, arm B with every lane pinned to `strong`.
 *
 * Issue #22's criteria 2, 3 and 8 are about what the router does on real work, and `bf validate`
 * cannot answer them: it compares the lanes the LABELS name. Nothing had ever run the SAME plan
 * twice and compared what verify said, so this does — once with the configured routing engine, once
 * with the whole crew on the `strong` alias — and reads the comparison back out of the scorecard
 * lines the gateway wrote. Pass/fail is the scorecard `verify_ok` field, the gateway's own exit
 * code; no worker's report text is consulted anywhere.
 *
 * Two servers, not one, and that is load-bearing. Arm B's pin is a config fact (`routing.laneMap`),
 * not a per-task one: `run_plan` never routes a task that names a `model`, and a task that was not
 * routed writes NO scorecard — so pinning every task with `model: <strong>` would leave the
 * all-strong arm with nothing to report and the comparison would have one side. Mapping every lane
 * to strong runs the whole plan on strong through the same routing path, so both arms produce
 * scorecards. The engine travels on the `run_plan` call for the second reason `bf validate` found
 * the hard way: a spawned server reads the user's config, whose `routing.engine` defaults to `off`.
 *
 * The workspace is reset to HEAD between passes (arm A, arm B, then each arm's retry) so every pass
 * starts from the same commit — that is what makes it "the same commit twice" rather than "arm B
 * inheriting arm A's edits". As with `bf validate`, that means it must be clean to start.
 */
async function cmdAb(flags: Record<string, string | boolean>): Promise<number> {
  const planFile = typeof flags.plan === "string" ? flags.plan : undefined;
  if (!planFile) {
    console.error("usage: bf ab --plan <file.json> [--workspace <git repo>] [--engine jev|rules|off] [--json] [--force]");
    return 2;
  }
  const ws = path.resolve(typeof flags.workspace === "string" ? flags.workspace : process.cwd());
  const engine = typeof flags.engine === "string" ? (flags.engine as RoutingEngine) : undefined;
  const { goal, tasks: rawTasks } = readPlan(planFile);
  if (!rawTasks.length) {
    console.error(`no tasks in ${planFile}`);
    return 2;
  }
  // Only the fields `run_plan` takes, so a plan file with extra keys (a `title`, say) cannot be
  // rejected by the tool's own schema.
  const tasks: PlanTask[] = rawTasks.map((t) => ({
    id: t.id,
    task: t.task,
    ...(t.acceptance ? { acceptance: t.acceptance } : {}),
    ...(t.verify ? { verify: t.verify } : {}),
    ...(t.files ? { files: t.files } : {}),
    ...(t.tags ? { tags: t.tags } : {}),
  }));

  const git = (args: string[]) => spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" });
  const clean = git(["status", "--porcelain"]);
  if (clean.status !== 0) {
    console.error(`${ws} is not a git repository — bf ab needs one so both arms start from the same commit`);
    return 2;
  }
  if (clean.stdout.trim() && flags.force !== true) {
    console.error(`${ws} has uncommitted changes.\n  bf ab resets the tree to HEAD between passes; commit, stash, or pass --force.`);
    return 2;
  }
  console.error(
    `bf ab: workspace ${ws}\n` +
      `  the plan runs TWICE on this commit (routed, then all-strong), plus one retry pass per arm, and it spends real money.\n` +
      `  reset to HEAD between passes, and files the runs add are deleted. Do not edit files there while this runs.`,
  );

  const baseConfig = configFor({});
  const strongCand = resolveCandidates(baseConfig, "strong", { useGlobalChain: false }).find((c) => !c.provider.unusableReason);
  if (!strongCand) {
    console.error("the `strong` alias resolves to no usable candidate, so there is no all-strong arm to compare against — set aliases.strong in your config");
    return 2;
  }
  const strongSpec = strongCand.spec;

  const userPath = userConfigPath();
  const userJson = fs.existsSync(userPath) ? (JSON.parse(fs.readFileSync(userPath, "utf8")) as Record<string, unknown>) : {};
  const userRouting = (userJson.routing as Record<string, unknown>) ?? {};
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-ab-"));
  const routedConfig = path.join(tmp, "routed.json");
  fs.writeFileSync(routedConfig, JSON.stringify(userJson));
  const strongConfig = path.join(tmp, "all-strong.json");
  fs.writeFileSync(
    strongConfig,
    JSON.stringify({
      ...userJson,
      routing: { ...userRouting, laneMap: { ...((userRouting.laneMap as Record<string, unknown>) ?? {}), local: strongSpec, fast: strongSpec, strong: strongSpec, thinker: strongSpec, codex_handoff: strongSpec } },
    }),
  );

  const entry = new URL("./index.js", import.meta.url).pathname;
  const stdio = (configPath: string) =>
    new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath], env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>, stderr: "pipe" });
  const connect = async (configPath: string, name: string) => {
    const client = new Client({ name, version: "0" });
    await client.connect(stdio(configPath));
    return client;
  };

  const resetTree = () => {
    git(["checkout", "--", "."]);
    git(["clean", "-fdq"]);
  };
  // The ledger must exist BEFORE the arms run: `run_plan` only writes a scorecard when it is
  // tracking, and an untracked plan writes nothing for this command to read.
  const ledger = new Ledger(ws);
  if (!ledger.exists()) ledger.init();
  const rowsFor = (planName: string) => toAbRows(ledger.scorecards().filter((r) => r.plan === planName), new Map(ledger.listTasks().map((t) => [t.id, t])));
  const routedByFor = (ledgerTaskId: string) => new Map(ledger.listTasks().map((t) => [t.id, t])).get(ledgerTaskId)?.routed_by;

  /** One pass of one arm. A failed tool call is reported and the run continues: the scorecards already written are still evidence. */
  const runPass = async (client: Client, planName: string, passTasks: PlanTask[]): Promise<void> => {
    resetTree();
    try {
      const reply = await client.callTool({ name: "run_plan", arguments: { goal: planName, tasks: passTasks, ...(engine ? { routing: engine } : {}) } });
      if (reply.isError) console.error(`  ${planName}: ${asText(reply).slice(0, 400)}`);
    } catch (e) {
      console.error(`  ${planName}: ${(e as Error).message.slice(0, 300)}`);
    }
  };

  const label = goal ?? path.basename(planFile);
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const inputs: AbArmInput[] = [];
  const routedBy: string[] = [];
  for (const arm of ["routed", "strong"] as AbArmName[]) {
    const planName = `${label} [bf ab: ${arm}]`;
    const retryName = `${planName} retry`;
    console.error(`  ${arm}: running ${tasks.length} task(s)`);
    const client = await connect(arm === "routed" ? routedConfig : strongConfig, `bf-ab-${arm}`);
    try {
      await runPass(client, planName, tasks);
      const first = rowsFor(planName);
      if (arm === "routed")
        for (const r of first) {
          const rb = routedByFor(r.task);
          if (rb && !routedBy.includes(rb)) routedBy.push(rb);
        }
      // Criterion 3 is "after ONE retry": only the tasks whose verify failed, re-run with the
      // failure's own command handed to the worker. Not a re-run of the plan — that would measure
      // a different thing and double the bill.
      const retryTasks: PlanTask[] = [];
      for (const r of first) {
        if (r.verify_ok !== false || !r.plan_task) continue;
        const t = byId.get(r.plan_task);
        if (!t) continue;
        retryTasks.push({
          ...t,
          task: `A previous attempt at this task ran and its verify command failed, so the task is not complete.\n  command: ${t.verify}\n  ledger: ${r.task}\nThe gateway's verify step records no output, so diagnose it yourself: run that command and find the actual failure before changing anything.\n\n${t.task}`,
        });
      }
      if (retryTasks.length) {
        console.error(`  ${arm}: retrying ${retryTasks.length} task(s) whose verify failed`);
        await runPass(client, retryName, retryTasks);
      }
      inputs.push({ name: arm, label: arm === "routed" ? `arm A routed (${engine ?? baseConfig.routing.engine} engine)` : `arm B all-strong (every lane -> ${strongSpec})`, rows: first, retry_rows: rowsFor(retryName) });
    } finally {
      await client.close();
    }
  }

  // The window figure from `cost_report`, fetched after both arms so it covers both: it is a
  // window total (every call in the window, not only this plan), which is why the per-arm split
  // above is summed from the scorecards and this is quoted for what it is.
  let savings: AbSavings | undefined;
  try {
    const client = await connect(routedConfig, "bf-ab-report");
    try {
      const report = JSON.parse(asText(await client.callTool({ name: "cost_report", arguments: { days: 1 } }))) as { routing_savings?: AbSavings };
      savings = report.routing_savings;
    } finally {
      await client.close();
    }
  } catch (e) {
    console.error(`  cost_report unavailable: ${(e as Error).message.slice(0, 200)}`);
  }

  const report = summariseAb({ tasks: tasks.map((t) => ({ id: t.id, verify: t.verify })) }, inputs);
  const engineLabel = engine
    ? `--engine ${engine}`
    : `the configured engine (config routing.engine = ${baseConfig.routing.engine})${routedBy.length ? `, tasks routed by ${routedBy.join("/")}` : " — NO task was routed, so arm A is not a routed arm"}`;
  const meta = { workspace: ws, plan: planFile, engine: engineLabel, strong: strongSpec, ...(savings ? { savings } : {}) };
  if (flags.json) console.log(JSON.stringify({ meta: { workspace: ws, plan: planFile, engine: engineLabel, strong: strongSpec }, report, savings: savings ?? null }, null, 2));
  else console.log(renderAb(report, meta));
  return abExitCode(report);
}

const HELP = `bf — Break Free command line

  bf route --plan <file> [--engine jev|rules|off]    decide which model runs each task
  bf bench route [--live]                            score four routers against the labelled set
  bf bench tripwire [--live]                         score the diff check on labelled diffs
  bf demo [--live]                                   one plan routed three ways
  bf scenarios [--live]                              ten real workflows, routed four ways
  bf validate --workspace <git repo>                 do the labels hold? (RESETS the workspace)
  bf ab --plan <file>                                one plan, two arms: routed vs all-strong (RESETS the workspace)

  bf <command> --help                                what that command takes

Environment
  TYPESAFE_API_KEY      live Jev (routing and the tripwire)
  GEMINI_API_KEY        the frontier-LLM-as-router baseline (bf bench route)
  BREAK_FREE_ROUTING    session-wide override: jev | rules | off
`;

/**
 * Every command's flags, and its own `--help`.
 *
 * This table exists because `bf validate --help` used to RUN the command with its defaults: `--help`
 * was handled only at the top level, and unknown flags were silently ignored. `bf validate` resets
 * its workspace to HEAD between runs, so a probing or mistyped invocation could reset a repository —
 * and one did. Now `--help` prints and exits, and an unknown flag is an error rather than a default.
 */
const COMMANDS: Record<string, { flags: string[]; usage: string }> = {
  route: {
    flags: ["plan", "engine", "threshold", "live", "record", "json"],
    usage: "bf route --plan <file.json|file.jsonl> [--engine jev|rules|off] [--threshold 0.7] [--live] [--record <file>] [--json]\n    Decide which model runs each task. Same code path run_plan uses. Nothing is run.",
  },
  "bench route": {
    flags: ["set", "engine", "live", "record", "json", "llm"],
    usage: "bf bench route [--set bench/route-set.jsonl] [--engine rules,jev] [--live] [--llm [spec]] [--record <file>] [--json]\n    Score lead picks, static rules and Jev against the labelled set. Offline it replays\n    bench/jev-recording.json; --live calls api.typesafe.ai (needs TYPESAFE_API_KEY) and writes the\n    capture with --record. A frontier-LLM-as-router arm needs a chat provider key (e.g. GEMINI_API_KEY).",
  },
  "bench tripwire": {
    flags: ["set", "live", "record", "json"],
    usage: "bf bench tripwire [--set bench/tripwire-set.jsonl] [--live] [--record <file>] [--json]\n    Score the diff check against a labelled set. Offline it replays bench/tripwire-recording.json;\n    --live needs TYPESAFE_API_KEY and writes the capture with --record.\n    A recording that does not cover the set is refused rather than scored.",
  },
  demo: {
    flags: ["plan", "live", "record", "json", "sensitive-lane"],
    usage: "bf demo [--plan bench/demo-plan.json] [--live] [--record <file>] [--sensitive-lane local|strong] [--json]\n    One plan routed three ways: Jev, deterministic rules, and routing off.",
  },
  scenarios: {
    flags: ["set", "live", "record", "json"],
    usage: "bf scenarios [--set bench/scenarios.json] [--live] [--record <file>] [--json]\n    Ten real workflows, routed four ways (jev, rules, off, lead).",
  },
  validate: {
    flags: ["set", "workspace", "tasks", "with-routing", "attempts", "json", "force", "include-unfalsifiable"],
    usage:
      "bf validate [--set bench/route-set.jsonl] --workspace <git repo> [--tasks 3] [--with-routing] [--attempts 2] [--json] [--force]\n" +
      "    Do the labels hold? Runs each task on the lane the label calls cheapest AND on the lane a\n" +
      "    lead would pick, then reads the gateway's own verify exit code. A run whose verify fails is\n" +
      "    repeated up to --attempts times (default 2), and both first-pass and after-retry are reported.\n" +
      "    THE WORKSPACE IS RESET TO HEAD BETWEEN RUNS. It must be clean to start (--force overrides),\n" +
      "    it defaults to the current directory, and it will delete files the runs added. Do not edit\n" +
      "    files in it while a validation is running.",
  },
  ab: {
    flags: ["plan", "workspace", "engine", "json", "force"],
    usage:
      "bf ab --plan <file.json> [--workspace <git repo>] [--engine jev|rules|off] [--json] [--force]\n" +
      "    One plan, run twice on the current commit: arm A with the configured routing engine, arm B with\n" +
      "    every lane pinned to the `strong` alias. Prints criteria 2 (first-pass verify rate per arm and\n" +
      "    the gap), 3 (the same after one retry) and 8 (the >=0.8 confidence band's verify failure rate\n" +
      "    against the <0.5 band), plus each arm's spend. Every pass/fail is the scorecard `verify_ok`\n" +
      "    field — the gateway's own exit code, never a worker's report. A task with no verify command, and\n" +
      "    a row with no verify result, are excluded and counted; a criterion that misses its target prints\n" +
      "    as MISS and exits non-zero.\n" +
      "    THE WORKSPACE IS RESET TO HEAD BETWEEN PASSES. It must be clean to start (--force overrides),\n" +
      "    it defaults to the current directory, and it will delete files the runs added.",
  },
  firstmate: {
    flags: ["harness", "task", "fm-home", "json", "dry-run"],
    usage: "bf firstmate [--harness claude|grok|pi|omp|codex|opencode|cursor-agent] [--task \"...\"] [--fm-home <dir>] [--dry-run] [--json]\n    Start a firstmate-led session inside the provisioned distro, connected to this gateway.\n    firstmate leads that session: it owns the crew, the worktrees and the merge authority.\n    Refuses when the distro is drifted or dirty, because that would run instructions nobody\n    approved. --dry-run prints the exact command instead of running it.",
  },
  help: { flags: [], usage: "bf help" },
};


/**
 * Start a firstmate-led session.
 *
 * The launcher lives here rather than in the MCP server on purpose: a server cannot make an
 * already-running client adopt firstmate's identity, because the distro is instructions a
 * harness reads at startup and startup is over. Launching a new session is the only honest way
 * for break-free to put firstmate in the lead.
 */
async function cmdFirstmate(flags: Record<string, string | boolean>): Promise<number> {
  const { loadConfig } = await import("./config.js");
  const { planLaunch, FIRSTMATE_LABEL } = await import("./firstmate.js");
  const { execFileSync, spawnSync } = await import("node:child_process");

  const cfg = loadConfig().config;
  const onPath = (bin: string) => {
    try {
      execFileSync("command", ["-v", bin], { stdio: "ignore", shell: "/bin/sh" });
      return true;
    } catch {
      return false;
    }
  };
  const plan = planLaunch(cfg.firstmate, {
    harness: typeof flags.harness === "string" ? flags.harness : undefined,
    task: typeof flags.task === "string" ? flags.task : undefined,
    fmHome: typeof flags["fm-home"] === "string" ? (flags["fm-home"] as string) : undefined,
    available: onPath,
  });

  if (flags.json) {
    console.log(JSON.stringify(plan, null, 2));
    return plan.ok ? 0 : 1;
  }
  if (!plan.ok) {
    console.error(`bf firstmate: ${plan.reason}`);
    return 1;
  }

  const shown = [plan.command, ...plan.args].join(" ");
  if (flags["dry-run"]) {
    console.log(`${plan.label}\n  cd ${plan.cwd}\n  ${Object.entries(plan.env).map(([k, v]) => `${k}=${v}`).join(" ")} ${shown}`);
    return 0;
  }

  // Say which system is about to lead, before it takes the terminal.
  console.log(`${plan.label} — ${shown} in ${plan.cwd}`);
  const r = spawnSync(plan.command!, plan.args, { cwd: plan.cwd, env: { ...process.env, ...plan.env }, stdio: "inherit" });
  return r.status ?? 1;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { cmd, sub, flags } = parseArgs(argv);
  const key = sub && COMMANDS[`${cmd} ${sub}`] ? `${cmd} ${sub}` : cmd;
  const spec = COMMANDS[key];

  if (cmd === "help" || cmd === "--help" || flags.help === true) {
    console.log(spec && cmd !== "help" ? `bf ${key}\n\n${spec.usage}` : HELP);
    return 0;
  }
  if (spec) {
    const unknown = Object.keys(flags).filter((f) => !spec.flags.includes(f));
    if (unknown.length) {
      console.error(`bf ${key}: unknown flag${unknown.length > 1 ? "s" : ""} ${unknown.map((u) => `--${u}`).join(", ")}\n  bf ${key} --help`);
      return 2;
    }
  }

  if (cmd === "route") return cmdRoute(flags);
  if (cmd === "bench" && sub === "route") return cmdBench(flags);
  if (cmd === "bench" && sub === "tripwire") return cmdBenchTripwire(flags);
  if (cmd === "demo") return cmdDemo(flags);
  if (cmd === "scenarios") return cmdScenarios(flags);
  if (cmd === "validate") return cmdValidate(flags);
  if (cmd === "firstmate") return cmdFirstmate(flags);
  console.log(HELP);
  return cmd === "help" || cmd === "--help" ? 0 : 2;
}

// Only run when executed, never when imported by a test.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const self = path.resolve(new URL(import.meta.url).pathname);
if (entry === self) process.exitCode = await main();

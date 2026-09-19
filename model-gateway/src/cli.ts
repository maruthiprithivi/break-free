#!/usr/bin/env node
/**
 * `bf` — the Break Free command line.
 *
 *   bf route  --plan <file> [--engine jev|rules|off] [--threshold 0.7] [--json]
 *   bf bench route [--set <file>] [--engine rules,jev] [--live] [--record <file>] [--json]
 *   bf demo [--plan <file>] [--live] [--json]
 *
 * `bf route`, `bf bench route` and `bf demo` call the same functions `run_plan` calls, so what
 * you see here is what the gateway does — not a reimplementation. Offline (the default) the Jev
 * arm answers from a recorded decision set replayed through the real TypeSafe client; `--live`
 * calls api.typesafe.ai and needs TYPESAFE_API_KEY.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, userConfigPath, type GatewayConfig } from "./config.js";
import { routePlanTasks, type RouteDecision, type RouteResult, type RoutingEngine, type RouteTaskInput } from "./routing.js";
import { ASSUMED_TOKENS_PER_TASK, benchEngineLabel, decisionArm, laneCostUsd, leadArm, loadLabeledSet, renderBenchTable, scoreArm, unmeasuredLlmArm, type LabeledTask, type RouterArm } from "./bench.js";
import { startTypeSafeDouble, type DoubleDecision, type TypeSafeDouble } from "./jev-double.js";
import { loadScenarios, recordScenarioDecisions, renderScenarioDigest, renderScenarioReport, routedArm, scoreScenario, staticArms, totals, type ScenarioRecording, type ScenarioScore, type ScenarioTask } from "./scenarios.js";
import { laneFor, renderValidation, summarise, toValidateTasks, type RawValidateTask, type TaskOutcome, type ValidateArm, type ValidateTask } from "./validate.js";
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

  arms.push(unmeasuredLlmArm("needs a frontier provider key: set one with the configure_provider tool, then this arm sends the same tasks through a chat model prompted as a router"));

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
 * Runs real work to check the labels. The workspace is reset to HEAD between runs so each arm
 * starts from the same tree — which means it must be clean when you start, and it removes
 * untracked files it created (git-clean honours .gitignore, so node_modules stays).
 */
async function cmdValidate(flags: Record<string, string | boolean>): Promise<number> {
  const setFile = typeof flags.set === "string" ? flags.set : path.join(REPO_BENCH, "route-set.jsonl");
  const ws = path.resolve(typeof flags.workspace === "string" ? flags.workspace : process.cwd());
  const limit = typeof flags.tasks === "string" ? Number(flags.tasks) : 3;
  const withRouting = flags["with-routing"] === true;
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
  const configFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bf-validate-")), "config.json");
  fs.writeFileSync(configFile, JSON.stringify({}));

  const asText = (r: unknown): string => {
    const content = (r as { content?: { text?: string }[] }).content ?? [];
    return content.map((c) => c.text ?? "").join("\n");
  };
  const entry = new URL("./index.js", import.meta.url).pathname;
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", userConfigPath()], env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<string, string>, stderr: "pipe" });
  const client = new Client({ name: "bf-validate", version: "0" });
  await client.connect(transport);

  const resetTree = () => {
    git(["checkout", "--", "."]);
    git(["clean", "-fdq"]);
  };
  /** One real run of one task on one lane; the verify result is the gateway's own exit code. */
  const runOn = async (t: ValidateTask, arm: ValidateArm, lane: string | null): Promise<TaskOutcome> => {
    const started = Date.now();
    if (lane === null) return { task: t.id, arm, lane: "(none)", verify_ok: null, model: "", ms: 0, error: `${t.id}: no lane mapped for ${arm}` };
    try {
      const r = await client.callTool({
        name: "run_plan",
        arguments: {
          goal: `bf validate ${t.id} on ${lane}`,
          tasks: [{ id: `${t.id}--${arm}`, task: t.task, acceptance: t.acceptance, verify: t.verify, files: t.files, tags: t.tags, model: lane, capabilities: ["read", "write", "run"] }],
        },
      });
      const text = asText(r);
      const meta = JSON.parse(text.slice(text.lastIndexOf("\nmeta: ") + 7)) as { results: { model?: string; verify?: { ok?: boolean } | null; error?: string }[] };
      const res = meta.results[0];
      return { task: t.id, arm, lane, verify_ok: res?.verify ? res.verify.ok === true : null, model: res?.model ?? "", ms: Date.now() - started, ...(res?.error ? { error: res.error } : {}) };
    } catch (e) {
      return { task: t.id, arm, lane, verify_ok: null, model: "", ms: Date.now() - started, error: (e as Error).message };
    }
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
      resetTree();
      outcomes.push(await runOn(t, "claimed", laneFor(config, t.cheapest_passing_lane)));
      resetTree();
      outcomes.push(await runOn(t, "lead", laneFor(config, t.lane)));
      if (withRouting) {
        resetTree();
        const routed = await client.callTool({ name: "route", arguments: { tasks: [{ id: t.id, task: t.task, files: t.files, tags: t.tags }] } });
        const body = JSON.parse(asText(routed)) as { decisions: { model: string | null; lane: string }[] };
        const decision = body.decisions[0];
        outcomes.push(await runOn(t, "jev", decision?.model ?? null));
      }
      console.error(`  ran ${t.id} (${outcomes.filter((o) => o.task === t.id).length} arms)`);
    }
  } finally {
    resetTree();
    await client.close();
  }

  const report = summarise(outcomes, tasks, config, unfalsifiable);
  if (flags.json) console.log(JSON.stringify({ meta: { workspace: ws, set: setFile, with_routing: withRouting }, report }, null, 2));
  else console.log(renderValidation(report, { workspace: ws, set: setFile, withRouting }));
  return report.label_validation.failed > 0 ? 1 : 0;
}

const HELP = `bf — Break Free command line

  bf route --plan <file> [--engine jev|rules|off]    decide which model runs each task
  bf bench route [--live]                            score four routers against the labelled set
  bf bench tripwire [--live]                         score the diff check on labelled diffs
  bf demo [--live]                                   one plan routed three ways
  bf scenarios [--live]                              ten real workflows, routed four ways
  bf validate --workspace <git repo>                 do the labels hold? (RESETS the workspace)

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
    flags: ["set", "engine", "live", "record", "json"],
    usage: "bf bench route [--set bench/route-set.jsonl] [--engine rules,jev] [--live] [--record <file>] [--json]\n    Score lead picks, static rules and Jev against the labelled set. Offline it replays\n    bench/jev-recording.json; --live calls api.typesafe.ai (needs TYPESAFE_API_KEY) and writes the\n    capture with --record. A frontier-LLM-as-router arm needs a chat provider key (e.g. GEMINI_API_KEY).",
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
    flags: ["set", "workspace", "tasks", "with-routing", "json", "force", "include-unfalsifiable"],
    usage:
      "bf validate [--set bench/route-set.jsonl] --workspace <git repo> [--tasks 3] [--with-routing] [--json] [--force]\n" +
      "    Do the labels hold? Runs each task on the lane the label calls cheapest AND on the lane a\n" +
      "    lead would pick, then reads the gateway's own verify exit code.\n" +
      "    THE WORKSPACE IS RESET TO HEAD BETWEEN RUNS. It must be clean to start (--force overrides),\n" +
      "    it defaults to the current directory, and it will delete files the runs added. Do not edit\n" +
      "    files in it while a validation is running.",
  },
  help: { flags: [], usage: "bf help" },
};

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
  console.log(HELP);
  return cmd === "help" || cmd === "--help" ? 0 : 2;
}

// Only run when executed, never when imported by a test.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
const self = path.resolve(new URL(import.meta.url).pathname);
if (entry === self) process.exitCode = await main();

/**
 * Routing: which model runs a task whose `model` was omitted.
 *
 * Pipeline, in order — hard policy first, judgement second, escalation last:
 *
 *   1. POLICY      deterministic globs decide what is sensitive. A sensitive task is forced
 *                  onto `routing.sensitiveLane` (default `local`) and can never be sent to a
 *                  remote lane, whatever any model says. Runs first, for both engines.
 *   2. ENGINE      `jev` asks TypeSafe System One once per plan (one question set, answered in
 *                  parallel) for a lane, a difficulty, a sensitivity flag and a repo-context
 *                  flag per task. `rules` is a deterministic keyword engine that needs no key.
 *   3. ESCALATION  a Jev answer below `routing.threshold`, or the `lead_keeps`/`unclear` lanes,
 *                  goes back to the lead with `model: null` instead of guessing.
 *
 * `off` is not a third engine here: it means "no routing at all", and `routePlanTasks` returns
 * no decisions so `run_plan` behaves exactly as it did before this existed.
 *
 * The lane taxonomy, the questions and the thresholds all live in THIS file: they are the
 * constants a human should review, and the thing to tune against your own data.
 */
import type { GatewayConfig } from "./config.js";
import { DEFAULT_LANE_MAP } from "./config.js";
import { globToRegex } from "./policy.js";
import { resolveProvider } from "./config.js";
import { estimateTokens, systemOne, JevError, type JevQuestion } from "./jev.js";
import { log as rlog } from "./logger.js";
import type { ScorecardRecord } from "./ledger.js";

export const LANES = ["local", "fast", "strong", "thinker", "codex_handoff", "lead_keeps", "unclear"] as const;
export type Lane = (typeof LANES)[number];
export type RoutingEngine = "jev" | "rules" | "off";

/** Where a decision came from, for the ledger and for filtering bench metrics. */
export type RouteReason = "jev" | "rules" | "policy" | "sensitive" | "confidence" | "unclear" | "lead_keeps" | "degraded";

/**
 * What each lane means. `what` / `not_for` / `examples` go to Jev verbatim as the Choice
 * criteria: Jev answers the question you wrote, so each option has to be separable from the
 * others on its own words. Edit here, nowhere else.
 */
export interface LaneSpec {
  what: string;
  not_for: string;
  examples: string;
}

export const LANE_SPEC: Record<Lane, LaneSpec> = {
  local: {
    what: "Prose, docs, README, comments, config examples and changelog edits with no runtime behaviour; or work that must not leave this machine.",
    not_for: "Anything that changes program behaviour, or any file outside documentation and comments.",
    examples: "Update docs/usage.md; fix a typo in a JSDoc comment; add a CHANGELOG entry.",
  },
  fast: {
    what: "A small, fully specified, mechanical change in one or two files: a rename, a new unit test, a CLI flag, a one-line bug fix.",
    not_for: "Anything needing judgement about design, more than a handful of files, or a change whose blast radius is hard to see.",
    examples: "Rename getUser to fetchUser and update its call sites; add a --json flag; add a unit test for an existing helper.",
  },
  strong: {
    what: "Implementation where a subtle mistake is expensive: core logic, multi-file changes, schema or API contract changes, migrations, concurrency.",
    not_for: "Mechanical edits that are already fully specified, and pure prose.",
    examples: "Add a database migration; change a public API response shape; fix a race in the job queue.",
  },
  thinker: {
    what: "The ask is ambiguous, or it is a design, architecture or root-cause question with no obviously right answer that should be reasoned about before code is written.",
    not_for: "Tasks that are already specified well enough to implement directly.",
    examples: "Decide between two storage designs; work out why a flaky test is flaky; propose the migration strategy.",
  },
  codex_handoff: {
    what: "A long, autonomous, multi-hour refactor better run to completion in a second coding harness.",
    not_for: "Anything that could be finished in one short worker turn.",
    examples: "Sweep the whole repository converting a deprecated API; run an overnight mechanical migration across 200 files.",
  },
  lead_keeps: {
    what: "The work needs the lead's own judgement, product authority, or a decision the user must make — it should not be delegated.",
    not_for: "Work that is merely hard; hard work goes to strong or thinker.",
    examples: "Choose what the public API should be; decide what to cut from scope; approve sending data to a third party.",
  },
  unclear: {
    what: "The task text genuinely does not contain enough information to choose a lane.",
    not_for: "Use this only when the other six options are all wrong for a real reason, not as a fallback.",
    examples: "Instructions that are a fragment with no file, no acceptance criteria and no verb.",
  },
};

/** The Score scale for difficulty: 0 trivial edit -> 4 cross-cutting design change. */
export const DIFFICULTY_LEVELS = [
  "Trivial edit: prose, a comment, a constant, a version bump.",
  "Mechanical, fully specified change confined to one or two files.",
  "Ordinary feature or bug fix with a clear acceptance criterion.",
  "Multi-file or subtle change: core logic, migration, contract change.",
  "Cross-cutting design change that touches how several modules fit together.",
];

/**
 * Capability/cost order of the lanes that form a ladder. `codex_handoff`, `lead_keeps` and
 * `unclear` are not rungs on it, so they have no tier.
 *
 * `local` sits at the bottom for cost, but it is also the *egress-safe* lane: it is the only one
 * that keeps the data on this machine. That double meaning is why sensitivity does not simply
 * raise a task to a higher tier — see `resolveSensitiveLane`.
 */
export const LANE_TIER: Record<string, number> = { local: 0, fast: 1, strong: 2, thinker: 3 };

/**
 * The lane a sensitive task actually runs on.
 *
 * Sensitivity is two different problems and the config has to say which one it is solving:
 *
 *   `sensitiveLane: "local"`  — data residency. Everything sensitive runs locally, always,
 *                               whatever any model says. This is the absolute rule.
 *   `sensitiveLane: "strong"` — care. The lane is raised to *at least* strong and never lowered:
 *                               an engine that already chose `thinker` keeps it, an engine that
 *                               chose `local` keeps that too (it is already the safest place for
 *                               the data), and an engine that chose `fast` is overruled upward.
 *
 * Either way the task is marked `requires_review`, which is the other half of "force strong with
 * review": a stronger model without a second pair of eyes is not a guardrail.
 */
export function resolveSensitiveLane(proposed: Lane, sensitiveLane: "local" | "strong"): Lane {
  if (sensitiveLane === "local") return "local";
  if (proposed === "local") return "local";
  const proposedTier = LANE_TIER[proposed];
  if (proposedTier === undefined) return "strong"; // lead_keeps/unclear/codex_handoff: give it to strong
  return proposedTier >= LANE_TIER.strong ? proposed : "strong";
}

/** Paths that make a task sensitive on their own, before any model is asked. */
export const BUILTIN_SENSITIVE_PATTERNS = [
  "**/auth/**",
  "**/*auth*",
  "**/*secret*",
  "**/*credential*",
  "**/*.pem",
  "**/*.key",
  "**/.env",
  "**/.env.*",
  "**/*password*",
  "**/*payment*",
  "**/*billing*",
  "**/migrations/**",
  "**/*migration*",
  "**/infra/prod/**",
];

// ------------------------------------------------------------------ engine choice

/**
 * Which engine to use: the call's own parameter beats the session env var beats the config
 * file (which already has project-over-user precedence applied). A task's explicit `model`
 * never reaches here — it is not routed at all.
 */
export function resolveEngine(
  configEngine: RoutingEngine,
  sessionEngine?: RoutingEngine,
  envEngine?: string,
): { engine: RoutingEngine; source: "call" | "env" | "config" } {
  if (sessionEngine) return { engine: sessionEngine, source: "call" };
  if (envEngine === "jev" || envEngine === "rules" || envEngine === "off") return { engine: envEngine, source: "env" };
  return { engine: configEngine, source: "config" };
}

// ------------------------------------------------------------------ policy rules

/**
 * Files that make a task sensitive. Three sources, all deterministic: the built-in list,
 * `routing.sensitivePaths`, and the user's own `policy.rules` globs (a path the user already
 * declared special for the tool jail is special here too). Glob semantics are shared with
 * policy.ts so there is one convention, not two.
 */
export function sensitiveHits(config: GatewayConfig, files: string[] | undefined): string[] {
  if (!files?.length) return [];
  const patterns = [
    ...BUILTIN_SENSITIVE_PATTERNS,
    ...config.routing.sensitivePaths,
    ...config.policy.rules.flatMap((r) => (Array.isArray(r.match) ? r.match : [r.match])),
  ];
  const hits = new Set<string>();
  for (const f of files) for (const g of patterns) if (globToRegex(g).test(f)) hits.add(f);
  return [...hits].sort();
}

// ------------------------------------------------------------------ rules engine

interface RuleMatch {
  lane: Lane;
  difficulty: number;
  /** A named, human-auditable reason so a surprising route can be traced to one line. */
  rule: string;
}

/**
 * Judgement rules: what KIND of thinking the task needs. They apply whatever the artefact is, so
 * a design decision written into a Markdown note is still thinker work.
 */
const JUDGEMENT_RULES: { rule: string; lane: Lane; difficulty: number; pattern: RegExp }[] = [
  { rule: "long-autonomous-refactor", lane: "codex_handoff", difficulty: 3, pattern: /\b(autonomous|multi-?hour|overnight|long-running|sweep the (whole|entire)|codemod across)\b/ },
  { rule: "design-or-diagnosis", lane: "thinker", difficulty: 4, pattern: /\b(design|architect|architectural|trade-?offs?|should we|which approach|root cause|investigate|decide (between|whether)|propose|proposal|strategy)\b/ },
  { rule: "underspecified", lane: "unclear", difficulty: 2, pattern: /\b(tbd|not sure|figure (it|this) out|unclear|as discussed|later)\b/ },
];

/**
 * Implementation rules: what the task is made of. These are evaluated ONLY after the file check,
 * because a keyword cannot establish what a task is made of: "add a changelog entry describing
 * the migration" is prose that mentions one word of implementation, and routing it to the strong
 * lane on that word alone was a real misfire.
 */
const IMPLEMENTATION_RULES: { rule: string; lane: Lane; difficulty: number; pattern: RegExp }[] = [
  { rule: "high-risk-implementation", lane: "strong", difficulty: 3, pattern: /\b(migrat\w*|schema|contract|breaking change|refactor|rewrite|concurren\w*|deadlock|race condition|multi-?file|across the (repo|codebase|project)|performance|regression)\b/ },
  { rule: "mechanical-small", lane: "fast", difficulty: 1, pattern: /\b(rename|bump|add a (flag|test|assertion)|extract|tidy|format|unit test)\b/ },
];

/** The default when nothing matches: the same lane the lead used to get by default. */
const RULES_DEFAULT: RuleMatch = { lane: "fast", difficulty: 2, rule: "default" };

const DOC_EXTENSIONS = [".md", ".mdx", ".txt", ".rst", ".adoc"];
const isProseOnly = (files: string[] | undefined) => {
  const f = files ?? [];
  return f.length > 0 && f.every((x) => DOC_EXTENSIONS.some((e) => x.toLowerCase().endsWith(e)));
};

export function classifyWithRules(task: RouteTaskInput): RuleMatch {
  const haystack = [task.title, task.task, task.acceptance].filter(Boolean).join("\n").toLowerCase();
  const match = (rules: typeof JUDGEMENT_RULES) => rules.find((r) => r.pattern.test(haystack));
  const judgement = match(JUDGEMENT_RULES);
  if (judgement) return { lane: judgement.lane, difficulty: judgement.difficulty, rule: judgement.rule };
  // File evidence beats keyword guessing: prose-only work never needs a strong coding model.
  if (isProseOnly(task.files)) return { lane: "local", difficulty: 0, rule: "prose-files" };
  const implementation = match(IMPLEMENTATION_RULES);
  if (implementation) return { lane: implementation.lane, difficulty: implementation.difficulty, rule: implementation.rule };
  return RULES_DEFAULT;
}

// ------------------------------------------------------------------ decisions

export interface RouteTaskInput {
  id: string;
  title?: string;
  task: string;
  acceptance?: string;
  verify?: string;
  files?: string[];
  tags?: string[];
}

export interface RouteDecision {
  id: string;
  /** The lane the task will actually run on (after policy, mapping and escalation). */
  lane: Lane;
  /** What the engine wanted before policy/escalation, so the override is visible. */
  proposed_lane: Lane;
  /** Model spec handed to run_plan. `null` = the lead keeps it. */
  model: string | null;
  difficulty: number;
  sensitive: boolean;
  needs_repo_context: boolean;
  /** Jev's confidence in the lane. `null` when the engine gave no calibrated number. */
  confidence: number | null;
  /** Lane distribution from Jev, probability per lane. */
  probabilities: Record<string, number> | null;
  /** Probability that the task is sensitive (Noul), and that it needs repo context. */
  sensitive_prob: number | null;
  context_prob: number | null;
  engine: RoutingEngine;
  reason: RouteReason;
  /** Rule name (rules engine) or `"jev"` (engine decision), for tracing a route. */
  matched: string;
  escalated: boolean;
  /** True when policy or the sensitivity check fired: this task gets an independent review. */
  requires_review: boolean;
  policy_hits: string[];
  ms: number;
  error?: string;
}

export interface RouteResult {
  engine: RoutingEngine;
  /** Which engine actually answered — differs from `engine` when Jev degraded to rules. */
  answered_by: RoutingEngine;
  engine_source: "call" | "env" | "config";
  model: string;
  threshold: number;
  decisions: RouteDecision[];
  ms: number;
  usage: { input_tokens: number; output_tokens: number };
  cost_usd: number;
  priced: boolean;
  batch: "plan" | "task";
  /** Jev's versioned id when it answered. */
  jev_model?: string;
  escalated: number;
  policy_hits: number;
  /** State size we sent, and whether it had to be trimmed to fit the budget. */
  state_tokens: number;
  state_truncated: boolean;
  /** Set when the requested engine could not run (no key, API error) and rules took over. */
  degraded?: string;
}

/** `fast=0.83 strong=0.11` — a frontmatter-safe encoding (frontmatter values must stay scalar). */
export function formatProbs(probs: Record<string, number> | null | undefined, limit = 3): string {
  if (!probs) return "";
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, v]) => `${k}=${v.toFixed(2)}`)
    .join(" ");
}

export function parseProbs(s: string | undefined): Record<string, number> | null {
  if (!s?.trim()) return null;
  const out: Record<string, number> = {};
  for (const part of s.trim().split(/\s+/)) {
    const [k, v] = part.split("=");
    const n = Number(v);
    if (k && Number.isFinite(n)) out[k] = n;
  }
  return Object.keys(out).length ? out : null;
}

export function effectiveLaneMap(config: GatewayConfig): Record<string, string | null> {
  return { ...DEFAULT_LANE_MAP, ...config.routing.laneMap };
}

// ------------------------------------------------------------------ state building

export interface ScorecardBundle {
  records: ScorecardRecord[];
}

/** `migration: fast 2/6 verify pass, strong 5/5` — the ledger remembering what worked. */
export function scorecardLines(records: ScorecardRecord[], tags: string[], limit: number): string[] {
  if (!limit || !records.length || !tags.length) return [];
  const lines: string[] = [];
  for (const tag of tags.slice(0, 2)) {
    const matching = records.filter((r) => r.tags.includes(tag) && r.verify_ok !== null);
    if (matching.length < 2) continue;
    const byLane = new Map<string, { pass: number; total: number }>();
    for (const r of matching) {
      const b = byLane.get(r.lane) ?? { pass: 0, total: 0 };
      b.total++;
      if (r.verify_ok) b.pass++;
      byLane.set(r.lane, b);
    }
    const parts = LANES.filter((l) => byLane.has(l))
      .slice(0, 3)
      .map((l) => `${l} ${byLane.get(l)!.pass}/${byLane.get(l)!.total}`);
    if (parts.length) lines.push(`${tag}: ${parts.join(" verify pass, ")}${parts.length === 1 ? " verify pass" : ""}`);
  }
  return lines.slice(0, limit);
}

export function fileBucket(files: string[] | undefined): string {
  const n = files?.length ?? 0;
  if (n <= 1) return n === 1 ? "1" : "unknown";
  return n <= 5 ? "2-5" : "6+";
}

interface StateTask {
  id: string;
  title?: string;
  instructions: string;
  acceptance?: string;
  verify?: string;
  files_touched: string;
  files?: string[];
  tags?: string[];
  scorecard?: string[];
}

/**
 * Keep `state` small: Jev's accuracy falls as unrelated detail piles up, and it cannot count,
 * so file counts are pre-bucketed in code rather than left for it to tally. Trimming is a
 * fixed sequence of steps (no randomness, no clock) so the same plan always sends byte-identical
 * state — which is what makes the routing tests deterministic.
 */
export function buildState(
  config: GatewayConfig,
  goal: string | undefined,
  tasks: RouteTaskInput[],
  scorecards: ScorecardRecord[],
): { state: Record<string, unknown>; tokens: number; truncated: boolean } {
  const budget = config.routing.maxStateTokens;
  const maxLines = config.routing.scorecardLines;
  const flat: StateTask[] = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    instructions: t.task,
    acceptance: t.acceptance,
    verify: t.verify,
    files_touched: fileBucket(t.files),
    files: t.files?.slice(0, 6),
    tags: t.tags,
    scorecard: scorecardLines(scorecards, t.tags ?? [], maxLines),
  }));
  const build = () => ({
    goal: goal ?? "(none given)",
    task_count: flat.length,
    note: "file counts are already bucketed in code — do not recount them",
    tasks: flat.map((t) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)))),
  });
  let state = build();
  let tokens = estimateTokens(state);
  if (tokens <= budget) return { state, tokens, truncated: false };
  // Deterministic trim ladder: least-load-bearing detail first.
  const strip = (fn: (t: StateTask) => StateTask) => { flat.forEach((t, i) => { flat[i] = fn(t); }); state = build(); tokens = estimateTokens(state); };
  const steps: ((t: StateTask) => StateTask)[] = [
    (t) => ({ ...t, acceptance: undefined }),
    (t) => ({ ...t, verify: undefined }),
    (t) => ({ ...t, scorecard: undefined }),
    (t) => ({ ...t, files: undefined }),
    (t) => ({ ...t, tags: undefined }),
    (t) => ({ ...t, instructions: t.instructions.slice(0, 240) }),
    (t) => ({ ...t, instructions: t.instructions.slice(0, 120) }),
    (t) => ({ ...t, title: undefined }),
  ];
  for (const step of steps) {
    if (tokens <= budget) break;
    strip(step);
  }
  return { state, tokens, truncated: true };
}

/** One Choice + one Score + two Nouls per task. Question ids are built from the task id and mapped back in code. */
export function buildQuestions(tasks: RouteTaskInput[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const t of tasks) {
    questions[`${t.id}__lane`] = {
      type: "choice",
      instructions: "Which lane should run this subtask? Answer with the option whose description fits the subtask, not the one that sounds most impressive. If two lanes both fit, pick the cheaper one. If the subtask cannot be judged from the text given, choose `unclear`.",
      criteria: LANE_SPEC,
    };
    questions[`${t.id}__difficulty`] = {
      type: "score",
      instructions: "How hard is this subtask for an experienced engineer who has the repository open?",
      criteria: DIFFICULTY_LEVELS,
    };
    questions[`${t.id}__sensitive`] = {
      type: "noul",
      instructions: "Does this subtask touch authentication, secrets, credentials, passwords, payments, billing, or a database migration?",
      criteria: { true: "It edits or reasons about auth, secrets, credentials, payments or a migration", false: "It does not touch any of those" },
    };
    questions[`${t.id}__needs_repo_context`] = {
      type: "noul",
      instructions: "Does doing this subtask correctly require understanding several modules of the repository at once, rather than one file?",
      criteria: { true: "It cannot be done from one file alone", false: "One file, or a self-contained detail, is enough" },
    };
  }
  return questions;
}

// ------------------------------------------------------------------ the router

export interface RouteOptions {
  goal?: string;
  /** Session-level override for this call */
  engine?: RoutingEngine;
  threshold?: number;
  scorecards?: ScorecardRecord[];
  signal?: AbortSignal;
  log?: (s: string) => void;
}

function escalatedDecision(base: Omit<RouteDecision, "lane" | "model" | "escalated" | "reason" | "proposed_lane">, reason: RouteReason, proposed: Lane): RouteDecision {
  return { ...base, lane: "lead_keeps", proposed_lane: proposed, model: null, escalated: true, reason };
}

/**
 * Route a plan's tasks. Returns one decision per task, in the order given.
 *
 * Never throws for a routing problem: if Jev is unreachable or unconfigured the rules engine
 * answers instead and `degraded` says why, because failing a plan because the router is down
 * would be worse than routing it slightly worse.
 */
export async function routePlanTasks(config: GatewayConfig, tasks: RouteTaskInput[], opts: RouteOptions = {}): Promise<RouteResult> {
  const laneMap = effectiveLaneMap(config);
  const threshold = opts.threshold ?? config.routing.threshold;
  const { engine, source } = resolveEngine(config.routing.engine, opts.engine, process.env.BREAK_FREE_ROUTING);
  const log = opts.log ?? (() => {});
  const started = Date.now();
  const empty: RouteResult = {
    engine,
    answered_by: engine,
    engine_source: source,
    model: config.routing.engine === "jev" ? "typesafe/jev-latest" : "",
    threshold,
    decisions: [],
    ms: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    cost_usd: 0,
    priced: true,
    batch: config.routing.batch,
    escalated: 0,
    policy_hits: 0,
    state_tokens: 0,
    state_truncated: false,
  };
  if (engine === "off" || !tasks.length) {
    return { ...empty, ms: Date.now() - started, model: engine === "off" ? "" : empty.model };
  }

  const policy = new Map<string, string[]>(tasks.map((t) => [t.id, sensitiveHits(config, t.files)]));
  const policyHits = [...policy.values()].filter((h) => h.length).length;

  let decisions: RouteDecision[];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let cost_usd = 0;
  let priced = true;
  let batch: "plan" | "task" = config.routing.batch;
  let jevModel: string | undefined;
  let degraded: string | undefined;
  let answered_by: RoutingEngine = engine;
  let stateTokens = 0;
  let stateTruncated = false;

  if (engine === "jev") {
    const provider = resolveProvider(config, "typesafe");
    if (!provider || provider.unusableReason) {
      degraded = provider?.unusableReason ?? "provider `typesafe` is not configured";
      answered_by = "rules";
      decisions = tasks.map((t) => rulesDecision(t, config, laneMap, threshold, policy.get(t.id) ?? []));
    } else {
      try {
        const scorecards = opts.scorecards ?? [];
        const builds = batch === "plan" ? [tasks] : tasks.map((t) => [t]);
        const collected = new Map<string, { answers: Record<string, unknown>; ms: number }>();
        if (batch === "plan") {
          const { state, tokens, truncated } = buildState(config, opts.goal, tasks, scorecards);
          stateTokens = tokens;
          stateTruncated = truncated;
          const res = await systemOne(config, provider, { state, model: provider.defaultModel, questions: buildQuestions(tasks) }, { signal: opts.signal, log });
          collected.set("__plan", { answers: res.answers as Record<string, unknown>, ms: res.ms });
          usage = res.usage;
          cost_usd = res.costUsd;
          priced = res.priced;
          jevModel = res.model;
        } else {
          for (const one of builds) {
            const { state, tokens, truncated } = buildState(config, opts.goal, one, scorecards);
            stateTokens += tokens;
            stateTruncated = stateTruncated || truncated;
            const res = await systemOne(config, provider, { state, model: provider.defaultModel, questions: buildQuestions(one) }, { signal: opts.signal, log });
            collected.set(one[0].id, { answers: res.answers as Record<string, unknown>, ms: res.ms });
            usage.input_tokens += res.usage.input_tokens;
            usage.output_tokens += res.usage.output_tokens;
            cost_usd += res.costUsd;
            priced = priced && res.priced;
            jevModel = res.model;
          }
        }
        decisions = tasks.map((t) => jevDecision(t, config, laneMap, threshold, policy.get(t.id) ?? [], collected.get(batch === "plan" ? "__plan" : t.id)!));
      } catch (e) {
        const msg = e instanceof JevError ? e.message : (e as Error).message;
        degraded = msg;
        answered_by = "rules";
        log(`routing degraded to rules: ${msg}`);
        decisions = tasks.map((t) => rulesDecision(t, config, laneMap, threshold, policy.get(t.id) ?? [], `jev unavailable: ${msg}`));
      }
    }
  } else {
    decisions = tasks.map((t) => rulesDecision(t, config, laneMap, threshold, policy.get(t.id) ?? []));
  }

  const escalatedCount = decisions.filter((d) => d.escalated).length;
  rlog("route.plan", {
    engine,
    answered_by,
    engine_source: source,
    tasks: decisions.length,
    escalations: escalatedCount,
    escalation_rate: decisions.length ? Math.round((escalatedCount / decisions.length) * 1000) / 1000 : 0,
    policy_hits: policyHits,
    ms: Date.now() - started,
    cost_usd,
    state_tokens: stateTokens,
    batch,
    degraded: degraded ?? null,
  });
  return {
    ...empty,
    answered_by,
    model: jevModel ? `typesafe/${jevModel}` : empty.model,
    decisions,
    ms: Date.now() - started,
    usage,
    cost_usd,
    priced,
    batch,
    jev_model: jevModel,
    escalated: decisions.filter((d) => d.escalated).length,
    policy_hits: policyHits,
    state_tokens: stateTokens,
    state_truncated: stateTruncated,
    degraded,
  };
}

/** Apply policy + threshold + laneMap to a Jev answer. Policy always wins over the model. */
function jevDecision(
  task: RouteTaskInput,
  config: GatewayConfig,
  laneMap: Record<string, string | null>,
  threshold: number,
  policy: string[],
  answer: { answers: Record<string, unknown>; ms: number },
): RouteDecision {
  const laneAnswer = answer.answers[`${task.id}__lane`] as { choice?: string; probabilities?: Record<string, number>; confidence?: number } | undefined;
  const diffAnswer = answer.answers[`${task.id}__difficulty`] as { score?: number; probabilities?: Record<string, number> } | undefined;
  const sensAnswer = answer.answers[`${task.id}__sensitive`] as { noul?: number } | undefined;
  const ctxAnswer = answer.answers[`${task.id}__needs_repo_context`] as { noul?: number } | undefined;

  const rawLane = String(laneAnswer?.choice ?? "");
  const proposed: Lane = (LANES as readonly string[]).includes(rawLane) ? (rawLane as Lane) : "unclear";
  const confidence = typeof laneAnswer?.confidence === "number" ? laneAnswer.confidence : null;
  const sensitiveProb = typeof sensAnswer?.noul === "number" ? sensAnswer.noul : null;
  const contextProb = typeof ctxAnswer?.noul === "number" ? ctxAnswer.noul : null;
  const difficulty = Math.max(0, Math.min(4, Math.round(diffAnswer?.score ?? 2)));
  const policySensitive = policy.length > 0;
  const modelSensitive = (sensitiveProb ?? 0) >= config.routing.sensitiveThreshold;
  const sensitive = policySensitive || modelSensitive;

  const base = {
    id: task.id,
    difficulty,
    sensitive,
    needs_repo_context: contextProb !== null ? contextProb >= 0.5 : fileBucket(task.files) === "6+",
    confidence,
    probabilities: laneAnswer?.probabilities ?? null,
    sensitive_prob: sensitiveProb,
    context_prob: contextProb,
    engine: "jev" as RoutingEngine,
    matched: "jev",
    requires_review: sensitive,
    policy_hits: policy,
    ms: answer.ms,
  };
  if (policySensitive || modelSensitive) {
    const lane = resolveSensitiveLane(proposed, config.routing.sensitiveLane);
    return { ...base, lane, proposed_lane: proposed, model: laneMap[lane] ?? null, escalated: false, reason: policySensitive ? "policy" : "sensitive" };
  }
  if (proposed === "lead_keeps" || proposed === "unclear") return escalatedDecision(base, proposed === "unclear" ? "unclear" : "lead_keeps", proposed);
  if (confidence !== null && confidence < threshold) return escalatedDecision(base, "confidence", proposed);
  const model = laneMap[proposed] ?? null;
  if (model === null) return escalatedDecision(base, "lead_keeps", proposed);
  return { ...base, lane: proposed, proposed_lane: proposed, model, escalated: false, reason: "jev" };
}

/** The same decision shape, from deterministic rules. Never gated on a confidence threshold. */
function rulesDecision(
  task: RouteTaskInput,
  config: GatewayConfig,
  laneMap: Record<string, string | null>,
  _threshold: number,
  policy: string[],
  error?: string,
): RouteDecision {
  const m = classifyWithRules(task);
  const bucket = fileBucket(task.files);
  const difficulty = bucket === "6+" ? Math.max(m.difficulty, 3) : m.difficulty;
  const policySensitive = policy.length > 0;
  const base = {
    id: task.id,
    difficulty,
    sensitive: policySensitive,
    needs_repo_context: bucket === "6+",
    confidence: m.rule === "default" ? 0.5 : 0.9,
    probabilities: null,
    sensitive_prob: null,
    context_prob: null,
    engine: "rules" as RoutingEngine,
    matched: m.rule,
    requires_review: policySensitive,
    policy_hits: policy,
    ms: 0,
    error,
  };
  if (policySensitive) {
    const lane = resolveSensitiveLane(m.lane, config.routing.sensitiveLane);
    return { ...base, lane, proposed_lane: m.lane, model: laneMap[lane] ?? null, escalated: false, reason: "policy" };
  }
  if (m.lane === "unclear") return escalatedDecision(base, "unclear", m.lane);
  const model = laneMap[m.lane] ?? null;
  if (model === null) return escalatedDecision(base, "lead_keeps", m.lane);
  return { ...base, lane: m.lane, proposed_lane: m.lane, model, escalated: false, reason: error ? "degraded" : "rules" };
}

/** `id -> model` for the tasks routing actually decided. Omitted ids fall through to defaults.model. */
export function routedModels(result: RouteResult): Map<string, RouteDecision> {
  return new Map(result.decisions.map((d) => [d.id, d]));
}

export { JevError };

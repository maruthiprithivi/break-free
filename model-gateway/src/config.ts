/**
 * Configuration: defaults -> user config file -> project config file -> env.
 *
 * Precedence for the API key of a provider:
 *   1. providers.<name>.apiKey in config (may be "${ENV_VAR}" reference)
 *   2. process.env[providers.<name>.keyEnv]
 *   3. catalog keyEnv (e.g. DEEPSEEK_API_KEY)
 *
 * Config file locations (all optional, merged in this order):
 *   - $MODEL_GATEWAY_CONFIG                       (explicit path)
 *   - ~/.config/model-gateway/config.json         (user)
 *   - <workspace>/.model-gateway.json             (project)
 */
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PROVIDER_CATALOG } from "./providers.js";

const ProviderConfigSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  keyEnv: z.string().optional(),
  headers: z.record(z.string()).optional(),
  defaultModel: z.string().optional(),
  supportsTools: z.boolean().optional(),
  /** Custom endpoints without auth (LM Studio, llama.cpp) set this false */
  requiresKey: z.boolean().optional(),
  /** Extra JSON merged into every request body (e.g. {"thinking":{"type":"enabled"}}) */
  extraBody: z.record(z.any()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  label: z.string().optional(),
});

const AliasSchema = z.union([
  z.array(z.string()),
  z.object({
    candidates: z.array(z.string()).min(1),
    description: z.string().optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
  }),
]);

export const FALLBACK_REASONS = ["rate_limit", "server_error", "timeout", "network", "auth", "not_found", "bad_request", "no_key"] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

const ConfigSchema = z.object({
  workspaceRoot: z.string().optional(),
  sessionDir: z.string().optional(),
  /** JSONL runtime log; default ~/.config/model-gateway/gateway.log. false disables. */
  logFile: z.union([z.string(), z.literal(false)]).optional(),
  /** Named project mode that derives github.allowPush/allowMerge defaults. */
  mode: z.enum(["guarded", "pr-only", "local-only"]).default("guarded"),
  /** Let a guarded worker merge PRs without explicit approval. Ignored for pr-only/local-only. */
  mergeAutonomy: z.boolean().default(false),
  defaults: z
    .object({
      model: z.string().default("fast"),
      reviewer: z.string().default("reviewer"),
      supervisor: z.string().default("strong"),
      temperature: z.number().default(0.2),
      maxTokens: z.number().int().positive().default(8192),
      timeoutMs: z.number().int().positive().default(180_000),
      maxToolIterations: z.number().int().positive().default(25),
      maxSessionMessages: z.number().int().positive().default(40),
      maxHistoryChars: z.number().int().positive().default(200_000),
    })
    .default({}),
  fallback: z
    .object({
      enabled: z.boolean().default(true),
      /** Appended after alias/explicit candidates when everything else fails */
      chain: z.array(z.string()).default([]),
      retryOn: z.array(z.enum(FALLBACK_REASONS)).default(["rate_limit", "server_error", "timeout", "network", "no_key", "not_found", "auth"]),
      /** Retries of the SAME candidate before moving on (only for rate_limit/server_error/timeout/network) */
      retriesPerCandidate: z.number().int().min(0).default(1),
      retryDelayMs: z.number().int().min(0).default(1500),
    })
    .default({}),
  providers: z.record(ProviderConfigSchema).default({}),
  aliases: z.record(AliasSchema).default({}),
  github: z
    .object({
      /** Branches workers may never push to directly (PR flow instead) */
      protectedBranches: z.array(z.string()).default(["main", "master", "production", "release"]),
      allowPush: z.boolean().default(true),
      allowMerge: z.boolean().default(true),
      /** Optional OWNER/REPO override passed to gh --repo (default: repo of the workspace) */
      repo: z.string().optional(),
    })
    .default({}),
  workers: z
    .object({
      /** Attach CLAUDE.md / AGENTS.md / .claude/rules from the workspace to every worker (delegate/supervise) */
      projectInstructions: z.boolean().default(true),
      /** Cap on injected instructions + skills, in characters */
      maxContextChars: z.number().int().positive().default(40_000),
      /** Commands a worker with the `run` capability may execute (matched as leading words of the command, no shell) */
      allowedCommands: z.array(z.string()).default(["npm test", "npm run", "npx vitest", "npx jest", "npx tsc", "npx eslint", "pnpm test", "pnpm run", "yarn test", "pytest", "python -m pytest", "python -m unittest", "ruff", "mypy", "go test", "go vet", "go build", "cargo test", "cargo check", "cargo clippy", "make test", "make check", "make lint", "mvn test", "gradle test", "./gradlew test", "dotnet test", "bundle exec rspec"]),
      commandTimeoutMs: z.number().int().positive().default(600_000),
      maxCommandOutputBytes: z.number().int().positive().default(60_000),
      /** How many workers run_plan may run at once */
      maxConcurrency: z.number().int().positive().default(4),
      mcp: z
        .object({
          /** Servers the gateway may bridge to workers, in addition to discovered ones */
          servers: z
            .record(
              z.object({
                command: z.string().optional(),
                args: z.array(z.string()).default([]),
                env: z.record(z.string()).default({}),
                cwd: z.string().optional(),
                url: z.string().optional(),
                headers: z.record(z.string()).default({}),
                /** Only these tools are exposed (glob); default all minus denyTools */
                allowTools: z.array(z.string()).optional(),
              }),
            )
            .default({}),
          /** Also read ~/.claude.json, <workspace>/.mcp.json and ~/.codex/config.toml */
          discover: z.boolean().default(true),
          /** Tool-name globs never exposed to workers, on any server */
          denyTools: z.array(z.string()).default(["*delete*", "*remove*", "*drop*", "*destroy*", "*purge*", "*wipe*", "*truncate*"]),
          connectTimeoutMs: z.number().int().positive().default(30_000),
          callTimeoutMs: z.number().int().positive().default(120_000),
        })
        .default({}),
    })
    .default({}),
  /** Harness sub-agents: spawn another coding harness inside a tmux session (a real PTY) so it runs in
   *  the interactive/subscription mode instead of `claude -p …` (which bills the API per token). */
  harness: z
    .object({
      /** tmux binary (override with BREAK_FREE_TMUX, e.g. for tests) */
      tmux: z.string().default("tmux"),
      /** Prefix for tmux session names */
      sessionPrefix: z.string().default("bf-"),
    })
    .default({}),
  fleet: z
    .object({
      /** A ci.pending event older than this stops blocking, so a run that never reports cannot wedge a session. */
      ciTimeoutMs: z.number().int().positive().default(20 * 60_000),
      /** A running harness whose pane has not changed for this long is reported as idle. */
      idleMs: z.number().int().positive().default(5 * 60_000),
    })
    .default({}),
  /**
   * The tripwire: a sub-second Jev check on what a crew diff actually does, run after `verify`
   * passes. It exists because glob rules see paths, not intent — a model that adds `.skip` to a
   * failing test, loosens an assertion or drops a guard passes every sensible glob and a green
   * verify.
   *
   * It is ADDITIVE: a glob-triggered review is never removed, only added to. Disabled until a
   * `policy.rules` entry with `action: "check"` scopes it to some paths.
   */
  tripwire: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * Probability at or above which a hunk is BLOCKED — a hard rejection of the task.
       *
       * Deliberately near certainty. A block is the most expensive mistake the tripwire can make
       * (it rejects work that may be fine), and on the calibration set lowering this to 0.8 bought
       * no extra recall while false-blocking 5 clean diffs. Everything from `reviewAt` up to this
       * is still reviewed, so the catch rate does not depend on it.
       */
      blockAt: z.number().min(0).max(1).default(0.99),
      /** Risk score at or above which a hunk is blocked (0..4 scale). */
      blockRisk: z.number().min(0).max(4).default(3.5),
      /**
       * Probability at or above which a hunk is sent for a full review.
       *
       * Calibrated against `bench/tripwire-set.jsonl`, not guessed: at 0.5 this flagged 51% of the
       * 100 clean diffs, because a Noul just over half is a coin flip rather than a finding. 0.95
       * is where recall on planted diffs is still 90% while false flags fall to 14%.
       */
      reviewAt: z.number().min(0).max(1).default(0.95),
      /**
       * Risk score at or above which a hunk is sent for a full review.
       *
       * 3.0, not the 2.5 the seeded set alone suggested. On a corpus of 175 REAL merged diffs this is
       * the single biggest lever there is: `risk` caused 13 of the 17 false flags, because ordinary
       * code in a real backend lands at 2.5-3.1 on the 0-4 scale. Raising it to 3.0 cuts real-diff
       * false flags 10% -> 4% (code-only 15% -> 5%) while costing NOTHING on the seeded set, whose
       * recall stays 90%. Only one planted diff (a destructive-data change at risk 3.27) depends on
       * a threshold below 3.5 at all. See bench/tripwire-results.md.
       */
      reviewRisk: z.number().min(0).max(4).default(3.0),
      /**
       * Below this confidence on the risk score, a hunk is reviewed rather than trusted.
       *
       * 0 disables the gate, and that is the calibrated default: Jev's confidence on the risk Score
       * is low on 48% of CLEAN diffs and 67% of bad ones, so it does not separate the two and gating
       * on it flagged half the clean set. Kept as a knob because it may separate them on your data.
       */
      confidenceThreshold: z.number().min(0).max(1).default(0),
      /**
       * Let an all-clean, confident tripwire stand in for a BLANKET plan-level review
       * (`review: true` on every task). It never replaces a glob-triggered review.
       */
      skipPlanReview: z.boolean().default(false),
      /** Cap the work: hunks beyond this are dropped, and the result says so only via the count. */
      maxHunks: z.number().int().positive().default(40),
      maxHunkChars: z.number().int().positive().default(4000),
    })
    .default({}),
  /** USD per 1M tokens, keyed by "provider/model" or "provider" (fallback). Unknown models cost 0 and are reported as unpriced. */
  pricing: z.record(z.object({ input: z.number().min(0), output: z.number().min(0) })).default({}),
  /**
   * Which model runs a `run_plan`/`delegate` task whose `model` is omitted.
   *
   * Precedence, highest first: the task's own `model` (never routed) → the call's `routing`
   * parameter → the BREAK_FREE_ROUTING env var → this block. `off` restores the pre-routing
   * behaviour exactly (an omitted model means `defaults.model`).
   */
  routing: z
    .object({
      /**
       * `jev` = TypeSafe System One (needs a key; degrades to `rules` without one);
       * `rules` = deterministic heuristics, no key, no network; `off` = no routing at all —
       * an omitted `model` means `defaults.model`, exactly as before this existed.
       *
       * The default is `off` on purpose: routing changes which model runs a task, and that must
       * be an explicit choice at user, project or session level, never a silent change to an
       * existing install. Turn it on globally here, or per call with the `routing` parameter.
       */
      engine: z.enum(["jev", "rules", "off"]).default("off"),
      /**
       * USER config only, never read from a project. Whether a repo's `.model-gateway.json` may set
       * `engine: "jev"` for itself. Allowed by default because a project can already choose any
       * remote model through `defaults.model`; set it false to keep every routing decision on this
       * machine, in which case a project may still ask for `rules` or `off`.
       */
      projectMayEnableJev: z.boolean().default(true),
      /** Jev confidence below this goes back to the lead instead of guessing a lane */
      threshold: z.number().min(0).max(1).default(0.7),
      /** lane -> model spec handed to run_plan (defaults to DEFAULT_LANE_MAP). `null` escalates that lane to the lead. */
      laneMap: z.record(z.string().nullable()).default({}),
      /**
       * What a sensitive task is forced onto.
       *
       * `strong` (default) is "care": the lane is raised to at least strong — never lowered, so a
       * `thinker` or `local` answer stands — and the task is always independently reviewed.
       * `local` is "data residency": everything sensitive runs on this machine, always.
       */
      sensitiveLane: z.enum(["local", "strong"]).default("strong"),
      /** File globs that make a task sensitive regardless of what Jev answers (added to the built-in list) */
      sensitivePaths: z.array(z.string()).default([]),
      /** Noul probability at/above which Jev's own `sensitive` answer forces the sensitive lane */
      sensitiveThreshold: z.number().min(0).max(1).default(0.5),
      /** Hard cap on the state sent to Jev. Jev degrades with padded input, so this stays small. */
      maxStateTokens: z.number().int().positive().default(2000),
      /**
       * Hard cap on state + questions for ONE request. TypeSafe rejects an oversized request with
       * `400 max_tokens_exceeded` (64k total, 32k for state plus the longest question), so a plan
       * that does not fit is split into several requests — and each chunk gets its own, smaller
       * state, which is better for accuracy than one padded one.
       */
      maxRequestTokens: z.number().int().positive().default(24_000),
      timeoutMs: z.number().int().positive().default(20_000),
      /** Retries of the same TypeSafe request on 429/529/5xx/network, with backoff honouring `retry-after` */
      retries: z.number().int().min(0).max(5).default(2),
      /** Base backoff in ms (doubles per attempt); set 0 in tests so they stay offline and instant */
      retryDelayMs: z.number().int().min(0).default(800),
      /** One batched request per plan (fast, cheap) or one request per task (fully isolated questions) */
      batch: z.enum(["plan", "task"]).default("plan"),
      /** How many ledger scorecard lines per task tag go into Jev's state (0 = none) */
      scorecardLines: z.number().int().min(0).max(10).default(3),
    })
    .default({}),
  budget: z
    .object({
      /** Hard caps in USD; 0 = unlimited. A worker/plan/day that exceeds its cap is stopped, not silently continued. */
      perTaskUsd: z.number().min(0).default(0),
      perPlanUsd: z.number().min(0).default(0),
      perDayUsd: z.number().min(0).default(0),
      /** Warn in reports when a day passes this fraction of perDayUsd */
      warnAt: z.number().min(0).max(1).default(0.8),
    })
    .default({}),
  policy: z
    .object({
      /** Enforced by the gateway, not by prompt text. `deny`: workers cannot read or write matching paths. `review`: when a worker
       *  changed a matching path, an independent review by a DIFFERENT vendor runs automatically (run_plan/delegate) and a
       *  reject fails the task. Globs are matched against repo-relative paths. */
      rules: z
        .array(
          z.object({
            match: z.union([z.string(), z.array(z.string())]),
            /** `check` runs the Jev tripwire over diffs whose changed paths match (adds reviews/blocks, never removes one). */
            action: z.enum(["deny", "review", "check"]),
            reason: z.string().optional(),
            /** For review: require the reviewer's provider to differ from the worker's (default true) */
            differentVendor: z.boolean().default(true),
          }),
        )
        .default([]),
    })
    .default({}),
  steward: z
    .object({
      /** Allow-listed command the steward runs on main after absorbing (e.g. "npm test"); empty = skip */
      verify: z.string().optional(),
      /** Done tasks older than this are proposed for archiving */
      archiveDoneAfterDays: z.number().positive().default(30),
      /** Journal files older than this are proposed for archiving */
      journalKeepDays: z.number().positive().default(90),
    })
    .default({}),
  worktrees: z
    .object({
      /** A registered worktree with no commit/heartbeat for this long is shown as inactive */
      inactiveAfterHours: z.number().positive().default(48),
    })
    .default({}),
  workspace: z
    .object({
      /** Extra glob-ish deny patterns for worker file reads */
      denyPatterns: z.array(z.string()).default([]),
      maxFileBytes: z.number().int().positive().default(200_000),
      maxGrepMatches: z.number().int().positive().default(200),
      maxListEntries: z.number().int().positive().default(500),
    })
    .default({}),
});

export type GatewayConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export function modeDefaults(mode: "guarded" | "pr-only" | "local-only", mergeAutonomy: boolean): { allowPush: boolean; allowMerge: boolean } {
  switch (mode) {
    case "guarded":
      return { allowPush: true, allowMerge: mergeAutonomy };
    case "pr-only":
      return { allowPush: true, allowMerge: false };
    case "local-only":
      return { allowPush: false, allowMerge: false };
  }
}

interface AliasDef { candidates: string[]; description: string }

const CORE_ALIASES = {
  fast: {
    description: "Cheap/fast worker for boilerplate, tests, refactors",
    candidates: ["deepseek/deepseek-v4-flash", "zai/glm-5.3-flash", "opencode/deepseek-v4-flash", "openrouter/deepseek/deepseek-v4-flash", "ollama/qwen3-coder:30b"],
  },
  strong: {
    description: "Strongest available model for hard implementation or supervision",
    candidates: ["deepseek/deepseek-v4-pro", "kimi/kimi-k3", "zai/glm-5.3", "minimax/MiniMax-M3", "openrouter/deepseek/deepseek-v4-pro"],
  },
  reviewer: {
    description: "Independent reviewer; prefer a DIFFERENT vendor than the worker",
    candidates: ["kimi/kimi-k2.7-code", "zai/glm-5.3", "minimax/MiniMax-M2.7", "deepseek/deepseek-v4-pro", "openrouter/moonshotai/kimi-k3"],
  },
  local: {
    description: "Never leaves the machine",
    candidates: ["ollama/qwen3-coder:30b", "ollama/qwen3:8b", "vllm/default"],
  },
  thinker: {
    description: "Reasoning-heavy work: design questions, gnarly debugging (slower, pricier)",
    candidates: ["deepseek/deepseek-reasoner", "deepseek/deepseek-v4-pro", "openrouter/deepseek/deepseek-v4-pro"],
  },
  cloud: {
    description: "Ollama Cloud tier",
    candidates: ["ollama-cloud/gpt-oss:120b", "ollama-cloud/deepseek-v4-flash"],
  },
} satisfies Record<string, AliasDef>;

/**
 * Crew names for the same chains. A crew alias points at the core alias BY NAME,
 * so it follows whatever that alias means at resolution time. Copying the candidate
 * list looked equivalent and was not: the copy froze the shipped defaults, so a user
 * who re-pointed `local` found `holodeck` still routing to the old chain and hanging
 * on a host that alias no longer referred to.
 */
const CREW_ALIASES: Record<string, { mirrors: keyof typeof CORE_ALIASES; description: string }> = {
  ensign: { mirrors: "fast", description: "Junior officer: the legwork. Same chain as `fast`." },
  commander: { mirrors: "strong", description: "Senior officer: hard implementation or supervision. Same chain as `strong`." },
  counselor: { mirrors: "reviewer", description: "The independent read on whether something is sound; prefer a DIFFERENT vendor than the worker. Same chain as `reviewer`." },
  holodeck: { mirrors: "local", description: "A simulation that never leaves the ship. Same chain as `local`." },
  subspace: { mirrors: "cloud", description: "The off-ship link. Same chain as `cloud`." },
};

export const DEFAULT_ALIASES: Record<string, AliasDef> = {
  ...CORE_ALIASES,
  ...Object.fromEntries(
    Object.entries(CREW_ALIASES).map(([name, { mirrors, description }]) => [name, { description, candidates: [mirrors] }]),
  ),
};

/** Which core alias each crew name mirrors, so callers can prove the pairing. */
export const CREW_ALIAS_MIRRORS: Record<string, string> = Object.fromEntries(
  Object.entries(CREW_ALIASES).map(([name, { mirrors }]) => [name, mirrors]),
);

/** Approximate list prices (USD per 1M tokens). Edit `pricing` in config to correct them; unknown models report as unpriced. */
export const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  "deepseek/deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "deepseek/deepseek-v4-pro": { input: 0.55, output: 2.19 },
  "deepseek/deepseek-chat": { input: 0.27, output: 1.1 },
  "deepseek/deepseek-reasoner": { input: 0.55, output: 2.19 },
  "kimi/kimi-k3": { input: 0.6, output: 2.5 },
  "kimi/kimi-k2.7-code": { input: 0.6, output: 2.5 },
  "zai/glm-5.3": { input: 0.6, output: 2.2 },
  "zai/glm-5.3-flash": { input: 0.1, output: 0.3 },
  "minimax/MiniMax-M3": { input: 0.4, output: 1.6 },
  "minimax/MiniMax-M2.7": { input: 0.3, output: 1.2 },
  "openrouter": { input: 0.5, output: 2.0 },
  "opencode": { input: 0.3, output: 1.0 },
  "ollama-cloud": { input: 0.2, output: 0.6 },
  "ollama": { input: 0, output: 0 },
  "vllm": { input: 0, output: 0 },
  "lmstudio": { input: 0, output: 0 },
  // Google's published Standard paid-tier rates, per 1M tokens, from
  // ai.google.dev/gemini-api/docs/pricing (fetched 2026-09-19). The Pro tier doubles above a 200k
  // prompt, which no routing or tripwire prompt comes close to. OUTPUT IS PRICED INCLUDING THINKING
  // TOKENS on these models, and thinking dominates — which is exactly why a reasoning model is an
  // expensive router, and why that has to be priced rather than assumed.
  "gemini/gemini-3.1-pro-preview": { input: 2.0, output: 12.0 },
  "gemini/gemini-3.5-flash": { input: 1.5, output: 9.0 },
  "gemini/gemini-3.6-flash": { input: 0.75, output: 3.75 },
  // provider-level fallback for a gemini model with no entry of its own: the Pro tier, so an
  // unpriced Gemini model is never accidentally reported as free.
  "gemini": { input: 2.0, output: 12.0 },
  // TypeSafe charges input only ($0.042/Mtok); output tokens are free.
  "typesafe": { input: 0.042, output: 0 },
  "typesafe/jev-latest": { input: 0.042, output: 0 },
  "typesafe/jev-1.13.0": { input: 0.042, output: 0 },
};

/** The seven lanes Jev chooses between, and the alias each one runs on. `null` = back to the lead. */
export const DEFAULT_LANE_MAP: Record<string, string | null> = {
  local: "local",
  fast: "fast",
  strong: "strong",
  thinker: "thinker",
  codex_handoff: "strong",
  lead_keeps: null,
  unclear: null,
};

/**
 * A config whose aliases and prices are the SHIPPED defaults, for cost figures in a report.
 *
 * Crew cost is meant to be comparable and reproducible: if it were priced through your local
 * `aliases`/`pricing` overrides, the same run would print different money on different machines
 * (and an alias pointing at a model with no price would silently cost $0). Routing *behaviour*
 * still uses your config; only the price table is pinned.
 */
export function withDefaultPricing(config: GatewayConfig): GatewayConfig {
  return { ...config, aliases: DEFAULT_ALIASES, pricing: DEFAULT_PRICING };
}

export function priceFor(config: GatewayConfig, provider: string, model: string): { input: number; output: number; priced: boolean } {
  const table = { ...DEFAULT_PRICING, ...config.pricing };
  const p = table[`${provider}/${model}`] ?? table[provider];
  return p ? { ...p, priced: true } : { input: 0, output: 0, priced: false };
}
/**
 * Bill what the API says it used.
 *
 * `completion_tokens` is not always the whole story: Google's OpenAI-compatibility layer reports only
 * the VISIBLE answer there while billing the thinking tokens as output. Observed directly — one
 * request came back `completion_tokens: 2, total_tokens: 600` for a two-token answer, so 598 billed
 * output tokens were missing from the cheap field. Under-billing a provider is not caution, it is a
 * wrong number, and here it would have flattered break-free's own router against the baseline it is
 * being compared with. Output is billed as the larger of `completion_tokens` and
 * `total_tokens - prompt_tokens`, and never less than the visible completion.
 */
export function costUsd(config: GatewayConfig, provider: string, model: string, usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): { usd: number; priced: boolean; output_tokens: number } {
  const p = priceFor(config, provider, model);
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const billedOutput = Math.max(completion, (usage?.total_tokens ?? 0) - prompt);
  const usd = (prompt * p.input + billedOutput * p.output) / 1_000_000;
  return { usd: Math.round(usd * 1e6) / 1e6, priced: p.priced, output_tokens: billedOutput };
}

export interface LoadedConfig {
  config: GatewayConfig;
  /** File that `configure_*` tools write to */
  writePath: string;
  sources: string[];
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

function readJson(file: string): unknown | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Failed to parse config ${file}: ${(e as Error).message}`);
  }
}

function deepMerge<T>(a: T, b: unknown): T {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || !a || !b) {
    return (b === undefined ? a : b) as T;
  }
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

const PROJECT_PROVIDER_KEYS = new Set(["defaultModel", "enabled", "supportsTools", "timeoutMs", "extraBody", "label"]);
export function sanitizeProjectConfig(j: unknown, opts: { projectMayEnableJev?: boolean } = {}): Record<string, unknown> {
  if (!j || typeof j !== "object") return {};
  const src = j as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Only project-tunable, non-sensitive settings are copied. `github`, `mode` and `mergeAutonomy`
  // are intentionally omitted so a cloned repo can never grant itself push or merge rights.
  for (const k of ["defaults", "aliases", "fallback", "policy", "steward", "pricing"]) if (k in src) out[k] = src[k]; // policy can only add restrictions, so a project may declare it
  // A project may tighten the tripwire (lower thresholds, enable it) but not loosen it: enabling is
  // free, disabling is refused because a repo must not be able to switch off its own guardrail.
  if (src.tripwire && typeof src.tripwire === "object") {
    const t = { ...(src.tripwire as Record<string, unknown>) };
    delete t.enabled;
    out.tripwire = t;
  }
  // Routing is project-tunable, so a repo can pin its own lanes and thresholds. Whether a project
  // may point the router at TypeSafe is the user's call: it is the same egress a project already
  // gets from `defaults.model`, so it is allowed by default and can be locked down with
  // `routing.projectMayEnableJev: false` in the USER config. `projectMayEnableJev` itself is never
  // read from a project, or a repo could lift its own restriction.
  if (src.routing && typeof src.routing === "object") {
    const r = { ...(src.routing as Record<string, unknown>) };
    delete r.projectMayEnableJev;
    if (r.engine === "jev" && opts.projectMayEnableJev === false) delete r.engine;
    out.routing = r;
  }
  if (src.providers && typeof src.providers === "object") {
    const provs: Record<string, unknown> = {};
    for (const [name, pc] of Object.entries(src.providers as Record<string, Record<string, unknown>>)) {
      if (!pc || typeof pc !== "object") continue;
      provs[name] = Object.fromEntries(Object.entries(pc).filter(([k]) => PROJECT_PROVIDER_KEYS.has(k)));
    }
    out.providers = provs;
  }
  return out;
}

export function userConfigPath(): string {
  return process.env.MODEL_GATEWAY_CONFIG ? expandHome(process.env.MODEL_GATEWAY_CONFIG) : path.join(os.homedir(), ".config", "model-gateway", "config.json");
}

export function loadConfig(opts: { workspaceRoot?: string; configPath?: string } = {}): LoadedConfig {
  const sources: string[] = [];
  let raw: unknown = {};
  const userPath = opts.configPath ? expandHome(opts.configPath) : userConfigPath();
  const projectPath = path.join(opts.workspaceRoot ?? process.cwd(), ".model-gateway.json");

  const userJson = readJson(userPath);
  if (userJson !== undefined) {
    raw = deepMerge(raw, userJson);
    sources.push(userPath);
  }
  // The gate that decides whether a project file may point the router at TypeSafe. Read from the
  // USER config only — never from the project, or a repo could lift its own restriction.
  const userRouting = (userJson as { routing?: { projectMayEnableJev?: unknown } } | undefined)?.routing;
  const projectMayEnableJev = userRouting?.projectMayEnableJev !== false;
  // The project file lives in a repo you may have just cloned: it is UNTRUSTED. It may tune
  // defaults/aliases/fallback and pick provider models, but never redirect keys, widen the jail,
  // or relax git/GitHub policy.
  const projectJson = readJson(projectPath);
  if (projectJson !== undefined) {
    raw = deepMerge(raw, sanitizeProjectConfig(projectJson, { projectMayEnableJev }));
    sources.push(projectPath);
  }
  // zod fills defaults, so presence of an explicit value can only be detected on the raw merged object.
  const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawGithub = rawObj.github && typeof rawObj.github === "object" ? (rawObj.github as Record<string, unknown>) : {};
  const hasAllowPush = Object.prototype.hasOwnProperty.call(rawGithub, "allowPush");
  const hasAllowMerge = Object.prototype.hasOwnProperty.call(rawGithub, "allowMerge");

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config (${sources.join(", ") || "defaults"}): ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const config = parsed.data;
  const modePolicy = modeDefaults(config.mode, config.mergeAutonomy);
  if (!hasAllowPush) config.github.allowPush = modePolicy.allowPush;
  if (!hasAllowMerge) config.github.allowMerge = modePolicy.allowMerge;
  config.workspaceRoot = path.resolve(expandHome(opts.workspaceRoot ?? config.workspaceRoot ?? process.cwd()));
  config.sessionDir = expandHome(config.sessionDir ?? path.join(os.homedir(), ".config", "model-gateway", "sessions"));
  // Built-in aliases are only defaults; user aliases win.
  for (const [name, def] of Object.entries(DEFAULT_ALIASES)) {
    if (!(name in config.aliases)) config.aliases[name] = def;
  }
  return { config, writePath: userPath, sources };
}

/** Save a partial config into the user config file (merging with what is there). */
export function saveConfigPatch(writePath: string, patch: Record<string, unknown>): void {
  const existing = (readJson(writePath) as Record<string, unknown> | undefined) ?? {};
  const merged = deepMerge(existing, patch);
  fs.mkdirSync(path.dirname(writePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(writePath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(writePath, 0o600);
  } catch {
    /* windows */
  }
}

/** Resolve "${VAR}" / "$VAR" references. */
function expandEnvRef(v: string | undefined): string | undefined {
  if (!v) return v;
  const m = v.match(/^\$\{?([A-Z0-9_]+)\}?$/i);
  return m ? process.env[m[1]] : v;
}

export interface ResolvedProvider {
  name: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  keyEnv: string;
  requiresKey: boolean;
  enabled: boolean;
  headers: Record<string, string>;
  defaultModel: string;
  knownModels: string[];
  supportsTools: boolean;
  /** `decision` providers answer typed questions (TypeSafe/Jev) and are never usable as a chat model. */
  kind: "chat" | "decision";
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  docs: string;
  notes?: string;
  /** Why it's unusable, if it is */
  unusableReason?: string;
}

export function resolveProvider(config: GatewayConfig, name: string): ResolvedProvider | undefined {
  const catalog = PROVIDER_CATALOG[name];
  const pc = config.providers[name];
  if (!catalog && !pc?.baseUrl) return undefined;
  const keyEnv = pc?.keyEnv ?? catalog?.keyEnv ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  const apiKey = expandEnvRef(pc?.apiKey) ?? process.env[keyEnv] ?? undefined;
  const requiresKey = pc?.requiresKey ?? catalog?.requiresKey ?? true;
  const enabled = pc?.enabled ?? true;
  const r: ResolvedProvider = {
    name,
    label: pc?.label ?? catalog?.label ?? name,
    baseUrl: (pc?.baseUrl ?? catalog!.baseUrl).replace(/\/+$/, ""),
    apiKey,
    keyEnv,
    requiresKey,
    enabled,
    headers: { ...(catalog?.headers ?? {}), ...(pc?.headers ?? {}) },
    defaultModel: pc?.defaultModel ?? catalog?.defaultModel ?? "default",
    knownModels: catalog?.knownModels ?? [],
    supportsTools: pc?.supportsTools ?? catalog?.supportsTools ?? true,
    kind: catalog?.kind ?? "chat",
    extraBody: catalog?.extraBody || pc?.extraBody ? { ...(catalog?.extraBody ?? {}), ...(pc?.extraBody ?? {}) } : undefined,
    timeoutMs: pc?.timeoutMs,
    docs: catalog?.docs ?? "",
    notes: catalog?.notes,
  };
  if (!enabled) r.unusableReason = "disabled in config";
  else if (requiresKey && !apiKey) r.unusableReason = `no API key (set ${keyEnv} or providers.${name}.apiKey)`;
  return r;
}

export function listProviderNames(config: GatewayConfig): string[] {
  return Array.from(new Set([...Object.keys(PROVIDER_CATALOG), ...Object.keys(config.providers)]));
}

export function redactKey(k?: string): string {
  if (!k) return "(none)";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

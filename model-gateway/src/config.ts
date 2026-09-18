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
  /** USD per 1M tokens, keyed by "provider/model" or "provider" (fallback). Unknown models cost 0 and are reported as unpriced. */
  pricing: z.record(z.object({ input: z.number().min(0), output: z.number().min(0) })).default({}),
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
            action: z.enum(["deny", "review"]),
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

export const DEFAULT_ALIASES: Record<string, { candidates: string[]; description: string }> = {
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
  cloud: {
    description: "Ollama Cloud tier",
    candidates: ["ollama-cloud/gpt-oss:120b", "ollama-cloud/deepseek-v4-flash"],
  },
};

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
};

export function priceFor(config: GatewayConfig, provider: string, model: string): { input: number; output: number; priced: boolean } {
  const table = { ...DEFAULT_PRICING, ...config.pricing };
  const p = table[`${provider}/${model}`] ?? table[provider];
  return p ? { ...p, priced: true } : { input: 0, output: 0, priced: false };
}
export function costUsd(config: GatewayConfig, provider: string, model: string, usage: { prompt_tokens?: number; completion_tokens?: number } | undefined): { usd: number; priced: boolean } {
  const p = priceFor(config, provider, model);
  const usd = ((usage?.prompt_tokens ?? 0) * p.input + (usage?.completion_tokens ?? 0) * p.output) / 1_000_000;
  return { usd: Math.round(usd * 1e6) / 1e6, priced: p.priced };
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
export function sanitizeProjectConfig(j: unknown): Record<string, unknown> {
  if (!j || typeof j !== "object") return {};
  const src = j as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Only project-tunable, non-sensitive settings are copied. `github`, `mode` and `mergeAutonomy`
  // are intentionally omitted so a cloned repo can never grant itself push or merge rights.
  for (const k of ["defaults", "aliases", "fallback", "policy", "steward", "pricing"]) if (k in src) out[k] = src[k]; // policy can only add restrictions, so a project may declare it
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
  // The project file lives in a repo you may have just cloned: it is UNTRUSTED. It may tune
  // defaults/aliases/fallback and pick provider models, but never redirect keys, widen the jail,
  // or relax git/GitHub policy.
  const projectJson = readJson(projectPath);
  if (projectJson !== undefined) {
    raw = deepMerge(raw, sanitizeProjectConfig(projectJson));
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

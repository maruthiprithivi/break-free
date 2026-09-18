#!/usr/bin/env node
/**
 * model-gateway MCP server (stdio).
 *
 *   node dist/index.js [--workspace <dir>] [--config <file>] [--stateless] [--selftest]
 *   node dist/index.js --serve [port]        local Responses-API shim for Codex profiles (see serve.ts)
 *
 * Tools exposed to Claude Code / Codex:
 *   list_providers, list_models, test_provider, configure_provider, configure_alias, configure_fallback,
 *   delegate, review, panel, supervise, run_plan,
 *   job_list, job_status, job_result, job_cancel,
 *   list_mcp_servers,
 *   ledger_resume, task_create, task_update, task_list, task_get, note_write, note_search, code_map,
 *   session_list, session_get, session_clear, gateway_logs,
 *   harness_spawn, harness_send, harness_read, harness_status, harness_close, harness_list (tmux PTY sub-agents)
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadConfig, listProviderNames, redactKey, resolveProvider, saveConfigPatch, FALLBACK_REASONS, type LoadedConfig } from "./config.js";
import { chatCompletion, listRemoteModels } from "./client.js";
import { resolveCandidates } from "./router.js";
import { Workspace, CAPABILITIES } from "./workspace.js";
import { McpBridge } from "./mcpbridge.js";
import { JobRegistry } from "./jobs.js";
import { Ledger, TASK_STATUSES } from "./ledger.js";
import { buildCodeMap, writeCodeMap } from "./codemap.js";
import { startServe } from "./serve.js";
import { WorktreeRegistry, WORKTREE_STATUSES, isLinkedWorktree, shadowLedgerDir, installGuardHook, guardHookStatus, removeGuardHook, LEDGER_GUARD_WORKFLOW } from "./worktrees.js";
import { LEDGER_DIR } from "./ledger.js";
import { runSteward, hygiene } from "./steward.js";
import { DEFAULT_PRICING } from "./config.js";
import { ghAvailable } from "./github.js";
import { SessionStore } from "./sessions.js";
import { HarnessController } from "./harnessctl.js";
import { appendEvents, classify, drainTo, expireCi, pendingEvents, readSnapshot, resolveCi, writeSnapshot, type FleetEvent, type FleetSnapshot } from "./fleet.js";
import { delegate, panel, review, supervise, runPlan, type Ctx } from "./orchestrate.js";
import { PROVIDER_CATALOG } from "./providers.js";
import { Logger, analyze, callContext, setLogger, summarizeArgs, log as rlog } from "./logger.js";

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------ CLI
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const stateless = argv.includes("--stateless");
const workspaceArg = flag("--workspace") ?? process.env.MODEL_GATEWAY_WORKSPACE;
const configArg = flag("--config");

let loaded: LoadedConfig;
const log = (s: string) => process.stderr.write(`[model-gateway] ${s}\n`);

let logger: Logger | undefined;
let jobs: JobRegistry | undefined;
function reload(): Ctx {
  loaded = loadConfig({ workspaceRoot: workspaceArg, configPath: configArg });
  const config = loaded.config;
  logger = config.logFile === false ? undefined : new Logger(typeof config.logFile === "string" ? config.logFile : undefined);
  setLogger(logger);
  const workspace = new Workspace(config);
  const sessions = new SessionStore(config, stateless);
  const mcp = new McpBridge(config, workspace.root);
  const worktrees = new WorktreeRegistry(workspace.root, { inactiveAfterHours: config.worktrees.inactiveAfterHours });
  const harnessctl = new HarnessController(config, stateless);
  // Ledger placement: main checkout writes the committed .break-free/; a linked worktree writes a local
  // shadow overlay (.git/break-free/shadow/<branch>) on top of main's LIVE ledger, so feature branches
  // never carry ledger changes and main absorbs them with ledger_merge_from.
  let ledger: Ledger;
  if (worktrees.available() && worktrees.commonDir && isLinkedWorktree(workspace.root)) {
    const name = worktrees.current()?.name ?? worktrees.currentBranch();
    ledger = new Ledger(workspace.root, { writeDir: shadowLedgerDir(worktrees.commonDir, name), baseDir: path.join(worktrees.mainPath() ?? workspace.root, LEDGER_DIR), origin: name });
  } else ledger = new Ledger(workspace.root);
  jobs ??= new JobRegistry(config, stateless);
  const spentTodayUsd = () => {
    if (!logger) return 0;
    const today = new Date().toISOString().slice(0, 10);
    return Math.round(logger.tail(20_000, (e) => e.kind === "route.attempt" && !!e.ok && String(e.ts).startsWith(today)).reduce((a, e) => a + Number(e.cost_usd ?? 0), 0) * 1e6) / 1e6;
  };
  return { config, sessions, workspace, mcp, ledger, worktrees, harnessctl, spentTodayUsd, log };
}

let ctx = reload();

// ------------------------------------------------------------ fleet

async function buildFleetSnapshot(prev: FleetSnapshot | undefined): Promise<FleetSnapshot> {
  const ts = new Date().toISOString();
  const jobsMap: Record<string, string> = {};
  try {
    for (const j of jobs!.list()) jobsMap[j.id] = j.state;
  } catch {
    // A job-list failure must not take down the snapshot.
  }
  const harness: FleetSnapshot["harness"] = {};
  try {
    const sessions = await ctx.harnessctl.list();
    for (const s of sessions) {
      let digest = "";
      if (s.state === "running") {
        try {
          digest = createHash("sha1").update(await ctx.harnessctl.read(s.id, 40)).digest("hex");
        } catch {
          digest = ""; // pane vanished or tmux is unavailable: keep the session but with no digest
        }
      }
      const prevH = prev?.harness?.[s.id];
      const unchanged = s.state === "running" && prevH?.state === "running" && prevH.digest === digest;
      harness[s.id] = { state: s.state, digest, since: unchanged ? prevH!.since : ts };
    }
  } catch {
    // tmux missing or the session directory is unreadable: no harness sessions.
  }
  return { ts, jobs: jobsMap, harness };
}

/** `gh` with JSON out; undefined on any failure, because CI reconciliation must never throw. */
async function ghJson(args: string[]): Promise<unknown | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", args, { timeout: 25_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Turn every ci.pending event into an answer, in shell rather than in a model.
 *
 * A green workflow is not a healthy deploy, so where the commit has deployments
 * their own status has to succeed too before the event is allowed to drain.
 * If `gh` cannot answer at all we expire the events rather than block forever:
 * an unverifiable run must not be able to wedge a session.
 */
async function reconcileCi(sessionDir: string): Promise<void> {
  const shas = [...new Set(pendingEvents(sessionDir).filter((e) => e.kind === "ci.pending").map((e) => e.ci?.sha).filter((x): x is string => !!x))];
  if (!shas.length) return;

  expireCi(sessionDir, Date.now(), ctx.config.fleet.ciTimeoutMs);

  const runs = (await ghJson(["run", "list", "--json", "databaseId,status,conclusion,url,headSha,name", "--limit", "30"])) as
    | { databaseId: number; status: string; conclusion: string | null; url: string; headSha: string; name: string }[]
    | undefined;
  if (!runs) {
    // No gh, no auth, or no repo: we cannot verify, so stop blocking on it.
    expireCi(sessionDir, Date.now(), 0);
    return;
  }

  for (const sha of shas) {
    const run = runs.find((r) => r.headSha === sha);
    if (!run || run.status !== "completed") continue; // still pending: keep blocking
    if (run.conclusion !== "success") {
      resolveCi(sessionDir, sha, { state: "failed", runId: run.databaseId, url: run.url, job: run.name });
      continue;
    }
    const deps = (await ghJson(["api", `repos/{owner}/{repo}/deployments?sha=${sha}`])) as { id: number }[] | undefined;
    if (Array.isArray(deps) && deps.length) {
      const states = await Promise.all(deps.map((d) => ghJson(["api", `repos/{owner}/{repo}/deployments/${d.id}/statuses?per_page=1`]) as Promise<{ state: string }[] | undefined>));
      const latest = states.map((x) => Array.isArray(x) && x[0] ? x[0].state : undefined);
      if (latest.some((st) => st === "failure" || st === "error")) {
        resolveCi(sessionDir, sha, { state: "failed", runId: run.databaseId, url: run.url, job: "deployment" });
        continue;
      }
      if (!latest.every((st) => st === "success")) continue; // deployment still in flight: keep blocking
    }
    resolveCi(sessionDir, sha, { state: "success", runId: run.databaseId, url: run.url });
  }
}

async function fleetCheck(): Promise<{ running: { jobs: number; harness: number }; pending: FleetEvent[]; blocking: boolean }> {
  const sessionDir = ctx.config.sessionDir!;
  const prev = readSnapshot(sessionDir);
  const next = await buildFleetSnapshot(prev);
  appendEvents(sessionDir, classify(prev, next, ctx.config.fleet.idleMs));
  writeSnapshot(sessionDir, next);
  await reconcileCi(sessionDir);
  const pending = pendingEvents(sessionDir);
  const running = {
    jobs: Object.values(next.jobs).filter((s) => s === "running").length,
    harness: Object.values(next.harness).filter((h) => h.state === "running").length,
  };
  return { running, pending, blocking: running.jobs > 0 || pending.length > 0 };
}

const CapabilitySchema = z.array(z.enum(CAPABILITIES as [string, ...string[]])).describe(
  "What the delegated model may do. read = files/grep/diff (jailed to workspace). write = create/edit files (+ ledger_note/ledger_task_log when a ledger exists). git = branch/commit/push (never protected branches, never force). github = issues/PRs/Actions via gh (implies git). run = run_command for allow-listed test/build/lint commands (workers.allowedCommands). mcp = tools of the MCP servers named in mcp_servers. Default: [\"read\"].",
) as unknown as z.ZodType<import("./workspace.js").Capability[]>;

const ShapeSchema = z.enum(["ship", "scout"]).optional().describe(
  "Task shape: 'ship' uses the requested capabilities (default); 'scout' is a read-only investigation whose capabilities are forced to ['read'] regardless of what was asked for.",
);

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const json = (o: unknown) => text(JSON.stringify(o, null, 2));
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `ERROR: ${(e as Error).message ?? String(e)}` }], isError: true });

const ScopeSchema = z.enum(["user", "project"]).optional().describe("Where to persist: 'user' (~/.config/model-gateway/config.json, default) or 'project' (<workspace>/.model-gateway.json, committed with the repo, overrides user settings for this repo; cannot hold keys/base URLs)");
function readJsonFile(f: string): Record<string, unknown> | undefined {
  try { return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>) : undefined; } catch { return undefined; }
}
function targetFor(scope: "user" | "project" | undefined): string {
  return scope === "project" ? path.join(ctx.workspace.root, ".model-gateway.json") : loaded.writePath;
}
function projectRefuses(scope: "user" | "project" | undefined, patch: Record<string, unknown>): string | undefined {
  if (scope !== "project") return undefined;
  const bad = Object.keys(patch).filter((k) => !["defaultModel", "enabled", "supportsTools", "timeoutMs", "extraBody", "label"].includes(k));
  return bad.length ? `project scope cannot set ${bad.join(", ")} (keys, base URLs and headers live only in the user config)` : undefined;
}

function providerReport(name: string) {
  const p = resolveProvider(ctx.config, name)!;
  return {
    provider: name,
    label: p.label,
    usable: !p.unusableReason,
    reason: p.unusableReason ?? null,
    base_url: p.baseUrl,
    api_key: p.requiresKey ? redactKey(p.apiKey) : p.apiKey ? redactKey(p.apiKey) : "(not required)",
    key_env: p.keyEnv,
    default_model: p.defaultModel,
    known_models: p.knownModels,
    supports_tools: p.supportsTools,
    get_key: p.docs,
    notes: p.notes ?? null,
  };
}

// ------------------------------------------------------------ server
const VERSION = "3.4.0";
const server = new McpServer({ name: "break-free-gateway", version: VERSION }, {
  instructions: [
    "break-free-gateway lets you (the orchestrating frontier agent) keep the high-order work — deciding, designing, reviewing, owning outcomes — and hand execution to other LLMs: DeepSeek, Ollama (local/cloud), Kimi, MiniMax, Z.AI/GLM, OpenRouter, OpenCode Zen, vLLM.",
    "Model specs: an alias (fast, strong, reviewer, local, cloud, …), 'provider/model' (e.g. deepseek/deepseek-v4-pro), a bare provider name, or a comma-separated fallback list. Every call falls back automatically according to config.fallback.",
    "Modes: delegate (one worker, tools, optional session memory), run_plan (many workers in parallel as a dependency graph, with verification and review gates), supervise (worker/supervisor loop), review (independent JSON verdict), panel (N models + judge). Add async:true to delegate/run_plan for long work and poll job_status / job_result.",
    "Verification is yours to specify, not to perform: give every task acceptance criteria and a `verify` command (npm test, pytest …) that the gateway runs itself after the worker finishes; give workers the 'run' capability so they test before reporting; gate risky tasks with review:true or supervise:true.",
    "Parallel agents: worktree_list / worktree_register / worktree_update / worktree_handoff keep a registry shared by every git worktree (.git/break-free/) so main knows what each worktree does (agent, tasks, issues, PRs, tools) and whether it is active, inactive, merged, abandoned or deleted and why; worktree_create spins up a checkout for another agent.",
    "Long-horizon work: call ledger_resume at the start of a session; task_create/task_update keep the board in .break-free/ (plain Markdown, Obsidian-compatible, committed with the repo); note_write records decisions and gotchas that every worker automatically receives; code_map builds an import graph for orientation.",
    "Guardrails you configure once and the gateway enforces: configure_policy (deny paths to workers; force a different-vendor review when sensitive paths change), configure_budget (per task/plan/day USD caps; cost_report shows spend), note_review (worker-written notes stay quarantined until you promote them). steward / ledger_doctor keep main absorbed, reconciled and tidy.",
    "Workers get least privilege: pass capabilities explicitly. 'github' lets them branch/commit/push/PR/merge/monitor Actions via gh, never delete or force-push. mcp_servers:[...] lends them your other MCP servers' tools (list_mcp_servers), minus destructive tools.",
    "Workers automatically receive the workspace's CLAUDE.md / AGENTS.md / .claude/rules and the ledger's decisions/gotchas as standing context; pass skills:[...] to attach specific SKILL.md files.",
  ].join("\n"),
});

// Every tool handler is wrapped so the runtime log records start/end, duration, outcome and a correlation id.
{
  const orig = server.registerTool.bind(server);
  (server as any).registerTool = (name: string, cfg: any, handler: (...a: any[]) => Promise<any>) =>
    orig(name, cfg, (async (args: any, extra: any) => {
      const call = logger?.newCallId() ?? "";
      const started = Date.now();
      return callContext.run({ call, tool: name }, async () => {
        rlog("tool.start", { args: summarizeArgs(args) });
        try {
          const res = await handler(args, extra);
          const text = res?.content?.map((c: any) => c.text ?? "").join("") ?? "";
          rlog("tool.end", { ok: !res?.isError, ms: Date.now() - started, chars: text.length, ...(res?.isError ? { error: text.slice(0, 300) } : {}), meta: extractMeta(text) });
          return res;
        } catch (e) {
          rlog("tool.end", { ok: false, ms: Date.now() - started, error: String((e as Error).message ?? e).slice(0, 300) });
          throw e;
        }
      });
    }) as any);
}
function extractMeta(text: string): unknown {
  const i = text.lastIndexOf("\nmeta: ");
  if (i < 0) return undefined;
  try { return JSON.parse(text.slice(i + 7)); } catch { return undefined; }
}

// ---- discovery / configuration
server.registerTool("list_providers", {
  title: "List providers",
  description: "Show every provider, whether it is usable (key present / enabled), its base URL, redacted key, default and known models. Optionally probe reachability by calling GET /models.",
  inputSchema: { probe: z.boolean().optional().describe("Also hit each usable provider's /models endpoint (slower)") },
}, async ({ probe }) => {
  try {
    const rows = await Promise.all(listProviderNames(ctx.config).map(async (n) => {
      const r: Record<string, unknown> = providerReport(n);
      if (probe && r.usable) {
        try {
          const models = await listRemoteModels(resolveProvider(ctx.config, n)!);
          r.probe = { ok: true, models: models.slice(0, 40), total: models.length };
        } catch (e) {
          r.probe = { ok: false, error: (e as Error).message.slice(0, 300) };
        }
      }
      return r;
    }));
    const gh = await ghAvailable();
    return json({ config_files: loaded.sources, writes_to: loaded.writePath, workspace: ctx.workspace.root, stateless, github_cli: gh, providers: rows });
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("list_models", {
  title: "List models & aliases",
  description: "Show aliases with their resolved fallback chains (usable candidates marked), the global fallback chain, and defaults. Pass provider to fetch that provider's live model list.",
  inputSchema: { provider: z.string().optional().describe("Fetch live /models for this provider"), spec: z.string().optional().describe("Resolve this spec/alias and show its candidate chain") },
}, async ({ provider, spec }) => {
  try {
    if (provider) {
      const p = resolveProvider(ctx.config, provider);
      if (!p) return fail(new Error(`unknown provider ${provider}`));
      if (p.unusableReason) return fail(new Error(`${provider}: ${p.unusableReason}`));
      return json({ provider, models: await listRemoteModels(p) });
    }
    if (spec) {
      return json({ spec, chain: resolveCandidates(ctx.config, spec).map((c) => ({ spec: c.spec, usable: !c.provider.unusableReason, reason: c.provider.unusableReason ?? null })) });
    }
    const aliases = Object.fromEntries(Object.entries(ctx.config.aliases).map(([k, v]) => {
      const cands = Array.isArray(v) ? v : v.candidates;
      return [k, { description: Array.isArray(v) ? undefined : v.description, chain: cands.map((c) => ({ spec: c, usable: resolveCandidates(ctx.config, c, { useGlobalChain: false }).some((x) => !x.provider.unusableReason) })) }];
    }));
    const provider_defaults = Object.fromEntries(listProviderNames(ctx.config).map((n) => [n, resolveProvider(ctx.config, n)?.defaultModel]));
    return json({ config_files: loaded.sources, project_config: path.join(ctx.workspace.root, ".model-gateway.json"), defaults: ctx.config.defaults, fallback: ctx.config.fallback, provider_defaults, aliases });
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("test_provider", {
  title: "Test a provider / model",
  description: "Send a tiny real chat completion to verify the key, base URL and model work. Returns latency and the reply. Use after configure_provider.",
  inputSchema: { spec: z.string().describe("alias, provider, or provider/model"), with_tools: z.boolean().optional().describe("Also verify tool-calling works (default true)") },
}, async ({ spec, with_tools }) => {
  const results: unknown[] = [];
  const cands = resolveCandidates(ctx.config, spec, { useGlobalChain: false });
  if (!cands.length) return fail(new Error(`nothing resolves from '${spec}'`));
  for (const c of cands) {
    const started = Date.now();
    if (c.provider.unusableReason) {
      results.push({ spec: c.spec, ok: false, error: c.provider.unusableReason });
      continue;
    }
    try {
      const r = await chatCompletion(c.provider, { model: c.model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 16, temperature: 0 }, { timeoutMs: 60_000 });
      const row: Record<string, unknown> = { spec: c.spec, ok: true, ms: Date.now() - started, reply: (r.message.content ?? "").trim().slice(0, 80), usage: r.usage };
      if (with_tools !== false && c.provider.supportsTools) {
        try {
          const t = await chatCompletion(c.provider, {
            model: c.model,
            messages: [{ role: "user", content: "Call the tool `ping` with argument {\"n\": 1}." }],
            tools: [{ type: "function", function: { name: "ping", description: "ping", parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } } }],
            max_tokens: 64,
            temperature: 0,
          }, { timeoutMs: 60_000 });
          row.tool_calling = t.message.tool_calls?.length ? "ok" : "model answered without calling the tool (tools may be unsupported or ignored)";
        } catch (e) {
          row.tool_calling = `error: ${(e as Error).message.slice(0, 200)}`;
        }
      }
      results.push(row);
      rlog("route.attempt", { spec: c.spec, ok: true, ms: row.ms, probe: true, tool_calling: row.tool_calling });
    } catch (e) {
      const err = e as { reason?: string; status?: number; message: string };
      results.push({ spec: c.spec, ok: false, ms: Date.now() - started, error: err.message.slice(0, 500) });
      rlog("route.attempt", { spec: c.spec, ok: false, ms: Date.now() - started, probe: true, reason: err.reason ?? "error", status: err.status, error: err.message.slice(0, 300) });
    }
  }
  return json({ spec, results });
});

server.registerTool("configure_provider", {
  title: "Configure a provider",
  description: "Set or update a provider's API key, base URL, default model, enabled flag, headers or extra body. Persists to the user config (mode 0600) or, with scope:'project', to <workspace>/.model-gateway.json (default_model/enabled/extra_body/timeout only). To switch the model a provider uses: configure_provider {provider:'deepseek', default_model:'deepseek-v4-pro'} — check list_models {provider} first for live names. Keys may be literal or \"${ENV_VAR}\" references.",
  inputSchema: {
    provider: z.string(),
    api_key: z.string().optional().describe("Literal key or \"${ENV_VAR}\""),
    base_url: z.string().optional(),
    default_model: z.string().optional(),
    enabled: z.boolean().optional(),
    key_env: z.string().optional().describe("Env var to read the key from instead of storing it"),
    headers: z.record(z.string()).optional(),
    extra_body: z.record(z.any()).optional().describe("Merged into every request body, e.g. {\"thinking\":{\"type\":\"enabled\"}}"),
    supports_tools: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
    scope: ScopeSchema,
  },
}, async (a) => {
  try {
    if (!PROVIDER_CATALOG[a.provider] && !a.base_url && !ctx.config.providers[a.provider]?.baseUrl) return fail(new Error(`'${a.provider}' is not a built-in provider; supply base_url to add a custom OpenAI-compatible endpoint`));
    const patch: Record<string, unknown> = {};
    if (a.api_key !== undefined) patch.apiKey = a.api_key;
    if (a.base_url !== undefined) patch.baseUrl = a.base_url;
    if (a.default_model !== undefined) patch.defaultModel = a.default_model;
    if (a.enabled !== undefined) patch.enabled = a.enabled;
    if (a.key_env !== undefined) patch.keyEnv = a.key_env;
    if (a.headers !== undefined) patch.headers = a.headers;
    if (a.extra_body !== undefined) patch.extraBody = a.extra_body;
    if (a.supports_tools !== undefined) patch.supportsTools = a.supports_tools;
    if (a.timeout_ms !== undefined) patch.timeoutMs = a.timeout_ms;
    const refused = projectRefuses(a.scope, patch);
    if (refused) return fail(new Error(refused));
    const target = targetFor(a.scope);
    saveConfigPatch(target, { providers: { [a.provider]: patch } });
    ctx = reload();
    return json({ saved_to: target, scope: a.scope ?? "user", provider: providerReport(a.provider) });
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("configure_alias", {
  title: "Configure a model alias / fallback chain",
  description: "Create or replace an alias (e.g. 'fast', 'strong', 'reviewer', 'my-team') with an ordered candidate list; the first usable candidate is tried first and the rest are fallbacks. Persists to user config or, with scope:'project', to <workspace>/.model-gateway.json. To change which model 'fast' means: configure_alias {alias:'fast', candidates:['kimi/kimi-k3', ...existing fallbacks]} (read the current chain from list_models first so fallbacks are kept).",
  inputSchema: {
    alias: z.string(),
    candidates: z.array(z.string()).min(1).describe("Ordered list of provider/model specs or other aliases"),
    description: z.string().optional(),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    scope: ScopeSchema,
  },
}, async (a) => {
  try {
    const target = targetFor(a.scope);
    saveConfigPatch(target, { aliases: { [a.alias]: { candidates: a.candidates, description: a.description, temperature: a.temperature, maxTokens: a.max_tokens } } });
    ctx = reload();
    return json({ saved_to: target, scope: a.scope ?? "user", alias: a.alias, chain: resolveCandidates(ctx.config, a.alias, { useGlobalChain: false }).map((c) => ({ spec: c.spec, usable: !c.provider.unusableReason, reason: c.provider.unusableReason ?? null })) });
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("configure_fallback", {
  title: "Configure fallback policy & defaults",
  description: "Set the global fallback chain (tried after any alias/explicit candidates), which failure reasons trigger fallback, retry counts, and the default model/reviewer/supervisor aliases. Persists to config.",
  inputSchema: {
    enabled: z.boolean().optional(),
    chain: z.array(z.string()).optional().describe("Global last-resort candidates, e.g. [\"openrouter/deepseek/deepseek-v4-flash\", \"ollama/qwen3:8b\"]"),
    retry_on: z.array(z.enum(FALLBACK_REASONS)).optional(),
    retries_per_candidate: z.number().int().min(0).optional(),
    retry_delay_ms: z.number().int().min(0).optional(),
    default_model: z.string().optional(),
    default_reviewer: z.string().optional(),
    default_supervisor: z.string().optional(),
    protected_branches: z.array(z.string()).optional(),
    allow_push: z.boolean().optional(),
    allow_merge: z.boolean().optional(),
    scope: ScopeSchema,
  },
}, async (a) => {
  try {
    if (a.scope === "project" && (a.protected_branches || a.allow_push !== undefined || a.allow_merge !== undefined)) return fail(new Error("project scope cannot change git/GitHub policy (protected_branches, allow_push, allow_merge) — user config only"));
    const fb: Record<string, unknown> = {};
    if (a.enabled !== undefined) fb.enabled = a.enabled;
    if (a.chain !== undefined) fb.chain = a.chain;
    if (a.retry_on !== undefined) fb.retryOn = a.retry_on;
    if (a.retries_per_candidate !== undefined) fb.retriesPerCandidate = a.retries_per_candidate;
    if (a.retry_delay_ms !== undefined) fb.retryDelayMs = a.retry_delay_ms;
    const d: Record<string, unknown> = {};
    if (a.default_model) d.model = a.default_model;
    if (a.default_reviewer) d.reviewer = a.default_reviewer;
    if (a.default_supervisor) d.supervisor = a.default_supervisor;
    const gh: Record<string, unknown> = {};
    if (a.protected_branches) gh.protectedBranches = a.protected_branches;
    if (a.allow_push !== undefined) gh.allowPush = a.allow_push;
    if (a.allow_merge !== undefined) gh.allowMerge = a.allow_merge;
    const target = targetFor(a.scope);
    saveConfigPatch(target, a.scope === "project" ? { fallback: fb, defaults: d } : { fallback: fb, defaults: d, github: gh });
    ctx = reload();
    return json({ saved_to: target, scope: a.scope ?? "user", fallback: ctx.config.fallback, defaults: ctx.config.defaults, github: ctx.config.github });
  } catch (e) {
    return fail(e);
  }
});

// ---- orchestration
server.registerTool("delegate", {
  title: "Delegate a task to a model",
  description: "Hand a self-contained task to another model. Returns its report (Result / Changes / Verification / Open questions) plus metadata (model actually used, fallbacks, tool calls). Use session_id to continue a conversation with the same worker later. Give capabilities deliberately: [\"read\"] for analysis, [\"read\",\"write\"] to let it edit files in place, [\"github\"] for branch→commit→push→PR flows. shape:'ship' uses the requested capabilities (default); shape:'scout' is a read-only investigation whose capabilities are forced to ['read'] regardless of what was asked for.",
  inputSchema: {
    task: z.string().describe("What to do. Be explicit about scope, constraints, and the expected output."),
    model: z.string().optional().describe("Alias, provider, provider/model, or comma-separated fallback list. Default: config.defaults.model"),
    session_id: z.string().optional().describe("Persist/continue conversation history under this id"),
    capabilities: CapabilitySchema.optional(),
    shape: ShapeSchema,
    context: z.string().optional().describe("Background the worker needs (design notes, relevant snippets, prior decisions)"),
    role: z.string().optional().describe("Persona, e.g. 'security engineer', 'technical writer'"),
    instructions: z.string().optional().describe("Extra standing rules appended to the system prompt"),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_iterations: z.number().int().positive().optional().describe("Tool-call rounds allowed (default config.defaults.maxToolIterations)"),
    include_project_instructions: z.boolean().optional().describe("Attach the workspace's CLAUDE.md / AGENTS.md / .claude/rules to the worker (default true)"),
    skills: z.array(z.string()).optional().describe("Skill names whose SKILL.md the worker should follow (looked up in project and user skill folders), e.g. [\"break-free-github-flow\"]"),
    mcp_servers: z.array(z.string()).optional().describe("Names of YOUR other MCP servers whose tools the worker may call (see list_mcp_servers). Implies capability 'mcp'. Destructive tools are filtered out."),
    verify: z.string().optional().describe("Allow-listed command the gateway runs after the worker finishes, e.g. 'npm test' or 'pytest -q'. Its real exit code and output are appended to the report — the worker cannot fake it."),
    budget_usd: z.number().min(0).optional().describe("USD cap for this worker (default budget.perTaskUsd; 0 = unlimited). The worker is stopped when exceeded."),
    async: z.boolean().optional().describe("Return immediately with a job id; poll job_status / job_result. Use for long tasks."),
  },
}, async (a) => {
  try {
    if (a.async) {
      const job = jobs!.start("delegate", a.task.slice(0, 80), (signal) => delegate(ctx, { ...a, signal }).then((r) => ({ text: r.text, meta: r.meta })));
      return json({ job_id: job.id, state: job.state, hint: "poll job_status; job_result returns the report when done" });
    }
    const r = await delegate(ctx, a);
    return text(`${r.text}\n\n---\nmeta: ${JSON.stringify(r.meta)}`);
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("review", {
  title: "Independent review / scrutiny",
  description: "Have a (preferably different-vendor) model scrutinise a diff, files, a plan, or another model's output. Returns a JSON verdict {verdict, confidence, summary, issues[], strengths[], questions[]}. Set use_git_diff to 'staged', 'HEAD', 'main...HEAD' etc. to attach a real diff; the reviewer can also read files itself.",
  inputSchema: {
    subject: z.string().describe("What to review: pasted diff/code/plan, or a description of the change if use_git_diff/paths are given"),
    model: z.string().optional().describe("Default: config.defaults.reviewer alias"),
    focus: z.string().optional().describe("e.g. 'security and concurrency', 'API compatibility'"),
    task_description: z.string().optional().describe("What the change was supposed to accomplish"),
    paths: z.array(z.string()).optional(),
    use_git_diff: z.string().optional(),
    capabilities: CapabilitySchema.optional().describe("Only 'read' is honoured for reviewers"),
  },
}, async (a) => {
  try {
    const r = await review(ctx, a);
    return json({ ...r.verdict, meta: r.meta });
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("panel", {
  title: "Panel: several models in parallel",
  description: "Ask N models the same question concurrently (e.g. for design decisions, root-cause hypotheses, second opinions). Optionally a judge model compares the answers and writes a synthesis. Returns every seat's answer.",
  inputSchema: {
    prompt: z.string(),
    models: z.array(z.string()).min(1).describe("Seats, e.g. [\"deepseek/deepseek-v4-pro\", \"kimi/kimi-k3\", \"zai/glm-5.3\"] or aliases"),
    judge: z.union([z.string(), z.literal(false)]).optional().describe("Judge model spec; false to skip synthesis. Default: config.defaults.supervisor"),
    capabilities: CapabilitySchema.optional().describe("Only 'read' is honoured for panels"),
    context: z.string().optional(),
    system: z.string().optional().describe("Override the seat system prompt"),
  },
}, async (a) => {
  try {
    const r = await panel(ctx, a);
    const body = r.seats.map((s, i) => `## Seat ${i + 1}: ${s.model}${s.ok ? "" : " (FAILED)"}\n${s.ok ? s.text : s.error}`).join("\n\n");
    return text(`${body}${r.synthesis ? `\n\n# Judge synthesis\n${r.synthesis}` : ""}\n\n---\nmeta: ${JSON.stringify({ seats: r.seats.map((s) => ({ requested: s.requested, model: s.model, ok: s.ok, ...(s.meta ?? {}) })), judge: r.judgeMeta ?? null })}`);
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("supervise", {
  title: "Supervised delegation (worker + supervisor loop)",
  description: "A worker model does the task; a supervisor model (ideally a different vendor) checks the result against acceptance criteria and either accepts or sends numbered feedback back, up to max_rounds. Returns the final report, every round's decision, and whether it was accepted. Best for larger implementation tasks you don't want to babysit. shape:'ship' uses the requested capabilities (default); shape:'scout' is a read-only investigation whose capabilities are forced to ['read'] regardless of what was asked for.",
  inputSchema: {
    task: z.string(),
    worker: z.string().optional().describe("Default: config.defaults.model"),
    supervisor: z.string().optional().describe("Default: config.defaults.supervisor"),
    max_rounds: z.number().int().min(1).max(10).optional().describe("Default 3"),
    capabilities: CapabilitySchema.optional(),
    shape: ShapeSchema,
    acceptance_criteria: z.string().optional(),
    context: z.string().optional(),
    session_id: z.string().optional(),
    skills: z.array(z.string()).optional().describe("Skill names attached to the worker's system prompt"),
    mcp_servers: z.array(z.string()).optional().describe("Your MCP servers the worker may use (see list_mcp_servers)"),
    verify: z.string().optional().describe("Allow-listed command the gateway runs after every worker round; the supervisor sees the real result and cannot accept a failing one"),
  },
}, async (a) => {
  try {
    const r = await supervise(ctx, a);
    const rounds = r.rounds.map((x) => `### Round ${x.round} — worker ${x.workerModel} → supervisor ${x.supervisorModel}: ${x.decision.toUpperCase()}${x.verify ? ` · verify ${x.verify.ok ? "ok" : "FAILED"}` : ""}\n${x.assessment ?? ""}${x.feedback ? `\nFeedback: ${x.feedback}` : ""}`).join("\n\n");
    return text(`# ${r.accepted ? "ACCEPTED" : "NOT ACCEPTED after " + r.rounds.length + " round(s)"}\n\n## Final worker report\n${r.final}\n\n## Supervision log\n${rounds}\n\n---\nmeta: ${JSON.stringify(r.meta)}`);
  } catch (e) {
    return fail(e);
  }
});


// ---- fan-out
const PlanTaskSchema = z.object({
  id: z.string().describe("Short unique id, e.g. 'api', 'tests', 'docs' — or an existing ledger task id (T-007) to run that task"),
  task: z.string().describe("Self-contained instructions for this worker: scope, files, constraints, expected output"),
  model: z.string().optional().describe("Alias/provider/model for this task (default config.defaults.model). Mix vendors freely."),
  capabilities: CapabilitySchema.optional(),
  shape: ShapeSchema,
  depends_on: z.array(z.string()).optional().describe("Task ids that must finish first; their reports are given to this worker as context"),
  context: z.string().optional(),
  role: z.string().optional(),
  skills: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  verify: z.string().optional().describe("Allow-listed command the gateway runs after this task; failure blocks dependants"),
  acceptance: z.string().optional().describe("Acceptance criteria (given to the worker, the reviewer and the supervisor)"),
  supervise: z.boolean().optional().describe("Run under a supervisor loop instead of a single pass"),
  review: z.boolean().optional().describe("Independent review of this task's result (overrides plan-level review)"),
  session_id: z.string().optional(),
  max_iterations: z.number().int().positive().optional(),
});

server.registerTool("run_plan", {
  title: "Run a plan: many workers in parallel with dependencies",
  description: "Execute a set of delegated tasks as a dependency graph with bounded concurrency — the way to get more done at once: split the work, give each task its own model, capabilities, acceptance criteria and verify command, and let the gateway run, verify, review and record them while you wait for the consolidated report. Independent tasks run in parallel (default workers.maxConcurrency); a task whose prerequisite failed is skipped; prerequisite reports are handed to dependants. When a .break-free ledger exists every task is tracked there so the work survives this session. Set async:true for long plans and poll job_status. Per task, shape:'ship' uses the requested capabilities (default); shape:'scout' is a read-only investigation whose capabilities are forced to ['read'] regardless of what was asked for.",
  inputSchema: {
    goal: z.string().optional().describe("One line describing what the whole plan achieves (recorded in the ledger)"),
    tasks: z.array(PlanTaskSchema).min(1).max(40),
    concurrency: z.number().int().min(1).max(16).optional(),
    review: z.boolean().optional().describe("Independently review every task result (default false); a 'reject' fails the task"),
    review_model: z.string().optional(),
    supervisor: z.string().optional().describe("Supervisor model for tasks with supervise:true"),
    track: z.boolean().optional().describe("Record in the project ledger (default: when .break-free exists)"),
    budget_usd: z.number().min(0).optional().describe("USD cap for the whole plan (default budget.perPlanUsd); remaining tasks are cancelled when exceeded"),
    async: z.boolean().optional(),
  },
}, async (a) => {
  try {
    if (a.async) {
      const job = jobs!.start("run_plan", a.goal ?? `${a.tasks.length} tasks`, (signal, progress) => runPlan(ctx, { ...a, signal, progress }).then((r) => ({ ok: r.ok, report: r.report, results: r.results.map(({ report: _r, ...rest }) => rest), usage: r.usage, cost_usd: r.costUsd, ms: r.ms })));
      return json({ job_id: job.id, state: job.state, tasks: a.tasks.map((t) => t.id), hint: "poll job_status for progress; job_result for the consolidated report" });
    }
    const r = await runPlan(ctx, a);
    return text(`${r.report}\n\n---\nmeta: ${JSON.stringify({ ok: r.ok, order: r.order, usage: r.usage, cost_usd: r.costUsd, ms: r.ms, results: r.results.map(({ report: _r, meta: _m, ...rest }) => rest) })}`);
  } catch (e) {
    return fail(e);
  }
});

// ---- jobs
server.registerTool("job_list", { title: "List background jobs", description: "Background delegations/plans started with async:true (running and finished, incl. from earlier sessions).", inputSchema: {} }, async () => json(jobs!.list()));
server.registerTool("job_status", {
  title: "Job status / progress",
  description: "State and progress lines of a background job. Optionally wait up to wait_ms for it to finish before answering.",
  inputSchema: { job_id: z.string(), wait_ms: z.number().int().min(0).max(300_000).optional() },
}, async ({ job_id, wait_ms }) => {
  const j = wait_ms ? await jobs!.wait(job_id, wait_ms) : jobs!.get(job_id);
  if (!j) return fail(new Error(`unknown job ${job_id}`));
  const { result: _r, ...rest } = j;
  return json({ ...rest, progress: j.progress.slice(-30) });
});
server.registerTool("job_result", {
  title: "Job result",
  description: "Full result of a finished background job (the delegate report or the plan report).",
  inputSchema: { job_id: z.string() },
}, async ({ job_id }) => {
  const j = jobs!.get(job_id);
  if (!j) return fail(new Error(`unknown job ${job_id}`));
  if (j.state === "running") return json({ id: j.id, state: "running", progress: j.progress.slice(-10), hint: "not finished; use job_status with wait_ms" });
  if (j.state !== "done") return json({ id: j.id, state: j.state, error: j.error });
  const r = j.result as { text?: string; report?: string; meta?: unknown; results?: unknown; usage?: unknown };
  return text(`${r.text ?? r.report ?? JSON.stringify(r)}\n\n---\nmeta: ${JSON.stringify({ job_id: j.id, state: j.state, ...(r.meta ? { ...(r.meta as object) } : {}), ...(r.results ? { results: r.results, usage: r.usage } : {}) })}`);
});
server.registerTool("job_cancel", { title: "Cancel a job", description: "Abort a running background job (in-flight model calls are cancelled; files already written stay).", inputSchema: { job_id: z.string() } }, async ({ job_id }) => json({ cancelled: jobs!.cancel(job_id) }));

server.registerTool("fleet_status", {
  title: "Fleet status: jobs, harness sessions, pending wake events",
  description: "Snapshot the live fleet (background jobs + tmux harness sessions), classify differences into wake events, persist the snapshot and return running counts plus the pending event queue. Set drain:true to advance the cursor past the returned events so they are not reported again.",
  inputSchema: { drain: z.boolean().optional() },
}, async ({ drain }) => {
  const res = await fleetCheck();
  if (drain && res.pending.length > 0) {
    const highest = res.pending.reduce((max, e) => Math.max(max, e.seq), 0);
    drainTo(ctx.config.sessionDir!, highest);
  }
  return json(res);
});

// ---- MCP bridge
server.registerTool("list_mcp_servers", {
  title: "List MCP servers workers can borrow",
  description: "Your other MCP servers (from config.workers.mcp.servers, ~/.claude.json, <workspace>/.mcp.json, ~/.codex/config.toml) that can be lent to workers via mcp_servers:[...]. Pass server to connect and list its tools, showing which are filtered out as destructive.",
  inputSchema: { server: z.string().optional().describe("Connect to this server and list its tools") },
}, async ({ server: name }) => {
  try {
    if (name) return json(await ctx.mcp.describe(name));
    const servers = ctx.mcp.servers();
    return json({ deny_tools: ctx.config.workers.mcp.denyTools, servers: Object.values(servers).map((d) => ({ name: d.name, source: d.source, transport: d.transport, command: d.command ? [d.command, ...d.args].join(" ").slice(0, 120) : d.url })) });
  } catch (e) {
    return fail(e);
  }
});

/** Main only: absorb every worktree's ledger overlay. Idempotent. */
function absorbWorktreeLedgers(only?: string): import("./ledger.js").MergeReport[] {
  if (ctx.ledger.isShadow || !ctx.worktrees.available() || !ctx.worktrees.commonDir) return [];
  const reports: import("./ledger.js").MergeReport[] = [];
  for (const w of ctx.worktrees.list()) {
    if (w.isMain) continue;
    if (only && only !== "all" && w.name !== only && w.branch !== only) continue;
    const shadow = shadowLedgerDir(ctx.worktrees.commonDir, w.name);
    if (!fs.existsSync(shadow)) continue;
    const rep = ctx.ledger.mergeFrom(new Ledger(w.path, { writeDir: shadow, origin: w.name }), w.name);
    const changed = rep.tasks.added.length + rep.tasks.updated.length + rep.notes.added.length + rep.notes.merged.length + rep.journal_lines;
    if (changed) ctx.worktrees.markLedgerMerged(w.name, `tasks +${rep.tasks.added.length}/~${rep.tasks.updated.length}, notes +${rep.notes.added.length}/~${rep.notes.merged.length}, journal +${rep.journal_lines}`);
    reports.push(rep);
  }
  return reports;
}
function mergeSummary(reports: import("./ledger.js").MergeReport[]): string {
  const rows = reports.filter((r) => r.tasks.added.length + r.tasks.updated.length + r.notes.added.length + r.notes.merged.length + r.journal_lines > 0);
  return rows.length ? rows.map((r) => `${r.from}: tasks +${r.tasks.added.length} ~${r.tasks.updated.length}, notes +${r.notes.added.length} ~${r.notes.merged.length}, journal +${r.journal_lines}`).join("; ") : "";
}

// ---- ledger: durable tasks + knowledge (.break-free/, Obsidian-compatible Markdown)
server.registerTool("ledger_resume", {
  title: "Resume: what the next session needs to know",
  description: "Call this first in every session. Returns the handoff brief from .break-free/: task counts, what is in progress/blocked/ready, decisions and gotchas, recent activity. If no ledger exists yet it says so (task_create or note_write creates one).",
  inputSchema: { init: z.boolean().optional().describe("Create the ledger if missing") },
}, async ({ init }) => {
  try {
    if (!ctx.ledger.exists()) {
      if (!init) return text("No project ledger yet (.break-free/ not found). Call ledger_resume with init:true, or task_create / note_write, to start one. It is plain Markdown you can commit and open in Obsidian.");
      ctx.ledger.init();
      if (ctx.worktrees.commonDir) try { installGuardHook(ctx.worktrees.commonDir); } catch { /* best effort */ }
    }
    let absorbed = "";
    try { absorbed = mergeSummary(absorbWorktreeLedgers()); } catch (e) { absorbed = `absorb failed: ${(e as Error).message}`; }
    ctx.ledger.render();
    let wt = "";
    try { wt = ctx.worktrees.summary(4000); } catch { /* not git */ }
    const placement = ctx.ledger.isShadow ? `\n_This checkout is a linked worktree: ledger writes go to a local overlay (${ctx.ledger.dir}) on top of main's live ledger and are absorbed into main by ledger_resume / ledger_merge_from there — feature-branch commits never touch .break-free/._\n` : "";
    return text(ctx.ledger.resumeBrief() + (absorbed ? `\n## Absorbed from worktrees just now\n${absorbed}\n` : "") + placement + (wt ? `\n## Worktrees (shared registry)\n${wt}\n\nUse worktree_list for details, worktree_register to claim this checkout, worktree_update / worktree_handoff to keep it current.\n` : ""));
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("ledger_merge_from", {
  title: "Absorb worktree ledgers into main",
  description: "Run on the MAIN checkout: merge the ledger overlays of linked worktrees (tasks by id — newer wins, logs unioned; notes by slug — appended under 'From <worktree>' when they differ; journal lines unioned) into main's committed .break-free/. Idempotent. This is the only path by which worktree knowledge reaches main: feature-branch PRs never carry .break-free/ changes (pre-commit hook + PR guard), so nothing can overwrite main's ledger. commit:true commits the result on main.",
  inputSchema: { worktree: z.string().optional().describe("A worktree name/branch, or 'all' (default)"), commit: z.boolean().optional().describe("git commit the merged ledger on main (never pushes)") },
}, async ({ worktree, commit }) => {
  try {
    if (ctx.ledger.isShadow) return fail(new Error("this checkout is a linked worktree; run ledger_merge_from on the main checkout (or from main: it absorbs all worktrees automatically on ledger_resume)"));
    const reports = absorbWorktreeLedgers(worktree ?? "all");
    let committed: string | null = null;
    if (commit) {
      await ctx.workspace.git(["add", "-A", "--", LEDGER_DIR]);
      const staged = await ctx.workspace.git(["diff", "--cached", "--name-only", "--", LEDGER_DIR]);
      if (staged.trim()) {
        const out = await ctx.workspace.git(["-c", "user.name=" + (process.env.GIT_AUTHOR_NAME ?? "break-free-gateway"), "-c", "user.email=" + (process.env.GIT_AUTHOR_EMAIL ?? "break-free@localhost"), "commit", "-m", `ledger: absorb worktree knowledge (${mergeSummary(reports) || "no changes"})`, "--", LEDGER_DIR]);
        committed = out.split("\n")[0];
      }
    }
    return json({ reports, summary: mergeSummary(reports) || "nothing new", committed });
  } catch (e) { return fail(e); }
});
server.registerTool("ledger_guard", {
  title: "Protect the ledger from feature-branch merges",
  description: "install: a pre-commit hook in the repo's common hooks dir (applies to every worktree; existing hook is chained) that refuses to commit .break-free/ from a linked worktree, plus optionally a GitHub Actions workflow that fails any PR touching .break-free/. status: report both. remove: uninstall the hook.",
  inputSchema: { action: z.enum(["install", "status", "remove"]).optional(), workflow: z.boolean().optional().describe("With install: also write .github/workflows/break-free-ledger-guard.yml in this checkout (default true on main)") },
}, async ({ action, workflow }) => {
  try {
    if (!ctx.worktrees.commonDir) return fail(new Error("not a git repository"));
    const wfPath = path.join(ctx.workspace.root, ".github", "workflows", "break-free-ledger-guard.yml");
    if (action === "remove") return json({ hook_removed: removeGuardHook(ctx.worktrees.commonDir) });
    if (action === "install") {
      const hook = installGuardHook(ctx.worktrees.commonDir);
      let wf: string | null = null;
      if (workflow ?? !ctx.ledger.isShadow) { fs.mkdirSync(path.dirname(wfPath), { recursive: true }); fs.writeFileSync(wfPath, LEDGER_GUARD_WORKFLOW); wf = path.relative(ctx.workspace.root, wfPath); }
      return json({ hook: hook.file, chained_existing_hook: hook.chained, workflow: wf, note: "commit the workflow from main so GitHub enforces it on every PR" });
    }
    const st = guardHookStatus(ctx.worktrees.commonDir);
    return json({ hook: st, workflow_present: fs.existsSync(wfPath), ledger_mode: ctx.ledger.isShadow ? `overlay (${ctx.ledger.dir}) over main's ledger` : "main (committed .break-free/)" });
  } catch (e) { return fail(e); }
});


// ---- note review (worker notes are quarantined until the lead promotes them)
server.registerTool("note_review", {
  title: "Promote or reject a worker-written note",
  description: "Notes written by delegated workers (ledger_note) are stored with trust:worker and pending:true — they are NOT injected into other workers until you promote them. Read the note (note_search {full:true}), then promote (becomes trusted, injected from now on) or reject (moved to notes/rejected/). ledger_resume lists what is pending.",
  inputSchema: { slug: z.string(), action: z.enum(["promote", "reject"]) },
}, async ({ slug, action }) => {
  try {
    const n = ctx.ledger.reviewNote(slug, action);
    if (!n) return fail(new Error(`unknown note ${slug}`));
    ctx.ledger.journal(`note ${slug} ${action === "promote" ? "promoted" : "rejected"} by lead`);
    ctx.ledger.render();
    return json({ slug: n.slug, action, pending: n.pending, trust: n.trust });
  } catch (e) { return fail(e); }
});

// ---- cost & budget
server.registerTool("cost_report", {
  title: "Spend report",
  description: "USD spent per day and per provider from the runtime log (list prices; edit `pricing` in config for exact rates), today's spend against budget.perDayUsd, unpriced calls, and the current caps.",
  inputSchema: { days: z.number().int().min(1).max(90).optional().describe("Window in days (default 7)") },
}, async ({ days }) => {
  if (!logger) return json({ enabled: false });
  const since = new Date(Date.now() - (days ?? 7) * 86_400_000).toISOString();
  const events = logger.tail(50_000, (e) => e.kind === "route.attempt" && !!e.ok && String(e.ts) >= since);
  const byDay: Record<string, number> = {}, byProvider: Record<string, { usd: number; calls: number; tokens_in: number; tokens_out: number }> = {}, byModel: Record<string, number> = {};
  let unpriced = 0;
  for (const e of events) {
    const c = Number(e.cost_usd ?? 0); const day = String(e.ts).slice(0, 10); const spec = String(e.spec ?? "?"); const prov = spec.split("/")[0];
    byDay[day] = (byDay[day] ?? 0) + c; byModel[spec] = (byModel[spec] ?? 0) + c;
    const p = (byProvider[prov] ??= { usd: 0, calls: 0, tokens_in: 0, tokens_out: 0 });
    const u = e.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    p.usd += c; p.calls++; p.tokens_in += u?.prompt_tokens ?? 0; p.tokens_out += u?.completion_tokens ?? 0;
    if (e.priced === false) unpriced++;
  }
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const today = ctx.spentTodayUsd();
  const cap = ctx.config.budget.perDayUsd;
  return json({ window_days: days ?? 7, total_usd: r6(Object.values(byDay).reduce((a, b) => a + b, 0)), by_day: Object.fromEntries(Object.entries(byDay).sort().map(([k, v]) => [k, r6(v)])), by_provider: Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, { ...v, usd: r6(v.usd) }])), by_model: Object.fromEntries(Object.entries(byModel).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, r6(v)])), today_usd: today, budget: ctx.config.budget, today_vs_day_cap: cap ? `${Math.round((today / cap) * 100)}%${today / cap >= ctx.config.budget.warnAt ? " — WARNING" : ""}` : "no daily cap", unpriced_calls: unpriced, pricing_note: "list prices from DEFAULT_PRICING merged with config.pricing; set pricing[\"provider/model\"] = {input, output} USD per 1M tokens to correct" });
});
server.registerTool("configure_budget", {
  title: "Set spend caps and prices",
  description: "Persist budget caps (USD; 0 = unlimited) and per-model prices (USD per 1M tokens). Workers stop when a task cap is hit, plans cancel remaining tasks at the plan cap, and new delegations are refused once the day cap is reached.",
  inputSchema: { per_task_usd: z.number().min(0).optional(), per_plan_usd: z.number().min(0).optional(), per_day_usd: z.number().min(0).optional(), warn_at: z.number().min(0).max(1).optional(), pricing: z.record(z.object({ input: z.number().min(0), output: z.number().min(0) })).optional().describe("e.g. {\"deepseek/deepseek-v4-pro\": {input: 0.55, output: 2.19}}"), scope: ScopeSchema },
}, async (a) => {
  try {
    const b: Record<string, unknown> = {};
    if (a.per_task_usd !== undefined) b.perTaskUsd = a.per_task_usd;
    if (a.per_plan_usd !== undefined) b.perPlanUsd = a.per_plan_usd;
    if (a.per_day_usd !== undefined) b.perDayUsd = a.per_day_usd;
    if (a.warn_at !== undefined) b.warnAt = a.warn_at;
    if (a.scope === "project" && Object.keys(b).length) return fail(new Error("budget caps live in the user config (project scope may only set pricing)"));
    const target = targetFor(a.scope);
    saveConfigPatch(target, { ...(Object.keys(b).length ? { budget: b } : {}), ...(a.pricing ? { pricing: a.pricing } : {}) });
    ctx = reload();
    return json({ saved_to: target, budget: ctx.config.budget, pricing_overrides: ctx.config.pricing, defaults_known: Object.keys(DEFAULT_PRICING).length });
  } catch (e) { return fail(e); }
});

// ---- policy rules (enforced by the gateway)
server.registerTool("configure_policy", {
  title: "Policy rules: deny paths to workers, force review on sensitive paths",
  description: "Rules the gateway enforces on every delegate/supervise/run_plan: action 'deny' = matching paths are unreadable and unwritable for workers; action 'review' = if a worker changed a matching path, an independent review by a different vendor runs automatically and a reject fails the task. Rules are appended (set replace:true to replace all). Project scope (.model-gateway.json) is allowed because rules can only add restrictions.",
  inputSchema: { rules: z.array(z.object({ match: z.union([z.string(), z.array(z.string())]), action: z.enum(["deny", "review"]), reason: z.string().optional(), differentVendor: z.boolean().optional() })), replace: z.boolean().optional(), scope: ScopeSchema },
}, async (a) => {
  try {
    const target = targetFor(a.scope);
    const existing = a.replace ? [] : (readJsonFile(target)?.policy as { rules?: unknown[] } | undefined)?.rules ?? [];
    saveConfigPatch(target, { policy: { rules: [...existing, ...a.rules] } });
    ctx = reload();
    return json({ saved_to: target, rules: ctx.config.policy.rules });
  } catch (e) { return fail(e); }
});

// ---- steward & hygiene
server.registerTool("ledger_doctor", {
  title: "Ledger hygiene report",
  description: "Stale notes (backticked paths that no longer exist), done/cancelled tasks older than steward.archiveDoneAfterDays, journal files older than steward.journalKeepDays, and worker notes awaiting review. archive:true moves the old tasks/journal into archive/ subfolders (never deletes).",
  inputSchema: { archive: z.boolean().optional() },
}, async ({ archive }) => {
  try { return json(hygiene(ctx.config, ctx.ledger, ctx.workspace.root, !!archive)); } catch (e) { return fail(e); }
});
server.registerTool("steward", {
  title: "Steward: keep main updated and healthy",
  description: "Run on main (or via `node dist/index.js --steward` from cron/launchd): absorb every worktree's ledger overlay, reconcile the worktree registry (merged/deleted/inactive, overlaps, removable checkouts), hygiene report (archive:true applies it), refresh CODE-MAP.md, run steward.verify on main, regenerate HANDOFF.md/WORKTREES.md, and journal a summary. Nothing destructive: removable worktrees are listed, not removed.",
  inputSchema: { archive: z.boolean().optional(), code_map: z.boolean().optional(), verify: z.boolean().optional() },
}, async ({ archive, code_map, verify }) => {
  try {
    const rep = await runSteward({ config: ctx.config, ledger: ctx.ledger, workspace: ctx.workspace, worktrees: ctx.worktrees, absorb: () => mergeSummary(absorbWorktreeLedgers()), archive, codeMap: code_map, verify });
    return json(rep);
  } catch (e) { return fail(e); }
});

server.registerTool("task_create", {
  title: "Create a ledger task",
  description: "Add a task to the durable board (.break-free/tasks/<id>.md) with problem statement, acceptance criteria, dependencies, owner and verify command. Use it for every unit of work you delegate or plan so a new session can pick it up.",
  inputSchema: {
    title: z.string(),
    problem: z.string().optional().describe("What needs to be done and why"),
    acceptance: z.string().optional().describe("How we know it is done (tests, behaviour, review)"),
    depends_on: z.array(z.string()).optional().describe("Ledger task ids"),
    owner: z.string().optional().describe("Model spec, 'orchestrator', or a person"),
    verify: z.string().optional().describe("Allow-listed command proving completion"),
    tags: z.array(z.string()).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    id: z.string().optional().describe("Explicit id (default T-NNN)"),
  },
}, async (a) => {
  try {
    return json(ctx.ledger.createTask(a));
  } catch (e) {
    return fail(e);
  }
});
server.registerTool("task_update", {
  title: "Update a ledger task",
  description: "Change status/owner/outcome/etc. of a task and/or append a log line. Status flow: todo → in_progress → review → done (or blocked / cancelled).",
  inputSchema: {
    id: z.string(),
    status: z.enum(TASK_STATUSES).optional(),
    title: z.string().optional(),
    owner: z.string().optional(),
    outcome: z.string().optional().describe("What was delivered; where; how it was verified"),
    problem: z.string().optional(),
    acceptance: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    verify: z.string().optional(),
    log: z.string().optional().describe("Progress line appended to the task log"),
  },
}, async ({ id, ...patch }) => {
  try {
    return json(ctx.ledger.updateTask(id, patch));
  } catch (e) {
    return fail(e);
  }
});
server.registerTool("task_list", {
  title: "List ledger tasks",
  description: "Tasks on the board, optionally filtered by status or tag. ready:true returns only tasks whose dependencies are done.",
  inputSchema: { status: z.array(z.enum(TASK_STATUSES)).optional(), tag: z.string().optional(), ready: z.boolean().optional() },
}, async ({ status, tag, ready }) => {
  const rows = ready ? ctx.ledger.ready() : ctx.ledger.listTasks({ status, tag });
  return json(rows.map(({ log, problem, acceptance, outcome, ...rest }) => ({ ...rest, last: log.at(-1) ?? null, has_outcome: !!outcome })));
});
server.registerTool("task_get", { title: "Get a ledger task", description: "Full task: problem, acceptance criteria, outcome and log.", inputSchema: { id: z.string() } }, async ({ id }) => {
  const t = ctx.ledger.getTask(id);
  return t ? json(t) : fail(new Error(`unknown task ${id}`));
});
server.registerTool("note_write", {
  title: "Write a knowledge note",
  description: "Record durable project knowledge in .break-free/notes/<slug>.md: decisions (and why), gotchas, conventions, how-tos, findings. Notes tagged decision/gotcha/convention/howto are injected into every worker's context automatically, so this is how you make all workers respect what you have learned.",
  inputSchema: { title: z.string(), body: z.string().describe("Markdown; [[wikilinks]] to other notes/tasks welcome"), tags: z.array(z.string()).optional().describe("decision | gotcha | convention | howto | finding | …"), append: z.boolean().optional().describe("Append to an existing note instead of replacing its body") },
}, async (a) => {
  try {
    const n = ctx.ledger.writeNote({ ...a, source: "orchestrator" });
    ctx.ledger.render();
    return json({ file: `.break-free/notes/${n.slug}.md`, title: n.title, tags: n.tags });
  } catch (e) {
    return fail(e);
  }
});
server.registerTool("note_search", {
  title: "Search knowledge notes",
  description: "Find notes by substring/glob in title, tags or body; or list all notes when query is omitted.",
  inputSchema: { query: z.string().optional(), full: z.boolean().optional().describe("Return full note bodies") },
}, async ({ query, full }) => {
  if (!query) return json(ctx.ledger.listNotes().map((n) => ({ slug: n.slug, title: n.title, tags: n.tags, updated: n.updated, ...(full ? { body: n.body } : { preview: n.body.slice(0, 200) }) })));
  return json(ctx.ledger.searchNotes(query).map(({ note, hits }) => ({ slug: note.slug, title: note.title, tags: note.tags, hits, ...(full ? { body: note.body } : {}) })));
});
server.registerTool("code_map", {
  title: "Build a code map (import graph + symbols)",
  description: "Scan the workspace (TS/JS, Python, Go, Rust) and write .break-free/CODE-MAP.md: directories, most-depended-on modules, a Mermaid import graph and exported symbols per module. Cheap orientation for you, for new sessions and for workers (give them the file path). Returns a summary.",
  inputSchema: { include: z.string().optional().describe("Only paths containing this substring"), max_files: z.number().int().positive().max(10_000).optional(), write: z.boolean().optional().describe("Write CODE-MAP.md (default true)") },
}, async ({ include, max_files, write }) => {
  try {
    const map = await buildCodeMap(ctx.workspace, { include, maxFiles: max_files });
    const file = write === false ? null : writeCodeMap(ctx.workspace, map);
    return json({ file: file ? ".break-free/CODE-MAP.md" : null, files: map.files, modules: Object.keys(map.modules).length, hubs: map.hubs, directories: Object.entries(map.dirs).sort((a, b) => b[1] - a[1]).slice(0, 20) });
  } catch (e) {
    return fail(e);
  }
});


// ---- worktrees: shared map of parallel checkouts (registry in .git/break-free/, visible from every worktree)
const WtStatusSchema = z.enum(WORKTREE_STATUSES);
const wtFields = {
  purpose: z.string().optional().describe("One line: what this worktree is for"),
  agent: z.string().optional().describe("Who works here: claude-code | codex | opencode | kiro | kimi | pi | omp | agy | a person's name"),
  base: z.string().optional().describe("Branch it merges into (default: the repo's main branch)"),
  tasks: z.array(z.string()).optional().describe("Ledger task ids (T-001 …) handled here"),
  issues: z.array(z.string()).optional().describe("GitHub issues, e.g. ['#42', 'owner/repo#7']"),
  prs: z.array(z.string()).optional().describe("Pull requests, e.g. ['#43']"),
  tools: z.array(z.string()).optional().describe("MCP servers / notable tools in use here"),
  models: z.array(z.string()).optional().describe("Models used here, e.g. ['deepseek/deepseek-v4-pro']"),
  paths: z.array(z.string()).optional().describe("Claimed paths/globs this worktree intends to change, e.g. ['src/api/**']; overlaps with other worktrees are flagged"),
  handoff: z.string().optional().describe("Handoff note for whoever picks this up: state, next steps, gotchas, how to verify"),
};
server.registerTool("worktree_list", {
  title: "List worktrees (shared across all checkouts)",
  description: "Every git worktree of this repository with what it is doing: status (active/inactive/blocked/merged/abandoned/deleted + reason), agent, purpose, ledger tasks, GitHub issues and PRs, tools, models, last handoff. Reconciled with `git worktree list` on every call, so deleted checkouts and merged branches are detected automatically. Call it before starting parallel work and whenever you need to know what other agents are doing.",
  inputSchema: { markdown: z.boolean().optional().describe("Return the WORKTREES.md rendering instead of JSON") },
}, async ({ markdown }) => {
  try {
    if (!ctx.worktrees.available()) return fail(new Error("not a git repository"));
    return markdown ? text(ctx.worktrees.render()) : json({ current: ctx.worktrees.current()?.name ?? null, current_branch: ctx.worktrees.currentBranch(), main_branch: ctx.worktrees.detectMainBranch(), registry: ctx.worktrees.file, overlaps: ctx.worktrees.conflicts(), worktrees: ctx.worktrees.list() });
  } catch (e) { return fail(e); }
});
server.registerTool("worktree_register", {
  title: "Register / claim this worktree",
  description: "Record the checkout this gateway runs in (or `path`) in the shared registry with its purpose, agent, tasks, issues, PRs, tools and models, so main and every other worktree know what is happening here. Idempotent: call again to add fields. Also acts as a heartbeat.",
  inputSchema: { path: z.string().optional().describe("Another worktree's path (default: this checkout)"), name: z.string().optional().describe("Registry name (default: branch name)"), ...wtFields },
}, async (a) => {
  try { return json(ctx.worktrees.register(a)); } catch (e) { return fail(e); }
});
server.registerTool("worktree_update", {
  title: "Update a worktree's status / metadata",
  description: "Change status with a reason (active | inactive | blocked | merged | abandoned | deleted), add tasks/issues/PRs/tools/models, append a log line, or write a handoff note. Use it when you pause ('inactive: waiting for review of #43'), give up ('abandoned: approach replaced by T-012'), finish ('merged'), or hand over.",
  inputSchema: { name: z.string().describe("Worktree name, branch, or path"), status: WtStatusSchema.optional(), reason: z.string().optional().describe("Why — required when setting inactive/blocked/abandoned/deleted"), log: z.string().optional(), heartbeat: z.boolean().optional(), ...wtFields },
}, async ({ name, ...a }) => {
  try {
    if (a.status && ["inactive", "blocked", "abandoned", "deleted"].includes(a.status) && !a.reason) return fail(new Error(`status '${a.status}' needs a reason`));
    return json(ctx.worktrees.update(name, a));
  } catch (e) { return fail(e); }
});
server.registerTool("worktree_handoff", {
  title: "Write a handoff for a worktree",
  description: "Record where this worktree's work stands so another agent (or a later session, or main) can continue: done / not done / next steps / how to verify / gotchas. Also updates status if given and records it in the ledger journal.",
  inputSchema: { name: z.string().optional().describe("Default: this checkout"), handoff: z.string(), status: WtStatusSchema.optional(), reason: z.string().optional(), tasks: z.array(z.string()).optional(), prs: z.array(z.string()).optional(), issues: z.array(z.string()).optional() },
}, async ({ name, ...a }) => {
  try {
    const target = name ?? ctx.worktrees.current()?.name ?? ctx.worktrees.register({}).name;
    const w = ctx.worktrees.update(target, a);
    if (ctx.ledger.exists()) ctx.ledger.journal(`handoff from worktree ${w.name} [${w.status}]: ${a.handoff.split("\n")[0].slice(0, 160)}`);
    return json(w);
  } catch (e) { return fail(e); }
});
server.registerTool("worktree_create", {
  title: "Create a worktree for parallel work",
  description: "git worktree add (new or existing branch) under <repo>.worktrees/<branch> (or `dir`), then register it with purpose/agent/tasks/issues so everyone sees it. Non-destructive. Point another agent (or a delegated worker via a second gateway instance) at the returned path.",
  inputSchema: { branch: z.string(), from: z.string().optional().describe("Start point (default: main branch)"), dir: z.string().optional(), purpose: z.string().optional(), agent: z.string().optional(), tasks: z.array(z.string()).optional(), issues: z.array(z.string()).optional(), tools: z.array(z.string()).optional(), models: z.array(z.string()).optional(), paths: z.array(z.string()).optional().describe("Claimed paths/globs") },
}, async (a) => {
  try {
    const w = ctx.worktrees.create(a);
    let guard: string | undefined;
    try { guard = installGuardHook(ctx.worktrees.commonDir!).file; } catch { /* best effort */ }
    return json({ ...w, ledger_guard_hook: guard ?? null, hint: `start the other agent in ${w.path}; its ledger writes go to a local overlay and are absorbed by main` });
  } catch (e) { return fail(e); }
});
server.registerTool("worktree_remove", {
  title: "Remove a worktree checkout (keeps the branch)",
  description: "git worktree remove + registry status 'deleted' with the reason. Refuses the main tree, the current checkout, dirty trees and unmerged branches unless force:true. The branch itself is never deleted.",
  inputSchema: { name: z.string(), reason: z.string(), force: z.boolean().optional() },
}, async ({ name, reason, force }) => {
  try {
    let absorbed = "";
    try { absorbed = mergeSummary(absorbWorktreeLedgers(name)); } catch (e) { absorbed = `absorb failed: ${(e as Error).message}`; }
    const w = ctx.worktrees.remove(name, reason, !!force);
    if (ctx.ledger.exists()) ctx.ledger.journal(`worktree ${w.name} removed: ${reason}${absorbed ? ` (ledger absorbed: ${absorbed})` : ""}`);
    return json({ ...w, ledger_absorbed: absorbed || "nothing new" });
  } catch (e) { return fail(e); }
});
server.registerTool("worktree_sync", {
  title: "Write WORKTREES.md into this checkout's ledger",
  description: "Render the shared registry to .break-free/WORKTREES.md here (commit it from main to keep the history in the repo) and refresh HANDOFF.md. Returns the rendering.",
  inputSchema: {},
}, async () => {
  try {
    if (!ctx.ledger.exists()) ctx.ledger.init();
    const md = ctx.worktrees.render();
    fs.writeFileSync(path.join(ctx.ledger.dir, "WORKTREES.md"), md);
    ctx.ledger.render();
    return text(md);
  } catch (e) { return fail(e); }
});

// ---- logs
server.registerTool("gateway_logs", {
  title: "Gateway runtime log / health",
  description: "Inspect the gateway's own runtime log: per-provider success/failure counts and reasons, per-tool stats, detected problems (e.g. a provider failing on every call), and optionally the raw recent events. Use this when delegation behaves oddly before blaming the model.",
  inputSchema: {
    last: z.number().int().positive().max(5000).optional().describe("How many recent events to analyse (default 500)"),
    raw: z.boolean().optional().describe("Include the raw events"),
    kind: z.string().optional().describe("Filter raw events by kind: tool.start, tool.end, route.attempt, worker.tool, mcp.connect, mcp.call, job.start, job.end"),
    call: z.string().optional().describe("Only events for this correlation id"),
  },
}, async ({ last, raw, kind, call }) => {
  if (!logger) return json({ enabled: false, hint: "logging disabled via config.logFile=false" });
  const events = logger.tail(last ?? 500, (e) => (!kind || e.kind === kind) && (!call || e.call === call));
  const a = analyze(events);
  return json({ file: logger.file, ...a, ...(raw ? { events } : {}) });
});

// ---- sessions
server.registerTool("session_list", { title: "List sessions", description: "List delegated-model sessions (id, turns, last model, updated).", inputSchema: {} }, async () => json(ctx.sessions.list()));
server.registerTool("session_get", {
  title: "Get session transcript",
  description: "Return the conversation history of a session (truncated per message).",
  inputSchema: { session_id: z.string(), max_chars_per_message: z.number().int().positive().optional() },
}, async ({ session_id, max_chars_per_message }) => {
  const s = ctx.sessions.get(session_id);
  const lim = max_chars_per_message ?? 2000;
  return json({ meta: s.meta, messages: s.messages.map((m) => ({ role: m.role, name: m.name, content: (m.content ?? "").slice(0, lim), tool_calls: m.tool_calls?.map((t) => `${t.function.name}(${t.function.arguments.slice(0, 200)})`) })) });
});
server.registerTool("session_clear", { title: "Clear session", description: "Delete a session's history.", inputSchema: { session_id: z.string() } }, async ({ session_id }) => json({ cleared: ctx.sessions.clear(session_id) }));

// ---- harness sub-agents (tmux PTY — subscription, not API credits)
server.registerTool("harness_spawn", {
  title: "Spawn a harness sub-agent",
  description: "Start another coding harness (claude, codex, omp, pi, grok, …) inside a detached tmux session — a real PTY — so it runs in the interactive/subscription mode instead of `claude -p` (print mode bills the API per token). Returns a session id for harness_send / harness_read / harness_status / harness_close, plus an `attach` command to watch or type into the session directly. A harness sub-agent shares the repo (and its worktree) with the lead but runs in its own terminal.",
  inputSchema: {
    harness: z.string().describe("CLI command that owns the session: claude, codex, omp, pi, grok, …"),
    cwd: z.string().optional().describe("Working directory (default: the gateway workspace root)"),
    command: z.string().optional().describe("Exact command override (default: the harness name)"),
  },
}, async (a) => {
  const s = await ctx.harnessctl.spawn(a.harness, a);
  return json({ ...s, attach: ctx.harnessctl.attach(s) });
});

server.registerTool("harness_send", {
  title: "Send input to a harness session",
  description: "Write literal keystrokes into a tmux harness session (plus Enter by default). Use for prompts, follow-ups, or approvals.",
  inputSchema: { id: z.string(), text: z.string(), enter: z.boolean().default(true) },
}, async (a) => { await ctx.harnessctl.send(a.id, a.text, a.enter); return json({ id: a.id, sent: true }); });

server.registerTool("harness_read", {
  title: "Read a harness session",
  description: "Capture the tmux pane text (last N lines of scrollback) so the lead can see what the sub-agent did.",
  inputSchema: { id: z.string(), lines: z.number().int().positive().default(400) },
}, async (a) => json({ id: a.id, output: await ctx.harnessctl.read(a.id, a.lines) }));

server.registerTool("harness_status", {
  title: "Harness session status",
  description: "running / exited / unknown for a harness sub-agent, plus the `attach` command to watch or type into it.",
  inputSchema: { id: z.string() },
}, async (a) => json({ id: a.id, state: await ctx.harnessctl.status(a.id), attach: ctx.harnessctl.attachFor(a.id) }));

server.registerTool("harness_close", {
  title: "Close a harness session",
  description: "Kill the tmux session (ends the sub-agent).",
  inputSchema: { id: z.string() },
}, async (a) => json({ id: a.id, closed: await ctx.harnessctl.close(a.id) }));

server.registerTool("harness_list", {
  title: "List harness sessions",
  description: "Every harness sub-agent with its tmux name, harness, cwd, state, timestamps and `attach` command — use to resume work a previous session started.",
  inputSchema: {},
}, async () => json({ sessions: (await ctx.harnessctl.list()).map((s) => ({ ...s, attach: ctx.harnessctl.attach(s) })) }));

// ------------------------------------------------------------ main
async function main() {
  if (argv.includes("--selftest")) {
    // Print a config/provider summary and exit non-zero if nothing is usable.
    const rows = listProviderNames(ctx.config).map(providerReport);
    const usable = rows.filter((r) => r.usable).map((r) => r.provider);
    console.log(JSON.stringify({ config_files: loaded.sources, workspace: ctx.workspace.root, usable_providers: usable, github_cli: await ghAvailable(), providers: rows }, null, 2));
    process.exit(usable.length ? 0 : 2);
  }
  if (argv.includes("--logs")) {
    // Machine-readable health summary for setup --doctor
    const n = Number(flag("--logs")) || 500;
    const events = logger ? logger.tail(n) : [];
    console.log(JSON.stringify({ file: logger?.file ?? null, enabled: !!logger, ...analyze(events) }, null, 2));
    process.exit(0);
  }
  if (argv.includes("--fleet-check")) {
    if (argv.includes("--hook")) {
      // Claude Code Stop-hook contract: block -> one line of JSON on stdout;
      // allow -> no output at all. Nothing may be written to stderr.
      const stderrWrite = process.stderr.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        const res = await fleetCheck();
        if (res.blocking) {
          const parts: string[] = [];
          const ciFailed = res.pending.filter((e) => e.kind === "ci.failed");
          const ciPending = res.pending.filter((e) => e.kind === "ci.pending");
          for (const f of ciFailed) parts.push(`CI FAILED on ${(f.ci?.sha ?? f.id).slice(0, 7)}${f.ci?.job ? ` (${f.ci.job})` : ""}${f.ci?.url ? ` - ${f.ci.url}` : ""}`);
          for (const p of ciPending) parts.push(`CI pending on ${(p.ci?.sha ?? p.id).slice(0, 7)}`);
          if (res.running.jobs > 0) parts.push(`${res.running.jobs} job(s) running`);
          const other = res.pending.length - ciFailed.length - ciPending.length;
          if (other > 0) parts.push(`${other} event(s) pending`);
          const reason = `${parts.join(", ")} - ${ciFailed.length ? "fix it before ending the turn" : "call fleet_status to collect them"}`;
          console.log(JSON.stringify({ decision: "block", reason }));
        }
      } catch {
        // Hook mode is silent on any internal error: no stdout, no stderr.
      } finally {
        process.stderr.write = stderrWrite;
      }
      process.exit(0);
    }
    // Shell-hook friendly fleet status: always valid JSON, always exit 0.
    try {
      console.log(JSON.stringify(await fleetCheck(), null, 2));
    } catch {
      console.log(JSON.stringify({ running: { jobs: 0, harness: 0 }, pending: [], blocking: false }, null, 2));
    }
    process.exit(0);
  }
  if (argv.includes("--serve")) {
    const port = Number(flag("--serve")) || Number(process.env.MODEL_GATEWAY_SERVE_PORT) || 18790;
    rlog("server", { event: "serve", port, pid: process.pid, version: VERSION });
    startServe(ctx.config, port, log);
    return; // keep running
  }
  if (argv.includes("--steward")) {
    const rep = await runSteward({ config: ctx.config, ledger: ctx.ledger, workspace: ctx.workspace, worktrees: ctx.worktrees, absorb: () => mergeSummary(absorbWorktreeLedgers()), archive: argv.includes("--archive") });
    console.log(JSON.stringify(rep, null, 2));
    process.exit(rep.verify && "ok" in rep.verify && !rep.verify.ok ? 1 : 0);
  }
  if (argv.includes("--ledger-guard")) {
    // Used by setup.mjs (project scope): pre-commit hook in the common hooks dir + PR guard workflow.
    if (!ctx.worktrees.commonDir) { console.error("not a git repository"); process.exit(2); }
    const hook = installGuardHook(ctx.worktrees.commonDir);
    const wf = path.join(ctx.workspace.root, ".github", "workflows", "break-free-ledger-guard.yml");
    fs.mkdirSync(path.dirname(wf), { recursive: true });
    fs.writeFileSync(wf, LEDGER_GUARD_WORKFLOW);
    console.log(JSON.stringify({ hook: hook.file, chained: hook.chained, workflow: wf }));
    process.exit(0);
  }
  if (argv.includes("--print-config")) {
    console.log(JSON.stringify(ctx.config, (k, v) => (k === "apiKey" ? redactKey(v) : v), 2));
    process.exit(0);
  }
  if (!fs.existsSync(ctx.workspace.root)) throw new Error(`workspace does not exist: ${ctx.workspace.root}`);
  log(`workspace=${ctx.workspace.root} config=${loaded.sources.join(",") || "(defaults)"} stateless=${stateless} log=${logger?.file ?? "off"}`);
  rlog("server", { event: "start", workspace: ctx.workspace.root, config: loaded.sources, stateless, pid: process.pid, version: VERSION });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  log(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});

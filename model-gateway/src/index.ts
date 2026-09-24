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
import { zodToJsonSchema } from "zod-to-json-schema";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loadConfig, listProviderNames, priceFor, costUsd, redactKey, resolveProvider, saveConfigPatch, FALLBACK_REASONS, type GatewayConfig, type LoadedConfig } from "./config.js";
import { chatCompletion, listRemoteModels } from "./client.js";
import { parseSpec, resolveCandidates } from "./router.js";
import { Workspace, CAPABILITIES } from "./workspace.js";
import { McpBridge } from "./mcpbridge.js";
import { JobRegistry } from "./jobs.js";
import { Ledger, TASK_STATUSES } from "./ledger.js";
import { buildCodeMap, writeCodeMap } from "./codemap.js";
import { startServe } from "./serve.js";
import { WorktreeRegistry, WORKTREE_STATUSES, isLinkedWorktree, shadowLedgerDir, installGuardHook, guardHookStatus, removeGuardHook, LEDGER_GUARD_WORKFLOW } from "./worktrees.js";
import { LEDGER_DIR } from "./ledger.js";
import { resolveVault, linkLedger, resolveGraph, type GraphProbe } from "./knowledge.js";
import { status as firstmateStatus, planUpdate, updateCommand, parseUpdateSummary, updateAvailable, sessionLabel, FIRSTMATE_REPO, FIRSTMATE_LABEL } from "./firstmate.js";
import { behindOrigin, isCheckout, readCache, writeCache, cacheIsWarm, notice as updateNotice, type UpdateState, type ComponentUpdate } from "./updates.js";
import { estimateTokens, line as ctxLine, report as ctxReport, renderReport, type ContextLine } from "./context.js";
import { runSteward, hygiene } from "./steward.js";
import { DEFAULT_PRICING } from "./config.js";
import { ghAvailable } from "./github.js";
import { SessionStore } from "./sessions.js";
import { HarnessController } from "./harnessctl.js";
import { appendEvents, classify, drainTo, expireCi, pendingEvents, readSnapshot, resolveCi, resolveJob, writeSnapshot, type FleetEvent, type FleetSnapshot } from "./fleet.js";
import { getBreaker } from "./breaker.js";
import { delegate, panel, review, supervise, runPlan, type Ctx } from "./orchestrate.js";
import { PROVIDER_CATALOG, isLocalEndpoint } from "./providers.js";
import { LANES, LANE_SPEC, effectiveLaneMap, routePlanTasks, resolveEngine } from "./routing.js";
import { listModels as listJevModels, probe as probeJev } from "./jev.js";
import { Logger, analyze, callContext, setLogger, summarizeArgs, log as rlog, type LogEvent } from "./logger.js";

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
  jobs ??= new JobRegistry(config, stateless, workspace.root);
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
    // Only this workspace's jobs: another project's finished run is not this turn's business.
    for (const j of jobs!.list({ mine: true })) jobsMap[j.id] = j.state;
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
      harness[s.id] = { state: s.state, digest, since: unchanged ? prevH!.since : ts, cwd: s.cwd };
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
  const shas = [...new Set(pendingEvents(sessionDir, ctx.workspace.root).filter((e) => e.kind === "ci.pending").map((e) => e.ci?.sha).filter((x): x is string => !!x))];
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

/** The MCP bridge, seen through the narrow interface graph resolution needs. */
const graphProbe: GraphProbe = {
  servers: () => Object.keys(ctx.mcp.servers()),
  toolNames: async (name) => (await ctx.mcp.describe(name)).tools.map((t) => t.name),
};

/** Resolved once per process: probing every server on every call would cost a connection each time. */
let graphCache: Promise<{ provider: string; reason: string; external: boolean }> | undefined;
function graphResolution() {
  return (graphCache ??= resolveGraph(ctx.config.knowledge.graph.provider, graphProbe).catch((e) => ({
    provider: "builtin",
    reason: `unresolved: ${(e as Error).message}`,
    external: false,
  })));
}

/**
 * Check for updates, and take them, at session start.
 *
 * Deliberately not awaited by anything on the startup path: a session must not wait on a git
 * fetch, and a network that is down is not a reason for the gateway to be. The result lands in
 * a cache that ledger_resume reads, so the notice reaches the session whether or not this
 * finished first.
 */
async function refreshUpdates(): Promise<UpdateState | undefined> {
  const cfg = ctx.config.updates;
  const sessionDir = ctx.config.sessionDir;
  if (!cfg.check || !sessionDir) return undefined;

  const cached = readCache(sessionDir);
  if (cacheIsWarm(cached, cfg.intervalHours)) return cached;

  const roots: { name: ComponentUpdate["name"]; root: string }[] = [
    { name: "break-free", root: path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..") },
    { name: "firstmate", root: firstmateStatus(ctx.config.firstmate).root },
  ];

  const components: ComponentUpdate[] = [];
  const applied: UpdateState["applied"] = [];

  for (const { name, root } of roots) {
    if (!isCheckout(root)) { components.push({ name, root, instructionChanges: [], reason: "not a git checkout" }); continue; }
    const r = await behindOrigin(root, { fetch: true });
    // Only firstmate's changes steer an agent; break-free's are a program's.
    const instructionChanges = name === "firstmate" && r.target ? planUpdate(root, r.target).instructionChanges : [];
    const before = r.behind;

    if (cfg.apply && (r.behind ?? 0) > 0) {
      const from = execFileSyncQuiet(root, ["rev-parse", "HEAD"]);
      // Fast-forward only: a checkout someone has edited is left exactly as it is, because
      // discarding their work to install a version they did not ask for would be far worse
      // than being a version behind.
      const ok = execFileSyncQuiet(root, ["merge", "--ff-only", r.target ?? "origin/HEAD"]) !== undefined;
      const to = execFileSyncQuiet(root, ["rev-parse", "HEAD"]);
      if (ok && from && to && from !== to) applied.push({ name, from, to });
    }
    const after = cfg.apply ? (await behindOrigin(root)).behind : before;
    components.push({ name, root, behind: after ?? before, instructionChanges, reason: r.reason });
  }

  const state: UpdateState = { checkedAt: new Date().toISOString(), components, applied };
  writeCache(sessionDir, state);
  if (applied.length) rlog("updates.applied", { applied });
  return state;
}

/** git, quietly: a failure here is information, not an exception to propagate. */
function execFileSyncQuiet(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }).trim();
  } catch {
    return undefined;
  }
}

async function fleetCheck(): Promise<{ running: { jobs: number; harness: number }; pending: FleetEvent[]; blocking: boolean }> {
  const sessionDir = ctx.config.sessionDir!;
  // Per workspace: the snapshot holds only this workspace's jobs, so sharing one file made
  // every gateway's `prev` somebody else's job list, and its own finished jobs look new again.
  const prev = readSnapshot(sessionDir, ctx.workspace.root);
  const next = await buildFleetSnapshot(prev);
  // The gateway owns the jobs it started, so those carry its workspace. A harness session owns
  // itself and carries its own cwd from classify(); defaulting it here would re-create the bug
  // this scoping exists to fix, by making the observer the owner.
  const events = classify(prev, next, ctx.config.fleet.idleMs).map((e) =>
    e.kind.startsWith("job.") ? { ...e, workspace: ctx.workspace.root } : e,
  );
  appendEvents(sessionDir, events);
  writeSnapshot(sessionDir, next, ctx.workspace.root);
  await reconcileCi(sessionDir);
  const pending = pendingEvents(sessionDir, ctx.workspace.root);
  const running = {
    jobs: Object.values(next.jobs).filter((s) => s === "running").length,
    harness: Object.values(next.harness).filter((h) => h.state === "running" && (!h.cwd || h.cwd.startsWith(ctx.workspace.root))).length,
  };
  return { running, pending, blocking: running.jobs > 0 || pending.length > 0 };
}

const CapabilitySchema = z.array(z.enum(CAPABILITIES as [string, ...string[]])).describe(
  "What the worker may do; grant deliberately. read = files/grep/diff, jailed to the workspace. write = create/edit files. git = branch/commit/push, never protected branches, never force. github = issues/PRs/Actions via gh, implies git. run = allow-listed commands only. mcp = tools of the servers in mcp_servers. Default: [\"read\"].",
) as unknown as z.ZodType<import("./workspace.js").Capability[]>;

const MinTierSchema = z.number().int().min(1).max(3).optional().describe(
  "Never route below this tier. Default: the tier of the model you asked for, so a capable request is never silently answered by a weak model.",
);
const AllowDowngradeSchema = z.boolean().optional().describe(
  "Allow falling below the floor once everything at or above it has failed.",
);

const StallAbortMsSchema = z.number().int().min(0).optional().describe(
  "Abort this worker as `stalled` after this many ms with no tool call (a worker that reads for ten minutes and writes nothing is not working). 0 disables. Default: config.workers.stallAbortMs (600000).",
);
const StallWarnMsSchema = z.number().int().min(0).optional().describe(
  "Emit a progress line after this many ms with no tool call, before the abort. 0 disables. Default: config.workers.stallWarnMs (180000).",
);

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
  // A private base URL plus "no API key" is usually a local server configured before `requiresKey`
  // mattered, so the report points at the one-call fix instead of leaving hand-editing the config as
  // the only way forward (#13). Kept here rather than in resolveProvider so the resolution path
  // carries no presentation.
  const localKeyHint = p.requiresKey && !p.apiKey && isLocalEndpoint(p.baseUrl)
    ? `; this endpoint looks local, so if it needs no auth: configure_provider {provider:"${name}", requires_key:false}`
    : "";
  return {
    provider: name,
    label: p.label,
    usable: !p.unusableReason,
    reason: p.unusableReason ? `${p.unusableReason}${localKeyHint}` : null,
    base_url: p.baseUrl,
    api_key: p.requiresKey ? redactKey(p.apiKey) : p.apiKey ? redactKey(p.apiKey) : "(not required)",
    requires_key: p.requiresKey,
    key_env: p.keyEnv,
    default_model: p.defaultModel,
    kind: p.kind,
    known_models: p.knownModels,
    supports_tools: p.supportsTools,
    get_key: p.docs,
    notes: p.notes ?? null,
  };
}

// ------------------------------------------------------------ server
// Read from package.json rather than kept by hand: this said 3.4.0 while the package said
// 3.7.0, so the server reported a version three releases stale to every client that asked.
const VERSION: string = (() => {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    return JSON.parse(fs.readFileSync(path.join(here, "..", "package.json"), "utf8")).version as string;
  } catch {
    return "0.0.0-unknown";
  }
})();
/**
 * Every registered tool's schema is sent to the lead in every session and re-sent every turn,
 * so the tool surface is a standing cost, not a per-call one. Recording it at registration is
 * the only place that sees all of it without re-deriving the list by hand and drifting.
 */
/** Sent to the lead at every session start, so it is a standing cost and named as one. */
const SERVER_INSTRUCTIONS = [
  "break-free-gateway lets you keep the high-order work — deciding, designing, reviewing, owning outcomes — and hand execution to other models.",
  "Name a model as an alias (fast, strong, reviewer, local, cloud), 'provider/model', a bare provider, or a comma-separated fallback list. Every call falls back according to config.fallback, and never below the tier you asked for unless you allow it.",
  "Verification is yours to SPECIFY, not to perform: give every task acceptance criteria and a `verify` command the gateway runs itself after the worker finishes. Worker prose is a claim; the exit code is the truth. Gate risky work with review or supervise.",
  "Give workers least privilege: capabilities are explicit, and 'github' and 'run' are not defaults.",
  "Long-horizon work: call ledger_resume first. The board and the notes live in .break-free/ and are committed with the repo, so decisions and gotchas reach every worker and survive this session.",
];

const toolSchemaCost: { name: string; tokens: number }[] = [];

/** Schema text as the client receives it: the field names plus whatever .describe() carries. */
function schemaText(shape: Record<string, unknown> | undefined): string {
  if (!shape) return "";
  // Serialize exactly as the SDK does when it answers tools/list, so the number is what the
  // client actually receives. Counting field names and descriptions alone — which this did —
  // omits types, enums, nested objects and required lists, and under-reports every tool.
  try {
    return JSON.stringify(zodToJsonSchema(z.object(shape as z.ZodRawShape)));
  } catch {
    return Object.keys(shape).join(" ");
  }
}

const server = new McpServer({ name: "break-free-gateway", version: VERSION }, {
  instructions: SERVER_INSTRUCTIONS.join("\n"),
});

/**
 * Tools the turn-end guard tells the agent to call. Kept in one place because the guard's
 * message and the advertised tool surface are written far apart and drifted apart once already.
 */
const HOOK_TOOLS = ["fleet_status"] as const;

/**
 * Execution, its lifecycle, and the first call of a session stay typed and resident.
 *
 * Astra's rule, and it is right: keep operations with their lifecycle. Advertising `delegate`
 * while hiding `job_cancel` would leave an agent able to start work it cannot stop.
 */
const RESIDENT_TOOLS = new Set([
  "delegate", "run_plan", "supervise", "review",
  "job_status", "job_result", "job_cancel", "job_list",
  "ledger_resume", "list_models",
  // The turn-end guard blocks the turn and names this tool as the way out, so hiding it behind
  // discovery deadlocks the session: the agent is told to call something it cannot see, cannot
  // drain, and the guard blocks again on the identical events. Anything a blocking message
  // instructs the agent to call has to be advertised. HOOK_TOOLS keeps that honest.
  ...HOOK_TOOLS,
  "bf_discover", "bf_invoke",
]);

/** Every registered operation, whether or not its schema is advertised. */
const operations = new Map<string, { def: Record<string, unknown>; handler: (a: Record<string, unknown>) => unknown }>();

// Wrap once, so every registerTool below is accounted and, under the compact profile, the
// rarely-used operations move behind discovery instead of being advertised in every turn.
const registerToolRaw = server.registerTool.bind(server);
(server as unknown as { registerTool: typeof registerToolRaw }).registerTool = ((name: string, def: Record<string, unknown>, handler: unknown) => {
  operations.set(name, { def, handler: handler as (a: Record<string, unknown>) => unknown });
  const compact = ctx.config.context.toolProfile === "compact" && !RESIDENT_TOOLS.has(name);
  if (compact) return undefined as unknown as ReturnType<typeof registerToolRaw>;
  const text = `${name}${def.title ?? ""}${def.description ?? ""}${schemaText(def.inputSchema as Record<string, unknown> | undefined)}`;
  toolSchemaCost.push({ name, tokens: estimateTokens(text) });
  return (registerToolRaw as (...a: unknown[]) => unknown)(name, def, handler);
}) as typeof registerToolRaw;

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
        const prov = resolveProvider(ctx.config, n)!;
        try {
          const models = prov.kind === "decision" ? await listJevModels(prov) : await listRemoteModels(prov);
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
      return json({ provider, kind: p.kind, models: p.kind === "decision" ? await listJevModels(p) : await listRemoteModels(p) });
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
  description: "Send a tiny real chat completion to verify the key, base URL and model work. Returns latency, the reply, and what the probe cost — it is a real, billable call, priced and logged like any other. An empty reply always says why (a reasoning model can spend the budget thinking before it answers). Use after configure_provider.",
  inputSchema: { spec: z.string().describe("alias, provider, or provider/model"), with_tools: z.boolean().optional().describe("Also verify tool-calling works (default true)") },
}, async ({ spec, with_tools }) => {
  const results: unknown[] = [];
  // Decision providers (TypeSafe/Jev) are not OpenAI-compatible and deliberately never appear in
  // a candidate chain, so probe them on their own endpoint instead of reporting "nothing resolves".
  const parsedSpec = parseSpec(ctx.config, spec.trim());
  const decisionProvider = parsedSpec ? resolveProvider(ctx.config, parsedSpec.provider) : undefined;
  if (decisionProvider?.kind === "decision") {
    if (decisionProvider.unusableReason) return fail(new Error(`${spec}: ${decisionProvider.unusableReason}`));
    const p = await probeJev(decisionProvider);
    rlog("route.decision", { kind: "routing", spec: `${decisionProvider.name}/${decisionProvider.defaultModel}`, ok: p.ok, ms: p.ms, probe: true, error: p.error });
    return json({
      spec,
      results: [{ spec: `${decisionProvider.name}/${parsedSpec?.model ?? decisionProvider.defaultModel}`, ok: p.ok, ms: p.ms, answered_by: p.model ?? null, ...(p.error ? { error: p.error } : {}), note: "decision provider: POST /v1/systemone, not a chat completion" }],
    });
  }
  const cands = resolveCandidates(ctx.config, spec, { useGlobalChain: false });
  if (!cands.length) return fail(new Error(`nothing resolves from '${spec}'`));
  for (const c of cands) {
    const started = Date.now();
    if (c.provider.unusableReason) {
      results.push({ spec: c.spec, ok: false, error: c.provider.unusableReason });
      continue;
    }
    try {
      // Reasoning models spend output tokens thinking BEFORE producing any visible text, and on these
      // providers the thinking is billed but not always reported in `completion_tokens`. A 16- or
      // 64-token cap can therefore be consumed entirely by thinking, so the probe reports an empty
      // reply and "tools may be unsupported" for a model whose tools work fine. Give the budget room
      // and, when it runs out anyway, say THAT rather than blaming the tools.
      const r = await chatCompletion(c.provider, { model: c.model, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 512, temperature: 0 }, { timeoutMs: 60_000 });
      const reply = (r.message.content ?? "").trim();
      // An empty reply must always say WHY. A reasoning model can put its whole output in a
      // non-standard `reasoning`/`reasoning_content` field (Ollama's OpenAI-compatible endpoint does),
      // which would otherwise read as a dead model; and `finish_reason: length` means the budget went
      // on thinking rather than answering. Both are the model's shape, not a broken endpoint (#13).
      const rawMessage = (r.raw as { choices?: { message?: { reasoning?: unknown; reasoning_content?: unknown } }[] } | undefined)?.choices?.[0]?.message;
      const reasoningChars = String(rawMessage?.reasoning ?? rawMessage?.reasoning_content ?? "").length;
      const whyEmpty = r.finishReason === "length"
        ? "the 512-token budget was spent before any visible reply — this model reasons first; raise maxTokens to reach the answer"
        : `finish_reason: ${r.finishReason}`;
      // A probe is a real, billable request, so it is priced like any other call. Logging it without a
      // cost is the same silent $0 as an unpriced model (#26): the report counted the call and charged
      // nothing for it, and a probe on an unpriced model was not flagged either.
      const replyCost = costUsd(ctx.config, c.provider.name, c.model, r.usage);
      let probeUsd = replyCost.usd;
      let probePriced = replyCost.priced;
      const row: Record<string, unknown> = {
        spec: c.spec,
        ok: true,
        ms: Date.now() - started,
        reply: reply.slice(0, 80),
        usage: r.usage,
        ...(reasoningChars ? { reasoning_chars: reasoningChars } : {}),
        ...(!reply ? { note: [reasoningChars ? `the model emitted ${reasoningChars} chars of reasoning and no visible reply` : "the model returned no visible reply", whyEmpty].join("; ") } : {}),
      };
      if (with_tools !== false && c.provider.supportsTools) {
        try {
          const t = await chatCompletion(c.provider, {
            model: c.model,
            messages: [{ role: "user", content: "Call the tool `ping` with argument {\"n\": 1}." }],
            tools: [{ type: "function", function: { name: "ping", description: "ping", parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] } } }],
            max_tokens: 2048,
            temperature: 0,
          }, { timeoutMs: 60_000 });
          const toolCost = costUsd(ctx.config, c.provider.name, c.model, t.usage);
          probeUsd += toolCost.usd;
          probePriced = probePriced && toolCost.priced;
          row.tool_calling = t.message.tool_calls?.length
            ? "ok"
            : t.finishReason === "length"
              ? "no call returned — the token budget ran out first (this model reasons before answering), which is NOT evidence that tools are unsupported"
              : "model answered without calling the tool (tools may be unsupported or ignored)";
        } catch (e) {
          row.tool_calling = `error: ${(e as Error).message.slice(0, 200)}`;
        }
      }
      row.cost_usd = Math.round(probeUsd * 1e6) / 1e6;
      row.priced = probePriced;
      results.push(row);
      rlog("route.attempt", { spec: c.spec, ok: true, ms: row.ms, probe: true, cost_usd: row.cost_usd, priced: row.priced, tool_calling: row.tool_calling });
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
  description: "Set or update a provider's key, base URL, default model, enabled flag, headers or extra body. Persists to the user config, or to the project file with scope:'project'. A loopback or private base URL needs no key.",
  inputSchema: {
    provider: z.string(),
    api_key: z.string().optional().describe("Literal key or \"${ENV_VAR}\""),
    base_url: z.string().optional(),
    requires_key: z.boolean().optional().describe("Whether the endpoint needs an API key. Defaults to false when the base URL is loopback or a private address (a local inference server rarely wants auth) and true otherwise; pass it explicitly to override. Setting a key or key_env counts as wanting auth, so the local default does not apply then."),
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
    // A local inference server almost never wants auth, so a call that SETS a loopback/private base
    // URL defaults `requiresKey` to false, instead of reporting a working server as unusable for want
    // of a key it would ignore (#13). Only the call that defines the endpoint does this: an unrelated
    // update (`default_model`, say) must not silently flip a provider's auth, and `requiresKey` is not
    // settable at project scope, so adding it there would break the documented project-scope path.
    // An explicit key, key_env or requires_key is a request for auth, and each wins over the default.
    if (a.requires_key === undefined && a.api_key === undefined && a.key_env === undefined && a.base_url && isLocalEndpoint(a.base_url)) patch.requiresKey = false;
    if (a.requires_key !== undefined) patch.requiresKey = a.requires_key;
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
  description: "Hand a self-contained task to another model and get its report plus the metadata of what actually ran. Give capabilities deliberately — a worker only needs what the task needs.",
  inputSchema: {
    task: z.string().describe("What to do. Be explicit about scope, constraints, and the expected output."),
    model: z.string().optional().describe("Alias, provider, provider/model, or comma-separated fallback list."),
    session_id: z.string().optional().describe("Continue the same worker's history under this id."),
    capabilities: CapabilitySchema.optional(),
    shape: ShapeSchema,
    min_tier: MinTierSchema,
    allow_downgrade: AllowDowngradeSchema,
    stall_abort_ms: StallAbortMsSchema,
    stall_warn_ms: StallWarnMsSchema,
    context: z.string().optional().describe("Background the worker needs: design notes, snippets, prior decisions."),
    role: z.string().optional().describe("Persona, e.g. 'security engineer'."),
    instructions: z.string().optional().describe("Extra standing rules for the worker."),
    temperature: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_iterations: z.number().int().positive().optional().describe("Tool-call rounds allowed."),
    include_project_instructions: z.boolean().optional().describe("Attach the workspace's CLAUDE.md / AGENTS.md to the worker. Default true."),
    skills: z.array(z.string()).optional().describe("Skill names whose SKILL.md the worker should follow."),
    mcp_servers: z.array(z.string()).optional().describe("Your other MCP servers whose tools the worker may call. Destructive tools are filtered out."),
    verify: z.string().optional().describe("Command the gateway runs itself after the worker finishes, e.g. 'npm test'. Its real exit code is appended to the report — the worker cannot fake it."),
    budget_usd: z.number().min(0).optional().describe("USD cap for this worker; the worker is stopped when exceeded."),
    routing: z.enum(["jev", "rules", "off"]).optional().describe("Routing for this call, used only when `model` is omitted."),
    async: z.boolean().optional().describe("Return a job id immediately; poll job_status."),
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
  description: "A worker does the task; a supervisor — ideally a different vendor — checks it against the acceptance criteria and either accepts or sends numbered feedback back, up to max_rounds. For work you do not want to babysit.",
  inputSchema: {
    task: z.string(),
    worker: z.string().optional().describe("Default: config.defaults.model"),
    supervisor: z.string().optional().describe("Default: config.defaults.supervisor"),
    max_rounds: z.number().int().min(1).max(10).optional().describe("Default 3"),
    capabilities: CapabilitySchema.optional(),
    shape: ShapeSchema,
    min_tier: MinTierSchema,
    allow_downgrade: AllowDowngradeSchema,
    stall_abort_ms: StallAbortMsSchema,
    stall_warn_ms: StallWarnMsSchema,
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


// ---- routing: policy rules first, then Jev, then the lead
server.registerTool("route", {
  title: "Route tasks to models",
  description:
    "Decide which model should run each task, without running anything. Deterministic policy rules run first (auth/secrets/migrations are forced onto the local lane and can never go remote), then the engine answers for the rest: 'jev' asks TypeSafe Jev once for the whole batch (a lane, a difficulty, a sensitivity flag and a repo-context flag per task, with probabilities and a confidence), 'rules' is a deterministic keyword engine that needs no key, 'off' returns no advice. A task below the confidence threshold, or one that needs your judgement, comes back as `escalated` with `model: null`. Returns per task: lane, model, confidence, probabilities, difficulty, flags, ms and why. run_plan calls this automatically for any task that omits `model`.",
  inputSchema: {
    tasks: z
      .array(
        z.object({
          id: z.string().describe("Task id (used to key the answers)"),
          title: z.string().optional(),
          task: z.string().describe("The instructions the worker would receive"),
          acceptance: z.string().optional(),
          verify: z.string().optional(),
          files: z.array(z.string()).optional().describe("Files it will touch — drives policy sensitivity"),
          tags: z.array(z.string()).optional().describe("Tags used to look up past outcomes in the ledger scorecards"),
        }),
      )
      .min(1)
      .max(40),
    goal: z.string().optional().describe("One line describing what the whole batch achieves"),
    engine: z.enum(["jev", "rules", "off"]).optional().describe("Session-level override for this call"),
    threshold: z.number().min(0).max(1).optional().describe("Confidence below which a task goes back to you (default routing.threshold)"),
  },
}, async (a) => {
  try {
    const r = await routePlanTasks(ctx.config, a.tasks, { goal: a.goal, engine: a.engine, threshold: a.threshold, scorecards: ctx.ledger.exists() ? ctx.ledger.scorecards() : [] });
    const { engine, source } = resolveEngine(ctx.config.routing.engine, a.engine, process.env.BREAK_FREE_ROUTING);
    return json({
      engine: r.engine,
      answered_by: r.answered_by,
      engine_source: r.engine_source,
      configured_engine: engine,
      config_source: source,
      threshold: r.threshold,
      ms: r.ms,
      cost_usd: r.cost_usd,
      priced: r.priced,
      batch: r.batch,
      state_tokens: r.state_tokens,
      state_truncated: r.state_truncated,
      jev_model: r.jev_model ?? null,
      degraded: r.degraded ?? null,
      usage: r.usage,
      escalated: r.escalated,
      policy_hits: r.policy_hits,
      lanes: LANES,
      lane_map: effectiveLaneMap(ctx.config),
      decisions: r.decisions.map((d) => ({ ...d, lane_meaning: LANE_SPEC[d.lane].what })),
      note: r.engine === "off" ? "routing is off: an omitted model means config.defaults.model" : "advice only — pass these models to run_plan, or omit `model` there and it routes identically",
    });
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
  min_tier: MinTierSchema,
  allow_downgrade: AllowDowngradeSchema,
  depends_on: z.array(z.string()).optional().describe("Task ids that must finish first; their reports are given to this worker as context"),
  context: z.string().optional(),
  role: z.string().optional(),
  skills: z.array(z.string()).optional(),
  mcp_servers: z.array(z.string()).optional(),
  verify: z.string().optional().describe("Allow-listed command the gateway runs after this task; failure blocks dependants"),
  acceptance: z.string().optional().describe("Acceptance criteria (given to the worker, the reviewer and the supervisor)"),
  files: z.array(z.string()).optional().describe("Files this task is expected to touch. Routing uses them for policy sensitivity (auth/secrets/migrations force the local lane) and to bucket repo-context need. Never enforced."),
  tags: z.array(z.string()).optional().describe("Free-form tags. Routing looks up what worked before for these tags in the ledger scorecards, e.g. ['migration','api']."),
  supervise: z.boolean().optional().describe("Run under a supervisor loop instead of a single pass"),
  review: z.boolean().optional().describe("Independent review of this task's result (overrides plan-level review)"),
  session_id: z.string().optional(),
  max_iterations: z.number().int().positive().optional(),
  stall_abort_ms: StallAbortMsSchema,
  stall_warn_ms: StallWarnMsSchema,
});

server.registerTool("run_plan", {
  title: "Run a plan: many workers in parallel with dependencies",
  description: "Run delegated tasks as a dependency graph: independent ones in parallel, each with its own model, capabilities, acceptance criteria and verify command. A task whose prerequisite failed is skipped, and a dependant is given its prerequisites' reports. Use async for long plans. Per task, shape:'ship' uses the requested capabilities (default); shape:'scout' is a read-only investigation whose capabilities are forced to ['read'] regardless of what was asked for.",
  inputSchema: {
    goal: z.string().optional().describe("One line describing what the whole plan achieves (recorded in the ledger)"),
    tasks: z.array(PlanTaskSchema).min(1).max(40),
    concurrency: z.number().int().min(1).max(16).optional(),
    review: z.boolean().optional().describe("Independently review every task result (default false); a 'reject' fails the task"),
    review_model: z.string().optional(),
    supervisor: z.string().optional().describe("Supervisor model for tasks with supervise:true"),
    track: z.boolean().optional().describe("Record in the project ledger (default: when .break-free exists)"),
    budget_usd: z.number().min(0).optional().describe("USD cap for the whole plan (default budget.perPlanUsd); remaining tasks are cancelled when exceeded"),
    routing: z.enum(["jev", "rules", "off"]).optional().describe("Session-level routing for this plan: 'jev' (TypeSafe Jev picks a lane per task), 'rules' (deterministic heuristics, no key), 'off' (an omitted model means config.defaults.model, exactly as before). Overrides BREAK_FREE_ROUTING and routing.engine in config. A task's own `model` is never routed."),
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
  // Reading the outcome is collecting it, so the wake event has done its job. Leaving it
  // pending is what piled up the stale list the guard kept re-reporting. A failure counts as
  // read too — it is placed before the early return so job.failed drains the same way.
  try { if (ctx.config.sessionDir) resolveJob(ctx.config.sessionDir, j.id); } catch { /* the queue is a nicety, never a reason to withhold a result */ }
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
    drainTo(ctx.config.sessionDir!, highest, ctx.workspace.root);
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
    // The first call of every session is where a notice is actually read.
    const upd = updateNotice(readCache(ctx.config.sessionDir ?? "")) ;
    return text((upd ? `## Updates\n${upd}\n\n` : "") + ctx.ledger.resumeBrief() + (absorbed ? `\n## Absorbed from worktrees just now\n${absorbed}\n` : "") + placement + (wt ? `\n## Worktrees (shared registry)\n${wt}\n\nUse worktree_list for details, worktree_register to claim this checkout, worktree_update / worktree_handoff to keep it current.\n` : ""));
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
/**
 * What routing saved in the window: the same token usage replayed at the `strong` alias's list
 * price, minus what the routing calls themselves cost. This is an estimate of what these exact
 * calls would have cost on strong — it is not a re-run, and it ignores cache and context reuse.
 *
 * A call whose model has no entry in the price table logs `cost_usd: 0`, so an `actual` built from
 * those calls is understated and the saving computed against it is inflated — a wrong number
 * pointing the direction this project wants it to point (#26). Unpriced calls are therefore named,
 * and the estimate is refused rather than reported with a number nobody can trust. A declared zero
 * is not a gap: price a local endpoint `{input:0,output:0}` and it counts as priced.
 */
function routingSavings(config: GatewayConfig, crewEvents: LogEvent[], since: string) {
  const strongCand = resolveCandidates(config, "strong", { useGlobalChain: false })[0];
  const routePlans = logger?.tail(50_000, (e) => e.kind === "route.plan" && String(e.ts) >= since) ?? [];
  const decisionEvents = logger?.tail(50_000, (e) => e.kind === "route.decision" && String(e.ts) >= since) ?? [];
  const routingUsd = decisionEvents.reduce((a, e) => a + Number(e.cost_usd ?? 0), 0);
  const latencies = routePlans.map((e) => Number(e.ms ?? 0)).filter((n) => n > 0).sort((a, b) => a - b);
  const tasks = routePlans.reduce((a, e) => a + Number(e.tasks ?? 0), 0);
  const escalations = routePlans.reduce((a, e) => a + Number(e.escalations ?? 0), 0);
  const routing = {
    plans: routePlans.length,
    tasks,
    escalations,
    escalation_rate: tasks ? Math.round((escalations / tasks) * 1000) / 1000 : null,
    ms_p50: latencies.length ? latencies[Math.floor((latencies.length - 1) * 0.5)] : null,
    ms_max: latencies.length ? latencies[latencies.length - 1] : null,
    usd: Math.round(routingUsd * 1e6) / 1e6,
  };
  // Both halves of the saving depend on prices: `actual` on the crew calls, `net_saved_usd` on the
  // routing calls. Either side unpriced makes the number unusable, so both are checked.
  const unpricedEvents = [...crewEvents, ...decisionEvents].filter((e) => e.priced === false);
  const unpricedSpecs = [...new Set(unpricedEvents.map((e) => String(e.spec ?? "?")))].sort();
  const unpriced = { unpriced_calls: unpricedEvents.length, unpriced_specs: unpricedSpecs };
  if (!strongCand) {
    return { measured: false, ...unpriced, reason: "the `strong` alias resolves to no usable candidate — add one to aliases.strong to enable the replay estimate", routing };
  }
  const price = priceFor(config, strongCand.provider.name, strongCand.model);
  if (!price.priced) {
    return { measured: false, ...unpriced, reason: `the \`strong\` alias resolves to ${strongCand.spec}, which has no entry in the price table, so there is no list price to replay at — add one with configure_budget {pricing:{"${strongCand.spec}":{input,output}}}`, routing };
  }
  if (unpriced.unpriced_calls) {
    return {
      measured: false,
      ...unpriced,
      reason: `${unpriced.unpriced_calls} call(s) in this window have no entry in the price table (${unpricedSpecs.join(", ")}), so they contribute $0 by table gap rather than by real saving; replaying that understated actual at strong's price would report an inflated saving. Add the rates with configure_budget {pricing:{"<provider>/<model>":{input,output}}} — {input:0,output:0} for a local endpoint that really is free — or stop routing to those models.`,
      routing,
    };
  }
  let actual = 0;
  let replay = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const e of crewEvents) {
    const u = e.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const pi = u?.prompt_tokens ?? 0;
    const po = u?.completion_tokens ?? 0;
    actual += Number(e.cost_usd ?? 0);
    tokensIn += pi;
    tokensOut += po;
    replay += (pi * price.input + po * price.output) / 1_000_000;
  }
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const saved = replay - actual;
  return {
    measured: true,
    unpriced_calls: 0,
    unpriced_specs: [],
    actual_crew_usd: r6(actual),
    all_strong_replay_usd: r6(replay),
    saved_usd: r6(saved),
    saved_pct: replay > 0 ? Math.round((saved / replay) * 1000) / 10 : null,
    routing_usd: routing.usd,
    net_saved_usd: r6(saved - routingUsd),
    crew_calls: crewEvents.length,
    tokens: { input: tokensIn, output: tokensOut },
    priced_on: strongCand.spec,
    routing,
    assumption: "the all-`strong` replay prices the SAME token usage at strong's list price; it estimates what these calls would have cost on strong, it is not a re-run, and it ignores prompt-cache and context-reuse differences",
  };
}

server.registerTool("cost_report", {
  title: "Spend report",
  description: "USD spent per day and per provider from the runtime log (list prices; edit `pricing` in config for exact rates), today's spend against budget.perDayUsd, unpriced calls, and the current caps.",
  inputSchema: { days: z.number().int().min(1).max(90).optional().describe("Window in days (default 7)") },
}, async ({ days }) => {
  if (!logger) return json({ enabled: false });
  const since = new Date(Date.now() - (days ?? 7) * 86_400_000).toISOString();
  const events = logger.tail(50_000, (e) => e.kind === "route.attempt" && !!e.ok && String(e.ts) >= since);
  const byDay: Record<string, number> = {}, byProvider: Record<string, { usd: number; calls: number; tokens_in: number; tokens_out: number; unpriced_calls: number; usd_is_lower_bound?: true; note?: string }> = {}, byModel: Record<string, number> = {};
  const unpricedBySpec: Record<string, number> = {};
  for (const e of events) {
    const c = Number(e.cost_usd ?? 0); const day = String(e.ts).slice(0, 10); const spec = String(e.spec ?? "?"); const prov = spec.split("/")[0];
    byDay[day] = (byDay[day] ?? 0) + c; byModel[spec] = (byModel[spec] ?? 0) + c;
    const p = (byProvider[prov] ??= { usd: 0, calls: 0, tokens_in: 0, tokens_out: 0, unpriced_calls: 0 });
    const u = e.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    p.usd += c; p.calls++; p.tokens_in += u?.prompt_tokens ?? 0; p.tokens_out += u?.completion_tokens ?? 0;
    // An unpriced call logs cost_usd 0, which is not the same claim as "free": the zero is a table
    // gap. Name the spec so the gap is attributable instead of quietly flattering the total (#26).
    if (e.priced === false) { p.unpriced_calls++; unpricedBySpec[spec] = (unpricedBySpec[spec] ?? 0) + 1; }
  }
  const unpriced = Object.values(unpricedBySpec).reduce((a, b) => a + b, 0);
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  const today = ctx.spentTodayUsd();
  const cap = ctx.config.budget.perDayUsd;
  // `spentTodayUsd` sums the same cost_usd fields, so today's figure shares the gap — and it is what
  // the day cap is compared against. Say so where the cap is reported, or the cap looks like it is
  // holding while an unpriced arm spends without moving it.
  const todayUnpriced = logger.tail(20_000, (e) => e.kind === "route.attempt" && !!e.ok && String(e.ts).startsWith(new Date().toISOString().slice(0, 10)) && e.priced === false).length;
  const providers = Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [
    k,
    { ...v, usd: r6(v.usd), ...(v.unpriced_calls ? { usd_is_lower_bound: true as const, note: `UNPRICED — ${v.unpriced_calls} of ${v.calls} call(s) have no entry in the price table, so this usd is a lower bound` } : {}) },
  ]));
  return json({
    window_days: days ?? 7,
    total_usd: r6(Object.values(byDay).reduce((a, b) => a + b, 0)),
    total_usd_is_lower_bound: unpriced > 0,
    by_day: Object.fromEntries(Object.entries(byDay).sort().map(([k, v]) => [k, r6(v)])),
    by_provider: providers,
    by_model: Object.fromEntries(Object.entries(byModel).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, r6(v)])),
    today_usd: today,
    budget: ctx.config.budget,
    today_vs_day_cap: cap
      ? `${Math.round((today / cap) * 100)}%${today / cap >= ctx.config.budget.warnAt ? " — WARNING" : ""}${todayUnpriced ? ` — lower bound: ${todayUnpriced} unpriced call(s) today are not counted in it` : ""}`
      : "no daily cap",
    unpriced_calls: unpriced,
    unpriced: {
      calls: unpriced,
      by_spec: unpricedBySpec,
      note: unpriced ? `UNPRICED — no entry in the price table for ${Object.keys(unpricedBySpec).sort().join(", ")}, so their spend is $0 by table gap, not by measurement; every total above that includes them is a lower bound` : null,
    },
    routing_savings: routingSavings(ctx.config, events, since),
    pricing_note: "list prices from DEFAULT_PRICING merged with config.pricing; set pricing[\"provider/model\"] = {input, output} USD per 1M tokens to correct them. A model with no entry contributes $0 and is listed under `unpriced` — that is a gap in the table, not a saving.",
  });
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
    // Prices are set here, so this is where a gap should surface: name the alias candidates that
    // have no entry, since those are the calls that would report $0 and make a cost report a lower
    // bound (#26) rather than a measurement.
    const unpricedCandidates = [...new Set(Object.values(ctx.config.aliases).flatMap((v) => (Array.isArray(v) ? v : v.candidates)))]
      // A crew alias names another alias ("ensign" -> "fast"); the chain it points at is checked
      // through that alias's own entry, so reporting the name again would just be noise.
      .filter((spec) => !ctx.config.aliases[spec])
      .filter((spec) => {
        const c = resolveCandidates(ctx.config, spec, { useGlobalChain: false })[0];
        return !!c && !priceFor(ctx.config, c.provider.name, c.model).priced;
      });
    return json({ saved_to: target, budget: ctx.config.budget, pricing_overrides: ctx.config.pricing, defaults_known: Object.keys(DEFAULT_PRICING).length, unpriced_candidates: unpricedCandidates });
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
/** Everything break-free charges a session, so the cost can be argued about instead of guessed. */
function contextLines(): ContextLine[] {
  const lines: ContextLine[] = [];
  const toolTokens = toolSchemaCost.reduce((n, t) => n + t.tokens, 0);
  const heaviest = toolSchemaCost.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 3).map((t) => `${t.name} ${t.tokens}`).join(", ");
  lines.push({ surface: "mcp tool schemas", bytes: toolTokens * 3, tokens: toolTokens, always: true, detail: `${toolSchemaCost.length} tools; heaviest: ${heaviest}` });
  lines.push(ctxLine("server instructions", SERVER_INSTRUCTIONS.join(" "), true));
  try {
    const brief = ctx.ledger.exists() ? ctx.ledger.resumeBrief() : "";
    lines.push(ctxLine("ledger resume brief", brief, true, "injected into the lead and every worker"));
  } catch { /* a ledger that will not render is a separate problem, not a budget one */ }
  return lines;
}

server.registerTool("context_report", {
  title: "What break-free costs this session before any work happens",
  description: "Account every surface break-free adds to the context — tool schemas, server instructions, the ledger brief — against context.budgetTokens. An unmeasured cost only ever grows, and the tool surface is re-sent every turn, so it is paid per turn and not per call.",
  inputSchema: {},
}, async () => {
  const r = ctxReport(contextLines(), ctx.config.context.budgetTokens);
  return text(`${renderReport(r)}\n\n${JSON.stringify(r, null, 2)}`);
});

server.registerTool("firstmate_status", {
  title: "Is the firstmate distro provisioned, and what is it pinned to",
  description: "Report the firstmate distro break-free drives for crew, worktrees and merge authority: where it lives, the commit the agent is actually obeying, the pinned commit, and whether the two have drifted apart. Drift means instructions nobody approved are in force.",
  inputSchema: {},
}, async () => json({ ...firstmateStatus(ctx.config.firstmate), repo: FIRSTMATE_REPO, label: FIRSTMATE_LABEL }));

server.registerTool("firstmate_update_plan", {
  title: "What moving the firstmate pin would change",
  description: "Show what a revision would change in the surfaces that steer an agent — AGENTS.md, bin/ and skills/ — WITHOUT changing anything. An upstream commit becomes the instructions your agent obeys, so it is reviewed before it is applied, never after. Returns the command break-free would run, which is upstream's own fast-forward-only script, so you can run it yourself instead.",
  inputSchema: {
    target: z.string().optional().describe("Revision to plan towards. Default: origin's current default branch."),
  },
}, async (a) => {
  try {
    const st = firstmateStatus(ctx.config.firstmate);
    if (!st.installed) return json({ installed: false, reason: st.reason, repo: FIRSTMATE_REPO });
    const plan = planUpdate(st.root, a.target ?? "origin/HEAD");
    return json({ ...plan, apply: updateCommand(st.root), note: plan.instructionChanges.length ? "These files steer the agent. Read them before applying." : "No change to instruction surfaces." });
  } catch (e) {
    return fail(e);
  }
});

server.registerTool("obsidian_link", {
  title: "Surface this project's ledger in an Obsidian vault",
  description: "Link (or index) the project ledger into the Obsidian vault, so notes, tasks and the journal open in the vault with their wikilinks intact. The repository stays the source of truth: `link` symlinks the ledger rather than copying it. Does nothing when no vault is detected. Anything already at the target that is not our own link is left untouched.",
  inputSchema: {
    vault: z.string().optional().describe("Vault path. Default: config.knowledge.obsidian.vault, then $OBSIDIAN_VAULT, then Obsidian's own registry."),
    mode: z.enum(["link", "index", "off"]).optional().describe("link = symlink the ledger in (default); index = write one note pointing at it; off = do nothing."),
    project: z.string().optional().describe("Name to use inside the vault. Default: the workspace directory name."),
  },
}, async (a) => {
  try {
    const cfg = {
      obsidian: {
        vault: a.vault ?? ctx.config.knowledge.obsidian.vault,
        mode: a.mode ?? ctx.config.knowledge.obsidian.mode,
        folder: ctx.config.knowledge.obsidian.folder,
      },
    };
    const vault = resolveVault(cfg);
    if (!vault) return json({ action: "skipped", reason: "no Obsidian vault detected — set knowledge.obsidian.vault or $OBSIDIAN_VAULT" });
    const project = a.project ?? path.basename(ctx.workspace.root);
    return json(linkLedger(vault.path, project, path.join(ctx.workspace.root, LEDGER_DIR), cfg));
  } catch (e) {
    return fail(e);
  }
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
/**
 * Discovery and dispatch for everything not advertised permanently.
 *
 * Registered last, so every other operation is already in the map. Under the compact profile
 * these two are the only way to reach the rest — which is why they are resident, and why
 * nothing is ever truly hidden: an agent can always ask what exists and then call it.
 */
server.registerTool("bf_discover", {
  title: "List the operations that are not advertised permanently",
  description: "break-free keeps execution and its lifecycle typed and resident, and moves everything else — worktrees, the ledger and its tasks and notes, provider and alias configuration, sessions, harnesses, cost, routing, the steward, firstmate — behind this. Call it with no argument for the list, or with `operation` for that one's full schema, then call it through bf_invoke. Nothing is unreachable; it is simply not spent on every turn.",
  inputSchema: {
    operation: z.string().optional().describe("Return this operation's full input schema instead of the list."),
    match: z.string().optional().describe("Substring filter over names and titles, e.g. 'worktree' or 'note'."),
  },
}, async (a) => {
  const hidden = [...operations.entries()].filter(([n]) => !RESIDENT_TOOLS.has(n));
  if (a.operation) {
    const op = operations.get(a.operation);
    if (!op) return fail(new Error(`no operation "${a.operation}". Call bf_discover with no argument for the list.`));
    return json({ operation: a.operation, title: op.def.title, description: op.def.description, input_schema: zodToJsonSchema(z.object((op.def.inputSchema ?? {}) as z.ZodRawShape)) });
  }
  const needle = a.match?.toLowerCase();
  const rows = hidden
    .filter(([n, op]) => !needle || n.toLowerCase().includes(needle) || String(op.def.title ?? "").toLowerCase().includes(needle))
    .map(([n, op]) => ({ operation: n, title: op.def.title }));
  return json({ operations: rows, count: rows.length, call_with: "bf_invoke {operation, arguments}", schema_with: "bf_discover {operation}" });
});

server.registerTool("bf_invoke", {
  title: "Call an operation returned by bf_discover",
  description: "Run one of the operations bf_discover lists. Arguments are validated against that operation's own schema by the same code path a permanently advertised tool uses, so an invalid call fails the same way rather than reaching the handler.",
  inputSchema: {
    operation: z.string().describe("Name from bf_discover."),
    arguments: z.record(z.unknown()).optional().describe("That operation's arguments. Get its schema from bf_discover {operation}."),
  },
}, async (a) => {
  const op = operations.get(a.operation);
  if (!op) return fail(new Error(`no operation "${a.operation}". Call bf_discover for the list.`));
  if (RESIDENT_TOOLS.has(a.operation) && a.operation.startsWith("bf_")) return fail(new Error(`${a.operation} cannot invoke itself`));
  try {
    // Same validation the tool would have had. Dispatching around it would make the compact
    // profile a hole rather than a saving.
    const parsed = z.object((op.def.inputSchema ?? {}) as z.ZodRawShape).parse(a.arguments ?? {});
    return (await op.handler(parsed as Record<string, unknown>)) as ReturnType<typeof json>;
  } catch (e) {
    return fail(e);
  }
});

// ------------------------------------------------------------ main
async function main() {
  if (argv.includes("--selftest")) {
    // Print a config/provider summary and exit non-zero if nothing is usable.
    const rows = listProviderNames(ctx.config).map(providerReport);
    const usable = rows.filter((r) => r.usable).map((r) => r.provider);
    // An open circuit looks exactly like a healthy provider in the rows above — key
    // present, model configured — so --doctor has to say it out loud.
    const openCircuits = getBreaker(ctx.config).list();
    // "Which knowledge layer am I actually using" is otherwise unanswerable. An absent vault
    // is reported as absent, not as a problem: Obsidian is optional and most machines lack it.
    const vault = resolveVault(ctx.config.knowledge);
    const fm = firstmateStatus(ctx.config.firstmate);
    const knowledge = {
      graph: { configured: ctx.config.knowledge.graph.provider, ...(await graphResolution()) },
      firstmate: { installed: fm.installed, root: fm.root, head: fm.head?.slice(0, 12) ?? null, pin: fm.pin ?? null, drifted: fm.drifted, ...(fm.installed ? { update: updateAvailable(fm.root) } : {}), ...(fm.reason ? { reason: fm.reason } : {}) },
      obsidian: vault
        ? { vault: vault.path, source: vault.source, mode: ctx.config.knowledge.obsidian.mode }
        : { vault: null, detected: false },
    };
    console.log(JSON.stringify({ config_files: loaded.sources, workspace: ctx.workspace.root, usable_providers: usable, open_circuits: openCircuits, knowledge, github_cli: await ghAvailable(), providers: rows }, null, 2));
    process.exit(usable.length ? 0 : 2);
  }
  if (argv.includes("--logs")) {
    // Machine-readable health summary for setup --doctor
    const n = Number(flag("--logs")) || 500;
    const events = logger ? logger.tail(n) : [];
    console.log(JSON.stringify({ file: logger?.file ?? null, enabled: !!logger, ...analyze(events) }, null, 2));
    process.exit(0);
  }
  /**
   * The Stop-hook payload on stdin, or nothing.
   *
   * Reading stdin must not become a new way to hang, so every unhappy path — no payload, a
   * closed pipe, malformed JSON, a writer that never finishes — resolves to an empty object
   * under a short deadline and the guard simply proceeds as it did before.
   */
  const hookPayload = async (timeoutMs = 250): Promise<Record<string, unknown>> => {
    if (process.stdin.isTTY) return {};
    return await new Promise((resolve) => {
      let data = "";
      let settled = false;
      const done = (v: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        process.stdin.pause();
        resolve(v);
      };
      const timer = setTimeout(() => done({}), timeoutMs);
      timer.unref?.();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { data += c; });
      process.stdin.on("end", () => {
        try {
          const parsed = JSON.parse(data) as unknown;
          done(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {});
        } catch { done({}); }
      });
      process.stdin.on("error", () => done({}));
    });
  };

  if (argv.includes("--fleet-check")) {
    if (argv.includes("--hook")) {
      // Claude Code Stop-hook contract: block -> one line of JSON on stdout;
      // allow -> no output at all. Nothing may be written to stderr.
      const stderrWrite = process.stderr.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try {
        // A guard that has already spoken must not be able to trap the session by repeating
        // itself. The harness sets stop_hook_active once it has blocked on our account, and a
        // hook that ignores it blocks forever — which is how this one made a session
        // unendable and had to be overridden. #82 made the instruction followable; this makes
        // the guard incapable of wedging a turn even when it is not, whatever the reason.
        const payload = await hookPayload();
        const res = payload.stop_hook_active === true ? undefined : await fleetCheck();
        if (res?.blocking) {
          const parts: string[] = [];
          const ciFailed = res.pending.filter((e) => e.kind === "ci.failed");
          const ciPending = res.pending.filter((e) => e.kind === "ci.pending");
          for (const f of ciFailed) parts.push(`CI FAILED on ${(f.ci?.sha ?? f.id).slice(0, 7)}${f.ci?.job ? ` (${f.ci.job})` : ""}${f.ci?.url ? ` - ${f.ci.url}` : ""}`);
          for (const p of ciPending) parts.push(`CI pending on ${(p.ci?.sha ?? p.id).slice(0, 7)}`);
          if (res.running.jobs > 0) parts.push(`${res.running.jobs} job(s) running`);
          // "1 event(s) pending" leaves the reader to grep a log to find out whether they
          // should care. Name what it is, so the answer is in the message.
          const rest = res.pending.filter((e) => e.kind !== "ci.failed" && e.kind !== "ci.pending");
          if (rest.length > 0) parts.push(rest.slice(0, 3).map((e) => `${e.kind} ${e.id}`).join(", ") + (rest.length > 3 ? ` and ${rest.length - 3} more` : ""));
          // Name the exact call. "call fleet_status" is not enough: without drain:true the events
          // stay pending and the next turn blocks on the identical list, which is a loop the
          // agent cannot escape by following the instruction it was given.
          const reason = `${parts.join(", ")} - ${ciFailed.length ? "fix it before ending the turn" : "call fleet_status with drain:true to collect them"}`;
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
  // Only a long-lived server checks for updates, and only once it is answering. This used to
  // run at the very top of main(), so every Stop hook - a fresh process at every turn end - and
  // every one-shot CLI mode paid for it too, and the fetch inside was synchronous despite the
  // "fire and forget" comment above it. A network that is down is not a reason for a session
  // to wait, so nothing here is awaited.
  setImmediate(() => void refreshUpdates().catch(() => undefined));
}

main().catch((e) => {
  log(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});

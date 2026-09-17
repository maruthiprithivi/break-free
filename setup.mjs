#!/usr/bin/env node
/**
 * model-gateway interactive installer / doctor / uninstaller.
 *
 *   node setup.mjs                      interactive install (asks what it needs)
 *   node setup.mjs --doctor             diagnose only, change nothing (includes runtime-log analysis; --last N events)
 *   node setup.mjs --uninstall          remove registrations, skills, commands (keeps config/keys unless --purge)
 *   node setup.mjs --yes                hands-free: no prompts, every question takes its default — existing config
 *                                       (keys, models, aliases, chains, disabled providers) is kept and re-verified
 *   node setup.mjs --update             pull the latest source (git pull --ff-only) and re-run the installer hands-free,
 *                                       reusing the scope/agents chosen last time (saved in last-install.json)
 *   node setup.mjs --answers file.json  non-interactive with explicit answers (see setup/answers.example.json)
 *   node setup.mjs --project DIR        also install project-scoped files into DIR
 *   node setup.mjs --skip-tests         don't run the e2e suite after building
 *
 * Every step prints PASS / WARN / FAIL with a fix hint; a JSON report and a log
 * are written to ~/.config/model-gateway/. Exit code 1 if anything FAILed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Report, Prompter, color, which, run, versionGte, home, expandHome, readJsonSafe, writeSecret, backup, copyDir, sameContent, deepMerge, upsertTomlTable, removeTomlTable, tomlStr } from "./setup/lib.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const GW = path.join(HERE, "model-gateway");
const ENTRY = path.join(GW, "dist", "index.js");
const AGENT_CFG = path.join(HERE, "agent-config");
const CFG_DIR = path.join(home(), ".config", "model-gateway");
const CFG_FILE = process.env.MODEL_GATEWAY_CONFIG ? expandHome(process.env.MODEL_GATEWAY_CONFIG) : path.join(CFG_DIR, "config.json");
const LOG_FILE = path.join(CFG_DIR, "setup.log");
const REPORT_FILE = path.join(CFG_DIR, "setup-report.json");
const INSTALL_STATE = path.join(CFG_DIR, "last-install.json");
const CLAUDE_SERVER = "break-free-gateway";
const LEGACY_CLAUDE_SERVER = "model-gateway";
const CODEX_SERVER = "break_free_gateway";
const LEGACY_CODEX_SERVER = "model_gateway";
const GW_COMMANDS = ["break-free-delegate.md", "break-free-plan.md", "break-free-resume.md", "break-free-model.md", "break-free-worktree.md", "break-free-panel.md", "break-free-review.md", "break-free-supervise.md", "break-free-update.md"];
const LEGACY_COMMANDS = ["delegate.md", "panel.md", "review.md", "supervise.md", "issue.md", "ci.md", "wrap-up.md"];
const GF_COMMANDS = ["break-free-issue.md", "break-free-ci.md", "break-free-wrap-up.md"];
const GW_SKILL = "break-free-model-gateway";
const GF_SKILL = "break-free-github-flow";
const LEGACY_SKILLS = ["model-gateway", "github-flow"];
const KEY_ENVS = ["DEEPSEEK_API_KEY", "MOONSHOT_API_KEY", "MINIMAX_API_KEY", "ZAI_API_KEY", "OPENROUTER_API_KEY", "OPENCODE_API_KEY", "OLLAMA_API_KEY", "GH_TOKEN"];

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const MODE = has("--uninstall") ? "uninstall" : has("--doctor") ? "doctor" : has("--update") ? "update" : "install";
const answersFile = val("--answers");
const answers = answersFile ? JSON.parse(fs.readFileSync(answersFile, "utf8")) : {};
const projectDir = val("--project") ? path.resolve(val("--project")) : answers.project_dir ? path.resolve(answers.project_dir) : undefined;
if (has("--help") || has("-h")) { console.log(fs.readFileSync(new URL(import.meta.url)).toString().split("*/")[0].replace(/^\/\*\*?\s?/, "").replace(/^ \* ?/gm, "")); process.exit(0); }

const report = new Report(LOG_FILE);
const prompter = new Prompter({ answers, interactive: !answersFile && !has("--yes") && !has("--update") });
const targets = { claude: false, codex: false };
const scope = { claude: "none", codex: "none", project: projectDir }; // user | project | both | none
const state = { providersConfigured: [], providersVerified: [], node: null, ghAuthed: false, githubFlow: "none" };

process.on("unhandledRejection", (e) => { report.fail("unexpected error", String(e?.stack ?? e)); finish(); });

// ================================================================== phases
async function preflight() {
  report.section("Preflight");
  state.node = process.versions.node;
  if (versionGte(state.node, "20.0.0")) report.pass(`Node ${state.node}`);
  else report.fail(`Node ${state.node} is too old`, "need >= 20", "install Node 20+ (https://nodejs.org) and re-run");
  const npm = which("npm");
  npm ? report.pass("npm found", npm) : report.fail("npm not found", "", "install Node.js which bundles npm");
  const git = await run("git", ["--version"]);
  git.ok ? report.pass("git", git.stdout.trim()) : report.fail("git not found", "", "install git; the workers' read/git tools need it");

  const claude = which("claude");
  targets.claude = !!claude;
  if (claude) { const v = await run("claude", ["--version"]); report.pass("Claude Code CLI", v.stdout.trim() || claude); }
  else report.warn("Claude Code CLI not found", "will skip Claude Code registration", "npm install -g @anthropic-ai/claude-code");
  const codex = which("codex");
  targets.codex = !!codex;
  if (codex) { const v = await run("codex", ["--version"]); report.pass("Codex CLI", v.stdout.trim() || codex); }
  else report.warn("Codex CLI not found", "will skip Codex registration", "npm install -g @openai/codex");
  if (!claude && !codex) report.fail("neither claude nor codex CLI is installed", "", "install at least one, then re-run");

  const gh = which("gh");
  if (gh) {
    const st = await run("gh", ["auth", "status"], { timeoutMs: 15_000 });
    state.ghAuthed = st.ok;
    st.ok ? report.pass("gh CLI authenticated", (st.stdout + st.stderr).split("\n").find((l) => /Logged in/.test(l))?.trim() ?? "ok")
          : report.warn("gh CLI installed but not authenticated", (st.stderr || st.stdout).trim().split("\n")[0], "run `gh auth login` or export GH_TOKEN — needed only for the github capability");
  } else report.warn("gh CLI not found", "github capability (issues/PRs/Actions) will be unavailable", "brew install gh  |  https://cli.github.com");

  const ollama = await probeUrl("http://localhost:11434/api/tags", 2000);
  if (ollama.ok) {
    const names = (ollama.json?.models ?? []).map((m) => m.name);
    report.pass("Ollama running locally", names.length ? `${names.length} model(s): ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}` : "no models pulled yet");
    state.ollamaModels = names;
  } else report.warn("Ollama not reachable on :11434", "local alias will fall through to cloud providers", "install from https://ollama.com and `ollama pull qwen3-coder:30b` (optional)");

  const net = await probeUrl("https://registry.npmjs.org/-/ping", 8000);
  net.ok ? report.pass("network: npm registry reachable") : report.warn("npm registry not reachable", net.error, "check proxy/VPN; `npm install` will fail without it");
}

async function probeUrl(url, timeoutMs, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { ok: res.ok, status: res.status, text, json };
  } catch (e) {
    return { ok: false, error: e.cause?.code ?? e.message };
  } finally { clearTimeout(t); }
}

async function build() {
  report.section("Build model-gateway");
  if (!fs.existsSync(path.join(GW, "package.json"))) { report.fail("model-gateway/package.json missing", GW, "run this script from the repository root"); return false; }
  report.info("npm install (first run can take a minute)…");
  prompter.pause();
  const inst = await run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: GW, timeoutMs: 300_000 });
  if (!inst.ok) { prompter.resume(); report.fail("npm install failed", lastLines(inst.stderr), "check network/proxy; see setup.log"); report.log(inst.stderr); return false; }
  report.pass("npm install");
  const b = await run("npm", ["run", "build", "--silent"], { cwd: GW, timeoutMs: 300_000 });
  if (!b.ok) { prompter.resume(); report.fail("TypeScript build failed", lastLines(b.stderr || b.stdout), "see setup.log for compiler errors"); report.log(b.stderr + b.stdout); return false; }
  fs.existsSync(ENTRY) ? report.pass("built", path.relative(HERE, ENTRY)) : report.fail("dist/index.js missing after build");
  if (!has("--skip-tests") && !answers.skip_tests) {
    report.info("running the gateway's own test-suite (mock provider, ~5-15 s)…");
    // Explicit file list: a bare `node --test` would also execute test/mock-provider.mjs as a script and hang forever.
    const files = fs.readdirSync(path.join(GW, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join("test", f));
    const t = await run(process.execPath, ["--test", "--test-reporter=tap", "--test-timeout=60000", ...files], { cwd: GW, timeoutMs: 180_000 });
    const m = (t.stdout + t.stderr).match(/# pass (\d+)[\s\S]*# fail (\d+)/);
    if (t.ok && m) report.pass("self-tests", `${m[1]} passed`);
    else if (t.error?.killed) { report.warn("self-tests timed out after 180 s", "", "run `cd model-gateway && npm test` manually to see where it hangs; not fatal"); report.log(t.stdout + t.stderr); }
    else {
      const out = t.stdout + t.stderr;
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((x) => x[1]);
      const firstErr = out.match(/error: \|-\n([\s\S]{0,300}?)\n\s+code:/)?.[1]?.trim().replace(/\n\s*/g, " | ");
      report.warn("self-tests did not pass cleanly", failed.length ? `${failed.length} failed: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "…" : ""}${firstErr ? ` — ${firstErr}` : ""}` : lastLines(t.stderr || t.stdout), "not fatal for installation; full output in setup.log — run `cd model-gateway && npm test` to reproduce");
      report.log(out);
    }
  } else report.skip("self-tests", "--skip-tests");
  prompter.resume();
  return true;
}

function lastLines(s, n = 3) { return String(s ?? "").trim().split("\n").slice(-n).join(" | ").slice(0, 400); }

// ---- providers ------------------------------------------------------------
async function loadGatewayModules() {
  const providers = await import(pathToFileURL(path.join(GW, "dist", "providers.js")).href);
  const client = await import(pathToFileURL(path.join(GW, "dist", "client.js")).href);
  const config = await import(pathToFileURL(path.join(GW, "dist", "config.js")).href);
  return { ...providers, ...client, ...config };
}

async function configureProviders() {
  report.section("Providers & API keys");
  const gw = await loadGatewayModules();
  const existing = readJsonSafe(CFG_FILE);
  if (existing?.__error) { report.fail(`existing config is not valid JSON`, existing.__error, `fix or delete ${CFG_FILE}`); return; }
  const cfg = existing ?? {};
  cfg.providers ??= {};
  report.info(existing ? `merging into existing ${CFG_FILE}` : `creating ${CFG_FILE}`);
  console.log(color.dim("  For each provider: paste the key, or type  skip  /  env  (use the env var)  /  keep  (saved key). Keys are verified live and never echoed."));

  const storage = await prompter.choose("key_storage", "Where should API keys live?", [
    { key: "config", label: `In ${CFG_FILE} (chmod 600). Works for Claude Code and Codex without any env forwarding.` },
    { key: "env", label: "Only as environment variables; config stores ${VAR} references. You must export them in the shell that launches Claude Code/Codex." },
  ], "config");

  state.modelLists = {}; // provider -> live model ids (for validation and suggestions)
  const selected = await chooseProviders(cfg, gw);
  const runOne = async (name) => {
    const cat = gw.PROVIDER_CATALOG[name];
    const current = cfg.providers[name] ?? {};
    console.log(`\n  ${color.bold(cat.label)} ${color.dim(`(${name})  ${cat.requiresKey ? `keys: ${cat.docs}` : cat.docs}`)}`);
    if (!cat.requiresKey) await configureLocalProvider(name, cat, current, cfg, gw);
    else await configureKeyedProvider(name, cat, current, cfg, gw, storage);
  };
  for (const name of selected) await runOne(name);
  await reviewProviders(cfg, gw, runOne);

  // ---- policy & fallback
  console.log("");
  const protDef = (cfg.github?.protectedBranches ?? ["main", "master", "production", "release"]).join(",");
  const prot = await prompter.ask("protected_branches", "Branches workers may never push to (comma-separated; 'none' to allow all)", { def: protDef });
  const protList = /^(none|-|no|off)$/i.test(String(prot).trim()) ? [] : String(prot).split(",").map((s) => s.trim()).filter(Boolean);
  cfg.github = { ...(cfg.github ?? {}), protectedBranches: protList };
  if (!protList.length) report.warn("no protected branches", "workers may push straight to main", "reconsider unless this is a scratch repo; configure_fallback protected_branches=[…] changes it later");
  cfg.github.allowMerge = await prompter.confirm("allow_merge", "Allow workers to merge PRs (only when a task explicitly says so)?", cfg.github.allowMerge ?? true);
  cfg.github.allowPush = await prompter.confirm("allow_push", "Allow workers to push branches?", cfg.github.allowPush ?? true);

  await configureChains(cfg, gw);

  const b = backup(CFG_FILE);
  writeSecret(CFG_FILE, JSON.stringify(cfg, null, 2) + "\n");
  report.pass(`wrote ${CFG_FILE}`, b ? `backup: ${path.basename(b)}` : "new file, mode 0600");
  const mode = fs.statSync(CFG_FILE).mode & 0o777;
  if (process.platform !== "win32" && mode !== 0o600) report.warn("config file permissions", mode.toString(8), `chmod 600 ${CFG_FILE}`);
  const usable = Object.entries(cfg.providers).filter(([n, p]) => usableProv(p, gw.PROVIDER_CATALOG[n])).map(([n]) => n);
  if (!usable.length) report.fail("no provider configured", "the gateway has nothing to route to", "re-run and add at least one key, or enable Ollama");
  else report.pass("providers configured", usable.join(", "));
}

function suggestChain(cfg) {
  const c = [];
  for (const [n, p] of Object.entries(cfg.providers)) {
    if (!(p.apiKey || p.enabled)) continue;
    if (n === "openrouter") c.push("openrouter/deepseek/deepseek-v4-flash");
    else if (n === "deepseek") c.push(`deepseek/${p.defaultModel ?? "deepseek-v4-flash"}`);
    else if (n === "ollama" && p.defaultModel) c.push(`ollama/${p.defaultModel}`);
  }
  return c.slice(0, 3);
}

/** Ask for a comma-separated list of provider/model specs and validate every entry; offer corrections for bare model names. */
async function askSpecList(id, question, def, cfg, gw) {
  const providers = new Set([...Object.keys(gw.PROVIDER_CATALOG), ...Object.keys(cfg.providers)]);
  for (let attempt = 0; attempt < 4; attempt++) {
    const raw = String(await prompter.ask(id, question, { def }) ?? "");
    const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const fixed = [];
    let bad = false;
    for (const p of parts) {
      const prov = p.split("/")[0];
      if (providers.has(prov) || cfg.aliases?.[p]) { fixed.push(p); continue; }
      // bare model name? find which provider lists it
      const owners = Object.entries(state.modelLists ?? {}).filter(([, list]) => list.includes(p)).map(([n]) => n);
      const guess = owners[0] ?? (/deepseek/i.test(p) ? "deepseek" : /kimi/i.test(p) ? "kimi" : /glm/i.test(p) ? "zai" : /minimax/i.test(p) ? "minimax" : undefined);
      if (guess) {
        const ok = await prompter.confirm(`${id}_fix_${p}`, `'${p}' has no provider prefix — did you mean '${guess}/${p}'?`, true);
        if (ok) { fixed.push(`${guess}/${p}`); continue; }
      }
      console.log(`    ${color.red(`'${p}' is not a known provider/model spec`)} ${color.dim(`(providers: ${[...providers].join(", ")})`)}`);
      bad = true;
    }
    if (!bad) {
      const unusable = fixed.filter((p) => { const prov = p.split("/")[0]; return providers.has(prov) && !usableProv(cfg.providers[prov], gw.PROVIDER_CATALOG[prov]); });
      if (unusable.length) report.warn("fallback chain includes providers without a key", unusable.join(", "), "they will be skipped at runtime until a key is added");
      return fixed;
    }
    if (id in prompter.answers) return fixed; // non-interactive: keep what parsed
    def = fixed.join(",");
  }
  return [];
}

/** A provider counts as usable only when it is not switched off AND has a key (or is a keyless local server that is enabled). */
const usableProv = (p, cat) => !!p && p.enabled !== false && (!!p.apiKey || (!cat?.requiresKey && p.enabled === true));

const PROVIDER_ORDER = ["ollama", "vllm", "deepseek", "kimi", "zai", "minimax", "openrouter", "opencode", "ollama-cloud"];
const PROVIDER_BLURB = {
  ollama: "local or LAN Ollama server — no key, models you pulled yourself",
  vllm: "vLLM / LM Studio / llama.cpp / any OpenAI-compatible server on your network",
  "ollama-cloud": "ollama.com hosted models — needs a key from ollama.com/settings/keys",
};

function providerStatus(name, pc, gw) {
  const cat = gw.PROVIDER_CATALOG[name];
  const bits = [];
  if (pc?.enabled === false) bits.push(color.dim("disabled"));
  if (!cat.requiresKey) { bits.push(pc?.baseUrl ?? cat.baseUrl); if (pc?.defaultModel) bits.push(`model ${pc.defaultModel}`); }
  else {
    if (pc?.apiKey && !/^\$/.test(pc.apiKey)) bits.push(`saved key ${redact(pc.apiKey)}`);
    else if (pc?.apiKey) bits.push(`key via ${pc.apiKey}`);
    else if (process.env[cat.keyEnv]) bits.push(`${cat.keyEnv} in shell`);
    else bits.push(color.dim("no key"));
    if (pc?.defaultModel) bits.push(`model ${pc.defaultModel}`);
  }
  return bits.join(", ");
}

/** Let the user decide WHICH providers to walk through, with each one's current state visible. */
async function chooseProviders(cfg, gw) {
  const configured = PROVIDER_ORDER.filter((n) => usableProv(cfg.providers[n], gw.PROVIDER_CATALOG[n]));
  const envReady = PROVIDER_ORDER.filter((n) => gw.PROVIDER_CATALOG[n].requiresKey && process.env[gw.PROVIDER_CATALOG[n].keyEnv]);
  const localUp = state.ollamaModels?.length ? ["ollama"] : [];
  const def = [...new Set([...configured, ...envReady, ...localUp])];
  let picked;
  if ("providers" in prompter.answers) picked = prompter.answers.providers === "all" ? PROVIDER_ORDER : prompter.answers.providers;
  else if (!prompter.interactive) picked = PROVIDER_ORDER.filter((n) => cfg.providers[n]?.enabled !== false); // hands-free: walk everything except what you switched off
  else {
    console.log(`\n  ${color.bold("Which providers do you want to set up or change?")} ${color.dim("(others are left exactly as they are)")}`);
    PROVIDER_ORDER.forEach((n, i) => {
      const cat = gw.PROVIDER_CATALOG[n];
      console.log(`    ${String(i + 1).padStart(2)}) ${cat.label.padEnd(36)} ${color.dim(providerStatus(n, cfg.providers[n], gw))}${PROVIDER_BLURB[n] ? `\n        ${color.dim(PROVIDER_BLURB[n])}` : ""}`);
    });
    for (;;) {
      const raw = String(await prompter.ask("providers", `numbers (e.g. 1,3,4), 'all', or Enter for the ${def.length ? "marked defaults" : "none"}`, { def: def.map((n) => PROVIDER_ORDER.indexOf(n) + 1).join(",") })).trim();
      if (/^all$/i.test(raw)) { picked = PROVIDER_ORDER; break; }
      if (/^(none|-)$/i.test(raw) || raw === "") { picked = raw === "" ? def : []; break; }
      const nums = raw.split(/[\s,]+/).filter(Boolean).map(Number);
      if (nums.every((n) => Number.isInteger(n) && n >= 1 && n <= PROVIDER_ORDER.length)) { picked = [...new Set(nums)].map((n) => PROVIDER_ORDER[n - 1]); break; }
      const names = raw.split(/[\s,]+/).filter(Boolean);
      if (names.every((n) => PROVIDER_ORDER.includes(n))) { picked = names; break; }
      console.log(`    ${color.red("enter numbers 1-" + PROVIDER_ORDER.length + ", provider names, or all")}`);
    }
  }
  picked = PROVIDER_ORDER.filter((n) => picked.includes(n));
  report.pass("providers to configure", picked.length ? picked.join(", ") : "(none)");
  // Anything configured earlier but not selected now: offer to switch it off so it cannot be picked by fallback.
  const stale = configured.filter((n) => !picked.includes(n));
  if (stale.length && prompter.interactive) {
    if (await prompter.confirm("disable_unselected", `Disable the providers you did not select but that still have saved config (${stale.join(", ")})? They stay in the file, just switched off`, true)) {
      for (const n of stale) { cfg.providers[n] = { ...cfg.providers[n], enabled: false }; report.skip(`${n}: disabled`, "re-run setup and select it to turn it back on"); }
    }
  }
  return picked;
}

/** After the walk-through: one table, and a chance to redo any row before anything is written. */
async function reviewProviders(cfg, gw, runOne) {
  if (!prompter.interactive) return;
  for (;;) {
    console.log(`\n  ${color.bold("Providers — review")}`);
    const rows = PROVIDER_ORDER.filter((n) => cfg.providers[n]);
    if (!rows.length) { console.log(color.dim("    nothing configured")); return; }
    rows.forEach((n, i) => {
      const p = cfg.providers[n];
      const usable = usableProv(p, gw.PROVIDER_CATALOG[n]);
      const tag = !usable ? color.dim("off      ") : state.providersVerified.includes(n) ? color.green("verified ") : color.yellow("unverified");
      console.log(`    ${String(i + 1).padStart(2)}) ${tag} ${gw.PROVIDER_CATALOG[n].label.padEnd(36)} ${color.dim(providerStatus(n, p, gw))}`);
    });
    const raw = String(await prompter.ask("review_providers", "Change one? number, or Enter to continue", { def: "" })).trim();
    delete prompter.answers.review_providers;
    if (!raw) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > rows.length) { console.log(`    ${color.red("enter a row number or press Enter")}`); continue; }
    await runOne(rows[n - 1]);
  }
}

/** Numbered catalog of every model the configured providers actually serve right now. */
function buildCatalog(cfg, gw) {
  const rows = [];
  for (const [prov, pc] of Object.entries(cfg.providers)) {
    const cat = gw.PROVIDER_CATALOG[prov];
    if (!usableProv(pc, cat)) continue;
    const live = state.modelLists?.[prov] ?? [];
    const def = pc.defaultModel ?? cat?.defaultModel;
    // default first, then catalog-known models that are live, then the rest (capped so OpenRouter does not print 300 lines)
    const ordered = [...new Set([def, ...(cat?.knownModels ?? []).filter((m) => live.includes(m)), ...live])].filter((m) => m && (live.length ? live.includes(m) : true));
    const shown = ordered.slice(0, live.length > 12 ? 12 : ordered.length);
    for (const m of shown) rows.push({ spec: `${prov}/${m}`, provider: prov, model: m, isDefault: m === def, live: live.includes(m) });
    if (ordered.length > shown.length) rows.push({ spec: `${prov}/…`, provider: prov, more: ordered.length - shown.length });
  }
  return rows;
}

/** Filter a wished-for sequence to models that exist; substitute a provider's chosen default when its named model is gone. */
function realise(cfg, gw, wanted) {
  const out = [];
  for (const spec of wanted) {
    const [prov, ...rest] = spec.split("/");
    const model = rest.join("/");
    const pc = cfg.providers[prov];
    if (!usableProv(pc, gw.PROVIDER_CATALOG[prov])) continue;
    const live = state.modelLists?.[prov];
    if (!model) { out.push(`${prov}/${pc.defaultModel ?? gw.PROVIDER_CATALOG[prov]?.defaultModel}`); continue; }
    if (!live?.length || live.includes(model)) out.push(spec);
    else if (pc.defaultModel) out.push(`${prov}/${pc.defaultModel}`);
  }
  return [...new Set(out)];
}

const ALIAS_HELP = {
  fast: "cheap/fast worker for boilerplate, tests, refactors",
  strong: "strongest model for hard implementation and supervision",
  reviewer: "independent reviewer — ideally a different vendor than the worker",
  local: "never leaves the machine (Ollama / vLLM / LM Studio)",
};

async function configureChains(cfg, gw) {
  console.log(`\n  ${color.bold("Model chains")} ${color.dim("— each alias is an ordered list; the first usable model is tried, the rest are fallbacks.")}`);
  const catalog = buildCatalog(cfg, gw);
  const pickable = catalog.filter((r) => !r.more);
  if (!pickable.length) { report.warn("no models to build chains from", "no provider is configured", "add a key or enable Ollama, then re-run"); return; }
  if (prompter.interactive) {
    console.log(color.dim("  Catalog (live from each provider; ★ = that provider's default):"));
    let n = 0;
    for (const r of catalog) {
      if (r.more) { console.log(color.dim(`        … ${r.more} more on ${r.provider} — type provider/model to use one`)); continue; }
      n++;
      console.log(`    ${String(n).padStart(2)}) ${r.spec}${r.isDefault ? " ★" : ""}${r.live ? "" : color.dim("  (not in live list)")}`);
    }
  }
  const providerDefaults = Object.entries(cfg.providers).filter(([n, p]) => usableProv(p, gw.PROVIDER_CATALOG[n])).map(([n, p]) => `${n}/${p.defaultModel ?? gw.PROVIDER_CATALOG[n]?.defaultModel}`);
  const localDefaults = providerDefaults.filter((s) => /^(ollama|vllm|lmstudio)\//.test(s));
  const cloudDefaults = providerDefaults.filter((s) => !/^(ollama|vllm|lmstudio)\//.test(s));
  const suggestions = {
    fast: realise(cfg, gw, gw.DEFAULT_ALIASES.fast.candidates),
    strong: realise(cfg, gw, gw.DEFAULT_ALIASES.strong.candidates),
    reviewer: realise(cfg, gw, gw.DEFAULT_ALIASES.reviewer.candidates),
    local: realise(cfg, gw, gw.DEFAULT_ALIASES.local.candidates),
  };
  // Fill gaps with what is actually configured so every alias resolves to something.
  if (!suggestions.fast.length) suggestions.fast = [...cloudDefaults, ...localDefaults];
  if (!suggestions.strong.length) suggestions.strong = [...cloudDefaults, ...localDefaults];
  if (!suggestions.reviewer.length) suggestions.reviewer = [...cloudDefaults.slice().reverse(), ...localDefaults];
  if (!suggestions.local.length) suggestions.local = localDefaults;
  suggestions.chain = [...new Set([...(cfg.fallback?.chain ?? []).filter((s) => realise(cfg, gw, [s]).length), ...cloudDefaults.slice(0, 2), ...localDefaults.slice(0, 1)])];

  cfg.aliases ??= {};
  const parseSeq = (raw, current) => {
    const parts = String(raw).split(",").map((x) => x.trim()).filter(Boolean);
    const out = [];
    for (const p of parts) {
      const n = Number(p);
      if (Number.isInteger(n) && n >= 1 && n <= pickable.length) { out.push(pickable[n - 1].spec); continue; }
      if (/^[\w.-]+\/.+$/.test(p) || cfg.providers[p]) out.push(p);
      else return { error: `'${p}' is neither a catalog number nor provider/model` };
    }
    return { seq: out.length ? [...new Set(out)] : current };
  };
  for (const key of ["fast", "strong", "reviewer", "local", "chain"]) {
    const existing = key === "chain" ? cfg.fallback?.chain : (Array.isArray(cfg.aliases[key]) ? cfg.aliases[key] : cfg.aliases[key]?.candidates);
    const stale = (existing ?? []).filter((s) => !realise(cfg, gw, [s]).length || realise(cfg, gw, [s])[0] !== s);
    let current = existing?.length && !stale.length ? existing : suggestions[key];
    if (stale.length) report.warn(`${key === "chain" ? "fallback chain" : `alias '${key}'`} referenced models that no longer exist`, stale.join(", "), "replaced with the suggestion below");
    const label = key === "chain" ? "global last-resort chain (tried after any alias)" : `alias '${key}' — ${ALIAS_HELP[key]}`;
    const id = key === "chain" ? "fallback_chain" : `alias_${key}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await prompter.ask(id, `${label}\n    suggested: ${current.length ? current.join(" → ") : "(none)"}\n    Enter = accept, or numbers/specs in order (e.g. 3,1,7), 'none' to clear`, { def: "" });
      delete prompter.answers[id];
      if (raw === undefined || String(raw).trim() === "") break;
      if (/^(none|-)$/i.test(String(raw).trim())) { current = []; break; }
      const r = parseSeq(raw, current);
      if (r.error) { console.log(`    ${color.red(r.error)}`); continue; }
      const gone = r.seq.filter((s) => !realise(cfg, gw, [s]).length);
      if (gone.length) console.log(`    ${color.yellow(`not usable right now (no key / not served): ${gone.join(", ")}`)} — kept anyway; fallback skips them at runtime`);
      current = r.seq;
      break;
    }
    if (key === "chain") cfg.fallback = { ...(cfg.fallback ?? {}), chain: current };
    else if (current.length) cfg.aliases[key] = { description: ALIAS_HELP[key], candidates: current };
    else delete cfg.aliases[key]; // empty alias is invalid; fall back to the built-in definition
    report.pass(`${key === "chain" ? "fallback chain" : `alias ${key}`}`, current.length ? current.join(" → ") : "(empty)");
  }
  report.info("change later: `configure_alias` / `configure_fallback` from inside the agent, or edit the config file");
}

async function configureKeyedProvider(name, cat, current, cfg, gw, storage) {
  if (prompter.answers[`${name}_enabled`] === false) {
    cfg.providers[name] = { ...current, enabled: false };
    report.skip(`${name}: disabled`, current.apiKey ? "saved key kept" : "");
    return;
  }
  if (current.enabled === false && prompter.interactive) {
    if (!(await prompter.confirm(`${name}_reenable`, `${cat.label} is currently switched off — turn it back on?`, false))) { report.skip(`${name}: stays disabled`); return; }
    current = { ...current, enabled: true };
  }
  const envKey = process.env[cat.keyEnv];
  const saved = current.apiKey && !/^\$\{?/.test(current.apiKey) ? current.apiKey : undefined;
  const savedRef = current.apiKey && /^\$\{?/.test(current.apiKey) ? current.apiKey : undefined;
  const opts = [];
  if (saved) opts.push(`Enter = keep saved key (${redact(saved)})`);
  else if (savedRef && envKey) opts.push(`Enter = keep ${savedRef} (${redact(envKey)})`);
  else if (envKey) opts.push(`Enter = use ${cat.keyEnv} from your shell (${redact(envKey)})`);
  else opts.push("Enter = skip");
  const def = saved ? "keep" : (savedRef && envKey) || envKey ? "env" : "skip";
  const legacy = prompter.answers[`${name}_key_source`]; // backwards-compatible answers files

  const save = (key, useEnvRef, model) => {
    cfg.providers[name] = { ...current, apiKey: useEnvRef ? `\${${cat.keyEnv}}` : key, defaultModel: model, enabled: true };
    if (useEnvRef && process.env[cat.keyEnv] !== key) report.warn(`${name}: ${cat.keyEnv} must be exported where Claude Code/Codex launch`, "config only references it", `export ${cat.keyEnv}=…  (add to ~/.zshrc)`);
    if (!state.providersConfigured.includes(name)) state.providersConfigured.push(name);
  };

  for (let keyAttempt = 0; keyAttempt < 3; keyAttempt++) {
    // ---- 1) obtain a key
    let input;
    if (legacy && keyAttempt === 0) input = legacy === "paste" ? prompter.answers[`${name}_api_key`] : legacy;
    else input = await prompter.ask(`${name}_api_key`, `${cat.label} API key  ${color.dim(`[${opts.join("; ")}; or type skip / env / keep]`)}`, { hidden: true, def });
    delete prompter.answers[`${name}_api_key`];
    const v = String(input ?? "").trim();
    let key;
    if (!v || /^(skip|none|no|-)$/i.test(v)) { report.skip(`${name}: not configured`); return; }
    if (/^env$/i.test(v)) { if (!envKey) { console.log(`    ${color.red(`${cat.keyEnv} is not set in this shell`)}`); if (!prompter.interactive) return; continue; } key = envKey; }
    else if (/^keep$/i.test(v)) { if (!saved) { console.log(`    ${color.red("no saved key to keep")}`); if (!prompter.interactive) return; continue; } key = saved; }
    else if (v.length < 8) { console.log(`    ${color.red("that looks too short for an API key — paste the full key, or type skip")}`); if (!prompter.interactive) return; continue; }
    else key = v;
    console.log(`    ${color.dim(`received ${redact(key)} (${key.length} chars)`)}`);
    const useEnvRef = storage === "env" || (/^env$/i.test(v) && !saved);

    if (name === "zai" && keyAttempt === 0 && await prompter.confirm("zai_coding_plan", "Are you on the Z.AI Coding Plan (different endpoint)?", /coding/.test(current.baseUrl ?? ""))) current.baseUrl = "https://api.z.ai/api/coding/paas/v4";
    const prov = { name, label: cat.label, baseUrl: (current.baseUrl ?? cat.baseUrl).replace(/\/+$/, ""), apiKey: key, keyEnv: cat.keyEnv, requiresKey: true, enabled: true, headers: cat.headers ?? {}, defaultModel: current.defaultModel ?? cat.defaultModel, knownModels: cat.knownModels, supportsTools: cat.supportsTools, extraBody: { ...(cat.extraBody ?? {}), ...(current.extraBody ?? {}) }, docs: cat.docs };

    // ---- 2) live model list (also validates the key on most providers)
    let models = [];
    try { models = await gw.listRemoteModels(prov, 15_000); } catch (e) { report.log(`${name} /models: ${e.message}`); }
    if (models.length) { state.modelLists[name] = models; report.info(`${name}: ${models.length} models listed${name === "ollama-cloud" ? " (note: ollama.com lists models without checking the key — the real test is next)" : ""}`); }
    else report.info(`${name}: could not list models (some providers do not support /models); the completion test below decides`);

    // ---- 3) pick a model, verify with a real completion; on failure choose what to do next
    let preferred = pickDefault(models, current.defaultModel ?? cat.defaultModel, cat.knownModels);
    for (let modelAttempt = 0; modelAttempt < 4; modelAttempt++) {
      const chosen = await askModel(name, cat.label, models, preferred);
      const started = Date.now();
      try {
        const r = await gw.chatCompletion(prov, { model: chosen, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 32, temperature: 0 }, { timeoutMs: 45_000 });
        report.pass(`${name}: key works, ${chosen} answered`, `${Date.now() - started} ms${(r.message.content ?? "").trim() ? `: "${(r.message.content ?? "").trim().slice(0, 30)}"` : ""}`);
        save(key, useEnvRef, chosen);
        state.providersVerified.push(name);
        return;
      } catch (e) {
        const reason = e.reason ?? "error";
        const fix = reason === "auth" && /allowlist|proxy|egress|forbidden by/i.test(String(e.message)) ? "a proxy/firewall blocked the request — allow the host or run outside the proxy"
          : reason === "auth" ? `key rejected (you entered ${redact(key)}) — check for a truncated paste, or regenerate at ${cat.docs}`
          : reason === "not_found" ? `model '${chosen}' not available on this account — pick another`
          : reason === "rate_limit" ? "rate limited or out of credit on that model — pick another, or top up"
          : reason === "bad_request" ? `the provider rejected the request: ${String(e.message).slice(0, 120)}`
          : reason === "network" || reason === "timeout" ? "endpoint unreachable or slow — check base URL / proxy / VPN"
          : "see setup.log";
        report.warn(`${name}: verification failed`, `[${reason}] ${String(e.message).slice(0, 160)}`, fix);
        report.log(String(e.stack ?? e));
        if (!prompter.interactive) { save(key, useEnvRef, chosen); report.info(`${name}: saved unverified (non-interactive)`); return; }
        const next = await prompter.choose(`${name}_after_fail_${keyAttempt}_${modelAttempt}`, "What next?", [
          { key: "model", label: "pick a different model (same key)" },
          { key: "key", label: "enter a different key" },
          { key: "save", label: "save it anyway (unverified)" },
          { key: "skip", label: "skip this provider" },
        ], reason === "auth" ? "key" : "model");
        if (next === "save") { save(key, useEnvRef, chosen); return; }
        if (next === "skip") { report.skip(`${name}: not saved`); return; }
        if (next === "key") break; // outer loop asks for a new key
        preferred = models.find((m) => m !== chosen) ?? preferred; // "model": loop again with the menu
      }
    }
  }
  report.skip(`${name}: giving up after 3 keys`);
}

/** Ollama native API: sizes and currently-loaded models, so we can pick a default that answers quickly. */
async function ollamaInventory(baseUrl) {
  const root = baseUrl.replace(/\/v1\/?$/, "");
  const tags = await probeUrl(`${root}/api/tags`, 6000);
  const ps = await probeUrl(`${root}/api/ps`, 6000);
  const sizes = Object.fromEntries((tags.json?.models ?? []).map((m) => [m.name, m.size ?? 0]));
  const loaded = (ps.json?.models ?? []).map((m) => m.name);
  return { ok: tags.ok, sizes, loaded };
}
const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;

async function configureLocalProvider(name, cat, current, cfg, gw) {
  const url = String(await prompter.ask(`${name}_base_url`, `Base URL for ${cat.label} (OpenAI-compatible, ends in /v1)`, { def: current.baseUrl ?? cat.baseUrl })).replace(/\/+$/, "");
  const prov = { name, label: cat.label, baseUrl: url, apiKey: process.env[cat.keyEnv], keyEnv: cat.keyEnv, requiresKey: false, enabled: true, headers: {}, defaultModel: current.defaultModel ?? cat.defaultModel, knownModels: cat.knownModels, supportsTools: cat.supportsTools, docs: cat.docs };
  let models = [];
  let inv = { ok: false, sizes: {}, loaded: [] };
  try { models = await gw.listRemoteModels(prov, 6_000); } catch (e) { report.log(`${name} /models: ${e.message}`); }
  if (name === "ollama" && models.length) {
    inv = await ollamaInventory(url).catch(() => inv);
    // Prefer what is already in memory, then the smallest pulled model: both answer within seconds instead of minutes.
    models = [...models].sort((a, b) => (inv.loaded.includes(b) - inv.loaded.includes(a)) || ((inv.sizes[a] ?? 0) - (inv.sizes[b] ?? 0)));
  }
  if (models.length) {
    state.modelLists[name] = models;
    const desc = models.slice(0, 6).map((m) => `${m}${inv.loaded.includes(m) ? " (loaded)" : inv.sizes[m] ? ` (${gb(inv.sizes[m])})` : ""}`).join(", ");
    report.pass(`${name}: reachable at ${url}`, `${models.length} model(s): ${desc}${models.length > 6 ? "…" : ""}`);
    if (name === "ollama") report.retract(/^Ollama not reachable/);
  } else {
    report.warn(`${name}: nothing answering at ${url}/models`, "", name === "ollama" ? "start Ollama (`ollama serve`) or fix the host/port; for a remote host make sure OLLAMA_HOST=0.0.0.0 on that machine" : "start the server, or leave disabled");
  }
  const enableDef = models.length > 0 || current.enabled === true;
  const enable = await prompter.confirm(`${name}_enabled`, `Enable ${cat.label}?`, enableDef);
  if (!enable) { cfg.providers[name] = { ...current, baseUrl: url, enabled: false }; report.skip(`${name}: disabled`); return; }
  // Local models: prefer a loaded one, else the smallest; the catalog's preferred name only if it is actually present.
  const preferred = current.defaultModel && models.includes(current.defaultModel) ? current.defaultModel : models.includes(cat.defaultModel) ? cat.defaultModel : models[0] ?? current.defaultModel ?? cat.defaultModel;
  const chosen = await askModel(name, cat.label, models, preferred);
  // Cold loads on a LAN box can take minutes: give the runtime a generous per-provider timeout.
  cfg.providers[name] = { ...current, baseUrl: url, enabled: true, defaultModel: chosen, timeoutMs: current.timeoutMs ?? 600_000 };
  if (models.length && !models.includes(chosen)) report.warn(`${name}: '${chosen}' is not in the server's model list`, "", name === "ollama" ? `ollama pull ${chosen}` : "check the model name");
  if (models.length) {
    const started = Date.now();
    const cold = name === "ollama" && !inv.loaded.includes(chosen);
    report.info(`${cold ? `loading ${chosen} into memory on ${url} (cold start can take a few minutes)` : `calling ${chosen}`}…`);
    try {
      await gw.chatCompletion({ ...prov, defaultModel: chosen }, { model: chosen, messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 32, temperature: 0 }, { timeoutMs: 300_000 });
      report.pass(`${name}: ${chosen} works`, `${((Date.now() - started) / 1000).toFixed(1)} s${cold ? " (cold start; later calls are faster)" : ""}`);
      state.providersVerified.push(name);
    } catch (e) {
      const reason = e.reason ?? "error";
      report.warn(`${name}: ${chosen} did not answer`, `[${reason}] ${String(e.message).slice(0, 160)}`,
        reason === "timeout" ? `the host did not finish loading ${chosen} in 5 min — pick a smaller model${inv.sizes[chosen] ? ` (this one is ${gb(inv.sizes[chosen])})` : ""}, or pre-load it with \`ollama run ${chosen}\` on the host` : name === "ollama" ? `ollama pull ${chosen} on that host, or pick a listed model` : "check the model name / server logs");
      report.log(String(e.stack ?? e));
    }
  }
  state.providersConfigured.push(name);
}

function pickDefault(models, preferred, known) {
  if (!models.length) return preferred;
  if (models.includes(preferred)) return preferred;
  const k = known.find((m) => models.includes(m));
  if (k) return k;
  const coder = models.find((m) => /coder|code/i.test(m));
  return coder ?? models[0];
}

async function askModel(name, label, models, def) {
  if (`${name}_default_model` in prompter.answers) return prompter.answers[`${name}_default_model`];
  if (!prompter.interactive || !models.length) {
    if (!models.length && prompter.interactive) return String(await prompter.ask(`${name}_default_model`, `Default model for ${label} (no live list available)`, { def })).trim();
    return def;
  }
  // Numbered menu from the provider's LIVE list; big catalogs (OpenRouter) can be filtered by typing a substring.
  let view = models;
  let filter = "";
  for (;;) {
    const page = view.slice(0, 25);
    console.log(`  ${color.bold(`Default model for ${label}`)}${filter ? color.dim(` — filter "${filter}"`) : ""} ${color.dim(`(${view.length} of ${models.length})`)}`);
    page.forEach((m, i) => console.log(`    ${String(i + 1).padStart(2)}) ${m}${m === def ? color.dim("  (suggested)") : ""}`));
    if (view.length > page.length) console.log(color.dim(`    … ${view.length - page.length} more — type part of a name to filter`));
    const defIdx = page.indexOf(def);
    const raw = String(await prompter.ask(`${name}_default_model`, `number, or name/substring`, { def: defIdx >= 0 ? String(defIdx + 1) : def })).trim();
    delete prompter.answers[`${name}_default_model`];
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= page.length) return page[n - 1];
    if (models.includes(raw)) return raw;
    const hits = models.filter((m) => m.toLowerCase().includes(raw.toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) { view = hits; filter = raw; continue; }
    console.log(`    ${color.yellow(`'${raw}' matches nothing in the live list`)}`);
    if (await prompter.confirm(`${name}_model_force`, "Use it anyway (the provider may accept names it does not list)?", false)) return raw;
    view = models; filter = "";
  }
}


function redact(k) { return !k ? "(none)" : k.length <= 8 ? "****" : `${k.slice(0, 4)}…${k.slice(-4)}`; }

// ---- scope ------------------------------------------------------------------
async function chooseScope() {
  report.section("Install scope");
  const opts = [
    { key: "user", label: "user level — available in every project (~/.claude, ~/.codex, ~/.agents)" },
    { key: "project", label: "project level — only inside one repository (.mcp.json, .claude/, .agents/, .codex/)" },
    { key: "both", label: "both" },
    { key: "none", label: "skip this tool" },
  ];
  if (targets.claude) scope.claude = await prompter.choose("claude_scope", "Claude Code: where should the skill, commands and MCP server be installed?", opts, "user");
  if (targets.codex) scope.codex = await prompter.choose("codex_scope", "Codex: where should the skill and MCP server be installed?", opts, "user");
  const needsProject = [scope.claude, scope.codex].some((x) => x === "project" || x === "both");
  if (needsProject && !scope.project) {
    scope.project = path.resolve(await prompter.ask("project_dir", "Project directory (repository root)", { def: process.cwd(), validate: (v) => (v && fs.existsSync(v) ? null : "directory does not exist") }));
  }
  if (scope.project && !fs.existsSync(scope.project)) { report.fail("project dir does not exist", scope.project); scope.project = undefined; }
  if (scope.project && !fs.existsSync(path.join(scope.project, ".git"))) report.warn("project dir is not a git repository", scope.project, "workers' git tools need a repo; `git init` first");
  report.pass("scope", `claude=${scope.claude} codex=${scope.codex}${scope.project ? ` project=${scope.project}` : ""}`);
}
const wantsUser = (t) => scope[t] === "user" || scope[t] === "both";
const wantsProject = (t) => (scope[t] === "project" || scope[t] === "both") && !!scope.project;

// ---- legacy names (pre break-free-* prefix) -------------------------------
async function removeLegacyNames() {
  const removed = [];
  const roots = [];
  if (targets.claude && wantsUser("claude")) roots.push({ tool: "claude", dir: path.join(home(), ".claude") });
  if (targets.codex && wantsUser("codex")) roots.push({ tool: "codex", dir: path.join(home(), ".agents") });
  if (scope.project) { roots.push({ tool: "claude", dir: path.join(scope.project, ".claude") }); roots.push({ tool: "codex", dir: path.join(scope.project, ".agents") }); }
  for (const r of roots) {
    for (const sk of LEGACY_SKILLS) { const p = path.join(r.dir, "skills", sk); if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(path.relative(home(), p)); } }
    if (r.tool === "claude") for (const f of LEGACY_COMMANDS) { const p = path.join(r.dir, "commands", f); if (fs.existsSync(p) && /model-gateway|github-flow/.test(fs.readFileSync(p, "utf8"))) { fs.rmSync(p); removed.push(path.relative(home(), p)); } }
  }
  if (targets.claude && wantsUser("claude")) { const r = await run("claude", ["mcp", "remove", "--scope", "user", LEGACY_CLAUDE_SERVER], { timeoutMs: 30_000 }); if (r.ok) removed.push(`claude mcp ${LEGACY_CLAUDE_SERVER}`); }
  if (targets.codex && wantsUser("codex")) { const toml = path.join(home(), ".codex", "config.toml"); if (fs.existsSync(toml) && fs.readFileSync(toml, "utf8").includes(`[mcp_servers.${LEGACY_CODEX_SERVER}]`)) { fs.writeFileSync(toml, removeTomlTable(fs.readFileSync(toml, "utf8"), `mcp_servers.${LEGACY_CODEX_SERVER}`)); removed.push(`codex table ${LEGACY_CODEX_SERVER}`); } }
  if (scope.project) {
    const mcpJsonPath = path.join(scope.project, ".mcp.json"); const mcp = readJsonSafe(mcpJsonPath);
    if (mcp?.mcpServers?.[LEGACY_CLAUDE_SERVER]) { delete mcp.mcpServers[LEGACY_CLAUDE_SERVER]; fs.writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2) + "\n"); removed.push(".mcp.json model-gateway"); }
    const ptoml = path.join(scope.project, ".codex", "config.toml");
    if (fs.existsSync(ptoml) && fs.readFileSync(ptoml, "utf8").includes(`[mcp_servers.${LEGACY_CODEX_SERVER}]`)) { fs.writeFileSync(ptoml, removeTomlTable(fs.readFileSync(ptoml, "utf8"), `mcp_servers.${LEGACY_CODEX_SERVER}`)); removed.push(".codex/config.toml model_gateway"); }
  }
  for (const f of [path.join(home(), ".codex", "AGENTS.md"), scope.project && path.join(scope.project, "AGENTS.md")].filter(Boolean)) {
    if (fs.existsSync(f)) { const t = fs.readFileSync(f, "utf8"); if (t.includes("model_gateway")) { fs.writeFileSync(f, t.replace(/model_gateway/g, CODEX_SERVER).replace(/`model-gateway` skill/g, `\`${GW_SKILL}\` skill`)); removed.push(`${path.basename(f)} references updated`); } }
  }
  for (const f of [path.join(home(), ".claude", "CLAUDE.md"), path.join(home(), ".codex", "AGENTS.md"), scope.project && path.join(scope.project, "CLAUDE.md"), scope.project && path.join(scope.project, "AGENTS.md")].filter(Boolean)) {
    if (fs.existsSync(f) && fs.readFileSync(f, "utf8").includes(LEGACY_GF_MARKER)) { stripBlock(f, LEGACY_GF_MARKER); removed.push(`${path.basename(f)} old rule`); }
  }
  // v2 Codex rule had no marker suffix and a blank line after its heading; replace it with the current one later
  for (const f of [path.join(home(), ".codex", "AGENTS.md"), scope.project && path.join(scope.project, "AGENTS.md")].filter(Boolean)) {
    if (!fs.existsSync(f)) continue;
    const t = fs.readFileSync(f, "utf8");
    const re = /(?:<!-- Append to your repo's AGENTS\.md[^\n]*-->\n+)?## Delegating to other models\n+The `break_free_gateway` MCP server is available\. Use the[^\n]*\n?/g;
    if (re.test(t)) { fs.writeFileSync(f, t.replace(re, "").replace(/\n{3,}/g, "\n\n")); removed.push(`${path.basename(f)} v2 delegation rule`); }
  }
  if (removed.length) report.pass("removed previous (unprefixed) names", removed.join(", "));
}

// ---- skills & registration --------------------------------------------------
async function installClaude() {
  report.section("Claude Code (user level)");
  if (!targets.claude) { report.skip("Claude Code registration", "claude CLI not installed"); return; }
  if (!wantsUser("claude")) { report.skip("user-level install", `scope=${scope.claude}`); return; }
  const skillsDir = path.join(home(), ".claude", "skills", GW_SKILL);
  const cmdDir = path.join(home(), ".claude", "commands");
  copyDir(path.join(AGENT_CFG, "claude", "skills", GW_SKILL), skillsDir);
  fs.existsSync(path.join(skillsDir, "SKILL.md")) ? report.pass("skill installed", skillsDir) : report.fail("skill copy failed", skillsDir);
  fs.mkdirSync(cmdDir, { recursive: true });
  const cmds = GW_COMMANDS;
  for (const f of cmds) {
    const dst = path.join(cmdDir, f);
    if (fs.existsSync(dst) && !sameContent(path.join(AGENT_CFG, "claude", "commands", f), dst) && !/break-free|model-gateway/.test(fs.readFileSync(dst, "utf8"))) {
      report.warn(`command /${f.replace(/\.md$/, "")} already exists and is not ours`, "left untouched", `delete ${dst} to install ours`);
      continue;
    }
    fs.copyFileSync(path.join(AGENT_CFG, "claude", "commands", f), dst);
  }
  report.pass("slash commands", cmds.map((f) => "/" + f.replace(/\.md$/, "")).join(" "));

  // MCP registration (user scope)
  await run("claude", ["mcp", "remove", "--scope", "user", CLAUDE_SERVER], { timeoutMs: 30_000 });
  // add-json is unambiguous; `claude mcp add --env` is variadic and swallows the server name.
  const spec = JSON.stringify({ type: "stdio", command: process.execPath, args: [ENTRY], env: { MODEL_GATEWAY_CONFIG: CFG_FILE } });
  let add = await run("claude", ["mcp", "add-json", "--scope", "user", CLAUDE_SERVER, spec], { timeoutMs: 60_000 });
  if (!add.ok) {
    report.log(`add-json failed: ${add.stderr || add.stdout}`);
    add = await run("claude", ["mcp", "add", "--scope", "user", "--transport", "stdio", CLAUDE_SERVER, "--", process.execPath, ENTRY], { timeoutMs: 60_000 });
  }
  if (!add.ok) { report.fail("claude mcp add failed", lastLines(add.stderr || add.stdout), `run manually: claude mcp add-json --scope user ${CLAUDE_SERVER} '${spec}'`); return; }
  const get = await run("claude", ["mcp", "get", CLAUDE_SERVER], { timeoutMs: 30_000 });
  if (get.ok && get.stdout.includes(ENTRY)) report.pass("MCP server registered (user scope)", `${CLAUDE_SERVER} → node ${path.relative(HERE, ENTRY)}`);
  else report.warn("registered, but `claude mcp get` did not echo the entry path", lastLines(get.stdout || get.stderr), "run `claude mcp list` to confirm");
  report.info("note: Claude Code launches the server with the project directory as cwd, which becomes the workers' workspace");
  // Same standing nudge Codex gets in AGENTS.md, so both agents consider delegation without magic words.
  const gwRule = fs.readFileSync(path.join(AGENT_CFG, "claude", "CLAUDE.gateway.snippet"), "utf8");
  appendOnce(path.join(home(), ".claude", "CLAUDE.md"), GW_MARKER, gwRule) ? report.pass("delegation rule added to ~/.claude/CLAUDE.md") : report.pass("~/.claude/CLAUDE.md already has the delegation rule");
}

function codexTomlBody(envVars) {
  return [
    `[mcp_servers.${CODEX_SERVER}]`,
    `command = ${tomlStr(process.execPath)}`,
    `args = [${tomlStr(ENTRY)}]`,
    `startup_timeout_sec = 20`,
    `tool_timeout_sec = 900`,
    envVars.length ? `env_vars = [${envVars.map(tomlStr).join(", ")}]` : `# env_vars = ["DEEPSEEK_API_KEY", ...]  # keys are read from the config file instead`,
    ``,
    `[mcp_servers.${CODEX_SERVER}.env]`,
    `MODEL_GATEWAY_CONFIG = ${tomlStr(CFG_FILE)}`,
  ].join("\n");
}

async function installCodex() {
  report.section("Codex (user level)");
  if (!targets.codex) { report.skip("Codex registration", "codex CLI not installed"); return; }
  if (!wantsUser("codex")) { report.skip("user-level install", `scope=${scope.codex}`); return; }
  const skillsDir = path.join(home(), ".agents", "skills", GW_SKILL);
  copyDir(path.join(AGENT_CFG, "codex", "skills", GW_SKILL), skillsDir);
  fs.existsSync(path.join(skillsDir, "SKILL.md")) ? report.pass("skill installed", skillsDir) : report.fail("skill copy failed", skillsDir);

  const tomlPath = path.join(home(), ".codex", "config.toml");
  fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
  const before = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : "";
  const envVars = KEY_ENVS.filter((k) => process.env[k]);
  const after = upsertTomlTable(before, `mcp_servers.${CODEX_SERVER}`, codexTomlBody(envVars));
  const b = backup(tomlPath);
  fs.writeFileSync(tomlPath, after);
  report.pass(`wrote [mcp_servers.${CODEX_SERVER}] to ~/.codex/config.toml`, b ? `backup: ${path.basename(b)}` : "new file");
  const list = await run("codex", ["mcp", "list"], { timeoutMs: 30_000 });
  if (list.ok && list.stdout.includes(CODEX_SERVER)) report.pass("codex sees the server", "codex mcp list");
  else if (list.ok) report.warn(`\`codex mcp list\` does not show ${CODEX_SERVER}`, lastLines(list.stdout), "open ~/.codex/config.toml and check the table was written (a syntax error elsewhere in the file breaks parsing)");
  else report.warn("`codex mcp list` failed", lastLines(list.stderr), "your codex version may not have `mcp list`; the TOML is written regardless");
  const agentsMd = path.join(home(), ".codex", "AGENTS.md");
  const snippet = fs.readFileSync(path.join(AGENT_CFG, "codex", "AGENTS.md.snippet"), "utf8");
  appendOnce(agentsMd, GW_MARKER, snippet) ? report.pass("delegation rule added/updated in ~/.codex/AGENTS.md") : report.pass("~/.codex/AGENTS.md already has the current delegation rule");
}

async function installProject() {
  const pd = scope.project;
  if (!pd || (!wantsProject("claude") && !wantsProject("codex"))) return;
  report.section(`Project level: ${pd}`);

  if (wantsProject("claude")) {
    copyDir(path.join(AGENT_CFG, "claude", "skills", GW_SKILL), path.join(pd, ".claude", "skills", GW_SKILL));
    fs.mkdirSync(path.join(pd, ".claude", "commands"), { recursive: true });
    for (const f of GW_COMMANDS) fs.copyFileSync(path.join(AGENT_CFG, "claude", "commands", f), path.join(pd, ".claude", "commands", f));
    report.pass("Claude: skill + commands → .claude/");
    const mcpJsonPath = path.join(pd, ".mcp.json");
    const existing = readJsonSafe(mcpJsonPath) ?? {};
    if (existing.__error) report.fail(".mcp.json exists but is not valid JSON; not touched", existing.__error, `fix ${mcpJsonPath} and re-run`);
    else {
      backup(mcpJsonPath);
      existing.mcpServers ??= {};
      existing.mcpServers[CLAUDE_SERVER] = { type: "stdio", command: process.execPath, args: [ENTRY], env: { MODEL_GATEWAY_CONFIG: CFG_FILE, MODEL_GATEWAY_WORKSPACE: "${CLAUDE_PROJECT_DIR}" }, timeout: 900000 };
      delete existing.$comment;
      fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n");
      report.pass("Claude: wrote .mcp.json", "Claude Code asks once to approve project servers (claude mcp reset-project-choices to re-ask)");
      if (appendOnce(path.join(pd, "CLAUDE.md"), GW_MARKER, fs.readFileSync(path.join(AGENT_CFG, "claude", "CLAUDE.gateway.snippet"), "utf8"))) report.pass("Claude: delegation rule added to CLAUDE.md");
      report.info("note: .mcp.json holds an absolute path to this machine's build — teammates run setup.mjs to get their own");
    }
  }

  if (wantsProject("codex")) {
    copyDir(path.join(AGENT_CFG, "codex", "skills", GW_SKILL), path.join(pd, ".agents", "skills", GW_SKILL));
    report.pass("Codex: skill → .agents/skills/");
    const tomlPath = path.join(pd, ".codex", "config.toml");
    fs.mkdirSync(path.dirname(tomlPath), { recursive: true });
    const before = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : "";
    backup(tomlPath);
    fs.writeFileSync(tomlPath, upsertTomlTable(before, `mcp_servers.${CODEX_SERVER}`, codexTomlBody(KEY_ENVS.filter((k) => process.env[k]))));
    report.pass("Codex: wrote .codex/config.toml (project scope)", "Codex only reads project config for trusted projects: answer 'trust' when Codex asks, or add the path under [projects] in ~/.codex/config.toml");
    const agents = path.join(pd, "AGENTS.md");
    const snippet = fs.readFileSync(path.join(AGENT_CFG, "codex", "AGENTS.md.snippet"), "utf8");
    appendOnce(agents, GW_MARKER, snippet) ? report.pass("Codex: delegation rule added/updated in AGENTS.md") : report.pass("AGENTS.md already has the current delegation rule");
  }

  if (fs.existsSync(path.join(pd, ".git"))) {
    const r = await run(process.execPath, [ENTRY, "--workspace", pd, "--ledger-guard"], { timeoutMs: 30_000, env: { ...process.env, MODEL_GATEWAY_CONFIG: CFG_FILE } });
    if (r.ok) { const j = safeJson(r.stdout) ?? {}; report.pass("ledger guard installed", `pre-commit hook ${j.hook}${j.chained ? " (existing hook chained)" : ""} + .github/workflows/break-free-ledger-guard.yml — feature-branch PRs can never change .break-free/`); }
    else report.warn("ledger guard not installed", lastLines(r.stderr || r.stdout), "run ledger_guard {action:'install'} from the gateway later");
  }
  const gi = path.join(pd, ".gitignore");
  if (!fs.existsSync(gi) || !fs.readFileSync(gi, "utf8").includes(".model-gateway.json")) { fs.appendFileSync(gi, "\n.model-gateway.json\n"); report.pass(".gitignore: added .model-gateway.json (project config may hold local overrides)"); }
}


// ---- other harnesses: opencode, kiro-cli, kimi, agy (Antigravity), pi, omp -----------
// Each gets: the MCP server registered in its own config, both break-free skills in its skill
// folder, and the standing rules in the instruction file it reads. Project-level installs reuse
// what Claude/Codex already put in the repo (AGENTS.md, .agents/skills, .mcp.json) where the
// harness reads those, and add only the harness-specific files.
const EXTRA_AGENTS = {
  opencode: { label: "OpenCode", bins: ["opencode"], dirs: ["~/.config/opencode"],
    user: { mcp: { file: "~/.config/opencode/opencode.json", shape: "opencode" }, skills: "~/.config/opencode/skills", rules: "~/.config/opencode/AGENTS.md" },
    project: { mcp: { file: "opencode.json", shape: "opencode" } } },
  kiro: { label: "Kiro CLI", bins: ["kiro-cli", "kiro"], dirs: ["~/.kiro"],
    user: { mcp: { file: "~/.kiro/settings/mcp.json", shape: "mcpServers" }, skills: "~/.kiro/skills", rules: "~/.kiro/steering/break-free.md", rulesOwned: true },
    project: { mcp: { file: ".kiro/settings/mcp.json", shape: "mcpServers" }, skills: ".kiro/skills", rules: ".kiro/steering/break-free.md", rulesOwned: true } },
  kimi: { label: "Kimi Code CLI", bins: ["kimi", "kimi-cli"], dirs: ["~/.kimi"],
    user: { mcp: { file: "~/.kimi/mcp.json", shape: "mcpServers" }, skills: "~/.kimi/skills" },
    project: {} , note: "kimi reads the repo's AGENTS.md and .agents/skills (installed with Codex/project scope)" },
  agy: { label: "Antigravity (agy)", bins: ["agy", "antigravity"], dirs: ["~/.gemini/config", "~/.gemini/antigravity"],
    user: { mcp: { file: "~/.gemini/config/mcp_config.json", shape: "mcpServers" }, skills: "~/.gemini/config/skills", rules: "~/.gemini/GEMINI.md" },
    project: { mcp: { file: ".agents/mcp_config.json", shape: "mcpServers" }, rules: ".agents/rules/break-free.md", rulesOwned: true } },
  pi: { label: "pi (pi.dev)", bins: ["pi"], dirs: ["~/.pi/agent"],
    user: { mcp: { file: "~/.pi/agent/mcp.json", shape: "mcpServers" }, skills: "~/.pi/agent/skills", rules: "~/.pi/agent/AGENTS.md" },
    project: { skills: ".pi/skills" }, note: "pi needs the MCP adapter extension once: pi install npm:pi-mcp-adapter" },
  omp: { label: "oh-my-pi (omp)", bins: ["omp"], dirs: ["~/.omp/agent"],
    user: { mcp: { file: "~/.omp/agent/mcp.json", shape: "mcpServers" }, skills: "~/.omp/agent/skills", rules: "~/.omp/agent/AGENTS.md" },
    project: { mcp: { file: ".omp/mcp.json", shape: "mcpServers" }, skills: ".omp/skills", rules: ".omp/AGENTS.md" } },
  gemini: { label: "Gemini CLI", bins: ["gemini"], dirs: ["~/.gemini"],
    user: { mcp: { file: "~/.gemini/settings.json", shape: "mcpServers" }, skills: "~/.gemini/skills", rules: "~/.gemini/GEMINI.md" },
    project: { mcp: { file: ".gemini/settings.json", shape: "mcpServers" }, skills: ".gemini/skills", rules: "GEMINI.md" } },
  copilot: { label: "GitHub Copilot CLI", bins: ["copilot"], dirs: ["~/.copilot"],
    user: { skills: "~/.copilot/skills", rules: "~/.copilot/AGENTS.md" },
    project: {}, mcpNote: `register the server with: copilot mcp add break-free-gateway -- node ${ENTRY}`,
    note: "reads AGENTS.md + ~/.copilot/skills" },
  hermes: { label: "Hermes Agent", bins: ["hermes"], dirs: ["~/.hermes"],
    user: { skills: "~/.hermes/skills", rules: "~/.hermes/AGENTS.md" },
    project: {}, mcpNote: `add break-free-gateway under "mcp_servers:" in ~/.hermes/config.yaml (command: node, args: ["${ENTRY}"]) — or run "hermes import-agent claude-code"`,
    note: "mcp_servers live in ~/.hermes/config.yaml; skills in ~/.hermes/skills" },
  aider: { label: "Aider", bins: ["aider"], dirs: [],
    user: { rules: "~/.aider.conf.yml", rulesKind: "aider" },
    project: { rules: ".aider.conf.yml", rulesKind: "aider" },
    mcpNote: "aider's MCP support is experimental — register break-free-gateway in .aider.conf.yml by hand; this installs the standing rule via `read: AGENTS.md`",
    note: "reads AGENTS.md / CONVENTIONS.md via the `read:` config key" },
  cline: { label: "Cline", bins: ["cline"], dirs: ["~/.cline"],
    user: { rules: "~/.clinerules", rulesOwned: true },
    project: { rules: ".clinerules", rulesOwned: true },
    mcpNote: `Cline stores MCP servers in its editor settings (cline_mcp_settings.json) — add break-free-gateway there (command: node, args: ["${ENTRY}"])`,
    note: "VS Code extension; rules via .clinerules" },
  adal: { label: "AdaL CLI", bins: ["adal"], dirs: ["~/.adal"],
    user: { rules: "~/.adal/AGENTS.md" },
    project: {}, mcpNote: "AdaL manages MCP servers in its UI (no editable config file) — add break-free-gateway there; this installs the standing AGENTS.md rule",
    note: "Claude Code skills/plugins compatible" },
  openclaw: { label: "OpenClaw", bins: ["openclaw"], dirs: ["~/.openclaw"],
    user: { rules: "~/.openclaw/AGENTS.md" },
    project: {}, mcpNote: "register the server with: openclaw mcp add break-free-gateway (the registry lives in OpenClaw config)",
    note: "openclaw mcp add manages the server registry" },
  cursor: { label: "Cursor", bins: [], dirs: ["~/.cursor"],
    user: { mcp: { file: "~/.cursor/mcp.json", shape: "mcpServers" } },
    project: { mcp: { file: ".cursor/mcp.json", shape: "mcpServers" } },
    note: "editor — reads AGENTS.md, .agents/skills and .cursor/rules at project scope" },
  goose: { label: "Goose (Block)", bins: ["goose"], dirs: ["~/.config/goose"],
    user: { skills: "~/.config/goose/skills" },
    project: {}, mcpNote: "add break-free-gateway as an `extensions` entry in ~/.config/goose/config.yaml (or run `goose configure`)",
    note: "reads AGENTS.md; skills in ~/.config/goose/skills" },
  amp: { label: "Amp (Sourcegraph)", bins: ["amp"], dirs: ["~/.config/agents"],
    user: { skills: "~/.config/agents/skills" },
    project: {}, mcpNote: "define break-free-gateway via a skill's mcpServers or Amp's MCP config",
    note: "reads AGENTS.md + .agents/skills; personal skills in ~/.config/agents/skills" },
};
const EXTRA_ORDER = Object.keys(EXTRA_AGENTS);
const GENERIC_MARKER_NOTE = "<!-- break-free: generated by setup.mjs; safe to delete -->";

function genericRule(kind) {
  // The Codex snippets are the generic form (AGENTS.md conventions); swap the Codex-specific names.
  const f = kind === "gateway" ? "AGENTS.md.snippet" : "AGENTS.github-flow.snippet";
  return fs.readFileSync(path.join(AGENT_CFG, "codex", f), "utf8").replace(/break_free_gateway/g, CLAUDE_SERVER).replace(/\(`\$break-free-(model-gateway|github-flow)`\)/g, "(`break-free-$1` skill)").replace(/`\$break-free-(model-gateway|github-flow)`/g, "the `break-free-$1` skill");
}
function mcpEntry(shape) {
  const env = Object.fromEntries(KEY_ENVS.filter((k) => process.env[k]).map((k) => [k, `\${${k}}`]));
  if (shape === "opencode") return { type: "local", command: [process.execPath, ENTRY], enabled: true, ...(Object.keys(env).length ? { environment: env } : {}) };
  return { command: process.execPath, args: [ENTRY], ...(Object.keys(env).length ? { env } : {}) };
}
function upsertJsonMcp(file, shape, remove = false) {
  const abs = expandHome(file);
  let j = {};
  if (fs.existsSync(abs)) { j = readJsonSafe(abs); if (!j || j.__error) throw new Error(`${abs} is not valid JSON — fix it by hand first`); backup(abs); }
  const key = shape === "opencode" ? "mcp" : "mcpServers";
  j[key] ??= {};
  for (const legacy of [LEGACY_CLAUDE_SERVER, "model_gateway"]) delete j[key][legacy];
  if (remove) delete j[key][CLAUDE_SERVER]; else j[key][CLAUDE_SERVER] = mcpEntry(shape);
  if (shape === "opencode" && !j.$schema) j.$schema = "https://opencode.ai/config.json";
  if (remove && !Object.keys(j[key]).length) delete j[key];
  if (remove && !Object.keys(j).filter((k) => k !== "$schema").length) { fs.rmSync(abs, { force: true }); return; }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(j, null, 2) + "\n");
}
/** Aider reads AGENTS.md / CONVENTIONS.md when the `read:` key lists them. Append only; never touch an existing list. */
function upsertAiderRead(file, remove = false) {
  const abs = expandHome(file);
  if (remove) {
    if (!fs.existsSync(abs)) return;
    const txt = fs.readFileSync(abs, "utf8").replace(/\n?read:\n  - AGENTS\.md\n  - CONVENTIONS\.md\n?/, "");
    fs.writeFileSync(abs, txt);
    return;
  }
  if (fs.existsSync(abs)) {
    const txt = fs.readFileSync(abs, "utf8");
    if (/^read:/m.test(txt)) return; // an existing read: list is the user's to manage
  }
  backup(abs);
  const cur = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").replace(/\s+$/, "") : "";
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${cur ? cur + "\n\n" : ""}read:\n  - AGENTS.md\n  - CONVENTIONS.md\n`);
}
function detectExtraAgents() {
  const out = {};
  for (const [k, a] of Object.entries(EXTRA_AGENTS)) {
    const bin = a.bins.find((b) => which(b));
    const dir = a.dirs.find((d) => fs.existsSync(expandHome(d)));
    if (bin || dir) out[k] = bin ? `binary ${bin}` : `config ${dir}`;
  }
  return out;
}
async function chooseExtraAgents() {
  const detected = detectExtraAgents();
  let picked;
  if ("extra_agents" in prompter.answers) picked = prompter.answers.extra_agents === "all" ? EXTRA_ORDER : prompter.answers.extra_agents === "detected" ? Object.keys(detected) : prompter.answers.extra_agents;
  else if (!prompter.interactive) picked = Object.keys(detected);
  else {
    console.log(`\n  ${color.bold("Other coding agents to wire up")} ${color.dim("(MCP server + both skills + standing rules, in each tool's own config)")}`);
    EXTRA_ORDER.forEach((k, i) => console.log(`    ${String(i + 1).padStart(2)}) ${EXTRA_AGENTS[k].label.padEnd(22)} ${color.dim(detected[k] ? `detected (${detected[k]})` : "not detected")}${EXTRA_AGENTS[k].note ? `\n        ${color.dim(EXTRA_AGENTS[k].note)}` : ""}`));
    const def = Object.keys(detected);
    for (;;) {
      const raw = String(await prompter.ask("extra_agents", `numbers, names, 'all', 'none', or Enter for the detected ones`, { def: def.map((n) => EXTRA_ORDER.indexOf(n) + 1).join(",") || "none" })).trim();
      if (/^all$/i.test(raw)) { picked = EXTRA_ORDER; break; }
      if (/^(none|-)$/i.test(raw)) { picked = []; break; }
      if (raw === "") { picked = def; break; }
      const toks = raw.split(/[\s,]+/).filter(Boolean);
      const byNum = toks.map((t) => (Number.isInteger(Number(t)) ? EXTRA_ORDER[Number(t) - 1] : t));
      if (byNum.every((n) => EXTRA_ORDER.includes(n))) { picked = [...new Set(byNum)]; break; }
      console.log(`    ${color.red("enter numbers 1-" + EXTRA_ORDER.length + ", names (" + EXTRA_ORDER.join(", ") + "), all, or none")}`);
    }
  }
  picked = EXTRA_ORDER.filter((k) => (picked ?? []).includes(k));
  let scopeChoice = "user";
  if (picked.length) {
    scopeChoice = await prompter.choose("extra_scope", "Where should these be installed?", [
      { key: "user", label: "user level — every project" },
      { key: "project", label: "project level — this repository only" },
      { key: "both", label: "both" },
    ], scope.project ? "both" : "user");
    if ((scopeChoice === "project" || scopeChoice === "both") && !scope.project) {
      scope.project = path.resolve(await prompter.ask("project_dir", "Project directory (repository root)", { def: process.cwd(), validate: (v) => (v && fs.existsSync(v) ? null : "directory does not exist") }));
    }
  }
  state.extraAgents = picked;
  state.extraScope = scopeChoice;
  return picked;
}
async function installExtraAgents() {
  report.section("Other coding agents (gemini, copilot, cursor, goose, amp, hermes, aider, cline, adal, openclaw, …)");
  const picked = await chooseExtraAgents();
  if (!picked.length) { report.skip("no other agents selected"); return; }
  const wantU = ["user", "both"].includes(state.extraScope);
  const wantP = ["project", "both"].includes(state.extraScope) && scope.project;
  const gfRule = state.githubFlow === "full";
  for (const k of picked) {
    const a = EXTRA_AGENTS[k];
    const done = [];
    const apply = (t, base, isUser) => {
      const abs = (p) => (isUser ? expandHome(p) : path.join(base, p));
      if (t.mcp) { upsertJsonMcp(isUser ? t.mcp.file : path.join(base, t.mcp.file), t.mcp.shape); done.push(`mcp → ${isUser ? t.mcp.file : t.mcp.file}`); }
      if (t.skills) {
        for (const sk of [GW_SKILL, ...(state.githubFlow && state.githubFlow !== "none" ? [GF_SKILL] : [])]) {
          copyDir(path.join(AGENT_CFG, "codex", "skills", sk), path.join(abs(t.skills), sk));
          fs.rmSync(path.join(abs(t.skills), sk, "agents"), { recursive: true, force: true }); // Codex-only metadata
        }
        done.push(`skills → ${t.skills}`);
      }
      if (t.rules) {
        if (t.rulesKind === "aider") { upsertAiderRead(isUser ? t.rules : path.join(base, t.rules)); done.push(`rules → ${isUser ? t.rules : t.rules} (read: AGENTS.md)`); }
        else {
          const text = genericRule("gateway") + (gfRule ? "\n" + genericRule("github-flow") : "");
          if (t.rulesOwned) { fs.mkdirSync(path.dirname(abs(t.rules)), { recursive: true }); fs.writeFileSync(abs(t.rules), `${GENERIC_MARKER_NOTE}\n${text}`); }
          else { appendOnce(abs(t.rules), GW_MARKER, genericRule("gateway")); if (gfRule) appendOnce(abs(t.rules), GF_MARKER, genericRule("github-flow")); }
          done.push(`rules → ${t.rules}`);
        }
      }
    };
    try {
      if (wantU) apply(a.user, null, true);
      if (wantP) apply(a.project, scope.project, false);
      if (!a.user.mcp && !a.project.mcp && a.mcpNote) report.warn(`${a.label}: MCP not auto-registered`, a.mcpNote);
      report.pass(`${a.label}`, done.join("; ") + (a.note ? ` — ${a.note}` : ""));
    } catch (e) { report.fail(`${a.label}: install failed`, String(e.message).slice(0, 200)); }
  }
  if (wantP) report.info("project-level: AGENTS.md, .agents/skills and .mcp.json written for Codex/Claude are also read by opencode, kimi, pi, agy, gemini, copilot, goose, amp, droid, kilo, roo, qoder, crush, cursor, windsurf, zed, trae, junie and warp");
}
function doctorExtraAgents() {
  const detected = detectExtraAgents();
  for (const k of EXTRA_ORDER) {
    const a = EXTRA_AGENTS[k];
    const m = a.user.mcp && expandHome(a.user.mcp.file);
    const j = m && fs.existsSync(m) ? readJsonSafe(m) : undefined;
    const registered = j && !j.__error && (a.user.mcp.shape === "opencode" ? j.mcp?.[CLAUDE_SERVER] : j.mcpServers?.[CLAUDE_SERVER]);
    if (registered) {
      const args = a.user.mcp.shape === "opencode" ? registered.command : registered.args;
      const skill = a.user.skills && fs.existsSync(path.join(expandHome(a.user.skills), GW_SKILL, "SKILL.md"));
      (args ?? []).includes(ENTRY) ? report.pass(`${a.label}: MCP registered${skill ? " + skill" : ""}`, m) : report.warn(`${a.label}: MCP entry points to another build`, (args ?? []).join(" "), "re-run node setup.mjs");
      if (a.user.rules && !(fs.existsSync(expandHome(a.user.rules)) && fs.readFileSync(expandHome(a.user.rules), "utf8").includes(GW_MARKER))) report.warn(`${a.label}: standing rule missing`, a.user.rules, "re-run node setup.mjs");
    } else if (!a.user.mcp) {
      const skill = a.user.skills && fs.existsSync(path.join(expandHome(a.user.skills), GW_SKILL, "SKILL.md"));
      const rules = a.user.rules && fs.existsSync(expandHome(a.user.rules));
      if (skill || rules) report.pass(`${a.label}: ${skill ? "skill " : ""}${skill && rules ? "+ " : ""}${rules ? "rules" : ""} installed`, a.mcpNote ? `MCP: ${a.mcpNote}` : "");
      else if (detected[k]) report.skip(`${a.label}: detected but not wired`, `node setup.mjs and pick it under "Other coding agents"`);
    } else if (detected[k]) report.skip(`${a.label}: detected but not wired`, `node setup.mjs and pick it under "Other coding agents"`);
  }
}
function uninstallExtraAgents(projectDir) {
  const removed = [];
  for (const k of EXTRA_ORDER) {
    const a = EXTRA_AGENTS[k];
    const strip = (t, base, isUser) => {
      const abs = (p) => (isUser ? expandHome(p) : path.join(base, p));
      try {
        if (t.mcp && fs.existsSync(isUser ? expandHome(t.mcp.file) : path.join(base, t.mcp.file))) { upsertJsonMcp(isUser ? t.mcp.file : path.join(base, t.mcp.file), t.mcp.shape, true); removed.push(`${a.label} mcp`); }
        if (t.skills) for (const sk of [GW_SKILL, GF_SKILL]) if (fs.existsSync(path.join(abs(t.skills), sk))) { fs.rmSync(path.join(abs(t.skills), sk), { recursive: true, force: true }); removed.push(`${a.label} ${sk}`); }
        if (t.rules && fs.existsSync(abs(t.rules))) {
          if (t.rulesKind === "aider") { upsertAiderRead(abs(t.rules), true); removed.push(`${a.label} rules`); }
          else if (t.rulesOwned) { if (fs.readFileSync(abs(t.rules), "utf8").includes(GENERIC_MARKER_NOTE)) { fs.rmSync(abs(t.rules)); removed.push(`${a.label} rules`); } }
          else { stripBlock(abs(t.rules), GW_MARKER); stripBlock(abs(t.rules), GF_MARKER); removed.push(`${a.label} rules`); }
        }
      } catch (e) { report.warn(`${a.label}: could not fully remove`, String(e.message).slice(0, 160)); }
    };
    strip(a.user, null, true);
    if (projectDir) strip(a.project, projectDir, false);
  }
  if (removed.length) report.pass("removed from other agents", [...new Set(removed)].join(", "));
}

// ---- harness profiles: run Claude Code / Codex ON another model ---------------
// Providers that expose an Anthropic-compatible /v1/messages endpoint can drive Claude Code itself
// (so CLAUDE.md, skills, hooks and every MCP server are available to that model). Every OpenAI-compatible
// provider can drive Codex via a model_providers entry + profile.
const HARNESS_DIR = path.join(CFG_DIR, "harness");
const SERVE_PORT = Number(process.env.BREAK_FREE_SERVE_PORT) || 18790;
const SERVE_PID = path.join(CFG_DIR, "serve.pid");
const RC_MARKER = "# break-free harness profiles";
function anthropicBase(name, pc, cat) {
  const oa = (pc?.baseUrl ?? cat.baseUrl).replace(/\/+$/, "");
  // A custom base URL (proxy, LAN host, mock) wins: assume the Anthropic endpoint lives next to the OpenAI one.
  if (pc?.baseUrl && pc.baseUrl.replace(/\/+$/, "") !== cat.baseUrl.replace(/\/+$/, "") && !["zai"].includes(name)) return oa.replace(/\/v1$/, "");
  switch (name) {
    case "deepseek": return "https://api.deepseek.com/anthropic";
    case "kimi": return "https://api.moonshot.ai/anthropic";
    case "zai": return /coding/.test(oa) ? "https://api.z.ai/api/anthropic" : "https://api.z.ai/api/anthropic";
    case "minimax": return "https://api.minimax.io/anthropic";
    case "ollama": case "vllm": return oa.replace(/\/v1$/, "");
    case "ollama-cloud": return "https://ollama.com";
    case "openrouter": return "https://openrouter.ai/api";
    default: return oa.replace(/\/v1$/, "");
  }
}
async function probeAnthropic(base, key, model) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch(`${base}/v1/messages`, { method: "POST", signal: ctrl.signal, headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": key || "none", authorization: `Bearer ${key || "none"}` }, body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: "Reply with exactly: OK" }] }) });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} ${text.slice(0, 140)}` };
    let j; try { j = JSON.parse(text); } catch { return { ok: false, detail: "non-JSON reply" }; }
    const out = (j.content ?? []).map((c) => c.text ?? "").join("").trim();
    return { ok: true, detail: `replied "${out.slice(0, 20)}"` };
  } catch (e) { return { ok: false, detail: e.cause?.code ?? e.message }; }
  finally { clearTimeout(t); }
}
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;


// ---- Responses-API shim (Codex profiles) ---------------------------------------
async function shimHealthy() {
  try { const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/healthz`, { signal: AbortSignal.timeout(2000) }); return r.ok; } catch { return false; }
}
async function ensureShim() {
  if (await shimHealthy()) return true;
  fs.mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  const out = fs.openSync(path.join(CFG_DIR, "serve.log"), "a");
  const child = spawn(process.execPath, [ENTRY, "--serve", String(SERVE_PORT)], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, MODEL_GATEWAY_CONFIG: CFG_FILE } });
  child.unref();
  fs.writeFileSync(SERVE_PID, String(child.pid));
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 200)); if (await shimHealthy()) return true; }
  return false;
}
function stopShim() {
  if (!fs.existsSync(SERVE_PID)) return false;
  const pid = Number(fs.readFileSync(SERVE_PID, "utf8"));
  try { process.kill(pid); } catch { /* already gone */ }
  fs.rmSync(SERVE_PID, { force: true });
  return true;
}
async function checkShim(providers) {
  // A real Responses-API round-trip through the shim for the first usable provider, non-streaming.
  const name = providers[0];
  if (!name) return;
  try {
    const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/${name}/v1/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "Reply with exactly: OK", max_output_tokens: 16 }), signal: AbortSignal.timeout(90_000) });
    const j = await r.json();
    if (r.ok && j.object === "response") report.pass(`Codex shim: /${name}/v1/responses answered`, `"${(j.output?.find((o) => o.type === "message")?.content?.[0]?.text ?? "").trim().slice(0, 30)}" — Codex profiles (wire_api="responses") will work`);
    else report.warn(`Codex shim: /${name}/v1/responses failed`, String(j.error?.message ?? r.status).slice(0, 160));
  } catch (e) { report.warn("Codex shim: request failed", String(e.message).slice(0, 160)); }
}

async function installHarnessProfiles(cfg, gw) {
  report.section("Harness profiles (run Claude Code / Codex on another model)");
  const usable = PROVIDER_ORDER.filter((n) => usableProv(cfg.providers[n], gw.PROVIDER_CATALOG[n]));
  if (!usable.length) { report.skip("no usable providers"); return; }
  const want = await prompter.confirm("harness_profiles", [
    "Create launch profiles so you can run the WHOLE Claude Code / Codex harness on one of these models?",
    "    e.g. `break-free-claude-deepseek` starts Claude Code on DeepSeek with all your CLAUDE.md, skills, hooks and MCP servers;",
    "    `break-free-codex-deepseek` does the same for Codex (codex --profile break_free_deepseek).",
  ].join("\n"), true);
  if (!want) { report.skip("harness profiles", "not created"); return; }
  fs.mkdirSync(HARNESS_DIR, { recursive: true, mode: 0o700 });
  const fns = [`${RC_MARKER} — generated by setup.mjs; safe to delete. Usage: break-free-harness`];
  const table = [];
  let tomlBody = "";
  for (const name of usable) {
    const pc = cfg.providers[name]; const cat = gw.PROVIDER_CATALOG[name];
    const model = pc.defaultModel ?? cat.defaultModel;
    const keyEnv = pc.keyEnv ?? cat.keyEnv;
    const literal = pc.apiKey && !/^\$/.test(pc.apiKey) ? pc.apiKey : undefined;
    const keyExpr = literal ? shq(literal) : `"\${${keyEnv}:-${cat.requiresKey ? "" : "local"}}"`;
    const keyForProbe = literal ?? process.env[keyEnv] ?? (cat.requiresKey ? "" : "local");
    const abase = anthropicBase(name, pc, cat);
    report.info(`${name}: probing Anthropic-compatible endpoint ${abase}/v1/messages with ${model}…`);
    const probe = await probeAnthropic(abase, keyForProbe, model);
    const id = name.replace(/-/g, "_");
    // env file (0600): Claude Code vars + the provider's own key var (for Codex' env_key)
    const env = [
      `# break-free harness profile for ${name} — source with: set -a; . this-file; set +a`,
      `export ${keyEnv}=${keyExpr}`,
      ...(probe.ok ? [
        `export ANTHROPIC_BASE_URL=${shq(abase)}`,
        `export ANTHROPIC_AUTH_TOKEN=${keyExpr}`,
        `export ANTHROPIC_MODEL=${shq(model)}`,
        `export ANTHROPIC_DEFAULT_OPUS_MODEL=${shq(model)}`,
        `export ANTHROPIC_DEFAULT_SONNET_MODEL=${shq(model)}`,
        `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${shq(model)}`,
        `export ANTHROPIC_DEFAULT_FABLE_MODEL=${shq(model)}`,
        `export CLAUDE_CODE_SUBAGENT_MODEL=${shq(model)}`,
      ] : [`# Claude Code: ${name} did not answer /v1/messages (${probe.detail}) — no Anthropic-compatible endpoint, Codex profile only`]),
    ].join("\n") + "\n";
    writeSecret(path.join(HARNESS_DIR, `${name}.env`), env);
    if (probe.ok) fns.push(`break-free-claude-${name}() { ( set -a; . ${shq(path.join(HARNESS_DIR, `${name}.env`))}; set +a; command claude "$@" ); }`);
    fns.push(`break-free-codex-${name}() { break-free-serve >/dev/null || return 1; ( set -a; . ${shq(path.join(HARNESS_DIR, `${name}.env`))}; set +a; command codex --profile break_free_${id} "$@" ); }`);
    // Codex only speaks the Responses API (wire_api="chat" was removed in 2026); the gateway's local shim
    // translates it to chat/completions for every provider and holds the keys, so no env_key is needed.
    tomlBody += [
      `[model_providers.break_free_${id}]`,
      `name = ${tomlStr(`Break Free: ${cat.label} (via break-free shim)`)}`,
      `base_url = ${tomlStr(`http://127.0.0.1:${SERVE_PORT}/${name}/v1`)}`,
      `wire_api = "responses"`,
      `request_max_retries = 2`,
      `stream_max_retries = 2`,
      ``,
      `[profiles.break_free_${id}]`,
      `model = ${tomlStr(model)}`,
      `model_provider = ${tomlStr(`break_free_${id}`)}`,
      ``,
    ].join("\n");
    table.push({ name, model, claude: probe.ok, detail: probe.detail });
    if (probe.ok) report.pass(`${name}: Claude Code profile ready`, `${abase} → ${model} ${probe.detail}; run: break-free-claude-${name}`);
    else report.warn(`${name}: no Anthropic-compatible endpoint`, probe.detail, `Codex profile still created (break-free-codex-${name}); Claude Code cannot use this provider directly`);
  }
  fns.push(
    `break-free-serve() { if curl -sf --max-time 2 http://127.0.0.1:${SERVE_PORT}/healthz >/dev/null 2>&1; then echo "break-free shim already running on http://127.0.0.1:${SERVE_PORT}"; return 0; fi; mkdir -p ${shq(CFG_DIR)}; nohup ${shq(process.execPath)} ${shq(ENTRY)} --serve ${SERVE_PORT} >> ${shq(path.join(CFG_DIR, "serve.log"))} 2>&1 & echo $! > ${shq(SERVE_PID)}; for i in 1 2 3 4 5 6 7 8 9 10; do sleep 0.3; curl -sf --max-time 2 http://127.0.0.1:${SERVE_PORT}/healthz >/dev/null 2>&1 && { echo "break-free shim started on http://127.0.0.1:${SERVE_PORT} (pid $(cat ${shq(SERVE_PID)}))"; return 0; }; done; echo "break-free shim failed to start; see ${path.join(CFG_DIR, "serve.log")}" >&2; return 1; }`,
    `break-free-steward() { ${shq(process.execPath)} ${shq(ENTRY)} --workspace "\${1:-.}" --steward "\${@:2}"; }`,
    `break-free-serve-stop() { [ -f ${shq(SERVE_PID)} ] && kill "$(cat ${shq(SERVE_PID)})" 2>/dev/null && rm -f ${shq(SERVE_PID)} && echo "break-free shim stopped" || echo "break-free shim not running"; }`,
  );
  fns.push(`break-free-harness() { echo "Break Free harness profiles (model per provider):"; ${table.map((t) => `echo "  ${t.claude ? "break-free-claude-" + t.name + "  " : "                            "}break-free-codex-${t.name}   -> ${t.model}"`).join("; ")}; }`);
  fs.writeFileSync(path.join(HARNESS_DIR, "break-free.sh"), fns.join("\n") + "\n", { mode: 0o600 });
  report.pass("shell functions written", path.join(HARNESS_DIR, "break-free.sh"));

  if (targets.codex && (wantsUser("codex") || wantsProject("codex"))) {
    const tomlPath = path.join(home(), ".codex", "config.toml");
    let cur = fs.existsSync(tomlPath) ? fs.readFileSync(tomlPath, "utf8") : "";
    for (const t of table) { const id = t.name.replace(/-/g, "_"); cur = removeTomlTable(removeTomlTable(cur, `model_providers.break_free_${id}`), `profiles.break_free_${id}`); }
    fs.writeFileSync(tomlPath, cur.replace(/\n+$/, "\n") + "\n" + tomlBody);
    report.pass("Codex model_providers + profiles written", `wire_api="responses" via the local shim http://127.0.0.1:${SERVE_PORT}/<provider>/v1 — ` + table.map((t) => `--profile break_free_${t.name.replace(/-/g, "_")}`).join(", "));
    const stale = (cur.match(/^\s*wire_api\s*=\s*"chat"/gm) ?? []).length;
    if (stale) {
      if (await prompter.confirm("fix_stale_wire_api", `~/.codex/config.toml still has ${stale} other provider(s) with wire_api = "chat", which makes Codex refuse to start. Change them to "responses"?`, true)) {
        backup(tomlPath);
        fs.writeFileSync(tomlPath, fs.readFileSync(tomlPath, "utf8").replace(/^(\s*wire_api\s*=\s*)"chat"/gm, '$1"responses"'));
        report.pass(`rewrote ${stale} stale wire_api="chat" entr${stale === 1 ? "y" : "ies"} to "responses"`, "those providers must serve /v1/responses themselves (Ollama does; DeepSeek/Kimi/… do not — use the break_free_* profiles for them)");
      } else report.warn(`${stale} provider(s) in ~/.codex/config.toml still use wire_api = "chat"`, "Codex will refuse to start until they say \"responses\"", "https://github.com/openai/codex/discussions/7782");
    }
  }
  const srcLine = `[ -f ${shq(path.join(HARNESS_DIR, "break-free.sh"))} ] && . ${shq(path.join(HARNESS_DIR, "break-free.sh"))}  ${RC_MARKER}`;
  const rcs = [".zshrc", ".bashrc"].map((f) => path.join(home(), f)).filter((f) => fs.existsSync(f) || f.endsWith(".zshrc"));
  if (await prompter.confirm("harness_shell_rc", `Add the functions to your shell (${rcs.map((f) => path.basename(f)).join(", ")}) so they are available in every terminal?`, true)) {
    for (const rc of rcs) { const cur = fs.existsSync(rc) ? fs.readFileSync(rc, "utf8") : ""; if (!cur.includes(RC_MARKER)) fs.appendFileSync(rc, `\n${srcLine}\n`); }
    report.pass("shell rc updated", `open a new terminal, then: break-free-harness`);
  } else report.info(`to use: source ${path.join(HARNESS_DIR, "break-free.sh")}`);
  state.harness = table;
}

// ---- github-flow (optional) -------------------------------------------------
// Append a standing rule once; if an older version of the same rule (same marker heading) is present, replace it.
function appendOnce(file, marker, text) {
  let cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (cur.includes(marker)) {
    if (cur.includes(text.trim())) return false;
    stripBlock(file, marker);
    cur = fs.readFileSync(file, "utf8");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + text);
  return true;
}
function stripBlock(file, marker) {
  if (!fs.existsSync(file)) return;
  const cur = fs.readFileSync(file, "utf8");
  const i = cur.indexOf(marker);
  if (i < 0) return;
  // remove from the "## Work tracking" heading through the end of that paragraph
  const start = cur.lastIndexOf("\n## ", i);
  const end = cur.indexOf("\n\n", i);
  fs.writeFileSync(file, (cur.slice(0, start < 0 ? i : start) + (end < 0 ? "" : cur.slice(end))).replace(/\n{3,}/g, "\n\n"));
}
const GF_MARKER = "## Work tracking (break-free-github-flow)";
const GW_MARKER = "## Delegating to other models (break-free-model-gateway)";
const LEGACY_GF_MARKER = "## Work tracking (github-flow)";

async function installGithubFlow() {
  report.section("GitHub work tracking (optional)");
  if (scope.claude === "none" && scope.codex === "none") { report.skip("github-flow", "no agent selected"); return; }
  const choice = await prompter.choose("github_flow", [
    "Install the github-flow skill? It makes the agent track every task in a GitHub issue (problem, plan, test & success criteria),",
    "    keep it updated, close it out with real verification results, and watch CI/deployments after every push — troubleshooting to root cause on failure.",
    state.ghAuthed ? "" : "    (gh is not authenticated on this machine — the skill will be installed but stays inert until `gh auth login`)",
  ].filter(Boolean).join("\n"), [
    { key: "full", label: "yes — skill + /break-free-issue /break-free-ci /break-free-wrap-up commands + a standing rule in CLAUDE.md / AGENTS.md so it is always applied" },
    { key: "skill", label: "skill + commands only (applied when the task looks like engineering work; no standing rule)" },
    { key: "none", label: "no, skip" },
  ], state.ghAuthed ? "full" : "skill");
  state.githubFlow = choice;
  if (choice === "none") { report.skip("github-flow", "not installed"); return; }
  const rule = fs.readFileSync(path.join(AGENT_CFG, "claude", "CLAUDE.md.snippet"), "utf8");
  const ruleCodex = fs.readFileSync(path.join(AGENT_CFG, "codex", "AGENTS.github-flow.snippet"), "utf8");
  const targetsList = [];
  if (targets.claude && wantsUser("claude")) targetsList.push({ tool: "claude", root: path.join(home(), ".claude"), rules: path.join(home(), ".claude", "CLAUDE.md") });
  if (targets.codex && wantsUser("codex")) targetsList.push({ tool: "codex", root: path.join(home(), ".agents"), rules: path.join(home(), ".codex", "AGENTS.md") });
  if (targets.claude && wantsProject("claude")) targetsList.push({ tool: "claude", root: path.join(scope.project, ".claude"), rules: path.join(scope.project, "CLAUDE.md") });
  if (targets.codex && wantsProject("codex")) targetsList.push({ tool: "codex", root: path.join(scope.project, ".agents"), rules: path.join(scope.project, "AGENTS.md") });
  for (const t of targetsList) {
    copyDir(path.join(AGENT_CFG, t.tool, "skills", GF_SKILL), path.join(t.root, "skills", GF_SKILL));
    let what = `skill → ${path.join(t.root, "skills", GF_SKILL)}`;
    if (t.tool === "claude") {
      fs.mkdirSync(path.join(t.root, "commands"), { recursive: true });
      for (const f of GF_COMMANDS) fs.copyFileSync(path.join(AGENT_CFG, "claude", "commands", f), path.join(t.root, "commands", f));
      what += " + /break-free-issue /break-free-ci /break-free-wrap-up";
    }
    if (choice === "full") {
      const added = appendOnce(t.rules, GF_MARKER, t.tool === "claude" ? rule : ruleCodex);
      what += added ? ` + rule in ${t.rules}` : ` (rule already in ${path.basename(t.rules)})`;
    }
    report.pass(`github-flow (${t.tool}${t.root.startsWith(home()) ? ", user" : ", project"})`, what);
  }
  if (!state.ghAuthed) report.warn("github-flow installed but gh is not authenticated", "", "gh auth login  (or export GH_TOKEN) — the skill checks this and stays quiet until then");
  report.info("recommended token scope: fine-grained PAT with Contents RW, Issues RW, Pull requests RW, Actions RW, Workflows RW, Metadata R");
}

// ---- verification ---------------------------------------------------------
async function verify() {
  report.section("Postflight (real MCP handshake + live provider calls)");
  if (!fs.existsSync(ENTRY)) { report.fail("dist/index.js missing", "", "build failed earlier"); return; }
  const st = await run(process.execPath, [ENTRY, "--selftest"], { env: { MODEL_GATEWAY_CONFIG: CFG_FILE }, timeoutMs: 30_000 });
  let self;
  try { self = JSON.parse(st.stdout); } catch { report.fail("--selftest produced no JSON", lastLines(st.stderr || st.stdout)); return; }
  if (self.usable_providers?.length) report.pass("usable providers", self.usable_providers.join(", "));
  else report.fail("no usable providers", "every provider is missing a key or disabled", "re-run setup and add a key");
  for (const p of self.providers ?? []) if (!p.usable && state.providersConfigured.includes(p.provider)) report.warn(`${p.provider} configured but unusable`, p.reason);

  let Client, StdioClientTransport;
  try {
    ({ Client } = await import(pathToFileURL(path.join(GW, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js")).href));
    ({ StdioClientTransport } = await import(pathToFileURL(path.join(GW, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "stdio.js")).href));
  } catch (e) { report.warn("MCP SDK client not importable; skipping handshake", e.message); return; }
  const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, "--stateless"], env: { ...process.env, MODEL_GATEWAY_CONFIG: CFG_FILE }, stderr: "pipe" });
  const client = new Client({ name: "setup", version: "0" });
  const t0 = Date.now();
  try {
    await withTimeout(client.connect(transport), 20_000, "MCP initialize");
    const { tools } = await withTimeout(client.listTools(), 10_000, "tools/list");
    const names = tools.map((t) => t.name);
    const expected = ["delegate", "review", "panel", "supervise", "run_plan", "job_status", "list_mcp_servers", "ledger_resume", "task_create", "note_write", "code_map", "list_providers", "configure_provider"];
    const missing = expected.filter((n) => !names.includes(n));
    missing.length ? report.fail("tool list incomplete", `missing ${missing.join(", ")}`) : report.pass(`MCP handshake ok in ${Date.now() - t0} ms`, `${names.length} tools`);
    // v3 features must actually work through MCP, not just be listed
    try {
      const r = await withTimeout(client.callTool({ name: "list_mcp_servers", arguments: {} }), 15_000, "list_mcp_servers");
      const j = JSON.parse(r.content.map((c) => c.text).join(""));
      report.pass(`MCP bridge: ${j.servers.length} other server(s) discovered for workers`, j.servers.map((x) => `${x.name} (${x.source})`).join(", ") || "none yet — add servers to Claude/Codex or config.workers.mcp.servers");
    } catch (e) { report.warn("MCP bridge discovery failed", String(e.message).slice(0, 200)); }
    try {
      const r = await withTimeout(client.callTool({ name: "run_plan", arguments: { track: false, tasks: [{ id: "x", task: "x", depends_on: ["y"] }, { id: "y", task: "y", depends_on: ["x"] }] } }), 15_000, "run_plan validation");
      /cycle/.test(r.content.map((c) => c.text).join("")) ? report.pass("run_plan validates dependency graphs") : report.warn("run_plan did not reject a dependency cycle");
    } catch (e) { report.warn("run_plan check failed", String(e.message).slice(0, 200)); }
    report.info(`runtime log: ${path.join(CFG_DIR, "gateway.log")} — every delegation, fallback and worker tool call lands there; \`node setup.mjs --doctor\` summarises it`);
    for (const name of state.providersConfigured) {
      const local = ["ollama", "vllm"].includes(name);
      if (local && state.providersVerified.length && !state.providersVerified.includes(name)) { report.warn(`through MCP: ${name} skipped`, "its direct probe did not answer earlier", "fix that first, then `node setup.mjs --doctor`"); continue; }
      try {
        const r = await withTimeout(client.callTool({ name: "test_provider", arguments: { spec: name, with_tools: !local } }), local ? 300_000 : 90_000, `test_provider ${name}`);
        const text = r.content?.map((c) => c.text).join("") ?? "";
        let j; try { j = JSON.parse(text); } catch { /* error text */ }
        const row = j?.results?.[0];
        if (row?.ok) report.pass(`through MCP: ${row.spec}`, `${row.ms} ms${row.tool_calling ? `; tool-calling: ${row.tool_calling}` : ""}`);
        else report.warn(`through MCP: ${name} failed`, (row?.error ?? text).slice(0, 160));
      } catch (e) {
        report.warn(`through MCP: ${name} failed`, String(e.message).slice(0, 160), local ? "model took too long to load; run `node setup.mjs --doctor` once the host has it in memory" : "");
      }
    }

  } catch (e) {
    report.fail("MCP handshake failed", String(e.message).slice(0, 200), "run `node model-gateway/dist/index.js` manually and look at stderr");
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
  if (state.harness?.length) {
    report.section("Codex shim (Responses API)");
    if (await ensureShim()) {
      report.pass(`shim running on http://127.0.0.1:${SERVE_PORT}`, `pid file ${SERVE_PID}; it is started on demand by break-free-codex-<provider> and can be started manually with break-free-serve`);
      await checkShim(state.harness.map((t) => t.name).filter((n) => !["ollama", "vllm"].includes(n) || state.providersVerified.includes(n)));
    } else report.warn("Codex shim did not start", `see ${path.join(CFG_DIR, "serve.log")}`, `run: node ${ENTRY} --serve ${SERVE_PORT}`);
  }
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms))]);

// ---- doctor ---------------------------------------------------------------
async function doctor() {
  await preflight();
  report.section("Installed state");
  fs.existsSync(ENTRY) ? report.pass("gateway built", ENTRY) : report.fail("gateway not built", "", "node setup.mjs");
  const cfg = readJsonSafe(CFG_FILE);
  if (!cfg) report.fail("config missing", CFG_FILE, "node setup.mjs");
  else if (cfg.__error) report.fail("config invalid JSON", cfg.__error);
  else {
    report.pass("config present", `${Object.keys(cfg.providers ?? {}).length} provider(s) configured`);
    if (process.platform !== "win32" && (fs.statSync(CFG_FILE).mode & 0o777) !== 0o600) report.warn("config permissions are not 0600", "", `chmod 600 ${CFG_FILE}`);
    for (const [n, p] of Object.entries(cfg.providers ?? {})) {
      const m = String(p.apiKey ?? "").match(/^\$\{?([A-Z0-9_]+)\}?$/i);
      if (m && !process.env[m[1]]) report.warn(`${n}: apiKey references ${m[1]} which is not set in this shell`, "", `export ${m[1]}=…`);
    }
  }
  if (targets.claude) {
    const skill = path.join(home(), ".claude", "skills", GW_SKILL, "SKILL.md");
    fs.existsSync(skill) ? (sameContent(skill, path.join(AGENT_CFG, "claude", "skills", GW_SKILL, "SKILL.md")) ? report.pass("Claude skill installed (current)") : report.warn("Claude skill installed but outdated", "", "node setup.mjs to refresh")) : report.fail("Claude skill not installed", "", "node setup.mjs");
    const get = await run("claude", ["mcp", "get", CLAUDE_SERVER], { timeoutMs: 30_000 });
    get.ok && get.stdout.includes(ENTRY) ? report.pass("Claude MCP registration") : report.fail("Claude MCP registration missing or points elsewhere", lastLines(get.stdout || get.stderr), "node setup.mjs");
  }
  {
    const c = fs.existsSync(path.join(home(), ".claude", "skills", GF_SKILL, "SKILL.md"));
    const x = fs.existsSync(path.join(home(), ".agents", "skills", GF_SKILL, "SKILL.md"));
    const ruleC = fs.existsSync(path.join(home(), ".claude", "CLAUDE.md")) && fs.readFileSync(path.join(home(), ".claude", "CLAUDE.md"), "utf8").includes(GF_MARKER);
    const ruleX = fs.existsSync(path.join(home(), ".codex", "AGENTS.md")) && fs.readFileSync(path.join(home(), ".codex", "AGENTS.md"), "utf8").includes(GF_MARKER);
    if (c || x) {
      report.pass("break-free-github-flow skill installed", `${c ? "claude" : ""}${c && x ? " + " : ""}${x ? "codex" : ""}${ruleC || ruleX ? "; standing rule present" : "; no standing rule (skill-triggered only)"}`);
      if (!state.ghAuthed) report.warn("github-flow needs gh auth", "issues/PR/CI tracking is inert", "gh auth login");
    } else report.skip("break-free-github-flow skill not installed", "optional; node setup.mjs to add it");
  }
  if (targets.codex) {
    const skill = path.join(home(), ".agents", "skills", GW_SKILL, "SKILL.md");
    fs.existsSync(skill) ? report.pass("Codex skill installed") : report.fail("Codex skill not installed", "", "node setup.mjs");
    const toml = path.join(home(), ".codex", "config.toml");
    const txt = fs.existsSync(toml) ? fs.readFileSync(toml, "utf8") : "";
    txt.includes(`[mcp_servers.${CODEX_SERVER}]`) && txt.includes(ENTRY) ? report.pass("Codex MCP table present") : report.fail(`Codex config.toml has no ${CODEX_SERVER} table (or wrong path)`, "", "node setup.mjs");
    if (txt.includes(`[mcp_servers.${CODEX_SERVER}]`) && !/tool_timeout_sec\s*=\s*\d{3,}/.test(txt)) report.warn("tool_timeout_sec is low", "long supervise runs will be killed", "set tool_timeout_sec = 900 in the model_gateway table");
  }
  if (projectDir) {
    report.section(`Project level: ${projectDir}`);
    const mcp = readJsonSafe(path.join(projectDir, ".mcp.json"));
    if (mcp?.mcpServers?.[CLAUDE_SERVER]) (mcp.mcpServers[CLAUDE_SERVER].args ?? []).includes(ENTRY) ? report.pass("Claude .mcp.json present") : report.warn("Claude .mcp.json points to a different gateway build", mcp.mcpServers[CLAUDE_SERVER].args?.join(" "), "node setup.mjs --project " + projectDir);
    else report.warn("no Claude project registration (.mcp.json)", "", "node setup.mjs --project " + projectDir + " and choose project scope");
    fs.existsSync(path.join(projectDir, ".claude", "skills", GW_SKILL, "SKILL.md")) ? report.pass("Claude project skill present") : report.skip("Claude project skill not present");
    const ptoml = path.join(projectDir, ".codex", "config.toml");
    fs.existsSync(ptoml) && fs.readFileSync(ptoml, "utf8").includes(`[mcp_servers.${CODEX_SERVER}]`) ? report.pass("Codex project config present") : report.skip("Codex project config not present");
    fs.existsSync(path.join(projectDir, ".agents", "skills", GW_SKILL, "SKILL.md")) ? report.pass("Codex project skill present") : report.skip("Codex project skill not present");
  }
  doctorExtraAgents();
  if (fs.existsSync(HARNESS_DIR)) {
    const envs = fs.readdirSync(HARNESS_DIR).filter((f) => f.endsWith(".env")).map((f) => f.replace(/\.env$/, ""));
    const claudeReady = envs.filter((n) => /ANTHROPIC_BASE_URL/.test(fs.readFileSync(path.join(HARNESS_DIR, `${n}.env`), "utf8")));
    report.pass("harness profiles", `claude: ${claudeReady.join(", ") || "none"}; codex: ${envs.join(", ")}`);
    const rc = path.join(home(), ".zshrc");
    if (!(fs.existsSync(rc) && fs.readFileSync(rc, "utf8").includes(RC_MARKER))) report.warn("harness functions not in ~/.zshrc", "", `source ${path.join(HARNESS_DIR, "break-free.sh")} or re-run setup`);
    const toml = path.join(home(), ".codex", "config.toml");
    if (fs.existsSync(toml)) {
      const t = fs.readFileSync(toml, "utf8");
      const chat = (t.match(/^\s*wire_api\s*=\s*"chat"/gm) ?? []).length;
      if (chat) report.fail(`~/.codex/config.toml has ${chat} provider(s) with wire_api = "chat"`, "Codex refuses to start with this", `sed -i '' 's/wire_api = "chat"/wire_api = "responses"/g' ~/.codex/config.toml  (or re-run node setup.mjs)`);
      else if (/break_free_/.test(t) && !new RegExp(`127\\.0\\.0\\.1:${SERVE_PORT}/`).test(t)) report.warn("Codex break_free_* profiles predate the Responses shim", "", "re-run node setup.mjs --yes to rewrite them");
    }
    if (await shimHealthy()) report.pass(`Codex shim running on http://127.0.0.1:${SERVE_PORT}`);
    else report.warn("Codex shim not running", "break-free-codex-<provider> starts it automatically", "or start it now: break-free-serve");
    {
      const c = readJsonSafe(CFG_FILE) ?? {};
      const b = c.budget ?? {};
      const caps = ["perTaskUsd", "perPlanUsd", "perDayUsd"].filter((k) => b[k] > 0).map((k) => `${k}=$${b[k]}`);
      caps.length ? report.pass("budget caps", caps.join(", ")) : report.warn("no budget caps set", "parallel crews can spend freely", "in any harness: configure_budget {per_day_usd: 20}");
      const rules = (c.policy?.rules ?? []).length;
      report.info(`policy rules in user config: ${rules} (project repos may add their own in .model-gateway.json); worker notes are quarantined until promoted with note_review`);
    }
  } else report.skip("harness profiles not created", "optional; node setup.mjs to add");
  if (fs.existsSync(ENTRY) && cfg && !cfg.__error) await checkModelDrift(cfg);
  if (fs.existsSync(ENTRY)) await analyzeRuntimeLog(cfg);
  if (fs.existsSync(ENTRY)) {
    state.providersConfigured = Object.keys(cfg?.providers ?? {}).filter((n) => cfg.providers[n].enabled !== false && (cfg.providers[n].apiKey || cfg.providers[n].enabled));
    await verify();
  }
}

/** Models get renamed and retired: compare every alias/default against each provider's live list. */
async function checkModelDrift(cfg) {
  report.section("Model catalog drift (live provider lists vs your config)");
  let gw;
  try { gw = await loadGatewayModules(); } catch (e) { report.warn("cannot load gateway modules", e.message); return; }
  const loaded = gw.loadConfig({ configPath: CFG_FILE });
  const conf = loaded.config;
  const live = {};
  for (const name of Object.keys(conf.providers)) {
    const p = gw.resolveProvider(conf, name);
    if (!p || p.unusableReason) continue;
    try { live[name] = await gw.listRemoteModels(p, 15_000); } catch (e) { report.warn(`${name}: could not list models`, String(e.message).slice(0, 120)); }
  }
  state.modelLists = live;
  const checked = Object.keys(live);
  if (!checked.length) { report.skip("no provider answered /models"); return; }
  report.pass("live lists fetched", checked.map((n) => `${n} (${live[n].length})`).join(", "));
  const refs = [];
  for (const [n, p] of Object.entries(conf.providers)) if (p.defaultModel) refs.push({ where: `providers.${n}.defaultModel`, spec: `${n}/${p.defaultModel}` });
  for (const [a, v] of Object.entries(conf.aliases)) for (const c of (Array.isArray(v) ? v : v.candidates)) refs.push({ where: `alias ${a}`, spec: c });
  for (const c of conf.fallback.chain) refs.push({ where: "fallback.chain", spec: c });
  let drift = 0;
  for (const r of refs) {
    const [prov, ...rest] = r.spec.split("/");
    const model = rest.join("/");
    if (!model || !live[prov]) continue;
    if (!live[prov].includes(model)) {
      drift++;
      const close = live[prov].filter((m) => m.toLowerCase().includes(model.split(/[-:]/)[0].toLowerCase())).slice(0, 3);
      report.warn(`${r.where}: ${r.spec} is not served any more`, close.length ? `closest: ${close.join(", ")}` : "", "run `node setup.mjs` and accept the new suggestions, or configure_alias / configure_provider from the agent");
    }
  }
  if (!drift) report.pass("every configured model still exists on its provider");
}

/** Read the gateway's own runtime log (via `--logs`) and turn patterns into PASS/WARN lines. */
async function analyzeRuntimeLog(cfg) {
  report.section("Runtime log (what actually happened in past sessions)");
  const n = Number(val("--last")) || 500;
  const r = await run(process.execPath, [ENTRY, "--logs", String(n)], { env: { MODEL_GATEWAY_CONFIG: CFG_FILE }, timeoutMs: 30_000 });
  let a;
  try { a = JSON.parse(r.stdout); } catch { report.warn("could not read runtime log", lastLines(r.stderr || r.stdout)); return; }
  if (!a.enabled) { report.skip("runtime logging disabled", "config.logFile=false"); return; }
  const file = a.file;
  if (!fs.existsSync(file)) { report.pass("no runtime log yet", `${file} will be created on first use`); return; }
  const size = fs.statSync(file).size;
  if (process.platform !== "win32" && (fs.statSync(file).mode & 0o777) !== 0o600) report.warn("log file permissions are not 0600", file, `chmod 600 ${file}`);
  if (!a.window?.events) { report.pass("log present but empty", file); return; }
  report.pass("log", `${file} (${(size / 1024).toFixed(0)} KB); analysed last ${a.window.events} events, ${a.window.from?.slice(0, 16)} → ${a.window.to?.slice(0, 16)}`);
  const provs = Object.entries(a.providers ?? {});
  if (!provs.length) report.pass("no provider calls recorded yet");
  for (const [p, st] of provs) {
    const total = st.ok + st.fail;
    const reasons = Object.entries(st.reasons).map(([k, v]) => `${k}×${v}`).join(", ");
    if (st.fail === 0) report.pass(`${p}: ${st.ok}/${total} ok`, `avg ${st.avgMs} ms`);
    else if (st.ok === 0) report.warn(`${p}: 0/${total} ok`, `${reasons}; last: ${st.lastError}`, fixForReason(p, st, cfg));
    else report[st.fail / total > 0.3 ? "warn" : "pass"](`${p}: ${st.ok}/${total} ok`, `${reasons}; avg ${st.avgMs} ms`, st.fail / total > 0.3 ? fixForReason(p, st, cfg) : "");
  }
  for (const [t, st] of Object.entries(a.tools ?? {})) if (st.fail) report[st.fail > st.ok ? "warn" : "pass"](`tool ${t}: ${st.ok} ok / ${st.fail} failed`, st.lastError ?? "", st.fail > st.ok ? "look at the error text; run `gateway_logs` with raw:true from the agent for details" : "");
  for (const f of a.findings ?? []) report.info("pattern: " + f);
  report.info(`inspect: node model-gateway/dist/index.js --logs 200 | jq  ·  or ask the agent to run gateway_logs`);
}
function fixForReason(p, st, cfg) {
  const top = Object.entries(st.reasons).sort((x, y) => y[1] - x[1])[0]?.[0];
  const keyEnv = { deepseek: "DEEPSEEK_API_KEY", kimi: "MOONSHOT_API_KEY", minimax: "MINIMAX_API_KEY", zai: "ZAI_API_KEY", openrouter: "OPENROUTER_API_KEY", opencode: "OPENCODE_API_KEY", "ollama-cloud": "OLLAMA_API_KEY" }[p];
  switch (top) {
    case "auth": return `key rejected — regenerate and re-run setup (or configure_provider provider=${p} api_key=…)${cfg?.providers?.[p]?.apiKey?.startsWith("$") ? `; note it references ${keyEnv} which must be exported where Claude Code/Codex launch` : ""}`;
    case "no_key": return `no key configured for ${p} but it is in a fallback chain — add a key or remove it from aliases`;
    case "rate_limit": return `rate-limited — add credit or move ${p} later in the chain`;
    case "timeout": return `timeouts — raise providers.${p}.timeoutMs or use a faster model`;
    case "network": return `unreachable — check base URL, proxy, VPN, or whether the local server (Ollama/vLLM) is running`;
    case "not_found": return `model not found — set providers.${p}.defaultModel to one the account has (list_models provider=${p})`;
    default: return "see the error text";
  }
}

// ---- uninstall ------------------------------------------------------------
async function uninstall() {
  report.section("Uninstall");
  if (targets.claude) {
    await run("claude", ["mcp", "remove", "--scope", "user", LEGACY_CLAUDE_SERVER], { timeoutMs: 30_000 });
    const r = await run("claude", ["mcp", "remove", "--scope", "user", CLAUDE_SERVER], { timeoutMs: 30_000 });
    report[r.ok ? "pass" : "warn"]("claude mcp remove", lastLines(r.stdout || r.stderr));
    for (const sk of [GW_SKILL, GF_SKILL, ...LEGACY_SKILLS]) fs.rmSync(path.join(home(), ".claude", "skills", sk), { recursive: true, force: true });
    for (const f of fs.readdirSync(path.join(AGENT_CFG, "claude", "commands"))) {
      const dst = path.join(home(), ".claude", "commands", f);
      if (fs.existsSync(dst) && /break-free|model-gateway|github-flow/.test(fs.readFileSync(dst, "utf8"))) fs.rmSync(dst);
    }
    stripBlock(path.join(home(), ".claude", "CLAUDE.md"), GF_MARKER);
    stripBlock(path.join(home(), ".claude", "CLAUDE.md"), GW_MARKER);
    report.pass("removed Claude skills (model-gateway, github-flow) + commands + CLAUDE.md rule");
  }
  if (targets.codex) {
    const toml = path.join(home(), ".codex", "config.toml");
    if (fs.existsSync(toml)) { backup(toml); fs.writeFileSync(toml, removeTomlTable(removeTomlTable(fs.readFileSync(toml, "utf8"), `mcp_servers.${CODEX_SERVER}`), `mcp_servers.${LEGACY_CODEX_SERVER}`)); report.pass(`removed ${CODEX_SERVER} table from ~/.codex/config.toml`); }
    for (const sk of [GW_SKILL, GF_SKILL, ...LEGACY_SKILLS]) fs.rmSync(path.join(home(), ".agents", "skills", sk), { recursive: true, force: true });
    stripBlock(path.join(home(), ".codex", "AGENTS.md"), GF_MARKER);
    stripBlock(path.join(home(), ".codex", "AGENTS.md"), GW_MARKER);
    report.pass("removed Codex skills + AGENTS.md rules");
  }
  if (projectDir && fs.existsSync(projectDir)) {
    const mcpJsonPath = path.join(projectDir, ".mcp.json");
    const mcp = readJsonSafe(mcpJsonPath);
    if (mcp?.mcpServers?.[CLAUDE_SERVER]) { delete mcp.mcpServers[CLAUDE_SERVER]; fs.writeFileSync(mcpJsonPath, JSON.stringify(mcp, null, 2) + "\n"); }
    for (const sk of [GW_SKILL, GF_SKILL, ...LEGACY_SKILLS]) { fs.rmSync(path.join(projectDir, ".claude", "skills", sk), { recursive: true, force: true }); fs.rmSync(path.join(projectDir, ".agents", "skills", sk), { recursive: true, force: true }); }
    for (const f of fs.readdirSync(path.join(AGENT_CFG, "claude", "commands"))) { const dst = path.join(projectDir, ".claude", "commands", f); if (fs.existsSync(dst) && /break-free|model-gateway/.test(fs.readFileSync(dst, "utf8"))) fs.rmSync(dst); }
    fs.rmSync(path.join(projectDir, ".agents", "skills", GW_SKILL), { recursive: true, force: true });
    fs.rmSync(path.join(projectDir, ".claude", "skills", GF_SKILL), { recursive: true, force: true });
    fs.rmSync(path.join(projectDir, ".agents", "skills", GF_SKILL), { recursive: true, force: true });
    stripBlock(path.join(projectDir, "CLAUDE.md"), GF_MARKER);
    stripBlock(path.join(projectDir, "CLAUDE.md"), GW_MARKER);
    stripBlock(path.join(projectDir, "AGENTS.md"), GF_MARKER);
    stripBlock(path.join(projectDir, "AGENTS.md"), GW_MARKER);
    const ptoml = path.join(projectDir, ".codex", "config.toml");
    if (fs.existsSync(ptoml)) fs.writeFileSync(ptoml, removeTomlTable(fs.readFileSync(ptoml, "utf8"), `mcp_servers.${CODEX_SERVER}`));
    report.pass("removed project-level files", projectDir);
  }
  uninstallExtraAgents(projectDir);
  {
    const rcLine = new RegExp(`\\n[^\\n]*${RC_MARKER.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[^\\n]*`, "g");
    for (const rc of [".zshrc", ".bashrc"].map((f) => path.join(home(), f))) if (fs.existsSync(rc)) { const cur = fs.readFileSync(rc, "utf8"); if (cur.includes(RC_MARKER)) fs.writeFileSync(rc, cur.replace(rcLine, "")); }
    const toml = path.join(home(), ".codex", "config.toml");
    if (fs.existsSync(toml)) { let cur = fs.readFileSync(toml, "utf8"); for (const n of PROVIDER_ORDER) { const id = n.replace(/-/g, "_"); cur = removeTomlTable(removeTomlTable(cur, `model_providers.break_free_${id}`), `profiles.break_free_${id}`); } fs.writeFileSync(toml, cur); }
    fs.rmSync(HARNESS_DIR, { recursive: true, force: true });
    if (stopShim()) report.pass("stopped the Codex shim");
    report.pass("removed harness profiles (env files, shell functions, Codex providers/profiles)");
  }
  if (has("--purge")) { fs.rmSync(CFG_DIR, { recursive: true, force: true }); report.pass("purged config, keys and sessions", CFG_DIR); }
  else report.info(`config and keys kept in ${CFG_DIR} (add --purge to delete)`);
}

// ---- update ---------------------------------------------------------------
/** Record the choices that let a later `--update` re-run hands-free without re-prompting. */
function writeInstallState() {
  const s = {
    source_dir: HERE,
    claude_scope: scope.claude,
    codex_scope: scope.codex,
    project_dir: scope.project,
    github_flow: state.githubFlow ?? "none",
    extra_agents: state.extraAgents ?? [],
    extra_scope: state.extraScope ?? "none",
    saved_at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(INSTALL_STATE, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
    report.info(`install state recorded → ${INSTALL_STATE} (used by --update)`);
  } catch (e) { report.warn("could not record install state", String(e.message)); }
}

/** Pull the latest source and re-run the installer in a fresh process (so the *new* code does the re-install). */
async function update() {
  report.section("Update");
  if (fs.existsSync(path.join(HERE, ".git"))) {
    const r = await run("git", ["pull", "--ff-only"], { cwd: HERE, timeoutMs: 180_000 });
    if (r.ok) report.pass("pulled latest source", lastLines(r.stdout) || "up to date");
    else report.warn("git pull failed", lastLines(r.stderr || r.stdout), "uncommitted changes or no upstream — continuing with the current files");
  } else {
    report.warn("not a git checkout", HERE, "self-update needs a `git clone`; re-clone from https://github.com/maruthiprithivi/break-free.git");
  }
  const args = [path.join(HERE, "setup.mjs"), "--yes"];
  if (fs.existsSync(INSTALL_STATE)) args.push("--answers", INSTALL_STATE);
  report.info(`re-running the installer with the new code: node setup.mjs --yes${fs.existsSync(INSTALL_STATE) ? " --answers " + path.basename(INSTALL_STATE) : ""}`);
  const code = await new Promise((res, rej) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env: process.env });
    child.on("error", rej);
    child.on("exit", (c) => res(c ?? 1));
  });
  return code;
}

// ================================================================== main
function finish() {
  prompter.close();
  const ok = report.summary(MODE === "doctor" ? undefined : REPORT_FILE);
  const warns = report.items.filter((i) => i.status === "WARN").length;
  console.log("");
  if (MODE === "uninstall") console.log(ok ? color.green(color.bold("  ●  Uninstall complete.")) : color.red(color.bold("  ●  Uninstall hit errors — see FAIL items above.")));
  else if (ok && !warns) console.log(color.green(color.bold("  ●  GREEN — everything checks out. Good to go.")));
  else if (ok) console.log(color.yellow(color.bold(`  ●  GREEN with ${warns} warning(s) — usable, but read the notes above.`)));
  else console.log(color.red(color.bold("  ●  RED — fix the FAIL items above, then run: node setup.mjs --doctor")));
  if (MODE === "install" && ok) {
    console.log(color.bold("\nNext steps"));
    console.log(`  1. Restart Claude Code / Codex so they pick up the new MCP server.`);
    console.log(`  2. In Claude Code: type ${color.cyan("/break-free-model-gateway")} or say "list providers". In Codex: ${color.cyan("$break-free-model-gateway")}.`);
    console.log(`  3. Try: ${color.cyan("/break-free-delegate fast explain what this repo does")}  — the meta line shows which model answered.`);
    console.log(`  4. Real work: ${color.cyan("/break-free-plan <goal>")} splits the goal, runs workers in parallel with verify + review gates, and tracks it in .break-free/ (commit that folder; it opens in Obsidian). ${color.cyan("/break-free-resume")} picks up where any session left off.`);
    console.log(`  5. Anytime: ${color.cyan("node setup.mjs --doctor")} to re-check everything.`);
  }
  process.exit(ok ? 0 : 1);
}

(async () => {
  console.log(color.bold(`model-gateway ${MODE}`) + color.dim(`  (${HERE})`));
  if (MODE === "doctor") { await doctor(); return finish(); }
  if (MODE === "uninstall") { await preflight(); await uninstall(); return finish(); }
  if (MODE === "update") { process.exit(await update()); }
  await preflight();
  if (report.items.some((i) => i.status === "FAIL")) {
    if (!(await prompter.confirm("continue_after_preflight_fail", "Preflight has failures. Continue anyway?", false))) return finish();
  }
  await chooseScope();
  if (scope.claude === "none" && scope.codex === "none") report.warn("nothing selected for Claude Code or Codex", "only the gateway itself will be built and configured");
  await removeLegacyNames();
  const built = await build();
  if (!built) return finish();
  await configureProviders();
  { const gw = await loadGatewayModules(); const cfgNow = readJsonSafe(CFG_FILE); if (cfgNow && !cfgNow.__error) await installHarnessProfiles(cfgNow, gw); }
  await installClaude();
  await installCodex();
  await installProject();
  await installGithubFlow();
  await installExtraAgents();
  await verify();
  writeInstallState();
  finish();
})().catch((e) => { report.fail("unexpected error", String(e.stack ?? e)); finish(); });

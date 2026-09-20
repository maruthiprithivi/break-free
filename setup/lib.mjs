// Shared helpers for setup.mjs: reporting, prompts, process execution, file ops.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

export const execFileP = promisify(execFile);

// ------------------------------------------------------------------ reporting
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  green: (s) => c(32, s), yellow: (s) => c(33, s), red: (s) => c(31, s), cyan: (s) => c(36, s), dim: (s) => c(2, s), bold: (s) => c(1, s),
};

export class Report {
  constructor(logFile) {
    this.logFile = logFile;
    this.items = [];
    this.phase = "";
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, `\n===== setup run ${new Date().toISOString()} argv=${process.argv.slice(2).join(" ")} =====\n`);
  }
  log(line) {
    fs.appendFileSync(this.logFile, `[${new Date().toISOString()}] ${line}\n`);
  }
  section(title) {
    this.phase = title;
    console.log(`\n${color.bold(color.cyan(`== ${title}`))}`);
    this.log(`== ${title}`);
  }
  add(status, what, detail = "", fix = "") {
    detail = String(detail ?? "").replace(/\s*\n\s*/g, " | ").slice(0, 300);
    const item = { phase: this.phase, status, what, detail, fix };
    this.items.push(item);
    const tag = status === "PASS" ? color.green("PASS") : status === "WARN" ? color.yellow("WARN") : status === "SKIP" ? color.dim("SKIP") : color.red("FAIL");
    console.log(`  ${tag}  ${what}${detail ? color.dim(` — ${detail}`) : ""}`);
    if (fix && status !== "PASS") console.log(`        ${color.dim("fix:")} ${fix}`);
    this.log(`${status} ${what} ${detail}${fix ? ` | fix: ${fix}` : ""}`);
    return item;
  }
  pass(what, detail) { return this.add("PASS", what, detail); }
  /** Withdraw an earlier WARN/FAIL that later steps resolved (e.g. preflight probe superseded by explicit config). */
  retract(pattern) {
    for (const it of this.items) if ((it.status === "WARN" || it.status === "FAIL") && pattern.test(it.what)) { it.status = "PASS"; it.detail = `${it.detail} (resolved later)`; it.fix = ""; }
  }
  warn(what, detail, fix) { return this.add("WARN", what, detail, fix); }
  fail(what, detail, fix) { return this.add("FAIL", what, detail, fix); }
  skip(what, detail) { return this.add("SKIP", what, detail); }
  info(msg) {
    console.log(`  ${color.dim(msg)}`);
    this.log(`INFO ${msg}`);
  }
  summary(reportFile) {
    const count = (s) => this.items.filter((i) => i.status === s).length;
    console.log(`\n${color.bold("== Summary")}  ${color.green(`${count("PASS")} pass`)}  ${color.yellow(`${count("WARN")} warn`)}  ${color.red(`${count("FAIL")} fail`)}  ${color.dim(`${count("SKIP")} skipped`)}`);
    const problems = this.items.filter((i) => i.status === "FAIL" || i.status === "WARN");
    if (problems.length) {
      console.log(color.bold("\nThings to look at:"));
      for (const p of problems) console.log(`  ${p.status === "FAIL" ? color.red("✗") : color.yellow("!")} [${p.phase}] ${p.what}${p.detail ? `: ${p.detail}` : ""}${p.fix ? `\n      → ${p.fix}` : ""}`);
    }
    if (reportFile) {
      fs.writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), items: this.items }, null, 2));
      console.log(color.dim(`\nFull log: ${this.logFile}\nJSON report: ${reportFile}`));
    }
    return count("FAIL") === 0;
  }
}

// ------------------------------------------------------------------ prompts
export class Prompter {
  /** answers: object of pre-supplied answers keyed by question id (non-interactive mode) */
  constructor({ answers = {}, interactive = true } = {}) {
    this.answers = answers;
    this.interactive = interactive && process.stdin.isTTY;
    this.rl = this.interactive ? readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true }) : null;
  }
  close() { this.rl?.close(); }
  /** Ignore keystrokes while a long step runs (otherwise Enter shows a stray "> " prompt). */
  pause() { this.rl?.pause(); }
  resume() { this.rl?.resume(); }

  async ask(id, question, { def, hidden = false, validate } = {}) {
    if (id in this.answers) return this.answers[id];
    if (!this.interactive) return def;
    for (;;) {
      const suffix = !hidden && def !== undefined && def !== "" ? color.dim(` [${def}]`) : "";
      const raw = hidden ? await this.readHidden(`  ${question}${suffix}: `) : await new Promise((r) => this.rl.question(`  ${question}${suffix}: `, r));
      const v = raw.trim() === "" ? def : raw.trim();
      if (validate) {
        const err = validate(v);
        if (err) { console.log(`    ${color.red(err)}`); continue; }
      }
      return v;
    }
  }
  async confirm(id, question, def = true) {
    const v = await this.ask(id, `${question} (${def ? "Y/n" : "y/N"})`, { def: def ? "y" : "n" });
    if (typeof v === "boolean") return v;
    return /^y(es)?$/i.test(String(v));
  }
  async choose(id, question, options, def) {
    // options: [{key, label}]
    if (id in this.answers) return this.answers[id];
    if (!this.interactive) return def;
    console.log(`  ${question}`);
    options.forEach((o, i) => console.log(`    ${i + 1}) ${o.label}${o.key === def ? color.dim(" (default)") : ""}`));
    for (;;) {
      const raw = await new Promise((r) => this.rl.question(`  choice [${options.findIndex((o) => o.key === def) + 1}]: `, r));
      if (raw.trim() === "") return def;
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].key;
      const byKey = options.find((o) => o.key === raw.trim());
      if (byKey) return byKey.key;
      console.log(`    ${color.red("enter a number 1-" + options.length)}`);
    }
  }
  /** Ask without echoing (API keys). Uses readline itself so stdin state stays consistent. */
  readHidden(prompt) {
    return new Promise((resolve) => {
      const rl = this.rl;
      const orig = rl._writeToOutput;
      rl._writeToOutput = function (s) {
        // readline re-renders "prompt + typed text" on every keypress; only ever show the prompt.
        if (typeof s === "string" && s.includes(prompt)) orig.call(rl, prompt);
      };
      rl.question(prompt, (ans) => {
        rl._writeToOutput = orig;
        process.stdout.write("\n");
        resolve(ans);
      });
    });
  }
}

// ------------------------------------------------------------------ processes
export function which(cmd) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n")[0] : null;
}

export async function run(cmd, args, { cwd, env, timeoutMs = 120_000, input } = {}) {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { cwd, env: { ...process.env, ...(env ?? {}) }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
    return { ok: true, code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e) {
    return { ok: false, code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "", error: e };
  }
}

export function versionGte(v, min) {
  const a = String(v).replace(/^v/, "").split(".").map(Number);
  const b = String(min).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ files
export const home = () => process.env.MODEL_GATEWAY_HOME_OVERRIDE ?? os.homedir();
export const expandHome = (p) => (p.startsWith("~") ? path.join(home(), p.slice(1)) : p);

export function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return undefined;
    const raw = fs.readFileSync(file, "utf8");
    // An empty file holds no configuration, so it is not corruption. Callers refuse to
    // overwrite a file they cannot parse — right for one with real content in it, since
    // clobbering someone's registrations is far worse than a failed step. For zero bytes
    // that caution protects nothing and fails the install instead.
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) { return { __error: e.message }; }
}
export function writeSecret(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
}
export function backup(file) {
  if (!fs.existsSync(file)) return null;
  const b = `${file}.bak`; // one rolling backup per file
  fs.copyFileSync(file, b);
  return b;
}
export function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}
export function sameContent(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}
export function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== "object" || typeof b !== "object" || !a || !b) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out;
}

/** Replace or append a `[mcp_servers.<name>]` table (and its sub-tables) in a TOML file. Minimal, but robust for this shape. */
export function upsertTomlTable(tomlText, tableName, tableBody) {
  const lines = tomlText.split("\n");
  const isHeader = (l) => /^\s*\[[^\]]+\]\s*(#.*)?$/.test(l);
  const headerName = (l) => l.trim().replace(/^\[+|\]+\s*(#.*)?$/g, "").trim().replace(/^"|"$/g, "");
  const out = [];
  let skipping = false;
  for (const l of lines) {
    if (isHeader(l)) {
      const n = headerName(l);
      skipping = n === tableName || n.startsWith(tableName + ".");
    }
    if (!skipping) out.push(l);
  }
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  const head = out.join("\n").replace(/^\n+/, "");
  return (head ? head + "\n\n" : "") + `${tableBody.trim()}\n`;
}
export function removeTomlTable(tomlText, tableName) {
  return upsertTomlTable(tomlText, tableName, "").replace(/\n+$/, "\n");
}
export const tomlStr = (s) => JSON.stringify(String(s)); // JSON string escaping is valid TOML basic-string escaping

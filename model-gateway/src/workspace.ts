/**
 * Tools handed to delegated (worker/reviewer) models.
 *
 * Capability tiers (chosen per call by the orchestrating agent):
 *   read   – read_file, list_files, search, git_status, git_diff, git_log
 *   write  – write_file, edit_file                (jailed to workspaceRoot)
 *   git    – git_create_branch, git_commit, git_push (no force, no protected branches)
 *   github – issues / PRs / Actions via `gh` (see github.ts); implies git
 *   run    – run_command, restricted to config.workers.allowedCommands (see runcmd.ts)
 *   mcp    – tools of the orchestrator's other MCP servers, per-call allow-list (see mcpbridge.ts)
 *
 * Nothing here can delete files, branches, or repos, force-push, reset, or
 * touch secrets — by construction, not by prompt.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GatewayConfig } from "./config.js";
import type { ToolSpec } from "./client.js";

const execFileP = promisify(execFile);

export type Capability = "read" | "write" | "git" | "github" | "run" | "mcp";
export const CAPABILITIES: readonly Capability[] = ["read", "write", "git", "github", "run", "mcp"] as const;

export interface WorkerTool {
  spec: ToolSpec;
  capability: Capability;
  run: (args: Record<string, unknown>) => Promise<string>;
}

const DEFAULT_DENY = [
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.git\//,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/,
  /(^|\/)\.model-gateway\.json$/,
  /(^|\/)(secrets?|credentials?)(\.[a-z0-9]+)?$/i,
  /(^|\/)\.(aws|ssh|gnupg|netrc)(\/|$)/,
];

/** Reject values that git/gh would parse as options. */
export function noFlag(v: unknown, name: string): string {
  const s = String(v ?? "");
  if (!s || s.startsWith("-")) throw new Error(`${name} must not be empty or start with '-'`);
  return s;
}
export function gitRef(v: unknown, name = "ref"): string {
  const s = noFlag(v, name);
  // refs, ranges (a..b, a...b), and pathless revisions only; never anything git could read as an option
  if (!/^[\w.@^~/:-]+$/.test(s) || (s.includes("..") && !/^[\w.@^~/-]+\.\.\.?[\w.@^~/-]+$/.test(s))) throw new Error(`${name} is not a valid git ref: ${s}`);
  return s;
}
export function enumArg<T extends string>(v: unknown, allowed: readonly T[], name: string, dflt?: T): T {
  if (v === undefined || v === null || v === "") {
    if (dflt !== undefined) return dflt;
    throw new Error(`${name} is required`);
  }
  if (!allowed.includes(v as T)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}
export function strArray(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new Error(`${name} must be an array of strings`);
  return v as string[];
}

export class Workspace {
  readonly root: string;
  private deny: RegExp[];

  constructor(private config: GatewayConfig, root?: string, extraDeny: string[] = []) {
    this.root = fs.realpathSync(path.resolve(root ?? config.workspaceRoot ?? process.cwd()));
    this.deny = [
      ...DEFAULT_DENY,
      ...[...config.workspace.denyPatterns, ...extraDeny].map((p) => new RegExp(p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"), "i")),
    ];
  }

  /** A view of the same workspace with additional deny globs (policy rules for one call). */
  withDeny(patterns: string[]): Workspace {
    return patterns.length ? new Workspace(this.config, this.root, patterns) : this;
  }

  /** Resolve a user-supplied path inside the jail; throws if it escapes or is denied. */
  resolve(p: string, { mustExist = true } = {}): string {
    const abs = path.resolve(this.root, p ?? ".");
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path escapes workspace: ${p}`);
    const relPosix = rel.split(path.sep).join("/");
    if (this.deny.some((re) => re.test(relPosix))) throw new Error(`Access to ${p} is denied by policy`);
    // Resolve symlinks of the nearest existing ancestor to defeat link escapes.
    let probe = abs;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new Error(`Path resolves outside workspace: ${p}`);
    const realRel = path.relative(this.root, real).split(path.sep).join("/");
    if (realRel && this.deny.some((re) => re.test(realRel))) throw new Error(`Access to ${p} is denied by policy`);
    if (mustExist && !fs.existsSync(abs)) throw new Error(`Not found: ${p}`);
    return abs;
  }

  async git(args: string[], timeoutMs = 60_000): Promise<string> {
    try {
      const { stdout, stderr } = await execFileP("git", args, { cwd: this.root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
      return (stdout + (stderr ? `\n${stderr}` : "")).trim();
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      throw new Error(`git ${args[0]} failed: ${(err.stderr || err.stdout || err.message).trim().slice(0, 2000)}`);
    }
  }

  async currentBranch(): Promise<string> {
    return (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  }

  isDenied(relPosix: string): boolean {
    return this.deny.some((re) => re.test(relPosix));
  }

  /** Drop per-file sections of a unified diff whose path is denied by policy. */
  filterDiff(diff: string): string {
    if (!diff.startsWith("diff --git")) return diff;
    const parts = diff.split(/^(?=diff --git )/m);
    const kept = parts.filter((sec) => {
      const m = sec.match(/^diff --git a\/(.+?) b\/(.+?)\n/);
      if (!m) return true;
      return !(this.isDenied(m[1]) || this.isDenied(m[2]));
    });
    const dropped = parts.length - kept.length;
    return kept.join("") + (dropped ? `\n[${dropped} file(s) omitted by policy]` : "");
  }

  isProtected(branch: string): boolean {
    return this.config.github.protectedBranches.includes(branch);
  }

  // ---------------------------------------------------------------- tools
  tools(): WorkerTool[] {
    const cfg = this.config.workspace;
    const t: WorkerTool[] = [];
    const add = (capability: Capability, name: string, description: string, properties: Record<string, unknown>, required: string[], run: WorkerTool["run"]) =>
      t.push({ capability, spec: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }, run });

    // ---- read
    add("read", "read_file", "Read a UTF-8 text file from the workspace. Returns numbered lines. Use start_line/end_line for large files.", {
      path: { type: "string", description: "Path relative to workspace root" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
    }, ["path"], async (a) => {
      const abs = this.resolve(String(a.path));
      const st = fs.statSync(abs);
      if (st.isDirectory()) throw new Error(`${a.path} is a directory; use list_files`);
      if (st.size > cfg.maxFileBytes * 4) throw new Error(`File too large (${st.size} bytes); read a line range`);
      const lines = fs.readFileSync(abs, "utf8").split("\n");
      const s = Math.max(1, Number(a.start_line ?? 1));
      const e = Math.min(lines.length, Number(a.end_line ?? lines.length));
      let out = lines.slice(s - 1, e).map((l, i) => `${String(s + i).padStart(5)}| ${l}`).join("\n");
      if (out.length > cfg.maxFileBytes) out = out.slice(0, cfg.maxFileBytes) + `\n… truncated at ${cfg.maxFileBytes} bytes; request a narrower line range`;
      return `${a.path} (lines ${s}-${e} of ${lines.length})\n${out}`;
    });

    add("read", "list_files", "List files under a directory (recursive, respects .gitignore when in a git repo). Returns relative paths.", {
      path: { type: "string", description: "Directory relative to root (default '.')" },
      pattern: { type: "string", description: "Optional substring or glob-ish filter, e.g. '*.ts' or 'src/'" },
      max: { type: "integer" },
    }, [], async (a) => {
      const dir = this.resolve(String(a.path ?? "."));
      const rel = path.relative(this.root, dir) || ".";
      const max = Math.min(Number(a.max ?? cfg.maxListEntries), cfg.maxListEntries);
      let entries: string[];
      try {
        const out = await this.git(["ls-files", "--cached", "--others", "--exclude-standard", "--", rel]);
        entries = out.split("\n").filter(Boolean);
      } catch {
        entries = walk(dir, this.root, 5000);
      }
      if (a.pattern) {
        const re = globToRegex(String(a.pattern));
        entries = entries.filter((e) => re.test(e));
      }
      entries = entries.filter((e) => !this.deny.some((re) => re.test(e))).filter((e) => { try { return !fs.lstatSync(path.join(this.root, e)).isSymbolicLink(); } catch { return false; } });
      const total = entries.length;
      return `${total} file(s)${total > max ? ` (showing ${max})` : ""}\n` + entries.slice(0, max).join("\n");
    });

    add("read", "search", "Search file contents with a regular expression (like grep -rn). Returns path:line: text.", {
      pattern: { type: "string", description: "JavaScript regular expression" },
      path: { type: "string", description: "Directory or file to search (default '.')" },
      glob: { type: "string", description: "Only files matching, e.g. '*.py'" },
      max_matches: { type: "integer" },
    }, ["pattern"], async (a) => {
      const re = new RegExp(String(a.pattern), "i");
      const start = this.resolve(String(a.path ?? "."));
      const max = Math.min(Number(a.max_matches ?? cfg.maxGrepMatches), cfg.maxGrepMatches);
      const fileRe = a.glob ? globToRegex(String(a.glob)) : undefined;
      let files: string[];
      if (fs.statSync(start).isFile()) files = [path.relative(this.root, start)];
      else {
        const rel = path.relative(this.root, start) || ".";
        try {
          files = (await this.git(["ls-files", "--cached", "--others", "--exclude-standard", "--", rel])).split("\n").filter(Boolean);
        } catch {
          files = walk(start, this.root, 5000);
        }
      }
      const hits: string[] = [];
      for (const f of files) {
        if (fileRe && !fileRe.test(f)) continue;
        if (this.deny.some((d) => d.test(f))) continue;
        const abs = path.join(this.root, f);
        let st: fs.Stats;
        try { st = fs.lstatSync(abs); } catch { continue; }
        if (!st.isFile() || st.size > 2_000_000) continue; // lstat: symlinks are skipped
        const buf = fs.readFileSync(abs);
        if (buf.subarray(0, 512).includes(0)) continue; // binary
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            hits.push(`${f}:${i + 1}: ${lines[i].slice(0, 300)}`);
            if (hits.length >= max) return hits.join("\n") + `\n… stopped at ${max} matches`;
          }
        }
      }
      return hits.length ? hits.join("\n") : "no matches";
    });

    add("read", "git_status", "git status --short plus current branch.", {}, [], async () => {
      const b = await this.currentBranch();
      return `branch: ${b}\n` + (await this.git(["status", "--short"]) || "(clean)");
    });

    add("read", "git_diff", "Show a diff. Default: working tree vs HEAD. Provide `ref` (e.g. 'main...HEAD' or a commit) or `staged: true`.", {
      ref: { type: "string" },
      staged: { type: "boolean" },
      path: { type: "string" },
      stat_only: { type: "boolean" },
    }, [], async (a) => {
      const args = ["diff", "--no-color"];
      if (a.stat_only) args.push("--stat");
      if (a.staged) args.push("--cached");
      if (a.ref) args.push(gitRef(a.ref));
      args.push("--");
      if (a.path) args.push(path.relative(this.root, this.resolve(String(a.path))) || ".");
      const out = this.filterDiff(await this.git(args));
      return out.length > cfg.maxFileBytes ? out.slice(0, cfg.maxFileBytes) + "\n… diff truncated; narrow with `path`" : out || "(no changes)";
    });

    add("read", "git_log", "Recent commits (oneline).", { n: { type: "integer" }, path: { type: "string" } }, [], async (a) => {
      const args = ["log", "--no-color", `-n${Math.min(Number(a.n ?? 20), 200)}`, "--pretty=format:%h %ad %an: %s", "--date=short"];
      if (a.path) args.push("--", path.relative(this.root, this.resolve(String(a.path))) || ".");
      return await this.git(args);
    });

    // ---- write
    add("write", "write_file", "Create or overwrite a text file inside the workspace. Parent directories are created.", {
      path: { type: "string" },
      content: { type: "string" },
    }, ["path", "content"], async (a) => {
      const abs = this.resolve(String(a.path), { mustExist: false });
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const existed = fs.existsSync(abs);
      fs.writeFileSync(abs, String(a.content), "utf8");
      return `${existed ? "overwrote" : "created"} ${a.path} (${Buffer.byteLength(String(a.content))} bytes)`;
    });

    add("write", "edit_file", "Replace an exact, unique substring in a file with new text (safer than rewriting the whole file).", {
      path: { type: "string" },
      old_text: { type: "string", description: "Must occur exactly once" },
      new_text: { type: "string" },
    }, ["path", "old_text", "new_text"], async (a) => {
      const abs = this.resolve(String(a.path));
      const src = fs.readFileSync(abs, "utf8");
      const occurrences = src.split(String(a.old_text)).length - 1;
      if (occurrences !== 1) throw new Error(`old_text occurs ${occurrences} times in ${a.path}; it must be unique`);
      fs.writeFileSync(abs, src.replace(String(a.old_text), () => String(a.new_text)), "utf8");
      return `edited ${a.path}`;
    });

    // ---- git (non-destructive subset)
    add("git", "git_create_branch", "Create and switch to a new branch from the current HEAD (or from `from`).", {
      name: { type: "string" },
      from: { type: "string", description: "Optional start point, e.g. 'main' or 'origin/main'" },
    }, ["name"], async (a) => {
      const name = String(a.name);
      if (!/^[\w./-]+$/.test(name) || name.startsWith("-")) throw new Error("invalid branch name");
      const args = ["checkout", "-b", name];
      if (a.from) args.push(gitRef(a.from, "from"));
      return await this.git(args);
    });

    add("git", "git_commit", "Stage the given paths (or all tracked+new files if omitted) and commit. Never amends, never resets.", {
      message: { type: "string" },
      paths: { type: "array", items: { type: "string" }, description: "Files to stage; default: everything (`git add -A`)" },
    }, ["message"], async (a) => {
      const branch = await this.currentBranch();
      if (Array.isArray(a.paths) && a.paths.length) {
        const paths = (a.paths as string[]).map((p) => path.relative(this.root, this.resolve(p)));
        await this.git(["add", "--", ...paths]);
      } else {
        await this.git(["add", "-A"]);
        const staged = (await this.git(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
        const denied = staged.filter((f) => this.isDenied(f));
        if (denied.length) await this.git(["reset", "-q", "--", ...denied]); // never stage secrets
      }
      // A linked worktree must not commit the ledger: it is absorbed into main by the gateway, never merged via git.
      try {
        const gitDir = await this.git(["rev-parse", "--path-format=absolute", "--git-dir"]);
        const common = await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
        if (gitDir !== common) {
          const ledgerStaged = (await this.git(["diff", "--cached", "--name-only", "--", ".break-free"])).split("\n").filter(Boolean);
          if (ledgerStaged.length) await this.git(["reset", "-q", "--", ".break-free"]);
        }
      } catch { /* not a worktree */ }
      const msg = String(a.message);
      const out = await this.git(["-c", "user.name=" + (process.env.GIT_AUTHOR_NAME ?? "model-gateway"), "-c", "user.email=" + (process.env.GIT_AUTHOR_EMAIL ?? "model-gateway@localhost"), "commit", "-m", msg]);
      return `on ${branch}${this.isProtected(branch) ? " (protected: push will be refused — open a PR from a feature branch)" : ""}\n${out}`;
    });

    add("git", "git_push", "Push the current branch to origin (sets upstream). Refused on protected branches; never force.", {
      remote: { type: "string", description: "default 'origin'" },
    }, [], async (a) => {
      if (!this.config.github.allowPush) throw new Error("git push disabled by config (github.allowPush=false)");
      const branch = await this.currentBranch();
      if (this.isProtected(branch)) throw new Error(`Refusing to push protected branch '${branch}'. Create a branch (git_create_branch) and open a PR (gh_create_pr).`);
      const remote = String(a.remote ?? "origin");
      if (!/^[\w.-]+$/.test(remote)) throw new Error("invalid remote name");
      // Plain push: git refuses non-fast-forward updates by default, and there is no way to pass --force here.
      return await this.git(["push", "-u", remote, `HEAD:refs/heads/${branch}`], 180_000);
    });

    return t;
  }
}

function walk(dir: string, root: string, limit: number): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".venv" || e.name === "dist") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else out.push(path.relative(root, p).split(path.sep).join("/"));
    }
  }
  return out;
}

function globToRegex(g: string): RegExp {
  if (!/[*?[]/.test(g)) return new RegExp(g.replace(/[.+^${}()|[\]\\]/g, "\\$&"), "i");
  const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  return new RegExp(g.includes("/") ? `^${re}$` : `(^|/)${re}$`, "i");
}

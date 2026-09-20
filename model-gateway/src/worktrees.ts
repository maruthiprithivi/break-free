/**
 * Worktree registry: shared knowledge for multi-agent work across git worktrees.
 *
 * Several agents (Claude Code, Codex, opencode, kiro, kimi, pi, omp, agy…) may each
 * work in their own worktree of the same repository. Every one of them needs to know:
 * what main is doing, what every other worktree is doing (task, agent, tools, issues,
 * PRs), whether a worktree is active / inactive / merged / abandoned / deleted and why,
 * and what was handed off.
 *
 * The registry lives in the git COMMON dir (`<repo>/.git/break-free/worktrees.json`),
 * which every worktree of the repository shares instantly and which never diverges
 * across branches. A rendered snapshot is written to `.break-free/WORKTREES.md` in the
 * checkout that asks for it (commit it from main to keep a history in the repo).
 *
 * Status is reconciled with `git worktree list` on every read: a registered worktree
 * that disappeared from git becomes `deleted` (reason "removed outside the gateway"
 * unless one was recorded); a branch already merged into the base becomes `merged`;
 * no heartbeat/commit for `inactiveAfterHours` becomes `inactive`.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const WORKTREE_STATUSES = ["active", "inactive", "blocked", "merged", "abandoned", "deleted"] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

export interface WorktreeRecord {
  name: string; // usually the branch name
  path: string;
  branch: string;
  base: string; // branch it was cut from / will merge into
  head?: string;
  status: WorktreeStatus;
  reason?: string; // why inactive / abandoned / deleted / blocked
  purpose?: string; // one line: what this worktree is for
  agent?: string; // claude-code | codex | opencode | kiro | kimi | pi | omp | agy | person
  tasks: string[]; // ledger task ids
  issues: string[]; // GitHub issue refs (#12, owner/repo#12, urls)
  prs: string[];
  tools: string[]; // mcp servers / notable tools in use
  models: string[];
  /** Declared ownership: repo-relative globs this worktree intends to change */
  paths: string[];
  handoff?: string; // last handoff note: state, next steps, gotchas
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string; // heartbeat: last time an agent in this worktree touched the registry
  lastCommitAt?: string;
  /** HEAD when registered — used to tell "merged" from "never committed" */
  startHead?: string;
  /** Last time main absorbed this worktree's ledger overlay */
  ledgerMergedAt?: string;
  isMain?: boolean;
  log: string[];
}

interface Registry {
  version: 1;
  repo: string;
  mainBranch: string;
  worktrees: Record<string, WorktreeRecord>;
  updatedAt: string;
}

const now = () => new Date().toISOString();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).trim();
}
function tryGit(cwd: string, args: string[]): string | undefined {
  try { return git(cwd, args); } catch { return undefined; }
}

/**
 * True when merging this branch into `base` would change nothing, because the merged tree IS
 * base's tree.
 *
 * Ancestry alone cannot answer this. A squash merge replays the branch as one new commit on
 * base, so the branch's own commits are never in base and `base..HEAD` stays above zero
 * forever — the worktree would sit at "active" long after it shipped, claiming paths in every
 * overlap forecast. A rebase merge has the same shape. This costs one in-memory three-way
 * merge: no checkout, no working tree, no index.
 *
 * Returns false when git cannot answer — a conflict (so definitely not landed), or a git older
 * than 2.38 without `merge-tree --write-tree`, where the ancestry check remains the fallback.
 */
function mergeAddsNothing(cwd: string, base: string): boolean {
  const merged = tryGit(cwd, ["merge-tree", "--write-tree", base, "HEAD"]);
  if (!merged) return false;
  const baseTree = tryGit(cwd, ["rev-parse", `${base}^{tree}`]);
  return !!baseTree && merged.split("\n")[0].trim() === baseTree.trim();
}

export interface GitWorktree { path: string; head: string; branch?: string; bare?: boolean; detached?: boolean; prunable?: string }

export function listGitWorktrees(cwd: string): GitWorktree[] {
  const out = tryGit(cwd, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const rows: GitWorktree[] = [];
  let cur: Partial<GitWorktree> = {};
  for (const line of out.split("\n")) {
    if (!line.trim()) { if (cur.path) rows.push(cur as GitWorktree); cur = {}; continue; }
    const [k, ...rest] = line.split(" ");
    const v = rest.join(" ");
    if (k === "worktree") cur.path = realpathSafe(v);
    else if (k === "HEAD") cur.head = v;
    else if (k === "branch") cur.branch = v.replace(/^refs\/heads\//, "");
    else if (k === "bare") cur.bare = true;
    else if (k === "detached") cur.detached = true;
    else if (k === "prunable") cur.prunable = v;
  }
  if (cur.path) rows.push(cur as GitWorktree);
  return rows;
}
function realpathSafe(p: string): string {
  try { return fs.realpathSync(p); } catch { return p; }
}

export class WorktreeRegistry {
  readonly commonDir: string | undefined;
  readonly file: string | undefined;
  readonly root: string;
  constructor(root: string, private opts: { inactiveAfterHours?: number } = {}) {
    this.root = realpathSafe(root);
    const common = tryGit(this.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) ?? tryGit(this.root, ["rev-parse", "--git-common-dir"]);
    if (common) {
      this.commonDir = path.isAbsolute(common) ? common : path.resolve(this.root, common);
      this.file = path.join(this.commonDir, "break-free", "worktrees.json");
    }
  }

  available(): boolean {
    return !!this.file;
  }

  private load(): Registry {
    if (this.file && fs.existsSync(this.file)) {
      try { return JSON.parse(fs.readFileSync(this.file, "utf8")) as Registry; } catch { /* rebuild */ }
    }
    return { version: 1, repo: this.repoName(), mainBranch: this.detectMainBranch(), worktrees: {}, updatedAt: now() };
  }
  private save(r: Registry): void {
    if (!this.file) throw new Error("not a git repository: worktree registry unavailable");
    r.updatedAt = now();
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(r, null, 2) + "\n");
  }

  repoName(): string {
    const url = tryGit(this.root, ["remote", "get-url", "origin"]);
    const m = url?.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    return m?.[1] ?? path.basename(this.mainPath() ?? this.root);
  }
  detectMainBranch(): string {
    const ref = tryGit(this.root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    if (ref) return ref.replace(/^origin\//, "");
    for (const b of ["main", "master", "develop"]) if (tryGit(this.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
    return tryGit(this.root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "main";
  }
  mainPath(): string | undefined {
    return listGitWorktrees(this.root).find((w) => !w.bare)?.path; // first entry is the main working tree
  }
  currentBranch(): string {
    return tryGit(this.root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
  }
  /** The record for the checkout this gateway instance runs in (registered or not). */
  current(): WorktreeRecord | undefined {
    return Object.values(this.load().worktrees).find((w) => realpathSafe(w.path) === this.root);
  }

  /** Reconcile registry with git reality; returns the fresh registry. */
  reconcile(): Registry {
    const r = this.load();
    const live = listGitWorktrees(this.root);
    const byPath = new Map(live.map((w) => [w.path, w]));
    const mainPath = live.find((w) => !w.bare)?.path;
    const inactiveMs = (this.opts.inactiveAfterHours ?? 48) * 3600_000;
    // main is always present as a record
    if (mainPath && !Object.values(r.worktrees).some((w) => realpathSafe(w.path) === mainPath)) {
      const mw = byPath.get(mainPath)!;
      r.worktrees[mw.branch ?? "main"] = { name: mw.branch ?? "main", path: mainPath, branch: mw.branch ?? r.mainBranch, base: r.mainBranch, status: "active", purpose: "main working tree (integration branch)", tasks: [], issues: [], prs: [], tools: [], models: [], paths: [], createdAt: now(), updatedAt: now(), lastSeenAt: now(), isMain: true, log: [`${now()} registered automatically`] };
    }
    for (const w of Object.values(r.worktrees)) {
      const g = byPath.get(realpathSafe(w.path));
      if (!g) {
        if (w.status !== "deleted") {
          w.status = "deleted";
          w.reason ??= "worktree removed outside the gateway (git worktree remove / directory deleted)";
          w.updatedAt = now();
          w.log.push(`${now()} detected deleted: ${w.reason}`);
        }
        continue;
      }
      w.head = g.head;
      if (g.branch && g.branch !== w.branch) { w.log.push(`${now()} branch changed ${w.branch} → ${g.branch}`); w.branch = g.branch; }
      const lastCommit = tryGit(w.path, ["log", "-1", "--format=%cI"]);
      if (lastCommit) w.lastCommitAt = lastCommit;
      if (w.status === "deleted") { w.status = "active"; w.reason = undefined; w.log.push(`${now()} worktree is back`); }
      if (!w.isMain && ["active", "inactive"].includes(w.status)) {
        // merged := the branch made commits since it was registered and none of its CONTENT is
        // missing from base. Ancestry is the cheap case; tree-equality catches the squash and
        // rebase merges that ancestry never sees. The reason records which one decided it,
        // because they fail differently and a wrong "merged" is worse than a stale "active".
        const ahead = Number(tryGit(w.path, ["rev-list", "--count", `${w.base}..HEAD`]) ?? "1");
        const hasOwnCommits = !!w.startHead && w.head !== w.startHead;
        const byAncestry = ahead === 0;
        const landed = byAncestry || mergeAddsNothing(w.path, w.base);
        if (hasOwnCommits && landed) {
          w.status = "merged";
          w.reason ??= byAncestry
            ? `branch ${w.branch} is contained in ${w.base}`
            : `branch ${w.branch} adds nothing to ${w.base} (squashed or rebased in)`;
          w.log.push(`${now()} detected merged into ${w.base}`);
        } else {
          const seen = Math.max(Date.parse(w.lastSeenAt || "") || 0, Date.parse(w.lastCommitAt ?? "") || 0);
          const inactive = Date.now() - seen > inactiveMs;
          if (inactive && w.status === "active") { w.status = "inactive"; w.reason = `no activity for ${Math.round((Date.now() - seen) / 3600_000)} h`; w.log.push(`${now()} marked inactive: ${w.reason}`); }
          else if (!inactive && w.status === "inactive" && /^no activity/.test(w.reason ?? "")) { w.status = "active"; w.reason = undefined; w.log.push(`${now()} active again`); }
        }
      }
    }
    this.save(r);
    return r;
  }

  list(): WorktreeRecord[] {
    return Object.values(this.reconcile().worktrees).sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || a.name.localeCompare(b.name));
  }

  get(name: string): WorktreeRecord | undefined {
    const r = this.reconcile();
    return r.worktrees[name] ?? Object.values(r.worktrees).find((w) => realpathSafe(w.path) === realpathSafe(name) || w.branch === name);
  }

  /** Register the current checkout (or a given path) with its metadata. */
  register(a: { path?: string; name?: string; base?: string; purpose?: string; agent?: string; tasks?: string[]; issues?: string[]; prs?: string[]; tools?: string[]; models?: string[]; paths?: string[]; handoff?: string }): WorktreeRecord {
    const r = this.reconcile();
    const p = realpathSafe(a.path ?? this.root);
    const g = listGitWorktrees(this.root).find((w) => w.path === p);
    if (!g) throw new Error(`${p} is not a worktree of this repository (git worktree list)`);
    let w = Object.values(r.worktrees).find((x) => realpathSafe(x.path) === p);
    const isMain = listGitWorktrees(this.root).find((x) => !x.bare)?.path === p;
    if (!w) {
      const name = a.name ?? g.branch ?? path.basename(p);
      if (r.worktrees[name] && realpathSafe(r.worktrees[name].path) !== p) throw new Error(`name '${name}' is already used by ${r.worktrees[name].path}`);
      w = { name, path: p, branch: g.branch ?? "HEAD", base: a.base ?? r.mainBranch, head: g.head, startHead: g.head, status: "active", tasks: [], issues: [], prs: [], tools: [], models: [], paths: [], createdAt: now(), updatedAt: now(), lastSeenAt: now(), isMain, log: [`${now()} registered`] };
      r.worktrees[name] = w;
    }
    this.merge(w, a);
    w.status = w.status === "deleted" ? "active" : w.status;
    w.lastSeenAt = now();
    w.updatedAt = now();
    this.save(r);
    return w;
  }

  private merge(w: WorktreeRecord, a: { base?: string; purpose?: string; agent?: string; handoff?: string; tasks?: string[]; issues?: string[]; prs?: string[]; tools?: string[]; models?: string[]; paths?: string[] }): void {
    if (a.base) w.base = a.base;
    if (a.purpose) w.purpose = a.purpose;
    if (a.agent) w.agent = a.agent;
    if (a.handoff) { w.handoff = a.handoff; w.log.push(`${now()} handoff: ${a.handoff.slice(0, 200)}`); }
    w.paths ??= [];
    for (const k of ["tasks", "issues", "prs", "tools", "models", "paths"] as const) if (a[k]?.length) w[k] = Array.from(new Set([...(w[k] ?? []), ...a[k]!]));
  }

  /** Files a worktree has changed relative to its base (commits + working tree). */
  changedFiles(w: WorktreeRecord): string[] {
    if (!fs.existsSync(w.path)) return [];
    const set = new Set<string>();
    const committed = tryGit(w.path, ["diff", "--name-only", `${w.base}...HEAD`]) ?? tryGit(w.path, ["diff", "--name-only", w.base]);
    for (const l of (committed ?? "").split("\n")) if (l.trim()) set.add(l.trim());
    for (const l of (tryGit(w.path, ["status", "--porcelain", "--untracked-files=all"]) ?? "").split("\n")) if (l.trim()) set.add(l.slice(3).replace(/^"(.*)"$/, "$1").split(" -> ").pop()!);
    return [...set].filter((f) => !f.startsWith(".break-free/")).sort();
  }

  /** Overlaps between live worktrees: declared path claims and files actually changed. */
  conflicts(): { a: string; b: string; files: string[]; claims: string[] }[] {
    const rows = Object.values(this.reconcile().worktrees).filter((w) => !w.isMain && ["active", "inactive", "blocked"].includes(w.status));
    const changed = new Map(rows.map((w) => [w.name, this.changedFiles(w)]));
    const glob = (g: string) => new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$", "i");
    const out: { a: string; b: string; files: string[]; claims: string[] }[] = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const A = rows[i], B = rows[j];
      const fa = changed.get(A.name)!, fb = new Set(changed.get(B.name)!);
      const files = fa.filter((f) => fb.has(f));
      const claims = new Set<string>();
      for (const g of A.paths ?? []) { const re = glob(g); for (const f of changed.get(B.name)!) if (re.test(f)) claims.add(`${A.name}:${g} ↔ ${f}`); for (const h of B.paths ?? []) if (g === h) claims.add(`${g} claimed by both`); }
      for (const g of B.paths ?? []) { const re = glob(g); for (const f of fa) if (re.test(f)) claims.add(`${B.name}:${g} ↔ ${f}`); }
      if (files.length || claims.size) out.push({ a: A.name, b: B.name, files, claims: [...claims] });
    }
    return out;
  }

  update(name: string, a: { status?: WorktreeStatus; reason?: string; purpose?: string; agent?: string; base?: string; tasks?: string[]; issues?: string[]; prs?: string[]; tools?: string[]; models?: string[]; paths?: string[]; handoff?: string; log?: string; heartbeat?: boolean }): WorktreeRecord {
    const r = this.reconcile();
    const w = r.worktrees[name] ?? Object.values(r.worktrees).find((x) => x.branch === name || realpathSafe(x.path) === realpathSafe(name));
    if (!w) throw new Error(`unknown worktree '${name}' (see worktree_list)`);
    this.merge(w, a);
    if (a.status && a.status !== w.status) {
      w.log.push(`${now()} ${w.status} → ${a.status}${a.reason ? `: ${a.reason}` : ""}`);
      w.status = a.status;
      w.reason = a.reason;
    } else if (a.reason) w.reason = a.reason;
    if (a.log) w.log.push(`${now()} ${a.log}`);
    if (a.heartbeat !== false) w.lastSeenAt = now();
    w.updatedAt = now();
    if (w.log.length > 100) w.log.splice(0, w.log.length - 100);
    this.save(r);
    return w;
  }

  markLedgerMerged(name: string, summary: string): void {
    const r = this.reconcile();
    const w = r.worktrees[name];
    if (!w) return;
    w.ledgerMergedAt = now();
    w.log.push(`${now()} ledger absorbed into main: ${summary}`);
    this.save(r);
  }

  /** Create a new worktree (non-destructive) and register it. */
  create(a: { branch: string; from?: string; dir?: string; purpose?: string; agent?: string; tasks?: string[]; issues?: string[]; tools?: string[]; models?: string[]; paths?: string[] }): WorktreeRecord {
    if (!/^[\w./-]+$/.test(a.branch) || a.branch.startsWith("-")) throw new Error("invalid branch name");
    const r = this.reconcile();
    const mainPath = this.mainPath() ?? this.root;
    const dir = a.dir ? path.resolve(this.root, a.dir) : path.join(path.dirname(mainPath), `${path.basename(mainPath)}.worktrees`, a.branch.replace(/\//g, "-"));
    if (fs.existsSync(dir)) throw new Error(`${dir} already exists`);
    if (a.from && !/^[\w.@^~/-]+$/.test(a.from)) throw new Error("invalid start point");
    const exists = tryGit(this.root, ["rev-parse", "--verify", "--quiet", `refs/heads/${a.branch}`]) !== undefined;
    const args = exists ? ["worktree", "add", dir, a.branch] : ["worktree", "add", "-b", a.branch, dir, a.from ?? r.mainBranch];
    execFileSync("git", args, { cwd: this.root, stdio: "ignore", timeout: 60_000 });
    return this.register({ path: dir, name: a.branch, base: a.from ?? r.mainBranch, purpose: a.purpose, agent: a.agent, tasks: a.tasks, issues: a.issues, tools: a.tools, models: a.models, paths: a.paths });
  }

  /** Remove a worktree checkout (the branch is kept). Refuses dirty trees unless force. */
  remove(name: string, reason: string, force = false): WorktreeRecord {
    const w = this.get(name);
    if (!w) throw new Error(`unknown worktree '${name}'`);
    if (w.isMain) throw new Error("refusing to remove the main working tree");
    if (realpathSafe(w.path) === this.root) throw new Error("refusing to remove the worktree this gateway is running in");
    if (fs.existsSync(w.path)) {
      const dirty = tryGit(w.path, ["status", "--porcelain"]);
      if (dirty && !force) throw new Error(`worktree has uncommitted changes; commit/stash them or pass force:true\n${dirty.slice(0, 500)}`);
      const unpushed = tryGit(w.path, ["log", "--oneline", `${w.base}..HEAD`]);
      if (unpushed && !force && w.status !== "merged") throw new Error(`branch ${w.branch} has ${unpushed.split("\n").length} commit(s) not in ${w.base}; merge/push first, mark it merged, or pass force:true`);
      execFileSync("git", ["worktree", "remove", ...(force ? ["--force"] : []), w.path], { cwd: this.root, stdio: "ignore", timeout: 60_000 });
    } else tryGit(this.root, ["worktree", "prune"]);
    return this.update(w.name, { status: "deleted", reason, log: `removed via gateway${force ? " (force)" : ""}` });
  }

  /** Markdown snapshot for .break-free/WORKTREES.md and for prompts. */
  render(): string {
    const r = this.reconcile();
    const rows = Object.values(r.worktrees).sort((a, b) => (b.isMain ? 1 : 0) - (a.isMain ? 1 : 0) || a.name.localeCompare(b.name));
    const cell = (s?: string) => (s ?? "").replace(/\|/g, "/").replace(/\n/g, " ");
    const lines = [
      "# Worktrees",
      "",
      `_Repository ${r.repo}, integration branch \`${r.mainBranch}\`. Generated ${now()} from the shared registry (\`.git/break-free/worktrees.json\`, visible from every worktree). This checkout: \`${this.currentBranch()}\` at ${this.root}._`,
      "",
      "| worktree | status | agent | purpose | tasks | issues | PRs | last seen | reason |",
      "|---|---|---|---|---|---|---|---|---|",
      ...rows.map((w) => `| ${w.isMain ? "**" : ""}${cell(w.name)}${w.isMain ? "** (main)" : ""} | ${w.status} | ${cell(w.agent)} | ${cell(w.purpose)} | ${w.tasks.join(", ")} | ${w.issues.join(", ")} | ${w.prs.join(", ")} | ${w.lastSeenAt.slice(0, 16).replace("T", " ")} | ${cell(w.reason)} |`),
      "",
      ...rows.filter((w) => w.handoff || w.tools.length || w.models.length).flatMap((w) => [`## ${w.name}${w.isMain ? " (main)" : ""} — ${w.status}`, `- path: \`${w.path}\` · branch \`${w.branch}\` → base \`${w.base}\`${w.head ? ` · head ${w.head.slice(0, 8)}` : ""}`, ...(w.tools.length ? [`- tools/MCP: ${w.tools.join(", ")}`] : []), ...((w.paths ?? []).length ? [`- claims: ${w.paths.join(", ")}`] : []), ...(w.models.length ? [`- models: ${w.models.join(", ")}`] : []), ...(w.handoff ? ["- handoff:", ...w.handoff.split("\n").map((l) => `  ${l}`)] : []), ...(w.log.length ? [`- last: ${w.log.at(-1)}`] : []), ""]),
    ];
    return lines.join("\n");
  }

  /** Compact text for worker prompts / resume briefs. */
  summary(maxChars = 3000): string {
    if (!this.available()) return "";
    const r = this.reconcile();
    const rows = Object.values(r.worktrees);
    if (rows.length <= 1 && !rows[0]?.handoff) return "";
    const me = rows.find((w) => realpathSafe(w.path) === this.root);
    const conflicts = this.conflicts();
    const out = [
      `Worktrees of ${r.repo} (integration branch ${r.mainBranch}); you are in ${me ? `'${me.name}'` : `'${this.currentBranch()}' (unregistered)`}:`,
      ...conflicts.map((c) => `- ⚠ OVERLAP ${c.a} ↔ ${c.b}: ${[...c.files, ...c.claims].slice(0, 6).join(", ")}${c.files.length + c.claims.length > 6 ? " …" : ""} — coordinate before touching these`),
      ...rows.map((w) => `- ${w.name}${w.isMain ? " (main)" : ""} [${w.status}${w.reason ? `: ${w.reason}` : ""}]${w.agent ? ` agent=${w.agent}` : ""}${w.purpose ? ` — ${w.purpose}` : ""}${w.tasks.length ? ` tasks=${w.tasks.join(",")}` : ""}${w.issues.length ? ` issues=${w.issues.join(",")}` : ""}${w.prs.length ? ` prs=${w.prs.join(",")}` : ""}${w.handoff ? ` handoff: ${w.handoff.split("\n")[0].slice(0, 160)}` : ""}`),
    ].join("\n");
    return out.length > maxChars ? out.slice(0, maxChars) + "\n…" : out;
  }
}

// ---------------------------------------------------------------- ledger placement & guards
export const LEDGER_GUARD_MARK = "# break-free ledger guard";

export function isLinkedWorktree(root: string): boolean {
  const gitDir = tryGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const common = tryGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return !!gitDir && !!common && path.resolve(gitDir) !== path.resolve(common);
}

/** Where a linked worktree keeps its ledger overlay: shared, local, never committed. */
export function shadowLedgerDir(commonDir: string, worktreeName: string): string {
  return path.join(commonDir, "break-free", "shadow", worktreeName.replace(/[^A-Za-z0-9._-]/g, "-"));
}

/**
 * Pre-commit hook in the COMMON hooks dir (applies to every worktree): blocks committing
 * `.break-free/` from a linked worktree, so a feature branch can never carry ledger changes
 * that would overwrite main's on merge. Existing hooks are chained, not replaced.
 */
export function guardHookStatus(commonDir: string): { installed: boolean; file: string; chained: boolean } {
  const hooksDir = tryGit(commonDir, ["config", "--get", "core.hooksPath"]);
  const file = path.join(hooksDir ? path.resolve(commonDir, "..", hooksDir) : path.join(commonDir, "hooks"), "pre-commit");
  if (!fs.existsSync(file)) return { installed: false, file, chained: false };
  const t = fs.readFileSync(file, "utf8");
  return { installed: t.includes(LEDGER_GUARD_MARK), file, chained: t.includes("pre-commit.break-free-chained") };
}

export function installGuardHook(commonDir: string): { file: string; chained: boolean } {
  const st = guardHookStatus(commonDir);
  const script = `#!/usr/bin/env bash
${LEDGER_GUARD_MARK} — installed by break-free-gateway; safe to delete (re-created by ledger_guard install)
# A linked worktree (feature branch) must not commit .break-free/: the ledger is merged into main by the
# gateway (ledger_merge_from), never through git, so a PR can never overwrite main's knowledge.
if [ "$(git rev-parse --git-dir 2>/dev/null)" != "$(git rev-parse --git-common-dir 2>/dev/null)" ] && [ -z "\${BREAK_FREE_ALLOW_LEDGER_COMMIT:-}" ]; then
  if git diff --cached --name-only -- .break-free | grep -q .; then
    echo "break-free: refusing to commit .break-free/ from a linked worktree ($(git rev-parse --abbrev-ref HEAD))." >&2
    echo "  Ledger changes from worktrees are absorbed into main by the gateway (ledger_merge_from / ledger_resume on main)." >&2
    echo "  Unstage them:  git restore --staged .break-free    (override once: BREAK_FREE_ALLOW_LEDGER_COMMIT=1)" >&2
    exit 1
  fi
fi
chained="$(dirname "$0")/pre-commit.break-free-chained"
[ -x "$chained" ] && exec "$chained" "$@"
exit 0
`;
  fs.mkdirSync(path.dirname(st.file), { recursive: true });
  let chained = false;
  if (fs.existsSync(st.file) && !st.installed) {
    fs.renameSync(st.file, path.join(path.dirname(st.file), "pre-commit.break-free-chained"));
    chained = true;
  }
  fs.writeFileSync(st.file, script, { mode: 0o755 });
  try { fs.chmodSync(st.file, 0o755); } catch { /* windows */ }
  return { file: st.file, chained: chained || st.chained };
}

export function removeGuardHook(commonDir: string): boolean {
  const st = guardHookStatus(commonDir);
  if (!st.installed) return false;
  fs.rmSync(st.file);
  const chained = path.join(path.dirname(st.file), "pre-commit.break-free-chained");
  if (fs.existsSync(chained)) fs.renameSync(chained, st.file);
  return true;
}

/** GitHub Actions workflow: fail any PR that changes .break-free/ (the ledger only moves on main). */
export const LEDGER_GUARD_WORKFLOW = `name: break-free ledger guard
# Installed by break-free-gateway (ledger_guard install). Keeps .break-free/ (the shared project ledger)
# from being changed by feature-branch PRs: knowledge from worktrees reaches main through the gateway's
# ledger merge, never through a PR, so a merge can never overwrite main's tasks/notes/journal.
on:
  pull_request:
    paths: [".break-free/**"]
jobs:
  ledger-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - name: PR must not modify .break-free/
        run: |
          changed=$(git diff --name-only "origin/\${{ github.base_ref }}...HEAD" -- .break-free || true)
          if [ -n "$changed" ]; then
            echo "::error::This PR modifies the break-free ledger (.break-free/). Ledger changes are absorbed into \${{ github.base_ref }} by the gateway (ledger_merge_from), not merged through PRs. Drop these changes from the branch:"
            echo "$changed"
            exit 1
          fi
          echo "ok: no ledger changes in this PR"
`;

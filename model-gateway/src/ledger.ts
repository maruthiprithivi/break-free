/**
 * Project ledger: durable task management + shared knowledge for long-horizon work.
 *
 * Everything lives as plain Markdown inside the repository at <workspace>/.break-free/
 * so it survives sessions, is diffable, is readable by humans, by Claude Code, by Codex
 * and by every delegated worker — and the folder opens directly as an Obsidian vault
 * (YAML frontmatter + [[wikilinks]]).
 *
 *   .break-free/
 *     README.md              what this folder is
 *     PLAN.md                generated board (open tasks by status, dependencies)
 *     HANDOFF.md             generated resume brief for the next session
 *     CODE-MAP.md            generated import graph / symbol index (codemap.ts)
 *     tasks/<id>.md          one file per task (frontmatter + Problem / Acceptance / Outcome / Log)
 *     notes/<slug>.md        knowledge: decisions, gotchas, how-tos, conventions
 *     journal/<date>.md      append-only log of delegations and outcomes
 */
import fs from "node:fs";
import path from "node:path";

export const LEDGER_DIR = ".break-free";
export const TASK_STATUSES = ["todo", "in_progress", "blocked", "review", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  owner?: string; // model spec / "orchestrator" / person
  depends_on: string[];
  tags: string[];
  verify?: string;
  job?: string;
  created: string;
  updated: string;
  problem?: string;
  acceptance?: string;
  outcome?: string;
  log: string[];
  /** Routing provenance — why this task ran on the model it ran on. */
  routed_by?: string; // "jev" | "rules" | "policy" | "lead"
  route_lane?: string;
  route_confidence?: number;
  /** Lane distribution as `fast=0.83 strong=0.11` (frontmatter values must stay scalar). */
  route_probs?: string;
  route_ms?: number;
  /** Set when the lead later replaced a routed lane with an explicit model. */
  overridden_by?: string;
}

/** The routing block a caller may pass to `createTask`. */
export type TaskRouting = Pick<Task, "routed_by" | "route_lane" | "route_confidence" | "route_probs" | "route_ms" | "overridden_by">;

/**
 * One line of routing evidence in `.break-free/scorecards.jsonl`: what lane ran a task, on what
 * model, and whether the gateway's own verify passed. This is the feedback loop — the next plan's
 * Jev state quotes these as `migration: fast 0/2 verify pass, strong 1/1`. Structured JSONL rather
 * than prose in a task body, because prose cannot be aggregated reliably.
 */
export interface ScorecardRecord {
  /** Ledger task id */
  task: string;
  /** `run_plan` id or goal slug, so a whole plan can be replayed */
  plan?: string;
  lane: string;
  model: string;
  tags: string[];
  /** `null` when the task had no verify command — excluded from pass rates rather than counted as a pass */
  verify_ok: boolean | null;
  attempts: number;
  ms: number;
  cost_usd: number;
  at: string;
}

export interface Note {
  slug: string;
  title: string;
  tags: string[];
  created: string;
  updated: string;
  body: string;
  /** "lead" (orchestrator/human) or "worker" (written by a delegated model — untrusted until promoted) */
  trust?: "lead" | "worker";
  /** Worker notes start pending and are NOT injected into other workers until the lead promotes them */
  pending?: boolean;
}

const now = () => new Date().toISOString();
const day = () => now().slice(0, 10);

// ---------------------------------------------------------------- frontmatter
export function parseFrontmatter(src: string): { meta: Record<string, unknown>; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, unknown> = {};
  let lastKey: string | undefined;
  for (const line of m[1].split(/\r?\n/)) {
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li && lastKey && Array.isArray(meta[lastKey])) {
      (meta[lastKey] as string[]).push(unquote(li[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    lastKey = kv[1];
    const v = kv[2].trim();
    if (v === "") meta[kv[1]] = [];
    else if (v.startsWith("[")) meta[kv[1]] = v.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter(Boolean);
    else meta[kv[1]] = unquote(v);
  }
  return { meta, body: m[2] };
}
function unquote(s: string): string {
  return /^".*"$/.test(s) || /^'.*'$/.test(s) ? s.slice(1, -1) : s;
}
function q(s: string): string {
  return /[:#\[\]{}",']|^\s|\s$/.test(s) || s === "" ? JSON.stringify(s) : s;
}
export function renderFrontmatter(meta: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => q(String(x))).join(", ")}]`);
    else lines.push(`${k}: ${q(String(v))}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

function section(body: string, name: string): string | undefined {
  const lines = body.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${name}`);
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  if (end < 0) end = lines.length;
  const text = lines.slice(start + 1, end).join("\n").trim();
  return text || undefined;
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
}

// -------------------------------------------------------------------- ledger
export interface LedgerOptions {
  /** Where this instance WRITES (default <root>/.break-free). In a linked worktree: the shadow dir under .git/break-free/ */
  writeDir?: string;
  /** Read-only lower layer (main checkout's live .break-free) that this instance overlays */
  baseDir?: string;
  /** Name of the worktree this ledger belongs to; new task ids are namespaced with it */
  origin?: string;
}

export interface MergeReport {
  from: string;
  tasks: { added: string[]; updated: string[]; unchanged: number };
  notes: { added: string[]; merged: string[]; unchanged: number };
  journal_lines: number;
}

export class Ledger {
  /** Directory this instance writes to */
  readonly dir: string;
  readonly baseDir?: string;
  readonly origin?: string;
  constructor(readonly root: string, opts: LedgerOptions = {}) {
    this.dir = opts.writeDir ?? path.join(root, LEDGER_DIR);
    this.baseDir = opts.baseDir && path.resolve(opts.baseDir) !== path.resolve(this.dir) ? opts.baseDir : undefined;
    this.origin = opts.origin;
  }

  /** True when this ledger is a worktree overlay (writes go to the shadow, never to the checkout) */
  get isShadow(): boolean {
    return !!this.baseDir;
  }
  private layers(): string[] {
    return this.baseDir ? [this.baseDir, this.dir] : [this.dir];
  }
  private static hasContent(dir: string): boolean {
    return fs.existsSync(path.join(dir, "tasks")) || fs.existsSync(path.join(dir, "notes"));
  }

  exists(): boolean {
    return this.layers().some((d) => Ledger.hasContent(d));
  }

  init(): void {
    for (const d of ["tasks", "notes", "journal"]) fs.mkdirSync(path.join(this.dir, d), { recursive: true });
    const readme = path.join(this.dir, "README.md");
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        "# break-free project ledger",
        "",
        "Durable task board and shared knowledge for this repository, maintained by the orchestrating agent (Claude Code / Codex) through the break-free gateway. Plain Markdown: commit it, diff it, or open this folder as an **Obsidian vault**.",
        "",
        "- `PLAN.md` — current board (generated; edit tasks in `tasks/` instead)",
        "- `HANDOFF.md` — resume brief for the next session (generated)",
        "- `CODE-MAP.md` — import graph and symbol index (generated by `code_map`)",
        "- `tasks/` — one file per task: problem, acceptance criteria, outcome, log",
        "- `notes/` — decisions, gotchas, conventions, how-tos ([[wikilinks]] welcome)",
        "- `journal/` — append-only log of what was delegated to which model and how it went",
        "",
        "Agents: call `ledger_resume` at the start of a session and keep `task_update` / `note_write` current as you work.",
        "",
      ].join("\n"));
    }
    this.render();
  }

  private ensure(): void {
    if (!this.exists()) this.init();
  }

  // ---- tasks
  private taskFile(id: string, dir = this.dir): string {
    return path.join(dir, "tasks", `${id.replace(/[^A-Za-z0-9._-]/g, "_")}.md`);
  }
  private taskFileAnyLayer(id: string): string | undefined {
    for (const d of [...this.layers()].reverse()) { const f = this.taskFile(id, d); if (fs.existsSync(f)) return f; }
    return undefined;
  }

  /** New ids: T-001 on main; T-<worktree>-001 in a worktree overlay so parallel branches never collide. */
  nextId(): string {
    const prefix = this.origin ? `T-${slugify(this.origin).slice(0, 24)}-` : "T-";
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`);
    const ids = this.listTasks().map((t) => Number((t.id.match(re) ?? [])[1] ?? 0));
    return `${prefix}${String(Math.max(0, ...ids) + 1).padStart(3, "0")}`;
  }

  createTask(t: { id?: string; title: string; problem?: string; acceptance?: string; depends_on?: string[]; owner?: string; verify?: string; tags?: string[]; status?: TaskStatus; routing?: TaskRouting }): Task {
    this.ensure();
    const id = t.id ?? this.nextId();
    if (this.taskFileAnyLayer(id)) throw new Error(`task ${id} already exists`);
    const task: Task = { id, title: t.title, status: t.status ?? "todo", owner: t.owner, depends_on: t.depends_on ?? [], tags: t.tags ?? [], verify: t.verify, created: now(), updated: now(), problem: t.problem, acceptance: t.acceptance, log: [`${now()} created`], ...t.routing };
    this.saveTask(task);
    this.render();
    return task;
  }

  getTask(id: string): Task | undefined {
    const f = this.taskFileAnyLayer(id);
    if (!f) return undefined;
    return Ledger.readTask(f, id);
  }
  static readTask(f: string, id: string): Task | undefined {
    if (!fs.existsSync(f)) return undefined;
    const { meta, body } = parseFrontmatter(fs.readFileSync(f, "utf8"));
    const logSec = section(body, "Log") ?? "";
    return {
      id: String(meta.id ?? id),
      title: String(meta.title ?? id),
      status: (TASK_STATUSES as readonly string[]).includes(String(meta.status)) ? (meta.status as TaskStatus) : "todo",
      owner: meta.owner ? String(meta.owner) : undefined,
      depends_on: Array.isArray(meta.depends_on) ? (meta.depends_on as string[]) : [],
      tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [],
      verify: meta.verify ? String(meta.verify) : undefined,
      job: meta.job ? String(meta.job) : undefined,
      created: String(meta.created ?? ""),
      updated: String(meta.updated ?? ""),
      problem: section(body, "Problem"),
      acceptance: section(body, "Acceptance criteria"),
      outcome: section(body, "Outcome"),
      log: logSec.split("\n").map((l) => l.replace(/^- /, "").trim()).filter(Boolean),
      routed_by: meta.routed_by ? String(meta.routed_by) : undefined,
      route_lane: meta.route_lane ? String(meta.route_lane) : undefined,
      route_confidence: meta.route_confidence !== undefined && meta.route_confidence !== "" ? Number(meta.route_confidence) : undefined,
      route_probs: meta.route_probs ? String(meta.route_probs) : undefined,
      route_ms: meta.route_ms !== undefined && meta.route_ms !== "" ? Number(meta.route_ms) : undefined,
      overridden_by: meta.overridden_by ? String(meta.overridden_by) : undefined,
    };
  }

  /** Tasks stored in ONE directory (no overlay) */
  static tasksIn(dir: string): Task[] {
    const d = path.join(dir, "tasks");
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => Ledger.readTask(path.join(d, f), f.slice(0, -3))).filter((t): t is Task => !!t);
  }
  /** Only what this instance itself wrote (the overlay), used for merging into main */
  ownTasks(): Task[] {
    return Ledger.tasksIn(this.dir);
  }

  listTasks(filter: { status?: TaskStatus[]; tag?: string } = {}): Task[] {
    const byId = new Map<string, Task>();
    for (const layer of this.layers()) for (const t of Ledger.tasksIn(layer)) byId.set(t.id, t); // later layer (overlay) wins
    return [...byId.values()]
      .filter((t) => (!filter.status || filter.status.includes(t.status)) && (!filter.tag || t.tags.includes(filter.tag)))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  updateTask(id: string, patch: Partial<Omit<Task, "id" | "created" | "updated" | "log">> & { log?: string }): Task {
    const t = this.getTask(id);
    if (!t) throw new Error(`unknown task ${id}`);
    const before = t.status;
    Object.assign(t, Object.fromEntries(Object.entries(patch).filter(([k, v]) => k !== "log" && v !== undefined)));
    t.updated = now();
    if (patch.status && patch.status !== before) t.log.push(`${now()} ${before} → ${patch.status}`);
    if (patch.log) t.log.push(`${now()} ${patch.log}`);
    this.saveTask(t);
    this.render();
    return t;
  }

  private saveTask(t: Task): void {
    const meta = {
      id: t.id,
      title: t.title,
      status: t.status,
      owner: t.owner,
      depends_on: t.depends_on,
      tags: t.tags,
      verify: t.verify,
      job: t.job,
      routed_by: t.routed_by,
      route_lane: t.route_lane,
      route_confidence: t.route_confidence,
      route_probs: t.route_probs,
      route_ms: t.route_ms,
      overridden_by: t.overridden_by,
      created: t.created,
      updated: t.updated,
    };
    const body = [
      `# ${t.id} ${t.title}`,
      "",
      "## Problem",
      t.problem ?? "",
      "",
      "## Acceptance criteria",
      t.acceptance ?? "",
      "",
      "## Outcome",
      t.outcome ?? "",
      "",
      "## Log",
      ...t.log.map((l) => `- ${l}`),
      "",
    ].join("\n");
    fs.mkdirSync(path.dirname(this.taskFile(t.id)), { recursive: true });
    fs.writeFileSync(this.taskFile(t.id), renderFrontmatter(meta) + body);
  }

  /** Tasks whose dependencies are all done and that are not finished themselves. */
  ready(): Task[] {
    const all = this.listTasks();
    const done = new Set(all.filter((t) => t.status === "done").map((t) => t.id));
    return all.filter((t) => (t.status === "todo" || t.status === "blocked") && t.depends_on.every((d) => done.has(d)));
  }

  // ---- notes
  private noteFile(slug: string, dir = this.dir): string {
    return path.join(dir, "notes", `${slugify(slug)}.md`);
  }

  writeNote(n: { title: string; body: string; tags?: string[]; append?: boolean; source?: string; trust?: "lead" | "worker" }): Note {
    this.ensure();
    const slug = slugify(n.title);
    const f = this.noteFile(slug);
    const existing = this.getNote(slug); // may come from the base layer: copy-on-write into the overlay
    const trust = n.trust ?? (n.source === "worker" ? "worker" : "lead");
    // A worker may never overwrite or silently extend a lead's note: its text lands as a pending sibling section.
    const workerOnLead = trust === "worker" && existing && existing.trust !== "worker";
    const body = workerOnLead
      ? `${existing!.body.trimEnd()}\n\n## Proposed by a worker (pending review)\n${n.body.trim()}\n`
      : existing && n.append ? `${existing.body.trimEnd()}\n\n${n.body.trim()}\n` : `${n.body.trim()}\n`;
    const note: Note = {
      slug,
      title: existing?.title ?? n.title,
      tags: Array.from(new Set([...(existing?.tags ?? []), ...(n.tags ?? [])])),
      created: existing?.created ?? now(),
      updated: now(),
      body,
      trust: workerOnLead ? existing!.trust ?? "lead" : trust,
      pending: trust === "worker" ? true : existing?.pending ?? false,
    };
    this.writeRawNote(note, n.source);
    return note;
  }

  /** Lead decision on a worker note: promote (inject from now on) or reject (moved to notes/rejected/). */
  reviewNote(slug: string, action: "promote" | "reject"): Note | undefined {
    const n = this.getNote(slug);
    if (!n) return undefined;
    if (action === "promote") {
      const promoted: Note = { ...n, pending: false, trust: "lead", updated: now(), body: n.body.replace(/^## Proposed by a worker \(pending review\)\n/m, "## From a worker (promoted)\n") };
      this.writeRawNote(promoted, "promoted");
      return promoted;
    }
    const f = this.noteFile(slug);
    const dest = path.join(this.dir, "notes", "rejected", `${slugify(slug)}.md`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(f)) fs.renameSync(f, dest);
    else this.writeRawNoteAt(dest, { ...n, pending: false }, "rejected"); // note lived in the base layer: shadow it with a rejected copy
    return { ...n, pending: false };
  }

  pendingNotes(): Note[] {
    return this.listNotes().filter((n) => n.pending);
  }

  getNote(slug: string): Note | undefined {
    for (const d of [...this.layers()].reverse()) { const f = this.noteFile(slug, d); if (fs.existsSync(f)) return Ledger.readNote(f, slug); }
    return undefined;
  }
  static readNote(f: string, slug: string): Note | undefined {
    if (!fs.existsSync(f)) return undefined;
    const { meta, body } = parseFrontmatter(fs.readFileSync(f, "utf8"));
    return { slug: slugify(slug), title: String(meta.title ?? slug), tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : [], created: String(meta.created ?? ""), updated: String(meta.updated ?? ""), body: body.replace(/^# .*\n\n?/, ""), trust: meta.trust === "worker" ? "worker" : "lead", pending: String(meta.pending) === "true" };
  }
  static notesIn(dir: string): Note[] {
    const d = path.join(dir, "notes");
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => f.endsWith(".md")).map((f) => Ledger.readNote(path.join(d, f), f.slice(0, -3))).filter((n): n is Note => !!n);
  }
  ownNotes(): Note[] {
    return Ledger.notesIn(this.dir);
  }

  listNotes(): Note[] {
    const bySlug = new Map<string, Note>();
    for (const layer of this.layers()) for (const n of Ledger.notesIn(layer)) bySlug.set(n.slug, n);
    return [...bySlug.values()].sort((a, b) => b.updated.localeCompare(a.updated));
  }

  searchNotes(query: string, max = 20): { note: Note; hits: string[] }[] {
    const re = new RegExp(query.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*"), "i");
    const out: { note: Note; hits: string[] }[] = [];
    for (const n of this.listNotes()) {
      const hits = [n.title, ...n.tags, ...n.body.split("\n")].filter((l) => re.test(l)).slice(0, 5);
      if (hits.length) out.push({ note: n, hits });
      if (out.length >= max) break;
    }
    return out;
  }

  // ---- journal
  journal(line: string): void {
    this.ensure();
    const f = path.join(this.dir, "journal", `${day()}.md`);
    if (!fs.existsSync(f)) fs.writeFileSync(f, `# Journal ${day()}\n\n`);
    fs.appendFileSync(f, `- ${now().slice(11, 19)} ${line.replace(/\s+/g, " ").trim()}\n`);
  }

  // ---- scorecards (the routing feedback loop)
  /** Append one routing outcome. Append-only JSONL: parallel workers never rewrite each other's lines. */
  scorecardAppend(rec: ScorecardRecord): void {
    this.ensure();
    const f = path.join(this.dir, "scorecards.jsonl");
    fs.appendFileSync(f, JSON.stringify(rec) + "\n");
  }

  /** Every scorecard line visible to this ledger, overlay included, oldest first. Malformed lines are skipped, not fatal. */
  scorecards(): ScorecardRecord[] {
    const out: ScorecardRecord[] = [];
    for (const layer of this.layers()) {
      const f = path.join(layer, "scorecards.jsonl");
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line) as ScorecardRecord;
          if (r && typeof r.task === "string" && typeof r.lane === "string") out.push({ ...r, tags: Array.isArray(r.tags) ? r.tags : [], verify_ok: r.verify_ok ?? null, cost_usd: Number(r.cost_usd ?? 0), ms: Number(r.ms ?? 0), attempts: Number(r.attempts ?? 1) });
        } catch {
          /* a half-written or hand-edited line must not break routing */
        }
      }
    }
    return out;
  }

  static journalIn(dir: string): { day: string; lines: string[] }[] {
    const d = path.join(dir, "journal");
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().map((f) => ({ day: f.slice(0, 10), lines: fs.readFileSync(path.join(d, f), "utf8").split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)) }));
  }

  recentJournal(lines = 30): string[] {
    const byDay = new Map<string, Set<string>>();
    for (const layer of this.layers()) for (const j of Ledger.journalIn(layer)) { const set = byDay.get(j.day) ?? new Set<string>(); for (const l of j.lines) set.add(l); byDay.set(j.day, set); }
    const days = [...byDay.keys()].sort().slice(-3);
    const out: string[] = [];
    for (const day of days) for (const l of [...byDay.get(day)!].sort()) out.push(`${day} ${l}`);
    return out.slice(-lines);
  }

  // ---- merging worktree overlays into main
  /**
   * Absorb another ledger's OWN content (its overlay) into this one. Idempotent.
   * Tasks: by id — the record with the later `updated` wins field-by-field, logs are unioned.
   * Notes: by slug — identical: skip; one contains the other: keep the longer; else keep ours and
   * append theirs under "## From <origin>". Journal: line union per day, lines prefixed with [origin].
   */
  mergeFrom(other: Ledger, origin: string): MergeReport {
    this.ensure();
    const rep: MergeReport = { from: origin, tasks: { added: [], updated: [], unchanged: 0 }, notes: { added: [], merged: [], unchanged: 0 }, journal_lines: 0 };
    for (const theirs of other.ownTasks()) {
      const mine = this.getTask(theirs.id);
      if (!mine) { this.saveTask({ ...theirs, log: [...theirs.log, `${now()} imported from ${origin}`] }); rep.tasks.added.push(theirs.id); continue; }
      const logs = Array.from(new Set([...mine.log, ...theirs.log])).sort();
      // already absorbed: every line of their log is in ours and ours is at least as new
      const same = theirs.updated <= mine.updated && theirs.log.every((l) => mine.log.includes(l));
      if (same) { rep.tasks.unchanged++; continue; }
      const newer = theirs.updated > mine.updated ? theirs : mine;
      const merged: Task = { ...mine, ...Object.fromEntries(Object.entries(newer).filter(([k, v]) => !["log", "depends_on", "tags", "created"].includes(k) && v !== undefined && v !== "")), depends_on: Array.from(new Set([...mine.depends_on, ...theirs.depends_on])), tags: Array.from(new Set([...mine.tags, ...theirs.tags])), log: [...logs, `${now()} merged from ${origin}`], updated: now() };
      this.saveTask(merged);
      rep.tasks.updated.push(theirs.id);
    }
    for (const theirs of other.ownNotes()) {
      const mine = this.getNote(theirs.slug);
      const tags = Array.from(new Set([...(mine?.tags ?? []), ...theirs.tags]));
      if (!mine) { this.writeRawNote({ ...theirs, tags }, `worktree:${origin}`); rep.notes.added.push(theirs.slug); continue; }
      if (theirs.pending && !mine.pending) {
        // a worker's pending proposal on top of a lead note: keep it pending on main, never silently merge
        if (!mine.body.includes(theirs.body.trim())) { this.writeRawNote({ ...mine, tags, body: `${mine.body.trimEnd()}\n\n## Proposed by a worker in ${origin} (pending review)\n${theirs.body.trim()}\n`, pending: true, updated: now() }, undefined); rep.notes.merged.push(theirs.slug); } else rep.notes.unchanged++;
        continue;
      }
      const a = mine.body.trim(), b = theirs.body.trim();
      if (a === b || a.includes(b)) { if (tags.length !== mine.tags.length) this.writeRawNote({ ...mine, tags }, undefined); rep.notes.unchanged++; continue; }
      const body = b.includes(a) ? theirs.body : `${mine.body.trimEnd()}\n\n## From ${origin} (${theirs.updated.slice(0, 10)})\n${theirs.body.trim()}\n`;
      this.writeRawNote({ ...mine, tags, body, updated: now() }, undefined);
      rep.notes.merged.push(theirs.slug);
    }
    for (const j of Ledger.journalIn(other.dir)) {
      const f = path.join(this.dir, "journal", `${j.day}.md`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const existing = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : `# Journal ${j.day}\n\n`;
      const have = new Set(existing.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)));
      const add = j.lines.map((l) => (l.includes(`[${origin}]`) ? l : l.replace(/^(\d\d:\d\d:\d\d) /, `$1 [${origin}] `))).filter((l) => !have.has(l));
      if (add.length) { fs.writeFileSync(f, existing.replace(/\n*$/, "\n") + add.map((l) => `- ${l}`).join("\n") + "\n"); rep.journal_lines += add.length; }
    }
    if (rep.tasks.added.length || rep.tasks.updated.length || rep.notes.added.length || rep.notes.merged.length || rep.journal_lines) {
      this.journal(`absorbed ledger of worktree ${origin}: tasks +${rep.tasks.added.length}/~${rep.tasks.updated.length}, notes +${rep.notes.added.length}/~${rep.notes.merged.length}, journal +${rep.journal_lines}`);
      this.render();
    }
    return rep;
  }
  private writeRawNote(n: Note, source: string | undefined): void {
    this.writeRawNoteAt(this.noteFile(n.slug), n, source);
  }
  private writeRawNoteAt(f: string, n: Note, source: string | undefined): void {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, renderFrontmatter({ title: n.title, tags: n.tags, created: n.created, updated: n.updated, source, trust: n.trust ?? "lead", pending: n.pending ? "true" : undefined }) + `# ${n.title}\n\n${n.body.trimEnd()}\n`);
  }

  // ---- generated views
  render(): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const tasks = this.listTasks();
    const by = (s: TaskStatus) => tasks.filter((t) => t.status === s);
    const row = (t: Task) => `| [[tasks/${t.id}\\|${t.id}]] | ${t.title.replace(/\|/g, "/")} | ${t.status} | ${t.owner ?? ""} | ${t.depends_on.join(", ")} | ${t.updated.slice(0, 16).replace("T", " ")} |`;
    const table = (rows: Task[]) => (rows.length ? ["| id | title | status | owner | depends on | updated |", "|---|---|---|---|---|---|", ...rows.map(row)].join("\n") : "_none_");
    const open = tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    const mermaid = open.length
      ? ["```mermaid", "graph LR", ...open.map((t) => `  ${t.id.replace(/-/g, "_")}["${t.id} ${t.title.replace(/"/g, "'").slice(0, 40)}"]`), ...open.flatMap((t) => t.depends_on.map((d) => `  ${d.replace(/-/g, "_")} --> ${t.id.replace(/-/g, "_")}`)), "```"].join("\n")
      : "";
    fs.writeFileSync(path.join(this.dir, "PLAN.md"), [
      "# Plan",
      "",
      `_Generated ${now()} — ${open.length} open, ${by("done").length} done. Edit tasks in \`tasks/\` (or via task_update), not here._`,
      "",
      "## In progress",
      table(by("in_progress")),
      "",
      "## Review",
      table(by("review")),
      "",
      "## Blocked",
      table(by("blocked")),
      "",
      "## Todo",
      table(by("todo")),
      "",
      "## Done",
      table(by("done").slice(-30)),
      "",
      mermaid,
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(this.dir, "HANDOFF.md"), this.resumeBrief());
  }

  /** What the next session needs to know to continue. */
  resumeBrief(maxChars = 12_000): string {
    const tasks = this.listTasks();
    const open = tasks.filter((t) => !["done", "cancelled"].includes(t.status));
    const ready = this.ready();
    const notes = this.listNotes();
    const decisions = notes.filter((n) => !n.pending && (n.tags.includes("decision") || n.tags.includes("gotcha") || n.tags.includes("convention")));
    const lines = [
      "# Handoff",
      "",
      `_Generated ${now()}. Read this first when resuming work in this repository._`,
      "",
      "## Where things stand",
      `- ${tasks.length} tasks total: ${TASK_STATUSES.map((s) => `${s} ${tasks.filter((t) => t.status === s).length}`).join(", ")}`,
      ...tasks.filter((t) => t.status === "in_progress").map((t) => `- IN PROGRESS ${t.id} ${t.title}${t.owner ? ` (owner: ${t.owner})` : ""} — last: ${t.log.at(-1) ?? ""}`),
      ...tasks.filter((t) => t.status === "blocked").map((t) => `- BLOCKED ${t.id} ${t.title} — last: ${t.log.at(-1) ?? ""}`),
      ...tasks.filter((t) => t.status === "review").map((t) => `- NEEDS REVIEW ${t.id} ${t.title}`),
      "",
      "## Ready to start or retry (dependencies satisfied)",
      ...(ready.length ? ready.map((t) => `- ${t.id} ${t.title}${t.verify ? ` — verify: \`${t.verify}\`` : ""}`) : ["- (nothing ready)"]),
      "",
      "## Open tasks",
      ...(open.length ? open.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.depends_on.length ? ` (after ${t.depends_on.join(", ")})` : ""}`) : ["- (none)"]),
      "",
      ...(notes.some((n) => n.pending) ? [`## Worker notes awaiting your review (not injected until promoted)`, ...notes.filter((n) => n.pending).map((n) => `- [[notes/${n.slug}|${n.title}]] — note_review {slug:"${n.slug}", action:"promote"|"reject"}`), ""] : []),
      "## Decisions, conventions & gotchas",
      ...(decisions.length ? decisions.slice(0, 15).map((n) => `- [[notes/${n.slug}|${n.title}]] — ${n.body.split("\n").find((l) => l.trim())?.slice(0, 160) ?? ""}`) : ["- (no notes tagged decision/convention/gotcha yet)"]),
      "",
      "## Other notes",
      ...(notes.filter((n) => !decisions.includes(n)).slice(0, 20).map((n) => `- [[notes/${n.slug}|${n.title}]] (${n.tags.join(", ") || "untagged"})`)),
      "",
      "## Recent activity",
      ...this.recentJournal(25).map((l) => `- ${l}`),
      "",
    ];
    let out = lines.join("\n");
    if (out.length > maxChars) out = out.slice(0, maxChars) + "\n… (truncated; read .break-free/ directly)";
    return out;
  }

  /** Compact knowledge for injection into worker prompts. */
  workerContext(maxChars: number, taskId?: string): string {
    if (!this.exists()) return "";
    const parts: string[] = [];
    const t = taskId ? this.getTask(taskId) : undefined;
    if (t) parts.push(`## Your task in the project ledger: ${t.id} ${t.title}\nProblem: ${t.problem ?? ""}\nAcceptance criteria: ${t.acceptance ?? ""}`);
    const notes = this.listNotes().filter((n) => !n.pending && n.tags.some((x) => ["decision", "gotcha", "convention", "howto"].includes(x))).slice(0, 12);
    if (notes.length) parts.push("## Project knowledge (from .break-free/notes — follow these)\n" + notes.map((n) => `### ${n.title} [${n.tags.join(", ")}]\n${n.body.trim().slice(0, 1200)}`).join("\n\n"));
    let out = parts.join("\n\n");
    if (out.length > maxChars) out = out.slice(0, maxChars) + "\n… (truncated)";
    return out;
  }
}

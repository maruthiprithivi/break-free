/**
 * Steward: the maintainer routine that keeps main "always updated" without a human remembering to.
 *   - absorb every worktree's ledger overlay into main
 *   - reconcile the worktree registry (merged / deleted / inactive) and surface overlaps
 *   - ledger hygiene: stale notes (paths that no longer exist), old done tasks, old journal files
 *   - optional archiving of the above (proposed by default, applied with archive:true)
 *   - refresh CODE-MAP.md, run the configured verify command on main, re-render HANDOFF.md
 * Runs from the `steward` MCP tool or `node dist/index.js --steward` (cron / launchd).
 */
import fs from "node:fs";
import path from "node:path";
import { Ledger, LEDGER_DIR, type Task } from "./ledger.js";
import type { GatewayConfig } from "./config.js";
import type { Workspace } from "./workspace.js";
import type { WorktreeRegistry } from "./worktrees.js";
import { buildCodeMap, writeCodeMap } from "./codemap.js";
import { runCommand, type CommandResult } from "./runcmd.js";

export interface HygieneReport {
  stale_notes: { slug: string; missing: string[] }[];
  old_done_tasks: string[];
  old_journal_files: string[];
  pending_worker_notes: string[];
  archived?: { tasks: string[]; journal: string[] };
}

const PATH_RE = /`([\w./-]+\.[a-z0-9]{1,6})`/g;

export function hygiene(config: GatewayConfig, ledger: Ledger, root: string, archive = false): HygieneReport {
  const rep: HygieneReport = { stale_notes: [], old_done_tasks: [], old_journal_files: [], pending_worker_notes: [] };
  const dayMs = 86_400_000;
  for (const n of ledger.listNotes()) {
    if (n.pending) rep.pending_worker_notes.push(n.slug);
    const missing = new Set<string>();
    for (const m of n.body.matchAll(PATH_RE)) {
      const p = m[1];
      if (p.includes("/") && !fs.existsSync(path.join(root, p))) missing.add(p);
    }
    if (missing.size) rep.stale_notes.push({ slug: n.slug, missing: [...missing] });
  }
  const cutoff = Date.now() - config.steward.archiveDoneAfterDays * dayMs;
  const old: Task[] = ledger.listTasks({ status: ["done", "cancelled"] }).filter((t) => Date.parse(t.updated) < cutoff);
  rep.old_done_tasks = old.map((t) => t.id);
  const jdir = path.join(ledger.dir, "journal");
  const jcut = new Date(Date.now() - config.steward.journalKeepDays * dayMs).toISOString().slice(0, 10);
  if (fs.existsSync(jdir)) rep.old_journal_files = fs.readdirSync(jdir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f) && f.slice(0, 10) < jcut).sort();
  if (archive) {
    const archived = { tasks: [] as string[], journal: [] as string[] };
    const tdir = path.join(ledger.dir, "tasks", "archive");
    fs.mkdirSync(tdir, { recursive: true });
    for (const t of old) {
      const f = path.join(ledger.dir, "tasks", `${t.id}.md`);
      if (fs.existsSync(f)) { fs.renameSync(f, path.join(tdir, `${t.id}.md`)); archived.tasks.push(t.id); }
    }
    const jarch = path.join(jdir, "archive");
    if (rep.old_journal_files.length) fs.mkdirSync(jarch, { recursive: true });
    for (const f of rep.old_journal_files) { fs.renameSync(path.join(jdir, f), path.join(jarch, f)); archived.journal.push(f); }
    rep.archived = archived;
  }
  return rep;
}

export interface StewardReport {
  at: string;
  absorbed: string;
  worktrees: { total: number; active: number; inactive: number; merged: number; deleted: number; overlaps: number; removable: string[] };
  hygiene: HygieneReport;
  code_map?: { files: number; modules: number } | { error: string };
  verify?: CommandResult | { skipped: string };
  handoff: string;
}

export async function runSteward(opts: { config: GatewayConfig; ledger: Ledger; workspace: Workspace; worktrees: WorktreeRegistry; absorb: () => string; archive?: boolean; codeMap?: boolean; verify?: boolean }): Promise<StewardReport> {
  const { config, ledger, workspace, worktrees } = opts;
  if (ledger.isShadow) throw new Error("steward runs on the main checkout");
  if (!ledger.exists()) ledger.init();
  const absorbed = opts.absorb() || "nothing new";
  const rows = worktrees.available() ? worktrees.list() : [];
  const overlaps = worktrees.available() ? worktrees.conflicts() : [];
  const removable = rows.filter((w) => !w.isMain && w.status === "merged" && fs.existsSync(w.path)).map((w) => w.name);
  const hyg = hygiene(config, ledger, workspace.root, opts.archive);
  const rep: StewardReport = {
    at: new Date().toISOString(),
    absorbed,
    worktrees: { total: rows.length, active: rows.filter((w) => w.status === "active").length, inactive: rows.filter((w) => w.status === "inactive").length, merged: rows.filter((w) => w.status === "merged").length, deleted: rows.filter((w) => w.status === "deleted").length, overlaps: overlaps.length, removable },
    hygiene: hyg,
    handoff: path.join(LEDGER_DIR, "HANDOFF.md"),
  };
  if (opts.codeMap !== false) {
    try { const m = await buildCodeMap(workspace); writeCodeMap(workspace, m); rep.code_map = { files: m.files, modules: Object.keys(m.modules).length }; } catch (e) { rep.code_map = { error: String((e as Error).message) }; }
  }
  if (opts.verify !== false) {
    if (config.steward.verify) { try { rep.verify = await runCommand(config, workspace.root, config.steward.verify); } catch (e) { rep.verify = { skipped: String((e as Error).message) }; } }
    else rep.verify = { skipped: "steward.verify not configured" };
  }
  if (worktrees.available()) { try { fs.writeFileSync(path.join(ledger.dir, "WORKTREES.md"), worktrees.render()); } catch { /* ignore */ } }
  const v = rep.verify && "ok" in rep.verify ? (rep.verify.ok ? "verify PASSED" : `verify FAILED (exit ${rep.verify.exitCode})`) : "verify skipped";
  ledger.journal(`steward: absorbed ${absorbed}; worktrees ${rep.worktrees.active} active/${rep.worktrees.merged} merged/${rep.worktrees.deleted} deleted, ${overlaps.length} overlap(s), ${removable.length} removable; hygiene: ${hyg.stale_notes.length} stale note(s), ${hyg.old_done_tasks.length} old task(s), ${hyg.pending_worker_notes.length} pending worker note(s)${hyg.archived ? ` (archived ${hyg.archived.tasks.length} tasks, ${hyg.archived.journal.length} journal files)` : ""}; ${v}`);
  ledger.render();
  return rep;
}

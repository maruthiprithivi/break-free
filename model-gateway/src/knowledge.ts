/**
 * The knowledge layer: where the ledger shows up outside the repository.
 *
 * The ledger is already the knowledge base — notes, tasks, journal, all Markdown with
 * frontmatter and [[wikilinks]] — and "open the folder as a vault" was the whole Obsidian
 * story. That leaves the wiring to the user. This finds the vault and does the wiring.
 *
 * Detection reads Obsidian's own vault registry rather than scanning the filesystem: the
 * registry is exact, costs one small JSON read, and cannot wander into directories nobody
 * asked it to look at. No registry, or no vault in it, means no Obsidian — silently. A
 * machine without Obsidian must not grow a warning about not having Obsidian.
 *
 * Nothing here ever copies the ledger. `link` symlinks it, so the repository stays the single
 * source of truth and a note edited in the vault is the same bytes git sees.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ObsidianMode = "link" | "index" | "off";

export interface VaultInfo {
  path: string;
  /** Obsidian's own "is this the vault currently open" flag, when it came from the registry. */
  open: boolean;
  source: "config" | "env" | "registry";
}

/** Obsidian's vault registry, per platform. */
export function registryPath(home = os.homedir(), platform = process.platform): string {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  if (platform === "win32") return path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "obsidian", "obsidian.json");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "obsidian", "obsidian.json");
}

/**
 * Vaults Obsidian knows about. A missing, unreadable or malformed registry means "no vaults",
 * never an error: this is an optional integration and it may not be installed at all.
 */
export function registryVaults(home = os.homedir(), platform = process.platform): VaultInfo[] {
  try {
    const raw = fs.readFileSync(registryPath(home, platform), "utf8");
    const vaults = (JSON.parse(raw) as { vaults?: Record<string, { path?: string; open?: boolean }> }).vaults ?? {};
    return Object.values(vaults)
      .filter((v): v is { path: string; open?: boolean } => typeof v.path === "string" && fs.existsSync(v.path))
      .map((v) => ({ path: v.path, open: !!v.open, source: "registry" as const }));
  } catch {
    return [];
  }
}

export interface KnowledgeConfig {
  obsidian: { vault?: string; mode: ObsidianMode; folder: string };
}

/**
 * The vault to use: an explicit path wins, then OBSIDIAN_VAULT, then the registry — preferring
 * the vault Obsidian currently has open when there is more than one, because that is the one
 * the user is looking at.
 */
export function resolveVault(cfg: KnowledgeConfig, env: NodeJS.ProcessEnv = process.env): VaultInfo | undefined {
  if (cfg.obsidian.mode === "off") return undefined;
  if (cfg.obsidian.vault) {
    const p = cfg.obsidian.vault.replace(/^~(?=$|\/)/, os.homedir());
    return fs.existsSync(p) ? { path: p, open: false, source: "config" } : undefined;
  }
  if (env.OBSIDIAN_VAULT && fs.existsSync(env.OBSIDIAN_VAULT)) return { path: env.OBSIDIAN_VAULT, open: false, source: "env" };
  const found = registryVaults();
  return found.find((v) => v.open) ?? found[0];
}

export interface LinkResult {
  mode: ObsidianMode;
  vault: string;
  /** Where the ledger now appears inside the vault. */
  target: string;
  action: "linked" | "already-linked" | "indexed" | "skipped";
  reason?: string;
}

/**
 * Surface a repository's ledger inside a vault.
 *
 * `link` symlinks the ledger in, so edits in either place are the same file. `index` writes one
 * note pointing at it, for people who would rather not have repository folders inside a vault.
 *
 * It refuses rather than overwrites: anything already at the target that is not our own link to
 * this same ledger is left exactly as it is. A vault is someone's notes, and losing them to an
 * integration nobody asked for would be far worse than a skipped step.
 */
export function linkLedger(vault: string, project: string, ledgerDir: string, cfg: KnowledgeConfig): LinkResult {
  const mode = cfg.obsidian.mode;
  const dir = path.join(vault, cfg.obsidian.folder);
  const target = mode === "index" ? path.join(dir, `${project}.md`) : path.join(dir, project);
  const base: Omit<LinkResult, "action"> = { mode, vault, target };

  if (mode === "off") return { ...base, action: "skipped", reason: "obsidian mode is off" };
  if (!fs.existsSync(ledgerDir)) return { ...base, action: "skipped", reason: `no ledger at ${ledgerDir}` };

  fs.mkdirSync(dir, { recursive: true });

  if (mode === "index") {
    fs.writeFileSync(target, indexNote(project, ledgerDir));
    return { ...base, action: "indexed" };
  }

  // lstat, not existsSync: a symlink pointing at a deleted ledger still exists as a link.
  let current: fs.Stats | undefined;
  try { current = fs.lstatSync(target); } catch { /* nothing there, which is the easy case */ }
  if (current) {
    if (current.isSymbolicLink() && path.resolve(fs.readlinkSync(target)) === path.resolve(ledgerDir)) {
      return { ...base, action: "already-linked" };
    }
    return { ...base, action: "skipped", reason: `${target} already exists and is not our link — left untouched` };
  }
  fs.symlinkSync(path.resolve(ledgerDir), target, "dir");
  return { ...base, action: "linked" };
}

function indexNote(project: string, ledgerDir: string): string {
  return [
    "---",
    `title: ${project}`,
    "tags: [break-free]",
    "---",
    `# ${project}`,
    "",
    `The ledger for this project lives in the repository, at \`${ledgerDir}\`.`,
    "",
    "It holds the task board, the decisions and gotchas every delegated worker is given, and",
    "the journal. It is committed with the code, so it moves with the branch rather than with",
    "this vault.",
    "",
    `- Board: \`${path.join(ledgerDir, "PLAN.md")}\``,
    `- Handoff: \`${path.join(ledgerDir, "HANDOFF.md")}\``,
    `- Notes: \`${path.join(ledgerDir, "notes")}\``,
    "",
    "_Written by break-free. Editing this note is safe; it is rewritten on the next link._",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- the code graph

/**
 * Tool names a code-graph service tends to expose. Detection is by SHAPE, never by server
 * name: a name is not a contract and the same capability ships under many of them.
 *
 * Two matches are required. One is too easy — plenty of servers expose a lone `search_code`
 * and cannot answer a single structural question.
 */
const GRAPH_SIGNATURE = ["search_graph", "trace_path", "query_graph", "get_architecture", "get_code_snippet", "index_repository"];

export function looksLikeGraphServer(toolNames: string[]): boolean {
  // Hosts prefix bridged tools (`server__tool`), so compare on the bare name.
  const bare = new Set(toolNames.map((n) => n.toLowerCase().replace(/^.*__/, "")));
  return GRAPH_SIGNATURE.filter((sig) => bare.has(sig)).length >= 2;
}

/** Just enough of the MCP bridge to resolve a provider, so this is testable without MCP. */
export interface GraphProbe {
  servers(): string[];
  toolNames(server: string): Promise<string[]>;
}

export interface GraphResolution {
  /** "builtin" or the name of an MCP server that answers structural questions. */
  provider: string;
  reason: string;
  /** True when a real graph service is in play, rather than the regex import map. */
  external: boolean;
}

/**
 * Which code graph answers structural questions.
 *
 * `builtin` is always available and is the floor: `code_map` must answer even when nothing else
 * is installed. An explicitly named server that cannot be reached is an ERROR rather than a
 * quiet fall back to the import map — a silent downgrade to something far weaker is the exact
 * class of failure the tier floor exists to prevent, and it is worse here because nothing in
 * the answer would say the graph was guessed from regexes.
 */
export async function resolveGraph(provider: string, probe: GraphProbe): Promise<GraphResolution> {
  if (provider === "builtin") return { provider: "builtin", reason: "configured", external: false };

  if (provider !== "auto") {
    const names = probe.servers();
    if (!names.includes(provider)) throw new Error(`knowledge.graph.provider is "${provider}", but no such MCP server is available. Set it to "auto" or "builtin", or fix the server — falling back silently would answer structural questions from regex import edges without saying so.`);
    return { provider, reason: "configured", external: true };
  }

  for (const name of probe.servers()) {
    let tools: string[];
    try {
      tools = await probe.toolNames(name);
    } catch {
      continue; // a server that will not answer cannot be the graph
    }
    if (looksLikeGraphServer(tools)) return { provider: name, reason: "detected by tool signature", external: true };
  }
  return { provider: "builtin", reason: "no graph service detected", external: false };
}

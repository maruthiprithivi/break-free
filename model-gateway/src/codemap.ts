/**
 * Lightweight code graph: internal import edges + exported symbols per module,
 * rendered to .break-free/CODE-MAP.md (Mermaid graph + symbol index). Cheap,
 * dependency-free, good enough to orient a worker or a fresh session quickly.
 * Languages: TS/JS (import/require), Python (import/from), Go (import), Rust (mod/use crate::).
 */
import fs from "node:fs";
import path from "node:path";
import { Workspace } from "./workspace.js";
import { LEDGER_DIR } from "./ledger.js";

export interface CodeMap {
  files: number;
  modules: Record<string, { imports: string[]; symbols: string[]; lines: number }>;
  dirs: Record<string, number>;
  hubs: { module: string; importedBy: number }[];
  markdown: string;
}

const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/;

export async function buildCodeMap(ws: Workspace, opts: { maxFiles?: number; include?: string } = {}): Promise<CodeMap> {
  let files: string[];
  try {
    files = (await ws.git(["ls-files", "--cached", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  } catch {
    files = [];
    const stack = [ws.root];
    while (stack.length && files.length < 20_000) {
      const d = stack.pop()!;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if ([".git", "node_modules", ".venv", "dist", "build", "target", "__pycache__"].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else files.push(path.relative(ws.root, p).split(path.sep).join("/"));
      }
    }
  }
  files = files.filter((f) => EXT.test(f) && !ws.isDenied(f) && !/(^|\/)(node_modules|dist|build|target|vendor|\.venv|__pycache__|coverage)\//.test(f) && !/\.(test|spec)\.[jt]sx?$|_test\.go$|(^|\/)test_.*\.py$/.test(f));
  if (opts.include) files = files.filter((f) => f.includes(opts.include!));
  files = files.slice(0, opts.maxFiles ?? 2000);

  const modules: CodeMap["modules"] = {};
  const dirs: Record<string, number> = {};
  const modOf = (f: string) => f.replace(EXT, "");
  const known = new Set(files.map(modOf));
  for (const f of files) {
    let src: string;
    try {
      const st = fs.lstatSync(path.join(ws.root, f));
      if (!st.isFile() || st.size > 1_500_000) continue;
      src = fs.readFileSync(path.join(ws.root, f), "utf8");
    } catch {
      continue;
    }
    const dir = path.posix.dirname(f);
    dirs[dir] = (dirs[dir] ?? 0) + 1;
    const imports = new Set<string>();
    const symbols: string[] = [];
    const lang = f.match(EXT)![1];
    if (/^(ts|tsx|js|jsx|mjs|cjs)$/.test(lang)) {
      for (const m of src.matchAll(/(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]|require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
        const spec = (m[1] ?? m[2]).replace(/\.(js|mjs|cjs|ts|tsx|jsx)$/, "");
        const target = path.posix.normalize(path.posix.join(dir, spec));
        for (const cand of [target, `${target}/index`]) if (known.has(cand)) { imports.add(cand); break; }
      }
      for (const m of src.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) symbols.push(m[1]);
    } else if (lang === "py") {
      for (const m of src.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
        const mod = (m[1] ?? m[2]).replace(/\./g, "/");
        for (const cand of [mod, `${mod}/__init__`, path.posix.join(dir, mod), path.posix.join(dir, mod, "__init__")]) if (known.has(cand)) { imports.add(cand); break; }
      }
      for (const m of src.matchAll(/^(?:def|class)\s+([A-Za-z_]\w*)/gm)) if (!m[1].startsWith("_")) symbols.push(m[1]);
    } else if (lang === "go") {
      for (const m of src.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm)) symbols.push(m[1]);
      for (const m of src.matchAll(/^type\s+([A-Z]\w*)/gm)) symbols.push(m[1]);
      // Go imports are package-level; map by directory
      for (const m of src.matchAll(/"([^"]+)"/g)) {
        const seg = m[1].split("/").slice(-2).join("/");
        for (const k of known) if (k.startsWith(seg + "/") || path.posix.dirname(k) === seg) { imports.add(path.posix.dirname(k)); break; }
      }
    } else if (lang === "rs") {
      for (const m of src.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_]\w*)/gm)) symbols.push(m[1]);
      for (const m of src.matchAll(/^\s*(?:pub\s+)?mod\s+(\w+);|use\s+crate::(\w+)/gm)) {
        const mod = m[1] ?? m[2];
        for (const cand of [path.posix.join(dir, mod), path.posix.join(dir, mod, "mod"), `src/${mod}`, `src/${mod}/mod`]) if (known.has(cand)) { imports.add(cand); break; }
      }
    }
    modules[modOf(f)] = { imports: [...imports].sort(), symbols: [...new Set(symbols)].slice(0, 60), lines: src.split("\n").length };
  }
  const importedBy: Record<string, number> = {};
  for (const m of Object.values(modules)) for (const i of m.imports) importedBy[i] = (importedBy[i] ?? 0) + 1;
  const hubs = Object.entries(importedBy).map(([module, n]) => ({ module, importedBy: n })).sort((a, b) => b.importedBy - a.importedBy).slice(0, 15);

  // ---- markdown
  const names = Object.keys(modules).sort();
  const id = (m: string) => "n" + m.replace(/[^A-Za-z0-9]/g, "_");
  const graphNodes = names.slice(0, 150);
  const nodeSet = new Set(graphNodes);
  const md = [
    "# Code map",
    "",
    `_Generated ${new Date().toISOString()} by \`code_map\` — ${files.length} source files, ${names.length} modules. Regenerate after large refactors._`,
    "",
    "## Directories",
    ...Object.entries(dirs).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([d, n]) => `- \`${d}/\` — ${n} file(s)`),
    "",
    "## Most depended-on modules",
    ...(hubs.length ? hubs.map((h) => `- \`${h.module}\` ← imported by ${h.importedBy}`) : ["- (no internal imports detected)"]),
    "",
    "## Import graph" + (names.length > 150 ? " (first 150 modules)" : ""),
    "```mermaid",
    "graph LR",
    ...graphNodes.map((m) => `  ${id(m)}["${m}"]`),
    ...graphNodes.flatMap((m) => modules[m].imports.filter((i) => nodeSet.has(i)).map((i) => `  ${id(m)} --> ${id(i)}`)),
    "```",
    "",
    "## Modules",
    ...names.map((m) => `- \`${m}\` (${modules[m].lines} lines)${modules[m].symbols.length ? `: ${modules[m].symbols.slice(0, 25).join(", ")}${modules[m].symbols.length > 25 ? ", …" : ""}` : ""}${modules[m].imports.length ? `\n  - imports: ${modules[m].imports.map((i) => `\`${i}\``).join(", ")}` : ""}`),
    "",
  ].join("\n");
  return { files: files.length, modules, dirs, hubs, markdown: md };
}

export function writeCodeMap(ws: Workspace, map: CodeMap): string {
  const dir = path.join(ws.root, LEDGER_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "CODE-MAP.md");
  fs.writeFileSync(f, map.markdown);
  return f;
}

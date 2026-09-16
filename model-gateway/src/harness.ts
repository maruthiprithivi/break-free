/**
 * Give delegated workers the same standing context the orchestrating harness has:
 *   - project instructions: <workspace>/CLAUDE.md, AGENTS.md, .claude/CLAUDE.md, .claude/rules/*.md
 *   - named skills: SKILL.md from .claude/skills, .agents/skills (project), then ~/.claude/skills, ~/.agents/skills (user)
 * Everything is size-capped and clearly labelled so the worker knows it is reading house rules, not the task.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface HarnessContext {
  text: string;
  sources: string[];
}

function readCapped(file: string, cap: number): string | undefined {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return undefined;
    const s = fs.readFileSync(file, "utf8");
    return s.length > cap ? s.slice(0, cap) + `\n… (truncated at ${cap} chars)` : s;
  } catch {
    return undefined;
  }
}

export function findSkill(root: string, name: string): string | undefined {
  if (!/^[\w.-]+$/.test(name)) return undefined;
  const dirs = [
    path.join(root, ".claude", "skills", name, "SKILL.md"),
    path.join(root, ".agents", "skills", name, "SKILL.md"),
    path.join(os.homedir(), ".claude", "skills", name, "SKILL.md"),
    path.join(os.homedir(), ".agents", "skills", name, "SKILL.md"),
  ];
  return dirs.find((f) => fs.existsSync(f));
}

export function collectHarnessContext(root: string, opts: { projectInstructions: boolean; skills: string[]; maxChars: number }): HarnessContext {
  const parts: string[] = [];
  const sources: string[] = [];
  let budget = opts.maxChars;
  const take = (label: string, file: string, cap: number) => {
    if (budget <= 0) return;
    const body = readCapped(file, Math.min(cap, budget));
    if (!body?.trim()) return;
    budget -= body.length;
    parts.push(`### ${label} (${path.relative(root, file).startsWith("..") ? file.replace(os.homedir(), "~") : path.relative(root, file)})\n${body.trim()}`);
    sources.push(path.relative(root, file).startsWith("..") ? file.replace(os.homedir(), "~") : path.relative(root, file));
  };
  if (opts.projectInstructions) {
    for (const f of ["CLAUDE.md", "AGENTS.md", path.join(".claude", "CLAUDE.md")]) take("Project instructions", path.join(root, f), 12_000);
    const rules = path.join(root, ".claude", "rules");
    if (fs.existsSync(rules)) for (const f of fs.readdirSync(rules).filter((x) => x.endsWith(".md")).sort()) take("Project rule", path.join(rules, f), 4_000);
  }
  for (const name of opts.skills) {
    const f = findSkill(root, name);
    if (f) take(`Skill: ${name}`, f, 16_000);
    else parts.push(`### Skill: ${name}\n(not found in .claude/skills, .agents/skills or the user skill folders)`);
  }
  if (!parts.length) return { text: "", sources };
  return {
    text: [
      "## Standing context from the orchestrator's harness",
      "The orchestrating agent works under these instructions and skills; follow them as if they were addressed to you (they take precedence over generic habits, but the Task below takes precedence over them where they conflict).",
      ...parts,
    ].join("\n\n"),
    sources,
  };
}

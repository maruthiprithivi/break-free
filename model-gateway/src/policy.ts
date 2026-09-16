/**
 * Policy rules enforced by the gateway (config.policy.rules), never by prompt text.
 *
 *   { match: "src/auth/**",   action: "review", reason: "auth code needs a second vendor's eyes" }
 *   { match: ["**\/*.pem", "infra/prod/**"], action: "deny", reason: "never delegated" }
 *
 * deny   → the paths are added to the worker's jail deny-list for that call (unreadable, unwritable)
 * review → after the worker finishes, files it changed are matched; any hit triggers an automatic
 *          independent review (different vendor unless differentVendor:false); a reject fails the task.
 */
import fs from "node:fs";
import path from "node:path";
import type { GatewayConfig } from "./config.js";
import { resolveCandidates } from "./router.js";
import type { Workspace } from "./workspace.js";

export interface PolicyRule { match: string[]; action: "deny" | "review"; reason?: string; differentVendor: boolean }

export function policyRules(config: GatewayConfig): PolicyRule[] {
  return config.policy.rules.map((r) => ({ match: Array.isArray(r.match) ? r.match : [r.match], action: r.action, reason: r.reason, differentVendor: r.differentVendor }));
}

export function globToRegex(g: string): RegExp {
  const re = g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "(.*/)?").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".");
  return new RegExp(g.includes("/") ? `^${re}$` : `(^|/)${re}$`, "i");
}

export function denyPatterns(config: GatewayConfig): string[] {
  return policyRules(config).filter((r) => r.action === "deny").flatMap((r) => r.match);
}

export function reviewHits(config: GatewayConfig, changed: string[]): { path: string; rule: PolicyRule }[] {
  const rules = policyRules(config).filter((r) => r.action === "review");
  const out: { path: string; rule: PolicyRule }[] = [];
  for (const p of changed) for (const rule of rules) if (rule.match.some((g) => globToRegex(g).test(p))) { out.push({ path: p, rule }); break; }
  return out;
}

/** Snapshot of the working tree state (status + path) so we can tell what a worker changed. */
export async function treeSnapshot(ws: Workspace): Promise<Set<string>> {
  try {
    const out = await ws.git(["status", "--porcelain", "--untracked-files=all"]);
    const set = new Set<string>();
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // status alone misses edits to files that were already modified/untracked: key on size+mtime too
      const p = line.slice(3).replace(/^"(.*)"$/, "$1").split(" -> ").pop()!;
      let sig = "";
      try { const st = fs.statSync(path.join(ws.root, p)); sig = `${st.size}:${Math.round(st.mtimeMs)}`; } catch { /* deleted */ }
      set.add(`${line} ${sig}`);
    }
    // include HEAD so commits made by the worker count as changes too
    set.add(`HEAD ${await ws.git(["rev-parse", "HEAD"]).catch(() => "")}`);
    return set;
  } catch {
    return new Set();
  }
}

/** Paths whose status changed between two snapshots, plus files in commits made in between. */
export async function changedSince(ws: Workspace, before: Set<string>): Promise<string[]> {
  const after = await treeSnapshot(ws);
  const paths = new Set<string>();
  for (const line of after) {
    if (line.startsWith("HEAD ")) continue;
    if (!before.has(line)) paths.add(line.slice(3).replace(/ \S*$/, "").replace(/^"(.*)"$/, "$1").split(" -> ").pop()!);
  }
  const headBefore = [...before].find((l) => l.startsWith("HEAD "))?.slice(5);
  const headAfter = [...after].find((l) => l.startsWith("HEAD "))?.slice(5);
  if (headBefore && headAfter && headBefore !== headAfter) {
    try { for (const p of (await ws.git(["diff", "--name-only", headBefore, headAfter])).split("\n")) if (p.trim()) paths.add(p.trim()); } catch { /* ignore */ }
  }
  return [...paths].sort();
}

/** Reviewer spec whose provider differs from the worker's, or undefined if none is usable. */
export function pickDifferentVendorReviewer(config: GatewayConfig, workerSpec: string, preferred?: string): { spec: string; differentVendor: boolean } {
  const workerProvider = workerSpec.split("/")[0];
  const cands = resolveCandidates(config, preferred ?? config.defaults.reviewer).filter((c) => !c.provider.unusableReason);
  const other = cands.find((c) => c.provider.name !== workerProvider);
  if (other) return { spec: other.spec, differentVendor: true };
  // widen: any usable provider except the worker's
  for (const alias of ["strong", "fast"]) {
    const c = resolveCandidates(config, alias).find((x) => !x.provider.unusableReason && x.provider.name !== workerProvider);
    if (c) return { spec: c.spec, differentVendor: true };
  }
  return { spec: cands[0]?.spec ?? config.defaults.reviewer, differentVendor: false };
}

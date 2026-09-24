/**
 * Every tool a shipped instruction tells the agent to call must be one it can actually reach.
 *
 * #82 was the turn-end guard naming a tool the compact profile hid, and the session could not
 * end. The standing rules had the same defect quietly: the CLAUDE.md delegation rule told every
 * session to call worktree_register, worktree_update, worktree_handoff, task_update, note_write
 * and note_review - none advertised under the default compact profile - and never said how to
 * reach them. Hidden operations are reachable, through bf_invoke; an instruction that names one
 * has to say so.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.join(here, "..", "..");
const entry = path.join(here, "..", "dist", "index.js");

let tmp, advertised, operations;
const fields = new Set();
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reach-"));
  const ws = path.join(tmp, "repo");
  fs.mkdirSync(ws);
  const cfg = path.join(tmp, "config.json");
  fs.writeFileSync(cfg, JSON.stringify({ sessionDir: path.join(tmp, "s"), logFile: false, context: { toolProfile: "compact" }, providers: {} }));
  const c = new Client({ name: "reach", version: "1" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", cfg] }));
  const listedTools = (await c.listTools()).tools;
  advertised = new Set(listedTools.map((t) => t.name));
  const collect = (o) => { if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (k === "properties" && v && typeof v === "object") for (const f of Object.keys(v)) fields.add(f); collect(v); } };
  for (const t of listedTools) collect(t.inputSchema);
  const listed = JSON.parse((await c.callTool({ name: "bf_discover", arguments: {} })).content.map((x) => x.text).join(""));
  operations = new Set([...advertised, ...listed.operations.map((o) => o.operation)]);
  await c.close();
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Everything the installer ships that an agent reads as an instruction. */
function shipped() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(snippet|md)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(repo, "agent-config"));
  return out;
}

test("an instruction that names a hidden operation also says how to reach it", () => {
  const offenders = [];
  for (const file of shipped()) {
    const text = fs.readFileSync(file, "utf8");
    const named = [...new Set([...text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)].map((m) => m[1]))];
    const hidden = named.filter((n) => operations.has(n) && !advertised.has(n));
    if (hidden.length && !text.includes("bf_invoke")) offenders.push(`${path.relative(repo, file)}: ${hidden.join(", ")}`);
  }
  assert.deepEqual(offenders, [], `these tell the agent to call tools it cannot see, and never mention bf_invoke:\n  ${offenders.join("\n  ")}`);
});

test("an instruction never names an operation that does not exist at all", () => {
  // Not every snake_case name is an MCP operation. Worker-side tools (what a delegated model can
  // call, defined in orchestrate.ts) and schema fields (review's task_description) are legitimate
  // references - both derived from the code, so a rename there still fails here.
  const workerTools = new Set([...fs.readFileSync(path.join(here, "..", "src", "orchestrate.ts"), "utf8").matchAll(/function: \{ name: "([a-z_]+)"/g)].map((m) => m[1]));
  const unknown = [];
  for (const file of shipped()) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/`(worktree_[a-z_]+|task_[a-z_]+|note_[a-z_]+|job_[a-z_]+|fleet_[a-z_]+|ledger_[a-z_]+)`/g)) {
      if (!operations.has(m[1]) && !workerTools.has(m[1]) && !fields.has(m[1])) unknown.push(`${path.relative(repo, file)}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(unknown)], [], "renamed or removed operations are still named in shipped instructions");
});

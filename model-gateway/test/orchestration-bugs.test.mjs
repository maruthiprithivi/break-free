// End-to-end regression tests for two reported bugs in the plan/verify area:
//   #16 `verify` ran at the workspace root but never said so, so a command written for a package
//       subdirectory (a monorepo) read as a broken suite instead of a wrong cwd. It must run where
//       the worker's files are — the workspace root, not wherever the gateway process was launched —
//       and a failure must name that directory and the command.
//   #17 re-running a plan minted a second ledger task for the same work and left the first one
//       blocked forever, so `ledger_resume` handed the next session false blockers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockProvider } from "./mock-provider.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const entry = path.join(here, "..", "dist", "index.js");

let mock, client, tmp, ws, launchedFrom;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  return { text, isError: !!r.isError, json: () => JSON.parse(text) };
};
// The gateway appends its structured metadata after the report; run_plan's is the last "meta: line".
const metaOf = (text) => JSON.parse(text.split("\nmeta: ").pop());
const taskFiles = () => (fs.existsSync(path.join(ws, ".break-free", "tasks")) ? fs.readdirSync(path.join(ws, ".break-free", "tasks")).sort() : []);
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

before(async () => {
  mock = await startMockProvider();
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mg-orch-")));
  ws = path.join(tmp, "repo");
  launchedFrom = path.join(tmp, "launched-from");
  fs.mkdirSync(path.join(ws, "pkg"), { recursive: true });
  fs.mkdirSync(launchedFrom, { recursive: true });
  fs.writeFileSync(path.join(ws, "ok.mjs"), 'console.log("root ok");\n');
  fs.writeFileSync(path.join(ws, "bad.mjs"), 'console.log("boom"); process.exit(3);\n');
  // The monorepo case: an acceptance command that only makes sense inside the package subdirectory.
  fs.writeFileSync(path.join(ws, "pkg", "check.mjs"), 'console.log("pkg ok");\n');
  // Lives only in the directory the gateway process is launched from, never in the workspace.
  fs.writeFileSync(path.join(launchedFrom, "launcher-only.mjs"), 'console.log("launcher cwd");\n');
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });

  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    context: { toolProfile: "full" },
    logFile: false,
    sessionDir: path.join(tmp, "sessions"),
    defaults: { model: "mock/good", reviewer: "mock/good", supervisor: "mock/good", timeoutMs: 8000 },
    fallback: { chain: ["mock/good"], retriesPerCandidate: 0, retryDelayMs: 0 },
    providers: { mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" } },
    workers: { allowedCommands: ["node"], maxConcurrency: 2 },
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--workspace", ws, "--config", configPath],
    // Deliberately NOT the workspace: verify must resolve against the workspace, not the process cwd.
    cwd: launchedFrom,
    env: { ...process.env },
    stderr: "pipe",
  });
  client = new Client({ name: "orchestration-bugs", version: "0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await mock?.close();
});

test("#16: verify runs in the workspace root, not the directory the gateway was launched from", async () => {
  const ok = await call("delegate", { task: "do it", model: "mock/good", verify: "node ok.mjs" });
  assert.match(ok.text, /Gateway verification \(`node ok\.mjs`\): PASSED/, ok.text);

  const stray = await call("delegate", { task: "do it", model: "mock/good", verify: "node launcher-only.mjs" });
  const v = metaOf(stray.text).verify;
  assert.equal(v.ok, false, "the launcher's script must not be reachable");
  assert.equal(v.cwd, ws, "verify resolves against the workspace root, never the gateway process cwd");
});

test("#16: a verify failure names the command and the directory it ran in", async () => {
  const r = await call("delegate", { task: "do it", model: "mock/good", verify: "node bad.mjs" });
  assert.match(r.text, /FAILED \(exit 3/, r.text);
  assert.match(r.text, new RegExp(`## Gateway verification \\(\`node bad\\.mjs\`\\): FAILED \\(exit 3, \\d+ ms\\) in ${re(ws)}`), r.text);
  assert.equal(metaOf(r.text).verify.cwd, ws);

  // The monorepo case from the issue: the command belongs to pkg/, so it fails at the root — and the
  // report has to say which directory it ran in, or the reader blames the command instead of the cwd.
  const sub = await call("delegate", { task: "do it", model: "mock/good", verify: "node check.mjs" });
  assert.match(sub.text, /FAILED \(exit 1/, sub.text);
  assert.match(sub.text, new RegExp(`in ${re(ws)}\n`), sub.text);
  assert.equal(metaOf(sub.text).verify.cwd, ws);

  // The plan report is where a failed verification is read, so it carries the same two facts.
  const plan = await call("run_plan", { track: false, tasks: [{ id: "api", task: "do it", model: "mock/good", verify: "node bad.mjs" }] });
  assert.match(plan.text, new RegExp(`verification failed: node bad\\.mjs \\(exit 3\\) in ${re(ws)}`), plan.text);
  assert.equal(metaOf(plan.text).results[0].verify.cwd, ws);
});

test("#17: re-running a plan reuses the ledger task and closes the blocked attempt", async () => {
  const before = taskFiles().length;
  const first = await call("run_plan", { track: true, goal: "ship the widget", tasks: [{ id: "widget", task: "build the widget", model: "mock/good", verify: "node bad.mjs" }] });
  const ledgerId = metaOf(first.text).results[0].ledger_id;
  assert.equal(metaOf(first.text).results[0].status, "failed", first.text);
  assert.equal(taskFiles().length, before + 1, "the first run tracks the task");
  assert.equal((await call("task_get", { id: ledgerId })).json().status, "blocked");
  const owned = fs.readFileSync(path.join(ws, ".break-free", "tasks", `${ledgerId}.md`), "utf8");
  assert.match(owned, /^plan: ship the widget$/m, "the ledger records the plan identity a re-run matches on");
  assert.match(owned, /^plan_task: widget$/m);

  // Re-running the same plan is the lead retrying, not a second unit of work.
  const second = await call("run_plan", { goal: "ship the widget", tasks: [{ id: "widget", task: "build the widget", model: "mock/good", verify: "node ok.mjs" }] });
  const m2 = metaOf(second.text);
  assert.equal(m2.ok, true, second.text);
  assert.equal(m2.results[0].ledger_id, ledgerId, "the re-run must reuse the tracked task");
  assert.equal(taskFiles().length, before + 1, "no second ledger task for the same plan task");
  const t = (await call("task_get", { id: ledgerId })).json();
  assert.equal(t.status, "done", JSON.stringify(t));
  assert.equal(t.verify, "node ok.mjs", "the reused task takes the re-run's acceptance command");
  assert.ok(t.log.some((l) => /closes the earlier blocked attempt \(re-run of plan task widget in "ship the widget"\)/.test(l)), JSON.stringify(t.log));
  // Read the record itself, not task_get's Outcome section: a worker report that embeds a markdown
  // heading truncates that section, so the ledger file is where the verification line is visible.
  const closedRecord = fs.readFileSync(path.join(ws, ".break-free", "tasks", `${ledgerId}.md`), "utf8");
  assert.match(closedRecord, new RegExp(`^Verification: PASSED \\(node ok\\.mjs in ${re(ws)}\\)$`, "m"), closedRecord);
});

test("#17: the same task id in a different plan is a different task", async () => {
  const before = taskFiles().length;
  const alpha = await call("run_plan", { track: true, goal: "alpha", tasks: [{ id: "api", task: "do alpha", model: "mock/good" }] });
  const beta = await call("run_plan", { track: true, goal: "beta", tasks: [{ id: "api", task: "do beta", model: "mock/good" }] });
  const a = metaOf(alpha.text).results[0].ledger_id;
  const b = metaOf(beta.text).results[0].ledger_id;
  assert.notEqual(a, b, "goal + task id is the identity, so two goals must not share a ledger task");
  assert.equal(taskFiles().length, before + 2);
});

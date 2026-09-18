// End-to-end tests for named project modes: spawn the real MCP server over stdio
// against the mock provider and assert the GitHub policy through worker tools.
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

let mock;

before(async () => {
  mock = await startMockProvider();
});

after(async () => {
  await mock?.close();
});

const git = (args, cwd) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

async function startGateway(t, { config = {}, projectConfig = undefined } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-modes-"));
  const ws = path.join(tmp, "repo");
  const origin = path.join(tmp, "origin.git");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(origin, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", origin]);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  fs.writeFileSync(path.join(ws, "file.txt"), "hello\n");
  git(["add", "-A"], ws);
  git(["commit", "-q", "-m", "init"], ws);
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: ws });
  // Work on an ordinary feature branch so a refusal proves allowPush/mode, not protectedBranches.
  git(["checkout", "-q", "-b", "feat/x"], ws);
  fs.writeFileSync(path.join(ws, "feature.txt"), "feature\n");
  git(["add", "-A"], ws);
  git(["commit", "-q", "-m", "feature"], ws);
  if (projectConfig) fs.writeFileSync(path.join(ws, ".model-gateway.json"), JSON.stringify(projectConfig));

  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    logFile: false,
    sessionDir: path.join(tmp, "sessions"),
    defaults: { model: "mock/tooly", reviewer: "mock/good", supervisor: "mock/good", timeoutMs: 1500, maxSessionMessages: 8 },
    fallback: { chain: ["mock/good"], retriesPerCandidate: 0, retryDelayMs: 0 },
    providers: { mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" } },
    ...config,
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--workspace", ws, "--config", configPath],
    env: { ...process.env },
    stderr: "pipe",
  });
  const client = new Client({ name: "modes-test", version: "0" });
  await client.connect(transport);
  t.after(async () => { await client.close(); });

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join("\n");
    return { text, isError: !!r.isError, json: () => JSON.parse(text) };
  };

  const push = () => call("delegate", { task: "CALL git_push {}", model: "mock/tooly", capabilities: ["git"] });
  const merge = () => call("delegate", { task: 'CALL gh_merge_pr {"number":1,"method":"squash"}', model: "mock/tooly", capabilities: ["github"] });
  const close = async () => { await client.close(); };
  return { tmp, ws, origin, configPath, call, push, merge, close };
}

test("default config is guarded: push allowed on a feature branch, merge refused", async (t) => {
  const g = await startGateway(t);
  const push = await g.push();
  assert.equal(push.isError, false, push.text);
  assert.doesNotMatch(push.text, /disabled by config/);
  const pushedBranch = execFileSync("git", ["--git-dir", g.origin, "branch", "--list", "feat/x"], { encoding: "utf8" }).trim();
  assert.equal(pushedBranch, "feat/x", "ordinary feature branch should have been pushed");
  const merge = await g.merge();
  assert.match(merge.text, /PR merging disabled by config \(github\.allowMerge=false\)/);
});

test("mode local-only refuses git_push on an ordinary feature branch", async (t) => {
  const g = await startGateway(t, { config: { mode: "local-only" } });
  const push = await g.push();
  assert.match(push.text, /git push disabled by config \(github\.allowPush=false\)/);
  const remoteBranches = execFileSync("git", ["--git-dir", g.origin, "for-each-ref", "--format=%(refname)", "refs/heads"], { encoding: "utf8" }).trim();
  assert.equal(remoteBranches, "", "local-only must not create a remote branch");
});

test("mode pr-only allows push but refuses merge", async (t) => {
  const g = await startGateway(t, { config: { mode: "pr-only" } });
  const push = await g.push();
  assert.equal(push.isError, false, push.text);
  assert.doesNotMatch(push.text, /disabled by config/);
  assert.equal(execFileSync("git", ["--git-dir", g.origin, "branch", "--list", "feat/x"], { encoding: "utf8" }).trim(), "feat/x");
  const merge = await g.merge();
  assert.match(merge.text, /PR merging disabled by config \(github\.allowMerge=false\)/);
});

test("an explicit github.allowPush:false beats mode guarded", async (t) => {
  const g = await startGateway(t, { config: { mode: "guarded", github: { allowPush: false } } });
  const push = await g.push();
  assert.match(push.text, /git push disabled by config \(github\.allowPush=false\)/);
});

test("project .model-gateway.json mode is ignored", async (t) => {
  const g = await startGateway(t, { projectConfig: { mode: "local-only" } });
  const push = await g.push();
  assert.equal(push.isError, false, push.text);
  assert.equal(execFileSync("git", ["--git-dir", g.origin, "branch", "--list", "feat/x"], { encoding: "utf8" }).trim(), "feat/x");
});

test("project .model-gateway.json mergeAutonomy is ignored", async (t) => {
  const g = await startGateway(t, { projectConfig: { mergeAutonomy: true } });
  const merge = await g.merge();
  assert.match(merge.text, /PR merging disabled by config \(github\.allowMerge=false\)/);
});

// Crew aliases are the same chains wearing a second badge. If someone edits a core
// alias and the crew name stops matching, that is a silent routing bug: `ensign`
// would quietly point at a model `fast` no longer uses.
test("crew aliases resolve to exactly the chain they mirror", async () => {
  const { DEFAULT_ALIASES, CREW_ALIAS_MIRRORS } = await import("../dist/config.js");
  assert.deepEqual(Object.keys(CREW_ALIAS_MIRRORS).sort(), ["commander", "counselor", "ensign", "holodeck", "subspace"]);
  for (const [crew, core] of Object.entries(CREW_ALIAS_MIRRORS)) {
    assert.ok(DEFAULT_ALIASES[core], `core alias ${core} must still exist`);
    assert.deepEqual(DEFAULT_ALIASES[crew].candidates, DEFAULT_ALIASES[core].candidates, `${crew} must mirror ${core}`);
  }
  for (const core of ["fast", "strong", "reviewer", "local", "cloud"]) {
    assert.ok(DEFAULT_ALIASES[core], `${core} must not be renamed or removed`);
  }
});

// End-to-end tests for the scout task shape: read-only investigations whose
// requested capabilities are forced to ["read"].
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

let mock, client, tmp, ws, configPath, sessionDir;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join("\n");
  return { text, isError: !!r.isError, json: () => JSON.parse(text) };
};

const metaOf = (text) => JSON.parse(text.split("\nmeta: ").pop());

before(async () => {
  mock = await startMockProvider();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mg-scout-test-"));
  ws = path.join(tmp, "repo");
  sessionDir = path.join(tmp, "sessions");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  ws = fs.realpathSync(ws); // macOS: /var -> /private/var; the gateway realpaths its workspace root, so match it
  fs.writeFileSync(path.join(ws, "src", "app.js"), "export const answer = 42;\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: ws });

  configPath = path.join(tmp, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    sessionDir,
    logFile: path.join(tmp, "gateway.log"),
    defaults: { model: "tooly", reviewer: "mock/good", supervisor: "mock/good", timeoutMs: 1500, maxSessionMessages: 8 },
    fallback: { chain: ["mock/good"], retriesPerCandidate: 0, retryDelayMs: 0 },
    providers: {
      mock: { baseUrl: `http://127.0.0.1:${mock.port}/v1`, apiKey: "test-key" },
    },
    aliases: { tooly: ["mock/tooly"] },
    pricing: { "mock/tooly": { input: 100, output: 100 } },
    workers: { allowedCommands: ["node", "false"], maxConcurrency: 3 },
  }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "--workspace", ws, "--config", configPath],
    env: { ...process.env, DEEPSEEK_API_KEY: "" },
    stderr: "pipe",
  });
  client = new Client({ name: "scout-test", version: "0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  await mock?.close();
});

test("delegate with shape 'scout' cannot write even when write/run were requested", async () => {
  const r = await call("delegate", {
    task: 'CALL write_file {"path":"src/scout-delegate.txt","content":"should not exist"}',
    model: "tooly",
    shape: "scout",
    capabilities: ["read", "write", "run"],
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /unknown tool write_file/);
  assert.ok(!fs.existsSync(path.join(ws, "src", "scout-delegate.txt")), "scout must not create files");
  assert.equal(metaOf(r.text).shape, "scout");
});

test("delegate with shape 'scout' can still read a file", async () => {
  const r = await call("delegate", {
    task: 'CALL read_file {"path":"src/app.js"}',
    model: "tooly",
    shape: "scout",
    capabilities: ["read", "write", "run"],
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /answer = 42/);
  assert.equal(metaOf(r.text).shape, "scout");
});

test("delegate with shape 'ship' and identical capabilities can write", async () => {
  const r = await call("delegate", {
    task: 'CALL write_file {"path":"src/ship-delegate.txt","content":"ship wrote"}',
    model: "tooly",
    shape: "ship",
    capabilities: ["read", "write", "run"],
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /created src\/ship-delegate\.txt/);
  assert.equal(fs.readFileSync(path.join(ws, "src", "ship-delegate.txt"), "utf8"), "ship wrote");
  assert.equal(metaOf(r.text).shape, "ship");
});

test("run_plan task with shape 'scout' is clamped to read-only while read still works", async () => {
  const r = await call("run_plan", {
    track: false,
    tasks: [
      { id: "scout-read", task: 'CALL read_file {"path":"src/app.js"}', model: "tooly", shape: "scout", capabilities: ["read", "write", "run"] },
      { id: "scout-write", task: 'CALL write_file {"path":"src/plan-scout.txt","content":"should not exist"}', model: "tooly", shape: "scout", capabilities: ["read", "write", "run"] },
    ],
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /answer = 42/);
  assert.match(r.text, /unknown tool write_file/);
  assert.ok(!fs.existsSync(path.join(ws, "src", "plan-scout.txt")), "plan scout must not create files");
  const meta = metaOf(r.text);
  assert.deepEqual(meta.results.map((x) => [x.id, x.status]), [["scout-read", "done"], ["scout-write", "done"]]);
});

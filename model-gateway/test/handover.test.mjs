// Phase 3 of issue #12 — hand over a brief, not a transcript.
//
// Substituting a model mid-task by replaying the conversation hands a model a transcript written
// for another context window, in another tool-calling dialect — and the files already written are
// not in the transcript at all. What a substituted model needs is the TASK: the instruction, the
// acceptance criteria, what has been touched, and the last verification result, capped to its own
// context window.
//
// The `tooly` model in the shared mock is what makes "files already touched" observable: it calls
// the tool named in the prompt, so round 1 of a supervision writes a real file, and round 2 is the
// substitution that has to hand that fact over.
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

/** Far longer than the 400-token window configured below, so the cap has to bite. */
const LONG_ACCEPTANCE = Array.from({ length: 120 }, (_, i) => `${i + 1}. the limiter must refuse the ${i + 1}th request within the window`).join("\n");

const TASK = 'Write the limiter.\nCALL write_file {"path": "src/limiter.js", "content": "export const limit = 1;"}';

async function startGateway() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bf-handover-"));
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bf-handover-ws-")));
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws, "README.md"), "# repo\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: ws });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: ws });
  const baseUrl = `http://127.0.0.1:${mock.port}/v1`;
  const configPath = path.join(tmp, "config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      context: { toolProfile: "full" },
      sessionDir: path.join(tmp, "sessions"),
      logFile: false,
      defaults: { model: "strong", reviewer: "mock/good", supervisor: "mock/good", timeoutMs: 8000, maxToolIterations: 3 },
      // `mockbad` always 401s, so the chain substitutes; both providers answer as `tooly`, the
      // one model name the mock gives a tool-calling loop.
      providers: {
        mock: { baseUrl, apiKey: "test-key" },
        mockbad: { baseUrl, apiKey: "wrong", defaultModel: "tooly", contextTokens: 400 },
        mock2: { baseUrl, apiKey: "test-key", defaultModel: "tooly", contextTokens: 400 },
      },
      aliases: { strong: ["mockbad", "mock2"] },
      fallback: { chain: [], retriesPerCandidate: 0, retryDelayMs: 0 },
      workers: { allowedCommands: ["node"], projectInstructions: false },
    }),
  );
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, "--workspace", ws, "--config", configPath] });
  const client = new Client({ name: "handover-test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join("\n");
    return { text, isError: !!r.isError, meta: () => JSON.parse(text.slice(text.lastIndexOf("\nmeta: ") + 7)) };
  };
  const ledgerFile = (...p) => path.join(ws, ".break-free", ...p);
  return {
    call,
    ws,
    taskFiles: () => {
      const d = ledgerFile("tasks");
      return fs.existsSync(d) ? fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), "utf8")) : [];
    },
    journalText: () => {
      const d = ledgerFile("journal");
      return fs.existsSync(d) ? fs.readdirSync(d).map((f) => fs.readFileSync(path.join(d, f), "utf8")).join("\n") : "";
    },
    close: async () => {
      await client.close();
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    },
  };
}

before(async () => {
  mock = await startMockProvider();
});

after(async () => {
  await mock?.close();
});

test("a substituted model is handed a brief, capped to its window, naming the files touched", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  // The journal is the ledger's record, so the ledger has to exist before the run.
  await g.call("note_write", { title: "seed", body: "seed the ledger" });
  const from = mock.calls.length;

  const r = await g.call("supervise", { task: TASK, worker: "strong", supervisor: "mock/good", capabilities: ["write"], max_rounds: 2, acceptance_criteria: LONG_ACCEPTANCE });
  assert.equal(r.isError, false, r.text);

  const hs = r.meta().handovers;
  assert.ok(Array.isArray(hs) && hs.length >= 2, `an earlier round's handover is recorded too: ${JSON.stringify(hs)}`);
  const last = hs.at(-1);
  assert.equal(last.from, "mockbad/tooly");
  assert.equal(last.to, "mock2/tooly");
  assert.equal(last.reason, "auth");
  assert.deepEqual(last.files_touched, ["src/limiter.js"], "the round-1 write is the checkpoint's file list");
  assert.equal(last.context_tokens, 400);
  assert.ok(last.brief_tokens <= last.context_tokens, `brief of ${last.brief_tokens} tokens exceeds the ${last.context_tokens}-token window`);
  assert.equal(last.truncated, true, "acceptance criteria far past the window have to be cut");
  assert.ok(last.dropped_messages >= 1, "the round-1 transcript was dropped, not replayed");

  // The model that answered round 2 was handed the brief on its FIRST turn — not the previous
  // model's transcript, which is what a replay would have given it.
  const workerCalls = mock.calls.slice(from).filter((c) => c.model === "tooly");
  const handed = workerCalls.find((c) => JSON.stringify(c.messages).includes("## Handover brief"));
  assert.ok(handed, `no worker request carried a brief: ${JSON.stringify(workerCalls.map((c) => c.messages.length))}`);
  const sent = JSON.stringify(handed.messages);
  assert.match(sent, /src\/limiter\.js/);
  assert.match(sent, /Write the limiter\./, "the instruction survives the cap");
  assert.equal(/TOOL RESULT WAS/.test(sent), false, "the previous model's transcript must not be replayed");

  const journal = g.journalText();
  assert.match(journal, /handover mockbad\/tooly -> mock2\/tooly \(auth\)/);
  assert.match(journal, /1 file\(s\) touched/);
  assert.match(journal, /brief \d+\/400 tokens \(truncated\)/);
});

test("a run_plan substitution writes the handover into the task's ledger entry", async (t) => {
  const g = await startGateway();
  t.after(g.close);
  const r = await g.call("run_plan", { goal: "handover", tasks: [{ id: "limiter", task: "Write the limiter", model: "strong", acceptance: "the limiter refuses" }], track: true });
  const row = r.meta().results[0];
  assert.equal(row.status, "done", r.text);
  assert.equal(row.model, "mock2/tooly", "the task ran on the substitute, not the 401ing first candidate");

  const task = g.taskFiles().join("\n");
  assert.match(task, /handover mockbad\/tooly -> mock2\/tooly \(auth\)/);
  assert.match(task, /0 file\(s\) touched/, "nothing had been written when this task was substituted");
});

test("the brief is capped to the target's window even for an oversized checkpoint", async () => {
  // The unit-level guarantee the E2E above depends on: whatever the checkpoint contains,
  // the rendered brief cannot exceed the window it is rendered for.
  const { buildHandoverBrief, DEFAULT_CONTEXT_TOKENS } = await import("../dist/agent.js");
  assert.ok(DEFAULT_CONTEXT_TOKENS > 0, "a provider with no configured window still gets a sane default");
  const huge = {
    from: "a/big",
    to: "c/small",
    instruction: "x".repeat(200_000),
    acceptance: "y".repeat(200_000),
    filesTouched: ["src/one.js", "src/two.js"],
    lastVerify: { command: "npm test", ok: false, exit: 1, output: "z".repeat(200_000) },
    droppedMessages: 9,
  };
  const b = buildHandoverBrief(huge, 512);
  assert.ok(b.tokens <= 512, `brief of ${b.tokens} tokens for a 512-token window`);
  assert.equal(b.truncated, true);
  assert.match(b.text, /src\/one\.js/);
  assert.match(b.text, /src\/two\.js/);
  assert.match(b.text, /a\/big/, "the substitute is told which model it is taking over from");

  // A window with almost no room still yields a capped brief rather than an overflowing one.
  const tiny = buildHandoverBrief(huge, 1);
  assert.ok(tiny.tokens <= 1, `brief of ${tiny.tokens} tokens for a 1-token window`);
});
